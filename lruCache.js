// Minimal in-memory LRU + TTL cache.
class LRUCache {
    constructor({ max = 100, ttl = 6 * 3600 * 1000 } = {}) {
        this.max = Number.isSafeInteger(max) && max > 0 ? max : 100;
        this.ttl = Number.isFinite(ttl) && ttl >= 0 ? ttl : 6 * 3600 * 1000;
        this.map = new Map(); // key -> { value, expires }
    }

    _now() {
        return Date.now();
    }

    _pruneExpired() {
        const now = this._now();
        for (const [key, entry] of this.map.entries()) {
            if (entry.expires !== null && entry.expires <= now) {
                this.map.delete(key);
            }
        }
    }

    get(key) {
        const entry = this.map.get(key);
        if (!entry) return undefined;
        if (entry.expires !== null && entry.expires <= this._now()) {
            this.map.delete(key);
            return undefined;
        }

        // Promote the accessed entry to the most-recently-used position.
        this.map.delete(key);
        this.map.set(key, entry);
        return entry.value;
    }

    set(key, value) {
        if (this.map.has(key)) this.map.delete(key);
        // Prune only on writes, not every read, to avoid scanning the full cache
        // for every request. The map remains bounded by max.
        this._pruneExpired();
        this.map.set(key, {
            value,
            expires: this.ttl > 0 ? this._now() + this.ttl : null,
        });

        while (this.map.size > this.max) {
            const oldestKey = this.map.keys().next().value;
            this.map.delete(oldestKey);
        }
    }

    delete(key) {
        this.map.delete(key);
    }

    has(key) {
        return this.get(key) !== undefined;
    }

    keys() {
        this._pruneExpired();
        return Array.from(this.map.keys());
    }

    entries() {
        this._pruneExpired();
        return Array.from(this.map.entries(), ([key, entry]) => [key, entry.value]);
    }

    clear() {
        this.map.clear();
    }
}

module.exports = LRUCache;
