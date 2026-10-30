"use strict";
const assert = require("assert");
const mode = process.argv[2];
const DAY = 86400000, HOUR = 3600000;
if (mode === "runtime") process.env.CATALOG_METADATA_REFRESH_MS = String(DAY);
let now = Date.UTC(2026, 9, 1, 12);
Date.now = () => now;
const safety = require("../../urlSafety");
let description = "Old source description", rating = "7.0", failOmdb = false;
const calls = { tmdb: 0, omdb: 0, seasons: 0 };
safety.safeFetch = async url => {
    const parsed = new URL(url);
    if (parsed.hostname === "www.omdbapi.com") {
        calls.omdb++;
        return failOmdb ? { ok: false, status: 503 } : { ok: true, status: 200,
            json: async () => ({ Response: "True", imdbID: "tt1234567", imdbRating: rating, Runtime: "60 min" }) };
    }
    assert.strictEqual(parsed.hostname, "api.themoviedb.org", "the fixture must intercept every request");
    calls.tmdb++;
    if (parsed.pathname.includes("/season/")) {
        calls.seasons++;
        return { ok: true, status: 200, text: async () => JSON.stringify({ episodes: [
            { id: 1, season_number: 1, episode_number: 1, runtime: 40, air_date: "2026-09-30" },
            { id: 2, season_number: 1, episode_number: 2, runtime: 80, air_date: "2026-10-02" }
        ] }) };
    }
    const details = { id: 123, name: "Example", title: "Example", overview: description,
        poster_path: "/p.jpg", backdrop_path: "/b.jpg", first_air_date: "2020-01-01",
        release_date: "2020-01-01", status: "Returning Series",
        runtime: 60, episode_run_time: mode === "runtime" ? [] : [60],
        seasons: [{ season_number: 1, episode_count: 2 }], number_of_episodes: 2,
        genres: [{ id: 18, name: "Drama" }], aggregate_credits: { cast: [{ name: "Actor" }] },
        credits: { cast: [{ name: "Actor" }], crew: [{ job: "Director", name: "Director" }] },
        external_ids: { imdb_id: "tt1234567" }, imdb_id: "tt1234567" };
    return { ok: true, status: 200, text: async () => JSON.stringify(details) };
};
const { M3UEPGAddon, omdbMetadataNeedsRefresh } = require("../../addon");
const tmdb = require("../../src/js/tmdbMetadata");
const omdb = require("../../src/js/omdbMetadata");
function preview(type, overrides = {}) {
    return { id: type === "movie" ? "iptv_vod_2" : "iptv_series_3", type, name: "Example",
        poster: "https://example.com/p.jpg", background: "https://example.com/b.jpg", description: "Old source description",
        genres: ["Drama"], year: 2020, runtime: "60 min", imdbId: "tt1234567", imdbRating: "7.0", cast: ["Actor"],
        ...(type === "movie" ? { director: ["Director"] } : {}),
        _tmdbId: "123", metadataVersion: 3, imdbIdChecked: true, omdbChecked: true,
        metadataCheckedAt: now - 15 * DAY, missingMetadataCheckedAt: now, omdbCheckedAt: now, ...overrides };
}
function addon(value) {
    const instance = new M3UEPGAddon({ provider: "direct" });
    instance.log = { debug() {}, info() {}, warn() {}, error() {} };
    instance.lastUpdate = now;
    instance[value.type === "movie" ? "movies" : "series"] = [
        { id: value.id, series_id: "3", type: value.type, name: value.name, tmdbId: "123" }
    ];
    const entries = new Map([[value.id, { value, savedAt: now }]]);
    instance.persistentCatalogMetaCache = {
        get: async id => entries.get(id) || null,
        set: async (id, val, current) => { if (!current || current()) entries.set(id, { value: val, savedAt: now }); }
    };
    return instance;
}
async function run() {
    if (mode === "runtime") {
        const original = await tmdb.getSeriesRuntimeMetadata("123");
        assert.strictEqual(original.runtime, "40 min");
        now += DAY;
        const previous = { ...original, version: 1, policyVersion: 1, checkedAt: now - DAY,
            attemptedAt: now - DAY, tmdbId: "123",
            seasons: original.seasons.map(season => ({ ...season, checkedAt: now - HOUR })) };
        const value = preview("series", { runtime: "40 min", runtimeAverage: previous, metadataCheckedAt: now });
        const instance = addon(value);
        const updated = await instance.ensureSeriesRuntimeAverage(instance.series[0], value);
        assert.strictEqual(updated.runtime, "60 min");
        assert.strictEqual(updated.runtimeAverage.episodeCount, 2);
        assert.strictEqual(calls.seasons, 2, "a full refresh must not reuse a young aggregate that still excludes a now-aired episode");
        return;
    }
    await tmdb.getSeriesCatalogMetadata("123");
    await tmdb.getMovieCatalogMetadata("123");
    await omdb.getByImdbId("tt1234567");
    now += 13 * DAY;
    description = "Updated source description"; rating = "8.0";
    if (mode === "full-metadata") {
        for (const type of ["movie", "series"]) {
            const before = { ...calls }, old = preview(type);
            const instance = addon(old);
            const result = await instance.getCatalogMetaAsync(old.id, type);
            assert.strictEqual(result.description, description);
            assert.strictEqual(result.imdbRating, rating);
            assert.strictEqual(result.metadataCheckedAt, now);
            assert.strictEqual(calls.tmdb, before.tmdb + 1);
            assert.strictEqual(calls.omdb, before.omdb + 1);
        }
    } else if (mode === "omdb-retry") {
        failOmdb = true;
        const old = preview("series"), instance = addon(old);
        const retained = await instance.getCatalogMetaAsync(old.id, "series");
        assert.strictEqual(retained.imdbRating, "7.0", "a failed full refresh must preserve the previous rating");
        assert.strictEqual(retained.omdbPending, true);
        assert.strictEqual(omdbMetadataNeedsRefresh(retained), false);
        now += 12 * HOUR + 1; failOmdb = false;
        assert.strictEqual(omdbMetadataNeedsRefresh(retained), true);
        const updated = await instance.getCatalogMetaAsync(old.id, "series");
        assert.strictEqual(updated.imdbRating, "8.0");
        assert.strictEqual(updated.omdbPending, false);
        assert.strictEqual(calls.omdb, 3, "the retry must bypass the complete retained raw response");
    } else throw new Error("Unknown API probe");
}
run().then(() => process.stdout.write(JSON.stringify({ mode, calls }) + "\n")).catch(error => {
    console.error(error.stack); process.exitCode = 1;
});
