const { createLogger } = require('./logger');
const log = createLogger();

// Log actual upstream 429 responses only. No pacing, retries or request URLs.
module.exports = function logSeriesMetadata429(source, operation, identifiers, response) {
    if (response?.status !== 429) return;
    const details = { source, operation, status: 429 };
    for (const field of ['seriesId', 'tmdbId']) {
        const id = String(identifiers?.[field] ?? '');
        if (/^\d{1,12}$/.test(id)) details[field] = id;
    }
    if (/^tt\d{7,10}$/.test(String(identifiers?.imdbId || ''))) details.imdbId = identifiers.imdbId;
    if (Number.isSafeInteger(identifiers?.season) && identifiers.season >= 0 && identifiers.season <= 1000) details.season = identifiers.season;
    const retryAfter = response.headers?.get?.('retry-after');
    if (typeof retryAfter === 'string' && retryAfter.length <= 128) {
        const seconds = /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim())
            : (Date.parse(retryAfter) - Date.now()) / 1000;
        if (Number.isFinite(seconds) && seconds >= 0) details.retryAfterSeconds = Math.ceil(seconds);
    }
    log.warn('Series metadata request returned HTTP 429', details);
};
