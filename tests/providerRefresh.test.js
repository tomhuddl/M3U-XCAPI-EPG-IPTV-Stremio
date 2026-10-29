const assert = require("assert");
const { Readable } = require("stream");
const { M3UEPGAddon } = require("../addon");
const { parseEPGStream } = require("../src/js/epgStreamParser");

const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

function jsonResponse(value, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => value };
}

function makeXtreamFetch(overrides = {}) {
    const payloads = {
        get_live_streams: [{ stream_id: 1, name: "Live channel", epg_channel_id: "channel.one" }],
        get_vod_streams: [{ stream_id: 2, name: "Movie", container_extension: "mp4" }],
        get_series: [{ series_id: 3, name: "Series" }],
        get_live_categories: [], get_vod_categories: [], get_series_categories: []
    };
    return async url => {
        const action = new URL(String(url)).searchParams.get("action");
        if (Object.prototype.hasOwnProperty.call(overrides, action)) return overrides[action](url);
        if (Object.prototype.hasOwnProperty.call(payloads, action)) return jsonResponse(payloads[action]);
        if (overrides.epg) return overrides.epg(url);
        throw new Error("Unexpected mock request");
    };
}

async function withProviderFetch(providerName, fetchMock, run) {
    const restoreScheduler = providerName === 'xtream' ? require('./xtreamTestScheduler')() : () => {};
    const safety = require("../urlSafety");
    const modulePath = require.resolve("../src/js/providers/" + providerName + "Provider");
    const originalFetch = safety.safeFetch;
    const originalModule = require.cache[modulePath];
    safety.safeFetch = fetchMock;
    delete require.cache[modulePath];
    try {
        await run(require(modulePath));
    } finally {
        restoreScheduler();
        safety.safeFetch = originalFetch;
        delete require.cache[modulePath];
        if (originalModule) require.cache[modulePath] = originalModule;
    }
}

function xtreamConfig(suffix) {
    return {
        provider: "xtream", xtreamUrl: "https://example.com/" + suffix,
        xtreamUsername: "test-user", xtreamPassword: "test-password",
        includeSeries: true, enableEpg: false
    };
}

async function testMalformedXtreamSectionsRejectRefreshInsteadOfBecomingRemovals() {
    const cases = [
        ["get_live_streams", () => jsonResponse({ error: "temporary failure" })],
        ["get_vod_streams", () => jsonResponse({ error: "temporary failure" })],
        ["get_series", () => jsonResponse({ error: "temporary failure" })],
        ["get_live_streams", () => jsonResponse([{}])],
        ["get_vod_streams", () => jsonResponse([{ stream_id: null }])],
        ["get_series", () => jsonResponse([{ series_id: "" }])],
        ["get_series", () => jsonResponse(null, 503)],
        ["get_series", () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Invalid JSON"); } })],
        ["get_series", () => { throw new Error("Simulated request failure"); }]
    ];
    for (const [action, response] of cases) {
        await withProviderFetch("xtream", makeXtreamFetch({ [action]: response }), async provider => {
            await assert.rejects(() => provider.fetchData({ config: xtreamConfig(action), log: quietLog }),
                undefined, action + " failures must reject the snapshot");
        });
    }
    await withProviderFetch("xtream", makeXtreamFetch({ get_series: () => jsonResponse([]) }), async provider => {
        const target = { config: xtreamConfig("empty-valid"), log: quietLog };
        await provider.fetchData(target);
        assert.deepStrictEqual(target.series, [], "a successfully fetched empty list must remain distinguishable from failure");
    });
}

async function testRepeatedSeriesFailuresDoNotConfirmProviderRemovals() {
    let failSeries = true;
    const fetchMock = makeXtreamFetch({
        get_series: () => failSeries ? jsonResponse(null, 503) : jsonResponse([])
    });
    await withProviderFetch("xtream", fetchMock, async () => {
        const addon = new M3UEPGAddon(xtreamConfig("refresh-failure-guard"));
        addon.log = quietLog;
        addon.channels = [{ id: "iptv_live_1", name: "Live channel" }];
        addon.movies = [{ id: "iptv_vod_2", name: "Movie", type: "movie" }];
        const originalSeries = [{ id: "iptv_series_3", series_id: 3, name: "Series", type: "series" }];
        addon.series = originalSeries;
        addon.lastUpdate = Date.now() - addon.updateInterval - 1000;
        const originalUpdate = addon.lastUpdate;
        let pruned = 0;
        let saves = 0;
        addon.pruneRemovedCatalogState = async () => { pruned++; };
        addon.buildGenresInManifest = () => {};
        addon.saveToCache = async () => { saves++; };
        addon.persistentAddonDataCache.save = async () => { saves++; return true; };

        await addon.updateData(true);
        await addon.updateData(true);
        assert.strictEqual(addon.series, originalSeries);
        assert.strictEqual(addon.lastUpdate, originalUpdate, "failed refreshes must remain overdue");
        assert.deepStrictEqual(addon.pendingRemovalCandidates, {});
        assert.strictEqual(pruned, 0, "failures must not prune metadata or episode details");
        assert.strictEqual(saves, 0, "a failed provider response must not replace the saved snapshot");

        failSeries = false;
        await addon.updateData(true);
        assert.strictEqual(addon.series, originalSeries, "one valid empty observation must still trigger the large-drop guard");
        await addon.updateData(true);
        assert.deepStrictEqual(addon.series, [], "matching valid empty lists may confirm an actual provider removal");
        assert.strictEqual(pruned, 1);
    });
}

function xmlGuide() {
    return '<tv><programme channel="channel.one" start="20261027120000 +0000" stop="20261027130000 +0000"><title>New programme</title></programme></tv>';
}

async function testPartialEpgFailuresRetainLastKnownGuideForBothProviders() {
    for (const providerName of ["xtream", "direct"]) {
        const guideFetch = url => String(url).endsWith("failed.xml")
            ? jsonResponse(null, 503)
            : { ok: true, status: 200, body: Readable.from([xmlGuide()]) };
        const fetchMock = providerName === "xtream"
            ? makeXtreamFetch({ epg: guideFetch })
            : async url => String(url).endsWith("list.m3u")
                ? { ok: true, text: async () => '#EXTM3U\n#EXTINF:-1 tvg-id="channel.one",Live channel\nhttps://example.com/live.m3u8\n' }
                : guideFetch(url);
        await withProviderFetch(providerName, fetchMock, async provider => {
            const config = providerName === "xtream" ? xtreamConfig("partial-epg") : {
                provider: "direct", m3uUrl: "https://example.com/list.m3u", includeSeries: true
            };
            Object.assign(config, { enableEpg: true, epgUrl: "https://example.com/good.xml", epgUrls: ["https://example.com/failed.xml"] });
            const addon = new M3UEPGAddon(config);
            addon.log = quietLog;
            addon.channels = [{ id: "old-live", name: "Live channel", attributes: { "tvg-id": "channel.one" } }];
            const previousGuide = { "channel.one": [{ title: "Saved programme", start: "20261027120000 +0000", stop: "20261027130000 +0000" }] };
            addon.epgData = previousGuide;
            addon.lastUpdate = Date.now() - addon.updateInterval - 1000;
            addon.pruneRemovedCatalogState = async () => {};
            addon.saveToCache = async () => {};
            addon.persistentAddonDataCache.save = async () => true;
            addon.buildGenresInManifest = () => {};
            await addon.updateData(true);
            assert.strictEqual(addon.epgData, previousGuide,
                providerName + " must not replace a saved complete guide with a partial failed aggregate");

            const isolated = Object.assign(Object.create(addon), { epgData: {} });
            await provider.fetchData(isolated);
            assert.strictEqual(isolated.epgRefreshFailed, true);
            assert.strictEqual(isolated.epgData["channel.one"][0].title, "New programme",
                "successful EPG sources remain available on a deployment without a prior guide");
        });
    }
}

async function testEpgRejectsHtmlResponsesAndAcceptsEmptyXmltv() {
    await assert.rejects(() => parseEPGStream(Readable.from(["<html>Temporary upstream error</html>"])), /XMLTV|root|tv/i);
    await assert.rejects(() => parseEPGStream(Readable.from([" "])), /XMLTV|root|tv/i);
    assert.deepStrictEqual(Object.keys(await parseEPGStream(Readable.from(["<tv/>"]))), []);
}

module.exports = [
    testMalformedXtreamSectionsRejectRefreshInsteadOfBecomingRemovals,
    testRepeatedSeriesFailuresDoNotConfirmProviderRemovals,
    testPartialEpgFailuresRetainLastKnownGuideForBothProviders,
    testEpgRejectsHtmlResponsesAndAcceptsEmptyXmltv
];
