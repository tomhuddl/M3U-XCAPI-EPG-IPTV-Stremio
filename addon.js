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
    // Keep missing-field retry timing separate from the normal metadata
    // refresh timestamp. Older persisted entries migrate via metadataCheckedAt.
    const checkedAt = Number(value.missingMetadataCheckedAt) ||
        Number(value.metadataCheckedAt) || 0;
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
            return null;
        }
        const cached = this.seriesInfoCache.get(seriesId);
        if (cached !== undefined) {
            return cached;
        }

        const pendingKey = 'series-info:' + String(seriesId);
        const pending = this.providerInfoInFlight.get(pendingKey);
        if (pending) {
            return pending;
        }

        const task = (async () => {
            try {
                const providerModule = require(`./src/js/providers/${this.providerName}Provider.js`);
                if (typeof providerModule.fetchSeriesInfo === 'function') {
                    const info = await providerModule.fetchSeriesInfo(this, seriesId);
                    // A failed provider request is not a valid empty series.
                    // Do not cache it, so a later detail open can retry immediately.
                    if (info?.fetchError) {
                        this.log.warn('Series info request failed; result not cached', {
                            seriesId: String(seriesId),
                            error: String(info.fetchError)
                        });
                        return info;
                    }
                    this.seriesInfoCache.set(seriesId, info);
                    return info;
                }
            } catch (e) {
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

            // Providers can return a partial success (for example, Xtream live and
            // VOD endpoints work while get_series fails). Never let an unexpectedly
            // empty section erase a previously populated section while other sections
            // make the overall refresh look successful. Preserve ordering and IDs by
            // retaining the exact last-good array; a truly empty provider section can
            // still be accepted on first load when no previous data exists.
            for (const section of ['channels', 'movies', 'series']) {
                const previousItems = previous[section];
                const currentItems = this[section];
                if (Array.isArray(previousItems) && previousItems.length > 0 &&
                    Array.isArray(currentItems) && currentItems.length === 0) {
                    this[section] = previousItems;
                    this.log.warn('Provider refresh returned an empty section; retaining last-known-good data', {
                        section,
                        previousCount: previousItems.length
                    });
                }
            }

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
            providerRefreshState.set(this.cacheKey, this.lastUpdate);
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
            if (this.scheduledRefreshInFlight || providerRefreshInFlight.has(this.cacheKey)) return;
            const sharedLastUpdate = providerRefreshState.get(this.cacheKey) || 0;
            const lastSuccessfulRefresh = Math.max(Number(this.lastUpdate) || 0, sharedLastUpdate);
            if (lastSuccessfulRefresh && Date.now() - lastSuccessfulRefresh < this.updateInterval) {
                this.lastUpdate = lastSuccessfulRefresh;
                return;
            }
            this.log.info('Scheduled provider refresh is due', {
                lastSuccessfulRefresh: lastSuccessfulRefresh ? new Date(lastSuccessfulRefresh).toISOString() : null,
                intervalHours: this.updateInterval / (60 * 60 * 1000)
            });
            const refreshPromise = this.updateData(true)
                .catch(error => this.log.warn('Scheduled provider refresh failed', error?.name || 'Error'))
                .finally(() => {
                    if (providerRefreshInFlight.get(this.cacheKey) === refreshPromise) {
                        providerRefreshInFlight.delete(this.cacheKey);
                    }
                    this.scheduledRefreshInFlight = null;
                });
            this.scheduledRefreshInFlight = refreshPromise;
            providerRefreshInFlight.set(this.cacheKey, refreshPromise);
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

    async getDetailOmdbMetadata(imdbId, itemId) {
        if (!imdbId) return null;

        // Check the in-memory catalogue first, then the persistent catalogue cache.
        // This prevents detail opens after a Railway restart from querying OMDb when
        // the enriched rating/runtime are already saved on disk.
        let preview = itemId ? this.catalogMetaCache.get(itemId) : null;
        if (!preview && itemId) {
            const persisted = await this.persistentCatalogMetaCache.get(String(itemId));
            if (persisted?.value) {
                preview = persisted.value;
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
            const result = {
                ...(refreshed || {}),
                imdbId: refreshed?.imdbId || preview.imdbId || preview.imdb_id,
                imdbRating: refreshed?.imdbRating || preview.imdbRating,
                runtime: refreshed?.runtime || preview.runtime,
                omdbChecked: refreshed?.omdbChecked === true || preview.omdbChecked === true,
                omdbCheckedAt: refreshed?.omdbCheckedAt || Date.now()
            };
            // Persist the attempt timestamp as well as the retained values. Without
            // this write, a restart or repeated detail open could retry immediately.
            const updatedPreview = {
                ...preview,
                imdbId: result.imdbId,
                imdbRating: result.imdbRating,
                runtime: result.runtime,
                omdbChecked: result.omdbChecked,
                omdbCheckedAt: result.omdbCheckedAt
            };
            // This write updates OMDb fields only. Preserve the catalogue/TMDb
            // refresh timestamp so opening a detail page cannot postpone the next
            // scheduled metadata refresh.
            this.cacheCatalogMetaPreview(String(itemId), updatedPreview, true);
            return result;
        }

        // No matching enriched preview: use the OMDb module cache first, which
        // avoids a request on ordinary opens when this process has seen the title.
        return omdbMetadata.getByImdbId(imdbId);
    }

    async buildSeriesMeta(seriesItem) {
        const seriesIdRaw = seriesItem.series_id || seriesItem.id.replace(/^iptv_series_/, '');
        const info = await this.ensureSeriesInfo(seriesIdRaw);
        const tmdbId = seriesItem.tmdbId || info?.tmdbId || null;
        const tmdb = await tmdbMetadata.getSeriesMetadata(tmdbId);
        // The detailed series view also exposes IMDb rating/runtime fallbacks.
        // Keep this lookup local to the function rather than referencing an
        // undefined catalogue-preview variable.
        const omdb = tmdb?.imdbId ? await this.getDetailOmdbMetadata(tmdb.imdbId, seriesItem.id) : null;
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
        // A fresh metadata result sets its own timestamps in getCatalogMetaAsync.
        // For first-time entries, initialize both clocks; cached entries retain
        // their existing timestamps rather than postponing a due retry on every view.
        const previousMetadataCheckedAt = Number(preview?.metadataCheckedAt) || 0;
        const previousMissingMetadataCheckedAt = Number(preview?.missingMetadataCheckedAt) || 0;
        const now = Date.now();
        preview = {
            ...preview,
            metadataCheckedAt: previousMetadataCheckedAt || now,
            missingMetadataCheckedAt: previousMissingMetadataCheckedAt || now
        };
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
                    if (!cached || !String(cached.name || '').trim() || cached.metadataVersion < 3 || (cached._tmdbId && !cached.imdbId && cached.imdbIdChecked !== true) || (omdbMetadataNeedsRefresh(cached) || catalogMetadataNeedsRefresh(cached))) missingMetadata++;
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
            // 14-day metadata refresh. If persistent storage is disabled/unavailable,
            // make the same due decision from the in-memory preview instead.
            const persisted = await this.persistentCatalogMetaCache.get(key);
            const refreshInterval = parsePositiveInteger(
                process.env.CATALOG_METADATA_REFRESH_MS, 14 * 24 * 60 * 60 * 1000,
                60 * 60 * 1000, 90 * 24 * 60 * 60 * 1000
            );
            const cachedValue = persisted?.value || cached;
            const metadataTimestamp = Number(cachedValue?.metadataCheckedAt) ||
                Number(persisted?.savedAt) || 0;
            const refreshDue = !(Number(cachedValue?.metadataVersion) >= 3) ||
                (cachedValue?._tmdbId && !cachedValue?.imdbId && cachedValue?.imdbIdChecked !== true) ||
                omdbMetadataNeedsRefresh(cachedValue) ||
                catalogMetadataNeedsRefresh(cachedValue) ||
                Date.now() - metadataTimestamp >= refreshInterval;
            if (!refreshDue) return cached;
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
            const normalMetadataRefreshDue = !persistedIsUsable ||
                persisted.value.metadataVersion < 3 ||
                (persisted.value._tmdbId && !persisted.value.imdbId && persisted.value.imdbIdChecked !== true) ||
                Date.now() - (Number(persisted.value.metadataCheckedAt) || persisted.savedAt) >= metadataRefreshInterval;
            const persistedIsDue = persistedIsUsable &&
                (normalMetadataRefreshDue ||
                    omdbMetadataNeedsRefresh(persisted.value) || catalogMetadataNeedsRefresh(persisted.value));
            if (persistedIsUsable && !persistedIsDue) {
                this.catalogMetaCache.set(key, persisted.value);
                return persisted.value;
            }
            const refreshed = await this._getCatalogMetaAsync(id, type, omdbMetadataNeedsRefresh(persisted?.value) || catalogMetadataNeedsRefresh(persisted?.value));
            if (refreshed) {
                // Merge field-by-field so a partial successful upstream refresh cannot
                // erase useful metadata from the last saved preview. Fresh values win;
                // missing/empty values fall back to the previous persistent record.
                const previous = persisted?.value && isUsablePreview(persisted.value) ? persisted.value : null;
                if (!previous) return refreshed;
                const merged = { ...previous, ...refreshed };
                for (const [field, value] of Object.entries(refreshed)) {
                    const empty = value === undefined || value === null || value === '' ||
                        (Array.isArray(value) && value.length === 0);
                    if (empty && previous[field] !== undefined && previous[field] !== null &&
                        previous[field] !== '' && !(Array.isArray(previous[field]) && previous[field].length === 0)) {
                        merged[field] = previous[field];
                    }
                }
                // Keep retry timestamps from the latest attempt even if some fields
                // fell back, so absent upstream fields are not retried on every open.
                // Missing-field retries must not restart the longer normal refresh
                // interval. Advance the normal clock only for a full/due refresh.
                merged.metadataCheckedAt = normalMetadataRefreshDue
                    ? (refreshed.metadataCheckedAt || Date.now())
                    : (Number(previous.metadataCheckedAt) || Number(persisted.savedAt) || Date.now());
                merged.missingMetadataCheckedAt = Date.now();
                this.catalogMetaCache.set(key, merged);
                await this.persistentCatalogMetaCache.set(key, merged);
                return merged;
            }
            if (persisted?.value && isUsablePreview(persisted.value)) {
                // A failed/empty upstream refresh is still an attempt. Persist its
                // timestamp while retaining all known fields, otherwise a stale
                // incomplete record can trigger a lookup on every request.
                const retained = {
                    ...persisted.value,
                    missingMetadataCheckedAt: Date.now()
                };
                this.catalogMetaCache.set(key, retained);
                await this.persistentCatalogMetaCache.set(key, retained);
                this.catalogMetaStaleFallbacks.add(key);
                return retained;
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
                ...(omdb?.imdbRating ? [{ name: String(omdb.imdbRating), category: 'imdb', url: 'https://imdb.com/title/' + encodeURIComponent(String(tmdb.imdbId)) }] : []),
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
            const omdb = tmdb.imdbId ? await this.getDetailOmdbMetadata(tmdb.imdbId, item.id) : null;
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
                    ...(omdb?.imdbRating ? [{ name: String(omdb.imdbRating), category: 'imdb', url: 'https://imdb.com/title/' + encodeURIComponent(String(tmdb.imdbId)) }] : []),
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
