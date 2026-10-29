const assert = require('node:assert/strict');
const requests = require('../xtreamRequests');
const { M3UEPGAddon } = require('../addon');
const tmdb = require('../src/js/tmdbMetadata');
const isolateScheduler = require('./xtreamTestScheduler');

const quietLog = { debug() {}, info() {}, warn() {}, error() {} };
const config = { provider: 'xtream', xtreamUrl: 'https://provider.example',
    xtreamUsername: 'secret-user', xtreamPassword: 'secret-password', includeSeries: true };
const response = (status = 200, retryAfter = null) => ({
    status, ok: status < 400, headers: { get: () => retryAfter }
});
const url = id => 'https://provider.example/player_api.php?username=secret-user&password=secret-password&action=get_series_info&series_id=' + id;

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function flush() {
    for (let index = 0; index < 30; index++) await Promise.resolve();
}

function fakeClock() {
    let time = Date.UTC(2026, 9, 29);
    let nextTimer = 0;
    const timers = new Map();
    const clock = {
        now: () => time,
        setTimer: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: time + delay }); return id; },
        clearTimer: id => timers.delete(id),
        async advance(ms) {
            const target = time + ms;
            await flush();
            for (;;) {
                const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break;
                time = next[1].at; timers.delete(next[0]); next[1].fn();
                await flush();
            }
            time = target;
            await flush();
        }
    };
    return clock;
}

function owner(extra = {}) {
    return { providerName: 'xtream', config: { ...config }, log: quietLog, ...extra };
}

function store(values = []) {
    const entries = new Map(values.map(value => [value.id, { value: structuredClone(value), savedAt: Date.now(), fresh: true }]));
    return { entries, get: async key => entries.get(key) || null,
        set: async (key, value) => entries.set(key, { value: structuredClone(value), savedAt: Date.now(), fresh: true }),
        delete: async key => entries.delete(key), flush: async () => {} };
}

function preview(extra = {}) {
    return { id: 'iptv_series_3', type: 'series', name: 'Example series', _tmdbId: '123',
        poster: 'https://example.com/poster.jpg', background: 'https://example.com/background.jpg',
        description: 'Saved description', genres: ['Drama'], year: 2026, releaseInfo: '2026-',
        cast: ['Actor'], imdbId: 'tt1234567', imdbRating: '8.0', metadataVersion: 3,
        metadataCheckedAt: Date.now(), missingMetadataCheckedAt: Date.now(),
        omdbCheckedAt: Date.now(), omdbChecked: true, ...extra };
}

function addonFor(value) {
    const addon = new M3UEPGAddon(config);
    const item = { id: value.id, series_id: '3', type: 'series', name: value.name, tmdbId: '123' };
    addon.lastUpdate = 1000;
    addon.series = [item];
    addon.log = quietLog;
    addon.persistentCatalogMetaCache = store([value]);
    addon.persistentSeriesInfoCache = { get: async () => null, flush: async () => {} };
    return { addon, item };
}

function testXtreamRetryAfterHandlesSecondsDatesAndInvalidValues() {
    const now = Date.UTC(2026, 9, 29);
    assert.equal(requests.retryAfterMilliseconds('120', now), 120000);
    assert.equal(requests.retryAfterMilliseconds(new Date(now + 90000).toUTCString(), now), 90000);
    assert.equal(requests.retryAfterMilliseconds(new Date(now - 1000).toUTCString(), now), 0);
    for (const value of [null, undefined, '', 'invalid', '-1', '1.5', '999999999999999999999999']) {
        assert.equal(requests.retryAfterMilliseconds(value, now), null);
    }
}

async function testXtreamPacingIsSharedAndHoldsSlotsUntilBodiesFinish() {
    const clock = fakeClock();
    const scheduler = requests.createXtreamRequestScheduler({ ...clock, minIntervalMs: 100, maxConcurrent: 2 });
    const firstBody = deferred(); const secondBody = deferred();
    const started = [];
    const start = label => async () => { started.push([label, clock.now()]); return response(); };
    try {
        const first = scheduler.request(owner(), url(1), start('first'), () => firstBody.promise);
        const second = scheduler.request(owner(), url(2), start('second'), () => secondBody.promise);
        const third = scheduler.request(owner(), url(3), start('third'));
        await flush();
        assert.deepEqual(started.map(([label]) => label), ['first']);
        await clock.advance(100);
        assert.deepEqual(started.map(([label]) => label), ['first', 'second']);
        await clock.advance(150);
        assert.equal(started.length, 2, 'full response bodies count towards the concurrency cap');
        firstBody.resolve('parsed'); await flush();
        assert.deepEqual(started.map(([label]) => label), ['first', 'second', 'third']);
        assert.equal(started[2][1] - started[0][1], 250);
        secondBody.resolve('parsed'); await Promise.all([first, second, third]);
    } finally { scheduler.close(); }
}

async function testXtreamInteractiveRequestsOvertakeWarmupAndPromoteSharedWork() {
    const clock = fakeClock();
    const scheduler = requests.createXtreamRequestScheduler({ ...clock, minIntervalMs: 100 });
    const addon = owner(); const order = [];
    const enqueue = id => scheduler.request(addon, url(id), async () => { order.push(id); return response(); });
    try {
        const first = requests.background(() => true, () => enqueue(1));
        const second = requests.background(() => true, () => enqueue(2));
        const third = enqueue(3);
        await clock.advance(100);
        assert.deepEqual(order, [1, 3]);
        // The foreground can join a warm-up already queued for the same title.
        scheduler.promote(addon, 2);
        const fourth = enqueue(4);
        await clock.advance(200);
        assert.deepEqual(order, [1, 3, 2, 4]);
        await Promise.all([first, second, third, fourth]);
    } finally { scheduler.close(); }
}

async function testXtream429StopsQueuedRequestsAndSharesCooldownAcrossFeatures() {
    const clock = fakeClock(); const logs = [];
    const scheduler = requests.createXtreamRequestScheduler({ ...clock, minIntervalMs: 1000 });
    const addon = owner({ log: { warn: (...args) => logs.push(args), info: (...args) => logs.push(args) } });
    let calls = 0; let destroyed = false;
    const fetch = async () => { calls++; return response(); };
    try {
        const failed = scheduler.request(addon, url(1), async () => {
            calls++; return { ...response(429, new Date(clock.now() + 5000).toUTCString()), body: { destroy() { destroyed = true; } } };
        }).catch(error => error);
        const queued = scheduler.request(addon, url(2), fetch).catch(error => error);
        await flush();
        const error = await failed;
        assert.equal(error.code, 'XTREAM_RATE_LIMITED');
        assert.equal(error.retryAt, clock.now() + 5000);
        assert.equal((await queued).code, 'XTREAM_RATE_LIMITED');
        assert.equal(destroyed, true);
        await assert.rejects(scheduler.request(owner(), 'https://provider.example/player_api.php?action=get_vod_info&vod_id=5', fetch),
            { code: 'XTREAM_RATE_LIMITED' });
        await assert.rejects(scheduler.request(owner(), 'https://provider.example/xmltv.php', fetch), { code: 'XTREAM_RATE_LIMITED' });
        assert.equal(calls, 1, 'a cooldown must prevent new network calls, including other addon instances');
        await scheduler.request(addon, 'https://other-epg.example/xmltv', fetch);
        assert.equal(calls, 2, 'external EPG hosts must remain independent');
        await clock.advance(5000);
        await scheduler.request(addon, url(3), fetch);
        assert.equal(scheduler.getState(addon).requestIntervalMs, 2000, 'resume at a lower request rate');
        assert.equal(logs.filter(([message]) => message.includes('paused')).length, 1);
        assert.equal(logs.filter(([message]) => message.includes('resumed')).length, 1);
        assert.ok(!JSON.stringify(logs).includes('secret-'));
        assert.ok(!JSON.stringify(error).includes('secret-'));
    } finally { scheduler.close(); }
}

async function testXtreamMissingRetryAfterUsesIncreasingCooldownAndNoAutomaticFlood() {
    const clock = fakeClock();
    const scheduler = requests.createXtreamRequestScheduler({ ...clock, minIntervalMs: 1000 });
    const addon = owner(); let calls = 0;
    try {
        for (const delay of [60000, 120000, 240000]) {
            const error = await scheduler.request(addon, url(1), async () => { calls++; return response(429); }).catch(error => error);
            assert.equal(error.retryAt - clock.now(), delay);
            await clock.advance(delay);
            assert.equal(calls, [60000, 120000, 240000].indexOf(delay) + 1,
                'the scheduler must wait for a caller instead of repeatedly retrying by itself');
        }
    } finally { scheduler.close(); }
}

async function testXtreamCancelledAndOutdatedQueuedRequestsNeverFetch() {
    const clock = fakeClock();
    const scheduler = requests.createXtreamRequestScheduler({ ...clock, minIntervalMs: 100 });
    let calls = 0; let current = true;
    const addon = owner(); const other = owner();
    const fetch = async () => { calls++; return response(); };
    try {
        await scheduler.request(addon, url(1), fetch);
        const outdated = requests.background(() => current, () => scheduler.request(addon, url(2), fetch)).catch(error => error);
        const cancelled = scheduler.request(other, url(3), fetch).catch(error => error);
        const valid = scheduler.request(addon, url(4), fetch);
        current = false; other.disposed = true; scheduler.cancel(other);
        await clock.advance(100);
        assert.equal((await outdated).code, 'XTREAM_REQUEST_CANCELLED');
        assert.equal((await cancelled).code, 'XTREAM_REQUEST_CANCELLED');
        await valid;
        assert.equal(calls, 2);
    } finally { scheduler.close(); }
}

async function testXtreamProviderShares429BetweenSeriesDetailsAndMovieFallback() {
    const clock = fakeClock();
    const restore = isolateScheduler({ ...clock });
    const safety = require('../urlSafety'); const originalFetch = safety.safeFetch;
    const modulePath = require.resolve('../src/js/providers/xtreamProvider');
    const originalModule = require.cache[modulePath];
    let calls = 0;
    safety.safeFetch = async () => { calls++; return response(429, '30'); };
    delete require.cache[modulePath];
    try {
        const provider = require(modulePath); const diagnostic = {};
        assert.equal(await provider.fetchSeriesRuntimeInfo(owner(), '3', diagnostic), null);
        assert.equal(diagnostic.httpStatus, 429);
        assert.equal(diagnostic.retryAt, clock.now() + 30000);
        const details = await provider.fetchSeriesInfo(owner(), '4');
        assert.equal(details.fetchError, 'HTTP 429');
        assert.equal(details.retryAt, diagnostic.retryAt);
        await assert.rejects(provider.fetchMovieInfo(owner(), '5'), { code: 'XTREAM_RATE_LIMITED' });
        await assert.rejects(provider.fetchData(owner()), { code: 'XTREAM_RATE_LIMITED' });
        assert.equal(calls, 1);
    } finally {
        restore(); safety.safeFetch = originalFetch; delete require.cache[modulePath];
        if (originalModule) require.cache[modulePath] = originalModule;
    }
}

async function testXtreamQuotaDoesNotEraseCardsOrSetTwelveHourMetadataBackoff() {
    const saved = preview({ description: undefined, runtime: '60 min', missingMetadataCheckedAt: 1 });
    const { addon } = addonFor(saved);
    let attempts = 0;
    addon._getCatalogMetaAsync = async () => {
        attempts++;
        if (attempts === 1) throw new requests.XtreamRateLimitError(Date.now() + 60000);
        return { ...saved, description: 'Recovered description' };
    };
    const first = (await addon.enrichCatalogMetaItems(addon.series, 1)).get(saved.id);
    assert.equal(first.runtime, '60 min');
    assert.equal(first.poster, saved.poster);
    assert.equal(first.missingMetadataCheckedAt, 1);
    const second = (await addon.enrichCatalogMetaItems(addon.series, 1)).get(saved.id);
    assert.equal(attempts, 2, 'rate limiting must not be cached as a definitive missing match');
    assert.equal(second.description, 'Recovered description');
}

async function testXtreamSeriesEpisodeFallbackExpiresAtCooldownWithoutOverwritingVolume() {
    const { addon } = addonFor(preview());
    const provider = require('../src/js/providers/xtreamProvider');
    const original = provider.fetchSeriesInfo; const originalNow = Date.now;
    let time = originalNow(); Date.now = () => time;
    const saved = { videos: [{ id: 'iptv_series_ep_1', season: 1, episode: 1, url: 'https://provider.example/saved.mp4' }], fetchedAt: 1 };
    let calls = 0; let writes = 0;
    addon.persistentSeriesInfoCache = { get: async () => ({ fresh: false, value: saved }),
        set: async () => { writes++; } };
    provider.fetchSeriesInfo = async () => {
        calls++;
        return calls === 1 ? { videos: [], fetchError: 'HTTP 429', retryAt: time + 60000 }
            : { videos: [...saved.videos], fetchedAt: time };
    };
    try {
        assert.deepEqual(await addon.ensureSeriesInfo('3'), saved);
        assert.equal(writes, 0, 'a quota response must never replace saved episodes with an empty list');
        assert.deepEqual(await addon.ensureSeriesInfo('3'), saved);
        assert.equal(calls, 1);
        time += 60001;
        assert.equal((await addon.ensureSeriesInfo('3')).fetchedAt, time);
        assert.equal(calls, 2);
        assert.equal(writes, 1);
    } finally { provider.fetchSeriesInfo = original; Date.now = originalNow; }
}

async function testXtreamMovieDetailsRemainAvailableDuringQuotaWithoutCachingAMissingId() {
    const value = preview({ id: 'iptv_vod_5', type: 'movie', runtime: '120 min', director: ['Director'] });
    const { addon } = addonFor(value);
    addon.series = [];
    addon.movies = [{ id: value.id, type: 'movie', name: value.name }];
    const provider = require('../src/js/providers/xtreamProvider');
    const original = provider.fetchMovieInfo;
    provider.fetchMovieInfo = async () => { throw new requests.XtreamRateLimitError(Date.now() + 60000); };
    try {
        const meta = await addon.getDetailedMetaAsync(value.id, 'movie');
        assert.equal(meta.description, value.description);
        assert.equal(meta.runtime, value.runtime);
        assert.equal(meta.imdbRating, value.imdbRating);
        assert.equal(addon.seriesInfoCache.has('movie-tmdb-miss:' + value.id), false);
        assert.deepEqual(addon.persistentCatalogMetaCache.entries.get(value.id).value, value);
    } finally { provider.fetchMovieInfo = original; }
}

async function testXtreamQuotaRefreshRetainsCatalogueGuideAndTimestamp() {
    const restore = isolateScheduler();
    const safety = require('../urlSafety'); const originalFetch = safety.safeFetch;
    const modulePath = require.resolve('../src/js/providers/xtreamProvider'); const originalModule = require.cache[modulePath];
    let requestsMade = 0; let savedSnapshots = 0; let pruned = 0;
    safety.safeFetch = async () => { requestsMade++; return response(429, '30'); };
    delete require.cache[modulePath];
    const { addon } = addonFor(preview());
    addon.channels = [{ id: 'iptv_live_1', name: 'Saved channel' }];
    addon.movies = [{ id: 'iptv_vod_2', name: 'Saved movie' }];
    addon.epgData = { one: [{ title: 'Saved programme' }] };
    const previous = { channels: addon.channels, movies: addon.movies, series: addon.series, epgData: addon.epgData, lastUpdate: addon.lastUpdate };
    addon.saveToCache = async () => { savedSnapshots++; };
    addon.persistentAddonDataCache.save = async () => { savedSnapshots++; return true; };
    addon.pruneRemovedCatalogState = async () => { pruned++; };
    try {
        await addon.updateData(true);
        const beforeRetry = requestsMade;
        assert.ok(beforeRetry >= 1 && beforeRetry <= 2, 'only requests already active may reach the provider');
        await addon.updateData(true);
        for (const [key, value] of Object.entries(previous)) assert.equal(addon[key], value);
        assert.equal(savedSnapshots, 0);
        assert.equal(pruned, 0);
        assert.equal(requestsMade, beforeRetry, 'another refresh during cooldown must not contact the provider');
    } finally {
        restore(); safety.safeFetch = originalFetch; delete require.cache[modulePath];
        if (originalModule) require.cache[modulePath] = originalModule;
    }
}

async function testTmdbRateLimitIsNotMisreportedAsAnXtreamCooldown() {
    const { addon, item } = addonFor(preview());
    const provider = require('../src/js/providers/xtreamProvider');
    const originalProvider = provider.fetchSeriesRuntimeInfo;
    const originalLevel = tmdb.getSeriesLevelRuntime; const originalAverage = tmdb.getSeriesRuntimeMetadata;
    let attempts = 0;
    tmdb.getSeriesLevelRuntime = async () => null;
    provider.fetchSeriesRuntimeInfo = async () => ({ episodes: [{ id: 'ep1', season: 1, episode: 1 }] });
    tmdb.getSeriesRuntimeMetadata = async () => {
        attempts++;
        return { lookupFailure: { reason: 'tmdb_http_error', httpStatus: 429 } };
    };
    try {
        const value = await requests.background(() => true, () => addon.ensureSeriesRuntimeAverage(item, preview()));
        assert.deepEqual(value.runtimeAverage.lastFailure, { reason: 'tmdb_http_error', httpStatus: 429 });
        await addon.ensureSeriesRuntimeAverage(item, value);
        assert.equal(attempts, 1, 'TMDb must keep its own retry policy');
    } finally {
        provider.fetchSeriesRuntimeInfo = originalProvider;
        tmdb.getSeriesLevelRuntime = originalLevel; tmdb.getSeriesRuntimeMetadata = originalAverage;
    }
}

async function testXtreamWarmupPausesAndAutomaticallyResumesWithoutCompletingScan() {
    const originalNow = Date.now; const originalSet = global.setTimeout; const originalClear = global.clearTimeout;
    let time = originalNow(); const timers = new Map(); let sequence = 0;
    Date.now = () => time;
    global.setTimeout = (fn, delay) => { const timer = { id: ++sequence, unref() {} }; timers.set(timer, { fn, delay }); return timer; };
    global.clearTimeout = timer => timers.delete(timer);
    const saved = preview({ runtime: '22 min', runtimeAverage: {
        version: 1, runtime: '22 min', source: 'tmdb-episodes', complete: true,
        lastFailure: { reason: 'provider_http_error', httpStatus: 429 },
        lookupRevision: 1, scopeMigrationAttemptedAt: time, attemptedAt: time
    } });
    const { addon } = addonFor(saved);
    const provider = require('../src/js/providers/xtreamProvider');
    const originalProvider = provider.fetchSeriesRuntimeInfo;
    const originalLevel = tmdb.getSeriesLevelRuntime; const originalAverage = tmdb.getSeriesRuntimeMetadata;
    let calls = 0;
    tmdb.getSeriesLevelRuntime = async () => null;
    provider.fetchSeriesRuntimeInfo = async (_addon, _id, diagnostic) => {
        calls++;
        if (calls === 1) {
            Object.assign(diagnostic, { reason: 'provider_http_error', httpStatus: 429, retryAt: time + 60000 });
            return null;
        }
        return { episodes: [{ id: 'ep1', season: 1, episode: 1, runtimeMinutes: 63 }] };
    };
    tmdb.getSeriesRuntimeMetadata = async () => ({ source: 'provider-episodes', runtime: '63 min', complete: true,
        episodeCount: 1, totalMinutes: 63, providerDurationCount: 1 });
    try {
        addon.startContinuousCatalogPrefetch('series', 50, 3);
        await assert.rejects(addon.catalogPrefetchJobs.get('series'), { code: 'XTREAM_RATE_LIMITED' });
        await flush();
        assert.equal(addon.persistentCatalogMetaCache.entries.has('__catalog_prefetch_status__:series'), false,
            'an interrupted warm-up must not save a successful completion marker');
        assert.equal(addon.catalogPrefetchResumeTimers.size, 1);
        const retained = addon.persistentCatalogMetaCache.entries.get(saved.id).value;
        assert.equal(retained.runtime, '22 min');
        assert.equal(retained.description, saved.description);
        assert.equal(retained.runtimeAverage.lastFailure.retryAt, time + 60000);
        const timer = addon.catalogPrefetchResumeTimers.get('series');
        assert.equal(timers.get(timer).delay, 60000);
        time += 60001;
        timers.get(timer).fn();
        await addon.catalogPrefetchJobs.get('series');
        await flush();
        assert.equal(calls, 2, 'the old 12-hour backoff must not delay a quota retry');
        assert.equal(addon.persistentCatalogMetaCache.entries.get(saved.id).value.runtime, '63 min');
        assert.equal(addon.persistentCatalogMetaCache.entries.has('__catalog_prefetch_status__:series'), true);
        assert.equal(addon.catalogPrefetchResumeTimers.size, 0);
    } finally {
        for (const timer of addon.catalogPrefetchResumeTimers.values()) global.clearTimeout(timer);
        provider.fetchSeriesRuntimeInfo = originalProvider;
        tmdb.getSeriesLevelRuntime = originalLevel; tmdb.getSeriesRuntimeMetadata = originalAverage;
        Date.now = originalNow; global.setTimeout = originalSet; global.clearTimeout = originalClear;
    }
}

module.exports = [
    testXtreamRetryAfterHandlesSecondsDatesAndInvalidValues,
    testXtreamPacingIsSharedAndHoldsSlotsUntilBodiesFinish,
    testXtreamInteractiveRequestsOvertakeWarmupAndPromoteSharedWork,
    testXtream429StopsQueuedRequestsAndSharesCooldownAcrossFeatures,
    testXtreamMissingRetryAfterUsesIncreasingCooldownAndNoAutomaticFlood,
    testXtreamCancelledAndOutdatedQueuedRequestsNeverFetch,
    testXtreamProviderShares429BetweenSeriesDetailsAndMovieFallback,
    testXtreamQuotaDoesNotEraseCardsOrSetTwelveHourMetadataBackoff,
    testXtreamSeriesEpisodeFallbackExpiresAtCooldownWithoutOverwritingVolume,
    testXtreamMovieDetailsRemainAvailableDuringQuotaWithoutCachingAMissingId,
    testXtreamQuotaRefreshRetainsCatalogueGuideAndTimestamp,
    testTmdbRateLimitIsNotMisreportedAsAnXtreamCooldown,
    testXtreamWarmupPausesAndAutomaticallyResumesWithoutCompletingScan
];
