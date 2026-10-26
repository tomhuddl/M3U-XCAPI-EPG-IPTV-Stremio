"use strict";

const fs = require("fs/promises");
const path = require("path");
const { logAt } = require("./logger");

const DAY_MS = 24 * 60 * 60 * 1000;
const activeHashes = new Map();
let lastRunAt = 0;
let maintenancePromise = null;

function positiveInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed >= min ? Math.min(parsed, max) : fallback;
}

function getCacheDirectories() {
    const root = String(process.env.PERSISTENT_DATA_DIR || "").trim();
    const metadataDirectory = String(process.env.CATALOG_META_CACHE_DIR ||
        (root ? path.join(root, "catalog-meta") : "")).trim();
    const seriesDirectory = String(process.env.SERIES_INFO_CACHE_DIR ||
        (root ? path.join(root, "series-info") : "")).trim();
    return [
        root ? { directory: root, prefix: "addon-data-" } : null,
        metadataDirectory ? { directory: metadataDirectory, prefix: "catalog-meta-" } : null,
        seriesDirectory ? { directory: seriesDirectory, prefix: "series-info-" } : null
    ].filter(Boolean);
}

async function cleanDirectory({ directory, prefix }, cutoff, active) {
    let names;
    try {
        names = await fs.readdir(directory);
    } catch (error) {
        if (error?.code !== "ENOENT") logAt("warn", "[DATA-CACHE] Cache maintenance could not scan a directory:", error?.name || "Error");
        return 0;
    }

    let removed = 0;
    const groups = new Map();
    const cachePattern = new RegExp("^" + prefix + "([a-f0-9]{24})\\.json(?:\\.wal)?$");
    for (const name of names) {
        const abandonedOmdbTemp = prefix === "addon-data-" &&
            name.startsWith("omdb-usage.json") && name.endsWith(".tmp");
        if (!name.startsWith(prefix) && !abandonedOmdbTemp) continue;
        const fullPath = path.join(directory, name);
        if (name.endsWith(".tmp")) {
            try {
                const stat = await fs.stat(fullPath);
                // Temp files are only abandoned by a killed writer; live atomic
                // writes finish in milliseconds, so retain a generous 24h grace.
                if (stat.isFile() && stat.mtimeMs < Date.now() - DAY_MS) {
                    await fs.unlink(fullPath);
                    removed++;
                }
            } catch (error) {
                if (error?.code !== "ENOENT") logAt("debug", "[DATA-CACHE] Could not remove an abandoned temp file:", error?.name || "Error");
            }
            continue;
        }
        const match = name.match(cachePattern);
        if (!match) continue;
        const hash = match[1];
        if (active.has(hash)) continue;
        if (!groups.has(hash)) groups.set(hash, []);
        groups.get(hash).push(fullPath);
    }

    for (const [hash, paths] of groups) {
        let latestMtime = 0;
        for (const filePath of paths) {
            try {
                const stat = await fs.stat(filePath);
                latestMtime = Math.max(latestMtime, stat.mtimeMs);
            } catch (error) {
                if (error?.code !== "ENOENT") logAt("debug", "[DATA-CACHE] Could not inspect an old cache file:", error?.name || "Error");
            }
        }
        if (active.has(hash) || !latestMtime || latestMtime >= cutoff) continue;
        for (const filePath of paths) {
            try {
                await fs.unlink(filePath);
                removed++;
            } catch (error) {
                if (error?.code !== "ENOENT") logAt("warn", "[DATA-CACHE] Could not remove an expired cache file:", error?.name || "Error");
            }
        }
    }
    return removed;
}

async function cleanupPersistentCacheFiles(cacheKey) {
    // Active hashes are registered for the lifetime of their addon interface.
    // Cleanup itself must not retain historical keys indefinitely.
    if (!process.env.PERSISTENT_DATA_DIR && !process.env.CATALOG_META_CACHE_DIR && !process.env.SERIES_INFO_CACHE_DIR) return;
    if (Date.now() - lastRunAt < DAY_MS) return;
    if (!maintenancePromise) {
        maintenancePromise = (async () => {
            const retentionDays = positiveInt(process.env.PERSISTENT_CACHE_RETENTION_DAYS, 90, 1, 365);
            const cutoff = Date.now() - retentionDays * DAY_MS;
            let removed = 0;
            for (const target of getCacheDirectories()) {
                removed += await cleanDirectory(target, cutoff, activeHashes);
            }
            lastRunAt = Date.now();
            if (removed) logAt("info", "[DATA-CACHE] Removed expired or abandoned cache files", { files: removed });
        })().finally(() => {
            maintenancePromise = null;
        });
    }
    await maintenancePromise;
}

module.exports = cleanupPersistentCacheFiles;
module.exports.registerActiveCache = function registerActiveCache(cacheKey) {
    const activeHash = String(cacheKey || "").slice(0, 24);
    if (!/^[a-f0-9]{24}$/.test(activeHash)) return () => {};
    activeHashes.set(activeHash, (activeHashes.get(activeHash) || 0) + 1);
    let released = false;
    return function releaseActiveCache() {
        if (released) return;
        released = true;
        const references = activeHashes.get(activeHash) || 0;
        if (references <= 1) activeHashes.delete(activeHash);
        else activeHashes.set(activeHash, references - 1);
    };
};
