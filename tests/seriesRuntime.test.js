const assert = require("assert");
const createAddon = require("../addon");
const { M3UEPGAddon, disposeAddonInterface } = createAddon;
const tmdbMetadata = require("../src/js/tmdbMetadata");
const { parseRuntimeMinutes, averageEpisodeRuntime } = require("../seriesRuntime");
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

function runtimeAddon(stored = seriesPreview()) {
    const addon = new M3UEPGAddon({ provider: "direct" });
    const item = { id: stored.id, series_id: "3", type: "series", name: stored.name, tmdbId: "123" };
    addon.series = [item];
    addon.lastUpdate = 1000;
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

async function testTmdbAverageIncludesRegularSeasonsAndLimitsConcurrentRequests() {
    let active = 0;
    let maxActive = 0;
    const requestedSeasons = [];
    await withFreshFetchModule("../src/js/tmdbMetadata", async url => {
        const match = new URL(url).pathname.match(/\/season\/(\d+)$/);
        if (!match) return tmdbResponse(tvDetails([[0, 1], [1, 1], [2, 3]]));
        const season = Number(match[1]);
        requestedSeasons.push(season);
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setImmediate(resolve));
        active--;
        return tmdbResponse(seasonEpisodes(season, season === 0 ? [10] : season === 1 ? [20] : [60, 60, 60]));
    }, async fresh => {
        const result = await fresh.getSeriesRuntimeMetadata("123");
        assert.strictEqual(result.runtime, "50 min");
        assert.strictEqual(result.episodeCount, 4);
        assert.strictEqual(result.totalMinutes, 200);
        assert.strictEqual(result.complete, true);
        assert.deepStrictEqual(requestedSeasons.sort(), [1, 2]);
        assert.ok(maxActive <= 2, "a runtime backfill must keep upstream season concurrency bounded");
        assert.ok(result.seasons.every(summary => !Object.hasOwn(summary, "episodes")),
            "only aggregates should be retained for a background runtime calculation");
    }, true);
}

async function testTmdbOfficialSeriesRuntimeAvoidsSeasonRequests() {
    let calls = 0;
    await withFreshFetchModule("../src/js/tmdbMetadata", async () => {
        calls++;
        return tmdbResponse(tvDetails([[1, 10]], { episode_run_time: [48] }));
    }, async fresh => {
        const result = await fresh.getSeriesRuntimeMetadata("123");
        assert.strictEqual(result.runtime, "48 min");
        assert.strictEqual(result.source, "tmdb-series");
        assert.strictEqual(calls, 1, "an official series duration must not trigger episode backfill");
    }, true);
}

async function testTmdbAverageReusesUnchangedSeasonsAndRefreshesChangedOnes() {
    const now = Date.now();
    const previous = { policyVersion: 1, tmdbId: "123", seasons: [
        { season: 1, episodeCount: 2, runtimeCount: 2, totalMinutes: 80, checkedAt: now - 1000, complete: true },
        { season: 2, episodeCount: 1, runtimeCount: 1, totalMinutes: 60, checkedAt: now - 1000, complete: true }
    ] };
    const requested = [];
    await withFreshFetchModule("../src/js/tmdbMetadata", async url => {
        const match = new URL(url).pathname.match(/\/season\/(\d+)$/);
        if (!match) return tmdbResponse(tvDetails([[1, 2], [2, 2]]));
        requested.push(Number(match[1]));
        return tmdbResponse(seasonEpisodes(2, [40, 60]));
    }, async fresh => {
        const result = await fresh.getSeriesRuntimeMetadata("123", { previous, refresh: true });
        assert.deepStrictEqual(requested, [2]);
        assert.strictEqual(result.runtime, "45 min");
        assert.strictEqual(result.episodeCount, 4);
        assert.strictEqual(result.seasons[0].checkedAt, previous.seasons[0].checkedAt);
    }, true);
}

async function testTmdbUnknownEpisodeLengthsRetryAfterTwelveHours() {
    const now = Date.now();
    const previous = { policyVersion: 1, tmdbId: "123", seasons: [
        { season: 1, episodeCount: 2, runtimeCount: 1, totalMinutes: 40, checkedAt: now - 13 * HOUR, complete: true }
    ] };
    let seasonCalls = 0;
    await withFreshFetchModule("../src/js/tmdbMetadata", async url => {
        if (!new URL(url).pathname.includes("/season/")) return tmdbResponse(tvDetails([[1, 2]]));
        seasonCalls++;
        return tmdbResponse(seasonEpisodes(1, [40, 50]));
    }, async fresh => {
        const result = await fresh.getSeriesRuntimeMetadata("123", { previous });
        assert.strictEqual(seasonCalls, 1);
        assert.strictEqual(result.runtime, "45 min");
        assert.strictEqual(result.episodeCount, 2);
    }, true);
}

async function testTmdbPartialFailureRetainsPriorSeasonTotalsAndMarksIncomplete() {
    const previous = { policyVersion: 1, tmdbId: "123", seasons: [
        { season: 2, episodeCount: 1, runtimeCount: 1, totalMinutes: 60, checkedAt: Date.now() - 15 * DAY, complete: true }
    ] };
    await withFreshFetchModule("../src/js/tmdbMetadata", async url => {
        const match = new URL(url).pathname.match(/\/season\/(\d+)$/);
        if (!match) return tmdbResponse(tvDetails([[1, 2], [2, 1]]));
        return Number(match[1]) === 2 ? tmdbResponse(null, 503) : tmdbResponse(seasonEpisodes(1, [40, 50]));
    }, async fresh => {
        const result = await fresh.getSeriesRuntimeMetadata("123", { previous });
        assert.strictEqual(result.complete, false);
        assert.strictEqual(result.seasons.find(summary => summary.season === 2).totalMinutes, 60);
        assert.strictEqual(result.runtime, "50 min");
    }, true);
    await withFreshFetchModule("../src/js/tmdbMetadata", async url => tmdbResponse(
        new URL(url).pathname.includes("/season/") ? seasonEpisodes(1, [null, 0]) : tvDetails([[1, 2]])
    ), async fresh => {
        const result = await fresh.getSeriesRuntimeMetadata("123");
        assert.strictEqual(result.episodeCount, 0);
        assert.strictEqual(result.runtime, undefined, "unknown lengths must never fabricate a zero-minute average");
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
        const [details, duplicate] = await Promise.all([
            provider.fetchSeriesInfo(addon, "3"), provider.fetchSeriesInfo(addon, "3")
        ]);
        assert.strictEqual(calls, 1);
        assert.deepStrictEqual(duplicate.videos, details.videos);
        assert.strictEqual(details.videos.find(video => video.id === "iptv_series_ep_11").runtimeMinutes, 44.5);
        assert.strictEqual(provider.fetchSeriesTmdbId, undefined);
        assert.strictEqual(provider.fetchSeriesRuntimeSummary, undefined);
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
            const result = await provider.fetchSeriesInfo(addon, "3");
            assert.ok(result.videos.every(video => video.runtime === undefined));
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

async function testCatalogueSummariesKeepMissingFieldsWithoutRuntimeNoise() {
    const previews = [seriesPreview({ runtime: "60 min" }), seriesPreview({
        id: "iptv_series_4", description: undefined, runtimeAverage: {
            version: 1, policyVersion: 1, attemptedAt: Date.now(), complete: false
        }
    })];
    const store = metadataStore(previews);
    const items = previews.map(preview => ({ id: preview.id, type: "series", name: preview.name, tmdbId: "123" }));
    for (let pass = 0; pass < 2; pass++) {
        const logs = [];
        const { addon } = runtimeAddon();
        addon.series = items;
        addon.persistentCatalogMetaCache = store;
        addon.log = Object.fromEntries(["debug", "info", "warn", "error"].map(level => [
            level, (message, details) => logs.push({ level, message, details })
        ]));
        addon.startContinuousCatalogPrefetch("series", 50, 2);
        await addon.catalogPrefetchJobs.get("series");
        assert.strictEqual(logs.length, 1, "one outcome summary per scan");
        assert.strictEqual(logs[0].level, "info");
        assert.strictEqual(logs[0].message, pass ? "Persistent catalogue metadata scan is current" : "Persistent catalogue metadata scan complete");
        assert.strictEqual(logs[0].details.total, 2);
        assert.strictEqual(logs[0].details.incompleteItems, 1);
        assert.strictEqual(logs[0].details.retriesDeferredByBackoff, 1);
        assert.deepStrictEqual(logs[0].details.missingFieldCounts, { description: 1, runtime: 1 });
        assert.ok(!("seriesRuntime" in logs[0].details));
    }
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
                runtime: "49 min", runtimeAverage: { version: 1, policyVersion: 1, runtime: "49 min", source: "tmdb-episodes",
                    episodeCount: 9, totalMinutes: 441, checkedAt: now - 15 * DAY, attemptedAt: now - 15 * DAY, tmdbId: "123", complete: true, seasons: [] }
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
        assert.strictEqual(detailed.videos[0].runtime, undefined, "ordinary episode responses omit runtime while the series average still uses internal durations");
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
            version: 1, policyVersion: 1, runtime: "49 min", source: "tmdb-episodes", episodeCount: 9, totalMinutes: 441,
            checkedAt: now - 15 * DAY, attemptedAt: now - 15 * DAY, tmdbId: "123", complete: true, seasons: []
        } });
        const { addon, item, store } = runtimeAddon(old);
        let response = { runtime: "50 min", source: "tmdb-episodes", episodeCount: 10, totalMinutes: 500, complete: true, seasons: [] };
        await withTmdbRuntimeResult(() => response, async calls => {
            const updated = await addon.ensureSeriesRuntimeAverage(item, old);
            assert.strictEqual(updated.runtime, "50 min");
            assert.strictEqual(store.entries.get(item.id).value.runtimeAverage.episodeCount, 10);
            now += 15 * DAY;
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
        version: 1, policyVersion: 1, runtime: "49 min", source: "tmdb-episodes", episodeCount: 9, totalMinutes: 441,
        checkedAt: Date.now() - 15 * DAY, attemptedAt: Date.now() - 15 * DAY,
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

async function testDirectPlaylistKeepsIndividualEpisodeDurations() {
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

async function testPartialDetailEpisodeListKeepsSavedWholeSeriesAverage() {
    const old = seriesPreview({ runtime: "49 min", runtimeAverage: {
        version: 1, policyVersion: 1, runtime: "49 min", source: "tmdb-episodes", episodeCount: 9, totalMinutes: 441,
        checkedAt: Date.now(), attemptedAt: Date.now(), tmdbId: "123", complete: true,
        seasons: [{ season: 1, episodeCount: 9, runtimeCount: 9, totalMinutes: 441, checkedAt: Date.now(), complete: true }]
    } });
    const { addon, item } = runtimeAddon(old);
    const result = await addon.getSeriesDetailRuntime(item,
        { runtimeSeasons: [{ season: 1, episodeCount: 9 }, { season: 2, episodeCount: 2 }] },
        null, [[1, [{ season: 1, episode: 1, runtime: "100 min" }]]], addon.lastUpdate);
    assert.strictEqual(result.runtime, "49 min",
        "a partial set of episodes used on a detail page must not replace the saved complete-series average");
    assert.strictEqual(result.runtimeAverage.episodeCount, 9);
    const truncated = await addon.getSeriesDetailRuntime(item,
        { runtimeSeasons: [{ season: 1, episodeCount: 9 }] }, null,
        [[1, [{ season: 1, episode: 1, runtime: "100 min" }]]], addon.lastUpdate);
    assert.strictEqual(truncated.runtime, "49 min",
        "a returned season with too few episodes must not be mistaken for complete series coverage");
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
                version: 1, policyVersion: 1, runtime: "45 min", source: priorSource, episodeCount: 1, totalMinutes: 45,
                checkedAt: Date.now() - 15 * DAY, attemptedAt: Date.now() - 15 * DAY,
                tmdbId: "123", complete: true, seasons: []
            } }) });
            const { addon, item, store } = runtimeAddon(old);
            addon.ensureSeriesInfo = async () => ({ tmdbId: "123", fetchedAt: Date.now(),
                videos: [{ id: "episode-1", season: 1, episode: 1, runtime: "60 min", url: "https://example.com/episode.mp4" }] });
            addon.getDetailOmdbMetadata = async () => null;
            const detail = await addon.buildSeriesMeta(item);
            await settleWrites(addon);
            const persisted = store.entries.get(item.id).value;
            const expected = priorSource === "provider-episodes" ? undefined : "45 min";
            assert.strictEqual(detail.runtime, expected);
            assert.strictEqual(persisted.runtime, expected,
                priorSource + " runtime must agree between full details and its saved catalogue card");
            if (priorSource === "provider-episodes") {
                assert.notStrictEqual(persisted.runtimeAverage?.source, "provider-episodes",
                    "removed provider averages must not survive a detail backfill");
            } else if (priorSource === "official") {
                assert.ok(!persisted.runtimeAverage, "a provider fallback must not relabel an official runtime as an estimate");
            } else {
                assert.strictEqual(persisted.runtimeAverage.runtime, persisted.runtime,
                    "the average value and its source/count marker must be saved atomically");
                assert.strictEqual(persisted.runtimeAverage.source, priorSource);
            }
        }
        // Model an in-flight fallback built before another request installed the
        // official/higher-priority runtime. Equal numeric values still have
        // different provenance and must not downgrade that installed record.
        for (const priorSource of ["official", "tmdb-episodes"]) {
            const old = seriesPreview({ runtime: "45 min", ...(priorSource === "official" ? {} : { runtimeAverage: {
                version: 1, policyVersion: 1, runtime: "45 min", source: "tmdb-episodes", episodeCount: 1, totalMinutes: 45,
                checkedAt: Date.now(), attemptedAt: Date.now(), tmdbId: "123", complete: true, seasons: []
            } }) });
            const { addon, item, store } = runtimeAddon(old);
            await addon.persistDetailedCatalogPreview(item.id, "series", null, {
                name: item.name, runtime: "45 min", runtimeAverage: {
                    version: 1, policyVersion: 1, runtime: "45 min", source: "provider-episodes", episodeCount: 1,
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

function testRuntimePolicyFiltersSpecialsAndKnownFutureDates() {
    const now = Date.now();
    const average = averageEpisodeRuntime([
        { season: 0, episode: 1, runtime: 1 },
        { season: 1, episode: 1, runtime: 40, released: '2000-01-01' },
        { season: 1, episode: 2, runtime: 60 },
        { season: 1, episode: 3, runtime: 100, released: '2999-01-01' },
        { season: 1, episode: 4, runtime: 50, released: 'unknown' },
        { season: 1, episode: 5, runtime: 100, released: String(Math.floor((now + DAY) / 1000)) },
        { season: 1, episode: 1, runtime: 500 },
        { runtime: 500 }
    ]);
    assert.deepStrictEqual(average, { runtime: '50 min', episodeCount: 3, totalMinutes: 150 });
}

async function testTmdbRuntimePolicyExcludesFutureEpisodesWithoutMarkingThemMissing() {
    const requested = [];
    await withFreshFetchModule('../src/js/tmdbMetadata', async url => {
        const match = new URL(url).pathname.match(/\/season\/(\d+)$/);
        if (!match) return tmdbResponse(tvDetails([[0, 40], [1, 3], [2, 1]]));
        const season = Number(match[1]); requested.push(season);
        const data = seasonEpisodes(season, season === 1 ? [40, 100, 60] : [80]);
        if (season === 1) data.episodes[1].air_date = '2999-01-01';
        return tmdbResponse(data);
    }, async fresh => {
        const value = await fresh.getSeriesRuntimeMetadata('123');
        assert.deepStrictEqual(requested.sort(), [1, 2]);
        assert.strictEqual(value.runtime, '60 min');
        assert.strictEqual(value.episodeCount, 3);
        assert.strictEqual(value.totalMinutes, 180);
        assert.strictEqual(value.seasons[0].episodeCount, 3);
        assert.strictEqual(value.seasons[0].eligibleEpisodeCount, 2);
        assert.strictEqual(value.seasons[0].runtimeCount, 2);
    }, true);
}

async function testSuccessfulRuntimeChecksNewEpisodesAtFourteenDaysNotTwelveHours() {
    const originalNow = Date.now; const initial = originalNow(); let now = initial;
    Date.now = () => now;
    let lengths = [40, 60]; let seasonCalls = 0;
    try {
        await withFreshFetchModule('../src/js/tmdbMetadata', async url => {
            if (!new URL(url).pathname.includes('/season/')) return tmdbResponse(tvDetails([[1, lengths.length]]));
            seasonCalls++;
            return tmdbResponse(seasonEpisodes(1, lengths));
        }, async fresh => {
            await withTmdbRuntimeResult((id, options) => fresh.getSeriesRuntimeMetadata(id, options), async calls => {
                const { addon, item, store } = runtimeAddon();
                addon.ensureSeriesInfo = async () => { throw new Error('a successful TMDb average must not fetch provider episodes'); };
                const first = await addon.ensureSeriesRuntimeAverage(item, seriesPreview());
                assert.strictEqual(first.runtime, '50 min');
                lengths = [40, 60, 80];
                now = initial + 12 * HOUR + 1; addon.lastUpdate = 2000;
                await addon.ensureSeriesRuntimeAverage(item, first);
                now = initial + 14 * DAY - 1;
                await addon.ensureSeriesRuntimeAverage(item, first);
                assert.strictEqual(calls(), 1, 'a provider catalogue refresh must not force a fresh successful average');
                now = initial + 14 * DAY + 1;
                const updated = await addon.ensureSeriesRuntimeAverage(item, first);
                assert.strictEqual(updated.runtime, '60 min');
                assert.strictEqual(updated.runtimeAverage.episodeCount, 3);
                assert.strictEqual(calls(), 2);
                assert.strictEqual(seasonCalls, 2, 'the full refresh must include newly listed episodes');
                const restarted = runtimeAddon(store.entries.get(item.id).value);
                await restarted.addon.ensureSeriesRuntimeAverage(restarted.item, updated);
                assert.strictEqual(calls(), 2, 'the longer successful interval must survive a restart');
            });
        }, true);
    } finally { Date.now = originalNow; }
}

async function testMissingEpisodeDurationsStillRetryAfterTwelveHours() {
    const originalNow = Date.now; const initial = originalNow(); let now = initial;
    Date.now = () => now; let lengths = [40, null];
    try {
        await withFreshFetchModule('../src/js/tmdbMetadata', async url => tmdbResponse(
            new URL(url).pathname.includes('/season/') ? seasonEpisodes(1, lengths) : tvDetails([[1, 2]])
        ), async fresh => {
            await withTmdbRuntimeResult((id, options) => fresh.getSeriesRuntimeMetadata(id, options), async calls => {
                const { addon, item } = runtimeAddon();
                const partial = await addon.ensureSeriesRuntimeAverage(item, seriesPreview());
                assert.strictEqual(partial.runtime, '40 min');
                now = initial + 12 * HOUR - 1;
                await addon.ensureSeriesRuntimeAverage(item, partial);
                assert.strictEqual(calls(), 1);
                lengths = [40, 60]; now = initial + 12 * HOUR + 1;
                const complete = await addon.ensureSeriesRuntimeAverage(item, partial);
                assert.strictEqual(complete.runtime, '50 min');
                assert.strictEqual(calls(), 2);
                now += 12 * HOUR + 1;
                await addon.ensureSeriesRuntimeAverage(item, complete);
                assert.strictEqual(calls(), 2, 'once durations are complete, the successful fourteen-day policy applies');
            });
        }, true);
    } finally { Date.now = originalNow; }
}

async function testFutureEpisodeBecomesEligibleOnFullRefreshWithUnchangedCount() {
    const originalNow = Date.now; const initial = originalNow(); let now = initial;
    Date.now = () => now;
    try {
        await withFreshFetchModule('../src/js/tmdbMetadata', async url => {
            if (!new URL(url).pathname.includes('/season/')) return tmdbResponse(tvDetails([[1, 2]]));
            const data = seasonEpisodes(1, [40, 80]);
            data.episodes[1].air_date = new Date(initial + DAY).toISOString().slice(0, 10);
            return tmdbResponse(data);
        }, async fresh => {
            await withTmdbRuntimeResult((id, options) => fresh.getSeriesRuntimeMetadata(id, options), async calls => {
                const { addon, item } = runtimeAddon();
                const first = await addon.ensureSeriesRuntimeAverage(item, seriesPreview());
                assert.strictEqual(first.runtime, '40 min');
                now = initial + 12 * HOUR + 1;
                await addon.ensureSeriesRuntimeAverage(item, first);
                assert.strictEqual(calls(), 1, 'excluded future episodes must not be treated as missing duration data');
                now = initial + 14 * DAY + 1;
                const aired = await addon.ensureSeriesRuntimeAverage(item, first);
                assert.strictEqual(aired.runtime, '60 min');
                assert.strictEqual(aired.runtimeAverage.episodeCount, 2);
            });
        }, true);
    } finally { Date.now = originalNow; }
}

async function testOldPersistedAverageFormatsRecalculateWithNewFiltersWithoutClearingMetadata() {
    for (const version of [1, 2]) {
        const old = seriesPreview({ runtime: '22 min', runtimeAverage: {
            version, runtime: '22 min', source: 'tmdb-episodes', complete: true,
            checkedAt: Date.now(), attemptedAt: Date.now(), tmdbId: '123'
        } });
        const { addon, item, store } = runtimeAddon(old);
        await withTmdbRuntimeResult({ runtime: '63 min', source: 'tmdb-episodes', complete: true, episodeCount: 18,
            totalMinutes: 1134, seasons: [] }, async calls => {
            const value = await addon.ensureSeriesRuntimeAverage(item, old);
            assert.strictEqual(calls(), 1);
            assert.strictEqual(value.runtime, '63 min');
            assert.strictEqual(value.runtimeAverage.policyVersion, 1);
            assert.strictEqual(store.entries.get(item.id).value.description, old.description);
            assert.strictEqual(value.imdbRating, old.imdbRating);
        });
    }
}

async function testFailedRuntimePolicyMigrationRetainsAverageAndRetriesAfterTwelveHours() {
    const originalNow = Date.now; let now = originalNow(); Date.now = () => now;
    const old = seriesPreview({ runtime: '22 min', runtimeAverage: {
        version: 2, runtime: '22 min', source: 'tmdb-episodes', complete: true,
        checkedAt: Date.now(), attemptedAt: Date.now(), tmdbId: '123'
    } });
    const { addon, item } = runtimeAddon(old);
    try { await withTmdbRuntimeResult(null, async calls => {
        const first = await addon.ensureSeriesRuntimeAverage(item, old);
        const second = await addon.ensureSeriesRuntimeAverage(item, first);
        assert.strictEqual(first.runtime, '22 min');
        assert.strictEqual(second.description, old.description);
        assert.strictEqual(calls(), 1);
        assert.strictEqual(first.runtimeAverage.attemptPolicyVersion, 1);
        now += 12 * HOUR + 1;
        await addon.ensureSeriesRuntimeAverage(item, first);
        assert.strictEqual(calls(), 2);
    }); } finally { Date.now = originalNow; }
}

async function testDetailRuntimeUsesSameRegularAiredEpisodeFilter() {
    const { addon, item } = runtimeAddon();
    const episodes = [
        { season: 0, episode: 1, runtime: '2 min' },
        { season: 1, episode: 1, runtime: '45 min' },
        { season: 1, episode: 2, runtime: '55 min' },
        { season: 1, episode: 3, runtime: '100 min', released: '2999-01-01' }
    ];
    const result = await addon.getSeriesDetailRuntime(item,
        { runtimeSeasons: [{ season: 1, episodeCount: 3 }] }, null,
        [[0, episodes.slice(0, 1)], [1, episodes.slice(1)]]);
    assert.strictEqual(result.runtime, '50 min');
    assert.strictEqual(result.runtimeAverage.episodeCount, 2);
    assert.strictEqual(result.runtimeAverage.seasons[0].eligibleEpisodeCount, 2);
    assert.strictEqual(episodes.length, 4, 'filtering an average must not remove playable specials from the actual episode list');
}

module.exports = [
    testRuntimePolicyFiltersSpecialsAndKnownFutureDates,
    testTmdbRuntimePolicyExcludesFutureEpisodesWithoutMarkingThemMissing,
    testSuccessfulRuntimeChecksNewEpisodesAtFourteenDaysNotTwelveHours,
    testMissingEpisodeDurationsStillRetryAfterTwelveHours,
    testFutureEpisodeBecomesEligibleOnFullRefreshWithUnchangedCount,
    testOldPersistedAverageFormatsRecalculateWithNewFiltersWithoutClearingMetadata,
    testFailedRuntimePolicyMigrationRetainsAverageAndRetriesAfterTwelveHours,
    testDetailRuntimeUsesSameRegularAiredEpisodeFilter,
    testEpisodeRuntimeParsingRejectsUnknownAndAmbiguousValues,
    testDuttonRanchAverageAndEpisodeWeighting,
    testTmdbAverageIncludesRegularSeasonsAndLimitsConcurrentRequests,
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
    testCatalogueSummariesKeepMissingFieldsWithoutRuntimeNoise,
    testRuntimeBackfillBypassesOldWarmupMarkerButReusesSavedAverage,
    testFailedRuntimeCalculationRetainsAverageAndBacksOff,
    testLateRuntimeAverageCannotRestoreRemovedSeries,
    testSeriesDetailAverageMatchesPersistentCataloguePreview,
    testNewEpisodesRefreshAverageAndOfficialRuntimeSupersedesIt,
    testPartialSeasonFailureCannotReplaceSavedCompleteAverage,
    testDirectPlaylistKeepsIndividualEpisodeDurations,
    testPartialDetailEpisodeListKeepsSavedWholeSeriesAverage,
    testIdleScheduledChecksStartMetadataWarmupAndRespectDisableSetting,
    testProviderRuntimeRefreshKeepsDetailAndPreviewProvenanceTogether
];
