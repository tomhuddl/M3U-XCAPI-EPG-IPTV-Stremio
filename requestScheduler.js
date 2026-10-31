"use strict";
// Bound active requests per origin; reserve capacity for interactive loading.
// This is concurrency control, with no rate-limit cooldown or timed retry queue.
class RequestScheduler {
    constructor({ limit = 12, backgroundLimit = 4, maxQueued = 512 } = {}) {
        this.limit = limit; this.backgroundLimit = backgroundLimit; this.maxQueued = maxQueued;
        this.origins = new Map();
    }
    acquire(origin, priority = "foreground") {
        let state = this.origins.get(origin);
        if (!state) this.origins.set(origin, state = { active: 0, background: 0, foreground: [], low: [], foregroundStreak: 0 });
        if (state.foreground.length + state.low.length >= this.maxQueued) {
            const error = new Error("Upstream loading capacity reached"); error.code = "LOAD_CAPACITY";
            return Promise.reject(error);
        }
        return new Promise(resolve => {
            (priority === "background" ? state.low : state.foreground).push(resolve);
            this.drain(origin, state);
        });
    }
    drain(origin, state) {
        while (state.active < this.limit) {
            const low = state.foreground.length === 0 ||
                (state.low.length > 0 && state.background < this.backgroundLimit && state.foregroundStreak >= 8);
            if (low && (state.background >= this.backgroundLimit || !state.low.length)) break;
            const next = (low ? state.low : state.foreground).shift();
            if (!next) break;
            state.active++; if (low) state.background++;
            state.foregroundStreak = low ? 0 : state.foregroundStreak + 1;
            let released = false;
            next(() => {
                if (released) return; released = true;
                state.active--; if (low) state.background--;
                this.drain(origin, state);
            });
        }
        if (!state.active && !state.foreground.length && !state.low.length) this.origins.delete(origin);
    }
}
module.exports = RequestScheduler;

