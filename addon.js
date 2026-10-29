// IPTV Stremio Addon Core (with debug logging + series (shows) support for BOTH Xtream & Direct M3U)
// Version 1.4.0: Adds Direct M3U series grouping + per‑episode streams
require('dotenv').config({ quiet: true });

const { createLogger, isDebugEnabled, logAt } = require('./logger');

const { addonBuilder } = require("stremio-addon-sdk");
const crypto = require("crypto");
const LRUCache = require("./lruCache");
const PersistentCatalogMetaCache = require("./persistentCatalogMetaCache");
const PersistentAddonDataCache = require("./persistentAddonDataCache");
const PersistentSeriesInfoCache = require("./persistentSeriesInfoCache");
const cleanupPersistentCacheFiles = require("./persistentCacheMaintenance");
const tmdbMetadata = require("./src/js/tmdbMetadata");
const omdbMetadata = require("./src/js/omdbMetadata");
const { parseRuntimeMinutes, providerEpisodes, providerEpisodeFingerprint, averageProviderEpisodes } = require("./seriesRuntime");
const xtreamRequests = require('./xtreamRequests');

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

function omdbMetadataNeedsRefresh(value) {
    if (!value || !value.imdbId) return false;
    if (value.imdbRating && value.runtime) return false;
    // Coordinate OMDb and general catalogue retries. If a recent catalogue
    // attempt already tried available sources, don't let an older OMDb timestamp
    // bypass the shared 12-hour backoff on the next card request.
    const checkedAt = Math.max(
        Number(value.omdbCheckedAt) || 0,
        Number(value.missingMetadataCheckedAt) || 0,
        Number(value.metadataCheckedAt) || 0
    );
    return !checkedAt || Date.now() - checkedAt >= OMDB_MISSING_DATA_RETRY_MS;
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

function catalogMetadataNeedsRefresh(value) {
    const missing = missingCatalogMetadataFields(value);
    if (!missing.length) return false;
    // Keep missing-field retry timing separate from the normal metadata
    // refresh timestamp. Older persisted entries migrate via metadataCheckedAt.
    const checkedAt = Number(value.missingMetadataCheckedAt) ||
        Number(value.metadataCheckedAt) || 0;
    return !checkedAt || Date.now() - checkedAt >= OMDB_MISSING_DATA_RETRY_MS;
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
        const sameScope = (old.runtimeAverage?.version === 1 && fresh.runtimeAverage?.version === 1) ||
            (old.runtimeAverage?.version === 2 && fresh.runtimeAverage?.version === 2 &&
                old.runtimeAverage?.episodeFingerprint === fresh.runtimeAverage?.episodeFingerprint);
        const lowerPriority = sameScope && ['tmdb-episodes', 'mixed-episodes'].includes(old.runtimeAverage?.source) &&
            fresh.runtimeAverage?.source === 'provider-episodes';
        const acceptedUpdate = hasDerivedSeriesRuntime(old) && !lowerPriority &&
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
    return value?.type === 'series' && [1, 2].includes(value.runtimeAverage?.version) &&
        parseRuntimeMinutes(value.runtime) !== null && value.runtimeAverage.runtime === value.runtime;
}

function providerRuntimeScopeIsValid(average) {
    return average?.version === 2 && average.scope === 'provider-episodes' &&
        typeof average.episodeFingerprint === 'string' && /^[a-f0-9]{64}$/.test(average.episodeFingerprint);
}

function isProviderQuotaFailure(failure) {
    return failure?.httpStatus === 429 && /^provider_/.test(failure.reason || '');
}

function seriesRuntimeAverageNeedsRefresh(value, providerLastUpdate = null) {
    if (value?.type !== 'series') return false;
    if (parseRuntimeMinutes(value.runtime) !== null && !hasDerivedSeriesRuntime(value)) return false;
    const average = value.runtimeAverage;
    // A provider quota response is temporary, not evidence that a duration is
    // unavailable. Older 429 records get one retry under the new shared pacing.
    if (isProviderQuotaFailure(average?.lastFailure)) {
        return !(Number(average.lastFailure.retryAt) > Date.now());
    }
    const attemptedGeneration = Number(average?.attemptProviderLastUpdate ?? average?.providerLastUpdate);
    if (providerLastUpdate !== null && attemptedGeneration !== Number(providerLastUpdate)) return true;
    if (!providerRuntimeScopeIsValid(average)) {
        if (average?.lookupRevision !== 1) return true;
        const attemptedAt = Number(average?.scopeMigrationAttemptedAt) || 0;
        return !attemptedAt || Date.now() - attemptedAt >= OMDB_MISSING_DATA_RETRY_MS;
    }
    const checkedAt = Number(average.attemptedAt) || Number(average.checkedAt) || 0;
    return !checkedAt || Date.now() - checkedAt >= OMDB_MISSING_DATA_RETRY_MS;
}

function providerRuntimeRecord(result, tmdbId, providerLastUpdate, now = Date.now()) {
    return {
        version: 2, scope: 'provider-episodes', lookupRevision: 1, runtime: result.runtime, source: result.source,
        episodeFingerprint: result.episodeFingerprint, providerEpisodeCount: result.providerEpisodeCount,
        episodeCount: result.episodeCount, totalMinutes: result.totalMinutes,
        tmdbEpisodeCount: result.tmdbEpisodeCount || 0, providerDurationCount: result.providerDurationCount || 0,
        missingDurationCount: result.missingDurationCount || 0,
        complete: result.complete === true, checkedAt: now, attemptedAt: now,
        tmdbId: tmdbId ? String(tmdbId) : null, providerLastUpdate, attemptProviderLastUpdate: providerLastUpdate,
        ...(Array.isArray(result.seasons) ? { seasons: result.seasons } : {})
    };
}

function compactRuntimeFailure(reason, details = {}) {
    details = details && typeof details === 'object' ? details : {};
    const safeWord = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
    const failure = { reason: safeWord(reason) ? reason : 'runtime_lookup_failed' };
    if (Number.isInteger(details.httpStatus) && details.httpStatus >= 100 && details.httpStatus <= 599) failure.httpStatus = details.httpStatus;
    if (safeWord(details.errorName)) failure.errorName = details.errorName;
    if (safeWord(details.errorCode)) failure.errorCode = details.errorCode;
    if (details.httpStatus === 429 && Number.isSafeInteger(details.retryAt) && details.retryAt > 0) failure.retryAt = details.retryAt;
    return failure;
}

function runtimeFailureLabel(details) {
    const failure = compactRuntimeFailure(details?.reason || 'not_recorded', details);
    return failure.reason + (failure.httpStatus ? ':' + failure.httpStatus : '') +
        (failure.errorCode ? ':' + failure.errorCode : '');
}

function countLookupReason(counts, details) {
    const label = runtimeFailureLabel(details);
    counts[label] = (counts[label] || 0) + 1;
}

function createSeriesRuntimeSummary() {
    return {
        seriesLevel: 0, tmdbEpisodeAverage: 0, providerEpisodeAverage: 0, mixedEpisodeAverage: 0, legacyScope: 0,
        missing: 0, retainedAfterFailedRefresh: 0, retryDue: 0, missingRetryDeferred: 0
    };
}

function countSeriesRuntime(summary, value, providerLastUpdate = null) {
    const present = parseRuntimeMinutes(value?.runtime) !== null;
    const derived = hasDerivedSeriesRuntime(value);
    if (!present) summary.missing++;
    else if (derived && value.runtimeAverage.source === 'tmdb-episodes') summary.tmdbEpisodeAverage++;
    else if (derived && value.runtimeAverage.source === 'provider-episodes') summary.providerEpisodeAverage++;
    else if (derived && value.runtimeAverage.source === 'mixed-episodes') summary.mixedEpisodeAverage++;
    else summary.seriesLevel++;
    const average = value?.runtimeAverage;
    if (derived && !providerRuntimeScopeIsValid(average)) {
        summary.legacyScope++;
        summary.legacyFailureReasons ||= {};
        countLookupReason(summary.legacyFailureReasons, average.lastFailure);
        summary.legacyExamples ||= [];
        if (summary.legacyExamples.length < 5) summary.legacyExamples.push({
            id: String(value.id || ''), name: String(value.name || '').slice(0, 120),
            runtime: value.runtime, ...compactRuntimeFailure(average.lastFailure?.reason || 'not_recorded', average.lastFailure)
        });
    }
    if (derived && Number(average.attemptedAt) > Number(average.checkedAt)) summary.retainedAfterFailedRefresh++;
    if (average?.lastFailure || Number(average?.attemptedAt) > Number(average?.checkedAt)) {
        summary.lookupFailureReasons ||= {};
        countLookupReason(summary.lookupFailureReasons, average?.lastFailure);
    }
    if (!value || seriesRuntimeAverageNeedsRefresh(value, providerLastUpdate)) summary.retryDue++;
    else if (!present) summary.missingRetryDeferred++;
}

function getCatalogMetadataWarmupState(value, providerLastUpdate = null) {
    const missingFields = value ? missingCatalogMetadataFields(value) : ['preview'];
    const nameMissing = !String(value?.name || '').trim();
    const metadataVersionOld = Boolean(value) && !(Number(value.metadataVersion) >= 3);
    const imdbIdLookupPending = Boolean(value?._tmdbId && !value?.imdbId && value?.imdbIdChecked !== true);
    const omdbRetryDue = omdbMetadataNeedsRefresh(value);
    const catalogRetryDue = catalogMetadataNeedsRefresh(value);
    const incomplete = !value || nameMissing || metadataVersionOld || imdbIdLookupPending || missingFields.length > 0;
    const retryDue = !value || nameMissing ||
        ((metadataVersionOld || imdbIdLookupPending) && catalogMetadataRefreshAttemptIsDue(value)) ||
        omdbRetryDue || catalogRetryDue || seriesRuntimeAverageNeedsRefresh(value, providerLastUpdate);
    return { missingFields, incomplete, retryDue };
}

function catalogMetadataRefreshAttemptIsDue(value) {
    const attemptedAt = Number(value?.metadataRefreshAttemptedAt) || 0;
    return !attemptedAt || Date.now() - attemptedAt >= CATALOG_METADATA_FAILURE_RETRY_MS;
}

function catalogMetadataNormalRefreshIsDue(value, savedAt = 0) {
    const refreshInterval = parsePositiveInteger(
        process.env.CATALOG_METADATA_REFRESH_MS, 14 * 24 * 60 * 60 * 1000,
        60 * 60 * 1000, 90 * 24 * 60 * 60 * 1000
    );
    const timestamp = Number(value?.metadataCheckedAt) || Number(savedAt) || 0;
    return catalogMetadataRefreshAttemptIsDue(value) && (
        !String(value?.name || '').trim() ||
        !(Number(value?.metadataVersion) >= 3) ||
        (value?._tmdbId && !value?.imdbId && value?.imdbIdChecked !== true) ||
        Date.now() - timestamp >= refreshInterval
    );
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
 * Apostrophes are ignored, while other punctuation/symbols become spaces.
 * This makes "it's" and "its", and hyphenated/unhyphenated titles, equivalent.
 */
function normalizeSearchText(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()
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
    const orderedQueryWords = [...queryWords].sort((a, b) => b.length - a.length);
    const used = new Set();

    function assign(index) {
        if (index >= orderedQueryWords.length) return true;
        const queryWord = orderedQueryWords[index];
        for (let i = 0; i < titleWords.length; i++) {
            if (used.has(i)) continue;
            const titleWord = titleWords[i];
            if (allowPrefix ? !titleWord.startsWith(queryWord) : titleWord !== queryWord) continue;
            used.add(i);
            if (assign(index + 1)) return true;
            used.delete(i);
        }
        return false;
    }

    return assign(0);
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

const DEBUG_ENV = isDebugEnabled();
function makeLogger(cfgDebug) {
    return createLogger(!!cfgDebug);
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

async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(items.length, Math.max(1, concurrency));
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await mapper(items[index], index);
        }
    }));
    return results;
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
const addonDisposals = new Map();

// Multiple configuration tokens can create separate addon instances for the same
// provider account. Keep refresh timestamps and scheduled jobs shared by provider
// cache key so those instances do not repeatedly refresh from stale local clocks.
const providerRefreshState = new Map();
const providerRefreshInFlight = new Map();

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
        // Keep a small parallel diagnostic cache without consuming slots from the
        // bounded series-info LRU.
        this.seriesTmdbLookupDiagnostics = new Map();
        // Coalesce overlapping Xtream ID and series-info lookups started by parallel
        // Discover workers, avoiding duplicate provider API round-trips.
        this.providerInfoInFlight = new Map();
        // Cached catalogue enrichment lets later home/search requests return
        // rich cards without waiting on TMDb/Xtream for every item.
        this.catalogMetaCache = new LRUCache({
            max: parsePositiveInteger(process.env.CATALOG_META_CACHE_MAX, 1000, 50, 5000),
            ttl: parsePositiveInteger(process.env.CATALOG_META_MEMORY_TTL_MS, 6 * 3600 * 1000, 1000, 30 * 24 * 3600 * 1000)
        });
        this.catalogMetaPending = new Map();
        this.persistentCatalogMetaCache = new PersistentCatalogMetaCache(this.cacheKey);
        this.catalogMetaStaleFallbacks = new Set();
        // At most one full-catalogue warm-up per media type. Search requests must not
        // spawn independent background walks over different filtered result sets.
        this.catalogPrefetchJobs = new Map();
        this.catalogPrefetchResumeTimers = new Map();
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
        this.seriesRuntimeInFlight = new Map();
        // Retain compact lookup-failure reasons for the warm-up summary.
        this.catalogMetaLookupDiagnostics = new Map();
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
        return 4 * 1024 * 1024 +
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

    async dispose() {
        if (this.disposePromise) return this.disposePromise;
        this.disposed = true;
        for (const timer of this.catalogPrefetchResumeTimers.values()) clearTimeout(timer);
        this.catalogPrefetchResumeTimers.clear();
        xtreamRequests.cancel(this);
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
        this.disposePromise = (async () => {
            if (this.activeRequestCount > 0) {
                this.activeRequestDrainPromise = new Promise(resolve => {
                    this.activeRequestDrainResolve = resolve;
                });
                await this.activeRequestDrainPromise;
            }
            const refresh = providerRefreshInFlight.get(this.cacheKey);
            if (refresh) await Promise.allSettled([refresh]);
            const jobs = [...this.catalogPrefetchJobs.values()];
            await Promise.allSettled(jobs);
            while (this.catalogMetaPersistWrites.size) {
                await Promise.allSettled([...this.catalogMetaPersistWrites]);
            }
            await Promise.allSettled([
                this.persistentAddonDataCache.flush(),
                this.persistentCatalogMetaCache.flush(),
                this.persistentSeriesInfoCache.flush()
            ]);
            providerRefreshState.delete(this.cacheKey);
            if (typeof this.releasePersistentCacheRegistration === "function") {
                this.releasePersistentCacheRegistration();
                this.releasePersistentCacheRegistration = null;
            }
        })();
        return this.disposePromise;
    }
    async loadFromCache() {
        const cacheKey = 'addon:data:' + this.cacheKey;
        // CACHE_ENABLED controls the in-memory/Redis layers only. A configured
        // persistent snapshot must still be loaded when those layers are disabled,
        // otherwise a saved last-good catalogue would be ignored on every restart.
        let cached = CACHE_ENABLED ? dataCache.get(cacheKey) : null;
        if (CACHE_ENABLED && !cached && redisClient) {
            cached = await redisGetJSON(cacheKey);
            if (cached) dataCache.set(cacheKey, cached);
        }
        if (!cached) {
            cached = await this.persistentAddonDataCache.load();
            if (cached) {
                if (CACHE_ENABLED) dataCache.set(cacheKey, cached);
                this.log.info('Loaded provider catalogue and EPG from persistent storage');
            }
        }
        if (cached) {
            this.channels = cached.channels || [];
            this.movies = cached.movies || [];
            this.series = cached.series || [];
            this.epgData = cached.epgData || {};
            this.lastUpdate = cached.lastUpdate || 0;
            this.pendingRemovalCandidates = cached.pendingRemovalCandidates && typeof cached.pendingRemovalCandidates === 'object'
                ? cached.pendingRemovalCandidates : {};

            // Direct-M3U episode URLs and IDs are not derivable from the series
            // summaries alone, so persist and restore the episode lists themselves.
            if (this.providerName === 'direct') {
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
            lastUpdate: this.lastUpdate,
            directSeriesEpisodes: Object.fromEntries(this.directSeriesEpisodeIndex.entries()),
            pendingRemovalCandidates: this.pendingRemovalCandidates
        };
        dataCache.set(cacheKey, entry);
        try {
            await redisSetJSON(cacheKey, entry, CACHE_TTL_MS);
        } catch (error) {
            // Redis is an optional acceleration layer; a failed Redis write must
            // not turn a valid provider refresh into an in-memory rollback.
            this.log.warn('Redis provider snapshot save failed', error?.name || 'Error');
        }
        try {
            const persisted = await this.persistentAddonDataCache.save(entry);
            if (persisted) this.log.debug('Persisted provider catalogue and EPG snapshot');
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

    async ensureSeriesTmdbId(seriesId, lookupDiagnostics = null, forceRefresh = false) {
        const setLookup = details => {
            if (lookupDiagnostics && details && typeof details === 'object') Object.assign(lookupDiagnostics, details);
        };
        if (!seriesId) {
            setLookup({ reason: 'provider_series_id_missing', source: 'provider_lookup' });
            return null;
        }
        const normalizedSeriesId = String(seriesId);
        xtreamRequests.promote(this, normalizedSeriesId);
        const providerLastUpdate = Number(this.lastUpdate) || 0;
        const isCurrent = () => this.isProviderSeriesCurrent(normalizedSeriesId, providerLastUpdate);
        const staleLookup = () => {
            setLookup({ reason: 'provider_catalogue_changed', source: 'provider_lookup' });
            return null;
        };
        if (!isCurrent()) return staleLookup();
        const cacheKey = 'series-tmdb-id:' + normalizedSeriesId;
        const cacheLookup = details => {
            if (!isCurrent()) return;
            this.seriesTmdbLookupDiagnostics.delete(normalizedSeriesId);
            this.seriesTmdbLookupDiagnostics.set(normalizedSeriesId, details);
            while (this.seriesTmdbLookupDiagnostics.size > 100) {
                this.seriesTmdbLookupDiagnostics.delete(this.seriesTmdbLookupDiagnostics.keys().next().value);
            }
        };
        const cached = this.seriesInfoCache.get(cacheKey);
        if (!forceRefresh && cached !== undefined) {
            setLookup(this.seriesTmdbLookupDiagnostics.get(normalizedSeriesId) || {
                reason: cached ? 'provider_tmdb_id_cached' : 'provider_tmdb_id_cached_unknown',
                source: 'memory_cache'
            });
            return cached;
        }
        if (!forceRefresh && this.providerName === 'xtream') {
            const persisted = await this.persistentSeriesInfoCache.get(normalizedSeriesId, providerLastUpdate);
            if (!isCurrent()) return staleLookup();
            if (persisted?.fresh) {
                const tmdbId = persisted.value.tmdbId || null;
                const details = {
                    reason: tmdbId ? 'provider_tmdb_id_found' : 'provider_tmdb_id_missing',
                    source: 'persistent_provider_cache'
                };
                this.cacheSeriesInfo(normalizedSeriesId, persisted.value);
                this.seriesInfoCache.set(cacheKey, tmdbId);
                cacheLookup(details);
                setLookup(details);
                return tmdbId;
            }
        }
        const pendingKey = 'series-tmdb-id:' + providerLastUpdate + ':' + normalizedSeriesId;
        const pending = this.providerInfoInFlight.get(pendingKey);
        if (pending) {
            const tmdbId = await pending;
            if (!isCurrent()) return staleLookup();
            setLookup(this.seriesTmdbLookupDiagnostics.get(normalizedSeriesId) || {
                reason: tmdbId ? 'provider_tmdb_id_found' : 'provider_tmdb_id_lookup_in_flight',
                source: 'provider_lookup'
            });
            return tmdbId;
        }
        const task = (async () => {
            const details = { source: 'provider_lookup' };
            try {
                const providerModule = require('./src/js/providers/' + this.providerName + 'Provider.js');
                let tmdbId = null;
                if (typeof providerModule.fetchSeriesTmdbId === 'function') {
                    tmdbId = await providerModule.fetchSeriesTmdbId(this, seriesId, details);
                } else {
                    const info = await this.ensureSeriesInfo(seriesId);
                    tmdbId = info?.tmdbId || null;
                    if (info?.fetchError) {
                        details.reason = 'provider_series_info_request_error';
                        const status = String(info.fetchError).match(/\bHTTP\s+(\d{3})\b/i);
                        if (status) details.httpStatus = Number(status[1]);
                    } else {
                        details.reason = tmdbId ? 'provider_tmdb_id_found' : 'provider_tmdb_id_missing';
                    }
                }
                if (!isCurrent()) return staleLookup();
                if (!details.reason) details.reason = tmdbId ? 'provider_tmdb_id_found' : 'provider_tmdb_id_missing';
                if (details.httpStatus === 429) throw new xtreamRequests.XtreamRateLimitError(details.retryAt);
                tmdbId = tmdbId || null;
                this.seriesInfoCache.set(cacheKey, tmdbId);
                cacheLookup(details);
                setLookup(details);
                return tmdbId;
            } catch (error) {
                if (xtreamRequests.isXtreamRateLimitError(error)) throw error;
                if (!isCurrent()) return staleLookup();
                const details = {
                    reason: 'provider_tmdb_id_lookup_error',
                    source: 'provider_lookup',
                    errorName: error?.name || 'Error'
                };
                this.log.warn('Series TMDb ID lookup failed', seriesId, details.errorName);
                this.seriesInfoCache.set(cacheKey, null);
                cacheLookup(details);
                setLookup(details);
                return null;
            }
        })();
        this.providerInfoInFlight.set(pendingKey, task);
        try {
            return await task;
        } finally {
            if (this.providerInfoInFlight.get(pendingKey) === task) this.providerInfoInFlight.delete(pendingKey);
        }
    }

    cacheSeriesInfo(seriesId, info, ttl = CACHE_TTL_MS) {
        this.seriesInfoCache.set(seriesId, info, ttl);
        if (Array.isArray(info?.videos)) {
            for (const video of info.videos) {
                if (!video?.id || !video.url) continue;
                const id = String(video.id);
                this.seriesEpisodeCache.delete(id);
                this.seriesEpisodeCache.set(id, {
                    video,
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
        xtreamRequests.promote(this, normalizedSeriesId);
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
                    if (info?.fetchError) {
                        const rateLimited = info.fetchError === 'HTTP 429';
                        const retryTtl = rateLimited
                            ? Math.max(1000, (Number(info.retryAt) || Date.now() + 60000) - Date.now())
                            : SERIES_INFO_FAILURE_RETRY_MS;
                        if (!rateLimited) this.log.warn('Series info request failed; retaining saved details when available', {
                            seriesId: normalizedSeriesId,
                            status: /^HTTP \d{3}$/i.test(String(info.fetchError)) ? String(info.fetchError) : undefined,
                            errorName: info.errorName || 'Error',
                            errorCode: info.errorCode
                        });
                        if (persisted?.value) {
                            this.cacheSeriesInfo(normalizedSeriesId, persisted.value, retryTtl);
                            return persisted.value;
                        }
                        this.cacheSeriesInfo(normalizedSeriesId, info, retryTtl);
                        return info;
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
        for (const id of this.catalogMetaLookupDiagnostics.keys()) {
            if (!currentCatalogIds.has(String(id)) || changedCatalogIds.has(String(id))) this.catalogMetaLookupDiagnostics.delete(id);
        }
        // Provider refreshes may add or remove episodes for an existing series.
        // Drop process-local episode details so the next open uses the new listing.
        // Cached stream URLs belong to the provider snapshot that just expired.
        this.seriesEpisodeCache.clear();
        this.seriesTmdbLookupDiagnostics.clear();
        const seriesKeysToInvalidate = new Set([
            ...(Array.isArray(previous.series) ? previous.series : []).map(getProviderSeriesKey),
            ...this.series.map(getProviderSeriesKey)
        ].filter(Boolean));
        for (const seriesKey of seriesKeysToInvalidate) {
            this.seriesInfoCache.delete(seriesKey);
            this.seriesInfoCache.delete('series-tmdb-id:' + seriesKey);
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

        const refreshPromise = this._updateData(force);
        providerRefreshInFlight.set(this.cacheKey, refreshPromise);
        try {
            await refreshPromise;
        } finally {
            if (providerRefreshInFlight.get(this.cacheKey) === refreshPromise) {
                providerRefreshInFlight.delete(this.cacheKey);
            }
        }
    }

    async _updateData(force = false) {
        const now = Date.now();
        if (!force) {
            if (this.lastUpdate && now - this.lastUpdate < this.updateInterval) return;
            if ((this.channels.length || this.movies.length || this.series.length) && now - this.lastUpdate < 900000) return;
        }

        const previous = {
            channels: this.channels,
            movies: this.movies,
            series: this.series,
            epgData: this.epgData,
            lastUpdate: this.lastUpdate,
            directSeriesEpisodeIndex: this.directSeriesEpisodeIndex,
            directSeriesEpisodeById: this.directSeriesEpisodeById,
            pendingRemovalCandidates: this.pendingRemovalCandidates
        };
        // Providers build into an isolated object so requests continue seeing the
        // last complete snapshot while slow network fetches and parsers run.
        const refreshed = Object.assign(Object.create(this), {
            channels: [],
            movies: [],
            series: this.config.includeSeries === false ? previous.series : [],
            epgData: {},
            epgRefreshFailed: false,
            directSeriesEpisodeIndex: new Map(),
            directSeriesEpisodeById: new Map()
        });

        try {
            const start = Date.now();
            const providerModule = require(`./src/js/providers/${this.providerName}Provider.js`);
            await providerModule.fetchData(refreshed);

            // Accept ordinary removals immediately. Major or empty sections need
            // matching observations before replacing the last-known-good catalogue.
            const removalCandidates = { ...(previous.pendingRemovalCandidates || {}) };
            const unconfirmedDrops = [];
            const providerConfirmations = parsePositiveInteger(
                process.env.PROVIDER_REMOVAL_CONFIRMATIONS, 2, 2, 5
            );
            for (const section of ['channels', 'movies', 'series']) {
                const stats = getSectionRemovalStats(previous[section], refreshed[section]);
                const guardedDrop = stats.largeDrop || (stats.previousCount > 0 && stats.currentCount === 0);
                if (guardedDrop) {
                    const ids = (Array.isArray(refreshed[section]) ? refreshed[section] : [])
                        .filter(item => item && item.id != null)
                        .map(item => String(item.id))
                        .sort();
                    const fingerprint = crypto.createHash('sha256').update(ids.join('\n')).digest('hex');
                    const prior = removalCandidates[section];
                    const confirmations = prior?.fingerprint === fingerprint
                        ? Math.min(providerConfirmations, (Number(prior.confirmations) || 1) + 1)
                        : 1;
                    removalCandidates[section] = { fingerprint, confirmations, observedAt: Date.now() };
                    if (confirmations < providerConfirmations) {
                        unconfirmedDrops.push({
                            section,
                            removedCount: stats.removedCount,
                            previousCount: stats.previousCount,
                            currentCount: stats.currentCount,
                            removedPercent: Number(stats.removedPercent.toFixed(1))
                        });
                    }
                } else {
                    delete removalCandidates[section];
                }
            }

            if (unconfirmedDrops.length) {
                this.pendingRemovalCandidates = removalCandidates;
                this.log.warn('Provider catalogue reduction needs one matching refresh before acceptance', {
                    sections: unconfirmedDrops,
                    requiredMatchingRefreshes: providerConfirmations
                });
                if (CACHE_ENABLED) await this.saveToCache();
                else {
                    try {
                        await this.persistentAddonDataCache.save({
                            channels: this.channels,
                            movies: this.movies,
                            series: this.series,
                            epgData: this.epgData,
                            lastUpdate: this.lastUpdate,
                            directSeriesEpisodes: Object.fromEntries(this.directSeriesEpisodeIndex.entries()),
                            pendingRemovalCandidates: this.pendingRemovalCandidates
                        });
                    } catch (error) {
                        this.log.warn('Persistent removal confirmation state save failed', error?.name || 'Error');
                    }
                }
                return;
            }

            for (const section of ['channels', 'movies', 'series']) {
                const stats = getSectionRemovalStats(previous[section], refreshed[section]);
                if (stats.removedCount > 0) {
                    this.log.info('Provider catalogue items removed', {
                        section,
                        removedCount: stats.removedCount,
                        previousCount: stats.previousCount,
                        currentCount: stats.currentCount
                    });
                }
            }

            // Keep the last-known-good guide if an optional EPG refresh is empty.
            const hasNewEpg = Object.values(refreshed.epgData || {}).some(
                programmes => Array.isArray(programmes) && programmes.length > 0
            );
            const hadPreviousEpg = Object.values(previous.epgData || {}).some(
                programmes => Array.isArray(programmes) && programmes.length > 0
            );
            if (this.config.enableEpg && hadPreviousEpg && (refreshed.epgRefreshFailed || !hasNewEpg)) {
                refreshed.epgData = previous.epgData;
                this.log.warn(refreshed.epgRefreshFailed
                    ? 'EPG refresh incomplete; retaining last-known-good guide'
                    : 'EPG refresh returned no programmes; retaining last-known-good guide');
            } else if (this.config.enableEpg && refreshed.epgRefreshFailed) {
                this.log.warn('EPG refresh incomplete; using available programmes until the next refresh');
            }

            const previousHadCatalogue = previous.channels.length + previous.movies.length + previous.series.length > 0;
            const currentHasCatalogue = refreshed.channels.length + refreshed.movies.length + refreshed.series.length > 0;
            if (previousHadCatalogue && !currentHasCatalogue) {
                this.log.warn('Provider refresh returned an empty catalogue; retaining the previous catalogue');
                throw new Error('Provider refresh returned an empty catalogue; retaining previous data');
            }

            // Commit the whole validated snapshot together. No request can observe
            // the empty/partially populated arrays used during provider fetching.
            this.channels = refreshed.channels;
            this.movies = refreshed.movies;
            this.series = refreshed.series;
            this.epgData = refreshed.epgData;
            this.directSeriesEpisodeIndex = refreshed.directSeriesEpisodeIndex;
            this.directSeriesEpisodeById = refreshed.directSeriesEpisodeById;
            this.pendingRemovalCandidates = {};
            this.lastUpdate = Math.max(Date.now(), (Number(previous.lastUpdate) || 0) + 1);
            providerRefreshState.set(this.cacheKey, this.lastUpdate);

            // Build user-facing catalogue metadata before saving the refreshed
            // snapshot. If this fails, the previous persistent snapshot stays intact.
            this.buildGenresInManifest();
            await this.pruneRemovedCatalogState(previous);
            if (CACHE_ENABLED) await this.saveToCache();
            else {
                try {
                    await this.persistentAddonDataCache.save({
                        channels: this.channels,
                        movies: this.movies,
                        series: this.series,
                        epgData: this.epgData,
                        lastUpdate: this.lastUpdate,
                        directSeriesEpisodes: Object.fromEntries(this.directSeriesEpisodeIndex.entries()),
                        pendingRemovalCandidates: this.pendingRemovalCandidates
                    });
                } catch (error) {
                    this.log.warn('Persistent provider data save failed', {
                        name: error?.name || 'Error', code: error?.code || 'UNKNOWN',
                        syscall: error?.syscall || null,
                        message: String(error?.message || 'No error message').slice(0, 300)
                    });
                }
            }
            this.log.info('Provider data refresh complete', {
                channels: this.channels.length,
                movies: this.movies.length,
                series: this.series.length,
                epgChannels: Object.keys(this.epgData || {}).length,
                epgProgrammes: Object.values(this.epgData || {}).reduce(
                    (total, programmes) => total + (Array.isArray(programmes) ? programmes.length : 0), 0
                ),
                durationMs: Date.now() - start
            });
        } catch (error) {
            // Before the commit point, live data is untouched. If an unexpected
            // post-commit failure occurs, restore the prior in-memory snapshot.
            this.channels = previous.channels;
            this.movies = previous.movies;
            this.series = previous.series;
            this.epgData = previous.epgData;
            this.lastUpdate = previous.lastUpdate;
            this.directSeriesEpisodeIndex = previous.directSeriesEpisodeIndex;
            this.directSeriesEpisodeById = previous.directSeriesEpisodeById;
            this.pendingRemovalCandidates = previous.pendingRemovalCandidates;
            providerRefreshState.set(this.cacheKey, previous.lastUpdate || 0);
            this.log.error('[UPDATE] Failed; retaining last-known-good data:', {
                name: error?.name || 'Error',
                message: String(error?.message || 'No error message')
                    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted URL]')
                    .replace(/((?:username|password|token|api[_-]?key)=)[^&\s]+/gi, '$1[redacted]')
                    .slice(0, 240),
                code: typeof error?.code === 'string' ? error.code : null
            });
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
            if (lastSuccessfulRefresh && Date.now() - lastSuccessfulRefresh < this.updateInterval) {
                this.lastUpdate = lastSuccessfulRefresh;
                this.startConfiguredCatalogPrefetch();
                return;
            }
            this.log.debug('Scheduled provider refresh is due', {
                lastSuccessfulRefresh: lastSuccessfulRefresh ? new Date(lastSuccessfulRefresh).toISOString() : null,
                intervalHours: this.updateInterval / (60 * 60 * 1000)
            });
            this.scheduledRefreshInFlight = this.updateData(true)
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
        let preview = itemId ? this.catalogMetaCache.get(itemId) : null;
        if (!preview && itemId) {
            const persisted = await this.persistentCatalogMetaCache.get(String(itemId));
            if (persisted?.value && this.isCatalogItemCurrent(String(itemId), providerLastUpdate)) {
                preview = this.catalogMetaCache.get(String(itemId)) || persisted.value;
                this.catalogMetaCache.set(String(itemId), preview);
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
            const refreshed = await omdbMetadata.getByImdbId(imdbId, { refreshIncomplete: true });
            const latestPreview = this.catalogMetaCache.get(String(itemId));
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
                omdbCheckedAt: result.omdbCheckedAt
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
        xtreamRequests.promote(this, getProviderSeriesKey(seriesItem));
        const current = this.catalogMetaCache.get(id) || preview;
        if (!seriesRuntimeAverageNeedsRefresh(current, providerLastUpdate)) return current;
        const key = providerLastUpdate + ':' + id;
        if (this.seriesRuntimeInFlight.has(key)) return this.seriesRuntimeInFlight.get(key);
        const task = (async () => {
            const previous = current?.runtimeAverage;
            let tmdbId = current?._tmdbId || seriesItem.tmdbId || null;
            let result = null;
            let failure = null;
            let probedTmdbId = null;
            try {
                // A source-supplied runtime needs no episode list. Check it even
                // when the provider's series-details request is unavailable.
                if (tmdbId) {
                    probedTmdbId = String(tmdbId);
                    result = await tmdbMetadata.getSeriesLevelRuntime(tmdbId, {
                        refresh: Boolean(previous)
                    });
                }
                if (!this.isCatalogItemCurrent(id, providerLastUpdate)) return null;
                if (!result) {
                    const providerDiagnostic = {};
                    const seriesKey = getProviderSeriesKey(seriesItem);
                    let info = this.seriesInfoCache.get(seriesKey);
                    if (!info || info.fetchError || Number(info.fetchedAt) < Number(providerLastUpdate)) {
                        info = null;
                        if (this.providerName === 'xtream') {
                            const saved = await this.persistentSeriesInfoCache.get(seriesKey, providerLastUpdate);
                            if (saved?.fresh && !saved.value.fetchError) info = saved.value;
                        }
                    }
                    if (!this.isCatalogItemCurrent(id, providerLastUpdate)) return null;
                    if (!info) {
                        if (this.providerName === 'direct') info = await this.ensureSeriesInfo(seriesKey);
                        else if (this.providerName === 'xtream' && !this.config.xtreamUseM3U) {
                            const provider = require('./src/js/providers/xtreamProvider.js');
                            info = await provider.fetchSeriesRuntimeInfo(this, seriesKey, providerDiagnostic);
                        }
                    }
                    if (!this.isCatalogItemCurrent(id, providerLastUpdate)) return null;
                    const episodes = info && !info.fetchError ? (info.episodes || info.videos) : null;
                    if (Array.isArray(episodes)) {
                        tmdbId = tmdbId || info.tmdbId || null;
                        result = await tmdbMetadata.getSeriesRuntimeMetadata(tmdbId, {
                            episodes, previous, refresh: Boolean(previous),
                            seriesLevelChecked: probedTmdbId !== null && probedTmdbId === String(tmdbId)
                        });
                        if (result && result.source !== 'tmdb-series') {
                            result = { ...result, scope: 'provider-episodes',
                                episodeFingerprint: providerEpisodeFingerprint(episodes),
                                providerEpisodeCount: providerEpisodes(episodes).length };
                        }
                        if (!result?.runtime || result.complete !== true) {
                            failure = result?.lookupFailure
                                ? compactRuntimeFailure(result.lookupFailure.reason, result.lookupFailure)
                                : compactRuntimeFailure(!episodes.length ? 'provider_episodes_empty'
                                    : result?.runtime ? 'episode_lookup_incomplete' : 'episode_durations_unavailable');
                        }
                    } else {
                        failure = compactRuntimeFailure(providerDiagnostic.reason || 'provider_series_info_unavailable', providerDiagnostic);
                    }
                }
            } catch (error) {
                failure = compactRuntimeFailure('runtime_calculation_error', {
                    errorName: error?.name, errorCode: error?.code
                });
            }
            if (!this.isCatalogItemCurrent(id, providerLastUpdate)) return null;
            const latest = this.catalogMetaCache.get(id) || current;
            if (parseRuntimeMinutes(latest.runtime) !== null && !hasDerivedSeriesRuntime(latest)) return latest;
            if (tmdbId && latest._tmdbId && String(tmdbId) !== String(latest._tmdbId)) return latest;
            const samePopulation = latest.runtimeAverage?.version === 2 && latest.runtimeAverage.scope === 'provider-episodes' &&
                latest.runtimeAverage.episodeFingerprint === result?.episodeFingerprint;
            const now = Date.now();
            if (isProviderQuotaFailure(failure) && !failure.retryAt) failure.retryAt = now + 60000;
            let updated;
            if (parseRuntimeMinutes(result?.runtime) !== null && (result.complete === true || !samePopulation)) {
                updated = { ...latest, runtime: result.runtime,
                    runtimeAverage: result.source === 'tmdb-series' ? null : {
                        ...providerRuntimeRecord(result, tmdbId, providerLastUpdate, now),
                        ...(failure ? { lastFailure: failure } : {})
                    } };
            } else {
                updated = { ...latest, runtimeAverage: {
                    ...(latest.runtimeAverage || {}), version: latest.runtimeAverage?.version || 1,
                    checkedAt: Number(latest.runtimeAverage?.checkedAt) || 0,
                    attemptedAt: now, attemptProviderLastUpdate: providerLastUpdate, lookupRevision: 1,
                    lastFailure: failure || compactRuntimeFailure('runtime_lookup_failed'),
                    ...(!providerRuntimeScopeIsValid(latest.runtimeAverage) ? { scopeMigrationAttemptedAt: now } : {}),
                    complete: latest.runtimeAverage?.complete === true,
                    ...(samePopulation && Array.isArray(result?.seasons) ? { seasons: result.seasons } : {}),
                    tmdbId: tmdbId ? String(tmdbId) : null
                } };
            }
            const saved = await this.persistCatalogMetaIfCurrent(id, updated, providerLastUpdate);
            if (isProviderQuotaFailure(failure) && xtreamRequests.isBackground()) {
                throw new xtreamRequests.XtreamRateLimitError(failure.retryAt);
            }
            return saved;
        })();
        this.seriesRuntimeInFlight.set(key, task);
        try { return await task; }
        finally { if (this.seriesRuntimeInFlight.get(key) === task) this.seriesRuntimeInFlight.delete(key); }
    }

    async getSeriesDetailRuntime(seriesItem, tmdb, omdb, info, seasonResults, providerLastUpdate = this.lastUpdate) {
        const id = String(seriesItem.id);
        let saved = this.catalogMetaCache.get(id);
        if (!saved) {
            const persisted = await this.persistentCatalogMetaCache.get(id);
            saved = this.catalogMetaCache.get(id) || persisted?.value;
        }
        if (!this.isCatalogItemCurrent(id, providerLastUpdate)) return {};
        const derived = hasDerivedSeriesRuntime(saved);
        const official = [tmdb?.runtime, seriesItem.runtime,
            !(derived && omdb?.runtime === saved.runtime) ? omdb?.runtime : null]
            .find(value => parseRuntimeMinutes(value) !== null);
        if (official) return { runtime: official, runtimeAverage: null };
        if (parseRuntimeMinutes(saved?.runtime) !== null && !derived) return { runtime: saved.runtime };
        const retained = () => derived ? { runtime: saved.runtime, runtimeAverage: saved.runtimeAverage } : {};
        if (!info || info.fetchError || !Array.isArray(info.videos)) return retained();
        const average = averageProviderEpisodes(info.videos, seasonResults);
        if (!average.runtime) return retained();
        const tmdbId = seriesItem.tmdbId || saved?._tmdbId || info.tmdbId || null;
        const complete = !tmdbId || average.unresolvedEpisodeCount === 0;
        const samePopulation = derived && saved.runtimeAverage.version === 2 &&
            saved.runtimeAverage.scope === 'provider-episodes' && saved.runtimeAverage.episodeFingerprint === average.episodeFingerprint;
        const lowerPriority = samePopulation && ['tmdb-episodes', 'mixed-episodes'].includes(saved.runtimeAverage.source) &&
            average.source === 'provider-episodes';
        if (samePopulation && (!complete || lowerPriority)) return retained();
        const now = Date.now();
        const groups = new Map();
        for (const episode of providerEpisodes(info.videos)) {
            const season = episode.episode === null ? null : episode.season;
            if (!groups.has(season)) groups.set(season, []);
            groups.get(season).push(episode);
        }
        const seasons = [...groups].map(([season, episodes]) => {
            const summary = averageProviderEpisodes(episodes, seasonResults);
            return { season, episodeFingerprint: summary.episodeFingerprint, episodeCount: episodes.length,
                runtimeCount: summary.episodeCount, totalMinutes: summary.totalMinutes,
                tmdbEpisodeCount: summary.tmdbEpisodeCount, providerDurationCount: summary.providerDurationCount,
                checkedAt: now, complete: !tmdbId || summary.unresolvedEpisodeCount === 0 };
        });
        return { runtime: average.runtime,
            runtimeAverage: providerRuntimeRecord({ ...average, complete, seasons }, tmdbId, providerLastUpdate, now) };
    }

    async buildSeriesMeta(seriesItem) {
        const providerLastUpdate = Number(this.lastUpdate) || 0;
        const seriesIdRaw = seriesItem.series_id || seriesItem.id.replace(/^iptv_series_/, '');
        const knownTmdbId = seriesItem.tmdbId || null;

        // The provider episode list and known TMDb metadata are independent.
        // Start them together to avoid serial network wait on detail pages.
        const infoPromise = this.ensureSeriesInfo(seriesIdRaw);
        const knownTmdbPromise = knownTmdbId
            ? tmdbMetadata.getSeriesMetadata(knownTmdbId)
            : Promise.resolve(null);
        const [info, initialTmdb] = await Promise.all([infoPromise, knownTmdbPromise]);
        const tmdbId = knownTmdbId || info?.tmdbId || null;
        const tmdb = initialTmdb || (tmdbId ? await tmdbMetadata.getSeriesMetadata(tmdbId) : null);

        const omdbPromise = tmdb?.imdbId
            ? this.getDetailOmdbMetadata(tmdb.imdbId, seriesItem.id, providerLastUpdate)
            : Promise.resolve(null);
        const tmdbSeasons = new Map();
        let seasonResultsPromise = Promise.resolve([]);
        if (tmdb && tmdbMetadata.validTmdbId(tmdbId)) {
            const seasonNumbers = [...new Set((info?.videos || [])
                .map(video => Number(video.season))
                .filter(n => Number.isSafeInteger(n) && n >= 0))];
            const seasonConcurrency = parsePositiveInteger(
                process.env.SERIES_EPISODE_METADATA_CONCURRENCY, 6, 1, 12
            );
            seasonResultsPromise = mapWithConcurrency(seasonNumbers, seasonConcurrency, async season => [
                season,
                await tmdbMetadata.getSeasonEpisodes(tmdbId, season)
            ]);
        }
        const [omdb, seasonResults] = await Promise.all([omdbPromise, seasonResultsPromise]);
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
            const episodeRuntime = tmdbEpisode?.runtime || v.runtime;
            if (parseRuntimeMinutes(episodeRuntime) !== null) video.runtime = episodeRuntime;
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

        const runtimeFields = await this.getSeriesDetailRuntime(
            seriesItem, tmdb, omdb, info, seasonResults, providerLastUpdate
        );
        if (!tmdb) {
            // Keep the provider episode list and any provider preview fields when
            // TMDb cannot return this title; store useful fallback fields for cards.
            const fallbackMeta = {
                id: seriesItem.id,
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
                    ...(v.released ? { released: v.released } : {}),
                    ...(v.runtime ? { runtime: v.runtime } : {})
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
            metadataVersion: 2,
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
        let rateLimitFailure = null;
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
                getCatalogMetadataWarmupState(cached, this.lastUpdate).retryDue || catalogMetadataNormalRefreshIsDue(cached);
        });
        let nextIndex = 0;
        const worker = async () => {
            while (nextIndex < candidates.length) {
                if (this.disposed) break;
                if (rateLimitFailure && xtreamRequests.isBackground()) break;
                const item = candidates[nextIndex++];
                const providerLastUpdate = Number(this.lastUpdate) || 0;
                try {
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
                    if (xtreamRequests.isXtreamRateLimitError(error)) {
                        if (!this.isCatalogItemCurrent(item.id, providerLastUpdate)) continue;
                        if (xtreamRequests.isBackground()) rateLimitFailure = error;
                        else {
                            const saved = this.catalogMetaCache.get(item.id) ||
                                (await this.persistentCatalogMetaCache.get(String(item.id)))?.value;
                            previews.set(String(item.id), saved || this.generateMetaPreview(item));
                        }
                        continue;
                    }
                    this.log.warn('Foreground catalogue metadata enrichment failed', { itemId: item.id, errorName: error?.name || 'Error' });
                }
            }
        };
        const workerCount = Math.min(Math.max(1, concurrency), candidates.length);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        if (rateLimitFailure) throw rateLimitFailure;
        return previews;
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
                        const providerLastUpdate = Number(this.lastUpdate) || 0;
                        const detailed = await this.getCatalogMetaAsync(next.id, next.type);
                        if (detailed && this.isCatalogItemCurrent(next.id, providerLastUpdate)) {
                            this.catalogMetaStaleFallbacks.delete(next.id);
                            const preview = { ...(this.catalogMetaCache.get(next.id) || detailed) };
                            const providerGenre = next.category || next.attributes?.['group-title'];
                            let fallbackPreview;
                            if (!isMetadataValuePresent('poster', preview.poster)) {
                                fallbackPreview = this.generateMetaPreview(next);
                                if (isMetadataValuePresent('poster', fallbackPreview.poster)) preview.poster = fallbackPreview.poster;
                            }
                            if (!isMetadataValuePresent('genres', preview.genres)) {
                                fallbackPreview = fallbackPreview || this.generateMetaPreview(next);
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
                            this.cacheCatalogMetaPreview(next.id, preview, true, providerLastUpdate);
                        }
                    } catch (error) {
                        this.log.warn('Background catalogue metadata enrichment failed', {
                            itemId: next.id,
                            errorName: error?.name || 'Error'
                        });
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
        this.catalogMetaCache.set(key, merged);
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
            missingMetadataCheckedAt: previousMissingMetadataCheckedAt || Number(preview?.missingMetadataCheckedAt) || now
        };
        this.catalogMetaCache.set(id, preview);
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
                'cast', 'director', 'tmdbRating', 'links', 'trailers'
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
            // A full details request has just checked these fields; keep the normal
            // metadata freshness clock separate from the incomplete-field retry clock.
            preview.missingMetadataCheckedAt = Date.now();
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
        const catalogueFingerprint = crypto.createHash('sha256')
            .update(type === 'series' ? 'provider-runtime-v2:' + providerLastUpdate + '\n' : '')
            .update(items.map(item => String(item?.id || '')).join('\n'))
            .digest('hex');
        const lastCompleted = this.catalogPrefetchLastCompleted.get(type) || 0;
        if (Date.now() - lastCompleted < refreshInterval &&
            this.catalogPrefetchLastFingerprint.get(type) === catalogueFingerprint) return;

        this.log.debug('Starting catalogue metadata warm-up check', {
            type, total: items.length, pageSize, concurrency
        });
        const job = (async () => {
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
                const seriesRuntime = type === 'series' ? createSeriesRuntimeSummary() : null;
                // Inspect saved previews before honoring the scan marker. Missing
                // fields are reported separately from retries held by their backoff.
                for (const item of items) {
                    const saved = await this.persistentCatalogMetaCache.get(String(item.id));
                    if (!isCurrentGeneration()) return;
                    const state = getCatalogMetadataWarmupState(saved?.value, providerLastUpdate);
                    if (seriesRuntime) countSeriesRuntime(seriesRuntime, saved?.value, providerLastUpdate);
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
                    this.catalogPrefetchLastFingerprint.set(type, catalogueFingerprint);
                    this.catalogPrefetchRetryAfter.delete(type);
                    this.log.debug('Persistent catalogue metadata scan is current', {
                        type,
                        total: items.length,
                        incompleteItems: cachedIncompleteItems,
                        retriesDeferredByBackoff: cachedRetryDeferredItems,
                        missingFieldCounts: cachedMissingFieldCounts,
                        ...(seriesRuntime ? { seriesRuntime } : {}),
                        completedAt: new Date(persistedCompletedAt).toISOString()
                    });
                    return;
                }
                this.log.debug('Persistent catalogue metadata has retries due', {
                    type, total: items.length
                });
            }

            let processed = 0;
            let incompleteItems = 0;
            let retryDueItems = 0;
            const missingFieldCounts = {};
            let providerFallbacks = 0;
            let nextProgressPercent = 25;
            const providerFallbackReasons = {};
            const providerLookupFailureReasons = {};
            for (let offset = 0; offset < items.length; offset += pageSize) {
                if (this.disposed || !isCurrentGeneration()) return;
                const providerRetryAt = xtreamRequests.getState(this)?.retryAt;
                if (providerRetryAt > Date.now()) throw new xtreamRequests.XtreamRateLimitError(providerRetryAt);
                const batch = items.slice(offset, Math.min(offset + pageSize, items.length));
                if (!batch.length) continue;
                // Force the warm-up through the metadata refresh path even when an old
                // preview is already in the LRU. Refreshed values must also replace
                // the persistent preview, not merely update memory.
                const batchPreviews = await xtreamRequests.background(
                    () => !this.disposed && isCurrentGeneration(),
                    () => this.enrichCatalogMetaItems(batch, concurrency, true)
                );
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
                    const lookupDiagnostic = this.catalogMetaLookupDiagnostics.get(String(item.id));
                    if (type === 'series' && lookupDiagnostic?.providerFallback) {
                        providerFallbacks++;
                        const reason = lookupDiagnostic.reason || 'unknown';
                        providerFallbackReasons[reason] = (providerFallbackReasons[reason] || 0) + 1;
                        const providerLookup = lookupDiagnostic.providerLookup;
                        if (providerLookup?.reason && /(?:error|invalid|failed|credentials_missing)/.test(providerLookup.reason)) {
                            countLookupReason(providerLookupFailureReasons, providerLookup);
                        }
                    }
                    const state = getCatalogMetadataWarmupState(cached, providerLastUpdate);
                    if (state.incomplete) {
                        incompleteItems++;
                        for (const field of state.missingFields) {
                            missingFieldCounts[field] = (missingFieldCounts[field] || 0) + 1;
                        }
                    }
                    if (state.retryDue) retryDueItems++;
                }

                const progressPercent = Math.floor((processed * 100) / items.length);
                if (progressPercent >= nextProgressPercent) {
                    const milestone = Math.min(75, Math.floor(progressPercent / 25) * 25);
                    if (milestone >= nextProgressPercent) {
                        this.log.debug('Catalogue metadata warm-up progress', {
                            type,
                            percent: milestone,
                            processed,
                            total: items.length,
                            incompleteItems,
                            retryDueItems,
                            providerFallbacks
                        });
                        nextProgressPercent = milestone + 25;
                    }
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
            const seriesRuntime = type === 'series' ? createSeriesRuntimeSummary() : null;
            // Read the persistent cache rather than catalogMetaCache (an LRU capped
            // at 1,000 items); otherwise this report falsely labels the rest of the
            // provider catalogue as missing.
            for (const item of items) {
                const saved = await this.persistentCatalogMetaCache.get(String(item.id));
                const value = saved?.value;
                if (seriesRuntime) countSeriesRuntime(seriesRuntime, value, providerLastUpdate);
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
            this.log.debug('Catalogue metadata diagnostics', {
                type,
                ...omdbCatalogueSummary,
                ...(Object.keys(providerLookupFailureReasons).length ? { providerLookupFailureReasons } : {}),
                ...(seriesRuntime ? { seriesRuntime } : {}),
                tmdb: typeof tmdbMetadata.getDiagnostics === 'function' ? tmdbMetadata.getDiagnostics() : undefined,
                omdb: typeof omdbMetadata.getDiagnostics === 'function' ? omdbMetadata.getDiagnostics() : undefined
            });

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
                    version: 4
                }, isCurrentGeneration);
                // Ensure metadata and its completion marker reach the persistent
                // volume before reporting the scan as durable.
                await this.persistentCatalogMetaCache.flush();
                if (!isCurrentGeneration()) return;
                this.catalogPrefetchLastCompleted.set(type, completedAt);
                this.catalogPrefetchLastFingerprint.set(type, catalogueFingerprint);
                this.catalogPrefetchRetryAfter.delete(type);
                this.log.info('Persistent catalogue metadata scan complete', {
                    type,
                    processed,
                    total: items.length,
                    incompleteItems,
                    retriesDeferredByBackoff: incompleteItems - retryDueItems,
                    missingFieldCounts,
                    providerFallbacks,
                    providerFallbackReasons,
                    ...(seriesRuntime ? { runtimeMigrationPending: seriesRuntime.legacyScope } : {}),
                    ...(Object.keys(providerLookupFailureReasons).length ? { providerLookupFailureReasons } : {}),
                    ms: Date.now() - startedAt
                });
            } else {
                const retryDelay = parsePositiveInteger(
                    process.env.CATALOG_PREFETCH_RETRY_MS, 60 * 60 * 1000,
                    5 * 60 * 1000, 24 * 60 * 60 * 1000
                );
                this.catalogPrefetchRetryAfter.set(type, Date.now() + retryDelay);
                this.log.warn('Catalogue metadata retries still due after warm-up', {
                    type,
                    processed,
                    total: items.length,
                    incompleteItems,
                    retryDueItems,
                    missingFieldCounts,
                    providerFallbacks,
                    providerFallbackReasons,
                    ...(seriesRuntime ? { runtimeMigrationPending: seriesRuntime.legacyScope } : {}),
                    ...(Object.keys(providerLookupFailureReasons).length ? { providerLookupFailureReasons } : {}),
                    retryDelay
                });
            }
        })();

        this.catalogPrefetchJobs.set(type, job);
        job.catch(error => {
            if (this.disposed || !isCurrentGeneration()) return;
            if (xtreamRequests.isXtreamRateLimitError(error)) {
                const retryAt = Math.max(Number(error.retryAt) || 0,
                    xtreamRequests.getState(this)?.retryAt || 0, Date.now() + 1000);
                this.catalogPrefetchRetryAfter.set(type, retryAt);
                this.log.info('Catalogue metadata warm-up paused for Xtream cooldown', {
                    type, resumeAt: new Date(retryAt).toISOString()
                });
                const resume = () => {
                    if (this.disposed) return;
                    const remaining = Math.max(this.catalogPrefetchRetryAfter.get(type) || 0,
                        xtreamRequests.getState(this)?.retryAt || 0) - Date.now();
                    if (remaining > 0) {
                        const timer = setTimeout(resume, Math.min(remaining, 2147483647));
                        timer.unref?.();
                        this.catalogPrefetchResumeTimers.set(type, timer);
                        return;
                    }
                    this.catalogPrefetchResumeTimers.delete(type);
                    this.catalogPrefetchRetryAfter.delete(type);
                    this.startContinuousCatalogPrefetch(type, pageSize, concurrency);
                };
                clearTimeout(this.catalogPrefetchResumeTimers.get(type));
                const timer = setTimeout(resume, Math.min(retryAt - Date.now(), 2147483647));
                timer.unref?.();
                this.catalogPrefetchResumeTimers.set(type, timer);
                return;
            }
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
        xtreamRequests.promote(this, key.replace(/^iptv_(?:series|vod)_/, ''), type);
        const providerLastUpdate = Number(this.lastUpdate) || 0;
        const pendingKey = providerLastUpdate + ':' + key;
        if (!key || !this.isCatalogItemCurrent(key, providerLastUpdate)) return null;
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
            const metadataRefreshDue = normalMetadataRefreshDue ||
                omdbMetadataNeedsRefresh(previousRecord) ||
                catalogMetadataNeedsRefresh(previousRecord);
            if (hasPreviousPreview && !metadataRefreshDue) {
                this.catalogMetaCache.set(key, previousRecord);
                this.catalogMetaLookupDiagnostics.delete(key);
                return previousRecord;
            }

            const lookupDiagnostics = {};
            let refreshed;
            try {
                refreshed = await this._getCatalogMetaAsync(
                    id, type,
                    omdbMetadataNeedsRefresh(previousRecord) || catalogMetadataNeedsRefresh(previousRecord),
                    lookupDiagnostics
                );
            } catch (error) {
                if (!xtreamRequests.isXtreamRateLimitError(error) || xtreamRequests.isBackground()) throw error;
                if (!this.isCatalogItemCurrent(key, providerLastUpdate)) return null;
                // Keep all retry timestamps intact: a quota response must not
                // suppress missing metadata lookups for another twelve hours.
                return this.catalogMetaCache.get(key) || previousRecord ||
                    this.generateMetaPreview(type === 'series'
                        ? findCatalogueItemById(this.series, key) : findCatalogueItemById(this.movies, key));
            }
            if (!this.isCatalogItemCurrent(key, providerLastUpdate)) return null;
            if (lookupDiagnostics.reason && lookupDiagnostics.reason !== 'tmdb_match_found') {
                this.catalogMetaLookupDiagnostics.set(key, lookupDiagnostics);
            } else {
                this.catalogMetaLookupDiagnostics.delete(key);
            }
            if (refreshed) {
                // A title-details lookup may have filled gaps while this request was
                // in flight. Merge the response into the latest preview, not the
                // snapshot captured before the network request.
                const currentRecord = this.catalogMetaCache.get(key) || previousRecord;
                const merged = mergeCatalogMetadataPreservingKnownFields(currentRecord, refreshed);
                const retainedAfterProviderFailure = Boolean(currentRecord?._tmdbId &&
                    Object.prototype.hasOwnProperty.call(refreshed, '_tmdbId') && !refreshed._tmdbId);
                merged.metadataCheckedAt = normalMetadataRefreshDue && !retainedAfterProviderFailure
                    ? (refreshed.metadataCheckedAt || Date.now())
                    : (Number(currentRecord?.metadataCheckedAt) || previousSavedAt || Date.now());
                if (normalMetadataRefreshDue) {
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
                    ...(normalMetadataRefreshDue ? { metadataRefreshAttemptedAt: Date.now() } : {}),
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

    async _getCatalogMetaAsync(id, type, refreshIncompleteMetadata = false, lookupDiagnostics = null) {
        // Discover cards do not need episode lists, trailers, or logo-image lookups.
        // Fetch only the fields displayed in the panel and the credits needed for cast/directors.
        if (type === 'series' || id.startsWith('iptv_series_')) {
            const seriesItem = findCatalogueItemById(this.series, id);
            if (!seriesItem) {
                if (lookupDiagnostics) lookupDiagnostics.reason = 'provider_catalogue_item_not_found';
                return null;
            }
            const seriesId = seriesItem.series_id || seriesItem.id.replace(/^iptv_series_/, '');
            const providerLookup = {};
            let tmdbId = seriesItem.tmdbId || null;
            let idSource = tmdbId ? 'catalogue' : 'provider_lookup';
            if (!tmdbId) {
                tmdbId = await this.ensureSeriesTmdbId(seriesId, providerLookup);
            }
            let tmdbLookup = {};
            let tmdb = await tmdbMetadata.getSeriesCatalogMetadata(tmdbId, {
                refresh: refreshIncompleteMetadata,
                diagnostics: tmdbLookup
            });
            const makeProviderFallback = details => {
                if (lookupDiagnostics) {
                    Object.assign(lookupDiagnostics, details, { providerFallback: true });
                }
                const fallback = this.generateMetaPreview(seriesItem);
                return {
                    ...fallback,
                    metadataVersion: 3,
                    _tmdbId: null,
                    imdbIdChecked: true,
                    omdbChecked: true,
                    omdbPending: false
                };
            };
            const providerLookupFailed = details => [
                'provider_http_error', 'provider_request_error', 'provider_invalid_json',
                'provider_invalid_response', 'provider_credentials_missing',
                'provider_tmdb_id_lookup_error', 'provider_series_info_request_error'
            ].includes(details?.reason);
            const compactTmdbFailure = details => ({
                reason: details?.reason || 'tmdb_lookup_failed',
                ...(details?.httpStatus ? { httpStatus: details.httpStatus } : {}),
                ...(details?.errorName ? { errorName: details.errorName } : {}),
                ...(details?.errorCode ? { errorCode: details.errorCode } : {})
            });

            // If the catalogue's supplied TMDb ID is confirmed missing, check
            // Xtream's detailed record once for a possibly corrected ID.
            if (!tmdb && tmdbId && idSource === 'catalogue' && tmdbLookup.reason === 'tmdb_not_found') {
                const detailedProviderLookup = {};
                const detailedTmdbId = await this.ensureSeriesTmdbId(seriesId, detailedProviderLookup, true);
                if (detailedTmdbId && String(detailedTmdbId) !== String(tmdbId)) {
                    const detailedTmdbLookup = {};
                    const detailedTmdb = await tmdbMetadata.getSeriesCatalogMetadata(detailedTmdbId, {
                        refresh: refreshIncompleteMetadata,
                        diagnostics: detailedTmdbLookup
                    });
                    Object.assign(providerLookup, detailedProviderLookup);
                    if (detailedTmdb) {
                        tmdbId = detailedTmdbId;
                        idSource = 'provider_details';
                        tmdbLookup = detailedTmdbLookup;
                        tmdb = detailedTmdb;
                    } else {
                        tmdbLookup = {
                            ...compactTmdbFailure(detailedTmdbLookup),
                            catalogueLookup: compactTmdbFailure({
                                ...tmdbLookup,
                                reason: 'tmdb_not_found'
                            }),
                            catalogueTmdbId: String(tmdbId)
                        };
                        tmdbId = detailedTmdbId;
                        idSource = 'provider_details';
                        Object.assign(providerLookup, detailedProviderLookup);
                    }
                } else {
                    Object.assign(providerLookup, detailedProviderLookup);
                    const reason = providerLookupFailed(detailedProviderLookup)
                        ? 'provider_tmdb_id_lookup_failed'
                        : detailedTmdbId
                            ? 'provider_tmdb_id_same_as_catalogue'
                            : detailedProviderLookup.reason === 'provider_tmdb_id_invalid'
                                ? 'provider_tmdb_id_invalid'
                                : 'provider_tmdb_id_missing';
                    return makeProviderFallback({
                        reason,
                        tmdbId: String(tmdbId),
                        idSource: 'catalogue',
                        catalogueLookup: compactTmdbFailure(tmdbLookup),
                        providerLookup: detailedProviderLookup
                    });
                }
            }

            // If neither source supplied a usable TMDb ID, keep a provider-backed
            // card for this warm-up and let the normal metadata retry clock try again.
            if (!tmdb && !tmdbId) {
                const reason = providerLookupFailed(providerLookup)
                    ? 'provider_tmdb_id_lookup_failed'
                    : providerLookup.reason === 'provider_tmdb_id_invalid'
                        ? 'provider_tmdb_id_invalid'
                        : 'provider_tmdb_id_missing';
                return makeProviderFallback({ reason, providerLookup });
            }
            if (!tmdb) {
                return makeProviderFallback({
                    ...compactTmdbFailure(tmdbLookup),
                    tmdbId: String(tmdbId),
                    idSource,
                    ...(tmdbLookup.catalogueLookup ? { catalogueLookup: tmdbLookup.catalogueLookup } : {}),
                    ...(tmdbLookup.catalogueTmdbId ? { catalogueTmdbId: tmdbLookup.catalogueTmdbId } : {}),
                    ...(Object.keys(providerLookup).length ? { providerLookup } : {})
                });
            }
            if (lookupDiagnostics) {
                Object.assign(lookupDiagnostics, {
                    reason: 'tmdb_match_found',
                    tmdbId: String(tmdbId),
                    idSource
                });
            }
            const omdb = tmdb.imdbId ? await omdbMetadata.getByImdbId(tmdb.imdbId, { refreshIncomplete: refreshIncompleteMetadata }) : null;
            if (!tmdb) return this.getDetailedMeta(id);
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
                ...(parseRuntimeMinutes(tmdb.runtime || seriesItem.runtime || omdb?.runtime) !== null
                    ? { runtimeAverage: null } : {}),
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
        const tmdb = await tmdbMetadata.getMovieCatalogMetadata(tmdbId, { refresh: refreshIncompleteMetadata });
        const omdb = tmdb?.imdbId ? await omdbMetadata.getByImdbId(tmdb.imdbId, { refreshIncomplete: refreshIncompleteMetadata }) : null;
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
            omdbPending: Boolean(tmdb.imdbId && omdbMetadata.shouldRetryLookup(tmdb.imdbId)),
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
        const providerLastUpdate = Number(this.lastUpdate) || 0;
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
                try {
                    tmdbId = await this.resolveMovieTmdbId(id, item, providerModule);
                } catch (error) {
                    if (!xtreamRequests.isXtreamRateLimitError(error)) throw error;
                    const saved = this.catalogMetaCache.get(id) || (await this.persistentCatalogMetaCache.get(id))?.value;
                    if (!this.isCatalogItemCurrent(id, providerLastUpdate)) return null;
                    return { ...this.getDetailedMeta(id), ...(saved || {}), id, type: 'movie' };
                }
            }
            const tmdb = await tmdbMetadata.getMovieMetadata(tmdbId);
            if (!tmdb) {
                const fallbackMeta = this.getDetailedMeta(id);
                await this.persistDetailedCatalogPreview(item.id, 'movie', null, fallbackMeta, {
                    providerLastUpdate,
                    providerFallback: true
                });
                return fallbackMeta;
            }
            // Keep the detailed movie response consistent with the enriched catalogue
            // preview: Stremio needs imdbRating on the returned meta object, not just
            // in the persistent catalogue cache or as a labelled link.
            const omdb = tmdb.imdbId ? await this.getDetailOmdbMetadata(tmdb.imdbId, item.id, providerLastUpdate) : null;
            const detailedMeta = {
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
    const buildKey = createInterfaceKey(config);
    const debugFlag = !!config.debug || DEBUG_ENV;
    if (debugFlag) {
        logAt('debug', '[DEBUG] createAddon start', { provider: config.provider, includeSeries: config.includeSeries !== false });
    } else {
        logAt('debug', `[ADDON] Cache ${CACHE_ENABLED ? 'ENABLED' : 'DISABLED'}`);
    }

    if (buildPromiseCache.has(buildKey)) {
        if (debugFlag) logAt('debug', '[DEBUG] Reusing in-progress addon build');
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
        addonInstance.startConfiguredCatalogPrefetch();
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
                if (!queryCacheHit && selectedGenre) {
                    const genreIndexResult = getCatalogueGenreIndex(items);
                    const genreIndex = genreIndexResult.index;
                    filtered = filtered.filter(i => {
                        const indexedGenre = genreIndex.get(i);
                        if (indexedGenre !== undefined) return indexedGenre === selectedGenre;
                        const cat = i.category || i.attributes?.['group-title'];
                        return matchesGenre(cat, selectedGenre);
                    });
                }
                // Reuse normalized titles from the per-catalogue index, then rank
                // matching cards before pagination so the best results appear first.
                if (!queryCacheHit && normalizedSearchQuery) {
                    const searchIndexResult = getCatalogueSearchIndex(items);
                    const searchIndex = searchIndexResult.index;
                    const scoreTitle = createNormalizedSearchScorer(normalizedSearchQuery);
                    filtered = filtered
                        .map((item, originalPosition) => {
                            const indexedTitle = searchIndex.get(item);
                            const score = indexedTitle
                                ? scoreTitle(indexedTitle.text, indexedTitle.words)
                                : scoreTitle(getNormalizedSearchText(item.name));
                            return { item, originalPosition, score };
                        })
                        .filter(match => match.score > 0)
                        .sort((a, b) => b.score - a.score || a.originalPosition - b.originalPosition)
                        .map(match => match.item);
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
                        logAt('debug', '[DEBUG] Series Episode Stream request', { id, target: safeStreamTarget(stream.url) });
                    }
                    return { streams: [stream] };
                }
                const stream = addonInstance.getStream(id);
                if (!stream) return { streams: [] };
                if (addonInstance.config.debug) {
                    logAt('debug', '[DEBUG] Stream request', { id, target: safeStreamTarget(stream.url) });
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
                this.log.warn('[META] Metadata response failed', e && e.name ? e.name : 'Error');
                return { meta: null };
            }
        });

        const iface = builder.getInterface();
        buildingInterface = iface;
        Object.defineProperty(iface, '__cacheWeight', {
            value: addonInstance.estimateMemoryBytes(),
            enumerable: false,
            configurable: false
        });
        addonInterfaceInstances.set(iface, addonInstance);

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

        return iface;
    })().catch(async (error) => {
        if (buildingInterface) addonInterfaceInstances.delete(buildingInterface);
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
        if (client.status === 'ready') await client.quit();
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
        if (addonDisposals.get(addon.cacheKey) === disposal) addonDisposals.delete(addon.cacheKey);
    }
};
module.exports.flushAddonDisposals = async function flushAddonDisposals() {
    await Promise.allSettled([...addonDisposals.values()]);
};
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
