"use strict";

const { mapWithConcurrency } = require("./asyncUtils");
const requestContext = require("./requestContext");
const { createLogger } = require("./logger");

// Shared ownership prevents overlapping configurations from writing to the same
// provider files through separate instances during reconfiguration or eviction.
const sharedSources = new Map();
const catalogTypes = { iptv_channels: "tv", iptv_movies: "movie", iptv_series: "series" };
function enabled(source, type) {
    return type === "tv" ? source.includeLive !== false :
        type === "movie" ? source.includeMovies !== false :
        type === "series" && source.includeSeries !== false;
}
function qualify(sourceId, id) { return `iptv_src_${sourceId}_${id}`; }
function parseId(id) {
    const match = typeof id === "string" && id.match(/^iptv_src_([a-z0-9]{12})_(iptv_.+)$/);
    return match ? { sourceId: match[1], id: match[2] } : null;
}
function qualifyResponse(value, sourceId) {
    if (Array.isArray(value)) return value.map(item => qualifyResponse(item, sourceId));
    if (!value || typeof value !== "object") return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        out[key] = (key === "id" || key === "defaultVideoId") && typeof item === "string" && item.startsWith("iptv_")
            ? qualify(sourceId, item) : qualifyResponse(item, sourceId);
    }
    return out;
}

async function acquireSource(source, dependencies) {
    // Internal source caches are separate from existing single-provider installs.
    // Names and UI IDs do not invalidate a provider's saved data.
    const { id, name, ...settings } = source;
    const config = { ...settings, __multiSource: true, __sourceLabel: name };
    const key = dependencies.key(config);
    let entry = sharedSources.get(key);
    if (entry?.disposal) { await entry.disposal; return acquireSource(source, dependencies); }
    if (!entry) {
        const building = [...sharedSources.values()].filter(item => !item.iface).length;
        if (dependencies.activeCount() + building >= dependencies.maxLive)
            throw new Error("Provider capacity is busy; retry shortly");
        entry = { references: 0, iface: null, disposal: null };
        sharedSources.set(key, entry);
        entry.promise = Promise.resolve().then(() => dependencies.build(config)).then(iface => {
            entry.iface = iface;
            return iface;
        });
    }
    entry.references++;
    let iface;
    try { iface = await entry.promise; }
    catch (error) {
        if (--entry.references === 0 && sharedSources.get(key) === entry) sharedSources.delete(key);
        throw error;
    }
    let released = false;
    return { iface, async release() {
        if (released) return;
        released = true;
        if (--entry.references) return;
        entry.disposal = Promise.resolve().then(() => dependencies.dispose(iface)).finally(() => {
            if (sharedSources.get(key) === entry) sharedSources.delete(key);
        });
        await entry.disposal;
    } };
}

class MultiProviderAddon {
    constructor(config, baseManifest, dependencies) {
        this.cacheKey = dependencies.key(config);
        this.dependencies = dependencies;
        this.sources = config.sources.map(source => ({ source, lease: null, promise: null, retryAfter: 0 }));
        this.baseManifest = baseManifest;
        this.disposed = false;
        this.activeRequests = 0;
        this.log = createLogger(() => config.debug === true);
    }
    acquireRequest() {
        if (this.disposed) return false;
        this.activeRequests++;
        return true;
    }
    releaseRequest() {
        if (this.activeRequests > 0) this.activeRequests--;
        if (!this.activeRequests) this.resolveDrain?.();
    }
    async load(slot) {
        if (slot.lease) return slot.lease.iface;
        if (slot.promise) return slot.promise;
        if (this.disposed || Date.now() < slot.retryAfter) return null;
        const task = (async () => {
            try {
                const lease = await acquireSource({ ...slot.source, debug: this.configDebug }, this.dependencies);
                if (this.disposed) { await lease.release(); return null; }
                slot.lease = lease;
                slot.retryAfter = 0;
                return lease.iface;
            } catch (error) {
                slot.retryAfter = Date.now() + this.dependencies.retryDelay;
                if (!this.disposed) this.log.warn("Provider is temporarily unavailable; other providers remain usable", {
                    provider: slot.source.name, errorName: error?.name || "Error"
                });
                return null;
            }
        })();
        slot.promise = task;
        try { return await task; } finally { if (slot.promise === task) slot.promise = null; }
    }
    getManifest() {
        const catalogs = this.sources.flatMap(({ source, lease }) => {
            const children = lease?.iface.manifest.catalogs || this.baseManifest.catalogs;
            return children.filter(catalog => enabled(source, catalog.type)).map(catalog => ({
                ...catalog, id: qualify(source.id, catalog.id), name: `${source.name} · ${catalog.name}`,
                extra: catalog.extra?.map(extra => ({ ...extra, ...(Array.isArray(extra.options) ? { options: [...extra.options] } : {}) }))
            }));
        });
        return { ...this.baseManifest,
            providerStatus: this.sources.map(slot => ({ id: slot.source.id, name: slot.source.name, ready: Boolean(slot.lease) })),
            types: ["tv", "movie", "series"].filter(type => this.sources.some(({ source }) => enabled(source, type))),
            catalogs,
            behaviorHints: { ...this.baseManifest.behaviorHints,
                epgProvider: this.sources.some(slot => enabled(slot.source, "tv") && slot.lease?.iface.manifest.behaviorHints?.epgProvider === true) }
        };
    }
    async get(resource, type, id, extra) {
        if (!this.acquireRequest()) throw new Error("Configuration is stopping");
        try {
            const parsed = parseId(id);
            const slot = parsed && this.sources.find(item => item.source.id === parsed.sourceId);
            const empty = resource === "stream" ? { streams: [] } : resource === "meta" ? { meta: null } : { metas: [] };
            if (!slot || !enabled(slot.source, type)) return empty;
            if (resource === "catalog" && catalogTypes[parsed.id] !== type) return empty;
            if (!["catalog", "meta", "stream"].includes(resource)) throw new Error("Unsupported resource");
            const iface = await this.load(slot);
            if (!iface) throw new Error("Selected provider is temporarily unavailable");
            if (!this.dependencies.acquire(iface)) throw new Error("Selected provider is restarting");
            try {
                // The existing provider handler still enriches the entire requested
                // page before returning, including search results and later pages.
                return qualifyResponse(await iface.get(resource, type, parsed.id, extra), slot.source.id);
            } finally { this.dependencies.release(iface); }
        } finally { this.releaseRequest(); }
    }
    async flushPersistentStores() {
        const results = await Promise.allSettled(this.sources.filter(slot => slot.lease)
            .map(slot => this.dependencies.flush(slot.lease.iface)));
        if (results.some(result => result.status === "rejected")) throw new Error("Provider cache flush failed");
    }
    dispose() {
        if (this.disposal) return this.disposal;
        this.disposed = true;
        clearInterval(this.retryTimer);
        this.disposal = (async () => {
            await this.flushPersistentStores().catch(() => {});
            if (this.activeRequests) await new Promise(resolve => { this.resolveDrain = resolve; });
            await Promise.allSettled(this.sources.map(slot => slot.promise));
            const finalFlush = await Promise.allSettled([this.flushPersistentStores()]);
            const results = await Promise.allSettled(this.sources.map(async slot => {
                const lease = slot.lease;
                slot.lease = null;
                if (lease) await lease.release();
            }));
            if ([...finalFlush, ...results].some(result => result.status === "rejected")) throw new Error("Provider disposal failed");
        })();
        return this.disposal;
    }
}

async function createMultiProviderAddon(config, baseManifest, dependencies) {
    const instance = new MultiProviderAddon(config, baseManifest, dependencies);
    instance.configDebug = config.debug === true;
    try {
        await mapWithConcurrency(instance.sources, 2, slot => instance.load(slot));
        if (!instance.sources.some(slot => slot.lease)) throw new Error("Configured providers are temporarily unavailable");
        const iface = { get: instance.get.bind(instance) };
        Object.defineProperties(iface, {
            manifest: { enumerable: true, get: () => instance.getManifest() },
            __cacheWeight: { get: () => instance.sources.reduce((sum, slot) => sum + (slot.lease?.iface.__cacheWeight || 0), 4096) }
        });
        instance.retryTimer = setInterval(() => {
            if (instance.disposed) return;
            requestContext.background(() => mapWithConcurrency(instance.sources.filter(slot => !slot.lease), 1,
                slot => instance.load(slot))).catch(() => {});
        }, 60000);
        instance.retryTimer.unref?.();
        return { iface, instance };
    } catch (error) { await instance.dispose(); throw error; }
}

module.exports = { createMultiProviderAddon, qualify, parseId, qualifyResponse };
