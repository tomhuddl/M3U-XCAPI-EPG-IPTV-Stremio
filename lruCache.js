// Bounded in-memory LRU cache with optional TTL, approximate weight, and eviction cleanup.
class LRUCache {
    constructor({ max = 100, ttl = 6 * 3600 * 1000, maxWeight = Infinity, sizeOf, onEvict } = {}) {
        this.max = Number.isSafeInteger(max) && max > 0 ? max : 100;
        this.ttl = Number.isFinite(ttl) && ttl >= 0 ? ttl : 6 * 3600 * 1000;
        this.maxWeight = Number.isFinite(maxWeight) && maxWeight > 0 ? maxWeight : Infinity;
        this.sizeOf = typeof sizeOf === 'function' ? sizeOf : () => 1;
        this.onEvict = typeof onEvict === 'function' ? onEvict : null;
        this.totalWeight = 0;
        this.map = new Map(); // key -> { value, expires, weight }
    }

    _now() {
        return Date.now();
    }

    _weight(value) {
        try {
            const weight = Number(this.sizeOf(value));
            return Number.isFinite(weight) && weight > 0 ? weight : 1;
        } catch {
            return 1;
        }
    }

    _delete(key, reason) {
        const entry = this.map.get(key);
        if (!entry) return false;
        this.map.delete(key);
        this.totalWeight = Math.max(0, this.totalWeight - entry.weight);
        if (this.onEvict) {
            try {
                this.onEvict(entry.value, key, reason);
            } catch {
                // Cache cleanup must never break a caller's cache operation.
            }
        }
        return true;
    }

    _pruneExpired() {
        const now = this._now();
        for (const [key, entry] of this.map.entries()) {
            if (entry.expires !== null && entry.expires <= now) this._delete(key, 'expired');
        }
    }

    get(key) {
        const entry = this.map.get(key);
        if (!entry) return undefined;
        if (entry.expires !== null && entry.expires <= this._now()) {
            this._delete(key, 'expired');
            return undefined;
        }
        this.map.delete(key);
        this.map.set(key, entry);
        return entry.value;
    }

    set(key, value, ttl = this.ttl) {
        const entryTtl = Number.isFinite(ttl) && ttl >= 0 ? ttl : this.ttl;
        const existing = this.map.get(key);
        if (existing && existing.value === value) {
            this.map.delete(key);
            existing.expires = entryTtl > 0 ? this._now() + entryTtl : null;
            const weight = this._weight(value);
            this.totalWeight += weight - existing.weight;
            existing.weight = weight;
            this.map.set(key, existing);
            this._evictCapacity();
            return;
        }
        if (this.map.has(key)) this._delete(key, 'replaced');
        this._pruneExpired();
        const weight = this._weight(value);
        this.map.set(key, {
            value,
            weight,
            expires: entryTtl > 0 ? this._now() + entryTtl : null,
        });
        this.totalWeight += weight;

        this._evictCapacity();
    }

    _evictCapacity() {
        // Keep one oversized entry instead of rebuilding it on every request.
        while (this.map.size > this.max || (this.totalWeight > this.maxWeight && this.map.size > 1)) {
            const oldestKey = this.map.keys().next().value;
            this._delete(oldestKey, 'capacity');
        }
    }

    delete(key) {
        this._delete(key, 'deleted');
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
        for (const key of [...this.map.keys()]) this._delete(key, 'cleared');
    }
}

module.exports = LRUCache;
