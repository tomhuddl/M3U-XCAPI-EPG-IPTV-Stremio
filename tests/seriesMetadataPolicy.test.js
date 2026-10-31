const assert = require("assert");
const { M3UEPGAddon } = require("../addon");
const tmdb = require("../src/js/tmdbMetadata");
const omdb = require("../src/js/omdbMetadata");

function setup(overrides = {}, itemOverrides = {}) {
    const now = Date.now();
    const preview = {
        id: "iptv_series_3", type: "series", name: "Example", _tmdbId: "123",
        description: "Saved description", poster: "https://example.com/poster.jpg",
        background: "https://example.com/background.jpg", genres: ["Drama"],
        year: 2026, cast: ["Actor"], imdbId: "tt1234567", imdbRating: "8",
        metadataVersion: 3, imdbIdChecked: true, omdbChecked: true, omdbCheckedAt: now,
        metadataCheckedAt: now, missingMetadataCheckedAt: now, ...overrides
    };
    const item = { id: preview.id, type: "series", series_id: "3", name: "Example", tmdbId: "123", ...itemOverrides };
    const addon = new M3UEPGAddon({ provider: "xtream" });
    const entries = new Map([[preview.id, structuredClone(preview)]]);
    addon.lastUpdate = 1000;
    addon.series = [item];
    addon.log = { debug() {}, info() {}, warn() {}, error() {} };
    addon.persistentCatalogMetaCache = {
        get: async id => entries.has(id) ? { value: structuredClone(entries.get(id)), savedAt: now, fresh: true } : null,
        set: async (id, value, current) => { if (!current || current()) entries.set(id, structuredClone(value)); },
        delete: async id => entries.delete(id), flush: async () => {}
    };
    addon.persistentSeriesInfoCache = { get: async () => null };
    return { addon, item, preview, entries };
}

async function mockMethods(target, replacements, run) {
    const previous = Object.fromEntries(Object.keys(replacements).map(key => [key, target[key]]));
    Object.assign(target, replacements);
    try { return await run(); } finally { Object.assign(target, previous); }
}

async function testSeriesCatalogueUsesOnlyListIdsWithoutProviderDetails() {
    const provider = require("../src/js/providers/xtreamProvider");
    await mockMethods(provider, {
        fetchSeriesInfo: async () => { throw new Error("Background metadata must not fetch provider episodes"); }
    }, async () => {
        for (const listId of [null, "123"]) {
            const { addon, item } = setup({}, { tmdbId: listId });
            const lookedUp = [];
            await mockMethods(tmdb, {
                getSeriesCatalogMetadata: async id => { lookedUp.push(["catalogue", id]); return null; },
                getSeriesRuntimeMetadata: async id => { lookedUp.push(["runtime", id]); return null; }
            }, async () => {
                const preview = await addon._getCatalogMetaAsync(item.id, "series", true);
                assert.ok(preview && preview.type === "series");
                await addon.ensureSeriesRuntimeAverage(item, preview);
                assert.deepStrictEqual(lookedUp, listId ? [["catalogue", listId], ["runtime", listId]] : []);
                assert.strictEqual(addon.ensureSeriesTmdbId, undefined);
                assert.strictEqual(provider.fetchSeriesTmdbId, undefined);
                assert.strictEqual(provider.fetchSeriesRuntimeSummary, undefined);
            });
        }
    });
}

async function testSeriesDetailsIgnoreReplacementIdAndKeepPlayableEpisodes() {
    for (const listId of [null, "123"]) {
        const { addon, item } = setup({}, { tmdbId: listId });
        addon.ensureSeriesInfo = async () => ({
            tmdbId: "999", videos: [{ id: "iptv_series_ep_7", season: 1, episode: 1, runtime: "60 min" }]
        });
        const requested = [];
        await mockMethods(tmdb, {
            getSeriesMetadata: async id => { requested.push(id); return null; },
            getSeriesRuntimeMetadata: async id => { requested.push(id); return null; }
        }, async () => {
            const detail = await addon.buildSeriesMeta(item);
            assert.strictEqual(detail.videos.length, 1);
            assert.strictEqual(detail.videos[0].runtime, undefined, "ordinary episode responses omit unused runtimes");
            assert.strictEqual((await addon.ensureSeriesInfo()).videos[0].runtime, "60 min", "provider durations remain available internally");
            assert.strictEqual(detail.runtime, undefined, "provider episodes must not produce a series average");
            assert.ok(requested.every(id => id === listId));
            if (!listId) assert.deepStrictEqual(requested, []);
        });
    }
}

async function testSavedProviderAndMixedAveragesAreRemovedWithoutMetadataLoss() {
    for (const source of ["provider-episodes", "mixed-episodes"]) {
        const now = Date.now();
        const { addon, item, entries } = setup({
            runtime: "22 min", runtimeAverage: {
                version: 2, policyVersion: 1, source, runtime: "22 min",
                checkedAt: now, attemptedAt: now, complete: true
            }
        });
        await mockMethods(tmdb, { getSeriesRuntimeMetadata: async () => null }, async () => {
            const page = await addon.enrichCatalogMetaItems([item], 1, false);
            assert.strictEqual(page.get(item.id).runtime, undefined);
            const saved = entries.get(item.id);
            assert.strictEqual(saved.runtime, undefined);
            assert.ok(!["provider-episodes", "mixed-episodes"].includes(saved.runtimeAverage?.source));
            assert.strictEqual(saved.description, "Saved description");
            assert.deepStrictEqual(saved.cast, ["Actor"]);
            assert.strictEqual(saved.imdbRating, "8");
            assert.strictEqual(saved.runtimeAverage.attemptPolicyVersion, 1);
        });
    }
}

async function testSavedProviderAverageCanBeReplacedByTmdbOnly() {
    const { addon, item, preview, entries } = setup({
        runtime: "22 min", runtimeAverage: {
            version: 1, source: "provider-episodes", runtime: "22 min", complete: true,
            checkedAt: Date.now(), attemptedAt: Date.now(), policyVersion: 1
        }
    });
    await mockMethods(tmdb, {
        getSeriesRuntimeMetadata: async () => ({
            runtime: "60 min", source: "tmdb-episodes", episodeCount: 2, totalMinutes: 120, complete: true, seasons: []
        })
    }, async () => {
        const result = await addon.ensureSeriesRuntimeAverage(item, preview);
        assert.strictEqual(result.runtime, "60 min");
        assert.strictEqual(entries.get(item.id).runtimeAverage.source, "tmdb-episodes");
    });
}

async function testProviderAverageIsNotReclassifiedAsOmdbRuntime() {
    const { addon, item } = setup({
        runtime: "22 min", runtimeAverage: {
            version: 1, source: "provider-episodes", runtime: "22 min", complete: true, checkedAt: Date.now()
        }
    });
    await mockMethods(omdb, {
        getByImdbId: async () => { throw new Error("Fresh saved OMDb data should be reused"); }
    }, async () => {
        const result = await addon.getDetailOmdbMetadata("tt1234567", item.id);
        assert.strictEqual(result.runtime, undefined);
        assert.strictEqual(result.imdbRating, "8");
    });
}

async function testValidSeriesLevelRuntimeSourcesTakePriority() {
    for (const [tmdbRuntime, providerRuntime, omdbRuntime, expected] of [
        ["60 min", "40 min", "45 min", "60 min"],
        ["N/A", "40 min", "45 min", "40 min"],
        ["N/A", "N/A", "45 min", "45 min"],
        [undefined, undefined, undefined, undefined]
    ]) {
        const { addon, item } = setup({}, { runtime: providerRuntime });
        await mockMethods(tmdb, {
            getSeriesCatalogMetadata: async () => ({ name: "Example", runtime: tmdbRuntime, imdbId: "tt1234567" })
        }, async () => mockMethods(omdb, {
            getByImdbId: async () => ({ runtime: omdbRuntime })
        }, async () => {
            const card = await addon._getCatalogMetaAsync(item.id, "series");
            assert.strictEqual(card.runtime, expected);
            if (expected) {
                const detail = await addon.getSeriesDetailRuntime(item, { runtime: tmdbRuntime }, { runtime: omdbRuntime }, []);
                assert.strictEqual(detail.runtime, expected);
            }
        }));
    }
}

async function testDetailAverageIncludesTmdbSeasonsAbsentFromProvider() {
    const { addon, item } = setup();
    let calls = 0;
    await mockMethods(tmdb, {
        getSeriesRuntimeMetadata: async () => {
            calls++;
            return { runtime: "60 min", source: "tmdb-episodes", complete: true,
                episodeCount: 2, totalMinutes: 120, seasons: [] };
        }
    }, async () => {
        const detail = await addon.getSeriesDetailRuntime(item, {
            runtimeSeasons: [{ season: 1, episodeCount: 1 }, { season: 2, episodeCount: 1 }]
        }, null, [[1, [{ season: 1, episode: 1, runtime: "40 min" }]]]);
        assert.strictEqual(calls, 1);
        assert.strictEqual(detail.runtime, "60 min", "a partial detail season list must not define the average");
    });
}

async function testSeriesProviderFailuresDoNotDelayOtherEpisodeRequestsOrLog429() {
    const safety = require("../urlSafety");
    const modulePath = require.resolve("../src/js/providers/xtreamProvider");
    const cached = require.cache[modulePath];
    const originalFetch = safety.safeFetch;
    const warn = console.warn;
    const warnings = [];
    let requests = 0;
    safety.safeFetch = async () => ++requests === 1
        ? { ok: false, status: 429 }
        : { ok: true, status: 200, json: async () => ({ episodes: { "1": [{ id: 7, episode_num: 1, title: "Episode" }] } }) };
    console.warn = (...args) => warnings.push(args.join(" "));
    delete require.cache[modulePath];
    try {
        const provider = require(modulePath);
        const addon = { config: { xtreamUrl: "https://example.com", xtreamUsername: "test", xtreamPassword: "test" } };
        const failed = await provider.fetchSeriesInfo(addon, "3");
        assert.ok(failed.fetchError);
        const available = await provider.fetchSeriesInfo(addon, "4");
        assert.strictEqual(requests, 2);
        assert.strictEqual(available.videos.length, 1);
        assert.deepStrictEqual(warnings, []);
    } finally {
        safety.safeFetch = originalFetch;
        console.warn = warn;
        delete require.cache[modulePath];
        if (cached) require.cache[modulePath] = cached;
    }
}

async function testXtreamWholeSeriesRuntimesAreKeptWithoutAveraging() {
    const safety = require("../urlSafety");
    const modulePath = require.resolve("../src/js/providers/xtreamProvider");
    const cached = require.cache[modulePath];
    const originalFetch = safety.safeFetch;
    const actions = [];
    safety.safeFetch = async url => {
        const action = new URL(url).searchParams.get("action");
        actions.push(action);
        return { ok: true, status: 200, json: async () => action === "get_series"
            ? [{ series_id: 3, name: "Example", episode_run_time: "45", tmdb: "123" }]
            : action === "get_series_info" ? { info: { runtime: "N/A", episode_run_time: "50" }, episodes: {} } : [] };
    };
    delete require.cache[modulePath];
    try {
        const provider = require(modulePath);
        const addon = { config: { xtreamUrl: "https://example.com", xtreamUsername: "test", xtreamPassword: "test", enableEpg: false } };
        await provider.fetchData(addon);
        assert.strictEqual(addon.series[0].runtime, "45 min");
        assert.ok(!actions.includes("get_series_info"));
        const details = await provider.fetchSeriesInfo(addon, "3");
        assert.strictEqual(details.runtime, "50 min");
        const saved = setup().addon;
        saved.ensureSeriesInfo = async () => ({ ...details, videos: [] });
        await mockMethods(tmdb, { getSeriesMetadata: async () => null }, async () => {
            const detail = await saved.buildSeriesMeta(saved.series[0]);
            assert.strictEqual(detail.runtime, "50 min");
        });
    } finally {
        safety.safeFetch = originalFetch;
        delete require.cache[modulePath];
        if (cached) require.cache[modulePath] = cached;
    }
}

module.exports = [
    testXtreamWholeSeriesRuntimesAreKeptWithoutAveraging,
    testSeriesCatalogueUsesOnlyListIdsWithoutProviderDetails,
    testSeriesDetailsIgnoreReplacementIdAndKeepPlayableEpisodes,
    testSavedProviderAndMixedAveragesAreRemovedWithoutMetadataLoss,
    testSavedProviderAverageCanBeReplacedByTmdbOnly,
    testProviderAverageIsNotReclassifiedAsOmdbRuntime,
    testValidSeriesLevelRuntimeSourcesTakePriority,
    testDetailAverageIncludesTmdbSeasonsAbsentFromProvider,
    testSeriesProviderFailuresDoNotDelayOtherEpisodeRequestsOrLog429
];
