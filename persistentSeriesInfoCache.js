"use strict";

const path = require("path");
const { isDeepStrictEqual } = require("util");
const { logAt } = require("./logger");
const PersistentMapJournal = require("./persistentMapJournal");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_FILE_BYTES = 128 * 1024 * 1024;

function positiveInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed >= min ? Math.min(parsed, max) : fallback;
}

/**
 * Persistent on-demand Xtream series detail cache. Entries are tied to the
 * provider catalogue's lastUpdate timestamp, so a successful catalogue refresh
 * makes old episode lists stale while retaining them as a fallback if the panel
 * is unavailable.
 */
class PersistentSeriesInfoCache {
    constructor(cacheKey, options = {}) {
        const persistentRoot = process.env.PERSISTENT_DATA_DIR || "";
        this.directory = options.directory ?? process.env.SERIES_INFO_CACHE_DIR ??
            (persistentRoot ? path.join(persistentRoot, "series-info") : "");
        this.enabled = typeof this.directory === "string" && this.directory.trim().length > 0;
        this.filePath = this.enabled
            ? path.join(this.directory, "series-info-" + String(cacheKey).slice(0, 24) + ".json")
            : null;
        this.journal = this.enabled
            ? new PersistentMapJournal(this.filePath, MAX_FILE_BYTES, (source, error) => {
                logAt("warn", "[SERIES-CACHE] Could not read persistent series details " + source + ":", error?.name || "Error");
            })
            : null;

        const providerRefresh = positiveInt(process.env.DATA_REFRESH_INTERVAL_MS, 12 * HOUR_MS, HOUR_MS, 7 * DAY_MS);
        this.ttlMs = positiveInt(
            options.ttlMs ?? process.env.SERIES_INFO_PERSISTENT_TTL_MS,
            providerRefresh, HOUR_MS, 30 * DAY_MS
        );
        this.staleRetentionMs = positiveInt(
            options.staleRetentionMs ?? process.env.SERIES_INFO_STALE_RETENTION_MS,
            30 * DAY_MS, this.ttlMs, 90 * DAY_MS
        );
        this.maxEntries = positiveInt(
            options.maxEntries ?? process.env.SERIES_INFO_PERSISTENT_MAX_ENTRIES,
            20000, 100, 100000
        );

        this.entries = new Map();
        this.episodeOwners = null;
        this.loadPromise = null;
        this.writePromise = null;
        this.writeTimer = null;
        this.dirty = false;
        this.writeRetryDelayMs = 1000;
    }

    async init() {
        if (!this.enabled) return;
        if (!this.loadPromise) {
            this.loadPromise = (async () => {
                try {
                    const loaded = await this.journal.load();
                    const now = Date.now();
                    for (const [key, entry] of loaded.entries) {
                        if (!entry || !Number.isFinite(entry.savedAt) || !Number.isFinite(entry.providerLastUpdate) ||
                            !entry.value || !Array.isArray(entry.value.videos) ||
                            now - entry.savedAt > this.staleRetentionMs || now < entry.savedAt) continue;
                        this.entries.set(String(key), {
                            savedAt: entry.savedAt,
                            providerLastUpdate: entry.providerLastUpdate,
                            value: entry.value
                        });
                    }
                    this.prune();
                    logAt("info", "[SERIES-CACHE] Loaded persistent series details", {
                        entries: this.entries.size,
                        bytes: loaded.snapshotBytes + loaded.journalBytes
                    });
                    if (this.dirty || this.journal.forceCompact) this.scheduleWrite();
                } catch (error) {
                    if (error?.code !== "ENOENT") {
                        logAt("warn", "[SERIES-CACHE] Could not load persistent series details:", error?.name || "Error");
                    }
                }
            })();
        }
        await this.loadPromise;
    }

    prune() {
        const cutoff = Date.now() - this.staleRetentionMs;
        for (const [key, entry] of this.entries) {
            if (!entry || entry.savedAt < cutoff) {
                this.entries.delete(key);
                this.episodeOwners = null;
                this.journal?.mark(key, null);
                this.dirty = true;
            }
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
            this.episodeOwners = null;
            this.journal?.mark(oldestKey, null);
            this.dirty = true;
        }
    }

    async get(seriesId, providerLastUpdate) {
        if (!this.enabled) return null;
        await this.init();
        const entry = this.entries.get(String(seriesId));
        if (!entry) return null;
        const age = Date.now() - entry.savedAt;
        if (age < 0 || age > this.staleRetentionMs) {
            this.entries.delete(String(seriesId));
            this.episodeOwners = null;
            this.journal.mark(String(seriesId), null);
            this.dirty = true;
            this.scheduleWrite();
            return null;
        }
        return {
            value: entry.value,
            savedAt: entry.savedAt,
            fresh: age < this.ttlMs && entry.providerLastUpdate === Number(providerLastUpdate || 0),
            providerLastUpdate: entry.providerLastUpdate
        };
    }

    async set(seriesId, value, providerLastUpdate, canStore = null) {
        if (!this.enabled || !value || typeof value !== "object" || !Array.isArray(value.videos)) return;
        await this.init();
        if (typeof canStore === "function" && !canStore()) return;
        const key = String(seriesId);
        const entry = {
            savedAt: Date.now(),
            providerLastUpdate: Number(providerLastUpdate) || 0,
            value
        };
        this.entries.set(key, entry);
        this.episodeOwners = null;
        this.journal.mark(key, entry);
        this.prune();
        this.dirty = true;
        // Journal asynchronously instead of rewriting the full series cache before
        // returning the detailed page.
        this.scheduleWrite();
    }

    async retainSeries(seriesIds, options = {}) {
        if (!this.enabled) return;
        await this.init();
        const keep = new Set(Array.from(seriesIds || [], value => String(value)));
        const invalidated = new Set(Array.from(options.invalidatedSeriesIds || [], value => String(value)));
        const currentGeneration = Number(options.providerLastUpdate) || 0;
        let changed = false;
        for (const [key, entry] of this.entries) {
            const changedIdentity = invalidated.has(key) && entry.providerLastUpdate !== currentGeneration;
            if (!keep.has(key) || changedIdentity) {
                this.entries.delete(key);
                this.episodeOwners = null;
                this.journal.mark(key, null);
                changed = true;
            }
        }
        if (changed) {
            this.dirty = true;
            this.journal.forceCompact = true;
            this.scheduleWrite();
        }
    }

    async updateEnrichment(seriesId, enrichment, providerLastUpdate, canStore = null) {
        if (!this.enabled) return;
        await this.init();
        const key = String(seriesId), entry = this.entries.get(key);
        if (!entry || entry.providerLastUpdate !== Number(providerLastUpdate) ||
            (canStore && !canStore())) return;
        const previous = entry.value._episodeMetadata;
        if (previous?.tmdbId === enrichment.tmdbId && isDeepStrictEqual(previous.seasons, enrichment.seasons)) return previous;
        if (Buffer.byteLength(JSON.stringify(enrichment)) > 256 * 1024) return;
        // Enriching TMDb fields must not renew the provider episode-list clock.
        entry.value = { ...entry.value, _episodeMetadata: enrichment };
        this.journal.mark(key, entry); this.dirty = true;
        const enriched = [...this.entries].filter(([, value]) => value.value?._episodeMetadata)
            .sort((a, b) => a[1].value._episodeMetadata.checkedAt - b[1].value._episodeMetadata.checkedAt);
        for (const [oldKey, old] of enriched.slice(0, Math.max(0, enriched.length - 200))) {
            const value = { ...old.value }; delete value._episodeMetadata;
            old.value = value; this.journal.mark(oldKey, old);
        }
        this.scheduleWrite();
        return enrichment;
    }

    async findSeriesByEpisodeId(episodeId) {
        if (!this.enabled) return null;
        await this.init();
        if (!this.episodeOwners) {
            const owners = new Map();
            const now = Date.now();
            for (const [seriesId, entry] of this.entries) {
                const age = now - entry.savedAt;
                if (age < 0 || age > this.staleRetentionMs) continue;
                for (const video of entry.value.videos) {
                    if (typeof video?.id === 'string' && video.url) owners.set(video.id, seriesId);
                }
            }
            this.episodeOwners = owners;
        }
        const owner = this.episodeOwners.get(String(episodeId));
        if (!owner) return null;
        // Recheck retention even when the index has been reused for a long time.
        return await this.get(owner, 0) ? owner : null;
    }

    scheduleWrite(delay = 500) {
        if (!this.enabled || this.writeTimer) return;
        this.writeTimer = setTimeout(() => {
            this.writeTimer = null;
            this.flush().catch(error => {
                logAt("warn", "[SERIES-CACHE] Could not save persistent series details:", {
                    name: error?.name || "Error",
                    code: error?.code || "UNKNOWN",
                    message: String(error?.message || "No error message").slice(0, 300)
                });
            });
        }, delay);
        if (typeof this.writeTimer.unref === "function") this.writeTimer.unref();
    }

    async flush() {
        if (!this.enabled) return;
        if (this.writeTimer) {
            clearTimeout(this.writeTimer);
            this.writeTimer = null;
        }
        await this.init();
        if (this.writePromise) {
            await this.writePromise;
            if (this.dirty || this.journal.forceCompact) return this.flush();
            return;
        }
        if (!this.dirty && !this.journal.forceCompact) return;

        this.dirty = false;
        this.writePromise = this.journal.flush(this.entries);
        let writeFailed = false;
        try {
            await this.writePromise;
            this.writeRetryDelayMs = 1000;
            this.dirty = this.journal.hasPending || this.journal.forceCompact;
        } catch (error) {
            this.dirty = true;
            writeFailed = true;
            throw error;
        } finally {
            this.writePromise = null;
            if (this.dirty) {
                const delay = writeFailed ? this.writeRetryDelayMs : 0;
                if (writeFailed) this.writeRetryDelayMs = Math.min(this.writeRetryDelayMs * 2, 5 * 60 * 1000);
                this.scheduleWrite(delay);
            }
        }
    }
}

module.exports = PersistentSeriesInfoCache;
