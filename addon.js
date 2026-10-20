// IPTV Stremio Addon Core (with debug logging + series (shows) support for BOTH Xtream & Direct M3U)
// Version 1.4.0: Adds Direct M3U series grouping + per‑episode streams
require('dotenv').config();

const { addonBuilder } = require("stremio-addon-sdk");
const crypto = require("crypto");
const LRUCache = require("./lruCache");
const tmdbMetadata = require("./src/js/tmdbMetadata");

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

function matchesGenre(category, selectedGenre) {
    const selected = normalizeGenre(selectedGenre);
    return selected.length > 0 && normalizeGenre(category) === selected;
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
        this.updateInterval = 3600000;
        this.channels = []; // live TV
        this.movies = [];   // VOD movies
        this.series = [];   // Series (shows)
        // Bound lazily loaded episode metadata so browsing many series cannot grow
        // this addon instance's memory without limit.
        this.seriesInfoCache = new LRUCache({ max: 100, ttl: CACHE_TTL_MS });
        // Cached catalogue enrichment lets later home/search requests return
        // rich cards without waiting on TMDb/Xtream for every item.
        this.catalogMetaCache = new LRUCache({
            max: parsePositiveInteger(process.env.CATALOG_META_CACHE_MAX, 1000, 50, 5000),
            ttl: parsePositiveInteger(process.env.CATALOG_META_CACHE_TTL_MS, 6 * 3600 * 1000, 1000, 30 * 24 * 3600 * 1000)
        });
        this.catalogMetaPending = new Map();
        this.catalogMetaQueue = [];
        this.catalogMetaWorkers = 0;
        this.epgData = {};
        this.lastUpdate = 0;
        this.log = makeLogger(config.debug);

        // Direct provider may populate this (seriesId -> episodes array)
        this.directSeriesEpisodeIndex = new Map();

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
        if (cached) {
            this.channels = cached.channels || [];
            this.movies = cached.movies || [];
            this.series = cached.series || [];
            this.epgData = cached.epgData || {};
            this.lastUpdate = cached.lastUpdate || 0;
            // Direct series episodes index is not persisted; rebuild on next fetch
            this.log.debug('Cache hit for data', {
                channels: this.channels.length,
                movies: this.movies.length,
                series: this.series.length,
                lastUpdate: new Date(this.lastUpdate).toISOString()
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

        const videos = [];
        for (const program of sourcePrograms) {
            if (!program || !program.start || !program.stop) continue;

            const start = this.parseEPGTime(program.start);
            const end = this.parseEPGTime(program.stop);
            const startMs = start instanceof Date ? start.getTime() : NaN;
            const endMs = end instanceof Date ? end.getTime() : NaN;
            if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
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
        return videos.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
    }

    async ensureSeriesInfo(seriesId) {
        if (!seriesId) return null;
        if (this.seriesInfoCache.has(seriesId)) return this.seriesInfoCache.get(seriesId);

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
        try {
            const start = Date.now();
            const providerModule = require(`./src/js/providers/${this.providerName}Provider.js`);
            await providerModule.fetchData(this);
            this.lastUpdate = Date.now();
            if (CACHE_ENABLED) await this.saveToCache();
            this.buildGenresInManifest();
            this.log.debug('Data update complete', {
                channels: this.channels.length,
                movies: this.movies.length,
                series: this.series.length,
                ms: Date.now() - start
            });
        } catch (e) {
            this.log.error('[UPDATE] Failed:', e && e.name ? e.name : 'Error');
        }
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
        const all = [...this.channels, ...this.movies];
        const item = all.find(i => i.id === id);
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
        // Direct provider inline index
        for (const arr of this.directSeriesEpisodeIndex.values()) {
            const found = arr.find(v => v.id === epId);
            if (found) return found;
        }
        return null;
    }

    async buildSeriesMeta(seriesItem) {
        const seriesIdRaw = seriesItem.series_id || seriesItem.id.replace(/^iptv_series_/, '');
        const info = await this.ensureSeriesInfo(seriesIdRaw);
        const tmdbId = seriesItem.tmdbId || info?.tmdbId || null;
        const tmdb = await tmdbMetadata.getSeriesMetadata(tmdbId);
        const tmdbSeasons = new Map();
        if (tmdb && tmdbMetadata.validTmdbId(tmdbId)) {
            const seasonNumbers = [...new Set((info?.videos || []).map(video => Number(video.season)).filter(n => Number.isSafeInteger(n) && n >= 0))];
            const seasonResults = await Promise.all(seasonNumbers.map(async season => [season, await tmdbMetadata.getSeasonEpisodes(tmdbId, season)]));
            for (const [season, episodes] of seasonResults) if (Array.isArray(episodes)) tmdbSeasons.set(season, episodes);
        }
        const videos = (info?.videos || []).map(v => {
            const tmdbEpisode = (tmdbSeasons.get(Number(v.season)) || []).find(ep => ep.episode === Number(v.episode));
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
            released: tmdb.released,
            year: tmdb.year,
            runtime: tmdb.runtime,
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

    queueCatalogMetaEnrichment(item) {
        if (!item || this.catalogMetaCache.has(item.id) || this.catalogMetaPending.has(item.id)) return;
        this.catalogMetaPending.set(item.id, true);
        this.catalogMetaQueue.push(item);

        const runNext = () => {
            while (this.catalogMetaWorkers < 3 && this.catalogMetaQueue.length) {
                const next = this.catalogMetaQueue.shift();
                this.catalogMetaWorkers++;
                (async () => {
                    try {
                        const detailed = await this.getDetailedMetaAsync(next.id, next.type);
                        if (detailed) {
                            const preview = { ...detailed };
                            delete preview.tmdbRating;
                            if (Array.isArray(preview.links)) {
                                preview.links = preview.links.filter(link => link?.category !== 'Rating');
                            }
                            const providerGenre = next.category || next.attributes?.['group-title'];
                            if (!Array.isArray(preview.genres) || !preview.genres.length) {
                                const base = this.generateMetaPreview(next);
                                preview.genres = base.genres?.length ? base.genres : (providerGenre ? [providerGenre] : []);
                            }
                            if (!Array.isArray(preview.cast) || !preview.cast.length) {
                                const base = this.generateMetaPreview(next);
                                if (Array.isArray(base.cast) && base.cast.length) preview.cast = base.cast;
                            }
                            this.catalogMetaCache.set(next.id, preview);
                        }
                    } catch (error) {
                        this.log.warn('Background catalogue metadata enrichment failed for', next.id, error?.message || error);
                    } finally {
                        this.catalogMetaPending.delete(next.id);
                        this.catalogMetaWorkers--;
                        runNext();
                    }
                })();
            }
        };
        runNext();
    }

    async getDetailedMetaAsync(id, type) {
        if (type === 'series' || id.startsWith('iptv_series_')) {
            const seriesItem = this.series.find(s => s.id === id);
            if (!seriesItem) return null;
            return await this.buildSeriesMeta(seriesItem);
        }
        const item = this.movies.find(movie => movie.id === id);
        if (item) {
            const providerModule = require('./src/js/providers/xtreamProvider.js');
            const idCacheKey = 'movie-tmdb:' + id;
            let tmdbId = item.tmdbId || this.seriesInfoCache.get(idCacheKey);
            if (!tmdbId && this.providerName === 'xtream' && !this.config.xtreamUseM3U) {
                const streamId = id.replace(/^iptv_vod_/, '');
                const providerInfo = await providerModule.fetchMovieInfo(this, streamId);
                tmdbId = providerInfo?.tmdbId || null;
                if (tmdbId) this.seriesInfoCache.set(idCacheKey, tmdbId);
            }
            const tmdb = await tmdbMetadata.getMovieMetadata(tmdbId);
            if (!tmdb) return this.getDetailedMeta(id);
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
                released: tmdb.released,
                year: tmdb.year,
                runtime: tmdb.runtime,
                director: tmdb.director,
                cast: tmdb.cast,
                tmdbRating: tmdb.rating,
                trailers: tmdb.trailer ? [{ source: tmdb.trailer.id, type: 'Trailer' }] : [],
                links: [
                    ...(tmdb.rating ? [{ name: 'TMDb rating: ' + tmdb.rating, category: 'Rating', url: 'https://www.themoviedb.org/movie/' + encodeURIComponent(String(tmdbId)) }] : []),
                    ...(tmdb.links || [])
                ]
            };
        }
        // Live-channel metadata remains unchanged; it is not film/series metadata.
        return this.getDetailedMeta(id);
    }

    getDetailedMeta(id) {
        const all = [...this.channels, ...this.movies];
        const item = all.find(i => i.id === id);
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
                
                // If specific genre selected
                if (extra.genre && normalizeGenre(extra.genre) !== 'all channels') {
                    filtered = filtered.filter(i => {
                        const cat = i.category || i.attributes?.['group-title'];
                        return matchesGenre(cat, extra.genre);
                    });
                }
                
                // If searching
                if (extra.search) {
                    const q = extra.search.toLowerCase();
                    filtered = filtered.filter(i => i.name.toLowerCase().includes(q));
                }
                
                // Pagination / Skip
                const skip = extra.skip ? parseInt(extra.skip) : 0;
                const page = filtered.slice(skip, skip + 100);

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

                // Return cached enriched cards immediately. Missing metadata is
                // fetched in a small background queue, so cold catalogue loads stay
                // fast and subsequent requests can use the richer cached previews.
                const metas = page.map(i => {
                    const meta = addonInstance.generateMetaPreview(i);
                    if (i.type === 'tv') {
                        meta.behaviorHints = { isLive: true };
                        meta.posterShape = 'square';
                        return meta;
                    }
                    if (i.type !== 'movie' && i.type !== 'series') return meta;

                    const cached = addonInstance.catalogMetaCache.get(i.id);
                    if (cached) return { ...meta, ...cached, id: i.id, type: i.type };

                    // Warm the cache without blocking catalogue delivery. Until
                    // authoritative TMDb data is ready, avoid showing provider
                    // genres/cast/plot as if they were the final metadata; otherwise
                    // Stremio can appear to switch from one set of details to another.
                    addonInstance.queueCatalogMetaEnrichment(i);
                    const firstPass = { ...meta, id: i.id, type: i.type };
                    delete firstPass.genres;
                    delete firstPass.cast;
                    delete firstPass.description;
                    delete firstPass.runtime;
                    delete firstPass.releaseInfo;
                    delete firstPass.year;
                    delete firstPass.links;
                    return firstPass;
                });
                
                if (addonInstance.config.debug) {
                    console.log('[DEBUG] Catalog handler', {
                        type: args.type,
                        id: args.id,
                        genre: extra.genre,
                        totalItems: items.length,
                        filtered: filtered.length,
                        returned: metas.length,
                        skip,
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
                if (addonInstance.config.debug) {
                    console.log('[DEBUG] Meta handler called', { type, id, seriesCount: addonInstance.series.length });
                }
                if (type === 'series' || id.startsWith('iptv_series_')) {
                    const meta = await addonInstance.getDetailedMetaAsync(id, 'series');
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
                const meta = await addonInstance.getDetailedMetaAsync(id, type);
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
                if (addonInstance.config.debug) {
                    console.log('[DEBUG] Meta request', { id, type, found: !!meta });
                }
                return { meta };
            } catch (e) {
                console.error('[META] Error', e && e.name ? e.name : 'Error');
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
module.exports.normalizeGenre = normalizeGenre;
module.exports.matchesGenre = matchesGenre;