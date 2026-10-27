const assert = require("assert");
const { M3UEPGAddon } = require("../addon");
const tmdbMetadata = require("../src/js/tmdbMetadata");
const omdbMetadata = require("../src/js/omdbMetadata");
const PersistentSeriesInfoCache = require("../persistentSeriesInfoCache");
const DAY_MS = 24 * 60 * 60 * 1000;

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function memoryMetadataStore(initialValues = []) {
    const entries = new Map(initialValues.map(value => [String(value.id), {
        value: structuredClone(value), savedAt: Date.now()
    }]));
    return {
        entries,
        get: async key => {
            const entry = entries.get(String(key));
            return entry ? { ...entry, value: structuredClone(entry.value), fresh: true } : null;
        },
        set: async (key, value, canStore) => {
            if (canStore && !canStore()) return;
            entries.set(String(key), { value: structuredClone(value), savedAt: Date.now() });
        },
        delete: async key => { entries.delete(String(key)); },
        flush: async () => {},
        retainCatalogItems: async ids => {
            const keep = new Set(ids);
            for (const key of entries.keys()) {
                if (!key.startsWith("__catalog_prefetch_status__:") && !keep.has(key)) entries.delete(key);
            }
        }
    };
}

function preview(type, overrides = {}) {
    const now = Date.now();
    return {
        id: type === "movie" ? "iptv_vod_2" : "iptv_series_3",
        type, name: "Example title",
        poster: "https://example.com/tmdb-poster.jpg",
        background: "https://example.com/tmdb-background.jpg",
        description: "Previously saved complete description.",
        genres: ["Drama"], year: 2020, releaseInfo: "2020", runtime: "120 min",
        imdbId: "tt1234567", imdbRating: "7.4", cast: ["Actor One"],
        ...(type === "movie" ? { director: "Director One" } : {}),
        _tmdbId: "123", imdbIdChecked: true, omdbChecked: true, omdbCheckedAt: now,
        metadataVersion: 3, metadataCheckedAt: now, missingMetadataCheckedAt: now,
        ...overrides
    };
}

function addonFor(type, storedPreview = null) {
    const addon = new M3UEPGAddon({ provider: "direct" });
    const item = {
        id: type === "movie" ? "iptv_vod_2" : "iptv_series_3",
        type, name: "Example title",
        ...(type === "series" ? { series_id: "3" } : {})
    };
    addon[type === "movie" ? "movies" : "series"] = [item];
    addon.persistentCatalogMetaCache = memoryMetadataStore(storedPreview ? [storedPreview] : []);
    addon.log = { debug() {}, info() {}, warn() {}, error() {} };
    return { addon, item, store: addon.persistentCatalogMetaCache };
}

async function settleMetadataWrites(addon) {
    while (addon.catalogMetaPersistWrites.size) {
        await Promise.allSettled([...addon.catalogMetaPersistWrites]);
        await Promise.resolve();
    }
}

async function testPartialMetadataRefreshRetainsKnownMovieAndSeriesFields() {
    for (const type of ["movie", "series"]) {
        const old = preview(type, { metadataCheckedAt: Date.now() - 100 * DAY_MS });
        const { addon, item, store } = addonFor(type, old);
        addon.catalogMetaCache.set(item.id, old);
        addon._getCatalogMetaAsync = async () => ({
            id: item.id, type, name: item.name, _tmdbId: "123", metadataVersion: 3,
            poster: "https://example.com/new-poster.jpg", background: "",
            description: undefined, genres: [], runtime: null, imdbRating: "", cast: [], director: undefined
        });
        const refreshed = await addon.getCatalogMetaAsync(item.id, type);
        assert.strictEqual(refreshed.poster, "https://example.com/new-poster.jpg");
        for (const field of ["background", "description", "genres", "runtime", "imdbRating", "cast"]) {
            assert.deepStrictEqual(refreshed[field], old[field], type + " must retain known " + field);
        }
        if (type === "movie") assert.strictEqual(refreshed.director, old.director);
        assert.strictEqual(store.entries.get(item.id).value.description, old.description);
    }
}

async function testSparsePreviewDescriptionSurvivesMetadataRefresh() {
    const old = preview("series", {
        poster: undefined, background: undefined, genres: [], year: undefined, releaseInfo: undefined,
        runtime: undefined, cast: [], imdbRating: undefined,
        metadataCheckedAt: Date.now() - 100 * DAY_MS, missingMetadataCheckedAt: Date.now() - DAY_MS
    });
    const { addon, item } = addonFor("series", old);
    addon._getCatalogMetaAsync = async () => ({
        id: item.id, type: "series", name: item.name, _tmdbId: "123", description: undefined,
        poster: "https://example.com/new-poster.jpg", metadataVersion: 3
    });
    const refreshed = await addon.getCatalogMetaAsync(item.id, "series");
    assert.strictEqual(refreshed.description, old.description,
        "a partial preview must retain its description even when it lacks other detail fields");
}

async function testConfirmedTmdbIdentityChangeDoesNotCarryOldMetadata() {
    const old = preview("movie", { metadataCheckedAt: Date.now() - 100 * DAY_MS });
    const { addon, item, store } = addonFor("movie", old);
    addon.catalogMetaCache.set(item.id, old);
    addon._getCatalogMetaAsync = async () => ({
        id: item.id, type: "movie", name: "Replacement title", _tmdbId: "456", metadataVersion: 3,
        poster: "https://example.com/replacement-poster.jpg"
    });
    const refreshed = await addon.getCatalogMetaAsync(item.id, "movie");
    assert.strictEqual(refreshed.name, "Replacement title");
    assert.strictEqual(refreshed._tmdbId, "456");
    for (const field of ["description", "imdbId", "imdbRating", "cast", "director"]) {
        assert.strictEqual(refreshed[field], undefined, "replacement title must not inherit old " + field);
    }
    assert.strictEqual(store.entries.get(item.id).value.description, undefined);
}

async function testMovieProviderFallbackCannotReplaceSavedTmdbMetadata() {
    const old = preview("movie", { metadataCheckedAt: Date.now() - 100 * DAY_MS });
    const { addon, item, store } = addonFor("movie", old);
    Object.assign(item, {
        tmdbId: "123", plot: "Provider-only plot", poster: "https://example.com/provider-poster.jpg",
        attributes: { "group-title": "Provider category" }
    });
    const original = tmdbMetadata.getMovieCatalogMetadata;
    tmdbMetadata.getMovieCatalogMetadata = async () => null;
    try {
        const refreshed = await addon.getCatalogMetaAsync(item.id, "movie");
        assert.strictEqual(refreshed.description, old.description);
        assert.strictEqual(refreshed.poster, old.poster);
        assert.deepStrictEqual(refreshed.genres, old.genres);
        assert.strictEqual(store.entries.get(item.id).value.description, old.description);
    } finally {
        tmdbMetadata.getMovieCatalogMetadata = original;
    }
}

async function testDetailedMetadataBackfillSurvivesCatalogueMemoryEviction() {
    for (const type of ["movie", "series"]) {
        const { addon, item, store } = addonFor(type);
        const detailed = preview(type, {
            description: "A complete description fetched on the full title page.",
            videos: [{ id: "episode-1", title: "Not a card field" }]
        });
        assert.strictEqual(await addon.persistDetailedCatalogPreview(item.id, type, "123", detailed), true);
        await settleMetadataWrites(addon);
        assert.strictEqual(store.entries.get(item.id).value.videos, undefined,
            "the preview cache must not retain a full series episode list");
        await addon.persistDetailedCatalogPreview(item.id, type, null, {
            name: "Provider title", poster: "https://via.placeholder.com/300x450",
            description: type === "movie" ? "Movie: Provider title" : "Series / Show",
            genres: [type === "movie" ? "Movie" : "Series"]
        }, { providerFallback: true });
        await settleMetadataWrites(addon);
        addon.catalogMetaCache.clear();
        addon._getCatalogMetaAsync = async () => { throw new Error("fresh persisted metadata should avoid an API request"); };
        const reloaded = await addon.getCatalogMetaAsync(item.id, type);
        assert.strictEqual(reloaded.description, detailed.description);
        assert.strictEqual(reloaded.poster, detailed.poster);
        assert.deepStrictEqual(reloaded.genres, detailed.genres);
    }
}

async function testConcurrentDetailBackfillSurvivesPartialAndFailedRefreshes() {
    for (const responseKind of ["partial", "failed"]) {
        const old = preview("series", { metadataCheckedAt: Date.now() - 100 * DAY_MS });
        const { addon, item, store } = addonFor("series", old);
        addon.catalogMetaCache.set(item.id, old);
        const started = deferred();
        const response = deferred();
        addon._getCatalogMetaAsync = async () => { started.resolve(); return response.promise; };
        const refresh = addon.getCatalogMetaAsync(item.id, "series");
        await started.promise;
        await addon.persistDetailedCatalogPreview(item.id, "series", "123", preview("series", {
            description: "New description obtained while the catalogue request was running."
        }));
        await settleMetadataWrites(addon);
        response.resolve(responseKind === "partial" ? {
            id: item.id, type: "series", name: item.name, _tmdbId: "123", metadataVersion: 3, description: undefined
        } : null);
        const refreshed = await refresh;
        assert.strictEqual(refreshed.description,
            "New description obtained while the catalogue request was running.",
            responseKind + " refresh must not restore its captured old description");
        assert.strictEqual(store.entries.get(item.id).value.description, refreshed.description);
    }
}

async function testDelayedPersistentReadCannotRestoreAnOlderCataloguePreview() {
    const old = preview("movie");
    const { addon, item, store } = addonFor("movie", old);
    addon.catalogMetaCache.set(item.id, old);
    const started = deferred();
    const released = deferred();
    const originalGet = store.get;
    let delayed = true;
    store.get = async key => {
        const captured = await originalGet(key);
        if (delayed) { delayed = false; started.resolve(); await released.promise; }
        return captured;
    };
    addon._getCatalogMetaAsync = async () => { throw new Error("a current complete preview does not need refreshing"); };
    const lookup = addon.getCatalogMetaAsync(item.id, "movie");
    await started.promise;
    await addon.persistDetailedCatalogPreview(item.id, "movie", "123", preview("movie", {
        description: "Newest full description."
    }));
    await settleMetadataWrites(addon);
    released.resolve();
    const result = await lookup;
    assert.strictEqual(result.description, "Newest full description.");
    assert.strictEqual(addon.catalogMetaCache.get(item.id).description, "Newest full description.");
}

async function testWarmupReportsIncompleteMetadataSeparatelyFromDeferredRetries() {
    const incomplete = preview("series", { description: undefined });
    const { addon, store } = addonFor("series", incomplete);
    const summaries = [];
    const warnings = [];
    addon.log = {
        debug() {}, error() {},
        info: (message, details) => summaries.push({ message, details }),
        warn: (message, details) => warnings.push({ message, details })
    };
    let apiCalls = 0;
    addon._getCatalogMetaAsync = async () => { apiCalls++; return null; };
    addon.startContinuousCatalogPrefetch("series", 10, 1);
    const job = addon.catalogPrefetchJobs.get("series");
    assert.ok(job);
    await job;
    const summary = summaries.find(entry => entry.message === "Persistent catalogue metadata scan complete");
    assert.ok(summary, "a completed scan should emit a summary");
    assert.strictEqual(summary.details.incompleteItems, 1);
    assert.strictEqual(summary.details.retriesDeferredByBackoff, 1);
    assert.deepStrictEqual(summary.details.missingFieldCounts, { description: 1 });
    assert.strictEqual(apiCalls, 0, "a recently checked missing description must respect retry backoff");
    assert.deepStrictEqual(warnings, []);
    assert.strictEqual(store.entries.get("__catalog_prefetch_status__:series").value.version, 4);
}

async function testLateSeriesDetailsCannotRepopulateANewerProviderGeneration() {
    const provider = require("../src/js/providers/xtreamProvider");
    const original = provider.fetchSeriesInfo;
    for (const removed of [false, true]) {
        const addon = new M3UEPGAddon({ provider: "xtream" });
        addon.series = [{ id: "iptv_series_3", series_id: "3", type: "series", name: "Example" }];
        addon.lastUpdate = 1000;
        addon.log = { debug() {}, info() {}, warn() {}, error() {} };
        const writes = [];
        addon.persistentSeriesInfoCache = {
            get: async () => null,
            set: async (id, value, generation, canStore) => {
                if (!canStore || canStore()) writes.push({ id, value, generation });
            },
            delete: async () => {}
        };
        const started = deferred();
        const oldResponse = deferred();
        let requests = 0;
        provider.fetchSeriesInfo = async () => {
            if (++requests === 1) { started.resolve(); return oldResponse.promise; }
            return { videos: [{ id: "new-episode", url: "https://example.com/new.mp4" }], tmdbId: "456" };
        };
        try {
            const oldLookup = addon.ensureSeriesInfo("3");
            await started.promise;
            addon.lastUpdate = 1001;
            if (removed) addon.series = [];
            else await addon.ensureSeriesInfo("3");
            oldResponse.resolve({ videos: [{ id: "old-episode", url: "https://example.com/old.mp4" }], tmdbId: "123" });
            assert.strictEqual(await oldLookup, null);
            assert.strictEqual(addon.seriesEpisodeCache.has("old-episode"), false);
            if (removed) {
                assert.strictEqual(addon.seriesInfoCache.has("3"), false);
                assert.deepStrictEqual(writes, []);
            } else {
                assert.strictEqual(addon.seriesInfoCache.get("3").tmdbId, "456");
                assert.strictEqual(writes.length, 1);
                assert.strictEqual(writes[0].generation, 1001);
            }
        } finally {
            provider.fetchSeriesInfo = original;
            oldResponse.resolve({ videos: [] });
        }
    }
}

async function testLateSeriesTmdbLookupCannotOverwriteTheNewProviderGeneration() {
    const provider = require("../src/js/providers/xtreamProvider");
    const original = provider.fetchSeriesTmdbId;
    const addon = new M3UEPGAddon({ provider: "xtream" });
    addon.series = [{ id: "iptv_series_3", series_id: "3", type: "series", name: "Example" }];
    addon.lastUpdate = 1000;
    addon.persistentSeriesInfoCache = { get: async () => null };
    const started = deferred();
    const oldResponse = deferred();
    let requests = 0;
    provider.fetchSeriesTmdbId = async () => {
        if (++requests === 1) { started.resolve(); return oldResponse.promise; }
        return "456";
    };
    try {
        const oldLookup = addon.ensureSeriesTmdbId("3");
        await started.promise;
        addon.lastUpdate = 1001;
        assert.strictEqual(await addon.ensureSeriesTmdbId("3"), "456");
        oldResponse.resolve("123");
        assert.strictEqual(await oldLookup, null);
        assert.strictEqual(addon.seriesInfoCache.get("series-tmdb-id:3"), "456");
    } finally {
        provider.fetchSeriesTmdbId = original;
        oldResponse.resolve(null);
    }
}

async function testProviderRefreshInvalidatesChangedSameIdTitles() {
    const provider = require("../src/js/providers/directProvider");
    const original = provider.fetchData;
    const addon = new M3UEPGAddon({
        provider: "direct", m3uUrl: "https://example.com/metadata-identity-refresh-regression.m3u"
    });
    const changedMovie = { id: "iptv_vod_2", type: "movie", name: "Example title", tmdbId: "123" };
    const stableMovie = { id: "iptv_vod_4", type: "movie", name: "Unchanged title", tmdbId: "789" };
    const changedSeries = { id: "iptv_series_3", series_id: "3", type: "series", name: "Old series title" };
    addon.movies = [changedMovie, stableMovie];
    addon.series = [changedSeries];
    addon.lastUpdate = Date.now() - DAY_MS;
    const oldUpdatedAt = addon.lastUpdate;
    const storedMovie = preview("movie");
    const storedStableMovie = preview("movie", { id: stableMovie.id, name: stableMovie.name, _tmdbId: "789" });
    const storedSeries = preview("series");
    const store = memoryMetadataStore([storedMovie, storedStableMovie, storedSeries]);
    addon.persistentCatalogMetaCache = store;
    addon.persistentSeriesInfoCache = { retainSeries: async () => {}, flush: async () => {} };
    addon.saveToCache = async () => {};
    addon.log = { debug() {}, info() {}, warn() {}, error() {} };
    for (const value of [storedMovie, storedStableMovie, storedSeries]) addon.catalogMetaCache.set(value.id, value);
    addon.seriesInfoCache.set("movie-tmdb:" + changedMovie.id, "123");
    addon.seriesInfoCache.set("movie-tmdb-miss:" + changedMovie.id, true);
    addon.seriesInfoCache.set("movie-tmdb:" + stableMovie.id, "789");
    for (const type of ["movie", "series"]) {
        addon.catalogPrefetchLastCompleted.set(type, Date.now());
        addon.catalogPrefetchLastFingerprint.set(type, "old-fingerprint");
        await store.set("__catalog_prefetch_status__:" + type, { version: 4, completedAt: Date.now() });
    }
    provider.fetchData = async refreshed => {
        refreshed.channels = [];
        refreshed.movies = [
            { ...changedMovie, tmdbId: "456" },
            { ...stableMovie, plot: "An updated provider plot does not change title identity" }
        ];
        refreshed.series = [{ ...changedSeries, name: "Replacement series title" }];
        refreshed.epgData = {};
    };
    try {
        await addon.updateData(true);
        assert.ok(addon.lastUpdate > oldUpdatedAt, "the simulated provider refresh must commit");
        for (const id of [changedMovie.id, changedSeries.id]) {
            assert.strictEqual(addon.catalogMetaCache.has(id), false, "changed title metadata must leave memory");
            assert.strictEqual(store.entries.has(id), false, "changed title metadata must leave persistent storage");
        }
        assert.strictEqual(addon.catalogMetaCache.get(stableMovie.id).description, storedStableMovie.description);
        assert.strictEqual(store.entries.get(stableMovie.id).value.description, storedStableMovie.description);
        assert.strictEqual(addon.seriesInfoCache.has("movie-tmdb:" + changedMovie.id), false);
        assert.strictEqual(addon.seriesInfoCache.has("movie-tmdb-miss:" + changedMovie.id), false);
        assert.strictEqual(addon.seriesInfoCache.get("movie-tmdb:" + stableMovie.id), "789");
        for (const type of ["movie", "series"]) {
            assert.strictEqual(addon.catalogPrefetchLastCompleted.has(type), false);
            assert.strictEqual(store.entries.has("__catalog_prefetch_status__:" + type), false);
        }
    } finally {
        provider.fetchData = original;
    }
}
async function testLatePartialOmdbResultPreservesNewlyBackfilledFields() {
    const old = preview("movie", {
        imdbRating: undefined, runtime: undefined,
        metadataCheckedAt: Date.now() - 100 * DAY_MS,
        missingMetadataCheckedAt: Date.now() - 100 * DAY_MS,
        omdbCheckedAt: Date.now() - 100 * DAY_MS
    });
    const { addon, item, store } = addonFor("movie", old);
    addon.catalogMetaCache.set(item.id, old);
    const started = deferred();
    const response = deferred();
    const original = omdbMetadata.getByImdbId;
    omdbMetadata.getByImdbId = async () => { started.resolve(); return response.promise; };
    try {
        const lookup = addon.getDetailOmdbMetadata(old.imdbId, item.id);
        await started.promise;
        await addon.persistDetailedCatalogPreview(item.id, "movie", "123", preview("movie", {
            description: "Newest description from a parallel full detail lookup.", imdbRating: "8.2", runtime: "145 min"
        }));
        await settleMetadataWrites(addon);
        response.resolve({ imdbId: old.imdbId, omdbChecked: true, omdbCheckedAt: Date.now() });
        const result = await lookup;
        await settleMetadataWrites(addon);
        assert.strictEqual(result.imdbRating, "8.2");
        assert.strictEqual(result.runtime, "145 min");
        assert.strictEqual(store.entries.get(item.id).value.description,
            "Newest description from a parallel full detail lookup.");
    } finally {
        omdbMetadata.getByImdbId = original;
        response.resolve(null);
    }
}

async function testOldGenerationCatalogueResponseCannotRestoreInvalidatedTitleMetadata() {
    const old = preview("movie", { metadataCheckedAt: Date.now() - 100 * DAY_MS });
    const { addon, item, store } = addonFor("movie", old);
    addon.lastUpdate = 1000;
    addon.catalogMetaCache.set(item.id, old);
    const started = deferred();
    const response = deferred();
    addon._getCatalogMetaAsync = async () => { started.resolve(); return response.promise; };
    const lookup = addon.getCatalogMetaAsync(item.id, "movie");
    await started.promise;
    addon.lastUpdate = 1001;
    addon.movies = [{ ...item, name: "Replacement title", tmdbId: "456" }];
    addon.catalogMetaCache.delete(item.id);
    await store.delete(item.id);
    response.resolve({ ...old, description: "Late metadata for the old title" });
    assert.strictEqual(await lookup, null);
    assert.strictEqual(addon.catalogMetaCache.has(item.id), false);
    assert.strictEqual(store.entries.has(item.id), false);
}

async function testChangedSeriesDetailsPruningKeepsOnlyCurrentGenerationReplacement() {
    const cache = new PersistentSeriesInfoCache("series-prune-regression", { directory: "" });
    cache.enabled = true;
    cache.init = async () => {};
    const deleted = [];
    cache.journal = { mark: (key, value) => { if (value === null) deleted.push(key); }, forceCompact: false };
    cache.scheduleWrite = () => {};
    for (const [id, generation] of [["3", 1000], ["4", 2000], ["5", 1000], ["6", 1000]]) {
        cache.entries.set(id, { savedAt: Date.now(), providerLastUpdate: generation, value: { videos: [] } });
    }
    await cache.retainSeries(new Set(["3", "4", "5"]), {
        invalidatedSeriesIds: new Set(["3", "4"]), providerLastUpdate: 2000
    });
    assert.deepStrictEqual([...cache.entries.keys()], ["4", "5"],
        "changed titles must lose old episodes while a newly fetched replacement and unchanged title stay cached");
    assert.deepStrictEqual(deleted.sort(), ["3", "6"]);
    assert.strictEqual(cache.dirty, true);
}

async function testSavedSeriesFallbackRetriesSoonAfterProviderRecovery() {
    const provider = require("../src/js/providers/xtreamProvider");
    const originalFetch = provider.fetchSeriesInfo;
    const originalNow = Date.now;
    let now = originalNow();
    const addon = new M3UEPGAddon({ provider: "xtream" });
    addon.series = [{ id: "iptv_series_3", series_id: "3", name: "Example", type: "series" }];
    addon.lastUpdate = 1000;
    addon.log = { debug() {}, info() {}, warn() {}, error() {} };
    const saved = { videos: [{ id: "saved-episode", url: "https://example.com/saved.mp4" }], tmdbId: "123" };
    addon.persistentSeriesInfoCache = {
        get: async () => ({ value: saved, fresh: false, providerLastUpdate: 999 }),
        set: async () => {}
    };
    let requests = 0;
    provider.fetchSeriesInfo = async () => {
        if (++requests === 1) return { videos: [], fetchError: "HTTP 503" };
        return { videos: [{ id: "new-episode", url: "https://example.com/new.mp4" }], tmdbId: "123" };
    };
    Date.now = () => now;
    try {
        const fallback = await addon.ensureSeriesInfo("3");
        assert.strictEqual(fallback.videos[0].id, "saved-episode");
        now += 4 * 60 * 1000;
        assert.strictEqual((await addon.ensureSeriesInfo("3")).videos[0].id, "saved-episode");
        assert.strictEqual(requests, 1, "the short fallback backoff must prevent immediate retry storms");
        now += 2 * 60 * 1000;
        assert.strictEqual((await addon.ensureSeriesInfo("3")).videos[0].id, "new-episode");
        assert.strictEqual(requests, 2, "saved fallback episodes should retry after five minutes rather than six hours");
    } finally {
        Date.now = originalNow;
        provider.fetchSeriesInfo = originalFetch;
    }
}

async function testWarmupRespectsFailedSchemaAndImdbLookupBackoff() {
    for (const pending of ["schema", "imdb"]) {
        const incomplete = preview("series", {
            metadataCheckedAt: Date.now() - 100 * DAY_MS,
            metadataRefreshAttemptedAt: Date.now(),
            ...(pending === "schema" ? { metadataVersion: 2 } : { imdbId: undefined, imdbIdChecked: false })
        });
        const { addon } = addonFor("series", incomplete);
        const warnings = [];
        const summaries = [];
        addon.log = {
            debug() {}, error() {},
            warn: (message, details) => warnings.push({ message, details }),
            info: (message, details) => summaries.push({ message, details })
        };
        let requests = 0;
        addon._getCatalogMetaAsync = async () => { requests++; return null; };
        addon.startContinuousCatalogPrefetch("series", 10, 1);
        await addon.catalogPrefetchJobs.get("series");
        assert.strictEqual(requests, 0, "a recent failed " + pending + " lookup must honor its failure backoff");
        assert.deepStrictEqual(warnings, [], "deferred " + pending + " work must not be reported as retries still due");
        const summary = summaries.find(entry => entry.message === "Persistent catalogue metadata scan complete");
        assert.ok(summary);
        assert.strictEqual(summary.details.incompleteItems, 1);
        assert.strictEqual(summary.details.retriesDeferredByBackoff, 1);
    }
}

async function testCompletePreviewRetainedAfterProviderFallbackRetriesAfterFailureBackoff() {
    const originalNow = Date.now;
    let now = originalNow();
    const old = preview("movie", { metadataCheckedAt: now - 100 * DAY_MS });
    const { addon, item } = addonFor("movie", old);
    addon.catalogMetaCache.set(item.id, old);
    let requests = 0;
    addon._getCatalogMetaAsync = async () => {
        requests++;
        return {
            id: item.id, type: "movie", name: item.name, _tmdbId: null,
            metadataVersion: 3, imdbIdChecked: true,
            description: "Provider-only fallback description", genres: ["Provider category"]
        };
    };
    Date.now = () => now;
    try {
        const retained = await addon.getCatalogMetaAsync(item.id, "movie");
        assert.strictEqual(retained.description, old.description);
        assert.strictEqual(retained.metadataCheckedAt, old.metadataCheckedAt,
            "a provider fallback must not mark retained TMDb fields as newly refreshed for fourteen days");
        assert.strictEqual(retained.metadataRefreshAttemptedAt, now);
        now += 6 * 60 * 60 * 1000;
        await addon.getCatalogMetaAsync(item.id, "movie");
        assert.strictEqual(requests, 1, "a failed TMDb refresh must honor failure backoff");
        now += 6 * 60 * 60 * 1000 + 1;
        await addon.getCatalogMetaAsync(item.id, "movie");
        assert.strictEqual(requests, 2, "retained complete metadata must retry after twelve hours rather than fourteen days");
    } finally {
        Date.now = originalNow;
    }
}

module.exports = [
    testPartialMetadataRefreshRetainsKnownMovieAndSeriesFields,
    testSparsePreviewDescriptionSurvivesMetadataRefresh,
    testConfirmedTmdbIdentityChangeDoesNotCarryOldMetadata,
    testMovieProviderFallbackCannotReplaceSavedTmdbMetadata,
    testDetailedMetadataBackfillSurvivesCatalogueMemoryEviction,
    testConcurrentDetailBackfillSurvivesPartialAndFailedRefreshes,
    testDelayedPersistentReadCannotRestoreAnOlderCataloguePreview,
    testLatePartialOmdbResultPreservesNewlyBackfilledFields,
    testOldGenerationCatalogueResponseCannotRestoreInvalidatedTitleMetadata,
    testWarmupReportsIncompleteMetadataSeparatelyFromDeferredRetries,
    testProviderRefreshInvalidatesChangedSameIdTitles,
    testLateSeriesDetailsCannotRepopulateANewerProviderGeneration,
    testLateSeriesTmdbLookupCannotOverwriteTheNewProviderGeneration,
    testChangedSeriesDetailsPruningKeepsOnlyCurrentGenerationReplacement,
    testSavedSeriesFallbackRetriesSoonAfterProviderRecovery,
    testWarmupRespectsFailedSchemaAndImdbLookupBackoff,
    testCompletePreviewRetainedAfterProviderFallbackRetriesAfterFailureBackoff
];