// IPTV catalogue, metadata and playback integration for Xtream and direct M3U.
require('dotenv').config({ quiet: true });

const { createLogger, logAt } = require('./logger');

const { addonBuilder } = require("stremio-addon-sdk");
const crypto = require("crypto");
const { isDeepStrictEqual } = require("util");
const requestContext = require("./requestContext");
const { mapWithConcurrency, withTimeout } = require("./asyncUtils");
const m3uParser = require("./src/js/m3u-parser");
const LRUCache = require("./lruCache");
const PersistentCatalogMetaCache = require("./persistentCatalogMetaCache");
const PersistentAddonDataCache = require("./persistentAddonDataCache");
const PersistentSeriesInfoCache = require("./persistentSeriesInfoCache");
const cleanupPersistentCacheFiles = require("./persistentCacheMaintenance");
const tmdbMetadata = require("./src/js/tmdbMetadata");
const omdbMetadata = require("./src/js/omdbMetadata");
const { parseRuntimeMinutes, averageEpisodeRuntime, isEligibleRuntimeEpisode } = require("./seriesRuntime");

// Retry incomplete OMDb data independently of the longer metadata refresh interval.
// Missing ratings/runtime are retried at most once per configured interval.
const OMDB_MISSING_DATA_RETRY_MS = parsePositiveInteger(
    process.env.OMDB_MISSING_DATA_RETRY_MS, 12 * 60 * 60 * 1000,
    60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000
);

const CATALOG_METADATA_FAILURE_RETRY_MS = parsePositiveInteger(
    process.env.CATALOG_METADATA_FAILURE_RETRY_MS, 12 * 60 * 60 * 1000,
    60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000
);

const SERIES_INFO_FAILURE_RETRY_MS = 5 * 60 * 1000;
const PROVIDER_REFRESH_RETRY_MS = parsePositiveInteger(
    process.env.PROVIDER_REFRESH_RETRY_MS, 60 * 60 * 1000, 5 * 60 * 1000, 6 * 60 * 60 * 1000
);
const EPG_REFRESH_RETRY_MS = parsePositiveInteger(
    process.env.EPG_REFRESH_RETRY_MS, 60 * 60 * 1000, 5 * 60 * 1000, 6 * 60 * 60 * 1000
);

function omdbMetadataNextCheckAt(value) {
    if (!value || !value.imdbId) return Infinity;
    if (value.imdbRating && value.runtime && !value.omdbPending) return Infinity;
    // Coordinate OMDb and general catalogue retries. If a recent catalogue
    // attempt already tried available sources, don't let an older OMDb timestamp
    // bypass the shared 12-hour backoff on the next card request.
    const checkedAt = Math.max(
        Number(value.omdbCheckedAt) || 0,
        Number(value.missingMetadataCheckedAt) || 0,
        Number(value.metadataCheckedAt) || 0
    );
    return checkedAt ? checkedAt + OMDB_MISSING_DATA_RETRY_MS : 0;
}

function omdbMetadataNeedsRefresh(value) {
    return omdbMetadataNextCheckAt(value) <= Date.now();
}

// Retry incomplete combined catalogue metadata from any source on the same
// 12-hour cadence, without making complete cards refresh more often than 14 days.
/** Remove TMDb score fields/links from user-facing metadata while retaining
 * TMDb-sourced artwork, descriptions, cast, dates and other metadata. */
function stripTmdbRatings(meta) {
    if (!meta || typeof meta !== 'object') return meta;

    // Keep the add-on's own IMDb ID field for existing integrations, and also
    // expose the snake_case alias present in native Cinemeta metadata. This is
    // additive only: the IPTV meta ID and stream IDs must never be replaced.
    const nativeImdbId = String(meta.imdb_id || meta.imdbId || '').trim();
    if (/^tt\d+$/.test(nativeImdbId)) {
        meta.imdb_id = nativeImdbId;
        if (!meta.imdbId) meta.imdbId = nativeImdbId;
    }

    delete meta.tmdbRating;
    if (Array.isArray(meta.links)) {
        meta.links = meta.links
            .filter(link => !/^TMDb rating:/i.test(String(link?.name || '').trim()))
            .map(link => {
                // Stremio Web currently recognizes the IMDb badge only when the
                // URL hostname is exactly "imdb.com", not "www.imdb.com".
                const url = String(link?.url || '').trim();
                let normalizedLink = link;
                if (String(link?.category || '').toLowerCase() === 'imdb' &&
                    /^https?:\/\/(?:www\.)?imdb\.com\/title\//i.test(url)) {
                    normalizedLink = {
                        ...link,
                        url: url.replace(/^https?:\/\/(?:www\.)?imdb\.com/i, 'https://imdb.com')
                    };
                }

                // Stremio Core treats category "imdb" specially: the link label
                // becomes the native IMDb score/logo in the metadata header.
                const match = String(normalizedLink?.name || '').trim().match(
                    /^IMDb rating:\s*(10(?:\.0+)?|[0-9](?:\.\d+)?)$/i
                );
                if (!match) return normalizedLink;
                return { ...normalizedLink, name: match[1], category: 'imdb' };
            });

        const isValidImdbRating = value => value != null && value !== '' &&
            Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 10;
        if (!isValidImdbRating(meta.imdbRating)) {
            const imdbRatingLink = meta.links.find(link =>
                String(link?.category || '').toLowerCase() === 'imdb' &&
                /^(?:10(?:\.0+)?|[0-9](?:\.[0-9]+)?)$/.test(String(link?.name || '').trim())
            );
            if (imdbRatingLink) meta.imdbRating = imdbRatingLink.name;
        }
        if (isValidImdbRating(meta.imdbRating)) meta.imdbRating = Number(meta.imdbRating).toFixed(1);

        // Catalogue previews also need the canonical IMDb link. The numeric
        // imdbRating field is supported by the Meta Preview schema, but some
        // Stremio clients render the native IMDb badge from an IMDb-category link.
        // Add it only when a valid IMDb ID and rating exist, and avoid duplicates.
        const imdbId = String(meta.imdbId || '').trim();
        const imdbRating = String(meta.imdbRating ?? '').trim();
        const validRating = /^(10(?:\.0+)?|[0-9](?:\.[0-9]+)?)$/.test(imdbRating);
        if (imdbId && validRating && !meta.links.some(link =>
            String(link?.category || '').toLowerCase() === 'imdb' &&
            String(link?.url || '').includes('/title/' + imdbId)
        )) {
            meta.links.push({
                name: imdbRating,
                category: 'imdb',
                url: 'https://imdb.com/title/' + encodeURIComponent(imdbId)
            });
        }
    } else if (meta.imdbId && meta.imdbRating != null && meta.imdbRating !== '') {
        // Ensure a links array exists for enriched catalogue preview metadata.
        const imdbRating = String(meta.imdbRating).trim();
        if (/^(10(?:\.0+)?|[0-9](?:\.[0-9]+)?)$/.test(imdbRating)) {
            meta.links = [{
                name: imdbRating,
                category: 'imdb',
                url: 'https://imdb.com/title/' + encodeURIComponent(String(meta.imdbId).trim())
            }];
        }
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

function missingCatalogMetadataFields(value) {
    if (!value || typeof value !== 'object') return [];
    const missing = [];
    if (!isMetadataValuePresent('poster', value.poster)) missing.push('poster');
    if (!value.background) missing.push('background');
    if (!isMetadataValuePresent('description', value.description)) missing.push('description');
    if (!isMetadataValuePresent('genres', value.genres)) missing.push('genres');
    if (!(value.year || value.releaseInfo)) missing.push('year/releaseInfo');
    if (!isMetadataValuePresent('runtime', value.runtime)) missing.push('runtime');
    if (!isMetadataValuePresent('imdbRating', value.imdbRating)) missing.push('imdbRating');
    if (!Array.isArray(value.cast) || value.cast.length === 0) missing.push('cast');
    if (value._tmdbId && !value.imdbId) missing.push('imdbId');
    if (value.type === 'movie' && !isMetadataValuePresent('director', value.director)) missing.push('director');
    return missing;
}

function catalogMetadataMissingNextCheckAt(value) {
    const missing = missingCatalogMetadataFields(value);
    if (!missing.length) return Infinity;
    // Keep missing-field retry timing separate from the normal metadata
    // refresh timestamp. Older persisted entries migrate via metadataCheckedAt.
    let checkedAt = Number(value.missingMetadataCheckedAt) ||
        Number(value.metadataCheckedAt) || 0;
    // A real OMDb attempt can throttle retries of its own fields. Merely
    // opening details must not defer retries of artwork, cast or descriptions.
    if (value.imdbId && missing.every(field => field === 'imdbRating' || field === 'runtime')) {
        checkedAt = Math.max(checkedAt, Number(value.omdbCheckedAt) || 0);
    }
    return checkedAt ? checkedAt + OMDB_MISSING_DATA_RETRY_MS : 0;
}

function catalogMetadataNeedsRefresh(value) {
    return catalogMetadataMissingNextCheckAt(value) <= Date.now();
}

const GENERIC_CATALOG_GENRES = new Set(['movie', 'movies', 'series', 'tv']);

function isMetadataValuePresent(field, value) {
    if (value === undefined || value === null || value === '') return false;
    if (Array.isArray(value)) {
        if (value.length === 0) return false;
        if (field === 'genres') {
            if (value.every(genre => GENERIC_CATALOG_GENRES.has(String(genre || '').trim().toLowerCase()))) return false;
        }
    }
    if (field === 'poster' && /(?:via\.placeholder\.com|placehold\.co)/i.test(String(value))) return false;
    if (field === 'description' && (
        value === 'Series / Show' || /^Movie:\s*/i.test(String(value))
    )) return false;
    if ((field === 'runtime' || field === 'imdbRating') && /^(?:n\/?a|not rated|unknown)$/i.test(String(value).trim())) return false;
    return true;
}

function mergeCatalogMetadataPreservingKnownFields(previous, refreshed) {
    previous = withoutProviderEpisodeAverage(previous);
    refreshed = withoutProviderEpisodeAverage(refreshed);
    const fresh = refreshed && typeof refreshed === 'object' && !Array.isArray(refreshed)
        ? refreshed
        : {};
    const old = previous && typeof previous === 'object' && !Array.isArray(previous)
        ? previous
        : null;
    if (!old) return { ...fresh };

    // Never carry title-specific metadata across a confirmed TMDb identity change.
    const conflictingTmdbIds = old._tmdbId && fresh._tmdbId &&
        String(old._tmdbId) !== String(fresh._tmdbId);
    if (conflictingTmdbIds) return { ...fresh };

    const providerFallback = Boolean(old._tmdbId &&
        Object.prototype.hasOwnProperty.call(fresh, '_tmdbId') && !fresh._tmdbId);
    const refreshStateFields = new Set([
        'id', 'type', 'metadataVersion', 'metadataCheckedAt',
        'missingMetadataCheckedAt', 'metadataRefreshAttemptedAt', 'imdbIdChecked',
        'omdbChecked', 'omdbCheckedAt', 'omdbPending', 'runtimeAverage'
    ]);
    const merged = { ...old, ...fresh };
    for (const [field, freshValue] of Object.entries(fresh)) {
        if (!refreshStateFields.has(field) &&
            (providerFallback || !isMetadataValuePresent(field, freshValue)) &&
            isMetadataValuePresent(field, old[field])) {
            merged[field] = old[field];
        }
    }
    // A provider fallback normally preserves known TMDb fields. An accepted
    // derived runtime must move together with its provenance, including when
    // two sources happen to report the same minute value.
    if (providerFallback && Object.prototype.hasOwnProperty.call(fresh, 'runtimeAverage') &&
        parseRuntimeMinutes(old.runtime) !== null) {
        const acceptedUpdate = hasDerivedSeriesRuntime(old) &&
            (hasDerivedSeriesRuntime(fresh) ||
                (fresh.runtimeAverage === null && parseRuntimeMinutes(fresh.runtime) !== null));
        if (acceptedUpdate) {
            merged.runtime = fresh.runtime;
        } else {
            merged.runtime = old.runtime;
            merged.runtimeAverage = old.runtimeAverage || null;
        }
    }
    return merged;
}

function hasDerivedSeriesRuntime(value) {
    // Accept persisted averages written after the baseline commit so the new
    // filtering policy can recalculate them without treating them as source runtimes.
    return value?.type === 'series' && [1, 2].includes(value.runtimeAverage?.version) &&
        parseRuntimeMinutes(value.runtime) !== null && value.runtimeAverage.runtime === value.runtime;
}

function withoutProviderEpisodeAverage(value) {
    if (value?.type !== 'series' ||
        !['provider-episodes', 'mixed-episodes'].includes(value.runtimeAverage?.source)) return value;
    const clean = { ...value };
    if (value.runtimeAverage.runtime === value.runtime) delete clean.runtime;
    delete clean.runtimeAverage;
    return clean;
}

function validSeriesRuntime(...values) {
    return values.find(value => parseRuntimeMinutes(value) !== null);
}

function metadataRefreshInterval() {
    return parsePositiveInteger(process.env.CATALOG_METADATA_REFRESH_MS, 14 * 24 * 60 * 60 * 1000,
        60 * 60 * 1000, 90 * 24 * 60 * 60 * 1000);
}

function seriesRuntimeAverageNextCheckAt(value) {
    if (value?.type !== 'series') return Infinity;
    if (withoutProviderEpisodeAverage(value) !== value) return 0;
    if (parseRuntimeMinutes(value.runtime) !== null && !hasDerivedSeriesRuntime(value)) return Infinity;
    const average = value.runtimeAverage;
    if (![1, 2].includes(average?.version)) return 0;
    const attemptedAt = Number(average.attemptedAt) || 0;
    if (average.policyVersion !== 1) {
        return average.attemptPolicyVersion !== 1 || !attemptedAt ? 0 : attemptedAt + OMDB_MISSING_DATA_RETRY_MS;
    }
    if (average.complete === false && !Number(average.attemptedAt)) return 0;
    const checkedAt = Number(average.checkedAt) || 0;
    const missingDurations = Array.isArray(average.seasons) && average.seasons.some(season =>
        Number(season.runtimeCount) < Number(season.eligibleEpisodeCount ?? season.episodeCount));
    const retryMissing = !hasDerivedSeriesRuntime(value) || average.complete !== true ||
        missingDurations || attemptedAt > checkedAt;
    const interval = retryMissing ? OMDB_MISSING_DATA_RETRY_MS : metadataRefreshInterval();
    const timestamp = retryMissing ? attemptedAt || checkedAt : checkedAt;
    return timestamp ? timestamp + interval : 0;
}

function seriesRuntimeAverageNeedsRefresh(value) {
    return seriesRuntimeAverageNextCheckAt(value) <= Date.now();
}

function catalogMetadataIdentityNextCheckAt(value, item) {
    if (!value?._tmdbId || !item?.tmdbId || String(value._tmdbId) === String(item.tmdbId)) return Infinity;
    const attemptedAt = Number(value.metadataRefreshAttemptedAt) || 0;
    return attemptedAt ? attemptedAt + CATALOG_METADATA_FAILURE_RETRY_MS : 0;
}

function catalogMetadataNextCheckAt(value, item) {
    if (!value) return 0;
    return Math.min(catalogMetadataNormalNextCheckAt(value), catalogMetadataIdentityNextCheckAt(value, item),
        catalogMetadataMissingNextCheckAt(value), omdbMetadataNextCheckAt(value), seriesRuntimeAverageNextCheckAt(value));
}

function getCatalogMetadataWarmupState(value, item) {
    const missingFields = value ? missingCatalogMetadataFields(value) : ['preview'];
    const nameMissing = !String(value?.name || '').trim();
    const metadataVersionOld = Boolean(value) && !(Number(value.metadataVersion) >= 3);
    const imdbIdLookupPending = Boolean(value?._tmdbId && !value?.imdbId && value?.imdbIdChecked !== true);
    const incomplete = !value || nameMissing || metadataVersionOld || imdbIdLookupPending ||
        value.omdbPending === true || missingFields.length > 0;
    const retryDue = catalogMetadataNextCheckAt(value, item) <= Date.now();
    return { missingFields, incomplete, retryDue };
}

function catalogMetadataNormalNextCheckAt(value, savedAt = 0) {
    const timestamp = Number(value?.metadataCheckedAt) || Number(savedAt) || 0;
    const schemaDue = !String(value?.name || '').trim() ||
        !(Number(value?.metadataVersion) >= 3) ||
        (value?._tmdbId && !value?.imdbId && value?.imdbIdChecked !== true);
    const attemptedAt = Number(value?.metadataRefreshAttemptedAt) || 0;
    return Math.max(schemaDue || !timestamp ? 0 : timestamp + metadataRefreshInterval(),
        attemptedAt ? attemptedAt + CATALOG_METADATA_FAILURE_RETRY_MS : 0);
}

function catalogMetadataNormalRefreshIsDue(value, savedAt = 0) {
    return catalogMetadataNormalNextCheckAt(value, savedAt) <= Date.now();
}

const CACHE_ENABLED = (process.env.CACHE_ENABLED || 'true').toLowerCase() !== 'false';

let redisClient = null;
if (process.env.REDIS_URL && CACHE_ENABLED) {
    try {
        const { Redis } = require('ioredis');
        redisClient = new Redis(process.env.REDIS_URL, {
            lazyConnect: true,
            maxRetriesPerRequest: 1,
            commandTimeout: 1000,
            enableOfflineQueue: false
        });
        redisClient.on('error', e => logAt('error', '[REDIS] Error:', e && e.name ? e.name : 'Error'));
        redisClient.connect().catch(err => logAt('error', '[REDIS] Connect failed:', err && err.name ? err.name : 'Error'));
        logAt('info', '[REDIS] Enabled');
    } catch (e) {
        logAt('warn', '[REDIS] ioredis not installed or failed, falling back to in-memory LRU');
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
const catalogueFingerprints = new WeakMap();
function getCatalogueFingerprint(items) {
    let fingerprint = catalogueFingerprints.get(items);
    if (!fingerprint) {
        fingerprint = crypto.createHash("sha256").update(items.map(item => String(item?.id || "")).join("\n")).digest("hex");
        catalogueFingerprints.set(items, fingerprint);
    }
    return fingerprint;
}

// Genre labels are stable for a loaded catalogue. Cache their normalised values
// per catalogue array so browsing different genres doesn't repeatedly run Unicode
// normalisation over every item in large movie/series libraries.
const catalogueGenreIndexes = new WeakMap();

function getCatalogueGenreIndex(items) {
    let index = catalogueGenreIndexes.get(items);
    if (index) return { ...index, built: false };
    const groups = new Map(), labels = new Map();
    for (const item of items) {
        if (!item || labels.has(item)) continue;
        const category = normalizeGenre(item.category || item.attributes?.['group-title']);
        labels.set(item, category);
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push(item);
    }
    index = { index: labels, groups };
    catalogueGenreIndexes.set(items, index);
    return { ...index, built: true };
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
 * Apostrophes are ignored, while other punctuation/symbols become spaces.
 * This makes "it's" and "its", and hyphenated/unhyphenated titles, equivalent.
 */
function normalizeSearchText(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/['’‘ʼ]/gu, '')
        .replace(/[\p{P}\p{S}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Score a title match for relevance. Exact titles and phrase/whole-word matches
 * rank above partial-token and in-word substring matches. Query tokens may
 * still appear in any order, but typo-only matches are intentionally excluded.
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

function allQueryWordsMatch(queryWords, titleWords, allowPrefix) {
    if (!queryWords.length || queryWords.length > titleWords.length) return false;
    if (!allowPrefix) {
        const counts = new Map();
        for (const word of titleWords) counts.set(word, (counts.get(word) || 0) + 1);
        for (const word of queryWords) {
            if (!counts.get(word)) return false;
            counts.set(word, counts.get(word) - 1);
        }
        return true;
    }
    // Prefix-match sets are nested or disjoint. Assign the longest prefixes
    // first: a shorter prefix cannot need a more specific match in preference.
    const used = new Set();
    for (const word of [...queryWords].sort((a, b) => b.length - a.length)) {
        const index = titleWords.findIndex((title, i) => !used.has(i) && title.startsWith(word));
        if (index < 0) return false;
        used.add(index);
    }
    return true;
}

function createNormalizedSearchScorer(q) {
    if (!q) return () => 0;
    const queryWords = q.split(' ').filter(Boolean);

    return function scoreNormalizedTitle(text, preparedTitleWords) {
        if (!text) return 0;
        if (text === q) return 1000;
        if (text.startsWith(q + ' ')) return 900;

        // Boundaries are spaces because normalization converts other punctuation
        // into spaces. This gives whole-word phrases priority over substrings such
        // as "time" inside "lifetime".
        if ((' ' + text + ' ').includes(' ' + q + ' ')) return 800;

        const titleWords = preparedTitleWords || text.split(' ').filter(Boolean);
        if (allQueryWordsMatch(queryWords, titleWords, false)) return 700;
        if (allQueryWordsMatch(queryWords, titleWords, true)) return 600;

        // Keep substring matching as a last-resort recall tier, below whole words.
        if (text.includes(q)) return 300;
        return 0;
    };
}

function createNormalizedSearchMatcher(q) {
    const score = createNormalizedSearchScorer(q);
    return (text, preparedTitleWords) => score(text, preparedTitleWords) > 0;
}

function matchesNormalizedSearchText(q, text) {
    return createNormalizedSearchMatcher(q)(text);
}

function estimateDetailCacheBytes(value) {
    if (!value) return 1;
    let bytes = 4096 + String(value.description || '').length * 2 + String(value.name || '').length * 2;
    for (const video of value.videos || []) bytes += 600 +
        [video.title, video.overview, video.thumbnail, video.released].reduce((n, text) => n + String(text || '').length * 2, 0);
    return bytes;
}

function makeLogger() {
    return createLogger(() => requestContext.current().debug === true);
}

function parsePositiveInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed >= min
        ? Math.min(parsed, max)
        : fallback;
}
const CACHE_TTL_MS = parsePositiveInteger(process.env.CACHE_TTL_MS, 6 * 3600 * 1000, 1000, 30 * 24 * 3600 * 1000);
const MAX_CACHE_ENTRIES = parsePositiveInteger(process.env.MAX_CACHE_ENTRIES, 10, 1, 500);
const CACHE_MEMORY_MAX_BYTES = parsePositiveInteger(process.env.CACHE_MEMORY_MAX_BYTES, 256 * 1024 * 1024, 16 * 1024 * 1024, 4 * 1024 * 1024 * 1024);
const PROVIDER_REMOVAL_GUARD_MIN_ITEMS = parsePositiveInteger(
    process.env.PROVIDER_REMOVAL_GUARD_MIN_ITEMS, 10, 1, 1000000
);
const PROVIDER_REMOVAL_GUARD_PERCENT = parsePositiveInteger(
    process.env.PROVIDER_REMOVAL_GUARD_PERCENT, 25, 1, 100
);

function getSectionRemovalStats(previousItems, currentItems) {
    const previousById = new Map(
        (Array.isArray(previousItems) ? previousItems : [])
            .filter(item => item && item.id != null)
            .map(item => [String(item.id), item])
    );
    const currentIds = new Set(
        (Array.isArray(currentItems) ? currentItems : [])
            .filter(item => item && item.id != null)
            .map(item => String(item.id))
    );
    const removedItems = [...previousById.entries()]
        .filter(([id]) => !currentIds.has(id))
        .map(([, item]) => item);
    const previousCount = previousById.size;
    const removedCount = removedItems.length;
    const removedPercent = previousCount ? (removedCount / previousCount) * 100 : 0;
    const largeDrop =
        (removedCount >= PROVIDER_REMOVAL_GUARD_MIN_ITEMS &&
            removedPercent >= PROVIDER_REMOVAL_GUARD_PERCENT) ||
        (removedCount >= 5 && removedPercent >= 50);

    return {
        removedItems,
        previousCount,
        currentCount: currentIds.size,
        removedCount,
        removedPercent,
        largeDrop
    };
}

function getProviderSeriesKey(item) {
    return String(item?.series_id || item?.id?.replace(/^iptv_series_/, '') || '');
}

function estimateProviderCacheBytes(entry) {
    if (!entry || typeof entry !== 'object') return 1;
    const catalogueCount = ['channels', 'movies', 'series'].reduce(
        (total, key) => total + (Array.isArray(entry[key]) ? entry[key].length : 0), 0
    );
    const epgProgrammeCount = Object.values(entry.epgData || {}).reduce(
        (total, programmes) => total + (Array.isArray(programmes) ? programmes.length : 0), 0
    );
    const directEpisodeCount = Object.values(entry.directSeriesEpisodes || {}).reduce(
        (total, episodes) => total + (Array.isArray(episodes) ? episodes.length : 0), 0
    );
    return 2 * 1024 * 1024 + catalogueCount * 1200 + epgProgrammeCount * 320 + directEpisodeCount * 600;
}

const dataCache = new LRUCache({
    max: MAX_CACHE_ENTRIES,
    ttl: CACHE_TTL_MS,
    maxWeight: CACHE_MEMORY_MAX_BYTES,
    sizeOf: estimateProviderCacheBytes
});
const buildPromiseCache = new Map();
const addonInterfaceInstances = new WeakMap();
const liveInterfaces = new Set();
const addonDisposals = new Map();

// Multiple configuration tokens can create separate addon instances for the same
// provider account. Keep refresh timestamps and scheduled jobs shared by provider
// cache key so those instances do not repeatedly refresh from stale local clocks.
const providerRefreshState = new Map();
const providerRefreshInFlight = new Map();

async function redisGetJSON(key) {
    if (!redisClient) return null;
    try {
        const raw = await withTimeout(redisClient.get(key), 1000, 'Redis read timed out');
        if (!raw) return null;
        return JSON.parse(raw);
    } catch { return null; }
}
async function redisSetJSON(key, value, ttl) {
    if (!redisClient) return;
    try {
        await withTimeout(redisClient.set(key, JSON.stringify(value), 'PX', ttl), 1000, 'Redis write timed out');
    } catch { /* ignore */ }
}

function stableStringify(obj) {
    // This cache-key input is deliberately a flat object with a fixed property order.
    return JSON.stringify(obj);
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

function createInterfaceKey(config) {
    // Debug verbosity changes logging only. Equivalent provider configurations
    // must share one addon instance and one persistent-cache writer.
    return createCacheKey(config);
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
        this.disposed = false;
        this.disposePromise = null;
        this.activeRequestCount = 0;
        this.activeRequestDrainPromise = null;
        this.activeRequestDrainResolve = null;
        this.pendingRemovalCandidates = {};
        this.persistentAddonDataCache = new PersistentAddonDataCache(this.cacheKey);
        this.persistentSeriesInfoCache = new PersistentSeriesInfoCache(this.cacheKey);
        this.updateInterval = parsePositiveInteger(process.env.DATA_REFRESH_INTERVAL_MS, 12 * 60 * 60 * 1000, 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
        this.channels = []; // live TV
        this.movies = [];   // VOD movies
        this.series = [];   // Series (shows)
        // Bound lazily loaded episode metadata so browsing many series cannot grow
        // this addon instance's memory without limit.
        this.seriesInfoCache = new LRUCache({ max: 100, ttl: CACHE_TTL_MS });
        // Episode IDs resolve through a bounded cache instead of scanning opened series.
        this.seriesEpisodeCache = new Map();
        this.seriesEpisodeCacheMax = parsePositiveInteger(
            process.env.SERIES_EPISODE_CACHE_MAX, 50000, 1000, 200000
        );
        // Coalesce on-demand provider detail lookups for the same title.
        this.providerInfoInFlight = new Map();
        // Cached catalogue enrichment lets later home/search requests return
        // rich cards without waiting on TMDb/Xtream for every item.
        this.catalogMetaCache = new LRUCache({
            max: parsePositiveInteger(process.env.CATALOG_META_CACHE_MAX, 1000, 50, 5000),
            ttl: parsePositiveInteger(process.env.CATALOG_META_MEMORY_TTL_MS, 6 * 3600 * 1000, 1000, 30 * 24 * 3600 * 1000)
        });
        this.detailCache = new LRUCache({ max: 50, ttl: 5 * 60 * 1000, maxWeight: 16 * 1024 * 1024,
            sizeOf: entry => estimateDetailCacheBytes(entry.value) });
        this.detailInFlight = new Map();
        this.catalogMetadataRevisions = new Map();
        this.catalogDetailsAvailableAt = new Map();
        this.epgResponseCache = new LRUCache({ max: 12, ttl: 300000 });
        this.persistentCatalogMetaCache = new PersistentCatalogMetaCache(this.cacheKey);
        this.catalogMetaStaleFallbacks = new Set();
        // At most one full-catalogue warm-up per media type. Search requests must not
        // spawn independent background walks over different filtered result sets.
        this.catalogPrefetchJobs = new Map();
        this.catalogPrefetchLastCompleted = new Map();
        this.catalogPrefetchNextCheckAt = new Map();
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
        this.seriesRuntimeInFlight = new Map();
        // Track asynchronous disk writes so a completed pre-warm can flush every
        // metadata preview before its durable completion marker is written.
        this.catalogMetaPersistWrites = new Set();

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
        this.lastEpgUpdate = 0;
        this.epgRetentionStatus = null;
        this.epgRefreshAttemptedAt = 0;
        this.providerRefreshRetryAfter = 0;
        this.log = makeLogger();

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

    }

    estimateMemoryBytes() {
        const catalogueCount = this.channels.length + this.movies.length + this.series.length;
        const epgProgrammeCount = Object.values(this.epgData || {}).reduce(
            (total, programmes) => total + (Array.isArray(programmes) ? programmes.length : 0), 0
        );
        const directEpisodeCount = this.directSeriesEpisodeById.size;
        const seriesDetailVideoCount = this.persistentSeriesInfoCache.entries.size
            ? [...this.persistentSeriesInfoCache.entries.values()].reduce(
                (total, entry) => total + (entry.value?.videos?.length || 0), 0
            )
            : 0;
        // The Xtream detail map is lazy-loaded after interface construction. Reserve
        // a conservative allowance for its configured entry capacity in advance.
        const seriesDetailVideoCapacity = this.providerName === 'xtream'
            ? this.persistentSeriesInfoCache.maxEntries * 10
            : 0;
        const metadataCapacity = Math.max(
            this.persistentCatalogMetaCache.entries.size,
            this.movies.length + this.series.length
        );
        // Reserve the bounded detail/guide caches and opened-series enrichment.
        return (4 + 16 + 12 + (this.providerName === 'xtream' ? 50 : 0)) * 1024 * 1024 +
            metadataCapacity * 3000 +
            catalogueCount * 1200 + epgProgrammeCount * 320 +
            directEpisodeCount * 600 + Math.max(seriesDetailVideoCount, seriesDetailVideoCapacity) * 500;
    }

    acquireRequest() {
        if (this.disposed) return false;
        this.activeRequestCount++;
        return true;
    }

    releaseRequest() {
        this.activeRequestCount = Math.max(0, this.activeRequestCount - 1);
        if (this.disposed && this.activeRequestCount === 0 && this.activeRequestDrainResolve) {
            this.activeRequestDrainResolve();
            this.activeRequestDrainResolve = null;
            this.activeRequestDrainPromise = null;
        }
    }

    async flushPersistentStores() {
        const stores = [
            ['provider snapshot', this.persistentAddonDataCache],
            ['catalogue metadata', this.persistentCatalogMetaCache],
            ['series details', this.persistentSeriesInfoCache]
        ];
        const results = await Promise.allSettled(stores.map(([, cache]) => Promise.resolve().then(() => cache.flush())));
        const failures = results.flatMap((result, index) => result.status === 'rejected'
            ? [{ cache: stores[index][0], reason: result.reason }] : []);
        if (failures.length) {
            const error = new AggregateError(failures.map(failure => failure.reason), 'Persistent cache flush failed');
            error.failedCaches = failures.map(failure => failure.cache);
            throw error;
        }
    }

    async dispose() {
        if (this.disposePromise) return this.disposePromise;
        this.disposed = true;
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
        this.disposePromise = (async () => {
            // Save completed work immediately; the final flush still follows draining.
            // Slow upstream work must not hold every dirty cache buffer hostage.
            await this.flushPersistentStores().catch(() => {});
            if (this.activeRequestCount > 0) {
                this.activeRequestDrainPromise = new Promise(resolve => {
                    this.activeRequestDrainResolve = resolve;
                });
                await this.activeRequestDrainPromise;
            }
            await Promise.allSettled([...this.detailInFlight.values()]);
            const refresh = providerRefreshInFlight.get(this.cacheKey);
            if (refresh) await Promise.allSettled([refresh]);
            const jobs = [...this.catalogPrefetchJobs.values()];
            await Promise.allSettled(jobs);
            while (this.catalogMetaPersistWrites.size) {
                await Promise.allSettled([...this.catalogMetaPersistWrites]);
            }
            let flushError;
            try { await this.flushPersistentStores(); } catch (error) { flushError = error; }
            providerRefreshState.delete(this.cacheKey);
            if (typeof this.releasePersistentCacheRegistration === "function") {
                this.releasePersistentCacheRegistration();
                this.releasePersistentCacheRegistration = null;
            }
            if (flushError) throw flushError;
        })();
        return this.disposePromise;
    }
    async loadFromCache() {
        const cacheKey = 'addon:data:' + this.cacheKey;
        // CACHE_ENABLED controls the in-memory/Redis layers only. A configured
        // persistent snapshot must still be loaded when those layers are disabled,
        // otherwise a saved last-good catalogue would be ignored on every restart.
        let cached = CACHE_ENABLED ? dataCache.get(cacheKey) : null;
        if (!cached) {
            cached = await this.persistentAddonDataCache.load();
            if (cached) {
                if (CACHE_ENABLED) dataCache.set(cacheKey, cached);
            }
        }
        if (CACHE_ENABLED && !cached && redisClient) {
            cached = await redisGetJSON(cacheKey);
            if (cached) dataCache.set(cacheKey, cached);
        }
        if (cached) {
            this.channels = cached.channels || [];
            this.movies = cached.movies || [];
            this.series = cached.series || [];
            this.epgData = cached.epgData || {};
            this.epgRetentionStatus = cached.epgRetentionStatus && typeof cached.epgRetentionStatus === 'object'
                ? cached.epgRetentionStatus : null;
            this.lastUpdate = cached.lastUpdate || 0;
            this.lastEpgUpdate = cached.lastEpgUpdate === undefined
                ? (Object.values(this.epgData).some(programmes => Array.isArray(programmes) && programmes.length)
                    ? this.lastUpdate : 0)
                : Number(cached.lastEpgUpdate) || 0;
            this.epgRefreshAttemptedAt = Number(cached.epgRefreshAttemptedAt) || 0;
            this.providerRefreshRetryAfter = Number(cached.providerRefreshRetryAfter) || 0;
            this.pendingRemovalCandidates = cached.pendingRemovalCandidates && typeof cached.pendingRemovalCandidates === 'object'
                ? cached.pendingRemovalCandidates : {};

            // Direct-M3U episode URLs and IDs are not derivable from the series
            // summaries alone, so persist and restore the episode lists themselves.
            if (this.providerName === 'direct' || this.config.xtreamUseM3U) {
                const savedEpisodes = cached.directSeriesEpisodes;
                if (savedEpisodes && typeof savedEpisodes === 'object' && !Array.isArray(savedEpisodes)) {
                    const episodesMap = new Map(
                        Object.entries(savedEpisodes)
                            .filter(([, episodes]) => Array.isArray(episodes))
                            .map(([seriesHash, episodes]) => [`iptv_series_${seriesHash}`, episodes])
                    );
                    require('./src/js/providers/directProvider.js')
                        .rebuildDirectEpisodeIndexes(this, episodesMap);
                }

                // A present but partial/corrupt map also needs a one-time rebuild.
                const missingSeriesIndexes = this.series.filter(item =>
                    !this.directSeriesEpisodeIndex.has(getProviderSeriesKey(item))
                ).length;
                if (this.series.length && missingSeriesIndexes > 0) {
                    this.lastUpdate = 0;
                    this.log.debug('Direct-M3U episode index is incomplete; rebuilding it', {
                        missingSeriesIndexes,
                        totalSeries: this.series.length
                    });
                }
            }

            const sharedLastUpdate = providerRefreshState.get(this.cacheKey) || 0;
            providerRefreshState.set(this.cacheKey, Math.max(sharedLastUpdate, Number(this.lastUpdate) || 0));
            this.log.info('Loaded saved provider catalogue and EPG', {
                channels: this.channels.length,
                movies: this.movies.length,
                series: this.series.length,
                epgChannels: Object.keys(this.epgData).length,
                ...(this.epgRetentionStatus?.truncated ? { guideLimited: true } : {}),
                lastUpdate: this.lastUpdate ? new Date(this.lastUpdate).toISOString() : null
            });
        }
    }

    providerSnapshot() {
        return {
            channels: this.channels,
            movies: this.movies,
            series: this.series,
            epgData: this.epgData,
            epgRetentionStatus: this.epgRetentionStatus,
            lastUpdate: this.lastUpdate,
            lastEpgUpdate: this.lastEpgUpdate,
            epgRefreshAttemptedAt: this.epgRefreshAttemptedAt,
            providerRefreshRetryAfter: this.providerRefreshRetryAfter,
            directSeriesEpisodes: Object.fromEntries(this.directSeriesEpisodeIndex.entries()),
            pendingRemovalCandidates: this.pendingRemovalCandidates
        };
    }

    async persistProviderSnapshot() {
        if (CACHE_ENABLED) return this.saveToCache();
        try {
            await this.persistentAddonDataCache.save(this.providerSnapshot());
        } catch (error) {
            this.log.warn('Persistent provider data save failed', { name: error?.name || 'Error', code: error?.code || 'UNKNOWN' });
        }
    }

    async saveToCache() {
        if (!CACHE_ENABLED) return;
        const cacheKey = 'addon:data:' + this.cacheKey;
        const entry = this.providerSnapshot();
        dataCache.set(cacheKey, entry);
        try {
            await this.persistentAddonDataCache.save(entry);
        } catch (error) {
            // The in-memory/Redis copy remains usable; a disk write failure must not
            // interrupt a successful provider refresh or replace the last-good file.
            this.log.warn('Persistent provider data save failed', {
                name: error?.name || 'Error', code: error?.code || 'UNKNOWN',
                syscall: error?.syscall || null, message: String(error?.message || 'No error message').slice(0, 300)
            });
        }
        await redisSetJSON(cacheKey, entry, CACHE_TTL_MS);
    }

    buildGenresInManifest() {
        if (!this.manifestRef) return;
        const tvCatalog = this.manifestRef.catalogs.find(c => c.id === 'iptv_channels');
        const movieCatalog = this.manifestRef.catalogs.find(c => c.id === 'iptv_movies');
        const seriesCatalog = this.manifestRef.catalogs.find(c => c.id === 'iptv_series');

        // Genre options are first installed after the SDK build, which limits
        // manifest size. Subsequent refreshes must keep those options in sync.
        // Keep first-seen order so groups follow the provider's ordering.
        function setGenresOnCatalog(catalog, groups) {
            if (!catalog) return;
            catalog.genres = groups;
            const genreExtra = Array.isArray(catalog.extra)
                ? catalog.extra.find(extra => extra.name === 'genre') : null;
            if (genreExtra && Object.prototype.hasOwnProperty.call(genreExtra, 'options')) {
                genreExtra.options = [...groups];
            }
        }

        function getGenres(items) {
            const normalize = value => {
                if (typeof value === 'string') return value.trim();
                if (typeof value === 'number' && Number.isFinite(value)) return String(value);
                return '';
            };
            return [...new Set((Array.isArray(items) ? items : [])
                .map(item => normalize(item?.category) || normalize(item?.attributes?.['group-title']))
                .filter(Boolean))];
        }

        if (tvCatalog) {
            const groups = getGenres(this.channels);
            if (!groups.includes('All Channels')) groups.unshift('All Channels');
            setGenresOnCatalog(tvCatalog, groups);
        }

        if (movieCatalog) {
            const movieGroups = getGenres(this.movies);
            setGenresOnCatalog(movieCatalog, movieGroups);
        }

        if (seriesCatalog) {
            const seriesGroups = getGenres(this.series);
            setGenresOnCatalog(seriesCatalog, seriesGroups);
        }

        // The SDK freezes the manifest root after startup. Its nested hints
        // object stays shared with the served interface, so update it in place.
        if (!this.manifestRef.behaviorHints) this.manifestRef.behaviorHints = {};
        this.manifestRef.behaviorHints.epgProvider = Object.values(this.epgData || {}).some(
            programmes => Array.isArray(programmes) && programmes.length > 0
        );
    }

    parseM3U(content) {
        return m3uParser.parseM3U(content).map(item => ({ ...item,
            id: 'iptv_' + crypto.createHash('md5').update(item.name + item.url).digest('hex').substring(0, 16) }));
    }

    parseAttributes(str) {
        return m3uParser.parseAttributes(str);
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
    isProviderSeriesCurrent(seriesId, providerLastUpdate = this.lastUpdate) {
        return !this.disposed && Number(this.lastUpdate || 0) === Number(providerLastUpdate || 0) &&
            this.series.some(item => getProviderSeriesKey(item) === String(seriesId));
    }

    cacheSeriesInfo(seriesId, info, ttl = CACHE_TTL_MS) {
        const owner = String(seriesId);
        this.detailCache.delete('iptv_series_' + owner);
        for (const [id, entry] of this.seriesEpisodeCache) {
            if (entry.seriesId === owner) this.seriesEpisodeCache.delete(id);
        }
        this.seriesInfoCache.set(seriesId, info, ttl);
        if (Array.isArray(info?.videos)) {
            for (const video of info.videos) {
                if (!video?.id || !video.url) continue;
                const id = String(video.id);
                this.seriesEpisodeCache.delete(id);
                this.seriesEpisodeCache.set(id, {
                    video,
                    seriesId: owner,
                    expires: Date.now() + ttl
                });
                while (this.seriesEpisodeCache.size > this.seriesEpisodeCacheMax) {
                    this.seriesEpisodeCache.delete(this.seriesEpisodeCache.keys().next().value);
                }
            }
        }
    }

    async ensureSeriesInfo(seriesId) {
        if (!seriesId) return null;
        const normalizedSeriesId = String(seriesId);
        const providerLastUpdate = Number(this.lastUpdate) || 0;
        const isCurrent = () => this.isProviderSeriesCurrent(normalizedSeriesId, providerLastUpdate);
        if (!isCurrent()) return null;
        const cached = this.seriesInfoCache.get(normalizedSeriesId);
        if (cached !== undefined) return cached;

        const pendingKey = 'series-info:' + providerLastUpdate + ':' + normalizedSeriesId;
        const pending = this.providerInfoInFlight.get(pendingKey);
        if (pending) return pending;

        const task = (async () => {
            const persisted = this.providerName === 'xtream'
                ? await this.persistentSeriesInfoCache.get(normalizedSeriesId, providerLastUpdate)
                : null;
            if (!isCurrent()) return null;
            if (persisted?.fresh) {
                this.cacheSeriesInfo(normalizedSeriesId, persisted.value);
                return persisted.value;
            }
            try {
                const providerModule = require('./src/js/providers/' + this.providerName + 'Provider.js');
                if (typeof providerModule.fetchSeriesInfo === 'function') {
                    const info = await providerModule.fetchSeriesInfo(this, normalizedSeriesId);
                    if (!isCurrent()) return null;
                    // A failed provider request is not a valid empty series.
                    if (info?.fetchError || !Array.isArray(info?.videos)) {
                        if (persisted?.value) {
                            this.cacheSeriesInfo(normalizedSeriesId, persisted.value, SERIES_INFO_FAILURE_RETRY_MS);
                            return persisted.value;
                        }
                        this.log.warn('Series episode list unavailable', { seriesId: normalizedSeriesId });
                        this.cacheSeriesInfo(normalizedSeriesId, info, SERIES_INFO_FAILURE_RETRY_MS);
                        return info;
                    }
                    const item = this.series.find(value => getProviderSeriesKey(value) === normalizedSeriesId);
                    if (persisted?.value?._episodeMetadata &&
                        String(persisted.value._episodeMetadata.tmdbId) === String(item?.tmdbId)) {
                        info._episodeMetadata = persisted.value._episodeMetadata;
                    }
                    this.cacheSeriesInfo(normalizedSeriesId, info);
                    if (this.providerName === 'xtream') {
                        await this.persistentSeriesInfoCache
                            .set(normalizedSeriesId, info, providerLastUpdate, isCurrent)
                            .catch(error => this.log.warn('Persistent series detail save failed:', error?.name || 'Error'));
                    }
                    return isCurrent() ? info : null;
                }
            } catch (error) {
                if (!isCurrent()) return null;
                if (persisted?.value) {
                    this.cacheSeriesInfo(normalizedSeriesId, persisted.value, SERIES_INFO_FAILURE_RETRY_MS);
                    return persisted.value;
                }
            }
            if (!isCurrent()) return null;
            const empty = { videos: [] };
            this.cacheSeriesInfo(normalizedSeriesId, empty, SERIES_INFO_FAILURE_RETRY_MS);
            return empty;
        })();
        this.providerInfoInFlight.set(pendingKey, task);
        try {
            return await task;
        } finally {
            if (this.providerInfoInFlight.get(pendingKey) === task) this.providerInfoInFlight.delete(pendingKey);
        }
    }

    async pruneRemovedCatalogState(previous) {
        this.detailCache.clear(); this.catalogDetailsAvailableAt.clear();
        this.catalogMetadataRevisions.clear();
        this.epgResponseCache.clear(); this.epgResponseSource = this.epgData;
        this.epgResponseGeneration = this.lastUpdate;
        const currentMovieIds = new Set(this.movies.map(item => String(item?.id || '')).filter(Boolean));
        const currentSeriesIds = new Set(this.series.map(item => String(item?.id || '')).filter(Boolean));
        const currentCatalogIds = new Set([...currentMovieIds, ...currentSeriesIds]);
        const currentSeriesKeys = new Set(this.series.map(getProviderSeriesKey).filter(Boolean));

        // A provider may reuse a stable item ID for a different title or TMDb
        // match. Those previews and lookup IDs must not survive that replacement.
        const changedCatalogIds = new Set();
        const changedSeriesKeys = new Set();
        const changedTypes = new Set();
        for (const [type, section] of [['movie', 'movies'], ['series', 'series']]) {
            const oldItems = new Map((previous[section] || []).map(item => [String(item?.id || ''), item]));
            for (const item of this[section]) {
                const oldItem = oldItems.get(String(item?.id || ''));
                if (!oldItem) continue;
                const oldTmdbId = String(oldItem.tmdbId || '').trim();
                const newTmdbId = String(item.tmdbId || '').trim();
                const identityChanged = oldTmdbId && newTmdbId
                    ? oldTmdbId !== newTmdbId
                    : normalizeSearchText(oldItem.name) !== normalizeSearchText(item.name);
                if (identityChanged) {
                    changedCatalogIds.add(String(item.id));
                    changedTypes.add(type);
                    if (type === 'series') {
                        changedSeriesKeys.add(getProviderSeriesKey(item));
                        changedSeriesKeys.add(getProviderSeriesKey(oldItem));
                    }
                }
            }
        }
        // Start series invalidation before yielding, so a detail request for a
        // replaced title cannot read the old episode list during other cleanup.
        const seriesRetention = Promise.resolve(this.persistentSeriesInfoCache.retainSeries(currentSeriesKeys, {
            invalidatedSeriesIds: changedSeriesKeys,
            providerLastUpdate: this.lastUpdate
        })).catch(error => {
            this.log.warn('Could not prune removed persistent series details:', error?.name || 'Error');
        });
        const persistentInvalidations = [];
        for (const id of changedCatalogIds) {
            persistentInvalidations.push(this.persistentCatalogMetaCache.delete(id));
        }
        for (const type of changedTypes) {
            this.catalogPrefetchLastCompleted.delete(type);
            this.catalogPrefetchNextCheckAt.delete(type);
            this.catalogPrefetchLastFingerprint.delete(type);
            this.catalogPrefetchRetryAfter.delete(type);
            persistentInvalidations.push(this.persistentCatalogMetaCache.delete('__catalog_prefetch_status__:' + type));
        }
        for (const item of previous.movies || []) {
            const id = String(item?.id || '');
            if (!currentMovieIds.has(id) || changedCatalogIds.has(id)) {
                this.seriesInfoCache.delete('movie-tmdb:' + id);
                this.seriesInfoCache.delete('movie-tmdb-miss:' + id);
            }
        }
        if (changedCatalogIds.size) {
            this.log.info('Invalidated metadata for changed provider titles', { items: changedCatalogIds.size });
        }

        // EPG programme groups are keyed by XMLTV channel ID/name. Drop groups
        // that belonged to the old channel list only when no current channel uses
        // that key; clone first so a later rollback still has the original guide.
        const currentEpgIds = new Set(this.channels.map(item =>
            String(item?.attributes?.['tvg-id'] || item?.attributes?.['tvg-name'] || '')
        ).filter(Boolean));
        const removedEpgIds = new Set((Array.isArray(previous.channels) ? previous.channels : [])
            .map(item => String(item?.attributes?.['tvg-id'] || item?.attributes?.['tvg-name'] || ''))
            .filter(id => id && !currentEpgIds.has(id)));
        const orphanedEpgIds = [...removedEpgIds].filter(id =>
            Object.prototype.hasOwnProperty.call(this.epgData || {}, id)
        );
        if (orphanedEpgIds.length) {
            this.epgData = { ...(this.epgData || {}) };
            for (const id of orphanedEpgIds) delete this.epgData[id];
            this.log.info('Removed orphaned EPG channel groups', { count: orphanedEpgIds.length });
        }

        // Remove cached cards for vanished titles so they cannot linger in memory
        // or on disk after an accepted provider deletion.
        for (const id of this.catalogMetaCache.keys()) {
            if (!currentCatalogIds.has(String(id)) || changedCatalogIds.has(String(id))) this.catalogMetaCache.delete(id);
        }
        for (const id of this.catalogMetaStaleFallbacks) {
            if (!currentCatalogIds.has(String(id)) || changedCatalogIds.has(String(id))) this.catalogMetaStaleFallbacks.delete(id);
        }
        // Provider refreshes may add or remove episodes for an existing series.
        // Refresh details on the next open, while retaining playable mappings for
        // unchanged series whose pages may already be open in Stremio.
        for (const [id, entry] of this.seriesEpisodeCache) {
            if (!entry.seriesId || !currentSeriesKeys.has(entry.seriesId) || changedSeriesKeys.has(entry.seriesId)) {
                this.seriesEpisodeCache.delete(id);
            }
        }
        const seriesKeysToInvalidate = new Set([
            ...(Array.isArray(previous.series) ? previous.series : []).map(getProviderSeriesKey),
            ...this.series.map(getProviderSeriesKey)
        ].filter(Boolean));
        for (const seriesKey of seriesKeysToInvalidate) {
            this.seriesInfoCache.delete(seriesKey);
        }

        try {
            await Promise.all(persistentInvalidations);
            await this.persistentCatalogMetaCache.retainCatalogItems(currentCatalogIds);
            await this.persistentCatalogMetaCache.flush();
        } catch (error) {
            this.log.warn('Could not prune removed catalogue metadata:', error?.name || 'Error');
        }

        try {
            await seriesRetention;
            await this.persistentSeriesInfoCache.flush();
        } catch (error) {
            this.log.warn('Could not prune removed persistent series details:', error?.name || 'Error');
        }
    }

    async updateData(force = false) {
        const inFlight = providerRefreshInFlight.get(this.cacheKey);
        if (inFlight) {
            await inFlight;
            const sharedLastUpdate = providerRefreshState.get(this.cacheKey) || 0;
            if (sharedLastUpdate > this.lastUpdate) await this.loadFromCache();
            return;
        }

        const sharedLastUpdate = providerRefreshState.get(this.cacheKey) || 0;
        if (sharedLastUpdate > this.lastUpdate) await this.loadFromCache();

        const refreshPromise = (async () => {
            await this._updateData(force);
            await this._updateEpg();
        })();
        providerRefreshInFlight.set(this.cacheKey, refreshPromise);
        try {
            await refreshPromise;
        } finally {
            if (providerRefreshInFlight.get(this.cacheKey) === refreshPromise) {
                providerRefreshInFlight.delete(this.cacheKey);
            }
        }
    }

    isEpgRefreshDue() {
        if (!this.config.enableEpg || this.disposed) return false;
        const normalDue = this.lastEpgUpdate ? this.lastEpgUpdate + this.updateInterval : 0;
        const retryDue = this.epgRefreshAttemptedAt > this.lastEpgUpdate
            ? this.epgRefreshAttemptedAt + EPG_REFRESH_RETRY_MS : 0;
        return Date.now() >= Math.max(normalDue, retryDue);
    }

    async _updateEpg() {
        if (!this.isEpgRefreshDue()) return;
        const provider = require('./src/js/providers/' + this.providerName + 'Provider.js');
        if (typeof provider.fetchEpg !== 'function') return;
        const generation = this.lastUpdate;
        const startedAt = Date.now();
        const previousGuide = this.epgData;
        const previousRetentionStatus = this.epgRetentionStatus;
        const previousSuccess = this.lastEpgUpdate;
        let acceptedPartial = false;
        const staged = Object.assign(Object.create(this), { epgData: {}, epgRefreshFailed: false });
        this.epgRefreshAttemptedAt = startedAt;
        try {
            await provider.fetchEpg(staged);
            if (this.disposed || this.lastUpdate !== generation) return;
            const hasProgrammes = Object.values(staged.epgData || {}).some(items => Array.isArray(items) && items.length);
            if (staged.epgRefreshFailed || !hasProgrammes) {
                const hadGuide = Object.values(this.epgData).some(items => Array.isArray(items) && items.length);
                if (!hadGuide && hasProgrammes) {
                    this.epgData = staged.epgData;
                    this.epgRetentionStatus = staged.epgRetentionStatus || null;
                    this.buildGenresInManifest();
                    acceptedPartial = true;
                }
                throw new Error('Guide unavailable');
            }
            this.epgData = staged.epgData;
            this.epgRetentionStatus = staged.epgRetentionStatus || null;
            this.buildGenresInManifest();
            this.lastEpgUpdate = Math.max(Date.now(), startedAt);
            this.epgRefreshAttemptedAt = this.lastEpgUpdate;
            this.log.info('EPG refresh complete', {
                epgChannels: Object.keys(this.epgData).length,
                ...(this.epgRetentionStatus?.truncated ? { guideLimited: true } : {}),
                epgProgrammes: Object.values(this.epgData).reduce((total, programmes) => total + programmes.length, 0),
                durationMs: Date.now() - startedAt
            });
        } catch (error) {
            if (this.disposed || this.lastUpdate !== generation) return;
            if (!acceptedPartial) {
                this.epgData = previousGuide;
                this.epgRetentionStatus = previousRetentionStatus;
                this.lastEpgUpdate = previousSuccess;
            }
            this.log.warn('EPG refresh failed; retaining saved guide', { retryDelay: EPG_REFRESH_RETRY_MS });
        }
        if (!this.disposed && this.lastUpdate === generation) {
            this.epgResponseCache.clear(); this.epgResponseSource = this.epgData;
            this.epgResponseGeneration = this.lastUpdate;
            await this.persistProviderSnapshot();
        }
    }

    async _updateData(force = false) {
        const now = Date.now();
        if (this.disposed || now < this.providerRefreshRetryAfter) return;
        if (!force && this.lastUpdate && now - this.lastUpdate < this.updateInterval) return;
        const previous = {
            channels: this.channels, movies: this.movies, series: this.series,
            epgData: this.epgData, lastUpdate: this.lastUpdate,
            epgRetentionStatus: this.epgRetentionStatus,
            lastEpgUpdate: this.lastEpgUpdate, epgRefreshAttemptedAt: this.epgRefreshAttemptedAt,
            directSeriesEpisodeIndex: this.directSeriesEpisodeIndex,
            directSeriesEpisodeById: this.directSeriesEpisodeById,
            pendingRemovalCandidates: this.pendingRemovalCandidates
        };
        const skipEpg = !this.isEpgRefreshDue();
        const refreshed = Object.assign(Object.create(this), {
            channels: [], movies: [], series: this.config.includeSeries === false ? previous.series : [],
            epgData: skipEpg ? previous.epgData : {}, epgRefreshFailed: false,
            directSeriesEpisodeIndex: new Map(), directSeriesEpisodeById: new Map()
        });

        try {
            const start = Date.now();
            const provider = require('./src/js/providers/' + this.providerName + 'Provider.js');
            await provider.fetchData(refreshed, { skipEpg });
            if (this.disposed) return;
            const guideAttemptAt = !skipEpg && this.config.enableEpg ? Date.now() : previous.epgRefreshAttemptedAt;
            const removalCandidates = { ...(previous.pendingRemovalCandidates || {}) };
            const unconfirmedDrops = [];
            const confirmationsRequired = parsePositiveInteger(process.env.PROVIDER_REMOVAL_CONFIRMATIONS, 2, 2, 5);
            for (const section of ['channels', 'movies', 'series']) {
                const stats = getSectionRemovalStats(previous[section], refreshed[section]);
                if (stats.largeDrop || (stats.previousCount > 0 && stats.currentCount === 0)) {
                    const ids = refreshed[section].map(item => String(item.id)).sort();
                    const fingerprint = crypto.createHash('sha256').update(ids.join('\n')).digest('hex');
                    const prior = removalCandidates[section];
                    const same = prior?.fingerprint === fingerprint;
                    const sufficientlySeparated = same && Date.now() - (Number(prior.observedAt) || 0) >= PROVIDER_REFRESH_RETRY_MS;
                    const confirmations = same
                        ? Math.min(confirmationsRequired, (Number(prior.confirmations) || 1) + (sufficientlySeparated ? 1 : 0)) : 1;
                    removalCandidates[section] = {
                        fingerprint, confirmations, observedAt: same && !sufficientlySeparated ? prior.observedAt : Date.now()
                    };
                    if (confirmations < confirmationsRequired) unconfirmedDrops.push({
                        section, removedCount: stats.removedCount, previousCount: stats.previousCount,
                        currentCount: stats.currentCount, removedPercent: Number(stats.removedPercent.toFixed(1))
                    });
                } else {
                    delete removalCandidates[section];
                }
            }

            if (unconfirmedDrops.length) {
                this.pendingRemovalCandidates = removalCandidates;
                this.providerRefreshRetryAfter = Date.now() + PROVIDER_REFRESH_RETRY_MS;
                this.epgRefreshAttemptedAt = guideAttemptAt;
                this.log.warn('Provider catalogue reduction awaits a later matching refresh', {
                    sections: unconfirmedDrops, requiredMatchingRefreshes: confirmationsRequired,
                    retryDelay: PROVIDER_REFRESH_RETRY_MS
                });
                await this.persistProviderSnapshot();
                return;
            }

            const hasNewGuide = Object.values(refreshed.epgData || {}).some(items => Array.isArray(items) && items.length);
            const hadGuide = Object.values(previous.epgData || {}).some(items => Array.isArray(items) && items.length);
            const guideSucceeded = !skipEpg && this.config.enableEpg && !refreshed.epgRefreshFailed && hasNewGuide;
            if (skipEpg) {
                refreshed.epgData = previous.epgData;
                refreshed.epgRetentionStatus = previous.epgRetentionStatus;
            }
            else if (this.config.enableEpg && !guideSucceeded) {
                if (hadGuide) {
                    refreshed.epgData = previous.epgData;
                    refreshed.epgRetentionStatus = previous.epgRetentionStatus;
                }
                this.log.warn('EPG refresh incomplete; retaining available guide', { retryDelay: EPG_REFRESH_RETRY_MS });
            }

            if (previous.channels.length + previous.movies.length + previous.series.length > 0 &&
                refreshed.channels.length + refreshed.movies.length + refreshed.series.length === 0) {
                throw new Error('Provider refresh returned an empty catalogue');
            }
            for (const section of ['channels', 'movies', 'series']) {
                const stats = getSectionRemovalStats(previous[section], refreshed[section]);
                if (stats.removedCount) this.log.info('Provider catalogue items removed', {
                    section, removedCount: stats.removedCount, previousCount: stats.previousCount, currentCount: stats.currentCount
                });
            }

            this.channels = refreshed.channels; this.movies = refreshed.movies; this.series = refreshed.series;
            this.epgData = refreshed.epgData;
            this.epgRetentionStatus = refreshed.epgRetentionStatus || null;
            this.directSeriesEpisodeIndex = refreshed.directSeriesEpisodeIndex;
            this.directSeriesEpisodeById = refreshed.directSeriesEpisodeById;
            this.pendingRemovalCandidates = {};
            this.lastUpdate = Math.max(Date.now(), (Number(previous.lastUpdate) || 0) + 1);
            this.providerRefreshRetryAfter = 0;
            this.epgRefreshAttemptedAt = guideSucceeded ? this.lastUpdate : guideAttemptAt;
            this.lastEpgUpdate = guideSucceeded ? this.lastUpdate : previous.lastEpgUpdate;
            providerRefreshState.set(this.cacheKey, this.lastUpdate);

            this.buildGenresInManifest();
            await this.pruneRemovedCatalogState(previous);
            await this.persistProviderSnapshot();
            this.log.info('Provider data refresh complete', {
                channels: this.channels.length, movies: this.movies.length, series: this.series.length,
                epgChannels: Object.keys(this.epgData).length,
                ...(this.epgRetentionStatus?.truncated ? { guideLimited: true } : {}),
                epgProgrammes: Object.values(this.epgData).reduce((total, programmes) => total + programmes.length, 0),
                durationMs: Date.now() - start
            });
        } catch (error) {
            Object.assign(this, previous);
            this.providerRefreshRetryAfter = Date.now() + PROVIDER_REFRESH_RETRY_MS;
            providerRefreshState.set(this.cacheKey, previous.lastUpdate || 0);
            this.log.error('[UPDATE] Failed; retaining last-known-good data:', {
                name: error?.name || 'Error',
                message: String(error?.message || 'No error message')
                    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted URL]')
                    .replace(/((?:username|password|token|api[_-]?key)=)[^&\s]+/gi, '$1[redacted]').slice(0, 240),
                code: typeof error?.code === 'string' ? error.code : null
            });
            await this.persistProviderSnapshot();
        }
    }
    startConfiguredCatalogPrefetch() {
        if (this.disposed || (process.env.CATALOG_PREFETCH_NEXT_PAGE || 'true').toLowerCase() === 'false') return;
        const pageSize = parsePositiveInteger(process.env.CATALOG_PAGE_SIZE, 50, 10, 100);
        const concurrency = parsePositiveInteger(process.env.CATALOG_PREFETCH_CONCURRENCY, 3, 1, 6);
        this.startContinuousCatalogPrefetch('movie', pageSize, concurrency);
        if (this.config.includeSeries !== false) this.startContinuousCatalogPrefetch('series', pageSize, concurrency);
    }

    startScheduledRefresh() {
        if (this.refreshTimer || this.disposed) return;
        const refreshCheckInterval = parsePositiveInteger(
            process.env.DATA_REFRESH_CHECK_INTERVAL_MS, 60 * 60 * 1000,
            5 * 60 * 1000, 6 * 60 * 60 * 1000
        );
        this.refreshTimer = setInterval(() => {
            if (this.scheduledRefreshInFlight || providerRefreshInFlight.has(this.cacheKey)) return;
            const sharedLastUpdate = providerRefreshState.get(this.cacheKey) || 0;
            const lastSuccessfulRefresh = Math.max(Number(this.lastUpdate) || 0, sharedLastUpdate);
            const providerDue = (!lastSuccessfulRefresh || Date.now() - lastSuccessfulRefresh >= this.updateInterval) &&
                Date.now() >= this.providerRefreshRetryAfter;
            if (!providerDue && !this.isEpgRefreshDue()) {
                this.startConfiguredCatalogPrefetch();
                return;
            }
            if (providerDue) this.log.debug('Scheduled provider refresh is due', {
                lastSuccessfulRefresh: lastSuccessfulRefresh ? new Date(lastSuccessfulRefresh).toISOString() : null,
                intervalHours: this.updateInterval / (60 * 60 * 1000)
            });
            this.scheduledRefreshInFlight = requestContext.background(() => this.updateData())
                .then(() => this.startConfiguredCatalogPrefetch())
                .catch(error => this.log.warn('Scheduled provider refresh failed', error?.name || 'Error'))
                .finally(() => {
                    this.scheduledRefreshInFlight = null;
                });
        }, refreshCheckInterval);
        if (typeof this.refreshTimer.unref === 'function') this.refreshTimer.unref();
    }

    deriveFallbackLogoUrl(item) {
        const logoAttr = item.attributes?.['tvg-logo'];
        if (logoAttr && logoAttr.trim()) return logoAttr;
        const tvgId = item.attributes?.['tvg-id'] || item.attributes?.['tvg-name'];
        return `logo/${encodeURIComponent(tvgId || item.name || 'Live TV')}.png`;
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

    async getStreamAsync(id) {
        const rememberedOwner = this.seriesEpisodeCache.get(id)?.seriesId;
        const cached = this.getStream(id);
        if (cached || !String(id).startsWith('iptv_series_ep_') || this.providerName !== 'xtream') return cached;
        const owner = rememberedOwner || await this.persistentSeriesInfoCache.findSeriesByEpisodeId?.(id);
        if (!owner || !this.isProviderSeriesCurrent(owner)) return null;
        await this.ensureSeriesInfo(owner);
        return this.getStream(id);
    }

    lookupEpisodeById(epId) {
        // Direct-M3U episodes use the playlist index; Xtream episode details are
        // indexed as series information enters the bounded detail cache.
        const cached = this.seriesEpisodeCache.get(epId);
        if (cached) {
            if (cached.expires > Date.now()) return cached.video;
            this.seriesEpisodeCache.delete(epId);
        }
        return this.directSeriesEpisodeById.get(epId) || null;
    }

    async getDetailOmdbMetadata(imdbId, itemId, providerLastUpdate = this.lastUpdate) {
        if (!imdbId) return null;

        // Check the in-memory catalogue first, then the persistent catalogue cache.
        // This prevents detail opens after a Railway restart from querying OMDb when
        // the enriched rating/runtime are already saved on disk.
        let preview = withoutProviderEpisodeAverage(itemId ? this.catalogMetaCache.get(itemId) : null);
        if (!preview && itemId) {
            const persisted = await this.persistentCatalogMetaCache.get(String(itemId));
            if (persisted?.value && this.isCatalogItemCurrent(String(itemId), providerLastUpdate)) {
                preview = withoutProviderEpisodeAverage(this.catalogMetaCache.get(String(itemId)) || persisted.value);
                this.putCatalogMeta(String(itemId), preview);
            }
        }

        const previewImdbId = String(preview?.imdbId || preview?.imdb_id || '');
        if (preview && previewImdbId === String(imdbId)) {
            if (!omdbMetadataNeedsRefresh(preview)) {
                return {
                    imdbId: preview.imdbId || preview.imdb_id,
                    imdbRating: preview.imdbRating,
                    runtime: preview.runtime,
                    omdbChecked: preview.omdbChecked === true,
                    omdbCheckedAt: preview.omdbCheckedAt
                };
            }

            // Incomplete metadata is retried only after the shared 12-hour interval.
            // A failed/partial refresh keeps any previously saved rating/runtime.
            const refreshed = await omdbMetadata.getByImdbId(imdbId, {
                refreshIncomplete: true, refresh: preview.omdbPending === true
            });
            const latestPreview = withoutProviderEpisodeAverage(this.catalogMetaCache.get(String(itemId)));
            const sameIdentity = (!latestPreview?.imdbId || String(latestPreview.imdbId) === String(imdbId)) &&
                !(preview._tmdbId && latestPreview?._tmdbId &&
                    String(preview._tmdbId) !== String(latestPreview._tmdbId));
            const currentPreview = sameIdentity ? (latestPreview || preview) : preview;
            const result = {
                ...(refreshed || {}),
                imdbId: refreshed?.imdbId || currentPreview.imdbId || currentPreview.imdb_id,
                imdbRating: refreshed?.imdbRating || currentPreview.imdbRating,
                runtime: refreshed?.runtime || currentPreview.runtime,
                omdbChecked: refreshed?.omdbChecked === true || currentPreview.omdbChecked === true,
                omdbCheckedAt: refreshed?.omdbCheckedAt || Date.now()
            };
            // Persist the attempt timestamp as well as the retained values. Without
            // this write, a restart or repeated detail open could retry immediately.
            const updatedPreview = {
                ...currentPreview,
                imdbId: result.imdbId,
                imdbRating: result.imdbRating,
                runtime: result.runtime,
                ...(parseRuntimeMinutes(refreshed?.runtime) !== null ? { runtimeAverage: null } : {}),
                omdbChecked: result.omdbChecked,
                omdbCheckedAt: result.omdbCheckedAt,
                omdbPending: refreshed?.omdbRetryableFailure === true || omdbMetadata.shouldRetryLookup(imdbId)
            };
            // This write updates OMDb fields only. Preserve the catalogue/TMDb
            // refresh timestamp so opening a detail page cannot postpone the next
            // scheduled metadata refresh.
            if (sameIdentity) this.cacheCatalogMetaPreview(String(itemId), updatedPreview, true, providerLastUpdate);
            return result;
        }

        // No matching enriched preview: use the OMDb module cache first, which
        // avoids a request on ordinary opens when this process has seen the title.
        return omdbMetadata.getByImdbId(imdbId);
    }

    async ensureSeriesRuntimeAverage(seriesItem, preview, providerLastUpdate = this.lastUpdate) {
        const id = String(seriesItem?.id || '');
        if (!id || !this.isCatalogItemCurrent(id, providerLastUpdate)) return preview;
        let current = withoutProviderEpisodeAverage(this.catalogMetaCache.get(id) || preview);
        if (catalogMetadataIdentityNextCheckAt(current, seriesItem) <= Date.now()) {
            current = withoutProviderEpisodeAverage(await this.getCatalogMetaAsync(id, 'series') || current);
        }
        if (!this.isCatalogItemCurrent(id, providerLastUpdate)) return null;
        if (current?._tmdbId && seriesItem.tmdbId && String(current._tmdbId) !== String(seriesItem.tmdbId)) {
            // Retain known metadata after an unresolved identity check, and record
            // this runtime attempt rather than repeatedly querying a conflicting ID.
            if (!hasDerivedSeriesRuntime(current) || !seriesRuntimeAverageNeedsRefresh(current)) return current;
            return this.persistCatalogMetaIfCurrent(id, { ...current, runtimeAverage: {
                ...current.runtimeAverage, attemptedAt: Date.now(), attemptPolicyVersion: 1,
                attemptTmdbId: String(seriesItem.tmdbId)
            } }, providerLastUpdate);
        }
        if (!seriesRuntimeAverageNeedsRefresh(current)) return current;
        const key = providerLastUpdate + ':' + id;
        if (this.seriesRuntimeInFlight.has(key)) return this.seriesRuntimeInFlight.get(key);
        const task = (async () => {
            const tmdbId = seriesItem.tmdbId || null;
            const previous = current?.runtimeAverage;
            let result = null;
            try {
                if (tmdbId) {
                    result = await tmdbMetadata.getSeriesRuntimeMetadata(tmdbId, {
                        previous, refresh: Boolean(previous),
                        reuseDetails: this.catalogDetailsAvailableAt.get(id)?.generation === providerLastUpdate &&
                            Date.now() - this.catalogDetailsAvailableAt.get(id).at < 60000,
                        refreshAll: Boolean(previous && (previous.policyVersion !== 1 ||
                            Date.now() - (Number(previous.checkedAt) || 0) >= metadataRefreshInterval()))
                    });
                }
                if (!this.isCatalogItemCurrent(id, providerLastUpdate)) return null;
            } catch {
                // A failed estimate must never erase a previously saved runtime.
            }
            if (!this.isCatalogItemCurrent(id, providerLastUpdate)) return null;
            const latest = withoutProviderEpisodeAverage(this.catalogMetaCache.get(id) || current);
            if (parseRuntimeMinutes(latest.runtime) !== null && !hasDerivedSeriesRuntime(latest)) return latest;
            if (tmdbId && latest._tmdbId && String(tmdbId) !== String(latest._tmdbId)) result = null;
            const now = Date.now();
            let updated;
            if (parseRuntimeMinutes(result?.runtime) !== null && result.complete === true) {
                updated = {
                    ...latest,
                    runtime: result.runtime,
                    runtimeAverage: result.source === 'tmdb-series' ? null : {
                        version: 1, policyVersion: 1, runtime: result.runtime, source: result.source,
                        episodeCount: result.episodeCount, totalMinutes: result.totalMinutes,
                        complete: true, checkedAt: now, attemptedAt: now,
                        tmdbId: tmdbId ? String(tmdbId) : null, providerLastUpdate,
                        ...(Array.isArray(result.seasons) ? { seasons: result.seasons } : {})
                    }
                };
            } else {
                updated = {
                    ...latest,
                    runtimeAverage: {
                        ...(latest.runtimeAverage || {}), version: 1,
                        checkedAt: Number(latest.runtimeAverage?.checkedAt) || 0,
                        attemptedAt: now,
                        attemptPolicyVersion: 1,
                        complete: latest.runtimeAverage?.complete === true,
                        tmdbId: latest.runtimeAverage?.tmdbId || (tmdbId ? String(tmdbId) : null),
                        attemptTmdbId: tmdbId ? String(tmdbId) : null,
                        ...(Array.isArray(result?.seasons) ? { seasons: result.seasons } : {})
                    }
                };
            }
            return this.persistCatalogMetaIfCurrent(id, updated, providerLastUpdate);
        })();
        this.seriesRuntimeInFlight.set(key, task);
        try {
            return await task;
        } finally {
            if (this.seriesRuntimeInFlight.get(key) === task) this.seriesRuntimeInFlight.delete(key);
        }
    }

    async getSeriesDetailRuntime(seriesItem, tmdb, omdb, seasonResults, providerLastUpdate = this.lastUpdate) {
        const id = String(seriesItem.id);
        let saved = this.catalogMetaCache.get(id);
        if (!saved) {
            const persisted = await this.persistentCatalogMetaCache.get(id);
            saved = this.catalogMetaCache.get(id) || persisted?.value;
        }
        if (!this.isCatalogItemCurrent(id, providerLastUpdate)) return {};
        saved = withoutProviderEpisodeAverage(saved);
        const derived = hasDerivedSeriesRuntime(saved);
        const official = [tmdb?.runtime, seriesItem.runtime,
            !(derived && omdb?.runtime === saved.runtime) ? omdb?.runtime : null]
            .find(value => parseRuntimeMinutes(value) !== null);
        if (official) return { runtime: official, runtimeAverage: null };
        if (parseRuntimeMinutes(saved?.runtime) !== null && !derived) return { runtime: saved.runtime };
        if (derived && !seriesRuntimeAverageNeedsRefresh(saved)) {
            return { runtime: saved.runtime, runtimeAverage: saved.runtimeAverage };
        }
        if (derived) {
            const refreshed = await this.ensureSeriesRuntimeAverage(seriesItem, saved, providerLastUpdate);
            return refreshed ? { runtime: refreshed.runtime, runtimeAverage: refreshed.runtimeAverage } : {};
        }
        const bySeason = new Map(seasonResults.filter(([season, episodes]) => Number(season) > 0 && Array.isArray(episodes)));
        const average = averageEpisodeRuntime([...bySeason.values()].flat());
        const required = (tmdb?.runtimeSeasons || []).filter(season => season.episodeCount !== 0);
        const seasonIsComplete = expected => {
            const episodes = bySeason.get(expected.season);
            if (!Array.isArray(episodes)) return false;
            if (expected.episodeCount == null) return true;
            const numbers = new Set(episodes.map(episode => Number(episode?.episode))
                .filter(number => Number.isSafeInteger(number) && number > 0));
            return numbers.size >= expected.episodeCount;
        };
        const complete = Boolean(average && required.length > 0 && required.every(seasonIsComplete));
        if (!complete) {
            // Detail pages may fetch only seasons present in the provider. An
            // average must use all regular TMDb seasons, just like catalogue cards.
            const refreshed = await this.ensureSeriesRuntimeAverage(seriesItem,
                saved || { id, type: 'series' }, providerLastUpdate);
            return refreshed ? { runtime: refreshed.runtime, runtimeAverage: refreshed.runtimeAverage } : {};
        }
        const now = Date.now();
        const seasons = [...bySeason].map(([season, episodes]) => {
            const summary = averageEpisodeRuntime(episodes);
            const expected = required.find(entry => entry.season === season);
            return {
                season, episodeCount: expected?.episodeCount ?? episodes.length,
                eligibleEpisodeCount: new Set(episodes.filter(episode => isEligibleRuntimeEpisode(episode, now))
                    .map(episode => episode.episode)).size,
                runtimeCount: summary?.episodeCount || 0, totalMinutes: summary?.totalMinutes || 0,
                checkedAt: now, complete: expected ? seasonIsComplete(expected) : true
            };
        });
        return {
            runtime: average.runtime,
            runtimeAverage: {
                ...average, version: 1, policyVersion: 1, source: 'tmdb-episodes', complete: true, checkedAt: now,
                attemptedAt: now,
                tmdbId: seriesItem.tmdbId || null, providerLastUpdate,
                seasons
            }
        };
    }

    detailSourceOptions(item, preview) {
        const same = preview?._tmdbId && String(preview._tmdbId) === String(item.tmdbId);
        if (!same || catalogMetadataNormalRefreshIsDue(preview) || catalogMetadataNeedsRefresh(preview)) return {};
        return { cachedMetadata: { ...preview,
            runtime: hasDerivedSeriesRuntime(preview) ? undefined : preview.runtime,
            trailer: undefined }, detailExtras: preview._detailExtras };
    }

    async loadSeasonMetadata(seriesItem, info, season) {
        const old = info?._episodeMetadata;
        const saved = String(old?.tmdbId) === String(seriesItem.tmdbId)
            ? old.seasons?.find(value => value.season === season) : null;
        const expected = (info?.videos || []).filter(video => Number(video.season) === season);
        const requestedEpisodes = [...new Set(expected.map(video => Number(video.episode)).filter(number => number > 0))];
        const now = Date.now();
        if (saved?.retryPending && now - saved.attemptedAt < OMDB_MISSING_DATA_RETRY_MS &&
            requestedEpisodes.every(number => saved.requestedEpisodes?.includes(number))) return [season, saved.episodes, saved];
        const numbers = new Set(saved?.episodes?.map(video => Number(video.episode)) || []);
        if (saved && !saved.retryPending && now - saved.checkedAt < metadataRefreshInterval() &&
            requestedEpisodes.every(number => numbers.has(number))) return [season, saved.episodes, saved];
        const fresh = await tmdbMetadata.getSeasonEpisodes(seriesItem.tmdbId, season, { refresh: Boolean(saved) });
        const freshNumbers = new Set(fresh?.map(episode => Number(episode.episode)) || []);
        const incomplete = !Array.isArray(fresh) || requestedEpisodes.some(number => !freshNumbers.has(number));
        const merged = new Map((saved?.episodes || []).map(episode => [Number(episode.episode), episode]));
        if (incomplete) for (const episode of fresh || []) merged.set(Number(episode.episode), episode);
        const episodes = incomplete ? [...merged.values()] : fresh;
        return [season, episodes, { season, episodes, checkedAt: incomplete ? (saved?.checkedAt || 0) : now,
            attemptedAt: now, retryPending: incomplete, requestedEpisodes }];
    }

    async buildSeriesMeta(seriesItem, options = {}) {
        const startedAt = Date.now(), timings = options.timings || {};
        const providerLastUpdate = Number(this.lastUpdate) || 0;
        const seriesIdRaw = seriesItem.series_id || seriesItem.id.replace(/^iptv_series_/, '');
        const knownTmdbId = seriesItem.tmdbId || null;
        const preview = options.preview || this.catalogMetaCache.get(seriesItem.id) ||
            (await this.persistentCatalogMetaCache.get(seriesItem.id))?.value;

        // The provider episode list and known TMDb metadata are independent.
        // Start them together to avoid serial network wait on detail pages.
        const infoPromise = (options.infoPromise || this.ensureSeriesInfo(seriesIdRaw)).then(info => {
            timings.providerEpisodesMs ??= Date.now() - startedAt; return info;
        });
        let ready;
        const metadataReady = new Promise(resolve => { ready = value => {
            if (timings.metadataMs === undefined) timings.metadataMs = Date.now() - startedAt;
            resolve(value);
        }; });
        const knownTmdbPromise = knownTmdbId
            ? tmdbMetadata.getSeriesMetadata(knownTmdbId, { ...this.detailSourceOptions(seriesItem, preview), onMetadata: ready })
            : Promise.resolve(null);
        knownTmdbPromise.then(value => { timings.metadataAndTrailersMs = Date.now() - startedAt; ready(value); }, () => ready(null));
        const omdbPromise = metadataReady.then(async meta => {
            const start = Date.now();
            const value = meta?.imdbId ? await this.getDetailOmdbMetadata(meta.imdbId, seriesItem.id, providerLastUpdate) : null;
            timings.omdbMs = Date.now() - start; return value;
        });
        const [info, initialTmdb] = await Promise.all([infoPromise, metadataReady]);
        const tmdbId = knownTmdbId;
        let tmdb = initialTmdb;
        const tmdbSeasons = new Map();
        let seasonResultsPromise = Promise.resolve([]);
        const seasonsStartedAt = Date.now();
        if (tmdb && tmdbMetadata.validTmdbId(tmdbId)) {
            const seasonNumbers = [...new Set((info?.videos || [])
                .map(video => Number(video.season))
                .filter(n => Number.isSafeInteger(n) && n >= 0))];
            const seasonConcurrency = parsePositiveInteger(
                process.env.SERIES_EPISODE_METADATA_CONCURRENCY, 6, 1, 12
            );
            seasonResultsPromise = mapWithConcurrency(seasonNumbers, seasonConcurrency,
                season => this.loadSeasonMetadata({ ...seriesItem, tmdbId }, info, season));
        }
        seasonResultsPromise = seasonResultsPromise.then(value => { timings.seasonsMs = Date.now() - seasonsStartedAt; return value; });
        const [omdb, seasonResults, completeTmdb] = await Promise.all([omdbPromise, seasonResultsPromise, knownTmdbPromise]);
        tmdb = completeTmdb || tmdb;
        if (this.isCatalogItemCurrent(seriesItem.id, providerLastUpdate) && tmdb && this.providerName === 'xtream') {
            const checkedAt = Date.now();
            const enrichment = { tmdbId: String(tmdbId), checkedAt, seasons: seasonResults
                .filter(([, episodes]) => Array.isArray(episodes))
                .map(([season, episodes, state]) => state || ({ season, checkedAt: info?._episodeMetadata?.seasons
                    ?.find(saved => saved.season === season && saved.episodes === episodes)?.checkedAt || checkedAt, episodes })) };
            if (Buffer.byteLength(JSON.stringify(enrichment)) <= 256 * 1024) {
                const stored = await this.persistentSeriesInfoCache.updateEnrichment?.(seriesIdRaw, enrichment, providerLastUpdate,
                    () => this.isCatalogItemCurrent(seriesItem.id, providerLastUpdate));
                if (info) info._episodeMetadata = stored || enrichment;
            }
        }
        for (const [season, episodes] of seasonResults) {
            if (Array.isArray(episodes)) tmdbSeasons.set(season, episodes);
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
            if (tmdbEpisode?.released) {
                const d = new Date(tmdbEpisode.released);
                if (!isNaN(d.getTime())) released = d.toISOString();
            }
            if (released) video.released = released;
            return video;
        });

        const runtimeStartedAt = Date.now();
        const runtimeFields = await this.getSeriesDetailRuntime(
            { ...seriesItem, runtime: validSeriesRuntime(seriesItem.runtime, info?.runtime) },
            tmdb, omdb, seasonResults, providerLastUpdate
        );
        timings.runtimeMs = Date.now() - runtimeStartedAt;
        if (!tmdb) {
            // Keep the provider episode list and any provider preview fields when
            // TMDb cannot return this title; store useful fallback fields for cards.
            const fallbackMeta = {
                id: seriesItem.id,
                _tmdbId: null,
                type: 'series',
                name: seriesItem.name,
                runtime: runtimeFields.runtime,
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
            await this.persistDetailedCatalogPreview(seriesItem.id, 'series', null, { ...fallbackMeta, ...runtimeFields }, {
                providerLastUpdate,
                providerFallback: true
            });
            return fallbackMeta;
        }
        const detailedMeta = {
            id: seriesItem.id,
            _tmdbId: tmdbId,
            type: 'series',
            name: tmdb.name,
            poster: tmdb.poster,
            background: tmdb.background,
            logo: tmdb.logo,
            description: tmdb.description,
            genres: tmdb.genres,
            releaseInfo: tmdb.releaseInfo,
            year: tmdb.year,
            runtime: runtimeFields.runtime,
            _detailExtras: tmdb._detailExtras,
            imdbId: tmdb.imdbId || omdb?.imdbId,
            imdbRating: omdb?.imdbRating != null ? String(omdb.imdbRating) : undefined,
            cast: tmdb.cast,
            tmdbRating: tmdb.rating,
            trailers: tmdb.trailer ? [{ source: tmdb.trailer.id, type: 'Trailer' }] : [],
            links: [
                // Keep the full series detail page consistent with movie details:
                // expose the IMDb score as a native IMDb-category link as well as
                // the top-level imdbRating field, without changing episode links.
                ...(omdb?.imdbRating && tmdb.imdbId ? [{
                    name: String(omdb.imdbRating),
                    category: 'imdb',
                    url: 'https://imdb.com/title/' + encodeURIComponent(String(tmdb.imdbId))
                }] : []),
                ...(tmdb.rating ? [{ name: 'TMDb rating: ' + tmdb.rating, category: 'Rating', url: 'https://www.themoviedb.org/tv/' + encodeURIComponent(String(tmdbId)) }] : []),
                ...(tmdb.links || [])
            ],
            videos
        };
        await this.persistDetailedCatalogPreview(seriesItem.id, 'series', tmdbId, { ...detailedMeta, ...runtimeFields }, { providerLastUpdate });
        return detailedMeta;
    }

    async enrichCatalogMetaItems(items, concurrency = 3, forceRefresh = false) {
        // Keep this page's previews until its caller has rendered or counted them.
        // A concurrent catalogue scan can evict entries from the shared LRU while
        // the slowest lookup in this page is still running.
        const previews = new Map();
        const candidates = items.filter(item => {
            if (!item || (item.type !== 'movie' && item.type !== 'series')) return false;
            const cached = this.catalogMetaCache.get(item.id);
            if (cached !== undefined) previews.set(String(item.id), cached);
            const pendingKey = (Number(this.lastUpdate) || 0) + ':' + String(item.id);
            const metadataPending = this.catalogMetaInFlight.has(pendingKey);
            const runtimePending = item.type === 'series' && this.seriesRuntimeInFlight.has(pendingKey);
            // An in-memory hit must still wait for a due missing-field retry or
            // an already-running refresh, just like a preview loaded from disk.
            return forceRefresh || cached === undefined || metadataPending || runtimePending ||
                getCatalogMetadataWarmupState(cached, item).retryDue;
        });
        let nextIndex = 0;
        const worker = async () => {
            while (nextIndex < candidates.length) {
                if (requestContext.current().signal?.aborted) {
                    const error = new Error("Catalogue request closed"); error.name = "AbortError"; throw error;
                }
                if (this.disposed) return;
                const item = candidates[nextIndex++];
                try {
                    const providerLastUpdate = Number(this.lastUpdate) || 0;
                    let detailed = await this.getCatalogMetaAsync(item.id, item.type);
                    // Complete runtime enrichment for the requested page before it
                    // is returned; join an existing background calculation when present.
                    if (detailed && item.type === 'series') {
                        detailed = await this.ensureSeriesRuntimeAverage(item, detailed, providerLastUpdate);
                    }
                    if (!detailed || !this.isCatalogItemCurrent(item.id, providerLastUpdate)) continue;
                    this.catalogMetaStaleFallbacks.delete(item.id);
                    const preview = { ...(this.catalogMetaCache.get(item.id) || detailed) };
                    const providerGenre = item.category || item.attributes?.['group-title'];
                    let fallbackPreview;
                    if (!isMetadataValuePresent('poster', preview.poster)) {
                        fallbackPreview = this.generateMetaPreview(item);
                        if (isMetadataValuePresent('poster', fallbackPreview.poster)) preview.poster = fallbackPreview.poster;
                    }
                    if (!isMetadataValuePresent('genres', preview.genres)) {
                        fallbackPreview = fallbackPreview || this.generateMetaPreview(item);
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
                    this.cacheCatalogMetaPreview(item.id, preview, true, providerLastUpdate);
                    previews.set(String(item.id), this.catalogMetaCache.get(item.id) || preview);
                } catch (error) {
                    this.log.warn('Foreground catalogue metadata enrichment failed', { itemId: item.id, errorName: error?.name || 'Error' });
                    const generation = Number(this.lastUpdate) || 0;
                    const currentItem = findCatalogueItemById(item.type === 'series' ? this.series : this.movies, item.id);
                    if (currentItem !== item) continue;
                    const saved = await this.persistentCatalogMetaCache.get(String(item.id));
                    if (!this.isCatalogItemCurrent(item.id, generation)) continue;
                    const fallback = this.catalogMetaCache.get(item.id) || saved?.value;
                    if (fallback && !(item.tmdbId && fallback._tmdbId && String(item.tmdbId) !== String(fallback._tmdbId))) {
                        this.putCatalogMeta(item.id, fallback);
                        previews.set(String(item.id), fallback);
                    }
                }
            }
        };
        const workerCount = Math.min(Math.max(1, concurrency), candidates.length);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        return previews;
    }

    putCatalogMeta(id, value) {
        const key = String(id);
        const old = this.catalogMetaCache.get(key) || this.persistentCatalogMetaCache.entries?.get(key)?.value;
        if (!isDeepStrictEqual(old, value)) {
            this.catalogMetadataRevisions.set(key, (this.catalogMetadataRevisions.get(key) || 0) + 1);
            this.detailCache.delete(key);
        }
        this.catalogMetaCache.set(key, value);
    }

    isCatalogItemCurrent(id, providerLastUpdate = null) {
        if (providerLastUpdate !== null && Number(this.lastUpdate || 0) !== Number(providerLastUpdate || 0)) return false;
        return Boolean(
            findCatalogueItemById(this.movies, id) ||
            findCatalogueItemById(this.series, id)
        );
    }
    async persistCatalogMetaIfCurrent(id, preview, providerLastUpdate = this.lastUpdate) {
        const key = String(id);
        if (!this.isCatalogItemCurrent(key, providerLastUpdate)) return null;
        const latest = this.catalogMetaCache.get(key);
        const merged = mergeCatalogMetadataPreservingKnownFields(latest, preview);
        this.putCatalogMeta(key, merged);
        await this.persistentCatalogMetaCache.set(key, merged, () => this.isCatalogItemCurrent(key, providerLastUpdate));
        if (!this.isCatalogItemCurrent(key, providerLastUpdate)) {
            if (!this.isCatalogItemCurrent(key)) {
                this.catalogMetaCache.delete(key);
                await this.persistentCatalogMetaCache.delete(key);
            }
            return null;
        }
        return merged;
    }

    cacheCatalogMetaPreview(id, preview, persist = true, providerLastUpdate = this.lastUpdate) {
        // Ignore any lookup that finished after its catalog item was removed.
        if (!this.isCatalogItemCurrent(id, providerLastUpdate)) return;
        // A fresh metadata result sets its own timestamps in getCatalogMetaAsync.
        // For first-time entries, initialize both clocks; cached entries retain
        // their existing timestamps rather than postponing a due retry on every view.
        const previousMetadataCheckedAt = Number(preview?.metadataCheckedAt) || 0;
        const previousMissingMetadataCheckedAt = Number(preview?.missingMetadataCheckedAt) || 0;
        const now = Date.now();
        preview = mergeCatalogMetadataPreservingKnownFields(this.catalogMetaCache.get(String(id)), preview);
        preview = {
            ...preview,
            metadataCheckedAt: previousMetadataCheckedAt || Number(preview?.metadataCheckedAt) || now,
            missingMetadataCheckedAt: previousMissingMetadataCheckedAt || Number(preview?.missingMetadataCheckedAt) ||
                previousMetadataCheckedAt || Number(preview?.metadataCheckedAt) || now
        };
        this.putCatalogMeta(id, preview);
        if (persist) {
            const write = this.persistentCatalogMetaCache.set(id, preview, () => this.isCatalogItemCurrent(id, providerLastUpdate)).then(async () => {
                if (!this.isCatalogItemCurrent(id)) {
                    this.catalogMetaCache.delete(String(id));
                    await this.persistentCatalogMetaCache.delete(id);
                }
            });
            this.catalogMetaPersistWrites.add(write);
            write.catch(error => {
                this.log.warn('Persistent catalogue metadata cache write failed:', error?.name || 'Error');
            }).finally(() => this.catalogMetaPersistWrites.delete(write));
        }
    }

    async persistDetailedCatalogPreview(id, type, tmdbId, detailed, options = {}) {
        const key = String(id || '');
        const providerLastUpdate = options.providerLastUpdate ?? this.lastUpdate;
        if (!key || (type !== 'movie' && type !== 'series') || !detailed ||
            typeof detailed !== 'object' || !this.isCatalogItemCurrent(key, providerLastUpdate)) return false;
        try {
            let previous = this.catalogMetaCache.get(key) || null;
            if (!previous) {
                const persisted = await this.persistentCatalogMetaCache.get(key);
                previous = this.catalogMetaCache.get(key) || persisted?.value || null;
            }
            if (!this.isCatalogItemCurrent(key, providerLastUpdate)) return false;

            const candidate = {
                id: key,
                type,
                metadataVersion: 3,
                _tmdbId: options.providerFallback ? null : (tmdbId ? String(tmdbId) : null),
                imdbIdChecked: options.providerFallback || Boolean(tmdbId)
            };
            for (const field of [
                'name', 'poster', 'background', 'logo', 'description', 'genres',
                'releaseInfo', 'year', 'runtime', 'imdbId', 'imdbRating',
                'cast', 'director', 'tmdbRating', 'links', 'trailers', '_detailExtras'
            ]) {
                if (Object.prototype.hasOwnProperty.call(detailed, field) &&
                    isMetadataValuePresent(field, detailed[field])) {
                    candidate[field] = detailed[field];
                }
            }

            if (Object.prototype.hasOwnProperty.call(detailed, 'runtimeAverage')) {
                candidate.runtimeAverage = detailed.runtimeAverage;
            }
            const preview = mergeCatalogMetadataPreservingKnownFields(previous, candidate);
            preview.id = key;
            preview.type = type;
            preview.metadataVersion = 3;
            preview.metadataCheckedAt =
                Number(previous?.metadataCheckedAt) || Number(detailed.metadataCheckedAt) || Date.now();
            // Reading cached details is not a new missing-field source attempt.
            // Catalogue attempts and the OMDb client maintain their own clocks.
            this.cacheCatalogMetaPreview(key, preview, true, providerLastUpdate);
            return true;
        } catch (error) {
            this.log.warn('Detailed catalogue metadata backfill failed', {
                itemId: key,
                errorName: error?.name || 'Error'
            });
            return false;
        }
    }

    startContinuousCatalogPrefetch(type, pageSize, concurrency) {
        if (this.disposed) return;
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
        const providerLastUpdate = Number(this.lastUpdate) || 0;
        const isCurrentGeneration = () => Number(this.lastUpdate || 0) === providerLastUpdate;
        if (!Array.isArray(items) || !items.length) return;
        const catalogueFingerprint = getCatalogueFingerprint(items);
        const lastCompleted = this.catalogPrefetchLastCompleted.get(type) || 0;
        if (Date.now() - lastCompleted < refreshInterval &&
            this.catalogPrefetchLastFingerprint.get(type) === catalogueFingerprint &&
            Date.now() < (this.catalogPrefetchNextCheckAt.get(type) || 0)) return;

        const job = requestContext.background(async () => {
            const startedAt = Date.now();
            const statusKey = '__catalog_prefetch_status__:' + type;
            // Persist the completion timestamp and catalogue fingerprint so Railway
            // restarts do not repeat a fresh warm-up, but changed provider catalogues
            // still trigger a full metadata pass even when the item count is unchanged.
            const persistedStatus = await this.persistentCatalogMetaCache.get(statusKey);
            if (!isCurrentGeneration()) return;
            const persistedCompletedAt = Number(persistedStatus?.value?.completedAt) || 0;
            const sameCatalogue = persistedStatus?.value?.catalogueFingerprint === catalogueFingerprint;
            // The completion marker has its own completedAt timestamp; do not
            // couple daily scheduling to the metadata entries' freshness TTL.
            let cachedCatalogueNeedsRefresh = false;
            if (persistedStatus && sameCatalogue &&
                Number(persistedStatus.value?.version) >= 4 &&
                Date.now() - persistedCompletedAt < refreshInterval) {
                let cachedIncompleteItems = 0;
                let cachedRetryDeferredItems = 0;
                const cachedMissingFieldCounts = {};
                let nextCheckAt = persistedCompletedAt + refreshInterval;
                // Inspect saved previews before honoring the scan marker. Missing
                // fields are reported separately from retries held by their backoff.
                for (const item of items) {
                    const saved = await this.persistentCatalogMetaCache.get(String(item.id));
                    if (!isCurrentGeneration()) return;
                    const state = getCatalogMetadataWarmupState(saved?.value, item);
                    nextCheckAt = Math.min(nextCheckAt, catalogMetadataNextCheckAt(saved?.value, item));
                    if (state.incomplete) {
                        cachedIncompleteItems++;
                        for (const field of state.missingFields) {
                            cachedMissingFieldCounts[field] = (cachedMissingFieldCounts[field] || 0) + 1;
                        }
                    }
                    if (state.retryDue) {
                        cachedCatalogueNeedsRefresh = true;
                        break;
                    }
                    if (state.incomplete) cachedRetryDeferredItems++;
                }
                if (!cachedCatalogueNeedsRefresh) {
                    this.catalogPrefetchLastCompleted.set(type, persistedCompletedAt);
                    this.catalogPrefetchNextCheckAt.set(type, nextCheckAt);
                    this.catalogPrefetchLastFingerprint.set(type, catalogueFingerprint);
                    this.catalogPrefetchRetryAfter.delete(type);
                    this.log.info('Persistent catalogue metadata scan is current', {
                        type,
                        total: items.length,
                        incompleteItems: cachedIncompleteItems,
                        retriesDeferredByBackoff: cachedRetryDeferredItems,
                        missingFieldCounts: cachedMissingFieldCounts,
                        completedAt: new Date(persistedCompletedAt).toISOString()
                    });
                    return;
                }
            }

            let processed = 0;
            let incompleteItems = 0;
            let retryDueItems = 0;
            const missingFieldCounts = {};
            let nextCheckAt = Date.now() + refreshInterval;
            for (let offset = 0; offset < items.length; offset += pageSize) {
                if (this.disposed || !isCurrentGeneration()) return;
                const batch = items.slice(offset, Math.min(offset + pageSize, items.length));
                if (!batch.length) continue;
                // Force the warm-up through the metadata refresh path even when an old
                // preview is already in the LRU. Refreshed values must also replace
                // the persistent preview, not merely update memory.
                const batchPreviews = await this.enrichCatalogMetaItems(batch, concurrency, true);
                if (!isCurrentGeneration()) return;
                processed += batch.length;
                // Count accepted page results or saved previews, since another
                // media scan may evict this batch from the shared memory LRU.
                // A genuinely missing preview still remains due for a later retry.
                for (const item of batch) {
                    let cached = this.catalogMetaCache.get(item.id) || batchPreviews?.get?.(String(item.id));
                    if (!cached) {
                        const saved = await this.persistentCatalogMetaCache.get(String(item.id));
                        if (!isCurrentGeneration()) return;
                        cached = saved?.value;
                    }
                    const state = getCatalogMetadataWarmupState(cached, item);
                    nextCheckAt = Math.min(nextCheckAt, catalogMetadataNextCheckAt(cached, item));
                    if (state.incomplete) {
                        incompleteItems++;
                        for (const field of state.missingFields) {
                            missingFieldCounts[field] = (missingFieldCounts[field] || 0) + 1;
                        }
                    }
                    if (state.retryDue) retryDueItems++;
                }
                // Let incoming interactive requests run between large cache-only batches.
                await new Promise(resolve => setImmediate(resolve));
            }

            if (!isCurrentGeneration()) return;
            if (retryDueItems === 0) {
                const completedAt = Date.now();
                // All set() calls are asynchronous because they initialize the
                // persistent store on first use. Wait for them before flushing, so the
                // completion marker can never get ahead of the actual card previews.
                while (this.catalogMetaPersistWrites.size) {
                    await Promise.allSettled([...this.catalogMetaPersistWrites]);
                }
                if (!isCurrentGeneration()) return;
                await this.persistentCatalogMetaCache.set(statusKey, {
                    completedAt,
                    catalogueCount: items.length,
                    catalogueFingerprint,
                    nextCheckAt,
                    version: 5
                }, isCurrentGeneration);
                // Ensure metadata and its completion marker reach the persistent
                // volume before reporting the scan as durable.
                await this.persistentCatalogMetaCache.flush();
                if (!isCurrentGeneration()) return;
                this.catalogPrefetchLastCompleted.set(type, completedAt);
                this.catalogPrefetchNextCheckAt.set(type, nextCheckAt);
                this.catalogPrefetchLastFingerprint.set(type, catalogueFingerprint);
                this.catalogPrefetchRetryAfter.delete(type);
                this.log.info('Persistent catalogue metadata scan complete', {
                    type,
                    processed,
                    total: items.length,
                    incompleteItems,
                    retriesDeferredByBackoff: incompleteItems - retryDueItems,
                    missingFieldCounts,
                    ms: Date.now() - startedAt
                });
            } else {
                const retryDelay = parsePositiveInteger(
                    process.env.CATALOG_PREFETCH_RETRY_MS, 60 * 60 * 1000,
                    5 * 60 * 1000, 24 * 60 * 60 * 1000
                );
                this.catalogPrefetchRetryAfter.set(type, Date.now() + retryDelay);
                this.log.info('Catalogue metadata scan finished with retries pending', {
                    type,
                    processed,
                    total: items.length,
                    incompleteItems,
                    retryDueItems,
                    missingFieldCounts,
                    retryDelay
                });
            }
        });

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
        const providerLastUpdate = Number(this.lastUpdate) || 0;
        const isCurrent = () => this.isCatalogItemCurrent(id, providerLastUpdate) &&
            Boolean(findCatalogueItemById(this.movies, id));
        if (!isCurrent()) return null;
        const idCacheKey = 'movie-tmdb:' + id;
        const saved = this.catalogMetaCache.get(id) || (await this.persistentCatalogMetaCache.get(id))?.value;
        if (saved?._tmdbId && !saved.metadataRefreshAttemptedAt &&
            Date.now() - Number(saved.metadataCheckedAt || 0) < metadataRefreshInterval() && isCurrent()) {
            this.seriesInfoCache.set(idCacheKey, String(saved._tmdbId)); return String(saved._tmdbId);
        }
        const cached = this.seriesInfoCache.get(idCacheKey);
        if (cached) return cached;

        // Missing IDs are cached for the cache TTL too, so every Discover revisit
        // does not repeat the same potentially slow get_vod_info call.
        const negativeKey = 'movie-tmdb-miss:' + id;
        if (this.seriesInfoCache.has(negativeKey)) return null;

        const pendingKey = 'movie-tmdb:' + providerLastUpdate + ':' + id;
        const pending = this.providerInfoInFlight.get(pendingKey);
        if (pending) return pending;

        const task = (async () => {
            const streamId = id.replace(/^iptv_vod_/, '');
            const providerInfo = await providerModule.fetchMovieInfo(this, streamId);
            if (!isCurrent()) return null;
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
        const providerLastUpdate = Number(this.lastUpdate) || 0;
        const pendingKey = providerLastUpdate + ':' + key;
        if (!key || !this.isCatalogItemCurrent(key, providerLastUpdate)) return null;
        const item = findCatalogueItemById(type === 'series' ? this.series : this.movies, key);
        const existingTask = this.catalogMetaInFlight.get(pendingKey);
        if (existingTask) {
            const result = await existingTask;
            return this.isCatalogItemCurrent(key, providerLastUpdate) ? result : null;
        }
        const cached = this.catalogMetaCache.get(key);
        if (cached !== undefined) {
            // An LRU hit must not keep popular titles permanently exempt from the
            // 14-day metadata refresh. If persistent storage is disabled/unavailable,
            // make the same due decision from the in-memory preview instead.
            const persisted = await this.persistentCatalogMetaCache.get(key);
            if (!this.isCatalogItemCurrent(key, providerLastUpdate)) return null;
            const cachedValue = this.catalogMetaCache.get(key) || cached || persisted?.value;
            const normalRefreshDue = catalogMetadataNormalRefreshIsDue(cachedValue, persisted?.savedAt);
            const refreshDue = normalRefreshDue ||
                catalogMetadataIdentityNextCheckAt(cachedValue, item) <= Date.now() ||
                omdbMetadataNeedsRefresh(cachedValue) ||
                catalogMetadataNeedsRefresh(cachedValue);
            if (!refreshDue) return cachedValue;
            // Due entries fall through to the shared in-flight refresh below.
        }
        const pending = this.catalogMetaInFlight.get(pendingKey);
        if (pending) {
            const result = await pending;
            return this.isCatalogItemCurrent(key, providerLastUpdate) ? result : null;
        }

        const task = (async () => {
            const persisted = await this.persistentCatalogMetaCache.get(key);
            if (!this.isCatalogItemCurrent(key, providerLastUpdate)) return null;
            const previousRecord = this.catalogMetaCache.get(key) || cached || persisted?.value || null;
            const hasNamedPreview = value =>
                Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
                    String(value.name || '').trim());
            // Partial but named previews remain useful and must retain their known
            // fields. Missing fields still trigger their own retry clocks below.
            const hasPreviousPreview = hasNamedPreview(previousRecord);
            const previousSavedAt = Number(persisted?.savedAt) || 0;
            const normalMetadataRefreshDue = catalogMetadataNormalRefreshIsDue(previousRecord, previousSavedAt);
            const identityRefreshDue = catalogMetadataIdentityNextCheckAt(previousRecord, item) <= Date.now();
            const metadataRefreshDue = normalMetadataRefreshDue || identityRefreshDue ||
                omdbMetadataNeedsRefresh(previousRecord) ||
                catalogMetadataNeedsRefresh(previousRecord);
            if (hasPreviousPreview && !metadataRefreshDue) {
                this.putCatalogMeta(key, previousRecord);
                return previousRecord;
            }

            const refreshed = await this._getCatalogMetaAsync(
                id, type,
                omdbMetadataNeedsRefresh(previousRecord) || catalogMetadataNeedsRefresh(previousRecord),
                { refreshAll: normalMetadataRefreshDue || identityRefreshDue,
                    refreshOmdb: previousRecord?.omdbPending === true,
                    previousMetadata: previousRecord }
            ).catch(error => {
                this.log.warn('Metadata source lookup failed; retaining saved fields', { itemId: key, errorName: error?.name || 'Error' });
                return null;
            });
            if (!this.isCatalogItemCurrent(key, providerLastUpdate)) return null;
            if (refreshed) {
                if (refreshed._tmdbId) this.catalogDetailsAvailableAt.set(key, { generation: providerLastUpdate, at: Date.now() });
                // A title-details lookup may have filled gaps while this request was
                // in flight. Merge the response into the latest preview, not the
                // snapshot captured before the network request.
                const currentRecord = this.catalogMetaCache.get(key) || previousRecord;
                const merged = mergeCatalogMetadataPreservingKnownFields(currentRecord, refreshed);
                const retainedAfterProviderFailure = Boolean(currentRecord?._tmdbId &&
                    Object.prototype.hasOwnProperty.call(refreshed, '_tmdbId') && !refreshed._tmdbId);
                merged.metadataCheckedAt = (normalMetadataRefreshDue || identityRefreshDue) && !retainedAfterProviderFailure
                    ? (refreshed.metadataCheckedAt || Date.now())
                    : (Number(currentRecord?.metadataCheckedAt) || previousSavedAt || Date.now());
                if (normalMetadataRefreshDue || identityRefreshDue) {
                    // Keeping old complete fields through a provider-only fallback
                    // does not mean TMDb refreshed successfully. Retry after failure
                    // backoff instead of postponing the next attempt for 14 days.
                    merged.metadataRefreshAttemptedAt = retainedAfterProviderFailure ? Date.now() : 0;
                }
                merged.missingMetadataCheckedAt = Date.now();
                return await this.persistCatalogMetaIfCurrent(key, merged, providerLastUpdate);
            }
            if (hasPreviousPreview) {
                // Keep partial previews through failed refreshes too, and record the
                // attempt so an incomplete result respects the 12-hour retry window.
                const retained = {
                    ...(this.catalogMetaCache.get(key) || previousRecord),
                    ...(normalMetadataRefreshDue || identityRefreshDue ? { metadataRefreshAttemptedAt: Date.now() } : {}),
                    missingMetadataCheckedAt: Date.now()
                };
                const saved = await this.persistCatalogMetaIfCurrent(key, retained, providerLastUpdate);
                if (!saved || !this.isCatalogItemCurrent(key, providerLastUpdate)) return null;
                this.catalogMetaStaleFallbacks.add(key);
                return saved;
            }
            return null;
        })();
        this.catalogMetaInFlight.set(pendingKey, task);
        try {
            const result = await task;
            return this.isCatalogItemCurrent(key, providerLastUpdate) ? result : null;
        } finally {
            if (this.catalogMetaInFlight.get(pendingKey) === task) {
                this.catalogMetaInFlight.delete(pendingKey);
            }
        }
    }

    async getCatalogOmdbMetadata(imdbId, refreshIncomplete, options) {
        const previous = options.previousMetadata;
        if (previous && String(previous.imdbId || '') === String(imdbId) &&
            !options.refreshAll && !omdbMetadataNeedsRefresh(previous)) {
            // A due artwork/description retry must not bypass an independent
            // recent OMDb attempt, including after its process cache was lost.
            return {
                imdbId, imdbRating: previous.imdbRating,
                runtime: hasDerivedSeriesRuntime(previous) ? undefined : previous.runtime,
                omdbChecked: previous.omdbChecked, omdbCheckedAt: previous.omdbCheckedAt,
                omdbPending: previous.omdbPending === true
            };
        }
        return omdbMetadata.getByImdbId(imdbId, {
            refreshIncomplete, refresh: options.refreshAll === true || options.refreshOmdb === true
        });
    }

    async _getCatalogMetaAsync(id, type, refreshIncompleteMetadata = false, options = {}) {
        // Discover cards do not need episode lists, trailers, or logo-image lookups.
        // Fetch only the fields displayed in the panel and the credits needed for cast/directors.
        if (type === 'series' || id.startsWith('iptv_series_')) {
            const seriesItem = findCatalogueItemById(this.series, id);
            if (!seriesItem) return null;
            const tmdbId = seriesItem.tmdbId || null;
            const tmdb = tmdbId ? await tmdbMetadata.getSeriesCatalogMetadata(tmdbId, {
                refresh: refreshIncompleteMetadata || options.refreshAll === true
            }) : null;
            if (!tmdb) {
                return {
                    ...this.generateMetaPreview(seriesItem),
                    runtime: validSeriesRuntime(seriesItem.runtime),
                    metadataVersion: 3,
                    _tmdbId: null,
                    imdbIdChecked: true,
                    omdbChecked: true,
                    omdbPending: false
                };
            }
            const omdb = tmdb.imdbId ? await this.getCatalogOmdbMetadata(tmdb.imdbId, refreshIncompleteMetadata, options) : null;
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
                runtime: validSeriesRuntime(tmdb.runtime, seriesItem.runtime, omdb?.runtime),
                ...(parseRuntimeMinutes(validSeriesRuntime(tmdb.runtime, seriesItem.runtime, omdb?.runtime)) !== null
                    ? { runtimeAverage: null } : {}),
                metadataVersion: 3,
                _tmdbId: tmdbId || null,
                imdbIdChecked: Boolean(tmdb),
                imdbId: tmdb.imdbId || omdb?.imdbId,
                imdbRating: omdb?.imdbRating != null ? String(omdb.imdbRating) : undefined,
                omdbChecked: omdb?.omdbChecked === true,
                omdbCheckedAt: omdb?.omdbCheckedAt,
                omdbPending: Boolean(omdb?.omdbPending || omdb?.omdbRetryableFailure ||
                    (tmdb.imdbId && omdbMetadata.shouldRetryLookup(tmdb.imdbId))),
                cast: tmdb.cast,
                tmdbRating: tmdb.rating,
                trailers: [],
                links: [
                    ...(omdb?.imdbRating ? [{ name: String(omdb.imdbRating), category: 'imdb', url: 'https://imdb.com/title/' + encodeURIComponent(String(tmdb.imdbId)) }] : []),
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
        if (!tmdbId && this.providerName === 'xtream' && !this.config.xtreamUseM3U) {
            tmdbId = await this.resolveMovieTmdbId(id, item, providerModule);
        }
        const tmdb = await tmdbMetadata.getMovieCatalogMetadata(tmdbId, { refresh: refreshIncompleteMetadata || options.refreshAll === true });
        const omdb = tmdb?.imdbId ? await this.getCatalogOmdbMetadata(tmdb.imdbId, refreshIncompleteMetadata, options) : null;
        if (!tmdb) {
            const fallback = this.getDetailedMeta(id);
            return fallback ? {
                ...fallback,
                metadataVersion: 3,
                _tmdbId: null,
                imdbIdChecked: true,
                omdbChecked: true,
                omdbPending: false
            } : null;
        }
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
            metadataVersion: 3,
            _tmdbId: tmdbId || null,
            imdbIdChecked: Boolean(tmdb),
            imdbId: tmdb.imdbId || omdb?.imdbId,
            imdbRating: omdb?.imdbRating != null ? String(omdb.imdbRating) : undefined,
            omdbChecked: omdb?.omdbChecked === true,
            omdbCheckedAt: omdb?.omdbCheckedAt,
            omdbPending: Boolean(omdb?.omdbPending || omdb?.omdbRetryableFailure ||
                (tmdb.imdbId && omdbMetadata.shouldRetryLookup(tmdb.imdbId))),
            director: tmdb.director,
            cast: tmdb.cast,
            tmdbRating: tmdb.rating,
            trailers: [],
            links: [
                ...(omdb?.imdbRating ? [{ name: String(omdb.imdbRating), category: 'imdb', url: 'https://imdb.com/title/' + encodeURIComponent(String(tmdb.imdbId)) }] : []),
                ...(tmdb.rating ? [{ name: 'TMDb rating: ' + tmdb.rating, category: 'Rating', url: 'https://www.themoviedb.org/movie/' + encodeURIComponent(String(tmdbId)) }] : []),
                ...(tmdb.links || [])
            ]
        };
    }

    async getDetailedMetaAsync(id, type) {
        if (type === 'tv') return this.getDetailedMeta(id);
        const startedAt = Date.now();
        for (let attempt = 0; attempt < 3; attempt++) {
            const generation = this.lastUpdate;
            const series = type === 'series' || id.startsWith('iptv_series_');
            const item = findCatalogueItemById(series ? this.series : this.movies, id);
            if (!item) return null;
            const pendingKey = generation + ':' + id;
            let task = this.detailInFlight.get(pendingKey);
            if (!task) {
                const timings = {};
                task = (async () => {
                    const saved = this.catalogMetaCache.get(id) || (await this.persistentCatalogMetaCache.get(id))?.value;
                    const cached = this.detailCache.get(id);
                    const metadataPending = this.catalogMetaInFlight.has(pendingKey) || this.seriesRuntimeInFlight.has(pendingKey);
                    if (cached?.generation === generation && !metadataPending &&
                        cached.revision === (this.catalogMetadataRevisions.get(id) || 0) &&
                        !getCatalogMetadataWarmupState(saved, item).retryDue &&
                        !(cached.value._detailExtras?.failed && Date.now() - cached.value._detailExtras.checkedAt >= OMDB_MISSING_DATA_RETRY_MS)) {
                        timings.cacheHit = true; return cached.value;
                    }
                    // Start episode work independently of any due catalogue enrichment.
                    const infoStartedAt = Date.now();
                    const infoPromise = series ? this.ensureSeriesInfo(getProviderSeriesKey(item)).then(info => {
                        timings.providerEpisodesMs = Date.now() - infoStartedAt; return info;
                    }) : null;
                    infoPromise?.catch(() => {});
                    const enrichmentStartedAt = Date.now();
                    const preview = await this.getCatalogMetaAsync(id, series ? 'series' : 'movie') || saved;
                    timings.catalogueMs = Date.now() - enrichmentStartedAt;
                    if (!this.isCatalogItemCurrent(id, generation)) { if (infoPromise) await infoPromise; return null; }
                    const detail = await this._getDetailedMetaAsync(id, type, { preview, infoPromise, timings });
                    if (!this.isCatalogItemCurrent(id, generation)) return null;
                    if (!detail) return null;
                    const latest = this.catalogMetaCache.get(id) || preview;
                    const result = mergeCatalogMetadataPreservingKnownFields(latest, detail);
                    const weight = estimateDetailCacheBytes(result);
                    if (weight <= 16 * 1024 * 1024) this.detailCache.set(id, { value: result,
                        generation, revision: this.catalogMetadataRevisions.get(id) || 0 });
                    return result;
                })();
                task.timings = timings;
                this.detailInFlight.set(pendingKey, task);
            }
            let result;
            try { result = await task; }
            finally { if (this.detailInFlight.get(pendingKey) === task) this.detailInFlight.delete(pendingKey); }
            if (generation === this.lastUpdate) {
                if (Date.now() - startedAt >= 10000) this.log.debug('Slow metadata request', {
                    type, id, durationMs: Date.now() - startedAt, episodes: result?.videos?.length || 0, stages: task.timings
                });
                return result ? structuredClone(result) : null;
            }
        }
        throw new Error('Provider data changed during details loading; retry the request');
    }

    async _getDetailedMetaAsync(id, type, options = {}) {
        const providerLastUpdate = Number(this.lastUpdate) || 0;
        if (type === 'series' || id.startsWith('iptv_series_')) {
            const seriesItem = findCatalogueItemById(this.series, id);
            if (!seriesItem) return null;
            return await this.buildSeriesMeta(seriesItem, options);
        }
        const item = findCatalogueItemById(this.movies, id);
        if (item) {
            const providerModule = require('./src/js/providers/xtreamProvider.js');
            const idCacheKey = 'movie-tmdb:' + id;
            let tmdbId = item.tmdbId || this.seriesInfoCache.get(idCacheKey);
            if (!tmdbId && this.providerName === 'xtream' && !this.config.xtreamUseM3U) {
                tmdbId = await this.resolveMovieTmdbId(id, item, providerModule);
            }
            const sourceStartedAt = Date.now();
            const tmdb = await tmdbMetadata.getMovieMetadata(tmdbId,
                this.detailSourceOptions({ ...item, tmdbId }, options.preview));
            if (options.timings) options.timings.metadataAndTrailersMs = Date.now() - sourceStartedAt;
            if (!tmdb) {
                const fallbackMeta = this.getDetailedMeta(id);
                if (fallbackMeta) fallbackMeta._tmdbId = null;
                await this.persistDetailedCatalogPreview(item.id, 'movie', null, fallbackMeta, {
                    providerLastUpdate,
                    providerFallback: true
                });
                return fallbackMeta;
            }
            // Keep the detailed movie response consistent with the enriched catalogue
            // preview: Stremio needs imdbRating on the returned meta object, not just
            // in the persistent catalogue cache or as a labelled link.
            const omdbStartedAt = Date.now();
            const omdb = tmdb.imdbId ? await this.getDetailOmdbMetadata(tmdb.imdbId, item.id, providerLastUpdate) : null;
            if (options.timings) options.timings.omdbMs = Date.now() - omdbStartedAt;
            const detailedMeta = {
                id: item.id,
                _tmdbId: tmdbId,
                _detailExtras: tmdb._detailExtras,
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
                    ...(omdb?.imdbRating ? [{ name: String(omdb.imdbRating), category: 'imdb', url: 'https://imdb.com/title/' + encodeURIComponent(String(tmdb.imdbId)) }] : []),
                    ...(tmdb.rating ? [{ name: 'TMDb rating: ' + tmdb.rating, category: 'Rating', url: 'https://www.themoviedb.org/movie/' + encodeURIComponent(String(tmdbId)) }] : []),
                    ...(tmdb.links || [])
                ]
            };
            await this.persistDetailedCatalogPreview(item.id, 'movie', tmdbId, detailedMeta, { providerLastUpdate });
            return detailedMeta;
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
                behaviorHints: { isLive: true }
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
    const buildKey = createInterfaceKey(config);
    if (buildPromiseCache.has(buildKey)) {
        return buildPromiseCache.get(buildKey);
    }

    let releasePersistentCacheRegistration = null;
    let buildingAddonInstance = null;
    let buildingInterface = null;
    const buildPromise = (async () => {
        const priorDisposal = addonDisposals.get(cacheKey);
        if (priorDisposal) await priorDisposal.catch(() => {});
        releasePersistentCacheRegistration = cleanupPersistentCacheFiles.registerActiveCache(cacheKey);
        await cleanupPersistentCacheFiles(cacheKey);
        const addonInstance = new M3UEPGAddon(config, manifest);
        buildingAddonInstance = addonInstance;
        addonInstance.releasePersistentCacheRegistration = releasePersistentCacheRegistration;
        releasePersistentCacheRegistration = null;
        await addonInstance.loadFromCache();
        try {
            const savedAvailable = addonInstance.lastUpdate &&
                addonInstance.channels.length + addonInstance.movies.length + addonInstance.series.length > 0;
            if (!addonInstance.lastUpdate || Date.now() - addonInstance.lastUpdate > addonInstance.updateInterval) {
                if (savedAvailable) addonInstance.refreshAfterBuild = true;
                else await requestContext.background(() => addonInstance.updateData(true));
            }
        } catch (e) {
            console.error('[ADDON] Initial update failed:', e && e.name ? e.name : 'Error');
        }
        if (!addonInstance.lastUpdate) throw new Error('Provider catalogue temporarily unavailable');
        addonInstance.buildGenresInManifest();
        // Load the complete persistent metadata index before serving requests, so
        // saved OMDb/TMDb previews are immediately available after a Railway restart.
        // This loads saved data only; it does not wait for network refreshes.
        await addonInstance.persistentCatalogMetaCache.init();
        // Start the full movie/series metadata warm-up as soon as this configured
        // addon is built, rather than waiting for the first Discover request.
        // It is intentionally non-blocking: saved previews remain available while
        // missing or 14-day-due metadata is refreshed in the background.
        if (!addonInstance.refreshAfterBuild) addonInstance.startConfiguredCatalogPrefetch();
        // Keep provider catalogue and guide refreshed every 12 hours even if Stremio is idle
        // after startup. The timer is unref'd so it does not keep Node alive.
        addonInstance.startScheduledRefresh();

        // Only advertise native EPG when this instance has parsed real programme data.
        manifest.behaviorHints.epgProvider = Object.values(addonInstance.epgData || {})
            .some(programmes => Array.isArray(programmes) && programmes.length > 0);

        // Pass the fully populated manifest to builder
        // IMPORTANT: We must ensure 'manifest' object has 'catalogs[].genres' populated BEFORE creating builder
        const builder = new addonBuilder(manifest); 

        const buildCatalogPage = async (args) => {
            const start = Date.now();
            try {
                // Background update
                requestContext.background(() => addonInstance.updateData()).catch(() => { });

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
                const normalizedSearchQuery = extra.search ? getNormalizedSearchText(extra.search) : '';
                const selectedGenre = extra.genre && normalizeGenre(extra.genre) !== 'all channels'
                    ? normalizeGenre(extra.genre)
                    : '';
                const queryCacheKey = createCatalogueQueryCacheKey(normalizedSearchQuery, selectedGenre);
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
                if (!queryCacheHit && selectedGenre) {
                    filtered = getCatalogueGenreIndex(items).groups.get(selectedGenre) || [];
                }
                // Reuse normalized titles from the per-catalogue index, then rank
                // matching cards before pagination so the best results appear first.
                if (!queryCacheHit && normalizedSearchQuery) {
                    const searchIndexResult = getCatalogueSearchIndex(items);
                    const searchIndex = searchIndexResult.index;
                    const scoreTitle = createNormalizedSearchScorer(normalizedSearchQuery);
                    const scores = [1000, 900, 800, 700, 600, 300];
                    const buckets = new Map(scores.map(score => [score, []]));
                    for (const item of filtered) {
                        const indexedTitle = searchIndex.get(item);
                        const score = indexedTitle ? scoreTitle(indexedTitle.text, indexedTitle.words)
                            : scoreTitle(getNormalizedSearchText(item.name));
                        if (score > 0) buckets.get(score).push(item);
                    }
                    filtered = scores.flatMap(score => buckets.get(score));
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
                const skip = extra.skip ? parseInt(extra.skip) : 0;
                const page = filtered.slice(skip, skip + catalogPageSize);

                // Native EPG requests specify a UTC date and expect metasDetailed.
                if (args.type === 'tv' && args.id === 'iptv_channels' && extra.date) {
                    const dateMatch = /^\d{4}-\d{2}-\d{2}$/.test(extra.date);
                    const dateStart = dateMatch ? Date.parse(`${extra.date}T00:00:00.000Z`) : NaN;
                    const validDate = Number.isFinite(dateStart) &&
                        new Date(dateStart).toISOString().slice(0, 10) === extra.date;
                    if (!validDate) return { metasDetailed: [], cacheMaxAge: 300 };

                    if (addonInstance.epgResponseSource !== addonInstance.epgData ||
                        addonInstance.epgResponseGeneration !== addonInstance.lastUpdate) {
                        addonInstance.epgResponseCache.clear();
                        addonInstance.epgResponseSource = addonInstance.epgData;
                        addonInstance.epgResponseGeneration = addonInstance.lastUpdate;
                    }
                    const responseKey = JSON.stringify([extra.date, selectedGenre, normalizedSearchQuery, skip,
                        addonInstance.config.epgOffsetHours]);
                    const guideHit = addonInstance.epgResponseCache.get(responseKey);
                    if (guideHit) return guideHit;

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

                    const epgHandlerMs = Date.now() - start;
                    if (epgHandlerMs >= 10_000) {
                        logAt('debug', '[DEBUG] Slow EPG guide request', {
                            channels: metasDetailed.length,
                            ms: epgHandlerMs
                        });
                    }
                    const response = { metasDetailed, cacheMaxAge: 300, staleRevalidate: 1800, staleError: 604800 };
                    const weight = metasDetailed.reduce((total, meta) => total + 1000 + meta.videos.reduce(
                        (bytes, video) => bytes + 600 + (video.overview?.length || 0) * 2, 0), 0);
                    if (weight < 1024 * 1024) addonInstance.epgResponseCache.set(responseKey, response);
                    return response;
                }

                // Stremio does not reliably refresh cards already rendered in Discover.
                // Enrich every movie/series item in the current page before replying,
                // including search results. Later pages are loaded when the user scrolls.
                // Allow more independent item lookups to overlap. Keep this configurable
                // because some Xtream providers impose stricter request limits.
                const genreMetaConcurrency = parsePositiveInteger(
                    process.env.CATALOG_GENRE_META_CONCURRENCY, 16, 1, 16
                );
                let pagePreviews;
                if (page.length && (args.type === 'movie' || args.type === 'series')) {
                    pagePreviews = await addonInstance.enrichCatalogMetaItems(page, genreMetaConcurrency);
                }

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

                const metas = page.map((i, pageIndex) => {
                    const meta = addonInstance.generateMetaPreview(i);
                    if (i.type === 'tv') {
                        meta.behaviorHints = { isLive: true };
                        meta.posterShape = 'square';
                        return meta;
                    }
                    if (i.type !== 'movie' && i.type !== 'series') return meta;

                    const cached = addonInstance.catalogMetaCache.get(i.id) || pagePreviews?.get?.(String(i.id));
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

                const catalogHandlerMs = Date.now() - start;
                if (catalogHandlerMs >= 10_000) {
                    logAt('debug', '[DEBUG] Slow catalogue request', {
                        type: args.type,
                        returned: metas.length,
                        ms: catalogHandlerMs
                    });
                }
                return { metas };
            } catch (e) {
                if (e?.name !== "AbortError") addonInstance.log.warn("Catalogue loading failed", { errorName: e?.name || "Error" });
                throw new Error("Catalogue temporarily unavailable");
            }
        };

        builder.defineCatalogHandler(async (args) => {
            // A generation change discards old lookups safely, but the response
            // must also be rebuilt so those discarded results cannot yield sparse cards.
            for (let attempt = 0; attempt < 3; attempt++) {
                const generation = addonInstance.lastUpdate;
                const response = await buildCatalogPage(args);
                if (generation === addonInstance.lastUpdate) return response;
            }
            throw new Error('Provider data changed during catalogue loading; retry the request');
        });

        builder.defineStreamHandler(async ({ type, id }) => {
            try {
                const stream = await addonInstance.getStreamAsync(id);
                if (!stream) return { streams: [] };
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

                    const cachedPreview = addonInstance.catalogMetaCache?.get(id);
                    let rating = meta.imdbRating;
                    if (!isValidRating(rating) && isValidRating(cachedPreview?.imdbRating)) {
                        rating = cachedPreview.imdbRating;
                    }

                    // A series detail response can have its rating recovered from the
                    // catalogue cache while its IMDb ID/link is missing from TMDb metadata.
                    // Recover the ID from that same enriched preview and expose the native
                    // IMDb link on the final detail response.
                    const imdbId = String(
                        meta.imdb_id || meta.imdbId ||
                        cachedPreview?.imdb_id || cachedPreview?.imdbId || ''
                    ).trim();
                    if (/^tt\d+$/.test(imdbId)) {
                        meta.imdb_id = imdbId;
                        if (!meta.imdbId) meta.imdbId = imdbId;
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
                    if (/^tt\d+$/.test(imdbId) && isValidRating(rating)) {
                        if (!Array.isArray(meta.links)) meta.links = [];
                        const existingImdbLink = meta.links.some(link =>
                            String(link?.category || '').toLowerCase() === 'imdb' &&
                            /imdb\.com\/title\//i.test(String(link?.url || ''))
                        );
                        if (!existingImdbLink) {
                            meta.links.unshift({
                                name: String(rating),
                                category: 'imdb',
                                url: 'https://imdb.com/title/' + encodeURIComponent(imdbId)
                            });
                        }
                    }
                    return meta;
                };

                if (type === 'series' || id.startsWith('iptv_series_')) {
                    const meta = exposeNativeImdbRating(
                        await addonInstance.getDetailedMetaAsync(id, 'series')
                    );
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
                return { meta };
            } catch (e) {
                addonInstance.log.warn('Metadata loading failed', { errorName: e?.name || 'Error' });
                throw new Error('Metadata temporarily unavailable');
            }
        });

        const iface = builder.getInterface();
        buildingInterface = iface;
        let cacheWeight = addonInstance.estimateMemoryBytes();
        let weightCheckedAt = Date.now(), weightGeneration = addonInstance.lastUpdate;
        Object.defineProperty(iface, '__cacheWeight', {
            get: () => {
                if (Date.now() - weightCheckedAt >= 30000 || weightGeneration !== addonInstance.lastUpdate) {
                    cacheWeight = addonInstance.estimateMemoryBytes();
                    weightCheckedAt = Date.now(); weightGeneration = addonInstance.lastUpdate;
                }
                return cacheWeight;
            },
            enumerable: false,
            configurable: false
        });
        addonInterfaceInstances.set(iface, addonInstance);
        liveInterfaces.add(iface);

        // POST-BUILD: Inject 'options' into each catalog's genre extra entry.
        // This MUST happen after getInterface() because the SDK linter would reject
        // the large options arrays during build. The SDK's shallow manifest copy
        // shares the nested catalogues with our live manifest route. Install even
        // empty options so later provider refreshes can update or clear them.
        for (const catalog of manifest.catalogs) {
            const genreExtra = Array.isArray(catalog.extra)
                ? catalog.extra.find(extra => extra.name === 'genre') : null;
            if (genreExtra) genreExtra.options = [...(catalog.genres || [])];
        }

        if (addonInstance.refreshAfterBuild) setImmediate(() => {
            if (addonInstance.disposed) return;
            requestContext.background(() => addonInstance.updateData())
                .catch(error => addonInstance.log.warn("Startup provider refresh failed", error?.name || "Error"))
                .finally(() => addonInstance.startConfiguredCatalogPrefetch());
        });
        return iface;
    })().catch(async (error) => {
        if (buildingInterface) { addonInterfaceInstances.delete(buildingInterface); liveInterfaces.delete(buildingInterface); }
        if (buildingAddonInstance) await buildingAddonInstance.dispose().catch(() => {});
        if (releasePersistentCacheRegistration) releasePersistentCacheRegistration();
        throw error;
    });

    buildPromiseCache.set(buildKey, buildPromise);
    try {
        const iface = await buildPromise;
        return iface;
    } finally {
        // Coalesce concurrent builds, but don't retain completed promises forever.
        if (buildPromiseCache.get(buildKey) === buildPromise) {
            buildPromiseCache.delete(buildKey);
        }
    }
}

module.exports = createAddon;
module.exports.createCacheKey = createCacheKey;
module.exports.closeRedisClient = async function closeRedisClient() {
    if (!redisClient) return;
    const client = redisClient;
    redisClient = null;
    try {
        if (client.status === 'ready') await withTimeout(client.quit(), 1000, 'Redis shutdown timed out');
        else client.disconnect();
    } catch {
        client.disconnect();
    }
};
module.exports.createInterfaceKey = createInterfaceKey;
module.exports.acquireAddonInterface = function acquireAddonInterface(iface) {
    const addon = addonInterfaceInstances.get(iface);
    return addon ? addon.acquireRequest() : false;
};
module.exports.releaseAddonInterface = function releaseAddonInterface(iface) {
    const addon = addonInterfaceInstances.get(iface);
    if (addon) addon.releaseRequest();
};
module.exports.disposeAddonInterface = async function disposeAddonInterface(iface) {
    const addon = addonInterfaceInstances.get(iface);
    if (!addon) return;
    const disposal = addon.dispose();
    addonDisposals.set(addon.cacheKey, disposal);
    try {
        await disposal;
    } finally {
        addonInterfaceInstances.delete(iface);
        liveInterfaces.delete(iface);
        if (addonDisposals.get(addon.cacheKey) === disposal) addonDisposals.delete(addon.cacheKey);
    }
};
module.exports.flushAddonDisposals = async function flushAddonDisposals() {
    const results = await Promise.allSettled([...addonDisposals.values()]);
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Addon disposal failed');
};
module.exports.M3UEPGAddon = M3UEPGAddon;
module.exports.getActiveInterfaceCount = () => liveInterfaces.size;
module.exports.flushActiveAddonCaches = () => Promise.allSettled([...liveInterfaces].map(iface =>
    addonInterfaceInstances.get(iface)?.flushPersistentStores()));
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
