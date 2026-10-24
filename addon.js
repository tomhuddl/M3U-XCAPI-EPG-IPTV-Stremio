// IPTV Stremio Addon Core (with debug logging + series (shows) support for BOTH Xtream & Direct M3U)
// Version 1.4.0: Adds Direct M3U series grouping + per‑episode streams
require('dotenv').config();

const { addonBuilder } = require("stremio-addon-sdk");
const crypto = require("crypto");
const LRUCache = require("./lruCache");
const PersistentCatalogMetaCache = require("./persistentCatalogMetaCache");
const PersistentAddonDataCache = require("./persistentAddonDataCache");
const tmdbMetadata = require("./src/js/tmdbMetadata");
const omdbMetadata = require("./src/js/omdbMetadata");

// Retry incomplete OMDb data independently of the longer metadata refresh interval.
// Missing ratings/runtime are retried at most once per configured interval.
const OMDB_MISSING_DATA_RETRY_MS = parsePositiveInteger(
    process.env.OMDB_MISSING_DATA_RETRY_MS, 12 * 60 * 60 * 1000,
    60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000
);

function omdbMetadataNeedsRefresh(value) {
    if (!value || !value.imdbId) return false;
    if (value.imdbRating && value.runtime) return false;
    const checkedAt = Number(value.omdbCheckedAt) || 0;
    return !checkedAt || Date.now() - checkedAt >= OMDB_MISSING_DATA_RETRY_MS;
}

// Retry incomplete combined catalogue metadata from any source on the same
// 12-hour cadence, without making complete cards refresh more often than 14 days.
/** Remove TMDb score fields/links from user-facing metadata while retaining
 * TMDb-sourced artwork, descriptions, cast, dates and other metadata. */
function stripTmdbRatings(meta) {
    if (!meta || typeof meta !== 'object') return meta;
    delete meta.tmdbRating;
    if (Array.isArray(meta.links)) {
        meta.links = meta.links.filter(link =>
            !/^TMDb rating:/i.test(String(link?.name || '').trim())
        );
    }
    if (Array.isArray(meta.videos)) {
        for (const video of meta.videos) {
            if (video && Array.isArray(video.links)) {
                video.links = video.links.filter(link =>
                    !/^TMDb rating:/i.test(String(link?.name || '').trim())
                );
            }
        }
    }
    return meta;
}

function catalogMetadataNeedsRefresh(value) {
    if (!value || typeof value !== 'object') return false;
    const missing = [
        !value.poster,
        !value.background,
        !value.description || value.description === 'Series / Show',
        !Array.isArray(value.genres) || value.genres.length === 0,
        !(value.year || value.releaseInfo),
        !value.runtime,
        !value.imdbRating,
        !Array.isArray(value.cast) || value.cast.length === 0,
        Boolean(value._tmdbId && !value.imdbId),
        value.type === 'movie' && !value.director
    ].some(Boolean);
    if (!missing) return false;
    const checkedAt = Number(value.metadataCheckedAt) || 0;
    return !checkedAt || Date.now() - checkedAt >= OMDB_MISSING_DATA_RETRY_MS;
}

const CACHE_ENABLED = (process.env.CACHE_ENABLED || 'true').toLowerCase() !== 'false';

let redisClient = null;
if (process.env.REDIS_URL && CACHE_ENABLED) {
    try {
        const { Redis } = require('ioredis');
        redisClient = new Redis(process.env.REDIS_URL, {
            lazyConnect: true,
            maxRetriesPerRequest: 2
        });
        redisClient.on('error', e => console.error('[REDIS] Error:', e && e.name ? e.name : 'Error'));
        redisClient.connect().catch(err => console.error('[REDIS] Connect failed:', err && err.name ? err.name : 'Error'));
        console.log('[REDIS] Enabled');
    } catch (e) {
        console.warn('[REDIS] ioredis not installed or failed, falling back to in-memory LRU');
        redisClient = null;
    }
}

const ADDON_NAME = "M3U/EPG TV Addon";
const ADDON_ID = "org.stremio.m3u-epg-addon";

/**
 * Compare catalogue genre labels defensively. Xtream category names and
 * Stremio's selected genre can differ only by casing or whitespace
 * (including non-breaking spaces), which should not hide otherwise matching
 * channels from a filtered catalogue.
 */
function normalizeGenre(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

// Cache exact ID lookups for immutable provider catalogue arrays. When a refresh
// replaces an array, its new identity naturally gets a fresh index.
const catalogueIdIndexes = new WeakMap();

// Genre labels are stable for a loaded catalogue. Cache their normalised values
// per catalogue array so browsing different genres doesn't repeatedly run Unicode
// normalisation over every item in large movie/series libraries.
const catalogueGenreIndexes = new WeakMap();

function getCatalogueGenreIndex(items) {
    let index = catalogueGenreIndexes.get(items);
    if (index) return { index, built: false };

    index = new Map();
    for (const item of items) {
        if (!item || index.has(item)) continue;
        const category = item.category || item.attributes?.['group-title'];
        index.set(item, normalizeGenre(category));
    }
    catalogueGenreIndexes.set(items, index);
    return { index, built: true };
}

function findCatalogueItemById(items, id) {
    if (!Array.isArray(items) || !id) return undefined;
    let index = catalogueIdIndexes.get(items);
    if (!index) {
        index = new Map();
        for (const item of items) {
            if (item && item.id != null && !index.has(item.id)) index.set(item.id, item);
        }
        catalogueIdIndexes.set(items, index);
    }
    return index.get(id);
}

function matchesGenre(category, selectedGenre) {
    const selected = normalizeGenre(selectedGenre);
    return selected.length > 0 && normalizeGenre(category) === selected;
}

/**
 * Normalise catalogue search text without changing the displayed title.
 * Unicode punctuation/symbols become spaces, and repeated whitespace collapses,
 * making hyphenated and unhyphenated title variants equivalent.
 */
function normalizeSearchText(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()
        .replace(/[\p{P}\p{S}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Return true when every query word can be matched to a distinct title word.
 * Exact phrase matching remains the fast path; token matching also supports
 * reordered words, partial words while typing, and a single-character typo
 * in words of at least five characters.
 */
// Search normalization is repeated for every catalogue item and every query.
// Keep a bounded cache so large libraries avoid re-normalizing the same titles.
const NORMALIZED_SEARCH_CACHE_MAX = parsePositiveInteger(
    process.env.SEARCH_TEXT_CACHE_MAX, 20000, 1000, 100000
);
// Use a bounded FIFO Map here rather than the shared LRU implementation: that
// cache prunes expired entries on every write, which is undesirable when a
// large catalogue introduces thousands of new titles in one search pass.
const normalizedSearchCache = new Map();

function getNormalizedSearchText(value) {
    const original = String(value ?? '');
    const cached = normalizedSearchCache.get(original);
    if (cached !== undefined) return cached;
    const normalized = normalizeSearchText(original);
    normalizedSearchCache.set(original, normalized);
    if (normalizedSearchCache.size > NORMALIZED_SEARCH_CACHE_MAX) {
        normalizedSearchCache.delete(normalizedSearchCache.keys().next().value);
    }
    return normalized;
}

// Cache normalized titles against each immutable catalogue array. The general
// bounded text cache can churn when movie and series catalogues are both searched;
// this per-catalogue index keeps normalized titles reusable across successive queries.
const catalogueSearchIndexes = new WeakMap();

// Cache filtered search results per immutable catalogue array. WeakMap keys allow
// old indexes to be collected after a provider refresh replaces the catalogue.
const CATALOGUE_QUERY_RESULT_CACHE_MAX = parsePositiveInteger(
    process.env.CATALOGUE_QUERY_RESULT_CACHE_MAX, 100, 10, 1000
);
const catalogueQueryResultCaches = new WeakMap();

function getCatalogueQueryResultCache(items) {
    if (!Array.isArray(items)) return null;
    let cache = catalogueQueryResultCaches.get(items);
    if (!cache) {
        cache = new Map();
        catalogueQueryResultCaches.set(items, cache);
    }
    return cache;
}

function createCatalogueQueryCacheKey(normalizedSearchQuery, selectedGenre = '') {
    return normalizedSearchQuery ? JSON.stringify([selectedGenre, normalizedSearchQuery]) : null;
}

function cacheCatalogueQueryResults(cache, key, filtered, maxEntries = CATALOGUE_QUERY_RESULT_CACHE_MAX) {
    if (!cache || !key) return;
    cache.delete(key);
    cache.set(key, filtered);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
}


function getCatalogueSearchIndex(items) {
    let index = catalogueSearchIndexes.get(items);
    if (index) return { index, built: false };

    index = new Map();
    for (const item of items) {
        if (item && !index.has(item)) {
            const text = getNormalizedSearchText(item.name);
            // Tokenisation is title-dependent too, so prepare it once per
            // catalogue item rather than splitting every title on every query.
            index.set(item, { text, words: text.split(' ').filter(Boolean) });
        }
    }
    catalogueSearchIndexes.set(items, index);
    return { index, built: true };
}

function matchesSearchText(query, title) {
    return matchesNormalizedSearchText(
        getNormalizedSearchText(query),
        getNormalizedSearchText(title)
    );
}

function createNormalizedSearchMatcher(q) {
    if (!q) return () => false;

    // Query tokenization and ordering are independent of the title, so compile
    // them once per search request rather than once per catalogue item.
    const words = q.split(' ').filter(Boolean).sort((a, b) => b.length - a.length);
    return function matchNormalizedTitle(text, preparedTitleWords) {
        if (!text) return false;
        if (text.includes(q)) return true;

        const titleWords = preparedTitleWords || text.split(' ').filter(Boolean);
        if (!words.length || words.length > titleWords.length) return false;
        const used = new Set();

        function matchesWord(queryWord, titleWord) {
            if (titleWord.startsWith(queryWord)) return true;
            if (queryWord.length < 5 || titleWord.length < 5) return false;
            return editDistanceAtMostOne(queryWord, titleWord);
        }

        function assign(index) {
            if (index >= words.length) return true;
            const word = words[index];
            for (let i = 0; i < titleWords.length; i++) {
                if (used.has(i) || !matchesWord(word, titleWords[i])) continue;
                used.add(i);
                if (assign(index + 1)) return true;
                used.delete(i);
            }
            return false;
        }

        return assign(0);
    };
}

function matchesNormalizedSearchText(q, text) {
    return createNormalizedSearchMatcher(q)(text);
}

function editDistanceAtMostOne(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    let j = 0;
    let edits = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            i++;
            j++;
            continue;
        }
        if (++edits > 1) return false;
        if (a.length > b.length) i++;
        else if (b.length > a.length) j++;
        else {
            i++;
            j++;
        }
    }
    if (i < a.length || j < b.length) edits++;
    return edits <= 1;
}

const DEBUG_ENV = (process.env.DEBUG_MODE || '').toLowerCase() === 'true';
function makeLogger(cfgDebug) {
    const enabled = !!cfgDebug || DEBUG_ENV;
    return {
        debug: (...a) => { if (enabled) console.log('[DEBUG]', ...a); },
        info:  (...a) => console.log('[INFO]', ...a),
        warn:  (...a) => console.warn('[WARN]', ...a),
        error: (...a) => console.error('[ERROR]', ...a)
    };
}

function parsePositiveInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed >= min
        ? Math.min(parsed, max)
        : fallback;
}
const CACHE_TTL_MS = parsePositiveInteger(process.env.CACHE_TTL_MS, 6 * 3600 * 1000, 1000, 30 * 24 * 3600 * 1000);
const MAX_CACHE_ENTRIES = parsePositiveInteger(process.env.MAX_CACHE_ENTRIES, 100, 1, 500);

const dataCache = new LRUCache({ max: MAX_CACHE_ENTRIES, ttl: CACHE_TTL_MS });
const buildPromiseCache = new Map();

async function redisGetJSON(key) {
    if (!redisClient) return null;
    try {
        const raw = await redisClient.get(key);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch { return null; }
}
async function redisSetJSON(key, value, ttl) {
    if (!redisClient) return;
    try {
        await redisClient.set(key, JSON.stringify(value), 'PX', ttl);
    } catch { /* ignore */ }
}

function stableStringify(obj) {
    // This cache-key input is deliberately a flat object with a fixed property order.
    return JSON.stringify(obj);
}

function safeStreamTarget(value) {
    try {
        const parsed = new URL(value);
        return parsed.protocol + '//' + parsed.host;
    } catch {
        return '[invalid URL]';
    }
}

function createCacheKey(config) {
    const minimal = {
        provider: config.provider,
        m3uUrl: config.m3uUrl,
        epgUrl: config.epgUrl,
        epgUrls: Array.isArray(config.epgUrls) ? config.epgUrls : [],
        enableEpg: !!config.enableEpg,
        xtreamUrl: config.xtreamUrl,
        xtreamUsername: config.xtreamUsername,
        // Keep accounts with different credentials in separate cache namespaces.
        xtreamPassword: config.xtreamPassword,
        xtreamUseM3U: !!config.xtreamUseM3U,
        xtreamOutput: config.xtreamOutput,
        epgOffsetHours: config.epgOffsetHours,
        includeSeries: config.includeSeries !== false // default true
    };
    return crypto.createHash('sha256').update(stableStringify(minimal)).digest('hex');
}

class M3UEPGAddon {
    constructor(config = {}, manifestRef) {
        if (!config.provider) {
            config.provider = config.useXtream ? 'xtream' : 'direct';
        }
        this.providerName = config.provider === 'xtream' ? 'xtream' : 'direct';
        this.config = config;
        this.manifestRef = manifestRef;
        this.cacheKey = createCacheKey(config);
        this.persistentAddonDataCache = new PersistentAddonDataCache(this.cacheKey);
        this.updateInterval = parsePositiveInteger(process.env.DATA_REFRESH_INTERVAL_MS, 12 * 60 * 60 * 1000, 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
        this.channels = []; // live TV
        this.movies = [];   // VOD movies
        this.series = [];   // Series (shows)
        // Bound lazily loaded episode metadata so browsing many series cannot grow
        // this addon instance's memory without limit.
        this.seriesInfoCache = new LRUCache({ max: 100, ttl: CACHE_TTL_MS });
        // Coalesce overlapping Xtream ID and series-info lookups started by parallel
        // Discover workers, avoiding duplicate provider API round-trips.
        this.providerInfoInFlight = new Map();
        // Cached catalogue enrichment lets later home/search requests return
        // rich cards without waiting on TMDb/Xtream for every item.
        this.catalogMetaCache = new LRUCache({
            max: parsePositiveInteger(process.env.CATALOG_META_CACHE_MAX, 1000, 50, 5000),
            ttl: parsePositiveInteger(process.env.CATALOG_META_CACHE_TTL_MS, 6 * 3600 * 1000, 1000, 30 * 24 * 3600 * 1000)
        });
        this.catalogMetaPending = new Map();
        this.persistentCatalogMetaCache = new PersistentCatalogMetaCache(this.cacheKey);
        this.catalogMetaStaleFallbacks = new Set();
        // At most one full-catalogue warm-up per media type. Search requests must not
        // spawn independent background walks over different filtered result sets.
        this.catalogPrefetchJobs = new Map();
        this.catalogPrefetchLastCompleted = new Map();
        // Remember which ordered catalogue the in-memory completion applies to, so
        // provider catalogue changes can trigger a new warm-up before the daily interval.
        this.catalogPrefetchLastFingerprint = new Map();
        // Avoid immediately rescanning thousands of provider items after a partial
        // warm-up or transient metadata outage. A later request can retry after backoff.
        this.catalogPrefetchRetryAfter = new Map();
        // Share concurrent foreground/background metadata work for the same item.
        // Without this, a category request and a queued warm-up can race and issue
        // duplicate Xtream lookups even though TMDb's own HTTP layer is deduplicated.
        this.catalogMetaInFlight = new Map();
        // Track asynchronous disk writes so a completed pre-warm can flush every
        // metadata preview before its durable completion marker is written.
        this.catalogMetaPersistWrites = new Set();
        this.catalogMetaQueue = [];
        this.catalogMetaQueueHead = 0;
        this.catalogMetaWorkers = 0;
        this.epgData = {};
        // XMLTV programme timestamps are immutable after parsing; cache their parsed
        // Date values per addon instance to avoid reparsing large guides on each request.
        this.epgTimeCache = new WeakMap();
        // Reuse chronological programme indexes for repeated guide date requests.
        this.epgProgramIndexes = new WeakMap();
        // Index each immutable per-channel programme array once. Prefix maximum
        // end-times let guide requests skip programmes that cannot overlap the
        // requested window, including programmes that started much earlier.
        this.lastUpdate = 0;
        this.log = makeLogger(config.debug);

        // Direct provider may populate this (seriesId -> episodes array)
        this.directSeriesEpisodeIndex = new Map();
        // Direct-provider episode IDs are stable for a loaded playlist; index them
        // so stream resolution does not scan every series and episode.
        this.directSeriesEpisodeById = new Map();

        if (typeof this.config.epgOffsetHours === 'string') {
            const n = parseFloat(this.config.epgOffsetHours);
            if (!isNaN(n)) this.config.epgOffsetHours = n;
        }
        if (typeof this.config.epgOffsetHours !== 'number' || !isFinite(this.config.epgOffsetHours))
            this.config.epgOffsetHours = 0;
        if (Math.abs(this.config.epgOffsetHours) > 48)
            this.config.epgOffsetHours = 0;
        if (typeof this.config.includeSeries === 'undefined')
            this.config.includeSeries = true;

        this.log.debug('Addon instance created', {
            provider: this.providerName,
            epgOffsetHours: this.config.epgOffsetHours,
            includeSeries: this.config.includeSeries
        });
    }

    async loadFromCache() {
        if (!CACHE_ENABLED) return;
        const cacheKey = 'addon:data:' + this.cacheKey;
        let cached = dataCache.get(cacheKey);
        if (!cached && redisClient) {
            cached = await redisGetJSON(cacheKey);
            if (cached) dataCache.set(cacheKey, cached);
        }
        if (!cached) {
            cached = await this.persistentAddonDataCache.load();
            if (cached) {
                dataCache.set(cacheKey, cached);
                this.log.info('Loaded provider catalogue and EPG from persistent storage');
            }
        }
        if (cached) {
            this.channels = cached.channels || [];
            this.movies = cached.movies || [];
            this.series = cached.series || [];
            this.epgData = cached.epgData || {};
            this.lastUpdate = cached.lastUpdate || 0;
            this.log.debug('Cache hit for data', {
                channels: this.channels.length,
                movies: this.movies.length,
                series: this.series.length,
                epgChannels: Object.keys(this.epgData).length,
                lastUpdate: this.lastUpdate ? new Date(this.lastUpdate).toISOString() : null
            });
        }
    }

    async saveToCache() {
        if (!CACHE_ENABLED) return;
        const cacheKey = 'addon:data:' + this.cacheKey;
        const entry = {
            channels: this.channels,
            movies: this.movies,
            series: this.series,
            epgData: this.epgData,
            lastUpdate: this.lastUpdate
        };
        dataCache.set(cacheKey, entry);
        await redisSetJSON(cacheKey, entry, CACHE_TTL_MS);
        try {
            const persisted = await this.persistentAddonDataCache.save(entry);
            if (persisted) this.log.info('Persisted provider catalogue and EPG snapshot');
        } catch (error) {
            // The in-memory/Redis copy remains usable; a disk write failure must not
            // interrupt a successful provider refresh or replace the last-good file.
            this.log.warn('Persistent provider data save failed', {
                name: error?.name || 'Error', code: error?.code || 'UNKNOWN',
                syscall: error?.syscall || null, message: String(error?.message || 'No error message').slice(0, 300)
            });
        }
        this.log.debug('Saved data to cache');
    }

    buildGenresInManifest() {
        if (!this.manifestRef) return;
        const tvCatalog = this.manifestRef.catalogs.find(c => c.id === 'iptv_channels');
        const movieCatalog = this.manifestRef.catalogs.find(c => c.id === 'iptv_movies');
        const seriesCatalog = this.manifestRef.catalogs.find(c => c.id === 'iptv_series');

        // Helper: set catalog.genres (options are added post-build to avoid SDK linter size limits).
        // Keep first-seen order so groups follow the provider's channel/category ordering.
        function setGenresOnCatalog(catalog, groups) {
            if (!catalog) return;
            catalog.genres = groups;
        }

        if (tvCatalog) {
            const groups = [
                ...new Set(
                    this.channels
                        .map(c => c.category || c.attributes?.['group-title'])
                        .filter(Boolean)
                        .map(s => s.trim())
                )
            ];
            if (!groups.includes('All Channels')) groups.unshift('All Channels');
            setGenresOnCatalog(tvCatalog, groups);
        }

        if (movieCatalog) {
            const movieGroups = [
                ...new Set(
                    this.movies
                        .map(c => c.category || c.attributes?.['group-title'])
                        .filter(Boolean)
                        .map(s => s.trim())
                )
            ];
            setGenresOnCatalog(movieCatalog, movieGroups);
        }

        if (seriesCatalog) {
            const seriesGroups = [
                ...new Set(
                    this.series
                        .map(c => c.category || c.attributes?.['group-title'])
                        .filter(Boolean)
                        .map(s => s.trim())
                )
            ];
            setGenresOnCatalog(seriesCatalog, seriesGroups);
        }

        this.log.debug('Catalog genres built', {
            tvGenres: tvCatalog?.genres?.length || 0,
            movieGenres: movieCatalog?.genres?.length || 0,
            seriesGenres: seriesCatalog?.genres?.length || 0
        });
    }

    parseM3U(content) {
        const startTs = Date.now();
        const lines = content.split('\n');
        const items = [];
        let currentItem = null;
        for (const raw of lines) {
            const line = raw.trim();
            if (line.startsWith('#EXTINF:')) {
                const matches = line.match(/#EXTINF:(-?\d+)(?:\s+(.*))?,(.*)/);
                if (matches) {
                    currentItem = {
                        duration: parseInt(matches[1]),
                        attributes: this.parseAttributes(matches[2] || ''),
                        name: (matches[3] || '').trim()
                    };
                }
            } else if (line && !line.startsWith('#') && currentItem) {
                currentItem.url = line;
                currentItem.logo = currentItem.attributes['tvg-logo'];
                currentItem.epg_channel_id = currentItem.attributes['tvg-id'] || currentItem.attributes['tvg-name'];
                currentItem.category = currentItem.attributes['group-title'];

                const group = (currentItem.attributes['group-title'] || '').toLowerCase();
                const lower = currentItem.name.toLowerCase();

                const isMovie =
                    group.includes('movie') ||
                    lower.includes('movie') ||
                    this.isMovieFormat(currentItem.name);

                const isSeries =
                    !isMovie && (
                        group.includes('series') ||
                        group.includes('show') ||
                        /\bS\d{1,2}E\d{1,2}\b/i.test(currentItem.name) ||
                        /\bSeason\s?\d+/i.test(currentItem.name)
                    );

                currentItem.type = isSeries ? 'series' : (isMovie ? 'movie' : 'tv');
                currentItem.id = `iptv_${crypto.createHash('md5').update(currentItem.name + currentItem.url).digest('hex').substring(0, 16)}`;
                items.push(currentItem);
                currentItem = null;
            }
        }
        const ms = Date.now() - startTs;
        this.log.debug('M3U parsed', { lines: lines.length, items: items.length, ms });
        return items;
    }

    parseAttributes(str) {
        const attrs = {};
        const regex = /(\w+(?:-\w+)*)="([^"]*)"/g;
        let m;
        while ((m = regex.exec(str)) !== null) attrs[m[1]] = m[2];
        return attrs;
    }

    isMovieFormat(name) {
        return [/\(\d{4}\)/, /\d{4}\./, /HD$|FHD$|4K$/i].some(p => p.test(name));
    }

    async parseEPG(content) {
        const start = Date.now();
        try {
            const xml2js = require('xml2js');
            const parser = new xml2js.Parser();
            const result = await parser.parseStringPromise(content);
            const epgData = {};
            if (result.tv && result.tv.programme) {
                for (const prog of result.tv.programme) {
                    const ch = prog.$.channel;
                    if (!epgData[ch]) epgData[ch] = [];
                    epgData[ch].push({
                        start: prog.$.start,
                        stop: prog.$.stop,
                        title: prog.title ? prog.title[0]._ || prog.title[0] : 'Unknown',
                        desc: prog.desc ? prog.desc[0]._ || prog.desc[0] : ''
                    });
                }
            }
            this.log.debug('EPG parsed', {
                channels: Object.keys(epgData).length,
                programmes: Object.values(epgData).reduce((a, b) => a + b.length, 0),
                ms: Date.now() - start
            });
            return epgData;
        } catch (e) {
            this.log.warn('EPG parse failed', e.message);
            return {};
        }
    }

    parseEPGTime(s) {
        if (!s) return new Date();
        const m = s.match(/^(\d{14})(?:\s*([+\-]\d{4}))?/);
        if (m) {
            const base = m[1];
            const tz = m[2] || null;
            const year = parseInt(base.slice(0, 4), 10);
            const month = parseInt(base.slice(4, 6), 10) - 1;
            const day = parseInt(base.slice(6, 8), 10);
            const hour = parseInt(base.slice(8, 10), 10);
            const min = parseInt(base.slice(10, 12), 10);
            const sec = parseInt(base.slice(12, 14), 10);
            let date;
            if (tz) {
                const iso = `${year}-${(month + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}T${hour.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}${tz}`;
                const parsed = new Date(iso);
                if (!isNaN(parsed.getTime())) date = parsed;
            }
            if (!date) date = new Date(year, month, day, hour, min, sec);
            if (this.config.epgOffsetHours) {
                date = new Date(date.getTime() + this.config.epgOffsetHours * 3600000);
            }
            return date;
        }
        const d = new Date(s);
        if (this.config.epgOffsetHours && !isNaN(d.getTime()))
            return new Date(d.getTime() + this.config.epgOffsetHours * 3600000);
        return d;
    }

    /**
     * Return XMLTV programmes overlapping a time window.
     * The guide passes UTC-day boundaries; parseEPGTime applies the addon's
     * configured EPG offset consistently with its existing programme methods.
     */
    getScheduledPrograms(channel, windowStartMs, windowEndMs) {
        if (!channel || channel.type !== 'tv' || !Number.isFinite(windowStartMs) ||
            !Number.isFinite(windowEndMs) || windowEndMs <= windowStartMs) return [];

        const epgId = channel.attributes?.['tvg-id'] || channel.attributes?.['tvg-name'];
        const sourcePrograms = epgId && this.epgData[epgId];
        if (!Array.isArray(sourcePrograms)) return [];

        // Build once per immutable channel programme array. Prefix maximum end
        // times preserve long programmes that overlap the window despite starting
        // well before its first programme.
        let index = this.epgProgramIndexes.get(sourcePrograms);
        if (!index) {
            index = [];
            for (const program of sourcePrograms) {
                if (!program || !program.start || !program.stop) continue;
                let times = this.epgTimeCache.get(program);
                if (!times) {
                    const start = this.parseEPGTime(program.start);
                    const end = this.parseEPGTime(program.stop);
                    times = { start, end, startMs: start instanceof Date ? start.getTime() : NaN, endMs: end instanceof Date ? end.getTime() : NaN };
                    this.epgTimeCache.set(program, times);
                }
                if (!Number.isFinite(times.startMs) || !Number.isFinite(times.endMs) || times.endMs <= times.startMs) continue;
                index.push({ program, times });
            }
            index.sort((a, b) => a.times.startMs - b.times.startMs);
            let maxEnd = -Infinity;
            for (const entry of index) {
                maxEnd = Math.max(maxEnd, entry.times.endMs);
                entry.prefixMaxEndMs = maxEnd;
            }
            this.epgProgramIndexes.set(sourcePrograms, index);
        }

        // Binary-search the first possible overlap and the first programme
        // starting outside the requested window.
        let low = 0, high = index.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (index[mid].prefixMaxEndMs <= windowStartMs) low = mid + 1;
            else high = mid;
        }
        const first = low;
        low = first; high = index.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (index[mid].times.startMs < windowEndMs) low = mid + 1;
            else high = mid;
        }

        const videos = [];
        for (let i = first; i < low; i++) {
            const { program, times } = index[i];
            const { start, end, startMs, endMs } = times;
            if (endMs <= windowStartMs || startMs >= windowEndMs) continue;
            const video = {
                id: `${channel.id}:epg:${start.toISOString()}`,
                title: String(program.title || 'Untitled programme'),
                released: start.toISOString(),
                startTime: start.toISOString(),
                endTime: end.toISOString()
            };
            if (program.desc) video.overview = String(program.desc);
            const runtimeMinutes = Math.round((endMs - startMs) / 60000);
            if (runtimeMinutes > 0) video.runtime = `${runtimeMinutes} min`;
            videos.push(video);
        }
        return videos;
    }
    async ensureSeriesTmdbId(seriesId) {
        if (!seriesId) return null;
        const cacheKey = 'series-tmdb-id:' + String(seriesId);
        const cached = this.seriesInfoCache.get(cacheKey);
        if (cached !== undefined) return cached;

        const pendingKey = 'series-tmdb-id:' + String(seriesId);
        const pending = this.providerInfoInFlight.get(pendingKey);
        if (pending) return pending;

        const task = (async () => {
            try {
                const providerModule = require(`./src/js/providers/${this.providerName}Provider.js`);
                if (typeof providerModule.fetchSeriesTmdbId === 'function') {
                    const tmdbId = await providerModule.fetchSeriesTmdbId(this, seriesId);
                    this.seriesInfoCache.set(cacheKey, tmdbId || null);
                    return tmdbId || null;
                }
                const info = await this.ensureSeriesInfo(seriesId);
                return info?.tmdbId || null;
            } catch (e) {
                this.log.warn('Series TMDb ID lookup failed', seriesId, e && e.name ? e.name : 'Error');
                this.seriesInfoCache.set(cacheKey, null);
                return null;
            }
        })();

        this.providerInfoInFlight.set(pendingKey, task);
        try {
            return await task;
        } finally {
            if (this.providerInfoInFlight.get(pendingKey) === task) {
                this.providerInfoInFlight.delete(pendingKey);
            }
        }
    }

    async ensureSeriesInfo(seriesId) {
        if (!seriesId) return null;
        const cached = this.seriesInfoCache.get(seriesId);
        if (cached !== undefined) return cached;

        const pendingKey = 'series-info:' + String(seriesId);
        const pending = this.providerInfoInFlight.get(pendingKey);
        if (pending) return pending;

        const task = (async () => {
            try {
                const providerModule = require(`./src/js/providers/${this.providerName}Provider.js`);
                if (typeof providerModule.fetchSeriesInfo === 'function') {
                    const info = await providerModule.fetchSeriesInfo(this, seriesId);
                    this.seriesInfoCache.set(seriesId, info);
                    return info;
                }
            } catch (e) {
                this.log.warn('Series info fetch failed', seriesId, e && e.name ? e.name : 'Error');
            }
            // Fallback empty structure
            const empty = { videos: [] };
            this.seriesInfoCache.set(seriesId, empty);
            return empty;
        })();

        this.providerInfoInFlight.set(pendingKey, task);
        try {
            return await task;
        } finally {
            if (this.providerInfoInFlight.get(pendingKey) === task) {
                this.providerInfoInFlight.delete(pendingKey);
            }
        }
    }

    async updateData(force = false) {
        const now = Date.now();
        if (!force && CACHE_ENABLED) {
            if (this.lastUpdate && now - this.lastUpdate < this.updateInterval) {
                this.log.debug('Skip update (global interval)');
                return;
            }
            if ((this.channels.length || this.movies.length || this.series.length) && now - this.lastUpdate < 900000) {
                this.log.debug('Skip update (recent minor interval)');
                return;
            }
        }
        const previous = {
            channels: this.channels,
            movies: this.movies,
            series: this.series,
            epgData: this.epgData,
            lastUpdate: this.lastUpdate
        };
        try {
            const start = Date.now();
            const providerModule = require(`./src/js/providers/${this.providerName}Provider.js`);
            await providerModule.fetchData(this);

            // A catalogue refresh may succeed while an optional EPG source is down.
            // Keep the last-known-good guide instead of replacing it with an empty one.
            const hasNewEpg = Object.values(this.epgData || {}).some(
                programmes => Array.isArray(programmes) && programmes.length > 0
            );
            const hadPreviousEpg = Object.values(previous.epgData || {}).some(
                programmes => Array.isArray(programmes) && programmes.length > 0
            );
            if (this.config.enableEpg && !hasNewEpg && hadPreviousEpg) {
                this.epgData = previous.epgData;
                this.log.warn('EPG refresh returned no programmes; retaining last-known-good guide');
            }

            // Reject an obviously partial catalogue response rather than persisting
            // an accidental empty snapshot over a previously working library.
            const previousHadCatalogue = previous.channels.length + previous.movies.length + previous.series.length > 0;
            const currentHasCatalogue = this.channels.length + this.movies.length + this.series.length > 0;
            if (previousHadCatalogue && !currentHasCatalogue) {
                throw new Error('Provider refresh returned an empty catalogue; retaining previous data');
            }

            this.lastUpdate = Date.now();
            if (CACHE_ENABLED) await this.saveToCache();
            else {
                try {
                    await this.persistentAddonDataCache.save({
                        channels: this.channels, movies: this.movies, series: this.series,
                        epgData: this.epgData, lastUpdate: this.lastUpdate
                    });
                } catch (error) {
                    this.log.warn('Persistent provider data save failed', {
                    name: error?.name || 'Error', code: error?.code || 'UNKNOWN',
                    syscall: error?.syscall || null, message: String(error?.message || 'No error message').slice(0, 300)
                });
                }
            }
            this.buildGenresInManifest();
            this.log.debug('Data update complete', {
                channels: this.channels.length,
                movies: this.movies.length,
                series: this.series.length,
                epgChannels: Object.keys(this.epgData || {}).length,
                ms: Date.now() - start
            });
        } catch (e) {
            this.channels = previous.channels;
            this.movies = previous.movies;
            this.series = previous.series;
            this.epgData = previous.epgData;
            this.lastUpdate = previous.lastUpdate;
            this.log.error('[UPDATE] Failed; retaining last-known-good data:', e && e.name ? e.name : 'Error');
        }
    }

    startScheduledRefresh() {
        if (this.refreshTimer) return;
        const refreshCheckInterval = parsePositiveInteger(process.env.DATA_REFRESH_CHECK_INTERVAL_MS, 60 * 60 * 1000, 5 * 60 * 1000, 6 * 60 * 60 * 1000);
        // Check hourly against the persisted last-success timestamp, so process restarts
        // cannot keep postponing the next refresh.
        this.refreshTimer = setInterval(() => {
            if (this.scheduledRefreshInFlight) return;
            const lastSuccessfulRefresh = Number(this.lastUpdate) || 0;
            if (lastSuccessfulRefresh && Date.now() - lastSuccessfulRefresh < this.updateInterval) return;
            this.log.info('Scheduled provider refresh is due', {
                lastSuccessfulRefresh: lastSuccessfulRefresh ? new Date(lastSuccessfulRefresh).toISOString() : null,
                intervalHours: this.updateInterval / (60 * 60 * 1000)
            });
            this.scheduledRefreshInFlight = this.updateData(true)
                .catch(error => this.log.warn('Scheduled provider refresh failed', error?.name || 'Error'))
                .finally(() => { this.scheduledRefreshInFlight = null; });
        }, refreshCheckInterval);
        if (typeof this.refreshTimer.unref === 'function') this.refreshTimer.unref();
    }

    deriveFallbackLogoUrl(item) {
        const logoAttr = item.attributes?.['tvg-logo'];
        if (logoAttr && logoAttr.trim()) return logoAttr;
        const tvgId = item.attributes?.['tvg-id'] || item.attributes?.['tvg-name'];
        if (!tvgId)
            return `https://via.placeholder.com/300x400/333333/FFFFFF?text=${encodeURIComponent(item.name)}`;
        return `logo/${encodeURIComponent(tvgId)}.png`;
    }

    generateMetaPreview(item) {
        const meta = { id: item.id, type: item.type, name: item.name };
        if (item.type === 'tv') {
            // Native EPG data is supplied separately through scheduled videos.
            // Keep programme information out of the channel description.
            meta.poster = this.deriveFallbackLogoUrl(item);
            meta.genres = item.category
                ? [item.category]
                : (item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Live TV']);
            meta.runtime = 'Live';
        } else if (item.type === 'movie') {
            meta.poster = item.poster ||
                item.attributes?.['tvg-logo'] ||
                `https://via.placeholder.com/300x450/CC6600/FFFFFF?text=${encodeURIComponent(item.name)}`;
            meta.year = item.year;
            if (!meta.year) {
                const m = item.name.match(/\((\d{4})\)/);
                if (m) meta.year = parseInt(m[1]);
            }
            meta.description = item.plot || item.attributes?.['plot'] || `Movie: ${item.name}`;
            meta.genres = item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Movie'];
        } else if (item.type === 'series') {
            meta.poster = item.poster ||
                item.attributes?.['tvg-logo'] ||
                `https://via.placeholder.com/300x450/3366CC/FFFFFF?text=${encodeURIComponent(item.name)}`;
            meta.description = item.plot || item.attributes?.['plot'] || 'Series / Show';
            meta.genres = item.category
                ? [item.category]
                : (item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Series']);
        }
        return meta;
    }

    getStream(id) {
        // Episode streams
        if (id.startsWith('iptv_series_ep_')) {
            const epEntry = this.lookupEpisodeById(id);
            if (!epEntry) return null;
            return {
                url: epEntry.url,
                title: `${epEntry.title || 'Episode'}${epEntry.season ? ` S${epEntry.season}E${epEntry.episode}` : ''}`,
                behaviorHints: { notWebReady: true }
            };
        }
        const item = findCatalogueItemById(this.channels, id) || findCatalogueItemById(this.movies, id);
        if (!item) return null;
        return {
            url: item.url,
            title: item.type === 'tv' ? `${item.name} - Live` : item.name,
            behaviorHints: { notWebReady: true }
        };
    }

    lookupEpisodeById(epId) {
        // Check cached series info
        for (const [, info] of this.seriesInfoCache.entries()) {
            if (info && Array.isArray(info.videos)) {
                const found = info.videos.find(v => v.id === epId);
                if (found) return found;
            }
        }
        // Direct-provider episodes are indexed when the playlist is loaded.
        return this.directSeriesEpisodeById.get(epId) || null;
    }

    async buildSeriesMeta(seriesItem) {
        const seriesIdRaw = seriesItem.series_id || seriesItem.id.replace(/^iptv_series_/, '');
        const info = await this.ensureSeriesInfo(seriesIdRaw);
        const tmdbId = seriesItem.tmdbId || info?.tmdbId || null;
        const tmdb = await tmdbMetadata.getSeriesMetadata(tmdbId);
        // The detailed series view also exposes IMDb rating/runtime fallbacks.
        // Keep this lookup local to the function rather than referencing an
        // undefined catalogue-preview variable.
        const omdb = tmdb?.imdbId ? await omdbMetadata.getByImdbId(tmdb.imdbId) : null;
        const tmdbSeasons = new Map();
        if (tmdb && tmdbMetadata.validTmdbId(tmdbId)) {
            const seasonNumbers = [...new Set((info?.videos || []).map(video => Number(video.season)).filter(n => Number.isSafeInteger(n) && n >= 0))];
            const seasonResults = await Promise.all(seasonNumbers.map(async season => [season, await tmdbMetadata.getSeasonEpisodes(tmdbId, season)]));
            for (const [season, episodes] of seasonResults) if (Array.isArray(episodes)) tmdbSeasons.set(season, episodes);
        }
        // Index each season's episodes once. A repeated Array.find for every
        // provider episode scales poorly for long-running series with many episodes.
        const tmdbEpisodesByKey = new Map();
        for (const [season, episodes] of tmdbSeasons) {
            for (const episode of episodes) {
                tmdbEpisodesByKey.set(`${season}:${Number(episode.episode)}`, episode);
            }
        }
        const videos = (info?.videos || []).map(v => {
            const tmdbEpisode = tmdbEpisodesByKey.get(`${Number(v.season)}:${Number(v.episode)}`);
            // Prefer TMDb episode details, retaining the provider listing if a season/episode has no match.
            let released = v.released || undefined;
            const video = {
                id: v.id,
                title: tmdbEpisode?.title || v.title || `Episode ${v.episode || ''}`.trim(),
                season: v.season,
                episode: v.episode,
                thumbnail: tmdbEpisode?.thumbnail || v.thumbnail || seriesItem.poster || undefined
            };
            if (tmdbEpisode?.description) video.overview = tmdbEpisode.description;
            if (tmdbEpisode?.runtime) video.runtime = tmdbEpisode.runtime;
            if (tmdbEpisode?.rating) {
                // Episode ratings are scores, not maturity/content ratings.
                // Expose the score as a clearly labelled TMDb link, matching
                // the series/movie metadata convention rather than misusing
                // Stremio's ContentRating field.
                video.links = [{
                    name: 'TMDb rating: ' + tmdbEpisode.rating,
                    category: 'Rating',
                    url: 'https://www.themoviedb.org/tv/' + encodeURIComponent(String(tmdbId)) +
                        '/season/' + encodeURIComponent(String(v.season)) +
                        '/episode/' + encodeURIComponent(String(v.episode))
                }];
            }
            if (tmdbEpisode?.guestStars?.length) video.cast = tmdbEpisode.guestStars;
            if (tmdbEpisode?.directors?.length) video.directors = tmdbEpisode.directors;
            if (tmdbEpisode?.released) {
                const d = new Date(tmdbEpisode.released);
                if (!isNaN(d.getTime())) released = d.toISOString();
            }
            if (released) video.released = released;
            return video;
        });

        if (!tmdb) {
            // Keep Xtream's playable episode catalogue when a TMDb ID is absent or unmatched.
            return {
                id: seriesItem.id,
                type: 'series',
                name: seriesItem.name,
                poster: seriesItem.poster || seriesItem.attributes?.['tvg-logo'] ||
                    `https://via.placeholder.com/300x450/3366CC/FFFFFF?text=${encodeURIComponent(seriesItem.name)}`,
                description: seriesItem.plot || seriesItem.attributes?.['plot'] || 'Series / Show',
                genres: seriesItem.category
                    ? [seriesItem.category]
                    : (seriesItem.attributes?.['group-title'] ? [seriesItem.attributes['group-title']] : ['Series']),
                videos: (info?.videos || []).map(v => ({
                    id: v.id,
                    title: v.title || `Episode ${v.episode || ''}`.trim(),
                    season: v.season,
                    episode: v.episode,
                    thumbnail: v.thumbnail || seriesItem.poster || undefined,
                    ...(v.released ? { released: v.released } : {})
                }))
            };
        }
        return {
            id: seriesItem.id,
            type: 'series',
            name: tmdb.name,
            poster: tmdb.poster,
            background: tmdb.background,
            logo: tmdb.logo,
            description: tmdb.description,
            genres: tmdb.genres,
            releaseInfo: tmdb.releaseInfo,
            year: tmdb.year,
            runtime: tmdb.runtime || seriesItem.runtime || omdb?.runtime,
            metadataVersion: 2,
            imdbId: tmdb.imdbId || omdb?.imdbId,
            imdbRating: omdb?.imdbRating != null ? String(omdb.imdbRating) : undefined,
            cast: tmdb.cast,
            tmdbRating: tmdb.rating,
            trailers: tmdb.trailer ? [{ source: tmdb.trailer.id, type: 'Trailer' }] : [],
            links: [
                    ...(tmdb.rating ? [{ name: 'TMDb rating: ' + tmdb.rating, category: 'Rating', url: 'https://www.themoviedb.org/tv/' + encodeURIComponent(String(tmdbId)) }] : []),
                ...(tmdb.links || [])
            ],
            videos
        };
    }

    async enrichCatalogMetaItems(items, concurrency = 3, forceRefresh = false) {
        const startedAt = Date.now();
        const candidates = items.filter(item => {
            if (!item || (item.type !== 'movie' && item.type !== 'series')) return false;
            // A scheduled warm-up must revisit cached items when the metadata schema
            // or IMDb enrichment state has changed; ordinary foreground enrichment
            // continues to skip items already present in the LRU.
            return forceRefresh || this.catalogMetaCache.get(item.id) === undefined;
        });
        let nextIndex = 0;
        const worker = async () => {
            while (nextIndex < candidates.length) {
                const item = candidates[nextIndex++];
                try {
                    const detailed = await this.getCatalogMetaAsync(item.id, item.type);
                    if (!detailed) continue;
                    // A fresh persistent hit is already stored on disk; don't reset its
                    // daily refresh timestamp just because the card was viewed again.
                    const loadedFromCache = !forceRefresh && (
                        this.catalogMetaCache.get(item.id) !== undefined ||
                        this.catalogMetaStaleFallbacks.delete(item.id)
                    );
                    const preview = { ...detailed };
                    const providerGenre = item.category || item.attributes?.['group-title'];
                    let fallbackPreview;
                    if (!Array.isArray(preview.genres) || !preview.genres.length) {
                        fallbackPreview = this.generateMetaPreview(item);
                        preview.genres = fallbackPreview.genres?.length
                            ? fallbackPreview.genres
                            : (providerGenre ? [providerGenre] : []);
                    }
                    if (!Array.isArray(preview.cast) || !preview.cast.length) {
                        fallbackPreview = fallbackPreview || this.generateMetaPreview(item);
                        if (Array.isArray(fallbackPreview.cast) && fallbackPreview.cast.length) {
                            preview.cast = fallbackPreview.cast;
                        }
                    }
                    this.cacheCatalogMetaPreview(item.id, preview, !loadedFromCache);
                } catch (error) {
                    this.log.warn('Foreground catalogue metadata enrichment failed for', item.id, error?.message || error);
                }
            }
        };
        const workerCount = Math.min(Math.max(1, concurrency), candidates.length);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        if (this.config.debug) {
            this.log.debug('Catalogue metadata enrichment complete', {
                requestedItems: items.length,
                uncachedItems: candidates.length,
                workers: workerCount,
                ms: Date.now() - startedAt
            });
        }
    }

    queueCatalogMetaEnrichment(item) {
        if (!item || this.catalogMetaCache.has(item.id) || this.catalogMetaPending.has(item.id)) return;
        this.catalogMetaPending.set(item.id, true);
        this.catalogMetaQueue.push(item);

        const runNext = () => {
            while (this.catalogMetaWorkers < 3 && this.catalogMetaQueueHead < this.catalogMetaQueue.length) {
                const next = this.catalogMetaQueue[this.catalogMetaQueueHead++];
                this.catalogMetaWorkers++;
                (async () => {
                    try {
                        const detailed = await this.getCatalogMetaAsync(next.id, next.type);
                        if (detailed) {
                            const loadedFromCache = this.catalogMetaCache.get(next.id) !== undefined ||
                                this.catalogMetaStaleFallbacks.delete(next.id);
                            const preview = { ...detailed };
                            const providerGenre = next.category || next.attributes?.['group-title'];
                            let fallbackPreview;
                            if (!Array.isArray(preview.genres) || !preview.genres.length) {
                                fallbackPreview = this.generateMetaPreview(next);
                                preview.genres = fallbackPreview.genres?.length
                                    ? fallbackPreview.genres
                                    : (providerGenre ? [providerGenre] : []);
                            }
                            if (!Array.isArray(preview.cast) || !preview.cast.length) {
                                fallbackPreview = fallbackPreview || this.generateMetaPreview(next);
                                if (Array.isArray(fallbackPreview.cast) && fallbackPreview.cast.length) {
                                    preview.cast = fallbackPreview.cast;
                                }
                            }
                            this.cacheCatalogMetaPreview(next.id, preview, !loadedFromCache);
                        }
                    } catch (error) {
                        this.log.warn('Background catalogue metadata enrichment failed for', next.id, error?.message || error);
                    } finally {
                        this.catalogMetaPending.delete(next.id);
                        this.catalogMetaWorkers--;
                        if (this.catalogMetaQueueHead >= this.catalogMetaQueue.length) {
                            this.catalogMetaQueue = [];
                            this.catalogMetaQueueHead = 0;
                        }
                        runNext();
                    }
                })();
            }
        };
        runNext();
    }

    cacheCatalogMetaPreview(id, preview, persist = true) {
        // Record the last successful enrichment attempt even when an upstream source
        // has no value for a field, preventing repeated retries on every card request.
        preview = { ...preview, metadataCheckedAt: Date.now() };
        this.catalogMetaCache.set(id, preview);
        if (persist) {
            const write = this.persistentCatalogMetaCache.set(id, preview);
            this.catalogMetaPersistWrites.add(write);
            write.catch(error => {
                this.log.warn('Persistent catalogue metadata cache write failed:', error?.name || 'Error');
            }).finally(() => this.catalogMetaPersistWrites.delete(write));
        }
    }

    startContinuousCatalogPrefetch(type, pageSize, concurrency) {
        if (type !== 'movie' && type !== 'series') return;
        if (this.catalogPrefetchJobs.has(type)) return;
        if ((this.catalogPrefetchRetryAfter.get(type) || 0) > Date.now()) return;

        const refreshInterval = parsePositiveInteger(
            process.env.CATALOG_PREFETCH_REFRESH_MS, 12 * 60 * 60 * 1000,
            60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000
        );
        // Walk the unfiltered provider catalogue so a search for a small subset does
        // not accidentally define the scope of the background warm-up.
        const items = type === 'movie' ? this.movies : this.series;
        if (!Array.isArray(items) || !items.length) return;
        const catalogueFingerprint = crypto.createHash('sha256')
            .update(items.map(item => String(item?.id || '')).join('\n'))
            .digest('hex');
        const lastCompleted = this.catalogPrefetchLastCompleted.get(type) || 0;
        if (Date.now() - lastCompleted < refreshInterval &&
            this.catalogPrefetchLastFingerprint.get(type) === catalogueFingerprint) return;

        this.log.info('Starting catalogue metadata warm-up check', {
            type, total: items.length, pageSize, concurrency
        });
        const job = (async () => {
            const startedAt = Date.now();
            const statusKey = '__catalog_prefetch_status__:' + type;
            // Persist the completion timestamp and catalogue fingerprint so Railway
            // restarts do not repeat a fresh warm-up, but changed provider catalogues
            // still trigger a full metadata pass even when the item count is unchanged.
            const persistedStatus = await this.persistentCatalogMetaCache.get(statusKey);
            const persistedCompletedAt = Number(persistedStatus?.value?.completedAt) || 0;
            const sameCatalogue = persistedStatus?.value?.catalogueFingerprint === catalogueFingerprint;
            // The completion marker has its own completedAt timestamp; do not
            // couple daily scheduling to the metadata entries' freshness TTL.
            let cachedCatalogueNeedsRefresh = false;
            if (persistedStatus && sameCatalogue &&
                Number(persistedStatus.value?.version) >= 3 &&
                Date.now() - persistedCompletedAt < refreshInterval) {
                // A completion marker alone is not proof that every cached preview
                // contains the current OMDb lookup state. Older markers can survive
                // code changes, so inspect saved entries before skipping the warm-up.
                for (const item of items) {
                    const saved = await this.persistentCatalogMetaCache.get(String(item.id));
                    const value = saved?.value;
                    if (!value || !String(value.name || '').trim() ||
                        value.metadataVersion < 3 ||
                        (value._tmdbId && !value.imdbId && value.imdbIdChecked !== true) ||
                        value.omdbPending === true ||
                        (omdbMetadataNeedsRefresh(value) || catalogMetadataNeedsRefresh(value))) {
                        cachedCatalogueNeedsRefresh = true;
                        break;
                    }
                }
                if (!cachedCatalogueNeedsRefresh) {
                    this.catalogPrefetchLastCompleted.set(type, persistedCompletedAt);
                    this.catalogPrefetchLastFingerprint.set(type, catalogueFingerprint);
                    this.catalogPrefetchRetryAfter.delete(type);
                    this.log.info('Persistent catalogue metadata is already warm', {
                        type, total: items.length, completedAt: new Date(persistedCompletedAt).toISOString()
                    });
                    return;
                }
                this.log.info('Persistent catalogue metadata requires refresh despite completion marker', {
                    type, total: items.length
                });
            }

            let processed = 0;
            let missingMetadata = 0;
            for (let offset = 0; offset < items.length; offset += pageSize) {
                const batch = items.slice(offset, Math.min(offset + pageSize, items.length));
                if (!batch.length) continue;
                // Force the warm-up through the metadata refresh path even when an old
                // preview is already in the LRU. Refreshed values must also replace
                // the persistent preview, not merely update memory.
                await this.enrichCatalogMetaItems(batch, concurrency, true);
                processed += batch.length;
                // A warm-up only counts as complete if every item has a usable card
                // preview in the cache. Missing lookups must be retried later rather
                // than permanently recording a false-success completion marker.
                for (const item of batch) {
                    const cached = this.catalogMetaCache.get(item.id);
                    if (!cached || !String(cached.name || '').trim() || cached.metadataVersion < 3 || (cached._tmdbId && !cached.imdbId && cached.imdbIdChecked !== true) || cached.omdbPending === true || (omdbMetadataNeedsRefresh(cached) || catalogMetadataNeedsRefresh(cached))) missingMetadata++;
                }
                if (this.config.debug) {
                    this.log.debug('Background catalogue prefetch progress', {
                        type, processed, total: items.length, missingMetadata,
                    });
                }
            }

            const omdbCatalogueSummary = {
                items: items.length,
                persistentEntries: 0,
                missingPersistentPreview: 0,
                withImdbId: 0,
                withImdbRating: 0,
                awaitingOmdbCheck: 0,
                omdbPending: 0,
                withoutImdbId: 0,
                markedCheckedWithoutRating: 0
            };
            // Read the persistent cache rather than catalogMetaCache (an LRU capped
            // at 1,000 items); otherwise this report falsely labels the rest of the
            // provider catalogue as missing.
            for (const item of items) {
                const saved = await this.persistentCatalogMetaCache.get(String(item.id));
                const value = saved?.value;
                if (!value) {
                    omdbCatalogueSummary.missingPersistentPreview++;
                    continue;
                }
                omdbCatalogueSummary.persistentEntries++;
                if (value.imdbId) {
                    omdbCatalogueSummary.withImdbId++;
                    if (value.imdbRating) omdbCatalogueSummary.withImdbRating++;
                    if (omdbMetadataNeedsRefresh(value)) omdbCatalogueSummary.awaitingOmdbCheck++;
                    if (!value.imdbRating && value.omdbChecked === true) omdbCatalogueSummary.markedCheckedWithoutRating++;
                } else {
                    omdbCatalogueSummary.withoutImdbId++;
                }
                if (value.omdbPending === true) omdbCatalogueSummary.omdbPending++;
            }
            this.log.info('Catalogue metadata diagnostics', {
                type,
                ...omdbCatalogueSummary,
                omdb: typeof omdbMetadata.getDiagnostics === 'function' ? omdbMetadata.getDiagnostics() : undefined
            });

            if (missingMetadata === 0) {
                const completedAt = Date.now();
                // All set() calls are asynchronous because they initialize the
                // persistent store on first use. Wait for them before flushing, so the
                // completion marker can never get ahead of the actual card previews.
                while (this.catalogMetaPersistWrites.size) {
                    await Promise.allSettled([...this.catalogMetaPersistWrites]);
                }
                await this.persistentCatalogMetaCache.set(statusKey, {
                    completedAt,
                    catalogueCount: items.length,
                    catalogueFingerprint,
                    version: 3
                });
                // Ensure metadata and its completion marker reach the persistent
                // volume before reporting the warm-up as durable.
                await this.persistentCatalogMetaCache.flush();
                this.catalogPrefetchLastCompleted.set(type, completedAt);
                this.catalogPrefetchLastFingerprint.set(type, catalogueFingerprint);
                this.catalogPrefetchRetryAfter.delete(type);
                this.log.info('Persistent catalogue metadata warm-up complete', {
                    type, processed, total: items.length, ms: Date.now() - startedAt
                });
            } else {
                const retryDelay = parsePositiveInteger(
                    process.env.CATALOG_PREFETCH_RETRY_MS, 60 * 60 * 1000,
                    5 * 60 * 1000, 24 * 60 * 60 * 1000
                );
                this.catalogPrefetchRetryAfter.set(type, Date.now() + retryDelay);
                this.log.warn('Catalogue metadata warm-up incomplete; will retry after backoff', {
                    type, processed, total: items.length, missingMetadata, retryDelay
                });
            }
        })();

        this.catalogPrefetchJobs.set(type, job);
        job.catch(error => {
            const retryDelay = parsePositiveInteger(
                process.env.CATALOG_PREFETCH_RETRY_MS, 60 * 60 * 1000,
                5 * 60 * 1000, 24 * 60 * 60 * 1000
            );
            this.catalogPrefetchRetryAfter.set(type, Date.now() + retryDelay);
            this.log.warn('Continuous catalogue prefetch failed:', error?.name || 'Error');
        }).finally(() => {
            if (this.catalogPrefetchJobs.get(type) === job) {
                this.catalogPrefetchJobs.delete(type);
            }
        });
    }

    async resolveMovieTmdbId(id, item, providerModule) {
        const idCacheKey = 'movie-tmdb:' + id;
        const cached = this.seriesInfoCache.get(idCacheKey);
        if (cached) return cached;

        // Missing IDs are cached for the cache TTL too, so every Discover revisit
        // does not repeat the same potentially slow get_vod_info call.
        const negativeKey = 'movie-tmdb-miss:' + id;
        if (this.seriesInfoCache.has(negativeKey)) return null;

        const pendingKey = 'movie-tmdb:' + id;
        const pending = this.providerInfoInFlight.get(pendingKey);
        if (pending) return pending;

        const task = (async () => {
            const streamId = id.replace(/^iptv_vod_/, '');
            const providerInfo = await providerModule.fetchMovieInfo(this, streamId);
            const tmdbId = providerInfo?.tmdbId || null;
            if (tmdbId) this.seriesInfoCache.set(idCacheKey, tmdbId);
            else this.seriesInfoCache.set(negativeKey, true);
            return tmdbId;
        })();

        this.providerInfoInFlight.set(pendingKey, task);
        try {
            return await task;
        } finally {
            if (this.providerInfoInFlight.get(pendingKey) === task) {
                this.providerInfoInFlight.delete(pendingKey);
            }
        }
    }

    async getCatalogMetaAsync(id, type) {
        const key = String(id || '');
        if (!key) return null;
        const cached = this.catalogMetaCache.get(key);
        if (cached !== undefined) {
            // An LRU hit must not keep popular titles permanently exempt from the
            // 14-day metadata refresh. Check the persisted save timestamp as well.
            const persisted = await this.persistentCatalogMetaCache.get(key);
            const refreshInterval = parsePositiveInteger(
                process.env.CATALOG_METADATA_REFRESH_MS, 14 * 24 * 60 * 60 * 1000,
                60 * 60 * 1000, 90 * 24 * 60 * 60 * 1000
            );
            if (!persisted || (persisted.value?.metadataVersion >= 3 && !(persisted.value?._tmdbId && !persisted.value?.imdbId && persisted.value?.imdbIdChecked !== true) && !persisted.value?.omdbPending && !(omdbMetadataNeedsRefresh(persisted.value) || catalogMetadataNeedsRefresh(persisted.value)) && Date.now() - persisted.savedAt < refreshInterval)) return cached;
            // Due entries fall through to the shared in-flight refresh below.
        }
        const pending = this.catalogMetaInFlight.get(key);
        if (pending) return pending;

        const task = (async () => {
            const persisted = await this.persistentCatalogMetaCache.get(key);
            const isUsablePreview = value => {
                if (!value || typeof value !== 'object' || !String(value.name || '').trim()) return false;
                // Older/partial previews must not suppress the normal metadata lookup.
                // Require multiple useful detail fields, while allowing legitimate
                // provider/TMDb records to omit any individual optional field.
                const usefulFields = [
                    value.description, value.releaseInfo, value.year, value.runtime,
                    value.director, value.cast?.length ? value.cast : null,
                    value.genres?.length ? value.genres : null
                ].filter(field => field !== undefined && field !== null && field !== '').length;
                return usefulFields >= 2;
            };
            // Reuse complete persisted metadata until its 14-day refresh interval expires.
            // Refresh due records when the catalogue warm-up reaches them; if a lookup
            // fails, keep the last saved preview available for the card.
            const metadataRefreshInterval = parsePositiveInteger(
                process.env.CATALOG_METADATA_REFRESH_MS, 14 * 24 * 60 * 60 * 1000,
                60 * 60 * 1000, 90 * 24 * 60 * 60 * 1000
            );
            const persistedIsUsable = persisted?.value && isUsablePreview(persisted.value);
            const persistedIsDue = persistedIsUsable &&
                (persisted.value.metadataVersion < 3 ||
                    (persisted.value._tmdbId && !persisted.value.imdbId && persisted.value.imdbIdChecked !== true) ||
                    persisted.value.omdbPending === true ||
                    (omdbMetadataNeedsRefresh(persisted.value) || catalogMetadataNeedsRefresh(persisted.value)) ||
                    Date.now() - persisted.savedAt >= metadataRefreshInterval);
            if (persistedIsUsable && !persistedIsDue) {
                this.catalogMetaCache.set(key, persisted.value);
                return persisted.value;
            }
            const refreshed = await this._getCatalogMetaAsync(id, type, omdbMetadataNeedsRefresh(persisted?.value) || catalogMetadataNeedsRefresh(persisted?.value));
            if (refreshed) return refreshed;
            if (persisted?.value && isUsablePreview(persisted.value)) {
                this.catalogMetaStaleFallbacks.add(key);
                return persisted.value;
            }
            return null;
        })();
        this.catalogMetaInFlight.set(key, task);
        try {
            return await task;
        } finally {
            if (this.catalogMetaInFlight.get(key) === task) {
                this.catalogMetaInFlight.delete(key);
            }
        }
    }

    async _getCatalogMetaAsync(id, type, refreshIncompleteMetadata = false) {
        // Discover cards do not need episode lists, trailers, or logo-image lookups.
        // Fetch only the fields displayed in the panel and the credits needed for cast/directors.
        if (type === 'series' || id.startsWith('iptv_series_')) {
            const seriesItem = findCatalogueItemById(this.series, id);
            if (!seriesItem) return null;
            const seriesId = seriesItem.series_id || seriesItem.id.replace(/^iptv_series_/, '');
            let info = null;
            let tmdbId = seriesItem.tmdbId || null;
            const providerLookupStartedAt = Date.now();
            if (!tmdbId) {
                tmdbId = await this.ensureSeriesTmdbId(seriesId);
            }
            const providerLookupMs = Date.now() - providerLookupStartedAt;
            const tmdbLookupStartedAt = Date.now();
            const tmdb = await tmdbMetadata.getSeriesCatalogMetadata(tmdbId, { refresh: refreshIncompleteMetadata });
            // Some provider series have no TMDb ID. Do not title-search as a fallback;
            // keep a durable provider-backed card so these legitimate no-match items
            // do not make the full-catalogue warm-up retry forever.
            if (!tmdb && !tmdbId) {
                const fallback = this.generateMetaPreview(seriesItem);
                return {
                    ...fallback,
                    metadataVersion: 3,
                    _tmdbId: null,
                    imdbIdChecked: true,
                    omdbChecked: true,
                    omdbPending: false
                };
            }
            if (!tmdb) return null;
            const omdb = tmdb.imdbId ? await omdbMetadata.getByImdbId(tmdb.imdbId, { refreshIncomplete: refreshIncompleteMetadata }) : null;
            this.log.debug('Catalogue metadata stages', {
                type: 'series',
                id: seriesItem.id,
                hasListingTmdbId: !!seriesItem.tmdbId,
                hasResolvedTmdbId: !!tmdbId,
                providerLookupMs,
                tmdbLookupMs: Date.now() - tmdbLookupStartedAt,
                totalMs: Date.now() - providerLookupStartedAt
            });
            if (!tmdb) return this.getDetailedMeta(id);
            return {
                id: seriesItem.id,
                type: 'series',
                name: tmdb.name,
                poster: tmdb.poster || seriesItem.poster,
                background: tmdb.background,
                logo: tmdb.logo,
                description: tmdb.description,
                genres: tmdb.genres,
                releaseInfo: tmdb.releaseInfo,
                year: tmdb.year,
                runtime: tmdb.runtime || seriesItem.runtime || omdb?.runtime,
                metadataVersion: 3,
                _tmdbId: tmdbId || null,
                imdbIdChecked: Boolean(tmdb),
                imdbId: tmdb.imdbId || omdb?.imdbId,
                imdbRating: omdb?.imdbRating != null ? String(omdb.imdbRating) : undefined,
                omdbChecked: omdb?.omdbChecked === true,
                omdbCheckedAt: omdb?.omdbCheckedAt,
                omdbPending: Boolean(tmdb.imdbId && omdbMetadata.shouldRetryLookup(tmdb.imdbId)),
                cast: tmdb.cast,
                tmdbRating: tmdb.rating,
                trailers: [],
                links: [
                    ...(omdb?.imdbRating ? [{ name: 'IMDb rating: ' + omdb.imdbRating, category: 'Rating', url: 'https://www.imdb.com/title/' + encodeURIComponent(String(tmdb.imdbId)) }] : []),
                    ...(tmdb.rating ? [{ name: 'TMDb rating: ' + tmdb.rating, category: 'Rating', url: 'https://www.themoviedb.org/tv/' + encodeURIComponent(String(tmdbId)) }] : []),
                    ...(tmdb.links || [])
                ]
            };
        }

        const item = findCatalogueItemById(this.movies, id);
        if (!item) return this.getDetailedMeta(id);
        const providerModule = require('./src/js/providers/xtreamProvider.js');
        const idCacheKey = 'movie-tmdb:' + id;
        let tmdbId = item.tmdbId || this.seriesInfoCache.get(idCacheKey);
        const providerLookupStartedAt = Date.now();
        if (!tmdbId && this.providerName === 'xtream' && !this.config.xtreamUseM3U) {
            tmdbId = await this.resolveMovieTmdbId(id, item, providerModule);
        }
        const providerLookupMs = Date.now() - providerLookupStartedAt;
        const tmdbLookupStartedAt = Date.now();
        const tmdb = await tmdbMetadata.getMovieCatalogMetadata(tmdbId, { refresh: refreshIncompleteMetadata });
        const omdb = tmdb?.imdbId ? await omdbMetadata.getByImdbId(tmdb.imdbId, { refreshIncomplete: refreshIncompleteMetadata }) : null;
        this.log.debug('Catalogue metadata stages', {
            type: 'movie',
            id: item.id,
            hasListingTmdbId: !!item.tmdbId,
            hasResolvedTmdbId: !!tmdbId,
            providerLookupMs,
            tmdbLookupMs: Date.now() - tmdbLookupStartedAt,
            totalMs: Date.now() - providerLookupStartedAt
        });
        if (!tmdb) return this.getDetailedMeta(id);
        return {
            id: item.id,
            type: 'movie',
            name: tmdb.name,
            poster: tmdb.poster || item.poster,
            background: tmdb.background,
            logo: tmdb.logo,
            description: tmdb.description,
            genres: tmdb.genres,
            releaseInfo: tmdb.releaseInfo,
            year: tmdb.year,
            runtime: tmdb.runtime || item.runtime || omdb?.runtime,
            metadataVersion: 3,
            _tmdbId: tmdbId || null,
            imdbIdChecked: Boolean(tmdb),
            imdbId: tmdb.imdbId || omdb?.imdbId,
            imdbRating: omdb?.imdbRating != null ? String(omdb.imdbRating) : undefined,
            omdbChecked: omdb?.omdbChecked === true,
            omdbCheckedAt: omdb?.omdbCheckedAt,
            omdbPending: Boolean(tmdb.imdbId && omdbMetadata.shouldRetryLookup(tmdb.imdbId)),
            director: tmdb.director,
            cast: tmdb.cast,
            tmdbRating: tmdb.rating,
            trailers: [],
            links: [
                ...(tmdb.rating ? [{ name: 'TMDb rating: ' + tmdb.rating, category: 'Rating', url: 'https://www.themoviedb.org/movie/' + encodeURIComponent(String(tmdbId)) }] : []),
                ...(tmdb.links || [])
            ]
        };
    }

    async getDetailedMetaAsync(id, type) {
        if (type === 'series' || id.startsWith('iptv_series_')) {
            const seriesItem = findCatalogueItemById(this.series, id);
            if (!seriesItem) return null;
            return await this.buildSeriesMeta(seriesItem);
        }
        const item = findCatalogueItemById(this.movies, id);
        if (item) {
            const providerModule = require('./src/js/providers/xtreamProvider.js');
            const idCacheKey = 'movie-tmdb:' + id;
            let tmdbId = item.tmdbId || this.seriesInfoCache.get(idCacheKey);
            if (!tmdbId && this.providerName === 'xtream' && !this.config.xtreamUseM3U) {
                tmdbId = await this.resolveMovieTmdbId(id, item, providerModule);
            }
            const tmdb = await tmdbMetadata.getMovieMetadata(tmdbId);
            if (!tmdb) return this.getDetailedMeta(id);
            // Keep the detailed movie response consistent with the enriched catalogue
            // preview: Stremio needs imdbRating on the returned meta object, not just
            // in the persistent catalogue cache or as a labelled link.
            const omdb = tmdb.imdbId ? await omdbMetadata.getByImdbId(tmdb.imdbId) : null;
            return {
                id: item.id,
                type: 'movie',
                name: tmdb.name,
                poster: tmdb.poster,
                background: tmdb.background,
                logo: tmdb.logo,
                description: tmdb.description,
                genres: tmdb.genres,
                releaseInfo: tmdb.releaseInfo,
                year: tmdb.year,
                runtime: tmdb.runtime || item.runtime || omdb?.runtime,
                imdbId: tmdb.imdbId || omdb?.imdbId,
                imdbRating: omdb?.imdbRating != null ? String(omdb.imdbRating) : undefined,
                director: tmdb.director,
                cast: tmdb.cast,
                tmdbRating: tmdb.rating,
                trailers: tmdb.trailer ? [{ source: tmdb.trailer.id, type: 'Trailer' }] : [],
                links: [
                    ...(omdb?.imdbRating ? [{ name: 'IMDb rating: ' + omdb.imdbRating, category: 'Rating', url: 'https://www.imdb.com/title/' + encodeURIComponent(String(tmdb.imdbId)) }] : []),
                    ...(tmdb.rating ? [{ name: 'TMDb rating: ' + tmdb.rating, category: 'Rating', url: 'https://www.themoviedb.org/movie/' + encodeURIComponent(String(tmdbId)) }] : []),
                    ...(tmdb.links || [])
                ]
            };
        }
        // Live-channel metadata remains unchanged; it is not film/series metadata.
        return this.getDetailedMeta(id);
    }

    getDetailedMeta(id) {
        const item = findCatalogueItemById(this.channels, id) || findCatalogueItemById(this.movies, id);
        if (!item) return null;
        if (item.type === 'tv') {
            // Native EPG programmes are attached separately as scheduled videos.
            // Do not duplicate programme information in the channel description.
            return {
                id: item.id,
                type: 'tv',
                name: item.name,
                poster: this.deriveFallbackLogoUrl(item),
                genres: item.category
                    ? [item.category]
                    : (item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Live TV']),
                runtime: 'Live'
            };
        } else {
            let year = item.year;
            if (!year) {
                const m = item.name.match(/\((\d{4})\)/);
                if (m) year = parseInt(m[1]);
            }
            const description = item.plot || item.attributes?.['plot'] || `Movie: ${item.name}`;
            return {
                id: item.id,
                type: 'movie',
                name: item.name,
                poster: item.poster || item.attributes?.['tvg-logo'] ||
                    `https://via.placeholder.com/300x450/CC6600/FFFFFF?text=${encodeURIComponent(item.name)}`,
                description,
                genres: item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Movie'],
                year
            };
        }
    }
}

async function createAddon(config) {
    const manifest = {
        id: ADDON_ID,
        version: "2.0.0",
        name: ADDON_NAME,
        description: "IPTV addon (M3U / EPG / Xtream) with encrypted configs, caching & series support (Xtream + Direct)",
        resources: ["catalog", "stream", "meta"],
        types: ["tv", "movie", "series"],
        catalogs: [
            {
                type: 'tv',
                id: 'iptv_channels',
                name: 'IPTV Channels',
                extra: [{ name: 'genre' }, { name: 'search' }, { name: 'skip' }, { name: 'date' }],
                genres: []
            },
            {
                type: 'movie',
                id: 'iptv_movies',
                name: 'IPTV Movies',
                extra: [{ name: 'genre' }, { name: 'search' }, { name: 'skip' }],
                genres: []
            },
            {
                type: 'series',
                id: 'iptv_series',
                name: 'IPTV Series',
                extra: [{ name: 'genre' }, { name: 'search' }, { name: 'skip' }],
                genres: []
            }
        ],
        idPrefixes: ["iptv_"],
        behaviorHints: {
            configurable: true,
            configurationRequired: false
        }
    };

    const cacheKey = createCacheKey(config);
    const debugFlag = !!config.debug || DEBUG_ENV;
    if (debugFlag) {
        console.log('[DEBUG] createAddon start', { provider: config.provider, includeSeries: config.includeSeries !== false });
    } else {
        console.log(`[ADDON] Cache ${CACHE_ENABLED ? 'ENABLED' : 'DISABLED'}`);
    }

    if (CACHE_ENABLED && buildPromiseCache.has(cacheKey)) {
        if (debugFlag) console.log('[DEBUG] Reusing in-progress addon build');
        return buildPromiseCache.get(cacheKey);
    }

    const buildPromise = (async () => {
        const addonInstance = new M3UEPGAddon(config, manifest);
        await addonInstance.loadFromCache();
        try {
            // Force update on first load to populate genres
            if (!addonInstance.lastUpdate || (Date.now() - addonInstance.lastUpdate > addonInstance.updateInterval)) {
                await addonInstance.updateData(true);
            }
        } catch (e) {
            console.error('[ADDON] Initial update failed:', e && e.name ? e.name : 'Error');
        }
        addonInstance.buildGenresInManifest();
        // Load the complete persistent metadata index before serving requests, so
        // saved OMDb/TMDb previews are immediately available after a Railway restart.
        // This loads saved data only; it does not wait for network refreshes.
        await addonInstance.persistentCatalogMetaCache.init();
        // Start the full movie/series metadata warm-up as soon as this configured
        // addon is built, rather than waiting for the first Discover request.
        // It is intentionally non-blocking: saved previews remain available while
        // missing or 14-day-due metadata is refreshed in the background.
        const metadataPrefetchPageSize = parsePositiveInteger(process.env.CATALOG_PAGE_SIZE, 50, 10, 100);
        const metadataPrefetchConcurrency = parsePositiveInteger(process.env.CATALOG_PREFETCH_CONCURRENCY, 3, 1, 6);
        if ((process.env.CATALOG_PREFETCH_NEXT_PAGE || 'true').toLowerCase() !== 'false') {
            addonInstance.startContinuousCatalogPrefetch('movie', metadataPrefetchPageSize, metadataPrefetchConcurrency);
            if (addonInstance.config.includeSeries !== false) {
                addonInstance.startContinuousCatalogPrefetch('series', metadataPrefetchPageSize, metadataPrefetchConcurrency);
            }
        }
        // Keep provider catalogue and guide refreshed every 12 hours even if Stremio is idle
        // after startup. The timer is unref'd so it does not keep Node alive.
        addonInstance.startScheduledRefresh();

        // Only advertise native EPG when this instance has parsed real programme data.
        manifest.behaviorHints.epgProvider = Object.values(addonInstance.epgData || {})
            .some(programmes => Array.isArray(programmes) && programmes.length > 0);

        // Pass the fully populated manifest to builder
        // IMPORTANT: We must ensure 'manifest' object has 'catalogs[].genres' populated BEFORE creating builder
        const builder = new addonBuilder(manifest); 

        builder.defineCatalogHandler(async (args) => {
            const start = Date.now();
            try {
                // Background update
                addonInstance.updateData().catch(() => { });

                let items = [];
                if (args.type === 'tv' && args.id === 'iptv_channels') {
                    items = addonInstance.channels;
                } else if (args.type === 'movie' && args.id === 'iptv_movies') {
                    items = addonInstance.movies;
                } else if (args.type === 'series' && args.id === 'iptv_series') {
                    if (addonInstance.config.includeSeries !== false)
                        items = addonInstance.series;
                }

                const extra = args.extra || {}; // Stremio passes filter/genre here
                let filtered = items;
                let genreFilterMs = 0;
                let genreIndexMs = 0;
                let genreIndexBuilt = false;
                let searchIndexMs = 0;
                let searchFilterMs = 0;
                let searchIndexBuilt = false;

                const normalizedSearchQuery = extra.search ? getNormalizedSearchText(extra.search) : '';
                const selectedGenre = extra.genre && normalizeGenre(extra.genre) !== 'all channels'
                    ? normalizeGenre(extra.genre)
                    : '';
                const queryCacheKey = normalizedSearchQuery
                    ? selectedGenre + '\u0000' + normalizedSearchQuery
                    : null;
                const queryResultCache = queryCacheKey ? getCatalogueQueryResultCache(items) : null;
                let queryCacheHit = false;
                // Preserve existing behaviour for punctuation-only searches: they
                // normalize to an empty query and must return no matches, not all items.
                if (extra.search && !normalizedSearchQuery) {
                    filtered = [];
                    queryCacheHit = true;
                }
                if (!queryCacheHit && queryResultCache && queryResultCache.has(queryCacheKey)) {
                    filtered = queryResultCache.get(queryCacheKey);
                    // Refresh insertion order for bounded LRU eviction.
                    queryResultCache.delete(queryCacheKey);
                    queryResultCache.set(queryCacheKey, filtered);
                    queryCacheHit = true;
                }

                // If specific genre selected, reuse normalised item categories across
                // requests. Matching remains exact and preserves catalogue order.
                const genreFilterStartedAt = Date.now();
                if (!queryCacheHit && selectedGenre) {
                    const genreIndexStartedAt = Date.now();
                    const genreIndexResult = getCatalogueGenreIndex(items);
                    const genreIndex = genreIndexResult.index;
                    genreIndexBuilt = genreIndexResult.built;
                    genreIndexMs = Date.now() - genreIndexStartedAt;
                    filtered = filtered.filter(i => {
                        const indexedGenre = genreIndex.get(i);
                        if (indexedGenre !== undefined) return indexedGenre === selectedGenre;
                        const cat = i.category || i.attributes?.['group-title'];
                        return matchesGenre(cat, selectedGenre);
                    });
                }
                genreFilterMs = Date.now() - genreFilterStartedAt;

                // Keep normalized titles indexed per immutable catalogue array. This
                // avoids repeatedly normalizing thousands of titles on every search,
                // without changing matching rules, result order, or displayed titles.
                if (!queryCacheHit && normalizedSearchQuery) {
                    const indexStartedAt = Date.now();
                    const searchIndexResult = getCatalogueSearchIndex(items);
                    const searchIndex = searchIndexResult.index;
                    searchIndexBuilt = searchIndexResult.built;
                    const matcher = createNormalizedSearchMatcher(normalizedSearchQuery);
                    searchIndexMs = Date.now() - indexStartedAt;

                    const searchFilterStartedAt = Date.now();
                    filtered = filtered.filter(i => {
                        const indexedTitle = searchIndex.get(i);
                        return indexedTitle
                            ? matcher(indexedTitle.text, indexedTitle.words)
                            : matcher(getNormalizedSearchText(i.name));
                    });
                    searchFilterMs = Date.now() - searchFilterStartedAt;
                }

                if (queryResultCache && !queryCacheHit) {
                    cacheCatalogueQueryResults(queryResultCache, queryCacheKey, filtered);
                }
                
                // Keep every movie/series Discover batch small enough to enrich fully
                // before returning it, including search results. Stremio requests the next
                // page as the user scrolls, so no visible movie/series card depends on a
                // later background update. Live-TV/EPG retain the existing 100-item size.
                const catalogPageSize = (args.type === 'movie' || args.type === 'series')
                    ? parsePositiveInteger(process.env.CATALOG_PAGE_SIZE, 50, 10, 100)
                    : 100;

                // Pagination / Skip. Stremio's next-page skip is based on the number
                // of items already returned, so smaller non-search pages remain pageable.
                const paginationStartedAt = Date.now();
                const skip = extra.skip ? parseInt(extra.skip) : 0;
                const page = filtered.slice(skip, skip + catalogPageSize);
                const paginationMs = Date.now() - paginationStartedAt;

                // Native EPG requests specify a UTC date and expect metasDetailed.
                if (args.type === 'tv' && args.id === 'iptv_channels' && extra.date) {
                    const dateMatch = /^\d{4}-\d{2}-\d{2}$/.test(extra.date);
                    const dateStart = dateMatch ? Date.parse(`${extra.date}T00:00:00.000Z`) : NaN;
                    const validDate = Number.isFinite(dateStart) &&
                        new Date(dateStart).toISOString().slice(0, 10) === extra.date;
                    if (!validDate) return { metasDetailed: [], cacheMaxAge: 300 };

                    const dateEnd = dateStart + 86400000;
                    const metasDetailed = page.map(channel => {
                        const videos = addonInstance.getScheduledPrograms(channel, dateStart, dateEnd);
                        return {
                            ...addonInstance.generateMetaPreview(channel),
                            type: 'tv',
                            posterShape: 'square',
                            behaviorHints: {
                                isLive: true,
                                hasScheduledVideos: videos.length > 0
                            },
                            videos
                        };
                    });

                    if (addonInstance.config.debug) {
                        console.log('[DEBUG] EPG guide catalog', {
                            date: extra.date,
                            channels: metasDetailed.length,
                            scheduledChannels: metasDetailed.filter(m => m.videos.length > 0).length,
                            skip,
                            ms: Date.now() - start
                        });
                    }
                    return { metasDetailed, cacheMaxAge: 300, staleRevalidate: 1800, staleError: 604800 };
                }

                // Stremio does not reliably refresh cards already rendered in Discover.
                // Enrich every movie/series item in the current page before replying,
                // including search results. Later pages are loaded when the user scrolls.
                // Allow more independent item lookups to overlap. Keep this configurable
                // because some Xtream providers impose stricter request limits.
                const genreMetaConcurrency = parsePositiveInteger(
                    process.env.CATALOG_GENRE_META_CONCURRENCY, 16, 1, 16
                );
                const enrichmentStartedAt = Date.now();
                if (page.length && (args.type === 'movie' || args.type === 'series')) {
                    await addonInstance.enrichCatalogMetaItems(page, genreMetaConcurrency);
                }
                const enrichmentMs = Date.now() - enrichmentStartedAt;

                // One background job per media type warms the complete, unfiltered
                // catalogue. Search requests join the same job instead of creating
                // separate walks over every search result. Persistent metadata means the
                // full catalogue can remain warm across restarts when a volume is configured.
                const continuousPrefetchEnabled =
                    (process.env.CATALOG_PREFETCH_NEXT_PAGE || 'true').toLowerCase() !== 'false';
                if (continuousPrefetchEnabled &&
                    (args.type === 'movie' || args.type === 'series')) {
                    const prefetchConcurrency = parsePositiveInteger(
                        process.env.CATALOG_PREFETCH_CONCURRENCY, 3, 1, 6
                    );
                    addonInstance.startContinuousCatalogPrefetch(
                        args.type, catalogPageSize, prefetchConcurrency
                    );
                }

                const responseBuildStartedAt = Date.now();
                const metas = page.map((i, pageIndex) => {
                    const meta = addonInstance.generateMetaPreview(i);
                    if (i.type === 'tv') {
                        meta.behaviorHints = { isLive: true };
                        meta.posterShape = 'square';
                        return meta;
                    }
                    if (i.type !== 'movie' && i.type !== 'series') return meta;

                    const cached = addonInstance.catalogMetaCache.get(i.id);
                    if (cached) return {
                        ...meta,
                        ...cached,
                        id: i.id,
                        type: i.type,
                        // Stremio's MetaPreview schema specifies imdbRating as a string.
                        // Normalize older persisted numeric values as well as new lookups.
                        ...(cached.imdbRating != null && cached.imdbRating !== ''
                            ? { imdbRating: String(cached.imdbRating) }
                            : {})
                    };

                    // Foreground enrichment has finished for this page. If TMDb or
                    // the provider could not supply a richer preview, retain the base
                    // provider metadata rather than stripping fields from the card.
                    // We never mutate this already-built response in the background.
                    return { ...meta, id: i.id, type: i.type };
                });
                
                metas.forEach(stripTmdbRatings);

                const responseBuildMs = Date.now() - responseBuildStartedAt;
                if (addonInstance.config.debug) {
                    console.log('[DEBUG] Catalog handler', {
                        type: args.type,
                        id: args.id,
                        genre: extra.genre,
                        totalItems: items.length,
                        filtered: filtered.length,
                        returned: metas.length,
                        skip,
                        genreFilterMs,
                        genreIndexMs,
                        genreIndexBuilt,
                        searchIndexMs,
                        searchIndexBuilt,
                        searchFilterMs,
                        queryCacheHit,
                        paginationMs,
                        enrichmentMs,
                        responseBuildMs,
                        ms: Date.now() - start
                    });
                }
                return { metas };
            } catch (e) {
                console.error('[CATALOG] Error', e && e.name ? e.name : 'Error');
                return { metas: [] };
            }
        });

        builder.defineStreamHandler(async ({ type, id }) => {
            try {
                if (id.startsWith('iptv_series_ep_')) {
                    const stream = addonInstance.getStream(id);
                    if (!stream) return { streams: [] };
                    if (addonInstance.config.debug) {
                        console.log('[DEBUG] Series Episode Stream request', { id, target: safeStreamTarget(stream.url) });
                    }
                    return { streams: [stream] };
                }
                const stream = addonInstance.getStream(id);
                if (!stream) return { streams: [] };
                if (addonInstance.config.debug) {
                    console.log('[DEBUG] Stream request', { id, target: safeStreamTarget(stream.url) });
                }
                return { streams: [stream] };
            } catch (e) {
                console.error('[STREAM] Error', e && e.name ? e.name : 'Error');
                return { streams: [] };
            }
        });

        builder.defineMetaHandler(async ({ type, id }) => {
            try {
                // Ensure Stremio's native header rating is populated on detailed pages.
                // Some cached/legacy metadata has the IMDb score only in the "Rating"
                // links section; promote that same score to the documented top-level field.
                const exposeNativeImdbRating = (meta) => {
                    if (!meta || typeof meta !== 'object') return meta;
                    stripTmdbRatings(meta);
                    const isValidRating = (value) => {
                        if (value == null || value === '') return false;
                        const numeric = Number(value);
                        return Number.isFinite(numeric) && numeric >= 0 && numeric <= 10;
                    };

                    let rating = meta.imdbRating;
                    if (!isValidRating(rating)) {
                        const cachedPreview = addonInstance.catalogMetaCache?.get(id);
                        if (isValidRating(cachedPreview?.imdbRating)) {
                            rating = cachedPreview.imdbRating;
                        }
                    }
                    if (!isValidRating(rating) && Array.isArray(meta.links)) {
                        const imdbRatingLink = meta.links.find((link) =>
                            link && typeof link.name === 'string' &&
                            /^IMDb rating:\s*(?:10(?:\.0+)?|[0-9](?:\.[0-9]+)?)$/i.test(link.name.trim())
                        );
                        if (imdbRatingLink) {
                            const match = imdbRatingLink.name.trim().match(
                                /^IMDb rating:\s*(10(?:\.0+)?|[0-9](?:\.[0-9]+)?)$/i
                            );
                            if (match) rating = match[1];
                        }
                    }
                    if (isValidRating(rating)) meta.imdbRating = String(rating);
                    return meta;
                };

                if (addonInstance.config.debug) {
                    console.log('[DEBUG] Meta handler called', { type, id, seriesCount: addonInstance.series.length });
                }
                if (type === 'series' || id.startsWith('iptv_series_')) {
                    const meta = exposeNativeImdbRating(
                        await addonInstance.getDetailedMetaAsync(id, 'series')
                    );
                    if (addonInstance.config.debug) {
                        console.log('[DEBUG] Series meta result', { id, found: !!meta, videos: meta?.videos?.length });
                    }
                    if (!meta) {
                        // Fallback: Try to find in series list and return basic meta without episodes
                        const seriesItem = addonInstance.series.find(s => s.id === id);
                        if (seriesItem) {
                            const fallbackMeta = {
                                id: seriesItem.id,
                                type: 'series',
                                name: 'Metadata unavailable',
                                videos: []
                            };
                            if (addonInstance.config.debug) {
                                console.log('[DEBUG] Series meta fallback used', { id, name: seriesItem.name });
                            }
                            return { meta: fallbackMeta };
                        }
                    }
                    return { meta: meta || null };
                }
                const meta = exposeNativeImdbRating(
                    await addonInstance.getDetailedMetaAsync(id, type)
                );
                if (meta && type === 'tv' && meta.type === 'tv') {
                    const channel = addonInstance.channels.find(item => item.id === id);
                    if (channel) {
                        const now = Date.now();
                        const videos = addonInstance.getScheduledPrograms(
                            channel, now - 3 * 3600000, now + 24 * 3600000
                        );
                        meta.behaviorHints = {
                            ...(meta.behaviorHints || {}),
                            isLive: true,
                            hasScheduledVideos: videos.length > 0
                        };
                        meta.posterShape = 'square';
                        meta.videos = videos;
                    }
                }
                if (meta && (type === 'movie' || type === 'series')) {
                    // Keep the native Stremio header field explicit on the final response,
                    // after all enrichment/fallback paths have completed.
                    const finalRating = meta.imdbRating;
                    if (finalRating != null && finalRating !== '') {
                        const numericRating = Number(finalRating);
                        if (Number.isFinite(numericRating) && numericRating >= 0 && numericRating <= 10) {
                            meta.imdbRating = numericRating.toFixed(1);
                        }
                    }
                }
                if (meta && (type === 'movie' || type === 'series')) {
                    // Log the final field Stremio uses for the native rating header even
                    // when general debug logging is disabled, so live deployments can be
                    // diagnosed without enabling verbose request logs.
                    console.log('[META-RATING] Final detail response', {
                        id,
                        type,
                        imdbRating: meta.imdbRating ?? null,
                        imdbRatingType: typeof meta.imdbRating,
                        imdbId: meta.imdbId ?? null,
                        ratingLinks: Array.isArray(meta.links)
                            ? meta.links.filter(link => /^IMDb rating:/i.test(String(link?.name || ''))).length
                            : 0
                    });
                }
                if (addonInstance.config.debug) {
                    console.log('[DEBUG] Meta request', { id, type, found: !!meta });
                }
                return { meta };
            } catch (e) {
                console.error('[META] Error', e && e.name ? e.name : 'Error', e && e.message ? e.message : 'No error message', e && e.stack ? e.stack : 'No stack trace');
                return { meta: null };
            }
        });

        const iface = builder.getInterface();

        // POST-BUILD: Inject 'options' into each catalog's genre extra entry.
        // This MUST happen after getInterface() because the SDK linter would reject
        // the large options arrays during build. The manifest object is shared by
        // reference, so mutating it here affects the iface.manifest served by our
        // custom manifest.json route in server.js.
        for (const catalog of manifest.catalogs) {
            if (Array.isArray(catalog.genres) && catalog.genres.length > 0) {
                if (Array.isArray(catalog.extra)) {
                    const genreExtra = catalog.extra.find(e => e.name === 'genre');
                    if (genreExtra) {
                        genreExtra.options = [...catalog.genres];
                    }
                }
            }
        }

        return iface;
    })();

    if (CACHE_ENABLED) buildPromiseCache.set(cacheKey, buildPromise);
    try {
        const iface = await buildPromise;
        return iface;
    } finally {
        // Coalesce concurrent builds, but don't retain completed promises forever.
        if (buildPromiseCache.get(cacheKey) === buildPromise) {
            buildPromiseCache.delete(cacheKey);
        }
    }
}

module.exports = createAddon;
module.exports.M3UEPGAddon = M3UEPGAddon;
module.exports.normalizeGenre = normalizeGenre;
module.exports.matchesGenre = matchesGenre;
module.exports.normalizeSearchText = normalizeSearchText;
module.exports.matchesSearchText = matchesSearchText;
module.exports.matchesNormalizedSearchText = matchesNormalizedSearchText;
module.exports.createNormalizedSearchMatcher = createNormalizedSearchMatcher;
module.exports.getCatalogueQueryResultCache = getCatalogueQueryResultCache;
module.exports.createCatalogueQueryCacheKey = createCatalogueQueryCacheKey;
module.exports.cacheCatalogueQueryResults = cacheCatalogueQueryResults;
module.exports.omdbMetadataNeedsRefresh = omdbMetadataNeedsRefresh;
module.exports.catalogMetadataNeedsRefresh = catalogMetadataNeedsRefresh;
