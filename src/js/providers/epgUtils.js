"use strict";
const { getEPGStatus } = require("../epgStreamParser");

function getEpgFetchConcurrency() {
    const value = Number.parseInt(process.env.EPG_FETCH_CONCURRENCY, 10);
    // Source order determines retention priority when a guide reaches its cap.
    return Number.isSafeInteger(value) && value >= 1 ? Math.min(value, 4) : 1;
}

function mergeEpgSources(addon, sources) {
    const groups = new Map();
    const status = {
        truncated: false,
        retainedProgrammes: 0,
        omittedProgrammes: 0,
        omittedTextCharacters: 0
    };
    for (const source of sources) {
        if (!source) continue;
        const detail = getEPGStatus(source);
        status.truncated ||= detail.truncated;
        status.omittedProgrammes += detail.omittedProgrammes;
        status.omittedTextCharacters += detail.omittedTextCharacters;
        for (const [id, programmes] of Object.entries(source)) {
            if (!groups.has(id)) groups.set(id, []);
            groups.get(id).push(...programmes);
        }
    }
    for (const [id, programmes] of groups) {
        const seen = new Set();
        const kept = programmes
            .filter((programme) => {
                const key = JSON.stringify([
                    programme.start,
                    programme.stop,
                    programme.title
                ]);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .sort((a, b) => String(a.start).localeCompare(String(b.start)));
        groups.set(id, kept);
        status.retainedProgrammes += kept.length;
    }
    addon.epgRetentionStatus = status;
    if (status.truncated)
        addon.log.warn(
            "EPG safety limit reached; partial guide retained",
            status
        );
    return Object.fromEntries(groups);
}

module.exports = { getEpgFetchConcurrency, mergeEpgSources };
