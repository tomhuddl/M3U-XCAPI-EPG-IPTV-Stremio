"use strict";

const fs = require("fs/promises");
const path = require("path");
const { logAt } = require("./logger");

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 128 * 1024 * 1024;

function positiveInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed >= min ? Math.min(parsed, max) : fallback;
}

/**
 * Persistent last-known-good provider catalogue and XMLTV data.
 * Configure PERSISTENT_DATA_DIR to a mounted persistent disk (Railway example: /data).
 * A missing directory intentionally disables disk persistence rather than writing
 * large IPTV data into an ephemeral deployment filesystem.
 */
class PersistentAddonDataCache {
    constructor(cacheKey, options = {}) {
        this.directory = options.directory ?? process.env.PERSISTENT_DATA_DIR ?? "";
        this.enabled = typeof this.directory === "string" && this.directory.trim().length > 0;
        this.filePath = this.enabled
            ? path.join(this.directory, "addon-data-" + String(cacheKey).slice(0, 24) + ".json")
            : null;
        this.maxFileBytes = positiveInt(options.maxFileBytes ?? process.env.PERSISTENT_DATA_MAX_BYTES,
            MAX_FILE_BYTES, 1024 * 1024, 512 * 1024 * 1024);
    }

    async load() {
        if (!this.enabled) return null;
        try {
            const stat = await fs.stat(this.filePath);
            if (!stat.isFile() || stat.size > this.maxFileBytes) {
                logAt("warn", "[DATA-CACHE] Persistent data file is not a valid size; ignoring it");
                return null;
            }
            const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
            if (!parsed || parsed.version !== 1 || !parsed.data ||
                !Array.isArray(parsed.data.channels) ||
                !Array.isArray(parsed.data.movies) ||
                !Array.isArray(parsed.data.series) ||
                !parsed.data.epgData || typeof parsed.data.epgData !== "object" ||
                !Number.isFinite(parsed.data.lastUpdate) ||
                (parsed.data.directSeriesEpisodes !== undefined &&
                    (!parsed.data.directSeriesEpisodes || typeof parsed.data.directSeriesEpisodes !== "object" ||
                        Array.isArray(parsed.data.directSeriesEpisodes)))) {
                logAt("warn", "[DATA-CACHE] Persistent data file failed validation; ignoring it");
                return null;
            }
            return parsed.data;
        } catch (error) {
            if (error?.code !== "ENOENT") {
                logAt("warn", "[DATA-CACHE] Could not load persistent data:", error?.name || "Error");
            }
            return null;
        }
    }

    async save(data) {
        if (!this.enabled) return false;
        if (!data || !Array.isArray(data.channels) || !Array.isArray(data.movies) ||
            !Array.isArray(data.series) || !data.epgData || typeof data.epgData !== "object" ||
            !Number.isFinite(data.lastUpdate) ||
            (data.directSeriesEpisodes !== undefined &&
                (!data.directSeriesEpisodes || typeof data.directSeriesEpisodes !== "object" ||
                    Array.isArray(data.directSeriesEpisodes)))) {
            throw new Error("Refusing to persist an incomplete provider data snapshot");
        }

        const snapshot = JSON.stringify({ version: 1, savedAt: Date.now(), data });
        if (Buffer.byteLength(snapshot, "utf8") > this.maxFileBytes) {
            throw new Error("Provider data snapshot exceeds the persistent cache size limit");
        }

        await fs.mkdir(this.directory, { recursive: true });
        const tempPath = this.filePath + "." + process.pid + "." + Date.now() + ".tmp";
        try {
            await fs.writeFile(tempPath, snapshot, { encoding: "utf8", mode: 0o600, flag: "wx" });
            await fs.rename(tempPath, this.filePath);
            return true;
        } finally {
            await fs.unlink(tempPath).catch(() => {});
        }
    }
}

module.exports = PersistentAddonDataCache;
