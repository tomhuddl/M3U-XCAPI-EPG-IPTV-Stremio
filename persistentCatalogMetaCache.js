"use strict";

const path = require("path");
const { logAt } = require("./logger");
const PersistentMapJournal = require("./persistentMapJournal");

const DAY_MS = 24 * 60 * 60 * 1000;
// A full movie + series catalogue can exceed 64 MiB once metadata is enriched.
// Allow room for the current ~27k-title library while still rejecting unexpectedly huge files.
const MAX_FILE_BYTES = 256 * 1024 * 1024;

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
        this.journal = this.enabled
            ? new PersistentMapJournal(this.filePath, MAX_FILE_BYTES, (source, error) => {
                logAt("warn", "[CATALOG-CACHE] Could not read persistent metadata " + source + ":", error?.name || "Error");
            })
            : null;
        // Persistent metadata has its own freshness window, separate from the
        // short-lived in-memory LRU. Keep the legacy variable as a migration fallback.
        this.ttlMs = parsePositiveInteger(
            options.ttlMs ?? process.env.CATALOG_META_PERSISTENT_TTL_MS ?? process.env.CATALOG_META_CACHE_TTL_MS,
            14 * DAY_MS, 1000, 30 * DAY_MS
        );
        this.staleRetentionMs = parsePositiveInteger(
            options.staleRetentionMs ?? process.env.CATALOG_META_STALE_RETENTION_MS,
            30 * DAY_MS, this.ttlMs, 90 * DAY_MS
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
                        if (!entry || !Number.isFinite(entry.savedAt) || !entry.value ||
                            now - entry.savedAt > this.staleRetentionMs || now < entry.savedAt) continue;
                        this.entries.set(key, { savedAt: entry.savedAt, value: entry.value });
                    }
                    this.prune();
                    logAt("info", "[CATALOG-CACHE] Loaded persistent metadata cache", {
                        entries: this.entries.size,
                        bytes: loaded.snapshotBytes + loaded.journalBytes,
                        freshEntries: [...this.entries.values()].filter(entry => now - entry.savedAt < this.ttlMs).length,
                        staleFallbackEntries: [...this.entries.values()].filter(entry => now - entry.savedAt >= this.ttlMs).length
                    });
                    if (this.dirty || this.journal.forceCompact) this.scheduleWrite();
                } catch (error) {
                    if (error?.code !== "ENOENT") {
                        logAt("warn", "[CATALOG-CACHE] Could not load persistent metadata cache:", error?.name || "Error");
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
            this.journal?.mark(oldestKey, null);
            this.dirty = true;
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
            this.journal.mark(String(key), null);
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
        const normalizedKey = String(key);
        const entry = { savedAt: Date.now(), value };
        this.entries.set(normalizedKey, entry);
        this.journal.mark(normalizedKey, entry);
        this.prune();
        this.dirty = true;
        this.scheduleWrite();
    }

    async delete(key) {
        if (!this.enabled) return;
        await this.init();
        if (this.entries.delete(String(key))) {
            this.journal.mark(String(key), null);
            this.dirty = true;
            this.scheduleWrite();
        }
    }

    async retainCatalogItems(itemIds) {
        if (!this.enabled) return;
        await this.init();
        const keep = new Set(Array.from(itemIds || [], value => String(value)));
        let changed = false;
        for (const key of this.entries.keys()) {
            // Warm-up completion markers are keyed separately from catalog items.
            if (key.startsWith("__catalog_prefetch_status__:")) continue;
            if (!keep.has(key)) {
                this.entries.delete(key);
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

    scheduleWrite(delay = 500) {
        if (!this.enabled || this.writeTimer) return;
        this.writeTimer = setTimeout(() => {
            this.writeTimer = null;
            this.flush().catch(error => {
                logAt("warn", "[CATALOG-CACHE] Could not save persistent metadata cache:", {
                    name: error?.name || "Error", code: error?.code || "UNKNOWN",
                    syscall: error?.syscall || null, message: String(error?.message || "No error message").slice(0, 300)
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

module.exports = PersistentCatalogMetaCache;
