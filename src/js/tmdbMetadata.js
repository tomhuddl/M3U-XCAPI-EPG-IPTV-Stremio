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
const pending = new Map();

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

async function request(path) {
  if (!tmdbConfigured()) return null;
  const cacheKey = "tmdb:" + path;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  if (pending.has(cacheKey)) return pending.get(cacheKey);

  const task = (async () => {
    try {
      const separator = path.includes("?") ? "&" : "?";
      const url = TMDB_API_BASE + path + separator + "api_key=" + encodeURIComponent(TMDB_API_KEY);
      const response = await safeFetch(url, {
        timeout: 12000,
        headers: { Accept: "application/json", "User-Agent": "M3U-XCAPI-EPG-IPTV-Stremio" },
      });
      if (!response.ok) return null;
      const data = await response.json();
      if (!data || typeof data !== "object" || Array.isArray(data)) return null;
      cache.set(cacheKey, data);
      return data;
    } catch {
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
  const genreType = mediaType === "tv" ? "tv" : "movie";
  for (const genre of Array.isArray(details?.genres) ? details.genres : []) {
    if (nonEmpty(genre?.name) && Number.isSafeInteger(genre.id) && genre.id > 0) {
      links.push({
        name: genre.name,
        category: "Genre",
        url: "https://www.themoviedb.org/genre/" + genre.id,
      });
    }
  }
  const cast = Array.isArray(credits?.cast) ? credits.cast : [];
  for (const person of cast.slice(0, 20)) {
    if (nonEmpty(person?.name) && Number.isSafeInteger(person.id) && person.id > 0) {
      links.push({
        name: person.name,
        category: "Actor",
        url: "https://www.themoviedb.org/person/" + person.id,
      });
    }
  }
  const crew = Array.isArray(credits?.crew) ? credits.crew : [];
  const directors = mediaType === "movie"
    ? crew.filter(person => person?.job === "Director")
    : crew.filter(person => Array.isArray(person?.jobs) && person.jobs.some(job => /director/i.test(String(job?.job || ""))));
  for (const person of directors.slice(0, 10)) {
    if (nonEmpty(person?.name) && Number.isSafeInteger(person.id) && person.id > 0) {
      links.push({
        name: person.name,
        category: "Director",
        url: "https://www.themoviedb.org/person/" + person.id,
      });
    }
  }
  return links;
}

function mapMovieMetadata(details, credits, videos) {
  if (!details || !nonEmpty(details.title)) return null;
  const directors = uniqueNames(credits?.crew, person => person.job === "Director" ? person.name : null, 10);
  const cast = uniqueNames(credits?.cast, person => person.name, 20);
  const trailer = Array.isArray(videos?.results)
    ? videos.results.find(video => video.site === "YouTube" && video.type === "Trailer" && video.key)
      || videos.results.find(video => video.site === "YouTube" && video.key)
    : null;
  const genres = Array.isArray(details.genres) ? uniqueNames(details.genres, genre => genre.name, 20) : [];
  const year = dateYear(details.release_date);
  return stripEmpty({
    name: details.title,
    description: nonEmpty(details.overview),
    poster: imageUrl(details.poster_path),
    background: imageUrl(details.backdrop_path, "w1280"),
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

async function getMovieMetadata(tmdbId) {
  const id = validTmdbId(tmdbId);
  if (!id) return null;
  const [details, credits, videos] = await Promise.all([
    request("/movie/" + id + "?language=en-GB"),
    request("/movie/" + id + "/credits?language=en-GB"),
    request("/movie/" + id + "/videos?language=en-GB"),
  ]);
  return mapMovieMetadata(details, credits, videos);
}

function mapSeriesMetadata(details, credits, videos) {
  if (!details || !nonEmpty(details.name)) return null;
  const cast = uniqueNames(credits?.cast, person => person.name, 20);
  const trailer = Array.isArray(videos?.results)
    ? videos.results.find(video => video.site === "YouTube" && video.type === "Trailer" && video.key)
      || videos.results.find(video => video.site === "YouTube" && video.key)
    : null;
  const year = dateYear(details.first_air_date);
  const endYear = dateYear(details.last_air_date);
  const stillRunning = details.status === "Returning Series" || details.status === "In Production";
  const releaseInfo = year ? String(year) + (endYear ? "-" + endYear : stillRunning ? "-" : "") : undefined;
  const episodeRuntime = Array.isArray(details.episode_run_time)
    ? details.episode_run_time.find(n => Number.isFinite(n) && n > 0)
    : undefined;
  return stripEmpty({
    name: details.name,
    description: nonEmpty(details.overview),
    poster: imageUrl(details.poster_path),
    background: imageUrl(details.backdrop_path, "w1280"),
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
  const [details, credits, videos] = await Promise.all([
    request("/tv/" + id + "?language=en-GB"),
    request("/tv/" + id + "/aggregate_credits?language=en-GB"),
    request("/tv/" + id + "/videos?language=en-GB"),
  ]);
  return mapSeriesMetadata(details, credits, videos);
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
  getSeasonEpisodes,
  mapMovieMetadata,
  mapSeriesMetadata,
  mapSeasonEpisodes,
  validTmdbId,
  tmdbConfigured,
};
