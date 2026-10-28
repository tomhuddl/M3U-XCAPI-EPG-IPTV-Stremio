const assert = require("assert");
const createAddon = require("../addon");
const { M3UEPGAddon, disposeAddonInterface } = createAddon;
const tmdbMetadata = require("../src/js/tmdbMetadata");
const { parseRuntimeMinutes, averageEpisodeRuntime, providerEpisodeFingerprint, averageProviderEpisodes } = require("../seriesRuntime");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function metadataStore(values = []) {
    const entries = new Map(values.map(value => [String(value.id), { value: structuredClone(value), savedAt: Date.now() }]));
    return {
        entries,
        get: async key => entries.has(String(key))
            ? { ...entries.get(String(key)), value: structuredClone(entries.get(String(key)).value), fresh: true } : null,
        set: async (key, value, canStore) => {
            if (!canStore || canStore()) entries.set(String(key), { value: structuredClone(value), savedAt: Date.now() });
        },
        delete: async key => { entries.delete(String(key)); },
        flush: async () => {},
        retainCatalogItems: async () => {}
    };
}

function seriesPreview(overrides = {}) {
    const now = Date.now();
    return {
        id: "iptv_series_3", type: "series", name: "Example series", _tmdbId: "123",
        poster: "https://example.com/poster.jpg", background: "https://example.com/background.jpg",
        description: "A full description", genres: ["Drama"], year: 2026, releaseInfo: "2026-",
        cast: ["Actor One"], imdbId: "tt1234567", imdbRating: "8.0", imdbIdChecked: true,
        omdbChecked: true, omdbCheckedAt: now, metadataVersion: 3,
        metadataCheckedAt: now, missingMetadataCheckedAt: now, ...overrides
    };
}

function defaultProviderVideos() {
    return Array.from({ length: 9 }, (_, index) => ({ id: "ep-1-" + (index + 1), season: 1, episode: index + 1 }));
}

function runtimeAddon(stored = seriesPreview()) {
    const addon = new M3UEPGAddon({ provider: "direct" });
    const item = { id: stored.id, series_id: "3", type: "series", name: stored.name, tmdbId: "123" };
    addon.series = [item];
    addon.lastUpdate = 1000;
    addon.directSeriesEpisodeIndex.set("3", defaultProviderVideos());
    addon.log = quietLog;
    addon.persistentCatalogMetaCache = metadataStore([stored]);
    addon.persistentSeriesInfoCache = { get: async () => null };
    return { addon, item, store: addon.persistentCatalogMetaCache };
}

async function settleWrites(addon) {
    while (addon.catalogMetaPersistWrites.size) {
        await Promise.allSettled([...addon.catalogMetaPersistWrites]);
        await Promise.resolve();
    }
}

async function withTmdbRuntimeResult(result, run) {
    const original = tmdbMetadata.getSeriesRuntimeMetadata;
    let calls = 0;
    tmdbMetadata.getSeriesRuntimeMetadata = async (...args) => {
        calls++;
        return typeof result === "function" ? result(...args) : structuredClone(result);
    };
    try { await run(() => calls); } finally { tmdbMetadata.getSeriesRuntimeMetadata = original; }
}

async function withFreshFetchModule(moduleName, fetchMock, run, withKey = false) {
    const safety = require("../urlSafety");
    const modulePath = require.resolve(moduleName);
    const originalFetch = safety.safeFetch;
    const originalModule = require.cache[modulePath];
    const originalKey = process.env.TMDB_API_KEY;
    safety.safeFetch = fetchMock;
    if (withKey) process.env.TMDB_API_KEY = "runtime-tests-only-key";
    delete require.cache[modulePath];
    try { await run(require(modulePath)); } finally {
        safety.safeFetch = originalFetch;
        delete require.cache[modulePath];
        if (originalModule) require.cache[modulePath] = originalModule;
        if (originalKey === undefined) delete process.env.TMDB_API_KEY;
        else process.env.TMDB_API_KEY = originalKey;
    }
}

function tmdbResponse(data, status = 200) {
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data) };
}

function tvDetails(seasons, extra = {}) {
    return { id: 123, name: "Example series", episode_run_time: [],
        seasons: seasons.map(([season_number, episode_count]) => ({ season_number, episode_count })), ...extra };
}

function seasonEpisodes(season, runtimes) {
    return { episodes: runtimes.map((runtime, index) => ({
        id: season * 100 + index + 1, season_number: season, episode_number: index + 1, runtime
    })) };
}

function testEpisodeRuntimeParsingRejectsUnknownAndAmbiguousValues() {
    assert.strictEqual(parseRuntimeMinutes("00:44:30"), 44.5);
    assert.strictEqual(parseRuntimeMinutes("1:02:00"), 62);
    assert.strictEqual(parseRuntimeMinutes("49 min"), 49);
    assert.strictEqual(parseRuntimeMinutes(49), 49);
    for (const value of [undefined, null, 0, -1, "N/A", "", "00:00:00", "1:60:00", Infinity, 1441]) {
        assert.strictEqual(parseRuntimeMinutes(value), null, "invalid episode length must be ignored: " + String(value));
    }
}

function testDuttonRanchAverageAndEpisodeWeighting() {
    const lengths = [56, 47, 49, 47, 53, 42, 42, 45, 60];
    assert.deepStrictEqual(averageEpisodeRuntime(lengths.map((runtime, index) => ({ season: 1, episode: index + 1, runtime }))), {
        runtime: "49 min", episodeCount: 9, totalMinutes: 441
    });
    const weighted = averageEpisodeRuntime([
        { season: 1, episode: 1, runtime: 20 },
        ...[1, 2, 3].map(episode => ({ season: 2, episode, runtime: 60 })),
        { season: 2, episode: 3, runtime: 300 },
        { season: 2, episode: 4, runtime: 0 },
        { season: 2, episode: 5, runtime: "N/A" }
    ]);
    assert.deepStrictEqual(weighted, { runtime: "50 min", episodeCount: 4, totalMinutes: 200 },
        "episodes must be equally weighted, duplicate editions counted once, and missing lengths excluded");
    assert.strictEqual(averageEpisodeRuntime([{ runtime: 0 }, { runtime: "N/A" }]), null);
}

async function testTmdbAverageIncludesOnlyProviderEpisodesAndLimitsConcurrentRequests() {
    let active = 0;
    let maxActive = 0;
    const requested = [];
    const episodes = [
        { id: "s1e2", season: 1, episode: 2 },
        { id: "s2e1", season: 2, episode: 1 },
        { id: "s2e3", season: 2, episode: 3 },
        { id: "s3e1", season: 3, episode: 1 }
    ];
    await withFreshFetchModule("../src/js/tmdbMetadata", async url => {
        const match = new URL(url).pathname.match(/\/season\/(\d+)$/);
        if (!match) return tmdbResponse(tvDetails([[0, 73], [1, 3], [2, 3], [3, 1], [4, 20]]));
        const season = Number(match[1]);
        requested.push(season);
        assert.notStrictEqual(season, 0, "TMDb-only specials must not be fetched");
        assert.notStrictEqual(season, 4, "unavailable seasons must not be fetched");
        active++; maxActive = Math.max(active, maxActive);
        await new Promise(setImmediate); active--;
        return tmdbResponse(seasonEpisodes(season, season === 1 ? [20, 30, 40] : season === 2 ? [50, 90, 70] : [80]));
    }, async fresh => {
        const result = await fresh.getSeriesRuntimeMetadata("123", { episodes });
        assert.strictEqual(result.runtime, "58 min");
        assert.strictEqual(result.episodeCount, 4);
        assert.strictEqual(result.totalMinutes, 230);
        assert.strictEqual(result.complete, true);
        assert.deepStrictEqual(requested.sort(), [1, 2, 3]);
        assert.ok(maxActive <= 2);
        assert.ok(result.seasons.every(summary => !Object.hasOwn(summary, "episodes")));
    }, true);
}

async function testTmdbOfficialSeriesRuntimeAvoidsSeasonRequests() {
    let calls = 0;
    await withFreshFetchModule("../src/js/tmdbMetadata", async () => {
        calls++;
        return tmdbResponse(tvDetails([[1, 10]], { episode_run_time: [48] }));
    }, async fresh => {
        const result = await fresh.getSeriesRuntimeMetadata("123", { episodes: defaultProviderVideos() });
        assert.strictEqual(result.runtime, "48 min");
        assert.strictEqual(result.source, "tmdb-series");
        assert.strictEqual(calls, 1);
    }, true);
}

async function testTmdbAverageReusesUnchangedSeasonsAndRefreshesChangedOnes() {
    let episodes = [
        { id: "a", season: 1, episode: 1 }, { id: "b", season: 1, episode: 2 }, { id: "c", season: 2, episode: 1 }
    ];
    const requested = [];
    let expanded = false;
    await withFreshFetchModule("../src/js/tmdbMetadata", async url => {
        const match = new URL(url).pathname.match(/\/season\/(\d+)$/);
        if (!match) return tmdbResponse(tvDetails([[0, 70], [1, 10], [2, 10]]));
        const season = Number(match[1]); requested.push(season);
        return tmdbResponse(seasonEpisodes(season, season === 1 ? [40, 40] : expanded ? [40, 60] : [60]));
    }, async fresh => {
        const first = await fresh.getSeriesRuntimeMetadata("123", { episodes });
        const previous = { ...first, version: 2, tmdbId: "123" };
        requested.length = 0; expanded = true;
        episodes = [...episodes, { id: "d", season: 2, episode: 2 }];
        const result = await fresh.getSeriesRuntimeMetadata("123", { episodes, previous, refresh: true });
        assert.deepStrictEqual(requested, [2]);
        assert.strictEqual(result.runtime, "45 min");
        assert.strictEqual(result.episodeCount, 4);
        assert.strictEqual(result.seasons[0].checkedAt, previous.seasons[0].checkedAt);
        requested.length = 0;
        const replaced = episodes.map(episode => episode.id === "b" ? { id: "replacement", season: 1, episode: 3 } : episode);
        await fresh.getSeriesRuntimeMetadata("123", { episodes: replaced, previous: { ...result, version: 2, tmdbId: "123" }, refresh: true });
        assert.deepStrictEqual(requested, [1], "same-count episode replacement must invalidate its season aggregate");
    }, true);
}

async function testTmdbUnknownEpisodeLengthsRetryAfterTwelveHours() {
    const episodes = [{ id: "a", season: 1, episode: 1 }, { id: "b", season: 1, episode: 2 }];
    let recovered = false;
    let seasonCalls = 0;
    await withFreshFetchModule("../src/js/tmdbMetadata", async url => {
        if (!new URL(url).pathname.includes("/season/")) return tmdbResponse(tvDetails([[1, 2]]));
        seasonCalls++;
        return tmdbResponse(seasonEpisodes(1, recovered ? [40, 50] : [40, null]));
    }, async fresh => {
        const first = await fresh.getSeriesRuntimeMetadata("123", { episodes });
        const previous = { ...first, version: 2, tmdbId: "123", seasons: first.seasons.map(season => ({ ...season, checkedAt: Date.now() - 13 * HOUR })) };
        recovered = true;
        const result = await fresh.getSeriesRuntimeMetadata("123", { episodes, previous, refresh: true });
        assert.strictEqual(seasonCalls, 2);
        assert.strictEqual(result.runtime, "45 min");
        assert.strictEqual(result.episodeCount, 2);
    }, true);
}

async function testTmdbPartialFailureRetainsPriorSeasonTotalsAndMarksIncomplete() {
    const episodes = [{ id: "a", season: 1, episode: 1 }, { id: "b", season: 1, episode: 2 }, { id: "c", season: 2, episode: 1 }];
    let fail = false;
    await withFreshFetchModule("../src/js/tmdbMetadata", async url => {
        const match = new URL(url).pathname.match(/\/season\/(\d+)$/);
        if (!match) return tmdbResponse(tvDetails([[1, 2], [2, 1]]));
        const season = Number(match[1]);
        return season === 2 && fail ? tmdbResponse(null, 503) : tmdbResponse(seasonEpisodes(season, season === 1 ? [40, 50] : [60]));
    }, async fresh => {
        const first = await fresh.getSeriesRuntimeMetadata("123", { episodes });
        fail = true;
        const previous = { ...first, version: 2, tmdbId: "123", seasons: first.seasons.map(season => ({ ...season, checkedAt: Date.now() - 15 * DAY })) };
        const result = await fresh.getSeriesRuntimeMetadata("123", { episodes, previous, refresh: true });
        assert.strictEqual(result.complete, false);
        assert.strictEqual(result.seasons.find(summary => summary.season === 2).totalMinutes, 60);
        assert.strictEqual(result.runtime, "50 min");
    }, true);
    await withFreshFetchModule("../src/js/tmdbMetadata", async url => tmdbResponse(
        new URL(url).pathname.includes("/season/") ? seasonEpisodes(1, [null, 0]) : tvDetails([[1, 2]])
    ), async fresh => {
        const result = await fresh.getSeriesRuntimeMetadata("123", { episodes: episodes.slice(0, 2) });
        assert.strictEqual(result.episodeCount, 0);
        assert.strictEqual(result.runtime, undefined);
    }, true);
}

async function testXtreamDurationsAndConcurrentDetailRequestsShareOneFetch() {
    const payload = { info: { tmdb: "123" }, episodes: {
        "0": [{ id: 10, season: 0, episode_num: 1, info: { duration_secs: 1800 } }],
        "1": [
            { id: 11, season: 1, episode_num: 1, info: { duration_secs: "2670" } },
            { id: 12, season: 1, episode_num: 2, info: { duration: "00:45:30" } },
            { id: 13, season: 1, episode_num: 2, info: { duration_secs: 9999 } },
            { id: 14, season: 1, episode_num: 3, info: { duration_secs: 0, duration: "N/A" } }
        ]
    } };
    let calls = 0;
    await withFreshFetchModule("../src/js/providers/xtreamProvider", async () => {
        calls++;
        await new Promise(resolve => setImmediate(resolve));
        return { ok: true, status: 200, json: async () => payload };
    }, async provider => {
        const addon = { config: { xtreamUrl: "https://example.com", xtreamUsername: "test", xtreamPassword: "test" }, lastUpdate: 1000 };
        const [details, id, summary] = await Promise.all([
            provider.fetchSeriesInfo(addon, "3"), provider.fetchSeriesTmdbId(addon, "3"), provider.fetchSeriesRuntimeInfo(addon, "3")
        ]);
        assert.strictEqual(calls, 1);
        assert.strictEqual(id, "123");
        assert.strictEqual(details.videos.find(video => video.id === "iptv_series_ep_11").runtimeMinutes, 44.5);
        const calculated = averageEpisodeRuntime(summary.episodes);
        assert.strictEqual(calculated.runtime, "40 min");
        assert.strictEqual(calculated.episodeCount, 3);
        assert.strictEqual(calculated.totalMinutes, 120);
        assert.strictEqual(summary.videos, undefined);
        assert.ok(!JSON.stringify(summary).includes("/series/"), "aggregate persistence must not need playable URLs");
    });
}

async function testXtreamMissingDurationsAndFailuresDoNotInventRuntime() {
    for (const response of [
        { ok: false, status: 503 },
        { ok: true, status: 200, json: async () => ({ episodes: "invalid" }) },
        { ok: true, status: 200, json: async () => ({ episodes: { "1": [{ id: 1, episode_num: 1, info: { duration_secs: 0, duration: "N/A" } }] } }) }
    ]) {
        await withFreshFetchModule("../src/js/providers/xtreamProvider", async () => response, async provider => {
            const addon = { config: { xtreamUrl: "https://example.com", xtreamUsername: "test", xtreamPassword: "test" } };
            const result = await provider.fetchSeriesRuntimeInfo(addon, "3");
            if (result) {
                assert.strictEqual(averageEpisodeRuntime(result.episodes), null);
                assert.strictEqual(result.episodes.length, 1, "unknown durations must retain the provider episode for TMDb matching");
            } else assert.strictEqual(result, null);
        });
    }
}

async function testBackgroundAveragePersistsAndReloadsWithoutEpisodeRequests() {
    const old = seriesPreview();
    const { addon, item, store } = runtimeAddon(old);
    await withTmdbRuntimeResult({ runtime: "49 min", source: "tmdb-episodes", episodeCount: 9, totalMinutes: 441, complete: true, seasons: [] }, async calls => {
        const saved = await addon.ensureSeriesRuntimeAverage(item, old);
        await settleWrites(addon);
        assert.strictEqual(saved.runtime, "49 min");
        assert.strictEqual(saved.description, old.description);
        assert.strictEqual(store.entries.get(item.id).value.runtimeAverage.episodeCount, 9);
        assert.strictEqual(store.entries.get(item.id).value.videos, undefined);
        const restarted = runtimeAddon(old).addon;
        restarted.persistentCatalogMetaCache = store;
        restarted._getCatalogMetaAsync = async () => { throw new Error("a saved average should not trigger a fresh metadata lookup"); };
        const reloaded = await restarted.getCatalogMetaAsync(item.id, "series");
        assert.strictEqual(reloaded.runtime, "49 min");
        assert.strictEqual(calls(), 1);
    });
}

async function testOfficialRuntimeWinsAndForegroundCompletesMissingRuntimeAverage() {
    const official = seriesPreview({ runtime: "60 min" });
    const { addon, item } = runtimeAddon(official);
    await withTmdbRuntimeResult(() => { throw new Error("episode average should not be fetched"); }, async calls => {
        const result = await addon.ensureSeriesRuntimeAverage(item, official);
        assert.strictEqual(result.runtime, "60 min");
        assert.strictEqual(calls(), 0);
    });
    const missing = seriesPreview();
    const setup = runtimeAddon(missing);
    setup.addon.catalogMetaCache.set(setup.item.id, missing);
    await withTmdbRuntimeResult({ runtime: "49 min", source: "tmdb-episodes", episodeCount: 9, totalMinutes: 441, complete: true, seasons: [] }, async calls => {
        const foreground = await setup.addon.enrichCatalogMetaItems([setup.item], 1, false);
        assert.strictEqual(foreground.get(setup.item.id).runtime, "49 min",
            "a cached card without a runtime must be enriched before the page returns");
        assert.strictEqual(calls(), 1);
        const repeated = await setup.addon.enrichCatalogMetaItems([setup.item], 1, false);
        assert.strictEqual(repeated.get(setup.item.id).runtime, "49 min");
        await setup.addon.enrichCatalogMetaItems([setup.item], 1, true);
        assert.strictEqual(calls(), 1, "fresh averages must be reused by foreground and background requests");
    });
}

async function testForegroundPageJoinsPendingBackgroundRuntimeAverage() {
    const missing = seriesPreview();
    const { addon, item } = runtimeAddon(missing);
    addon.catalogMetaCache.set(item.id, missing);
    const started = deferred();
    const response = deferred();
    const result = { runtime: "49 min", source: "tmdb-episodes", episodeCount: 9, totalMinutes: 441, complete: true, seasons: [] };
    await withTmdbRuntimeResult(async () => { started.resolve(); return response.promise; }, async calls => {
        const background = addon.ensureSeriesRuntimeAverage(item, missing);
        await started.promise;
        let pageSettled = false;
        const foreground = addon.enrichCatalogMetaItems([item], 1, false);
        foreground.then(() => { pageSettled = true; }, () => { pageSettled = true; });
        try {
            await new Promise(setImmediate);
            assert.strictEqual(pageSettled, false, "the page must wait for an already running background average");
            assert.strictEqual(calls(), 1, "foreground and background must share one episode lookup");
        } finally {
            response.resolve(result);
            await background;
        }
        const previews = await foreground;
        assert.strictEqual(previews.get(item.id).runtime, "49 min");
        assert.strictEqual(calls(), 1);
    });
}

async function testCatalogueFirstNextAndSearchPagesAwaitVisibleRuntimeAverages() {
    const proto = M3UEPGAddon.prototype;
    const originals = {
        loadFromCache: proto.loadFromCache,
        updateData: proto.updateData,
        startConfiguredCatalogPrefetch: proto.startConfiguredCatalogPrefetch,
        startScheduledRefresh: proto.startScheduledRefresh,
        runtime: tmdbMetadata.getSeriesRuntimeMetadata
    };
    const env = {
        CATALOG_PREFETCH_NEXT_PAGE: process.env.CATALOG_PREFETCH_NEXT_PAGE,
        CATALOG_PAGE_SIZE: process.env.CATALOG_PAGE_SIZE
    };
    const previews = Array.from({ length: 120 }, (_, index) => {
        const number = index + 1;
        return seriesPreview({
            id: "iptv_series_" + number,
            name: (number > 70 ? "Target series " : "Series ") + String(number).padStart(3, "0"),
            _tmdbId: String(1000 + number)
        });
    });
    const series = previews.map((preview, index) => ({
        id: preview.id, type: "series", series_id: String(index + 1), name: preview.name, tmdbId: preview._tmdbId
    }));
    const result = { runtime: "49 min", source: "tmdb-episodes", episodeCount: 9, totalMinutes: 441, complete: true, seasons: [] };
    const expectedPreviews = new Map(previews.map(preview => [preview.id, preview]));
    const assertOtherEnrichedFields = (metas, label) => {
        for (const meta of metas) {
            const expected = expectedPreviews.get(meta.id);
            for (const field of ["description", "year", "releaseInfo", "cast", "imdbRating", "poster", "background", "genres"]) {
                assert.deepStrictEqual(meta[field], expected[field], label + " must preserve " + field + " for " + meta.id);
            }
        }
    };
    const calls = [];
    let activeGate;
    let instance;
    let iface;
    let pendingRequest;
    proto.loadFromCache = async function () {
        instance = this;
        this.log = quietLog;
        this.series = series;
        for (const item of series) this.directSeriesEpisodeIndex.set(item.series_id, defaultProviderVideos());
        this.channels = [];
        this.movies = [];
        this.epgData = {};
        this.lastUpdate = Date.now();
        this.persistentCatalogMetaCache = metadataStore(previews);
        this.persistentCatalogMetaCache.init = async () => {};
        this.persistentAddonDataCache = { flush: async () => {} };
        this.persistentSeriesInfoCache = { entries: new Map(), get: async () => null, flush: async () => {} };
    };
    proto.updateData = async () => {};
    proto.startConfiguredCatalogPrefetch = () => {};
    proto.startScheduledRefresh = () => {};
    process.env.CATALOG_PREFETCH_NEXT_PAGE = "false";
    process.env.CATALOG_PAGE_SIZE = "50";
    tmdbMetadata.getSeriesRuntimeMetadata = async tmdbId => {
        calls.push(String(tmdbId));
        if (String(tmdbId) === activeGate?.tmdbId) {
            activeGate.started.resolve();
            return activeGate.response.promise;
        }
        return structuredClone(result);
    };
    try {
        iface = await createAddon({ provider: "direct", includeSeries: true,
            m3uUrl: "https://example.com/runtime-page-wait-" + Date.now() + ".m3u" });
        const cases = [
            { label: "first page", extra: {}, first: 1, last: 50, firstNew: 1 },
            { label: "next page", extra: { skip: "50" }, first: 51, last: 100, firstNew: 51 },
            { label: "search", extra: { search: "Target" }, first: 71, last: 120, firstNew: 101 }
        ];
        for (const scenario of cases) {
            if (scenario.label === "next page") {
                for (const preview of previews.slice(50, 100)) instance.catalogMetaCache.set(preview.id, preview);
            }
            activeGate = { tmdbId: String(1000 + scenario.last), started: deferred(), response: deferred() };
            const before = calls.length;
            let pageSettled = false;
            let timer;
            pendingRequest = iface.get("catalog", "series", "iptv_series", scenario.extra);
            pendingRequest.then(() => { pageSettled = true; }, () => { pageSettled = true; });
            try {
                await Promise.race([
                    activeGate.started.promise,
                    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(scenario.label + " never requested its missing runtime")), 5000); })
                ]);
                await new Promise(setImmediate);
                assert.strictEqual(pageSettled, false, scenario.label + " must wait for the last visible card's runtime");
            } finally {
                clearTimeout(timer);
                activeGate.response.resolve(structuredClone(result));
            }
            const response = await pendingRequest;
            pendingRequest = null;
            assert.deepStrictEqual(response.metas.map(meta => meta.id),
                series.slice(scenario.first - 1, scenario.last).map(item => item.id));
            assert.strictEqual(response.metas.length, 50);
            assertOtherEnrichedFields(response.metas, scenario.label);
            assert.ok(response.metas.every(meta => meta.runtime === "49 min"),
                scenario.label + " must return runtime averages on every available card");
            assert.deepStrictEqual(calls.slice(before).sort(),
                series.slice(scenario.firstNew - 1, scenario.last).map(item => item.tmdbId).sort(),
                scenario.label + " must fetch only missing averages for its visible cards");
            const freshCalls = calls.length;
            const repeat = await iface.get("catalog", "series", "iptv_series", scenario.extra);
            assert.ok(repeat.metas.every(meta => meta.runtime === "49 min"));
            assertOtherEnrichedFields(repeat.metas, scenario.label + " repeated");
            assert.strictEqual(calls.length, freshCalls, scenario.label + " must reuse fresh averages without episode requests");
        }
    } finally {
        activeGate?.response.resolve(structuredClone(result));
        if (pendingRequest) await pendingRequest.catch(() => {});
        if (iface) await disposeAddonInterface(iface);
        Object.assign(proto, {
            loadFromCache: originals.loadFromCache,
            updateData: originals.updateData,
            startConfiguredCatalogPrefetch: originals.startConfiguredCatalogPrefetch,
            startScheduledRefresh: originals.startScheduledRefresh
        });
        tmdbMetadata.getSeriesRuntimeMetadata = originals.runtime;
        for (const [key, value] of Object.entries(env)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

async function testForegroundCardsAwaitDueFieldsAndJoinMetadataRefresh() {
    for (const type of ["movie", "series"]) {
        for (const alreadyRefreshing of [false, true]) {
            const now = Date.now();
            const old = seriesPreview({
                id: "iptv_" + type + "_3", type, runtime: "60 min", director: ["Director One"],
                description: undefined, year: undefined, releaseInfo: undefined,
                missingMetadataCheckedAt: now - 13 * HOUR
            });
            const addon = new M3UEPGAddon({ provider: "direct" });
            const item = { id: old.id, type, name: old.name, tmdbId: "123", series_id: "3" };
            if (type === "series") addon.series = [item];
            else addon.movies = [item];
            addon.lastUpdate = 1000;
            addon.log = quietLog;
            addon.persistentCatalogMetaCache = metadataStore([old]);
            addon.catalogMetaCache.set(item.id, old);
            const response = deferred();
            const refreshed = { ...old, description: "The refreshed description", year: 2026, releaseInfo: "2026-" };
            let calls = 0;
            let sourceArgs;
            addon._getCatalogMetaAsync = async (...args) => {
                calls++;
                sourceArgs = args;
                return response.promise;
            };
            let background;
            if (alreadyRefreshing) {
                background = addon.getCatalogMetaAsync(item.id, type);
                await new Promise(setImmediate);
                assert.strictEqual(calls, 1);
                // A detail request can fill the memory cache while the source
                // refresh is still pending. The visible page must still join it.
                addon.catalogMetaCache.set(item.id, {
                    ...refreshed, description: "An intermediate detail value",
                    missingMetadataCheckedAt: Date.now()
                });
            }
            let pageSettled = false;
            const page = addon.enrichCatalogMetaItems([item], 1, false);
            page.then(() => { pageSettled = true; }, () => { pageSettled = true; });
            try {
                await new Promise(setImmediate);
                assert.strictEqual(calls, 1, type + " must refresh due missing description/year exactly once");
                assert.strictEqual(pageSettled, false, type + " cards must wait for due missing fields before display");
                assert.ok(addon.catalogMetaInFlight.has(addon.lastUpdate + ":" + item.id),
                    "foreground and background metadata work must share the current generation");
                assert.deepStrictEqual(sourceArgs.slice(0, 3), [item.id, type, true]);
            } finally {
                response.resolve(refreshed);
                if (background) await background;
            }
            const enriched = (await page).get(item.id);
            assert.strictEqual(enriched.description, refreshed.description);
            assert.strictEqual(enriched.year, 2026);
            assert.strictEqual(enriched.releaseInfo, "2026-");
            assert.deepStrictEqual(enriched.cast, old.cast);
            assert.strictEqual(enriched.imdbRating, old.imdbRating);
            assert.strictEqual(enriched.runtime, old.runtime);
            await settleWrites(addon);
            assert.strictEqual(addon.persistentCatalogMetaCache.entries.get(item.id).value.description, refreshed.description);

            const backedOff = { ...old, missingMetadataCheckedAt: Date.now() };
            addon.catalogMetaCache.set(item.id, backedOff);
            await addon.persistentCatalogMetaCache.set(item.id, backedOff);
            const deferredPreview = (await addon.enrichCatalogMetaItems([item], 1, false)).get(item.id);
            assert.strictEqual(calls, 1, "recent missing-field attempts must remain in backoff on foreground views");
            assert.strictEqual(deferredPreview.description, undefined);
            assert.strictEqual(deferredPreview.year, undefined);
            assert.strictEqual(deferredPreview.runtime, "60 min");
        }
    }
}

async function testRuntimeSummaryLogsExplainSavedAndUnavailableAverages() {
    const now = Date.now();
    const average = (runtime, source, extra = {}) => ({
        version: 2, scope: "provider-episodes", attemptProviderLastUpdate: 1000, episodeFingerprint: providerEpisodeFingerprint(defaultProviderVideos()), runtime, source, episodeCount: 9, totalMinutes: parseRuntimeMinutes(runtime) * 9,
        checkedAt: now, attemptedAt: now, tmdbId: "123", complete: true, seasons: [], ...extra
    });
    const previews = [
        seriesPreview({ id: "iptv_series_1", runtime: "60 min" }),
        seriesPreview({ id: "iptv_series_2", runtime: "49 min", runtimeAverage: average("49 min", "tmdb-episodes") }),
        seriesPreview({ id: "iptv_series_3", runtime: "45 min", runtimeAverage: average("45 min", "provider-episodes") }),
        seriesPreview({ id: "iptv_series_4", runtime: "43 min", runtimeAverage: average("43 min", "tmdb-episodes", {
            checkedAt: now - 13 * HOUR
        }) }),
        seriesPreview({ id: "iptv_series_5", runtimeAverage: {
            version: 2, scope: "provider-episodes", attemptProviderLastUpdate: 1000, episodeFingerprint: providerEpisodeFingerprint(defaultProviderVideos()), checkedAt: 0, attemptedAt: now, complete: false, tmdbId: "123"
        } })
    ];
    const items = previews.map((preview, index) => ({
        id: preview.id, name: preview.name, type: "series", series_id: String(index + 1), tmdbId: "123"
    }));
    const store = metadataStore(previews);
    const expected = {
        seriesLevel: 1, tmdbEpisodeAverage: 2, providerEpisodeAverage: 1, mixedEpisodeAverage: 0, legacyScope: 0, missing: 1,
        retainedAfterFailedRefresh: 1, retryDue: 0, missingRetryDeferred: 1
    };
    const build = logs => {
        const addon = runtimeAddon().addon;
        addon.series = items;
        addon.persistentCatalogMetaCache = store;
        addon.log = { ...quietLog, debug(message, details) { logs.push({ message, details }); } };
        return addon;
    };
    await withTmdbRuntimeResult(() => { throw new Error("fresh runtime summaries must not request episodes"); }, async calls => {
        const logs = [];
        const addon = build(logs);
        addon.startContinuousCatalogPrefetch("series", 50, 2);
        await addon.catalogPrefetchJobs.get("series");
        const diagnostics = logs.filter(entry => entry.message === "Catalogue metadata diagnostics");
        assert.strictEqual(diagnostics.length, 1, "one compact runtime summary should accompany the catalogue diagnostics");
        assert.deepStrictEqual(diagnostics[0].details.seriesRuntime, expected);
        assert.strictEqual(calls(), 0);
        const restartLogs = [];
        const restarted = build(restartLogs);
        restarted.startContinuousCatalogPrefetch("series", 50, 2);
        await restarted.catalogPrefetchJobs.get("series");
        const current = restartLogs.filter(entry => entry.message === "Persistent catalogue metadata scan is current");
        assert.strictEqual(current.length, 1, "a current scan should explain the persisted runtime state after restart");
        assert.deepStrictEqual(current[0].details.seriesRuntime, expected);
        assert.strictEqual(calls(), 0, "logging a saved summary must not start runtime lookups");
    });
}

async function testRuntimeBackfillBypassesOldWarmupMarkerButReusesSavedAverage() {
    const old = seriesPreview();
    const { addon, item, store } = runtimeAddon(old);
    const fingerprint = require("crypto").createHash("sha256").update(item.id).digest("hex");
    await store.set("__catalog_prefetch_status__:series", { completedAt: Date.now(), catalogueFingerprint: fingerprint, version: 99 });
    await withTmdbRuntimeResult({ runtime: "49 min", source: "tmdb-episodes", episodeCount: 9, totalMinutes: 441, complete: true, seasons: [] }, async calls => {
        addon.startContinuousCatalogPrefetch("series", 10, 1);
        await addon.catalogPrefetchJobs.get("series");
        assert.strictEqual(store.entries.get(item.id).value.runtime, "49 min",
            "a pre-feature completion marker must not suppress the initial runtime backfill");
        const restart = runtimeAddon(old).addon;
        restart.persistentCatalogMetaCache = store;
        restart.startContinuousCatalogPrefetch("series", 10, 1);
        await restart.catalogPrefetchJobs.get("series");
        assert.strictEqual(calls(), 1, "fresh persisted averages should survive redeployment without another season walk");
    });
}

async function testFailedRuntimeCalculationRetainsAverageAndBacksOff() {
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    try {
        for (const hadAverage of [false, true]) {
            const old = seriesPreview(hadAverage ? {
                runtime: "49 min", runtimeAverage: { version: 2, scope: "provider-episodes", attemptProviderLastUpdate: 1000, episodeFingerprint: providerEpisodeFingerprint(defaultProviderVideos()), runtime: "49 min", source: "tmdb-episodes",
                    episodeCount: 9, totalMinutes: 441, checkedAt: now - 13 * HOUR, attemptedAt: now - 13 * HOUR, tmdbId: "123", complete: true, seasons: [] }
            } : {});
            const { addon, item } = runtimeAddon(old);
            await withTmdbRuntimeResult(null, async calls => {
                const result = await addon.ensureSeriesRuntimeAverage(item, old);
                assert.strictEqual(result.runtime, hadAverage ? "49 min" : undefined);
                assert.strictEqual(calls(), 1);
                const foreground = await addon.enrichCatalogMetaItems([item], 1, false);
                assert.strictEqual(foreground.get(item.id).runtime, hadAverage ? "49 min" : undefined,
                    "foreground cards must preserve the saved average while a failed retry is in backoff");
                await addon.ensureSeriesRuntimeAverage(item, result);
                assert.strictEqual(calls(), 1, "a failed or unavailable duration must not be retried on every view");
                now += 12 * HOUR + 1;
                await addon.ensureSeriesRuntimeAverage(item, result);
                assert.strictEqual(calls(), 2, "a failed calculation must become eligible again after twelve hours");
            });
        }
    } finally { Date.now = originalNow; }
}

async function testLateRuntimeAverageCannotRestoreRemovedSeries() {
    const old = seriesPreview();
    const { addon, item, store } = runtimeAddon(old);
    const started = deferred();
    const response = deferred();
    await withTmdbRuntimeResult(async () => { started.resolve(); return response.promise; }, async () => {
        const lookup = addon.ensureSeriesRuntimeAverage(item, old);
        await started.promise;
        addon.series = [];
        addon.lastUpdate++;
        response.resolve({ runtime: "49 min", source: "tmdb-episodes", episodeCount: 9, totalMinutes: 441, complete: true, seasons: [] });
        await lookup;
        await settleWrites(addon);
        assert.strictEqual(store.entries.get(item.id).value.runtime, undefined);
        assert.notStrictEqual(addon.catalogMetaCache.get(item.id)?.runtime, "49 min");
    });
}

async function testSeriesDetailAverageMatchesPersistentCataloguePreview() {
    const old = seriesPreview();
    const { addon, item, store } = runtimeAddon(old);
    const originals = { details: tmdbMetadata.getSeriesMetadata, episodes: tmdbMetadata.getSeasonEpisodes, average: tmdbMetadata.getSeriesRuntimeMetadata };
    const lengths = [56, 47, 49, 47, 53, 42, 42, 45, 60];
    addon.ensureSeriesInfo = async () => ({ tmdbId: "123", videos: lengths.map((_, index) => ({
        id: "episode-" + index, season: 1, episode: index + 1, title: "Episode " + (index + 1)
    })) });
    addon.getDetailOmdbMetadata = async () => null;
    tmdbMetadata.getSeriesMetadata = async () => ({ name: old.name, imdbId: old.imdbId,
        runtimeSeasons: [{ season: 1, episodeCount: 9 }], genres: old.genres, cast: old.cast });
    tmdbMetadata.getSeasonEpisodes = async () => lengths.map((runtime, index) => ({ season: 1, episode: index + 1, runtime: runtime + " min" }));
    tmdbMetadata.getSeriesRuntimeMetadata = async () => { throw new Error("details should reuse episodes already fetched for display"); };
    try {
        const detailed = await addon.buildSeriesMeta(item);
        await settleWrites(addon);
        assert.strictEqual(detailed.runtime, "49 min");
        assert.strictEqual(store.entries.get(item.id).value.runtime, detailed.runtime);
        assert.strictEqual(store.entries.get(item.id).value.runtimeAverage.episodeCount, 9);
        assert.strictEqual(detailed.videos[0].runtime, "56 min", "episode-specific runtime must remain unchanged");
    } finally {
        tmdbMetadata.getSeriesMetadata = originals.details;
        tmdbMetadata.getSeasonEpisodes = originals.episodes;
        tmdbMetadata.getSeriesRuntimeMetadata = originals.average;
    }
}

async function testNewEpisodesRefreshAverageAndOfficialRuntimeSupersedesIt() {
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    try {
        const old = seriesPreview({ runtime: "49 min", runtimeAverage: {
            version: 2, scope: "provider-episodes", attemptProviderLastUpdate: 1000, episodeFingerprint: providerEpisodeFingerprint(defaultProviderVideos()), runtime: "49 min", source: "tmdb-episodes", episodeCount: 9, totalMinutes: 441,
            checkedAt: now - 13 * HOUR, attemptedAt: now - 13 * HOUR, tmdbId: "123", complete: true, seasons: []
        } });
        const { addon, item, store } = runtimeAddon(old);
        let response = { runtime: "50 min", source: "tmdb-episodes", episodeCount: 10, totalMinutes: 500, complete: true, seasons: [] };
        await withTmdbRuntimeResult(() => response, async calls => {
            const updated = await addon.ensureSeriesRuntimeAverage(item, old);
            assert.strictEqual(updated.runtime, "50 min");
            assert.strictEqual(store.entries.get(item.id).value.runtimeAverage.episodeCount, 10);
            now += 13 * HOUR;
            response = { runtime: "52 min", source: "tmdb-series", episodeCount: 0, totalMinutes: 0, complete: true, seasons: [] };
            const official = await addon.ensureSeriesRuntimeAverage(item, updated);
            assert.strictEqual(official.runtime, "52 min");
            assert.strictEqual(official.runtimeAverage, null,
                "an available official runtime must replace an estimate and stop average-only refreshes");
            assert.strictEqual(calls(), 2);
        });
    } finally { Date.now = originalNow; }
}

async function testPartialSeasonFailureCannotReplaceSavedCompleteAverage() {
    const old = seriesPreview({ runtime: "49 min", runtimeAverage: {
        version: 2, scope: "provider-episodes", attemptProviderLastUpdate: 1000, episodeFingerprint: providerEpisodeFingerprint(defaultProviderVideos()), runtime: "49 min", source: "tmdb-episodes", episodeCount: 9, totalMinutes: 441,
        checkedAt: Date.now() - 13 * HOUR, attemptedAt: Date.now() - 13 * HOUR,
        tmdbId: "123", complete: true, seasons: []
    } });
    const { addon, item, store } = runtimeAddon(old);
    await withTmdbRuntimeResult({ runtime: "12 min", source: "tmdb-episodes", episodeCount: 1,
        totalMinutes: 12, complete: false, seasons: [] }, async () => {
        const retained = await addon.ensureSeriesRuntimeAverage(item, old);
        assert.strictEqual(retained.runtime, "49 min");
        assert.strictEqual(store.entries.get(item.id).value.runtimeAverage.episodeCount, 9);
        assert.ok(retained.runtimeAverage.attemptedAt > old.runtimeAverage.attemptedAt);
    });
}

async function testDirectPlaylistEpisodeDurationsCanProduceAnAverage() {
    const playlist = '#EXTM3U\n' + [2700, 3000, -1, 0].map((duration, index) =>
        '#EXTINF:' + duration + ' group-title="Series",Example S01E0' + (index + 1) + '\nhttps://example.com/episode-' + index + '.mp4\n'
    ).join('');
    await withFreshFetchModule("../src/js/providers/directProvider", async () => ({ ok: true, text: async () => playlist }), async provider => {
        const addon = new M3UEPGAddon({ provider: "direct", m3uUrl: "https://example.com/durations.m3u", enableEpg: false });
        addon.log = quietLog;
        await provider.fetchData(addon);
        assert.strictEqual(addon.series.length, 1);
        const info = await provider.fetchSeriesInfo(addon, addon.series[0].series_id);
        assert.strictEqual(info.videos[0].runtimeMinutes, 45);
        assert.strictEqual(info.videos[1].runtimeMinutes, 50);
        assert.strictEqual(info.videos[2].runtime, undefined);
        assert.deepStrictEqual(averageEpisodeRuntime(info.videos), { runtime: "48 min", episodeCount: 2, totalMinutes: 95 });
    });
}

async function testPartialDetailLookupKeepsSavedAverageForSameProviderPopulation() {
    const old = seriesPreview({ runtime: "49 min", runtimeAverage: {
        version: 2, scope: "provider-episodes", episodeFingerprint: providerEpisodeFingerprint(defaultProviderVideos()),
        runtime: "49 min", source: "tmdb-episodes", episodeCount: 9, totalMinutes: 441,
        checkedAt: Date.now(), attemptedAt: Date.now(), tmdbId: "123", complete: true, attemptProviderLastUpdate: 1000
    } });
    const { addon, item } = runtimeAddon(old);
    addon.catalogMetaCache.set(item.id, old);
    const partial = [[1, [{ season: 1, episode: 1, runtime: "100 min" }]]];
    const result = await addon.getSeriesDetailRuntime(item, {}, null,
        { videos: defaultProviderVideos() }, partial, addon.lastUpdate);
    assert.strictEqual(result.runtime, "49 min",
        "a partial TMDb lookup cannot replace a saved average for the same provider episode set");
    assert.strictEqual(result.runtimeAverage.episodeCount, 9);
    const changed = await addon.getSeriesDetailRuntime(item, {}, null,
        { videos: defaultProviderVideos().slice(0, 1) }, partial, addon.lastUpdate);
    assert.strictEqual(changed.runtime, "100 min",
        "after the provider removes episodes, a complete calculation for its smaller set must replace the old total");
    assert.strictEqual(changed.runtimeAverage.episodeCount, 1);
}

async function testIdleScheduledChecksStartMetadataWarmupAndRespectDisableSetting() {
    const originalSetInterval = global.setInterval;
    const originalPrefetch = process.env.CATALOG_PREFETCH_NEXT_PAGE;
    let tick;
    global.setInterval = callback => { tick = callback; return { unref() {} }; };
    const addon = new M3UEPGAddon({ provider: "direct", m3uUrl: "https://example.com/runtime-idle-scheduler.m3u" });
    addon.log = quietLog;
    addon.lastUpdate = Date.now();
    let warmups = 0;
    let providerUpdates = 0;
    addon.startConfiguredCatalogPrefetch = () => { warmups++; };
    addon.updateData = async () => { providerUpdates++; addon.lastUpdate = Date.now(); };
    try {
        addon.startScheduledRefresh();
        tick();
        assert.strictEqual(providerUpdates, 0, "a fresh provider snapshot must not be fetched just to backfill runtime");
        assert.strictEqual(warmups, 1, "idle metadata/runtime retries must still be checked when the provider is fresh");
        addon.lastUpdate = Date.now() - addon.updateInterval - 1;
        tick();
        await addon.scheduledRefreshInFlight;
        assert.strictEqual(providerUpdates, 1);
        assert.strictEqual(warmups, 2, "a completed provider refresh should also start the metadata/runtime warm-up");
        process.env.CATALOG_PREFETCH_NEXT_PAGE = "false";
        const disabled = new M3UEPGAddon({ provider: "direct" });
        disabled.startContinuousCatalogPrefetch = () => { throw new Error("disabled prefetch must not start a runtime backfill"); };
        disabled.startConfiguredCatalogPrefetch();
    } finally {
        global.setInterval = originalSetInterval;
        if (originalPrefetch === undefined) delete process.env.CATALOG_PREFETCH_NEXT_PAGE;
        else process.env.CATALOG_PREFETCH_NEXT_PAGE = originalPrefetch;
        addon.refreshTimer = null;
    }
}

async function testProviderRuntimeRefreshKeepsDetailAndPreviewProvenanceTogether() {
    const originalDetails = tmdbMetadata.getSeriesMetadata;
    const originalEpisodes = tmdbMetadata.getSeasonEpisodes;
    tmdbMetadata.getSeriesMetadata = async () => null;
    tmdbMetadata.getSeasonEpisodes = async () => { throw new Error("TMDb episode calls are unavailable in this case"); };
    try {
        for (const priorSource of ["provider-episodes", "tmdb-episodes", "official"]) {
            const old = seriesPreview({ runtime: "45 min", ...(priorSource === "official" ? {} : { runtimeAverage: {
                version: 2, scope: "provider-episodes", attemptProviderLastUpdate: 1000, episodeFingerprint: providerEpisodeFingerprint(defaultProviderVideos()), runtime: "45 min", source: priorSource, episodeCount: 1, totalMinutes: 45,
                checkedAt: Date.now() - 13 * HOUR, attemptedAt: Date.now() - 13 * HOUR,
                tmdbId: "123", complete: true, seasons: []
            } }) });
            const { addon, item, store } = runtimeAddon(old);
            addon.ensureSeriesInfo = async () => ({ tmdbId: "123", fetchedAt: Date.now(),
                videos: [{ id: "episode-1", season: 1, episode: 1, runtime: "60 min", url: "https://example.com/episode.mp4" }] });
            addon.getDetailOmdbMetadata = async () => null;
            const detail = await addon.buildSeriesMeta(item);
            await settleWrites(addon);
            const persisted = store.entries.get(item.id).value;
            const expected = priorSource === "official" ? "45 min" : "60 min";
            assert.strictEqual(detail.runtime, expected);
            assert.strictEqual(persisted.runtime, expected,
                priorSource + " runtime must agree between full details and its saved catalogue card");
            if (priorSource === "official") {
                assert.ok(!persisted.runtimeAverage, "a provider fallback must not relabel an official runtime as an estimate");
            } else {
                assert.strictEqual(persisted.runtimeAverage.runtime, persisted.runtime,
                    "the average value and its source/count marker must be saved atomically");
                assert.strictEqual(persisted.runtimeAverage.source, "provider-episodes");
            }
        }
        // Model an in-flight fallback built before another request installed the
        // official/higher-priority runtime. Equal numeric values still have
        // different provenance and must not downgrade that installed record.
        for (const priorSource of ["official", "tmdb-episodes"]) {
            const old = seriesPreview({ runtime: "45 min", ...(priorSource === "official" ? {} : { runtimeAverage: {
                version: 2, scope: "provider-episodes", attemptProviderLastUpdate: 1000, episodeFingerprint: providerEpisodeFingerprint(defaultProviderVideos()), runtime: "45 min", source: "tmdb-episodes", episodeCount: 1, totalMinutes: 45,
                checkedAt: Date.now(), attemptedAt: Date.now(), tmdbId: "123", complete: true, seasons: []
            } }) });
            const { addon, item, store } = runtimeAddon(old);
            await addon.persistDetailedCatalogPreview(item.id, "series", null, {
                name: item.name, runtime: "45 min", runtimeAverage: {
                    version: 2, scope: "provider-episodes", attemptProviderLastUpdate: 1000, episodeFingerprint: providerEpisodeFingerprint(defaultProviderVideos()), runtime: "45 min", source: "provider-episodes", episodeCount: 1,
                    totalMinutes: 45, checkedAt: Date.now(), attemptedAt: Date.now(), complete: true
                }
            }, { providerFallback: true });
            await settleWrites(addon);
            const persisted = store.entries.get(item.id).value;
            assert.strictEqual(persisted.runtime, "45 min");
            if (priorSource === "official") {
                assert.ok(!persisted.runtimeAverage,
                    "an equal-valued provider average must not relabel an official runtime");
            } else {
                assert.strictEqual(persisted.runtimeAverage.source, "tmdb-episodes",
                    "an equal-valued provider average must not downgrade TMDb episode provenance");
            }
        }
    } finally {
        tmdbMetadata.getSeriesMetadata = originalDetails;
        tmdbMetadata.getSeasonEpisodes = originalEpisodes;
    }
}

async function testHouseOfTheDragonMigratesLegacyAverageAndMatchesCardsAndDetails() {
    const durations = [
        [66, 54, 63, 62, 60, 67, 59, 67, 58, 59],
        [58, 69, 66, 55, 63, 67, 64, 69],
        [66, 64, 57, 62, 64, 63, 64, 71]
    ];
    const episodes = durations.flatMap((rows, index) => rows.map((runtime, number) => ({
        id: "hotd-" + (index + 1) + "-" + (number + 1), season: index + 1, episode: number + 1
    })));
    const old = seriesPreview({ runtime: "22 min", runtimeAverage: {
        version: 1, runtime: "22 min", source: "tmdb-episodes", complete: true,
        episodeCount: 99, totalMinutes: 2178, checkedAt: Date.now(), attemptedAt: Date.now(), tmdbId: "123"
    } });
    const { addon, item, store } = runtimeAddon(old);
    addon.directSeriesEpisodeIndex.set("3", episodes);
    const original = tmdbMetadata.getSeriesRuntimeMetadata;
    const requested = [];
    await withFreshFetchModule("../src/js/tmdbMetadata", async url => {
        const match = new URL(url).pathname.match(/\/season\/(\d+)$/);
        if (!match) return tmdbResponse(tvDetails([[0, 73], [1, 10], [2, 8], [3, 8], [4, 10]]));
        const season = Number(match[1]);
        requested.push(season);
        assert.ok(season >= 1 && season <= 3, "only provider-supplied seasons may be fetched");
        const response = seasonEpisodes(season, durations[season - 1]);
        response.episodes.push({ id: "not-supplied", season_number: season, episode_number: 99, runtime: 1 });
        return tmdbResponse(response);
    }, async fresh => {
        tmdbMetadata.getSeriesRuntimeMetadata = fresh.getSeriesRuntimeMetadata;
        try {
            const previews = await addon.enrichCatalogMetaItems([item], 1);
            const preview = previews.get(item.id);
            assert.strictEqual(preview.runtime, "63 min", "the attached 26 episode lengths total 1,637 minutes and round to 63");
            assert.strictEqual(preview.runtimeAverage.version, 2, "a fresh but wrongly scoped legacy aggregate must migrate immediately");
            assert.strictEqual(preview.runtimeAverage.providerEpisodeCount, 26);
            assert.strictEqual(preview.runtimeAverage.episodeCount, 26);
            assert.strictEqual(preview.runtimeAverage.totalMinutes, 1637);
            assert.deepStrictEqual(requested.sort(), [1, 2, 3]);
            const seasonResults = durations.map((rows, index) => [index + 1,
                [...rows.map((runtime, number) => ({ season: index + 1, episode: number + 1, runtime: runtime + " min" })),
                    { season: index + 1, episode: 99, runtime: "1 min" }]]);
            const detail = await addon.getSeriesDetailRuntime(item, {}, null, { videos: episodes }, seasonResults, addon.lastUpdate);
            assert.strictEqual(detail.runtime, preview.runtime);
            assert.strictEqual(detail.runtimeAverage.episodeFingerprint, preview.runtimeAverage.episodeFingerprint);
            assert.strictEqual(detail.runtimeAverage.totalMinutes, 1637);
            const saved = store.entries.get(item.id).value;
            assert.strictEqual(saved.runtime, "63 min");
            for (const field of ["description", "year", "poster", "imdbRating"]) assert.deepStrictEqual(saved[field], old[field]);
            const calls = requested.length;
            await addon.enrichCatalogMetaItems([item], 1);
            assert.strictEqual(requested.length, calls, "a migrated persisted average must be reused on the next card request");
        } finally { tmdbMetadata.getSeriesRuntimeMetadata = original; }
    }, true);
}

async function testProviderPopulationMixesMatchedAndFallbackDurationsPerEpisode() {
    const episodes = [
        { id: "1", season: 1, episode: 1, runtime: "1 min" },
        { id: "2", season: 1, episode: 2, runtimeMinutes: 54 },
        { id: "3", season: 1, episode: 3, runtime: "63 min" },
        { id: "4", season: 2, episode: 1 },
        { id: "5", season: 0, episode: 1, runtime: "5 min" },
        { id: "6", season: 1, episode: 4, runtime: "N/A" },
        { id: "duplicate", season: 1, episode: 1, runtime: "999 min" }
    ];
    const seasons = [
        [0, [{ season: 0, episode: 1, runtime: "7 min" }, { season: 0, episode: 2, runtime: "1 min" }]],
        [1, [{ season: 1, episode: 1, runtime: "66 min" }, { season: 1, episode: 2 },
            { season: 1, episode: 4, runtime: "0 min" }, { season: 1, episode: 99, runtime: "1 min" }]],
        [2, [{ season: 2, episode: 1, runtime: "64 min" }]]
    ];
    const result = averageProviderEpisodes(episodes, seasons);
    assert.strictEqual(result.runtime, "51 min");
    assert.strictEqual(result.totalMinutes, 254);
    assert.strictEqual(result.episodeCount, 5);
    assert.strictEqual(result.providerEpisodeCount, 6);
    assert.strictEqual(result.tmdbEpisodeCount, 3);
    assert.strictEqual(result.providerDurationCount, 2);
    assert.strictEqual(result.missingDurationCount, 1);
    assert.strictEqual(result.source, "mixed-episodes");
    assert.strictEqual(providerEpisodeFingerprint(episodes), providerEpisodeFingerprint([...episodes].reverse().filter(row => row.id !== "duplicate")),
        "ordering and redundant identical episode entries must not alter the population");
    const noTmdb = await tmdbMetadata.getSeriesRuntimeMetadata(null, { episodes });
    assert.strictEqual(noTmdb.source, "provider-episodes");
    assert.strictEqual(noTmdb.episodeCount, 4);
    assert.strictEqual(noTmdb.runtime, "31 min");
    const requested = [];
    await withFreshFetchModule("../src/js/tmdbMetadata", async url => {
        const match = new URL(url).pathname.match(/\/season\/(\d+)$/);
        if (!match) return tmdbResponse(tvDetails([[0, 70], [1, 20], [2, 20], [3, 20]]));
        const season = Number(match[1]); requested.push(season);
        const rows = seasons.find(([number]) => number === season)[1];
        return tmdbResponse({ episodes: rows.map(row => ({ season_number: season, episode_number: row.episode,
            runtime: parseRuntimeMinutes(row.runtime) })) });
    }, async fresh => {
        const fetched = await fresh.getSeriesRuntimeMetadata("123", { episodes });
        assert.strictEqual(fetched.runtime, result.runtime);
        assert.strictEqual(fetched.totalMinutes, 254);
        assert.strictEqual(fetched.source, "mixed-episodes");
        assert.strictEqual(fetched.tmdbEpisodeCount, 3);
        assert.strictEqual(fetched.providerDurationCount, 2);
        assert.strictEqual(fetched.complete, true);
        assert.deepStrictEqual(requested.sort(), [0, 1, 2], "specials are included only when the provider actually supplies them");
    }, true);
}

async function testFreshAverageRechecksMembershipAfterProviderGenerationChanges() {
    const originalNow = Date.now;
    let now = originalNow(); Date.now = () => now;
    try {
        const { addon, item, store } = runtimeAddon();
        addon.lastUpdate = now;
        const rows = Array.from({ length: 10 }, (_, index) => ({ season: 1, episode: index + 1, runtime: index === 9 ? "90 min" : "49 min" }));
        await withTmdbRuntimeResult((_id, options) => ({ ...averageProviderEpisodes(options.episodes, [[1, rows]]), complete: true, seasons: [] }), async calls => {
            addon.startContinuousCatalogPrefetch("series", 10, 1);
            await addon.catalogPrefetchJobs.get("series");
            assert.strictEqual(store.entries.get(item.id).value.runtime, "49 min");
            const firstFingerprint = store.entries.get(item.id).value.runtimeAverage.episodeFingerprint;
            await new Promise(setImmediate); // Allow the completed job's cleanup to settle before the next refresh.
            now += 60000; addon.lastUpdate = now;
            addon.seriesInfoCache.clear();
            addon.directSeriesEpisodeIndex.set("3", [...defaultProviderVideos().slice(1), { id: "ep-1-10", season: 1, episode: 10 }]);
            addon.startContinuousCatalogPrefetch("series", 10, 1);
            await addon.catalogPrefetchJobs.get("series");
            const updated = store.entries.get(item.id).value;
            assert.strictEqual(updated.runtime, "54 min", "remove the unavailable episode and average the replacement episode");
            assert.strictEqual(updated.runtimeAverage.episodeCount, 9);
            assert.notStrictEqual(updated.runtimeAverage.episodeFingerprint, firstFingerprint);
            assert.strictEqual(calls(), 2, "a recent scan marker must not suppress a new provider generation");
        });
    } finally { Date.now = originalNow; }
}

async function testLegacyAverageMigrationFailureBacksOffWithoutDroppingMetadata() {
    const old = seriesPreview({ runtime: "22 min", runtimeAverage: {
        version: 1, runtime: "22 min", source: "tmdb-episodes", complete: true,
        checkedAt: Date.now(), attemptedAt: Date.now(), tmdbId: "123"
    } });
    const { addon, item } = runtimeAddon(old);
    await withTmdbRuntimeResult(null, async calls => {
        const first = await addon.ensureSeriesRuntimeAverage(item, old);
        assert.strictEqual(calls(), 1, "migration must run even when the old aggregate was recently saved");
        assert.strictEqual(first.runtime, "22 min", "an unavailable lookup keeps the prior value until it can be recalculated");
        assert.strictEqual(first.description, old.description);
        assert.ok(first.runtimeAverage.scopeMigrationAttemptedAt);
        assert.strictEqual(first.runtimeAverage.version, 1, "a failed migration must not falsely claim the old total uses the new population");
        await addon.ensureSeriesRuntimeAverage(item, first);
        assert.strictEqual(calls(), 1);
    });
}

module.exports = [
    testEpisodeRuntimeParsingRejectsUnknownAndAmbiguousValues,
    testDuttonRanchAverageAndEpisodeWeighting,
    testTmdbAverageIncludesOnlyProviderEpisodesAndLimitsConcurrentRequests,
    testTmdbOfficialSeriesRuntimeAvoidsSeasonRequests,
    testTmdbAverageReusesUnchangedSeasonsAndRefreshesChangedOnes,
    testTmdbUnknownEpisodeLengthsRetryAfterTwelveHours,
    testTmdbPartialFailureRetainsPriorSeasonTotalsAndMarksIncomplete,
    testXtreamDurationsAndConcurrentDetailRequestsShareOneFetch,
    testXtreamMissingDurationsAndFailuresDoNotInventRuntime,
    testBackgroundAveragePersistsAndReloadsWithoutEpisodeRequests,
    testOfficialRuntimeWinsAndForegroundCompletesMissingRuntimeAverage,
    testForegroundPageJoinsPendingBackgroundRuntimeAverage,
    testCatalogueFirstNextAndSearchPagesAwaitVisibleRuntimeAverages,
    testForegroundCardsAwaitDueFieldsAndJoinMetadataRefresh,
    testRuntimeSummaryLogsExplainSavedAndUnavailableAverages,
    testRuntimeBackfillBypassesOldWarmupMarkerButReusesSavedAverage,
    testFailedRuntimeCalculationRetainsAverageAndBacksOff,
    testLateRuntimeAverageCannotRestoreRemovedSeries,
    testSeriesDetailAverageMatchesPersistentCataloguePreview,
    testNewEpisodesRefreshAverageAndOfficialRuntimeSupersedesIt,
    testPartialSeasonFailureCannotReplaceSavedCompleteAverage,
    testDirectPlaylistEpisodeDurationsCanProduceAnAverage,
    testPartialDetailLookupKeepsSavedAverageForSameProviderPopulation,
    testIdleScheduledChecksStartMetadataWarmupAndRespectDisableSetting,
    testProviderRuntimeRefreshKeepsDetailAndPreviewProvenanceTogether,
    testHouseOfTheDragonMigratesLegacyAverageAndMatchesCardsAndDetails,
    testProviderPopulationMixesMatchedAndFallbackDurationsPerEpisode,
    testFreshAverageRechecksMembershipAfterProviderGenerationChanges,
    testLegacyAverageMigrationFailureBacksOffWithoutDroppingMetadata
];