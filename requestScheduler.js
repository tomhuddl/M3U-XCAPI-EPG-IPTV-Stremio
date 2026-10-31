"use strict";
// Bound active requests per origin; reserve capacity for interactive loading.
// This is concurrency control, with no rate-limit cooldown or timed retry queue.
class RequestScheduler {
    constructor({
        limit = 12,
        backgroundLimit = 4,
        maxQueued = 512,
        globalLimit = 32,
        globalBackgroundLimit = Math.max(1, globalLimit - 8),
        maxOrigins = 64,
        maxQueuedTotal = 1024
    } = {}) {
        this.limit = limit;
        this.backgroundLimit = backgroundLimit;
        this.maxQueued = maxQueued;
        this.globalLimit = globalLimit;
        this.maxOrigins = maxOrigins;
        this.maxQueuedTotal = maxQueuedTotal;
        this.globalBackgroundLimit = Math.min(
            globalLimit,
            globalBackgroundLimit
        );
        this.backgroundTotal = 0;
        this.activeTotal = 0;
        this.queuedTotal = 0;
        this.originCursor = 0;
        this.origins = new Map();
    }
    acquire(origin, priority = "foreground", { signal } = {}) {
        if (signal?.aborted) return Promise.reject(this.abortError());
        let state = this.origins.get(origin);
        if (
            (!state && this.origins.size >= this.maxOrigins) ||
            this.queuedTotal >= this.maxQueuedTotal
        )
            return Promise.reject(
                Object.assign(new Error("Upstream loading capacity reached"), {
                    code: "LOAD_CAPACITY"
                })
            );
        if (!state)
            this.origins.set(
                origin,
                (state = {
                    active: 0,
                    background: 0,
                    foreground: [],
                    low: [],
                    foregroundStreak: 0
                })
            );
        if (state.foreground.length + state.low.length >= this.maxQueued) {
            const error = new Error("Upstream loading capacity reached");
            error.code = "LOAD_CAPACITY";
            return Promise.reject(error);
        }
        return new Promise((resolve, reject) => {
            const queue =
                priority === "background" ? state.low : state.foreground;
            const ticket = {
                start: (release) => {
                    cleanup();
                    resolve(release);
                }
            };
            const cancel = () => {
                const index = queue.indexOf(ticket);
                if (index < 0) return;
                queue.splice(index, 1);
                this.queuedTotal--;
                cleanup();
                reject(this.abortError());
                this.drainAll();
            };
            const cleanup = () => signal?.removeEventListener("abort", cancel);
            signal?.addEventListener("abort", cancel, { once: true });
            queue.push(ticket);
            this.queuedTotal++;
            this.drainAll();
        });
    }
    abortError() {
        return Object.assign(new Error("Request aborted or timed out"), {
            name: "AbortError"
        });
    }
    drainAll() {
        const entries = [...this.origins];
        if (!entries.length) return;
        const first = this.originCursor++ % entries.length;
        for (let i = 0; i < entries.length; i++) {
            const [origin, state] = entries[(first + i) % entries.length];
            this.drain(origin, state);
        }
    }
    drain(origin, state) {
        while (
            state.active < this.limit &&
            this.activeTotal < this.globalLimit
        ) {
            const canStartBackground =
                state.background < this.backgroundLimit &&
                this.backgroundTotal < this.globalBackgroundLimit;
            const low =
                state.foreground.length === 0 ||
                (state.low.length > 0 &&
                    canStartBackground &&
                    state.foregroundStreak >= 8);
            if (low && (!canStartBackground || !state.low.length)) break;
            const next = (low ? state.low : state.foreground).shift();
            if (!next) break;
            state.active++;
            this.activeTotal++;
            this.queuedTotal--;
            if (low) {
                state.background++;
                this.backgroundTotal++;
            }
            state.foregroundStreak = low ? 0 : state.foregroundStreak + 1;
            let released = false;
            next.start(() => {
                if (released) return;
                released = true;
                state.active--;
                this.activeTotal--;
                if (low) {
                    state.background--;
                    this.backgroundTotal--;
                }
                this.drainAll();
            });
        }
        if (!state.active && !state.foreground.length && !state.low.length)
            this.origins.delete(origin);
    }
}
module.exports = RequestScheduler;
