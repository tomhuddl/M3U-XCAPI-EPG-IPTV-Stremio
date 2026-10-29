const assert = require('node:assert/strict');
const cooloff = require('../seriesMetadataCooloff');
const isolate = require('./seriesCooloffTestHelper');
const { M3UEPGAddon } = require('../addon');
const tmdb = require('../src/js/tmdbMetadata');
const omdb = require('../src/js/omdbMetadata');
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const config = { provider: 'xtream', xtreamUrl: 'https://provider.example',
    xtreamUsername: 'secret-user', xtreamPassword: 'secret-password', includeSeries: true };
const response429 = value => ({ ok: false, status: 429, headers: { get: () => value } });
const owner = extra => ({ config: { ...config, ...extra }, providerName: 'xtream' });

async function flush() {
    for (let n = 0; n < 30; n++) await Promise.resolve();
}

function preview(id = 'iptv_series_1', overrides = {}) {
    return { id, type: 'series', name: 'Example ' + id, poster: 'https://example.com/poster.jpg',
        background: 'https://example.com/background.jpg', description: 'Saved description', genres: ['Drama'],
        year: 2026, releaseInfo: '2026-', cast: ['Actor'], imdbId: 'tt1234567', imdbRating: '8.0',
        metadataVersion: 3, metadataCheckedAt: Date.now(), missingMetadataCheckedAt: Date.now(),
        omdbChecked: true, omdbCheckedAt: Date.now(), ...overrides };
}

function makeAddon(values) {
    const entries = new Map(values.map(value => [value.id, structuredClone(value)]));
    const addon = new M3UEPGAddon(config);
    addon.log = quiet; addon.lastUpdate = 1000;
    addon.series = values.map(value => ({ id: value.id, series_id: value.id.replace('iptv_series_', ''),
        type: 'series', name: value.name, tmdbId: value._tmdbId }));
    addon.persistentCatalogMetaCache = {
        get: async id => entries.has(id) ? { value: structuredClone(entries.get(id)), fresh: true, savedAt: 1 } : null,
        set: async (id, value) => entries.set(id, structuredClone(value)),
        delete: async id => entries.delete(id), flush: async () => {}, retainCatalogItems: async () => {}
    };
    const episodeEntries = new Map();
    addon.persistentSeriesInfoCache = {
        get: async id => episodeEntries.get(id) || null,
        set: async (id, value, generation) => episodeEntries.set(id, { value, fresh: true, providerLastUpdate: generation }),
        flush: async () => {}
    };
    return { addon, entries };
}

async function withProvider(fetch, run, options = {}) {
    const restore = isolate({ logger: quiet, log429() {}, ...options });
    const safety = require('../urlSafety'); const original = safety.safeFetch;
    const path = require.resolve('../src/js/providers/xtreamProvider'); const originalModule = require.cache[path];
    safety.safeFetch = fetch; delete require.cache[path];
    try { return await run(require(path)); } finally {
        restore(); safety.safeFetch = original; delete require.cache[path];
        if (originalModule) require.cache[path] = originalModule;
    }
}

function testSeriesCooloffReusesFailuresAndAllowsUnrelatedInteractiveLookups() {
    let time = 100000; const warnings = []; const summaries = [];
    const instance = cooloff.createSeriesMetadataCooloff({ now: () => time,
        log429: (...args) => warnings.push(args), logger: { info: (...args) => summaries.push(args) } });
    const account = owner();
    instance.record429(account, '1', response429(null));
    const cached = instance.guard(account, '1');
    assert.strictEqual(cached.diagnostic.httpStatus, 429);
    assert.strictEqual(cached.diagnostic.reused429, true);
    assert.strictEqual(instance.guard(account, '2'), null, 'our background pause must not block opening another series');
    assert.throws(() => cooloff.background(() => instance.guard(account, '2')), { code: 'SERIES_METADATA_COOLOFF', scope: 'background' });
    instance.record429(account, '3', response429(null));
    assert.strictEqual(instance.getState(account).backgroundRetryAt, time + 60000,
        'several already-active failures must not multiply the first recovery window');
    assert.strictEqual(warnings.length, 1, 'actual failures in the same window are summarised');
    assert.strictEqual(instance.getState(account).actual429s, 2);
    assert.strictEqual(instance.getState(account).reused429s, 1);
    time = instance.getState(account).backgroundRetryAt + 1;
    assert.strictEqual(instance.guard(account, '2'), null);
    const summary = summaries.find(([message]) => message.includes('summary'))[1];
    assert.deepStrictEqual(summary, { actual429s: 2, reused429s: 1, deferredLookups: 1 });
    assert.ok(!JSON.stringify(summaries).includes('secret-'));
}

function testSeriesCooloffHonoursRetryAfterSecondsAndDatesAndSeparatesAccounts() {
    for (const value of ['120', new Date(Date.UTC(2026, 9, 29) + 120000).toUTCString()]) {
        let time = Date.UTC(2026, 9, 29);
        const instance = cooloff.createSeriesMetadataCooloff({ now: () => time, logger: quiet, log429() {} });
        const account = owner();
        instance.record429(account, '1', response429(value));
        assert.strictEqual(instance.getState(account).providerRetryAt, time + 120000);
        assert.throws(() => instance.guard(account, '2'), { code: 'SERIES_METADATA_COOLOFF', scope: 'retry-after' });
        assert.strictEqual(instance.guard(owner({ xtreamPassword: 'another-account' }), '2'), null);
        time += 120001;
        assert.strictEqual(instance.guard(account, '2'), null);
    }
}

function testBackgroundCooloffIsBoundedButLongerProviderDelayIsRespected() {
    let time = 100000;
    const instance = cooloff.createSeriesMetadataCooloff({ now: () => time, logger: quiet, log429() {} });
    const account = owner();
    for (const delay of [60000, 120000, 240000, 300000, 300000]) {
        instance.record429(account, '1', response429(null));
        assert.strictEqual(instance.getState(account).backgroundRetryAt - time, delay);
        assert.strictEqual(instance.getState(account).providerRetryAt, 0);
        assert.strictEqual(instance.guard(account, '2'), null);
        time += delay + 1;
        instance.guard(account, '2');
    }
    instance.record429(account, '1', response429('900'));
    assert.strictEqual(instance.getState(account).backgroundRetryAt - time, 900000);
    assert.strictEqual(instance.getState(account).providerRetryAt - time, 900000);
}

async function testSeries429IsSharedAcrossSequentialIdRuntimeAndEpisodeLookups() {
    let calls = 0;
    await withProvider(async () => { calls++; return response429(null); }, async provider => {
        const account = owner();
        await provider.fetchSeriesTmdbId(account, '1');
        await provider.fetchSeriesRuntimeSummary(account, '1');
        const details = await provider.fetchSeriesInfo(account, '1');
        assert.strictEqual(details.fetchError, 'HTTP 429');
        assert.ok(details.retryAt > Date.now());
        assert.strictEqual(calls, 1, 'the same rejected response must cover sequential metadata fallback paths');
        await provider.fetchSeriesInfo(account, '2');
        assert.strictEqual(calls, 2, 'a different interactive series is allowed when no Retry-After was supplied');
    });
}

async function testBackgroundProviderDeferralDoesNotBecomeAFalseMissingDataAttempt() {
    const original = preview('iptv_series_1', { description: undefined, runtime: '60 min', metadataCheckedAt: 1, missingMetadataCheckedAt: 1 });
    const { addon, entries } = makeAddon([original]);
    addon._getCatalogMetaAsync = async () => { throw new cooloff.SeriesMetadataCooloff(Date.now() + 60000, 'background'); };
    const deferred = new Map();
    const previews = await cooloff.background(() => addon.enrichCatalogMetaItems(addon.series, 1, true, deferred));
    assert.strictEqual(deferred.size, 1);
    assert.strictEqual(previews.get(original.id).runtime, '60 min');
    assert.deepStrictEqual(entries.get(original.id), original, 'an unmade request must not change the twelve-hour retry timestamps');
    const foreground = await addon.enrichCatalogMetaItems(addon.series, 1, true);
    assert.strictEqual(foreground.get(original.id).runtime, '60 min');
    assert.strictEqual(foreground.get(original.id).missingMetadataCheckedAt, 1);
}

async function testRuntimeDeferralKeepsItsPreviousValueAndAttemptClock() {
    const old = preview('iptv_series_1', { _tmdbId: '111', runtime: '49 min', runtimeAverage: {
        version: 1, policyVersion: 1, runtime: '49 min', source: 'provider-episodes', complete: true,
        checkedAt: 1, attemptedAt: 1, episodeCount: 1, totalMinutes: 49, tmdbId: '111'
    } });
    const { addon, entries } = makeAddon([old]);
    const provider = require('../src/js/providers/xtreamProvider'); const originalProvider = provider.fetchSeriesRuntimeSummary;
    const originalTmdb = tmdb.getSeriesRuntimeMetadata;
    tmdb.getSeriesRuntimeMetadata = async () => null;
    provider.fetchSeriesRuntimeSummary = async () => { throw new cooloff.SeriesMetadataCooloff(Date.now() + 60000, 'background'); };
    try {
        await assert.rejects(cooloff.background(() => addon.ensureSeriesRuntimeAverage(addon.series[0], old)), { code: 'SERIES_METADATA_COOLOFF' });
        assert.deepStrictEqual(entries.get(old.id), old);
    } finally { provider.fetchSeriesRuntimeSummary = originalProvider; tmdb.getSeriesRuntimeMetadata = originalTmdb; }
}

async function testSavedEpisodesRemainAvailableAndRetryAtTheProviderDeadline() {
    const originalNow = Date.now; let time = originalNow(); Date.now = () => time;
    const { addon } = makeAddon([preview()]);
    const saved = { videos: [{ id: 'iptv_series_ep_1', season: 1, episode: 1, url: 'https://provider.example/episode.mp4' }], fetchedAt: 1 };
    let writes = 0; let calls = 0;
    addon.persistentSeriesInfoCache = { get: async () => ({ value: saved, fresh: false }), set: async () => { writes++; } };
    const provider = require('../src/js/providers/xtreamProvider'); const original = provider.fetchSeriesInfo;
    provider.fetchSeriesInfo = async () => {
        calls++;
        return calls === 1 ? { videos: [], fetchError: 'HTTP 429', retryAt: time + 10000 }
            : { videos: saved.videos, fetchedAt: time };
    };
    try {
        assert.deepStrictEqual(await addon.ensureSeriesInfo('1'), saved);
        assert.strictEqual(writes, 0);
        time += 9999; await addon.ensureSeriesInfo('1'); assert.strictEqual(calls, 1);
        time += 2; assert.strictEqual((await addon.ensureSeriesInfo('1')).fetchedAt, time);
        assert.strictEqual(calls, 2, 'the old five-minute failure cache must not extend an explicit short retry delay');
        assert.strictEqual(writes, 1);
    } finally { provider.fetchSeriesInfo = original; Date.now = originalNow; }
}

async function testWarmupContinuesTmdbWorkAndResumesOnlyDeferredTitles() {
    const originalNow = Date.now; let time = originalNow(); Date.now = () => time;
    const values = [1, 2, 3].map(n => preview('iptv_series_' + n, { _tmdbId: String(n * 111),
        metadataCheckedAt: 1, missingMetadataCheckedAt: 1 }));
    const { addon, entries } = makeAddon(values);
    const originalCatalog = tmdb.getSeriesCatalogMetadata; const originalRuntime = tmdb.getSeriesRuntimeMetadata;
    const originalOmdb = omdb.getByImdbId;
    const lookups = [];
    const originalLookup = addon._getCatalogMetaAsync.bind(addon);
    addon._getCatalogMetaAsync = async (...args) => { lookups.push(args[0]); return originalLookup(...args); };
    tmdb.getSeriesCatalogMetadata = async (id, options = {}) => {
        if (String(id) === '333') return { ...values[2], runtime: '61 min', imdbId: undefined };
        Object.assign(options.diagnostics || {}, { reason: 'tmdb_not_found', httpStatus: 404 }); return null;
    };
    tmdb.getSeriesRuntimeMetadata = async () => null;
    omdb.getByImdbId = async () => null;
    const requests = [];
    let waits = 0;
    try {
        await withProvider(async input => {
            const id = new URL(input).searchParams.get('series_id'); requests.push(id);
            return id === '1' ? response429(null) : { ok: true, status: 200, json: async () => ({ info: { tmdb: '222' },
                episodes: { '1': [{ id: 20, season: 1, episode_num: 1, info: { duration_secs: 3600 } }] } }) };
        }, async () => {
            addon.waitForProviderMetadataCooloff = async retryAt => {
                waits++;
                assert.strictEqual(entries.get('iptv_series_3').runtime, '61 min', 'TMDb-only titles must finish before waiting for the provider');
                assert.strictEqual(entries.get('iptv_series_2').missingMetadataCheckedAt, 1);
                assert.strictEqual(entries.has('__catalog_prefetch_status__:series'), false);
                const details = await addon.ensureSeriesInfo('2');
                assert.strictEqual(details.videos.length, 1, 'opening another series must work during our background-only pause');
                time = retryAt + 1;
                return true;
            };
            addon.startContinuousCatalogPrefetch('series', 1, 1);
            await addon.catalogPrefetchJobs.get('series'); await flush();
            assert.strictEqual(waits, 1);
            assert.strictEqual(lookups.filter(id => id === 'iptv_series_1').length, 1);
            assert.strictEqual(lookups.filter(id => id === 'iptv_series_3').length, 1);
            assert.strictEqual(lookups.filter(id => id === 'iptv_series_2').length, 2);
            assert.strictEqual(requests.filter(id => id === '1').length, 1, 'the failed title must not send an immediate runtime fallback request');
            assert.strictEqual(entries.get('iptv_series_2').runtime, '60 min');
            assert.strictEqual(entries.has('__catalog_prefetch_status__:series'), true);
        }, { now: () => time });
    } finally {
        Date.now = originalNow; tmdb.getSeriesCatalogMetadata = originalCatalog;
        tmdb.getSeriesRuntimeMetadata = originalRuntime; omdb.getByImdbId = originalOmdb;
    }
}

async function testDisposalCancelsProviderWaitImmediately() {
    const { addon } = makeAddon([preview()]);
    const waiting = addon.waitForProviderMetadataCooloff(Date.now() + 3600000, () => true);
    await addon.dispose();
    assert.strictEqual(await waiting, false);
    assert.strictEqual(addon.providerMetadataWait, null);
}

async function testExplicitProviderCooldownUsesSavedEpisodesAndThenRecovers() {
    const originalNow = Date.now; let time = originalNow(); Date.now = () => time;
    const { addon } = makeAddon([preview('iptv_series_1'), preview('iptv_series_2')]);
    const saved = { videos: [{ id: 'iptv_series_ep_2', season: 1, episode: 1,
        url: 'https://provider.example/saved.mp4' }], fetchedAt: 1 };
    let writes = 0; let networkCalls = 0;
    addon.persistentSeriesInfoCache = { get: async () => ({ value: saved, fresh: false }),
        set: async () => { writes++; }, flush: async () => {} };
    try {
        await withProvider(async input => {
            networkCalls++;
            if (new URL(input).searchParams.get('series_id') === '1') return response429('10');
            return { ok: true, status: 200, json: async () => ({ episodes: { '1': [{ id: 2, season: 1, episode_num: 1 }] } }) };
        }, async provider => {
            await provider.fetchSeriesTmdbId(addon, '1');
            assert.deepStrictEqual(await addon.ensureSeriesInfo('2'), saved);
            assert.strictEqual(networkCalls, 1, 'an explicit provider delay also applies to new interactive requests');
            assert.strictEqual(writes, 0, 'a local cooldown must never overwrite the saved playable episode list');
            time += 10001;
            const fresh = await addon.ensureSeriesInfo('2');
            assert.strictEqual(fresh.videos.length, 1);
            assert.strictEqual(fresh.fetchedAt, time);
            assert.strictEqual(networkCalls, 2);
            assert.strictEqual(writes, 1);
        }, { now: () => time });
    } finally { Date.now = originalNow; }
}

async function testNewProviderGenerationCancelsOldCheckpointAndStartsCurrentScan() {
    const value = preview('iptv_series_1', { runtime: '60 min' });
    const { addon, entries } = makeAddon([value]);
    const generations = [];
    addon.enrichCatalogMetaItems = async (items, _concurrency, _force, deferred) => {
        generations.push(addon.lastUpdate);
        if (addon.lastUpdate === 1000) deferred.set(items[0], Date.now() + 3600000);
        return new Map([[value.id, value]]);
    };
    addon.startContinuousCatalogPrefetch('series', 50, 1);
    const original = addon.catalogPrefetchJobs.get('series');
    await flush();
    assert.strictEqual(typeof addon.providerMetadataWait, 'function');
    assert.strictEqual(entries.has('__catalog_prefetch_status__:series'), false);
    addon.lastUpdate = 2000;
    addon.providerMetadataWait();
    await original; await flush();
    const replacement = addon.catalogPrefetchJobs.get('series');
    if (replacement) await replacement;
    await flush();
    assert.deepStrictEqual(generations, [1000, 2000]);
    assert.strictEqual(entries.has('__catalog_prefetch_status__:series'), true);
    assert.strictEqual(addon.providerMetadataWait, null);
}

module.exports = [
    testSeriesCooloffReusesFailuresAndAllowsUnrelatedInteractiveLookups,
    testSeriesCooloffHonoursRetryAfterSecondsAndDatesAndSeparatesAccounts,
    testBackgroundCooloffIsBoundedButLongerProviderDelayIsRespected,
    testSeries429IsSharedAcrossSequentialIdRuntimeAndEpisodeLookups,
    testBackgroundProviderDeferralDoesNotBecomeAFalseMissingDataAttempt,
    testRuntimeDeferralKeepsItsPreviousValueAndAttemptClock,
    testSavedEpisodesRemainAvailableAndRetryAtTheProviderDeadline,
    testWarmupContinuesTmdbWorkAndResumesOnlyDeferredTitles,
    testDisposalCancelsProviderWaitImmediately,
    testExplicitProviderCooldownUsesSavedEpisodesAndThenRecovers,
    testNewProviderGenerationCancelsOldCheckpointAndStartsCurrentScan
];
