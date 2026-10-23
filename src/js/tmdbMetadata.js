const { safeFetch } = require("../../urlSafety");
const LRUCache = require("../../lruCache");

const TMDB_API_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/";
const TMDB_API_KEY = (process.env.TMDB_API_KEY || "").trim();
const CACHE_TTL_MS = parsePositiveInteger(process.env.TMDB_CACHE_TTL_MS, 24 * 60 * 60 * 1000, 1000, 30 * 24 * 60 * 60 * 1000);
const cache = new LRUCache({
  max: parsePositiveInteger(process.env.TMDB_CACHE_MAX_ENTRIES, 1000, 1, 5000),
  ttl: CACHE_TTL_MS,
});
// Missing TMDb records are common when provider IDs are stale or incorrect.
// Cache only confirmed 404s briefly; transient errors must remain retryable.
const negativeCache = new LRUCache({
  max: parsePositiveInteger(process.env.TMDB_NEGATIVE_CACHE_MAX_ENTRIES, 500, 1, 5000),
  ttl: parsePositiveInteger(process.env.TMDB_NEGATIVE_CACHE_TTL_MS, 5 * 60 * 1000, 1000, 60 * 60 * 1000),
});
const pending = new Map();
const MAX_MAIN_CAST = 4;

function parsePositiveInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= min ? Math.min(parsed, max) : fallback;
}

function validTmdbId(value) {
  const id = String(value ?? "").trim();
  return /^\d{1,12}$/.test(id) && Number(id) > 0 ? id : null;
}

function imageUrl(path, size = "w500") {
  return typeof path === "string" && path.startsWith("/") ? TMDB_IMAGE_BASE + size + path : undefined;
}

function dateYear(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const year = Number(value.slice(0, 4));
  return year >= 1800 && year <= 3000 ? year : undefined;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function uniqueNames(items, selector, limit = 20) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const name = nonEmpty(selector(item));
    if (name && !seen.has(name)) {
      seen.add(name);
      result.push(name);
      if (result.length >= limit) break;
    }
  }
  return result;
}

function tmdbConfigured() {
  return TMDB_API_KEY.length > 0;
}

const TMDB_DEBUG = (process.env.DEBUG_MODE || "").toLowerCase() === "true";

function logRequestDebug(event, details) {
  if (TMDB_DEBUG) console.log("[DEBUG] TMDb request", { event, ...details });
}

async function request(path) {
  if (!tmdbConfigured()) return null;
  const cacheKey = "tmdb:" + path;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    logRequestDebug("cache-hit", { path, ms: 0 });
    return cached;
  }
  if (negativeCache.has(cacheKey)) {
    logRequestDebug("negative-cache-hit", { path, ms: 0 });
    return null;
  }
  if (pending.has(cacheKey)) {
    logRequestDebug("in-flight-join", { path });
    return pending.get(cacheKey);
  }

  const task = (async () => {
    const startedAt = Date.now();
    let status = null;
    try {
      const separator = path.includes("?") ? "&" : "?";
      const url = TMDB_API_BASE + path + separator + "api_key=" + encodeURIComponent(TMDB_API_KEY);
      const diagnostics = {};
      const response = await safeFetch(url, {
        timeout: 12000,
        // Opt in only for TMDb requests. safeFetch still resolves and validates
        // DNS for every request before selecting an agent pinned to those addresses.
        reuseConnection: true,
        diagnostics,
        headers: { Accept: "application/json", "User-Agent": "M3U-XCAPI-EPG-IPTV-Stremio" },
      });
      status = response.status;
      if (!response.ok) {
        // Do not leave an unused upstream response body draining in the
        // background. Explicitly close it so repeated HTTP failures release
        // sockets and buffers promptly.
        if (response.body && typeof response.body.destroy === "function") {
          response.body.destroy();
        }
        if (response.status === 404) negativeCache.set(cacheKey, true);
        logRequestDebug("http-miss", { path, status, ms: Date.now() - startedAt });
        return null;
      }
      // Separate response-body consumption from JSON parsing so large or slow
      // responses can be distinguished from CPU time spent decoding metadata.
      const bodyStartedAt = Date.now();
      const responseText = await response.text();
      const bodyMs = Date.now() - bodyStartedAt;
      const parseStartedAt = Date.now();
      const data = JSON.parse(responseText);
      const parseMs = Date.now() - parseStartedAt;
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        logRequestDebug("invalid-response", { path, status, ms: Date.now() - startedAt });
        return null;
      }
      cache.set(cacheKey, data);
      logRequestDebug("fetched", {
        path, status, ms: Date.now() - startedAt,
        dnsMs: diagnostics.dnsMs ?? null,
        headersMs: diagnostics.headersMs ?? null,
        bodyMs,
        parseMs,
        freeSocketsBeforeRequest: diagnostics.freeSocketsBeforeRequest ?? null,
      });
      return data;
    } catch (error) {
      logRequestDebug("request-error", {
        path,
        status,
        ms: Date.now() - startedAt,
        error: error && error.name ? error.name : "Error",
      });
      return null;
    } finally {
      pending.delete(cacheKey);
    }
  })();
  pending.set(cacheKey, task);
  return task;
}

function metadataLinks(details, credits, mediaType) {
  const links = [];
  for (const genre of Array.isArray(details?.genres) ? details.genres : []) {
    if (nonEmpty(genre?.name) && Number.isSafeInteger(genre.id) && genre.id > 0) {
      links.push({
        name: genre.name,
        category: "Genres",
        url: "https://www.themoviedb.org/genre/" + genre.id,
      });
    }
  }
  const cast = Array.isArray(credits?.cast) ? credits.cast : [];
  for (const person of cast.slice(0, MAX_MAIN_CAST)) {
    if (nonEmpty(person?.name) && Number.isSafeInteger(person.id) && person.id > 0) {
      links.push({
        name: person.name,
        category: "Cast",
        url: "https://www.themoviedb.org/person/" + person.id,
      });
    }
  }
  // Directors are shown for movies only; use the plural category so multiple
  // credited directors are grouped under the correct label in Stremio.
  if (mediaType === "movie") {
    const crew = Array.isArray(credits?.crew) ? credits.crew : [];
    const seen = new Set();
    let directorCount = 0;
    for (const person of crew) {
      if (person?.job !== "Director") continue;
      // Preserve the previous first-ten-credits limit without allocating a
      // filtered directors array and a second sliced array for every catalogue item.
      if (directorCount >= 10) break;
      directorCount++;
      if (nonEmpty(person?.name) && Number.isSafeInteger(person.id) && person.id > 0 && !seen.has(person.id)) {
        seen.add(person.id);
        links.push({
          name: person.name,
          category: "Directors",
          url: "https://www.themoviedb.org/person/" + person.id,
        });
      }
    }
  }
  // Writers are supplied in TMDb credit order. The HTTP response layer
  // keeps this category visible only to the iOS Stremio client.
  const crew = Array.isArray(credits?.crew) ? credits.crew : [];
  // Only include explicit writing credits. Creator/developed-by and editorial
  // roles can identify people who did not write episodes or scripts themselves.
  const seenWriters = new Set();
  for (const person of crew) {
    // Movie credits use person.job; TV aggregate credits use person.jobs[].
    // Check the relevant role directly to avoid building temporary role arrays
    // for every credited crew member on each catalogue metadata response.
    const isWriter = person?.job != null && String(person.job) === "Writer"
      || Array.isArray(person?.jobs) && person.jobs.some(job => job?.job != null && String(job.job) === "Writer");
    if (isWriter &&
        nonEmpty(person?.name) &&
        Number.isSafeInteger(person.id) && person.id > 0 &&
        !seenWriters.has(person.id)) {
      seenWriters.add(person.id);
      links.push({
        name: person.name,
        category: "Writers",
        url: "https://www.themoviedb.org/person/" + person.id,
      });
    }
  }
  return links;
}

function selectLogo(images) {
  const logos = Array.isArray(images?.logos) ? images.logos : [];
  const selected = logos.find(item => item?.iso_639_1 === "en" && typeof item.file_path === "string" && item.file_path.startsWith("/"))
    || logos.find(item => item?.iso_639_1 == null && typeof item.file_path === "string" && item.file_path.startsWith("/"))
    || logos.find(item => typeof item?.file_path === "string" && item.file_path.startsWith("/"));
  return imageUrl(selected?.file_path, "w500");
}

function mapMovieMetadata(details, credits, videos, images) {
  if (!details || !nonEmpty(details.title)) return null;
  const logo = selectLogo(images);
  const directors = uniqueNames(credits?.crew, person => person.job === "Director" ? person.name : null, 10);
  const cast = uniqueNames(credits?.cast, person => person.name, MAX_MAIN_CAST);
  const trailer = Array.isArray(videos?.results)
    ? videos.results.find(video => video.site === "YouTube" && video.type === "Trailer" && video.key)
      || videos.results.find(video => video.site === "YouTube" && video.key)
    : null;
  const genres = Array.isArray(details.genres) ? uniqueNames(details.genres, genre => genre.name, 20) : [];
  const year = dateYear(details.release_date);
  return stripEmpty({
    name: details.title,
    imdbId: nonEmpty(details.imdb_id) || nonEmpty(details.external_ids?.imdb_id),
    description: nonEmpty(details.overview),
    poster: imageUrl(details.poster_path),
    background: imageUrl(details.backdrop_path, "w1280"),
    logo,
    genres,
    year,
    releaseInfo: year ? String(year) : undefined,
    runtime: Number.isFinite(details.runtime) && details.runtime > 0 ? details.runtime + " min" : undefined,
    rating: Number.isFinite(details.vote_average) && details.vote_count > 0 ? Number(details.vote_average).toFixed(1) : undefined,
    director: directors,
    cast,
    links: metadataLinks(details, credits, "movie"),
    trailer: trailer ? { id: trailer.key, title: nonEmpty(trailer.name) || "Trailer", site: "YouTube" } : undefined,
  });
}

async function getMovieCatalogMetadata(tmdbId) {
  const id = validTmdbId(tmdbId);
  if (!id) return null;
  // Include images in the appended response so Discover can use TMDb's
  // transparent title logo without adding a second network round-trip per movie.
  const details = await request("/movie/" + id + "?language=en-GB&append_to_response=credits,images,external_ids&include_image_language=en,null");
  return mapMovieMetadata(details, details?.credits, null, details?.images);
}

async function getSeriesCatalogMetadata(tmdbId) {
  const id = validTmdbId(tmdbId);
  if (!id) return null;
  // Append images alongside aggregate credits so Discover receives the
  // transparent title logo without an extra request for each series.
  const details = await request("/tv/" + id + "?language=en-GB&append_to_response=aggregate_credits,images,external_ids&include_image_language=en,null");
  return mapSeriesMetadata(details, details?.aggregate_credits, null, details?.images);
}

async function getMovieMetadata(tmdbId) {
  const id = validTmdbId(tmdbId);
  if (!id) return null;
  // Reuse the exact details/credits/images response already fetched for Discover.
  // Only trailers need a separate request; the shared request cache deduplicates it
  // when another detail request for the same movie is already in progress.
  const [details, videos] = await Promise.all([
    request("/movie/" + id + "?language=en-GB&append_to_response=credits,images&include_image_language=en,null"),
    request("/movie/" + id + "/videos?language=en-GB"),
  ]);
  return mapMovieMetadata(details, details?.credits, videos, details?.images);
}

function mapSeriesMetadata(details, credits, videos, images) {
  if (!details || !nonEmpty(details.name)) return null;
  const logo = selectLogo(images);
  const cast = uniqueNames(credits?.cast, person => person.name, MAX_MAIN_CAST);
  const trailer = Array.isArray(videos?.results)
    ? videos.results.find(video => video.site === "YouTube" && video.type === "Trailer" && video.key)
      || videos.results.find(video => video.site === "YouTube" && video.key)
    : null;
  const year = dateYear(details.first_air_date);
  const endYear = dateYear(details.last_air_date);
  const stillRunning = details.status === "Returning Series" || details.status === "In Production";
  const releaseInfo = year ? String(year) + (stillRunning ? "-" : endYear ? "-" + endYear : "") : undefined;
  const episodeRuntime = Array.isArray(details.episode_run_time)
    ? details.episode_run_time.find(n => Number.isFinite(n) && n > 0)
    : undefined;
  return stripEmpty({
    name: details.name,
    imdbId: nonEmpty(details.external_ids?.imdb_id) || nonEmpty(details.imdb_id),
    description: nonEmpty(details.overview),
    poster: imageUrl(details.poster_path),
    background: imageUrl(details.backdrop_path, "w1280"),
    logo,
    genres: Array.isArray(details.genres) ? uniqueNames(details.genres, genre => genre.name, 20) : [],
    year,
    releaseInfo,
    runtime: episodeRuntime ? episodeRuntime + " min" : undefined,
    rating: Number.isFinite(details.vote_average) && details.vote_count > 0 ? Number(details.vote_average).toFixed(1) : undefined,
    cast,
    links: metadataLinks(details, credits, "tv"),
    trailer: trailer ? { id: trailer.key, title: nonEmpty(trailer.name) || "Trailer", site: "YouTube" } : undefined,
  });
}

async function getSeriesMetadata(tmdbId) {
  const id = validTmdbId(tmdbId);
  if (!id) return null;
  // Reuse the exact details/credits/images response already fetched for Discover.
  // Only trailers need a separate request; the shared request cache deduplicates it
  // when another detail request for the same series is already in progress.
  const [details, videos] = await Promise.all([
    request("/tv/" + id + "?language=en-GB&append_to_response=aggregate_credits,images&include_image_language=en,null"),
    request("/tv/" + id + "/videos?language=en-GB"),
  ]);
  return mapSeriesMetadata(details, details?.aggregate_credits, videos, details?.images);
}

function mapSeasonEpisodes(data, season) {
  if (!data || !Array.isArray(data.episodes)) return null;
  return data.episodes.map(episode => ({
    season: Number.isSafeInteger(episode.season_number) ? episode.season_number : season,
    episode: Number.isSafeInteger(episode.episode_number) ? episode.episode_number : undefined,
    title: nonEmpty(episode.name),
    description: nonEmpty(episode.overview),
    thumbnail: imageUrl(episode.still_path, "w500"),
    released: nonEmpty(episode.air_date),
    runtime: Number.isFinite(episode.runtime) && episode.runtime > 0 ? episode.runtime + " min" : undefined,
    rating: Number.isFinite(episode.vote_average) && episode.vote_count > 0 ? Number(episode.vote_average).toFixed(1) : undefined,
    guestStars: uniqueNames(episode.guest_stars, person => person.name, 15),
    directors: uniqueNames(episode.crew, person => /director/i.test(String(person.job || "")) ? person.name : null, 10),
  })).filter(episode => Number.isSafeInteger(episode.episode) && episode.episode > 0);
}

async function getSeasonEpisodes(tmdbId, seasonNumber) {
  const id = validTmdbId(tmdbId);
  const season = Number(seasonNumber);
  if (!id || !Number.isSafeInteger(season) || season < 0 || season > 100) return null;
  const data = await request("/tv/" + id + "/season/" + season + "?language=en-GB");
  return mapSeasonEpisodes(data, season);
}

function stripEmpty(value) {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined || value[key] === null || value[key] === "" ||
        (Array.isArray(value[key]) && value[key].length === 0)) delete value[key];
  }
  return value;
}

module.exports = {
  getMovieMetadata,
  getSeriesMetadata,
  getMovieCatalogMetadata,
  getSeriesCatalogMetadata,
  getSeasonEpisodes,
  mapMovieMetadata,
  mapSeriesMetadata,
  mapSeasonEpisodes,
  validTmdbId,
  tmdbConfigured,
};
