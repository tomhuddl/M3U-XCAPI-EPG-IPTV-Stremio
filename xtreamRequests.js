const { AsyncLocalStorage } = require('node:async_hooks');

const requestContext = new AsyncLocalStorage();
const MAX_TIMER_MS = 2147483647;

class XtreamRateLimitError extends Error {
    constructor(retryAt = Date.now() + 60000) {
        super('Xtream requests paused after HTTP 429');
        this.name = 'XtreamRateLimitError';
        this.code = 'XTREAM_RATE_LIMITED';
        this.status = 429;
        this.retryAt = retryAt;
    }
}

function isXtreamRateLimitError(error) {
    return error?.code === 'XTREAM_RATE_LIMITED';
}

function retryAfterMilliseconds(value, now = Date.now()) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const text = value.trim();
    if (/^\d+$/.test(text)) {
        const seconds = Number(text);
        return Number.isSafeInteger(seconds) && seconds <= Number.MAX_SAFE_INTEGER / 1000
            ? seconds * 1000 : null;
    }
    // An HTTP date must contain a month/day name; reject permissive Date.parse
    // inputs such as negative numbers and fractional delay-seconds.
    if (!/[a-z]/i.test(text)) return null;
    const date = Date.parse(text);
    return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function requestTag(url) {
    const action = url.searchParams.get('action');
    if (action === 'get_series_info') return action + ':' + url.searchParams.get('series_id');
    if (action === 'get_vod_info') return action + ':' + url.searchParams.get('vod_id');
    return ['get_live_streams', 'get_vod_streams', 'get_series', 'get_live_categories',
        'get_vod_categories', 'get_series_categories'].includes(action)
        ? action : (url.pathname.endsWith('/xmltv.php') ? 'xmltv' : 'playlist');
}

function createXtreamRequestScheduler(options = {}) {
    const now = options.now || Date.now;
    const setTimer = options.setTimer || setTimeout;
    const clearTimer = options.clearTimer || clearTimeout;
    const minIntervalMs = options.minIntervalMs ?? 1000;
    const maxConcurrent = options.maxConcurrent ?? 2;
    const defaultCooldownMs = options.defaultCooldownMs ?? 60000;
    const states = new Map();

    function originFor(addon) {
        return new URL(addon.config.xtreamUrl).origin;
    }

    function stateFor(origin) {
        let state = states.get(origin);
        if (!state) {
            // Never evict an active cooldown: another addon instance on the same
            // host must not bypass it. Idle entries are otherwise bounded.
            if (states.size >= 256) {
                for (const [key, entry] of states) {
                    if (!entry.active && !entry.queue.length && entry.cooldownUntil <= now()) {
                        states.delete(key);
                        break;
                    }
                }
                if (states.size >= 256) throw new Error('Xtream request scheduler capacity reached');
            }
            state = { queue: [], active: 0, nextStartAt: 0, intervalMs: minIntervalMs,
                cooldownUntil: 0, strikes: 0, timer: null, paused: false,
                rejectedDuringCooldown: 0, promoted: new Map() };
            states.set(origin, state);
        }
        return state;
    }

    function cancelled(job) {
        return job.owner?.disposed || (job.context?.isCurrent && !job.context.isCurrent());
    }

    function cancellationError() {
        const error = new Error('Xtream request no longer needed');
        error.code = 'XTREAM_REQUEST_CANCELLED';
        return error;
    }

    function clearWakeup(state) {
        if (state.timer !== null) clearTimer(state.timer);
        state.timer = null;
    }

    function pause(state, response, job) {
        const time = now();
        const alreadyPaused = state.cooldownUntil > time;
        state.strikes = Math.min(5, state.strikes + 1);
        const fallback = Math.min(15 * 60 * 1000, defaultCooldownMs * 2 ** (state.strikes - 1));
        const supplied = retryAfterMilliseconds(response.headers?.get?.('retry-after'), time);
        const delay = Math.max(1000, supplied ?? fallback);
        state.cooldownUntil = Math.max(state.cooldownUntil, Math.min(8640000000000000, time + delay));
        state.intervalMs = Math.min(10000, Math.max(minIntervalMs, state.intervalMs * 2));
        state.paused = true;
        clearWakeup(state);
        const error = new XtreamRateLimitError(state.cooldownUntil);
        const queued = state.queue.splice(0);
        state.rejectedDuringCooldown += queued.length;
        queued.forEach(waiting => waiting.reject(error));
        if (!alreadyPaused) job.owner.log?.warn?.('Xtream rate limit reached; provider requests paused', {
            operation: job.tag.split(':')[0],
            retryAfterSeconds: Math.ceil((state.cooldownUntil - time) / 1000),
            requestIntervalMs: state.intervalMs
        });
        return error;
    }

    function drain(state) {
        clearWakeup(state);
        for (let index = state.queue.length - 1; index >= 0; index--) {
            if (cancelled(state.queue[index])) state.queue.splice(index, 1)[0].reject(cancellationError());
        }
        if (!state.queue.length || state.active >= maxConcurrent) return;
        const time = now();
        const wait = Math.max(state.nextStartAt, state.cooldownUntil) - time;
        if (wait > 0) {
            state.timer = setTimer(() => { state.timer = null; drain(state); }, Math.min(wait, MAX_TIMER_MS));
            return;
        }
        let index = state.queue.findIndex(job => job.priority === 'interactive');
        if (index < 0) index = 0;
        const job = state.queue.splice(index, 1)[0];
        if (state.paused) {
            state.paused = false;
            job.owner.log?.info?.('Xtream provider requests resumed', {
                requestIntervalMs: state.intervalMs,
                requestsDeferred: state.rejectedDuringCooldown
            });
            state.rejectedDuringCooldown = 0;
        }
        state.active++;
        state.nextStartAt = time + state.intervalMs;
        // Keep the slot until the caller has read/parsed the response body.
        Promise.resolve().then(async () => {
            if (cancelled(job)) throw cancellationError();
            const response = await job.fetch();
            if (response?.status === 429) {
                const error = pause(state, response, job);
                response.body?.destroy?.();
                throw error;
            }
            return job.consume(response);
        }).then(job.resolve, job.reject).finally(() => {
            state.active--;
            drain(state);
        });
        drain(state);
    }

    async function request(owner, input, fetchResponse, consume = response => response) {
        const url = new URL(input);
        const origin = originFor(owner);
        // Custom XMLTV feeds on other hosts have independent quotas.
        if (url.origin !== origin) return consume(await fetchResponse());
        const state = stateFor(origin);
        const context = requestContext.getStore();
        const job = { owner, context };
        if (cancelled(job)) throw cancellationError();
        if (state.cooldownUntil > now()) {
            state.rejectedDuringCooldown++;
            throw new XtreamRateLimitError(state.cooldownUntil);
        }
        if (state.queue.length >= 512) throw new Error('Xtream request queue capacity reached');
        const tag = requestTag(url);
        for (const [key, until] of state.promoted) if (until <= now()) state.promoted.delete(key);
        return new Promise((resolve, reject) => {
            state.queue.push({ ...job, tag, fetch: fetchResponse, consume, resolve, reject,
                priority: context?.priority === 'background' && !state.promoted.has(tag) ? 'background' : 'interactive' });
            drain(state);
        });
    }

    function promote(owner, id, type = 'series') {
        if (requestContext.getStore()?.priority === 'background' || owner.providerName !== 'xtream' || !owner.config?.xtreamUrl) return;
        const state = states.get(originFor(owner));
        if (!state) return;
        const tag = (type === 'movie' ? 'get_vod_info:' : 'get_series_info:') + String(id);
        state.promoted.delete(tag);
        state.promoted.set(tag, now() + 60000);
        while (state.promoted.size > 128) state.promoted.delete(state.promoted.keys().next().value);
        state.queue.forEach(job => { if (job.tag === tag) job.priority = 'interactive'; });
        drain(state);
    }

    function cancel(owner) {
        for (const state of states.values()) {
            for (let index = state.queue.length - 1; index >= 0; index--) {
                const queuedOwner = state.queue[index].owner;
                if (queuedOwner === owner || Object.getPrototypeOf(queuedOwner) === owner) {
                    state.queue.splice(index, 1)[0].reject(cancellationError());
                }
            }
            drain(state);
        }
    }

    function getState(owner) {
        if (owner.providerName !== 'xtream' && owner.config?.provider !== 'xtream') return null;
        if (!owner.config?.xtreamUrl) return null;
        const state = states.get(originFor(owner));
        return state ? { retryAt: state.cooldownUntil, requestIntervalMs: state.intervalMs,
            queued: state.queue.length, active: state.active } : null;
    }

    function close() {
        for (const state of states.values()) {
            clearWakeup(state);
            state.queue.splice(0).forEach(job => job.reject(cancellationError()));
        }
        states.clear();
    }

    return { request, promote, cancel, getState, close };
}

module.exports = {
    ...createXtreamRequestScheduler(), createXtreamRequestScheduler,
    XtreamRateLimitError, isXtreamRateLimitError, retryAfterMilliseconds,
    isBackground: () => requestContext.getStore()?.priority === 'background',
    background: (isCurrent, run) => requestContext.run({ priority: 'background', isCurrent }, run)
};
