"use strict";

const fs = require("fs/promises");
const path = require("path");

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

function parsePositiveInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed >= min
        ? Math.min(parsed, max)
        : fallback;
}

/**
 * Optional persistent cache for completed catalogue metadata.
 *
 * Set CATALOG_META_CACHE_DIR to a persistent directory (for example /data/catalog-cache
 * on Railway). Files are namespaced by the existing provider/config hash, so metadata
 * from different IPTV configurations is never mixed. Stale values are retained briefly
 * as a fallback if a daily refresh cannot reach TMDb.
 */
class PersistentCatalogMetaCache {
    constructor(cacheKey, options = {}) {
        const sharedDataDirectory = process.env.PERSISTENT_DATA_DIR || "";
        this.directory = options.directory ?? process.env.CATALOG_META_CACHE_DIR ?? (sharedDataDirectory ? path.join(sharedDataDirectory, "catalog-meta") : "");
        this.enabled = typeof this.directory === "string" && this.directory.trim().length > 0;
        this.filePath = this.enabled
            ? path.join(this.directory, "catalog-meta-" + String(cacheKey).slice(0, 24) + ".json")
            : null;
        this.ttlMs = parsePositiveInteger(
            options.ttlMs ?? process.env.CATALOG_META_CACHE_TTL_MS,
            DAY_MS, 1000, 30 * DAY_MS
        );
        this.staleRetentionMs = parsePositiveInteger(
            options.staleRetentionMs ?? process.env.CATALOG_META_STALE_RETENTION_MS,
            7 * DAY_MS, this.ttlMs, 90 * DAY_MS
        );
        this.maxEntries = parsePositiveInteger(
            options.maxEntries ?? process.env.CATALOG_META_PERSISTENT_MAX_ENTRIES,
            50000, 100, 100000
        );
        this.entries = new Map();
        this.loadPromise = null;
        this.writePromise = null;
        this.writeTimer = null;
        this.dirty = false;
    }

    async init() {
        if (!this.enabled) return;
        if (!this.loadPromise) {
            this.loadPromise = (async () => {
                try {
                    const stat = await fs.stat(this.filePath);
                    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
                        return;
                    }
                    const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
                    if (!parsed || parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
                        return;
                    }
                    const now = Date.now();
                    for (const [key, entry] of Object.entries(parsed.entries)) {
                        if (!entry || !Number.isFinite(entry.savedAt) || !entry.value ||
                            now - entry.savedAt > this.staleRetentionMs || now < entry.savedAt) {
                            continue;
                        }
                        this.entries.set(key, { savedAt: entry.savedAt, value: entry.value });
                    }
                    this.prune();
                } catch (error) {
                    if (error?.code !== "ENOENT") {
                        console.warn("[CATALOG-CACHE] Could not load persistent metadata cache:", error?.name || "Error");
                    }
                }
            })();
        }
        await this.loadPromise;
    }

    prune() {
        const cutoff = Date.now() - this.staleRetentionMs;
        for (const [key, entry] of this.entries) {
            if (!entry || entry.savedAt < cutoff) this.entries.delete(key);
        }
        while (this.entries.size > this.maxEntries) {
            let oldestKey;
            let oldestTime = Infinity;
            for (const [key, entry] of this.entries) {
                if (entry.savedAt < oldestTime) {
                    oldestTime = entry.savedAt;
                    oldestKey = key;
                }
            }
            if (oldestKey === undefined) break;
            this.entries.delete(oldestKey);
        }
    }

    async get(key) {
        if (!this.enabled) return null;
        await this.init();
        const entry = this.entries.get(String(key));
        if (!entry) return null;
        const age = Date.now() - entry.savedAt;
        if (age < 0 || age > this.staleRetentionMs) {
            this.entries.delete(String(key));
            this.dirty = true;
            this.scheduleWrite();
            return null;
        }
        return {
            value: entry.value,
            savedAt: entry.savedAt,
            fresh: age < this.ttlMs,
        };
    }

    async set(key, value) {
        if (!this.enabled || !value || typeof value !== "object") return;
        await this.init();
        this.entries.delete(String(key));
        this.entries.set(String(key), { savedAt: Date.now(), value });
        this.prune();
        this.dirty = true;
        this.scheduleWrite();
    }

    scheduleWrite(delay = 500) {
        if (!this.enabled || this.writeTimer) return;
        this.writeTimer = setTimeout(() => {
            this.writeTimer = null;
            this.flush().catch(error => {
                console.warn("[CATALOG-CACHE] Could not save persistent metadata cache:", {
                    name: error?.name || "Error", code: error?.code || "UNKNOWN",
                    syscall: error?.syscall || null, message: String(error?.message || "No error message").slice(0, 300)
                });
            });
        }, delay);
        if (typeof this.writeTimer.unref === "function") this.writeTimer.unref();
    }

    async flush() {
        if (!this.enabled) return;
        await this.init();
        if (this.writePromise) {
            await this.writePromise;
            if (this.dirty) return this.flush();
            return;
        }
        if (!this.dirty) return;

        this.dirty = false;
        const snapshot = JSON.stringify({
            version: 1,
            entries: Object.fromEntries(this.entries),
        });
        this.writePromise = (async () => {
            await fs.mkdir(this.directory, { recursive: true });
            const tempPath = this.filePath + "." + process.pid + ".tmp";
            try {
                await fs.writeFile(tempPath, snapshot, { encoding: "utf8", mode: 0o600 });
                await fs.rename(tempPath, this.filePath);
            } finally {
                await fs.unlink(tempPath).catch(() => {});
            }
        })();

        try {
            await this.writePromise;
        } finally {
            this.writePromise = null;
            if (this.dirty) this.scheduleWrite(0);
        }
    }
}

module.exports = PersistentCatalogMetaCache;
