"use strict";

const fs = require("fs/promises");
const path = require("path");

const DEFAULT_COMPACT_BYTES = 16 * 1024 * 1024;

/**
 * Append small cache changes to a journal instead of rewriting the whole cache
 * snapshot for every item. Version-1 snapshots remain readable and migrate on
 * the next compaction.
 */
class PersistentMapJournal {
    constructor(filePath, maxFileBytes, logger) {
        this.filePath = filePath;
        this.journalPath = filePath ? filePath + ".wal" : null;
        this.maxFileBytes = maxFileBytes;
        this.compactBytes = DEFAULT_COMPACT_BYTES;
        this.forceCompact = false;
        this.log = logger || (() => {});
        this.pending = new Map();
        this.sequence = 0;
        this.journalBytes = 0;
        this.writePromise = null;
    }

    async trimIncompleteJournalTail(contents = null) {
        let journalContents = contents;
        if (journalContents == null) {
            try {
                journalContents = await fs.readFile(this.journalPath, "utf8");
            } catch (error) {
                if (error?.code === "ENOENT") {
                    this.journalBytes = 0;
                    return "";
                }
                throw error;
            }
        }
        if (journalContents.endsWith("\n")) {
            this.journalBytes = Buffer.byteLength(journalContents, "utf8");
            return journalContents;
        }
        const lastNewline = journalContents.lastIndexOf("\n");
        const completeContents = lastNewline >= 0 ? journalContents.slice(0, lastNewline + 1) : "";
        const completeBytes = Buffer.byteLength(completeContents, "utf8");
        await fs.truncate(this.journalPath, completeBytes);
        this.journalBytes = completeBytes;
        return completeContents;
    }
    get hasPending() {
        return this.pending.size > 0;
    }

    async load() {
        const entries = new Map();
        let snapshotBytes = 0;
        try {
            const stat = await fs.stat(this.filePath);
            if (stat.isFile() && stat.size <= this.maxFileBytes) {
                const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
                if ((parsed?.version === 1 || parsed?.version === 2) &&
                    parsed.entries && typeof parsed.entries === "object" && !Array.isArray(parsed.entries)) {
                    for (const [key, value] of Object.entries(parsed.entries)) entries.set(key, value);
                    if (Number.isSafeInteger(parsed.sequence) && parsed.sequence >= 0) {
                        this.sequence = parsed.sequence;
                    }
                    snapshotBytes = stat.size;
                }
            }
        } catch (error) {
            if (error?.code !== "ENOENT") this.log("snapshot", error);
        }

        try {
            const stat = await fs.stat(this.journalPath);
            this.journalBytes = stat.size;
            if (stat.isFile() && stat.size <= this.maxFileBytes) {
                const contents = await this.trimIncompleteJournalTail(await fs.readFile(this.journalPath, "utf8"));
                for (const line of contents.split(/\r?\n/)) {
                    if (!line) continue;
                    try {
                        const record = JSON.parse(line);
                        if (!record || !Number.isSafeInteger(record.sequence) || record.sequence <= this.sequence ||
                            typeof record.key !== "string") continue;
                        if (record.deleted === true) entries.delete(record.key);
                        else if (record.value && typeof record.value === "object") entries.set(record.key, record.value);
                        else continue;
                        this.sequence = record.sequence;
                    } catch {
                        // A process may stop during an append. Ignore only that bad line;
                        // later complete records remain usable.
                    }
                }
            } else if (stat.size > this.maxFileBytes) {
                this.forceCompact = true;
                // Cache data can be regenerated. Avoid unbounded allocation if a
                // damaged or externally modified journal is unexpectedly enormous.
                this.log("journal-size", new Error("journal exceeded the cache safety limit"));
            }
        } catch (error) {
            if (error?.code !== "ENOENT") this.log("journal", error);
        }

        return { entries, snapshotBytes, journalBytes: this.journalBytes, sequence: this.sequence };
    }

    mark(key, value) {
        this.pending.set(String(key), value == null ? null : value);
        if (value == null) this.forceCompact = true;
    }

    async flush(entries) {
        if (this.writePromise) {
            await this.writePromise;
            if (this.pending.size || this.journalBytes >= this.compactBytes || this.forceCompact) return this.flush(entries);
            return;
        }
        if (!this.pending.size && this.journalBytes < this.compactBytes && !this.forceCompact) return;

        const operation = this.flushBatch(entries);
        this.writePromise = operation;
        try {
            await operation;
        } finally {
            this.writePromise = null;
        }
        if (this.pending.size || this.journalBytes >= this.compactBytes || this.forceCompact) return this.flush(entries);
    }

    async flushBatch(entries) {
        if (this.pending.size) {
            const batch = this.pending;
            this.pending = new Map();
            let sequence = this.sequence;
            const records = [];
            for (const [key, value] of batch) {
                sequence += 1;
                records.push(JSON.stringify(value == null
                    ? { sequence, key, deleted: true }
                    : { sequence, key, value }));
            }
            const payload = records.join("\n") + "\n";
            try {
                await fs.mkdir(path.dirname(this.filePath), { recursive: true });
                await fs.appendFile(this.journalPath, payload, { encoding: "utf8", mode: 0o600 });
                this.sequence = sequence;
                this.journalBytes += Buffer.byteLength(payload, "utf8");
            } catch (error) {
                await this.trimIncompleteJournalTail().catch(() => {});
                for (const [key, value] of batch) {
                    if (!this.pending.has(key)) this.pending.set(key, value);
                }
                throw error;
            }
        }

        if ((this.journalBytes >= this.compactBytes || this.forceCompact) && this.pending.size === 0) {
            const snapshot = JSON.stringify({
                version: 2,
                sequence: this.sequence,
                entries: Object.fromEntries(entries)
            });
            if (Buffer.byteLength(snapshot, "utf8") > this.maxFileBytes) {
                throw new Error("persistent cache snapshot exceeds its safety limit");
            }
            await fs.mkdir(path.dirname(this.filePath), { recursive: true });
            const tempPath = this.filePath + "." + process.pid + ".tmp";
            try {
                await fs.writeFile(tempPath, snapshot, { encoding: "utf8", mode: 0o600 });
                await fs.rename(tempPath, this.filePath);
                // If the process stops before this truncation, the sequence stored in
                // the new snapshot makes the old journal records harmless on reload.
                await fs.writeFile(this.journalPath, "", { encoding: "utf8", mode: 0o600 });
                this.journalBytes = 0;
                this.forceCompact = false;
            } finally {
                await fs.unlink(tempPath).catch(() => {});
            }
        }
    }
}

module.exports = PersistentMapJournal;
