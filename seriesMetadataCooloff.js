const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createLogger } = require('./logger');
const log429 = require('./seriesMetadataLog');
const log = createLogger();
const context = new AsyncLocalStorage();

class SeriesMetadataCooloff extends Error {
    constructor(retryAt, scope) {
        super('Series metadata lookup deferred during provider cool-off');
        this.name = 'SeriesMetadataCooloff';
        this.code = 'SERIES_METADATA_COOLOFF';
        this.retryAt = retryAt;
        this.scope = scope;
    }
}

function retryAfterMs(response, now) {
    const value = response.headers?.get?.('retry-after');
    if (typeof value !== 'string' || !value.trim() || value.length > 128) return null;
    const text = value.trim();
    if (/^\d+$/.test(text)) {
        const seconds = Number(text);
        return Number.isSafeInteger(seconds) && seconds <= Number.MAX_SAFE_INTEGER / 1000 ? seconds * 1000 : null;
    }
    if (!/[a-z]/i.test(text)) return null;
    const date = Date.parse(text);
    return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function createSeriesMetadataCooloff(options = {}) {
    const now = options.now || (() => Date.now());
    const states = new Map();
    const defaultMs = options.defaultMs ?? 60000;
    const maxBackgroundMs = options.maxBackgroundMs ?? 300000;
    const logger = options.logger || log;
    const warn429 = options.log429 || log429;

    function stateFor(owner) {
        const config = owner.config;
        if (!config?.xtreamUrl) return null;
        // A result for one provider account must never affect a different account.
        // Only a digest is retained; credentials and request URLs are never logged.
        const key = crypto.createHash('sha256').update(JSON.stringify([
            config.xtreamUrl.replace(/\/+$/, ''), config.xtreamUsername, config.xtreamPassword
        ])).digest('hex');
        let state = states.get(key);
        if (!state) {
            for (const [other, value] of states) {
                if (now() - value.lastUsed > 3600000 && value.backgroundRetryAt <= now() && value.providerRetryAt <= now()) states.delete(other);
            }
            if (states.size >= 256) throw new Error('Series cool-off capacity reached');
            state = { failures: new Map(), backgroundRetryAt: 0, providerRetryAt: 0,
                strikes: 0, lastLimit: 0, lastUsed: now(), summaryPending: false,
                actual429s: 0, reused429s: 0, deferredLookups: 0 };
            states.set(key, state);
        }
        state.lastUsed = now();
        for (const [id, value] of state.failures) if (value.retryAt <= now()) state.failures.delete(id);
        return state;
    }

    function finishWindow(state) {
        if (!state.summaryPending || state.backgroundRetryAt > now()) return;
        logger.info('Xtream series metadata cool-off summary', {
            actual429s: state.actual429s, reused429s: state.reused429s,
            deferredLookups: state.deferredLookups
        });
        state.summaryPending = false;
        state.actual429s = state.reused429s = state.deferredLookups = 0;
    }

    function guard(owner, seriesId) {
        const state = stateFor(owner);
        if (!state) return null;
        finishWindow(state);
        const saved = state.failures.get(String(seriesId));
        if (saved) {
            state.reused429s++;
            return { diagnostic: { ...saved, reused429: true } };
        }
        // Only an explicit upstream Retry-After applies to interactive lookups
        // for other series. Our longer fallback recovery pause is background-only.
        if (state.providerRetryAt > now()) {
            state.deferredLookups++;
            throw new SeriesMetadataCooloff(state.providerRetryAt, 'retry-after');
        }
        if (context.getStore() === 'background' && state.backgroundRetryAt > now()) {
            state.deferredLookups++;
            throw new SeriesMetadataCooloff(state.backgroundRetryAt, 'background');
        }
        return null;
    }

    function record429(owner, seriesId, response) {
        const state = stateFor(owner);
        finishWindow(state);
        const time = now();
        const continuingWindow = state.summaryPending && state.backgroundRetryAt > time;
        if (time - state.lastLimit > 30 * 60000) state.strikes = 0;
        if (!continuingWindow) state.strikes = Math.min(4, state.strikes + 1);
        state.lastLimit = time;
        const supplied = retryAfterMs(response, time);
        const perSeriesDelay = Math.max(1000, supplied ?? defaultMs);
        const backgroundDelay = Math.max(perSeriesDelay, Math.min(maxBackgroundMs, defaultMs * 2 ** (state.strikes - 1)));
        const deadline = delay => Math.min(8640000000000000, time + delay);
        state.backgroundRetryAt = Math.max(state.backgroundRetryAt,
            continuingWindow && supplied === null ? state.backgroundRetryAt : deadline(backgroundDelay));
        if (supplied !== null) state.providerRetryAt = Math.max(state.providerRetryAt, deadline(Math.max(1000, supplied)));
        const diagnostic = { reason: 'provider_http_error', source: 'xtream_get_series_info',
            httpStatus: 429, retryAt: deadline(perSeriesDelay) };
        state.failures.delete(String(seriesId));
        state.failures.set(String(seriesId), diagnostic);
        while (state.failures.size > 2000) state.failures.delete(state.failures.keys().next().value);
        state.actual429s++;
        if (!state.summaryPending) {
            state.summaryPending = true;
            warn429('xtream', 'get_series_info', { seriesId }, response);
            logger.info('Xtream series metadata background lookups cooling off', {
                retryAt: new Date(state.backgroundRetryAt).toISOString(),
                retryAfterSeconds: Math.ceil((state.backgroundRetryAt - time) / 1000),
                providerRetryAfterSupplied: supplied !== null
            });
        }
        return { diagnostic };
    }

    function getState(owner) {
        const state = stateFor(owner);
        return state ? { backgroundRetryAt: state.backgroundRetryAt, providerRetryAt: state.providerRetryAt,
            actual429s: state.actual429s, reused429s: state.reused429s, deferredLookups: state.deferredLookups,
            cachedFailures: state.failures.size } : null;
    }

    return { guard, record429, getState };
}

module.exports = {
    ...createSeriesMetadataCooloff(), createSeriesMetadataCooloff,
    SeriesMetadataCooloff,
    isCooloff: error => error?.code === 'SERIES_METADATA_COOLOFF',
    background: run => context.run('background', run),
    isBackground: () => context.getStore() === 'background'
};
