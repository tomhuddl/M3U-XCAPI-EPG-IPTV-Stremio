"use strict";
const assert = require("assert");
const fs = require("fs"), path = require("path"), os = require("os");
const { spawnSync } = require("child_process");
const { validateConfig } = require("../configValidation");
const { createCacheKey } = require("../addon");
const { qualify, parseId, qualifyResponse } = require("../multiProviderAddon");

function source(extra = {}) { return { provider: "xtream", xtreamUrl: "https://provider.example", xtreamUsername: "test", xtreamPassword: "test", ...extra }; }
function probe(mode, directory) {
    const run = spawnSync(process.execPath, [path.join(__dirname, "fixtures/multiProviderProbe.js"), mode, directory || ""], {
        encoding: "utf8", timeout: 30000, windowsHide: true
    });
    assert.strictEqual(run.status, 0, run.stdout + run.stderr);
}
function testMultiProviderValidationAndStableSourceIdentities() {
    const a = source({ name: "Movies", includeLive: false }), b = source({ xtreamUrl: "https://live.example", includeMovies: false, includeSeries: false });
    const config = validateConfig({ sources: [a, b] });
    assert.strictEqual(config.sources[0].enableEpg, false);
    assert.strictEqual(config.sources[1].includeMovies, false);
    assert.notStrictEqual(config.sources[0].id, config.sources[1].id);
    const reversed = validateConfig({ sources: [b, { ...a, name: "Renamed" }] });
    assert.strictEqual(reversed.sources[1].id, config.sources[0].id);
    assert.notStrictEqual(createCacheKey(config), createCacheKey(reversed));
    for (const sources of [[], [a, a], Array(5).fill(a), [{ sources: [a] }], [source({ id: "../invalid" })],
        [source({ includeLive: false, includeMovies: false, includeSeries: false })]])
        assert.throws(() => validateConfig({ sources }));
    assert.throws(() => validateConfig(source({ includeLive: "false" })));
    assert.notStrictEqual(createCacheKey(a), createCacheKey({ ...a, __multiSource: true }));
    assert.strictEqual(createCacheKey(source()), createCacheKey(source({ includeLive: true, includeMovies: true })));
}
function testMultiProviderResponseIdsDoNotMutateOrMixSources() {
    const original = { meta: { id: "iptv_series_3", imdbId: "tt1234567", behaviorHints: { defaultVideoId: "iptv_series_ep_7" },
        videos: [{ id: "iptv_series_ep_7", streams: [{ url: "https://example.com/iptv_series_ep_7" }] }] } };
    const before = structuredClone(original);
    const a = qualifyResponse(original, "aaaaaaaaaaaa"), b = qualifyResponse(original, "bbbbbbbbbbbb");
    assert.notStrictEqual(a.meta.videos[0].id, b.meta.videos[0].id);
    assert.strictEqual(a.meta.behaviorHints.defaultVideoId, a.meta.videos[0].id);
    assert.strictEqual(a.meta.imdbId, original.meta.imdbId);
    assert.strictEqual(a.meta.videos[0].streams[0].url, original.meta.videos[0].streams[0].url);
    assert.deepStrictEqual(original, before);
    assert.deepStrictEqual(parseId(qualify("aaaaaaaaaaaa", "iptv_vod_2")), { sourceId: "aaaaaaaaaaaa", id: "iptv_vod_2" });
    assert.strictEqual(parseId("iptv_vod_2"), null);
}
function testMultiProviderFetchesOnlySelectedContent() { probe("selection"); }
function testMultiProviderCollisionsEnrichedPagesSearchPlaybackAndEpg() { probe("integration"); }
function testMultiProviderFailureRecoveryAndSharedWriterOwnership() { probe("failure"); }
function testMultiProviderHttpSetupAndPlayback() { probe("http"); }
function testMultiProviderPlaylistModesKeepEpisodesAndPlayback() { probe("m3u"); }
function testMultiProviderRestoresEachSourceAcrossFreshProcesses() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "multi-provider-"));
    try { probe("write", directory); probe("read", directory); }
    finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
module.exports = [testMultiProviderValidationAndStableSourceIdentities, testMultiProviderResponseIdsDoNotMutateOrMixSources,
    testMultiProviderFetchesOnlySelectedContent, testMultiProviderCollisionsEnrichedPagesSearchPlaybackAndEpg,
    testMultiProviderFailureRecoveryAndSharedWriterOwnership, testMultiProviderRestoresEachSourceAcrossFreshProcesses,
    testMultiProviderHttpSetupAndPlayback, testMultiProviderPlaylistModesKeepEpisodesAndPlayback];
