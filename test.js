const assert = require("assert");
process.env.CONFIG_SECRET = "test-only-secret-with-more-than-32-characters";

const { encryptConfig, decryptConfig, tryParseConfigToken } = require("./cryptoConfig");
const LRUCache = require("./lruCache");
const { isPublicAddress, resolvePublicAddresses, safeFetch, getPinnedAgent } = require("./urlSafety");
const { validateConfig } = require("./configValidation");
const { Readable } = require("stream");
const { parseEPGStream, MAX_TITLE_CHARS, MAX_DESCRIPTION_CHARS, MAX_PROGRAMMES_TOTAL } = require("./src/js/epgStreamParser");
const { M3UEPGAddon, normalizeGenre, matchesGenre, normalizeSearchText, matchesSearchText, matchesNormalizedSearchText, getCatalogueQueryResultCache, createCatalogueQueryCacheKey, cacheCatalogueQueryResults, omdbMetadataNeedsRefresh, catalogMetadataNeedsRefresh } = require("./addon");
const { validTmdbId, tmdbConfigured, getMovieMetadata, getSeriesMetadata, mapMovieMetadata, mapSeriesMetadata, mapSeasonEpisodes } = require("./src/js/tmdbMetadata");
const { normalizeTmdbId } = require("./src/js/providers/xtreamProvider");
const PersistentCatalogMetaCache = require("./persistentCatalogMetaCache");
const PersistentAddonDataCache = require("./persistentAddonDataCache");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { rebuildDirectEpisodeIndexes } = require("./src/js/providers/directProvider");

function testCatalogueQueryResultCacheIsBoundedAndPreservesPagination() {
    const catalogue = [
        { id: "m1", name: "Alpha Movie", category: "Drama" },
        { id: "m2", name: "Alpha Series", category: "Comedy" },
        { id: "m3", name: "Alpha Story", category: "Drama" },
        { id: "m4", name: "Beta Movie", category: "Drama" }
    ];
    const cache = getCatalogueQueryResultCache(catalogue);
    const key = createCatalogueQueryCacheKey("alpha", "");
    const results = catalogue.filter(item => item.name.toLowerCase().includes("alpha"));
    cacheCatalogueQueryResults(cache, key, results, 2);

    assert.strictEqual(getCatalogueQueryResultCache(catalogue), cache,
        "the same catalogue array should reuse its result cache");
    assert.deepStrictEqual(cache.get(key), results);
    assert.deepStrictEqual(cache.get(key).slice(1, 3).map(item => item.id), ["m2", "m3"],
        "pagination over cached results must preserve provider order");

    const genreKey = createCatalogueQueryCacheKey("alpha", "drama");
    assert.notStrictEqual(genreKey, key, "the selected genre must be part of the query cache key");
    cacheCatalogueQueryResults(cache, genreKey, results.filter(item => item.category === "Drama"), 2);
    const thirdKey = createCatalogueQueryCacheKey("beta", "");
    cacheCatalogueQueryResults(cache, thirdKey, [catalogue[3]], 2);
    assert.strictEqual(cache.size, 2, "the cache must remain within its configured entry bound");
    assert.strictEqual(cache.has(key), false, "oldest search should be evicted when the bound is exceeded");

    const refreshedCatalogue = catalogue.slice();
    assert.notStrictEqual(getCatalogueQueryResultCache(refreshedCatalogue), cache,
        "a replacement catalogue array must not reuse potentially stale search results");
    assert.strictEqual(createCatalogueQueryCacheKey("", "drama"), null,
        "empty normalized searches should not be cached as ordinary queries");
}

function testBuildGenresNormalizesNumericXtreamCategories() {
    const manifest = {
        catalogs: [
            { id: "iptv_channels", genres: [] },
            { id: "iptv_movies", genres: [] },
            { id: "iptv_series", genres: [] }
        ],
        behaviorHints: {}
    };
    const addon = new M3UEPGAddon({ provider: "xtream" }, manifest);
    addon.channels = [
        { category: 14 },
        { category: " News ", attributes: { "group-title": "Ignored fallback" } },
        { category: null, attributes: { "group-title": " Sports " } },
        { category: { unexpected: true }, attributes: { "group-title": " Other " } }
    ];
    addon.movies = [{ category: 27 }];
    addon.series = [{ category: null, attributes: { "group-title": " Drama " } }];
    addon.epgData = {};

    assert.doesNotThrow(() => addon.buildGenresInManifest());
    assert.deepStrictEqual(manifest.catalogs[0].genres, ["All Channels", "14", "News", "Sports", "Other"]);
    assert.deepStrictEqual(manifest.catalogs[1].genres, ["27"]);
    assert.deepStrictEqual(manifest.catalogs[2].genres, ["Drama"]);
}

async function testFailedGenreBuildDoesNotPersistProviderRefresh() {
    const provider = require("./src/js/providers/directProvider");
    const originalFetchData = provider.fetchData;
    const manifest = { catalogs: [], behaviorHints: {} };
    const addon = new M3UEPGAddon({
        provider: "direct",
        m3uUrl: "https://example.com/refresh-rollback-test.m3u"
    }, manifest);
    const previousChannels = [{ id: "old-channel", category: "Old" }];
    const previousLastUpdate = Date.now() - addon.updateInterval - 1000;
    addon.channels = previousChannels;
    addon.lastUpdate = previousLastUpdate;
    let persisted = false;
    addon.log = { error() {} };
    addon.pruneRemovedCatalogState = async () => {};
    addon.saveToCache = async () => { persisted = true; };
    addon.buildGenresInManifest = () => { throw new TypeError("simulated genre build failure"); };

    provider.fetchData = async refreshed => {
        refreshed.channels = [{ id: "new-channel", category: "New" }];
        refreshed.movies = [];
        refreshed.series = [];
        refreshed.epgData = {};
    };
    try {
        await addon.updateData(true);
    } finally {
        provider.fetchData = originalFetchData;
    }

    assert.strictEqual(persisted, false, "a refresh that fails genre building must not save its new provider snapshot");
    assert.strictEqual(addon.channels, previousChannels, "the last-known-good in-memory catalogue must be restored");
    assert.strictEqual(addon.lastUpdate, previousLastUpdate, "a failed refresh must leave its prior timestamp intact");
}

function testDirectEpisodeLookupUsesExactIndex() {
    const addon = new M3UEPGAddon({ provider: "direct" });
    const staleEpisode = { id: "iptv_series_ep_stale", title: "Old episode" };
    addon.directSeriesEpisodeIndex.set("old-series", [staleEpisode]);
    addon.directSeriesEpisodeById.set(staleEpisode.id, staleEpisode);

    const firstEpisode = { id: "iptv_series_ep_example", title: "Example episode", season: 1, episode: 1, url: "https://example.com/episode.m3u8" };
    const duplicateIdEpisode = { id: firstEpisode.id, title: "Duplicate ID episode", season: 1, episode: 2, url: "https://example.com/duplicate.m3u8" };
    const secondEpisode = { id: "iptv_series_ep_second", title: "Second episode", season: 1, episode: 2, url: "https://example.com/second.m3u8" };
    const episodesBySeries = new Map([
        ["iptv_series_example", [firstEpisode, duplicateIdEpisode]],
        ["iptv_series_other", [secondEpisode]]
    ]);

    rebuildDirectEpisodeIndexes(addon, episodesBySeries);

    assert.strictEqual(addon.directSeriesEpisodeIndex.get("example")[0], firstEpisode);
    assert.strictEqual(addon.directSeriesEpisodeIndex.get("example").length, 2);
    assert.strictEqual(addon.directSeriesEpisodeIndex.get("other")[0], secondEpisode);
    assert.strictEqual(addon.directSeriesEpisodeById.get(firstEpisode.id), firstEpisode, "first duplicate ID should be preserved");
    assert.strictEqual(addon.directSeriesEpisodeById.get(secondEpisode.id), secondEpisode);
    assert.strictEqual(addon.directSeriesEpisodeById.has(staleEpisode.id), false, "rebuilding indexes should remove stale IDs");
    assert.strictEqual(addon.lookupEpisodeById(firstEpisode.id), firstEpisode);
    assert.strictEqual(addon.lookupEpisodeById("iptv_series_ep_missing"), null);
}

function testEncryptedConfigRoundTrip() {
    const config = {
        provider: "xtream",
        xtreamUsername: "test-user",
        xtreamPassword: "test-password",
        epgUrls: ["https://example.com/guide.xml"],
    };
    const token = encryptConfig(JSON.stringify(config));

    assert.ok(token.startsWith("enc:"), "encrypted token should have the enc: prefix");
    assert.ok(!token.includes(config.xtreamPassword), "token should not expose the password as plain text");
    assert.deepStrictEqual(decryptConfig(token), config);
    assert.deepStrictEqual(tryParseConfigToken(token), config);
}

function testTamperedConfigIsRejected() {
    const token = encryptConfig(JSON.stringify({ provider: "direct" }));
    const payload = token.slice(4);
    const first = payload[0] === "A" ? "B" : "A";
    const tampered = "enc:" + first + payload.slice(1);

    assert.throws(() => decryptConfig(tampered), "tampered encrypted config must fail authentication");
}

function testMalformedTokensAreRejected() {
    assert.throws(() => tryParseConfigToken("enc:not-a-valid-payload"));
    assert.throws(() => tryParseConfigToken("not-valid-json"));
}

function testLegacyTokensRequireExplicitOptIn() {
    const legacy = Buffer.from(JSON.stringify({ provider: "direct", m3uUrl: "https://example.com/list.m3u" })).toString("base64url");
    delete process.env.ALLOW_LEGACY_CONFIG_TOKENS;
    assert.throws(() => tryParseConfigToken(legacy), /Legacy unencrypted/);
    process.env.ALLOW_LEGACY_CONFIG_TOKENS = "true";
    assert.deepStrictEqual(tryParseConfigToken(legacy), { provider: "direct", m3uUrl: "https://example.com/list.m3u" });
    delete process.env.ALLOW_LEGACY_CONFIG_TOKENS;
}

function testSearchNormalisationIgnoresPunctuationAndExtraWhitespace() {
    assert.strictEqual(normalizeSearchText("Spider-Man"), "spider man");
    assert.strictEqual(normalizeSearchText("spider man"), "spider man");
    assert.strictEqual(normalizeSearchText("  SPIDER   MAN  "), "spider man");
    assert.strictEqual(normalizeSearchText("Spider—Man: Brand New Day"), "spider man brand new day");
    assert.strictEqual(normalizeSearchText("Café"), normalizeSearchText("CAFÉ"));
    assert.strictEqual(normalizeSearchText("Amélie"), "amelie");
    assert.strictEqual(normalizeSearchText("It's Time"), normalizeSearchText("Its Time"));
    assert.strictEqual(normalizeSearchText("   ---   "), "");
}

function testSearchSupportsReorderedWordsAndPartialTyping() {
    assert.strictEqual(matchesSearchText("man spider", "Spider-Man: Brand New Day"), true);
    assert.strictEqual(matchesSearchText("spid man", "Spider-Man"), true);
    assert.strictEqual(matchesSearchText("brand day", "Spider-Man: Brand New Day"), true);
    assert.strictEqual(matchesSearchText("man man", "Spider-Man"), false);
}

function testNormalizedSearchMatcherAgreesWithPublicMatcher() {
    const normalize = normalizeSearchText;
    const cases = [
        ["man spider", "Spider-Man: Brand New Day", true],
        ["spid man", "Spider-Man", true],
        ["spidr man", "Spider-Man", false],
        ["spxxr man", "Spider-Man", false],
        ["man man", "Spider-Man", false],
        ["", "Spider-Man", false]
    ];
    for (const [query, title, expected] of cases) {
        assert.strictEqual(
            matchesNormalizedSearchText(normalize(query), normalize(title)),
            matchesSearchText(query, title),
            "normalized and standard matching should agree for " + query + " / " + title
        );
        assert.strictEqual(matchesNormalizedSearchText(normalize(query), normalize(title)), expected);
    }
}

function testSearchRejectsTypoOnlyMatches() {
    assert.strictEqual(matchesSearchText("spidr man", "Spider-Man"), false);
    assert.strictEqual(matchesSearchText("Amelie", "Amélie"), true);
    assert.strictEqual(matchesSearchText("spxxr man", "Spider-Man"), false);
    assert.strictEqual(matchesSearchText("spi", "Spider-Man"), true);
    assert.strictEqual(matchesSearchText("   ", "Spider-Man"), false);
}

function testGenreMatchingIgnoresCaseAndWhitespace() {
    assert.strictEqual(normalizeGenre(" Peacock "), "peacock");
    assert.strictEqual(normalizeGenre("PEACOCK"), "peacock");
    assert.strictEqual(normalizeGenre("Peacock" + String.fromCharCode(160)), "peacock");
    assert.strictEqual(matchesGenre("Peacock" + String.fromCharCode(160), "Peacock"), true);
    assert.strictEqual(matchesGenre("  PEACOCK  ", "Peacock"), true);
    assert.strictEqual(matchesGenre("Peacock" + String.fromCharCode(160), "Peacock"), true);
    assert.strictEqual(matchesGenre("USA | Peacock", "Peacock"), false);
    assert.strictEqual(matchesGenre("Peacock Plus", "Peacock"), false);
    assert.strictEqual(matchesGenre("TNT Sports", "Peacock"), false);
    assert.strictEqual(normalizeGenre("All   Channels"), "all channels");
}

function testTmdbIdValidationAndMissingKeyGracefulHandling() {
    assert.strictEqual(validTmdbId("969681"), "969681");
    assert.strictEqual(validTmdbId(94997), "94997");
    assert.strictEqual(validTmdbId("0"), null);
    assert.strictEqual(validTmdbId(""), null);
    assert.strictEqual(validTmdbId("tt1234567"), null);
    assert.strictEqual(validTmdbId("../1"), null);
    if (!tmdbConfigured()) {
        return Promise.all([
            getMovieMetadata("969681").then(value => assert.strictEqual(value, null)),
            getSeriesMetadata("65251").then(value => assert.strictEqual(value, null))
        ]);
    }
}

function testMovieMetadataMapping() {
    const meta = mapMovieMetadata(
        {
            title: "Spider-Man: Brand New Day",
            overview: "A sample overview.",
            release_date: "2026-07-29",
            runtime: 145,
            poster_path: "/poster.jpg",
            backdrop_path: "/backdrop.jpg",
            vote_average: 7.9,
            vote_count: 1200,
            genres: [{ id: 28, name: "Action" }, { id: 12, name: "Adventure" }]
        },
        {
            crew: [{ id: 55, job: "Director", name: "Sample Director" }, { id: 56, job: "Director", name: "Co-Director" }, { id: 57, job: "Writer", name: "Sample Writer" }],
            cast: Array.from({ length: 8 }, (_, index) => ({ id: 101 + index, name: "Actor " + (index + 1) }))
        },
        { results: [{ site: "YouTube", type: "Trailer", key: "abc123", name: "Official Trailer" }] },
        { logos: [{ iso_639_1: "en", file_path: "/movie-logo.png" }] }
    );
    assert.strictEqual(meta.name, "Spider-Man: Brand New Day");
    assert.strictEqual(meta.year, 2026);
    assert.strictEqual(meta.releaseInfo, "2026");
    assert.strictEqual(meta.runtime, "145 min");
    assert.strictEqual(meta.rating, "7.9");
    assert.deepStrictEqual(meta.genres, ["Action", "Adventure"]);
    assert.deepStrictEqual(meta.director, ["Sample Director", "Co-Director"]);
    assert.deepStrictEqual(meta.cast, ["Actor 1", "Actor 2", "Actor 3", "Actor 4"]);
    assert.deepStrictEqual(meta.links, [
        { name: "Action", category: "Genres", url: "https://www.themoviedb.org/genre/28" },
        { name: "Adventure", category: "Genres", url: "https://www.themoviedb.org/genre/12" },
        { name: "Actor 1", category: "Cast", url: "https://www.themoviedb.org/person/101" },
        { name: "Actor 2", category: "Cast", url: "https://www.themoviedb.org/person/102" },
        { name: "Actor 3", category: "Cast", url: "https://www.themoviedb.org/person/103" },
        { name: "Actor 4", category: "Cast", url: "https://www.themoviedb.org/person/104" },
        { name: "Sample Director", category: "Directors", url: "https://www.themoviedb.org/person/55" },
        { name: "Co-Director", category: "Directors", url: "https://www.themoviedb.org/person/56" },
        { name: "Sample Writer", category: "Writers", url: "https://www.themoviedb.org/person/57" }
    ]);
    assert.strictEqual(meta.poster, "https://image.tmdb.org/t/p/w500/poster.jpg");
    assert.strictEqual(meta.background, "https://image.tmdb.org/t/p/w1280/backdrop.jpg");
    assert.strictEqual(meta.logo, "https://image.tmdb.org/t/p/w500/movie-logo.png");
    assert.strictEqual(meta.trailer.id, "abc123");
    assert.strictEqual(mapMovieMetadata({ title: "Unknown", vote_average: 9.9, vote_count: 0 }, {}, {}).rating, undefined);
}

function testSeriesMetadataMapping() {
    const meta = mapSeriesMetadata(
        {
            name: "Crashing",
            overview: "Series overview.",
            first_air_date: "2016-01-01",
            last_air_date: "2024-12-31",
            status: "Ended",
            episode_run_time: [25],
            poster_path: "/series.jpg",
            backdrop_path: "/series-backdrop.jpg",
            vote_average: 7,
            vote_count: 50,
            genres: [{ id: 35, name: "Comedy" }]
        },
        {
            crew: [{ name: "Sample Director", jobs: [{ job: "Director" }] }],
            cast: [{ id: 202, name: "Series Actor" }]
        },
        { results: [] },
        { logos: [{ iso_639_1: "en", file_path: "/series-logo.png" }] }
    );
    assert.strictEqual(meta.name, "Crashing");
    assert.strictEqual(meta.year, 2016);
    assert.strictEqual(meta.releaseInfo, "2016-2024");
    assert.strictEqual(meta.runtime, "25 min");
    assert.strictEqual(meta.rating, "7.0");
    assert.deepStrictEqual(meta.genres, ["Comedy"]);
    assert.strictEqual(meta.director, undefined);
    assert.deepStrictEqual(meta.cast, ["Series Actor"]);
    assert.deepStrictEqual(meta.links, [
        { name: "Comedy", category: "Genres", url: "https://www.themoviedb.org/genre/35" },
        { name: "Series Actor", category: "Cast", url: "https://www.themoviedb.org/person/202" }
    ]);
    assert.strictEqual(meta.trailer, undefined);
    assert.strictEqual(meta.logo, "https://image.tmdb.org/t/p/w500/series-logo.png");
}

function testEpisodeMetadataMapping() {
    const episodes = mapSeasonEpisodes({
        episodes: [
            {
                season_number: 1,
                episode_number: 2,
                name: "The Example",
                overview: "Episode overview.",
                air_date: "2026-03-01",
                still_path: "/episode.jpg",
                runtime: 44,
                vote_average: 8.1,
                vote_count: 30,
                guest_stars: [{ name: "Guest Actor" }],
                crew: [{ name: "Episode Director", job: "Director" }, { name: "Episode Writer", job: "Writer" }]
            },
            { season_number: 1, episode_number: 0, name: "Invalid episode" }
        ]
    }, 1);
    assert.strictEqual(episodes.length, 1);
    assert.strictEqual(episodes[0].season, 1);
    assert.strictEqual(episodes[0].episode, 2);
    assert.strictEqual(episodes[0].title, "The Example");
    assert.strictEqual(episodes[0].description, "Episode overview.");
    assert.strictEqual(episodes[0].thumbnail, "https://image.tmdb.org/t/p/w500/episode.jpg");
    assert.strictEqual(episodes[0].runtime, "44 min");
    assert.strictEqual(episodes[0].rating, "8.1");
    assert.deepStrictEqual(episodes[0].guestStars, ["Guest Actor"]);
    assert.deepStrictEqual(episodes[0].directors, ["Episode Director"]);
    assert.strictEqual(mapSeasonEpisodes(null, 1), null);
}

function testXtreamTmdbIdNormalization() {
    assert.strictEqual(normalizeTmdbId("969681"), "969681");
    assert.strictEqual(normalizeTmdbId(94997), "94997");
    assert.strictEqual(normalizeTmdbId(" 65251 "), "65251");
    assert.strictEqual(normalizeTmdbId("0"), null);
    assert.strictEqual(normalizeTmdbId(0), null);
    assert.strictEqual(normalizeTmdbId("tt1234567"), null);
    assert.strictEqual(normalizeTmdbId("../1"), null);
    assert.strictEqual(normalizeTmdbId("1e5"), null);
    assert.strictEqual(normalizeTmdbId(""), null);
}

function testConfigValidation() {
    assert.deepStrictEqual(
        validateConfig({ provider: "direct", m3uUrl: "https://example.com/list.m3u", epgUrls: ["https://one.example/epg.xml", "https://two.example/epg.xml"] }),
        { provider: "direct", m3uUrl: "https://example.com/list.m3u", epgUrls: ["https://one.example/epg.xml", "https://two.example/epg.xml"] }
    );
    assert.throws(() => validateConfig({ provider: "direct", m3uUrl: "file:///etc/passwd" }), /Invalid m3uUrl/);
    assert.throws(() => validateConfig({ provider: "other", m3uUrl: "https://example.com/list.m3u" }), /Unsupported provider/);
    assert.throws(() => validateConfig({ provider: "xtream", xtreamUrl: "https://panel.example/?x=1", xtreamUsername: "u", xtreamPassword: "p" }), /base URL/);
    assert.throws(() => validateConfig({ provider: "direct", m3uUrl: "https://example.com/list.m3u", epgUrls: Array(21).fill("https://example.com/epg.xml") }), /at most 20/);
}

async function testSafeFetchRejectsPrivateAddresses() {
    await assert.rejects(() => safeFetch("http://127.0.0.1/"), /Blocked host/);
    await assert.rejects(() => safeFetch("file:///etc/passwd"), /Invalid URL|Only HTTP/);
}

function testLruEvictionAndPromotion() {
    const cache = new LRUCache({ max: 2, ttl: 0 });
    cache.set("a", 1);
    cache.set("b", 2);
    assert.strictEqual(cache.get("a"), 1); // promote a above b
    cache.set("c", 3);

    assert.strictEqual(cache.get("a"), 1);
    assert.strictEqual(cache.get("b"), undefined);
    assert.strictEqual(cache.get("c"), 3);
    assert.deepStrictEqual(cache.entries().sort(), [["a", 1], ["c", 3]]);
}

function testLruExpiry() {
    const cache = new LRUCache({ max: 2, ttl: 60000 });
    cache.set("temporary", "value");
    const entry = cache.map.get("temporary");
    entry.expires = Date.now() - 1;

    assert.strictEqual(cache.get("temporary"), undefined);
    assert.strictEqual(cache.has("temporary"), false);
}

function testLruInvalidSettingsFallback() {
    const cache = new LRUCache({ max: -1, ttl: -100 });
    assert.strictEqual(cache.max, 100);
    assert.strictEqual(cache.ttl, 6 * 3600 * 1000);
}

function testPublicAndPrivateAddressClassification() {
    assert.strictEqual(isPublicAddress("8.8.8.8"), true);
    assert.strictEqual(isPublicAddress("10.0.0.1"), false);
    assert.strictEqual(isPublicAddress("127.0.0.1"), false);
    assert.strictEqual(isPublicAddress("169.254.169.254"), false);
    assert.strictEqual(isPublicAddress("::1"), false);
    assert.strictEqual(isPublicAddress("fc00::1"), false);
    assert.strictEqual(isPublicAddress("fe80::1"), false);
    assert.strictEqual(isPublicAddress("::ffff:127.0.0.1"), false);
    assert.strictEqual(isPublicAddress("::ffff:8.8.8.8"), true);
    assert.strictEqual(isPublicAddress("224.0.0.1"), false);
    assert.strictEqual(isPublicAddress("2001:db8::1"), false);
    assert.strictEqual(isPublicAddress("3fff::1"), false);
    assert.strictEqual(isPublicAddress("2001:4860:4860::8888"), true);
}

function testValidatedConnectionReuseIsScopedToValidatedAddresses() {
    const url = new URL("https://tmdb.example.test/");
    const firstAddresses = [{ address: "8.8.8.8", family: 4 }];
    const changedAddresses = [{ address: "1.1.1.1", family: 4 }];
    const firstAgent = getPinnedAgent(url, firstAddresses, true);
    const reusedAgent = getPinnedAgent(url, firstAddresses, true);
    const changedAgent = getPinnedAgent(url, changedAddresses, true);
    const oneShotAgent = getPinnedAgent(url, firstAddresses, false);

    try {
        assert.strictEqual(firstAgent, reusedAgent, "same origin and validated DNS answers should reuse an agent");
        assert.notStrictEqual(firstAgent, changedAgent, "changed validated DNS answers must not reuse the old pinned agent");
        assert.strictEqual(firstAgent.options.keepAlive, true, "opt-in agents should enable keep-alive");
        assert.strictEqual(oneShotAgent.options.keepAlive, false,
            "requests without opt-in should retain one-shot agent behavior");
    } finally {
        firstAgent.destroy();
        changedAgent.destroy();
        oneShotAgent.destroy();
    }
}

async function testPrivateDestinationsAreRejected() {
    await assert.rejects(
        () => resolvePublicAddresses(new URL("http://127.0.0.1/")),
        /Blocked host/
    );
    await assert.rejects(
        () => resolvePublicAddresses(new URL("http://localhost/")),
        /Blocked host/
    );
    const withCredentials = await resolvePublicAddresses(
        new URL("http://user:pass@8.8.8.8/")
    );
    assert.strictEqual(withCredentials[0].address, "8.8.8.8");
}

function testScheduledProgramsCacheParsedTimestamps() {
    const addon = new M3UEPGAddon({ provider: "direct", epgOffsetHours: 0 });
    const channel = {
        id: "iptv_test_channel",
        type: "tv",
        attributes: { "tvg-id": "test.channel" }
    };
    const programme = {
        start: "20261018120000 +0000",
        stop: "20261018130000 +0000",
        title: "Test programme"
    };
    addon.epgData = { "test.channel": [programme] };
    let parseCalls = 0;
    const originalParse = addon.parseEPGTime.bind(addon);
    addon.parseEPGTime = (value) => {
        parseCalls++;
        return originalParse(value);
    };

    const first = addon.getScheduledPrograms(channel, Date.parse("2026-10-18T11:00:00Z"), Date.parse("2026-10-18T14:00:00Z"));
    const second = addon.getScheduledPrograms(channel, Date.parse("2026-10-18T11:00:00Z"), Date.parse("2026-10-18T14:00:00Z"));
    assert.strictEqual(first.length, 1);
    assert.deepStrictEqual(second, first);
    assert.strictEqual(parseCalls, 2, "start and stop timestamps should only be parsed once per programme");
}


function testScheduledProgramsIndexReturnsOnlyOverlappingPrograms() {
    const addon = new M3UEPGAddon({ provider: "direct", epgOffsetHours: 0 });
    const channel = {
        id: "iptv_test_channel",
        type: "tv",
        attributes: { "tvg-id": "test.indexed.channel" }
    };
    addon.epgData = {
        "test.indexed.channel": [
            { start: "20261018000000 +0000", stop: "20261018123000 +0000", title: "Long overnight programme" },
            { start: "20261018100000 +0000", stop: "20261018110000 +0000", title: "Earlier programme" },
            { start: "20261018120000 +0000", stop: "20261018130000 +0000", title: "Noon programme" },
            { start: "20261018130000 +0000", stop: "20261018140000 +0000", title: "Afternoon programme" },
            { start: "20261018150000 +0000", stop: "20261018160000 +0000", title: "Later programme" }
        ]
    };

    const start = Date.parse("2026-10-18T12:00:00Z");
    const end = Date.parse("2026-10-18T14:00:00Z");
    const first = addon.getScheduledPrograms(channel, start, end);
    assert.deepStrictEqual(first.map(program => program.title), [
        "Long overnight programme", "Noon programme", "Afternoon programme"
    ], "include long programmes overlapping the window and exclude programmes ending at its start");

    const second = addon.getScheduledPrograms(channel, start, end);
    assert.deepStrictEqual(second, first, "repeated guide requests should reuse the indexed programme window");

    const nextDay = addon.getScheduledPrograms(
        channel,
        Date.parse("2026-10-19T00:00:00Z"),
        Date.parse("2026-10-19T02:00:00Z")
    );
    assert.deepStrictEqual(nextDay, [], "a guide window with no overlapping programmes should be empty");
}


async function testPersistentAddonDataCacheRoundTripAndLastGoodSnapshot() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "iptv-persistent-data-"));
    const data = {
        channels: [{ id: "channel-1", name: "Live channel", url: "https://example.com/live.m3u8" }],
        movies: [{ id: "movie-1", name: "Film", url: "https://example.com/movie.mp4" }],
        series: [{ id: "series-1", name: "Series" }],
        epgData: { "channel.one": [{ start: "20261023120000 +0000", stop: "20261023130000 +0000", title: "News", desc: "Description" }] },
        lastUpdate: Date.now()
    };
    try {
        const cache = new PersistentAddonDataCache("test-provider", { directory });
        assert.strictEqual(await cache.load(), null, "missing persistent data should be a cache miss");
        assert.strictEqual(await cache.save(data), true);
        const reloaded = await new PersistentAddonDataCache("test-provider", { directory }).load();
        assert.deepStrictEqual(reloaded, data, "catalogue, series, and EPG should survive a new cache instance");
        await assert.rejects(
            () => cache.save({ channels: [], movies: [], series: [], epgData: {}, lastUpdate: NaN }),
            /incomplete provider data snapshot/
        );
        const stillSaved = await cache.load();
        assert.deepStrictEqual(stillSaved, data, "invalid refresh data must not overwrite the last-good snapshot");
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}

async function testPersistentCatalogMetadataCacheRoundTripAndStaleFallback() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "iptv-catalog-cache-"));
    try {
        const first = new PersistentCatalogMetaCache("test-config", {
            directory, ttlMs: 60000, staleRetentionMs: 120000, maxEntries: 10
        });
        const metadata = { id: "movie-1", name: "Cached movie", cast: ["Actor"] };
        await first.set("movie-1", metadata);
        await first.flush();
        first.journal.forceCompact = true;
        await first.flush();

        const reopened = new PersistentCatalogMetaCache("test-config", {
            directory, ttlMs: 60000, staleRetentionMs: 120000, maxEntries: 10
        });
        const loaded = await reopened.get("movie-1");
        assert.deepStrictEqual(loaded.value, metadata);
        assert.strictEqual(loaded.fresh, true);

        const cacheFile = first.filePath;
        const stored = JSON.parse(await fs.readFile(cacheFile, "utf8"));
        stored.entries["movie-1"].savedAt = Date.now() - 2000;
        await fs.writeFile(cacheFile, JSON.stringify(stored), "utf8");
        const shortTtl = new PersistentCatalogMetaCache("test-config", {
            directory, ttlMs: 1000, staleRetentionMs: 120000, maxEntries: 10
        });
        const stale = await shortTtl.get("movie-1");
        assert.deepStrictEqual(stale.value, metadata);
        assert.strictEqual(stale.fresh, false, "expired metadata should remain available as a refresh fallback");
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}

async function testPersistentCatalogMetadataCacheRetainsDirtyStateAfterWriteFailure() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "iptv-catalog-cache-write-failure-"));
    const blockedDirectory = path.join(root, "not-a-directory");
    await fs.writeFile(blockedDirectory, "block directory creation");
    let cache;
    try {
        cache = new PersistentCatalogMetaCache("test-config", {
            directory: blockedDirectory, ttlMs: 60000, staleRetentionMs: 120000, maxEntries: 10
        });
        await cache.set("movie-1", { id: "movie-1", name: "Cached movie" });
        if (cache.writeTimer) {
            clearTimeout(cache.writeTimer);
            cache.writeTimer = null;
        }

        await assert.rejects(() => cache.flush(), /EEXIST|ENOTDIR/);
        assert.strictEqual(cache.dirty, true,
            "a failed disk write must leave the cache dirty so a later flush can retry");
        assert.strictEqual(cache.writeRetryDelayMs, 2000,
            "the first failed write should increase the next retry delay");
        assert.ok(cache.writeTimer,
            "a failed write should schedule a delayed retry rather than dropping the update");

        // Avoid leaving the deliberately failing retry timer alive in this test.
        if (cache.writeTimer) {
            clearTimeout(cache.writeTimer);
            cache.writeTimer = null;
        }
    } finally {
        if (cache?.writeTimer) clearTimeout(cache.writeTimer);
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function testConcurrentCatalogMetadataLookupsAreDeduplicated() {
    const addon = new M3UEPGAddon({ provider: "direct" });
    addon.movies = [{ id: "movie-shared", name: "Shared movie", type: "movie" }];
    let calls = 0;
    addon._getCatalogMetaAsync = async (id, type) => {
        calls++;
        await new Promise(resolve => setImmediate(resolve));
        return { id, type, name: "Shared metadata" };
    };

    const results = await Promise.all([
        addon.getCatalogMetaAsync("movie-shared", "movie"),
        addon.getCatalogMetaAsync("movie-shared", "movie"),
        addon.getCatalogMetaAsync("movie-shared", "movie")
    ]);

    assert.strictEqual(calls, 1, "concurrent requests for one item should share a single metadata lookup");
    assert.deepStrictEqual(results[0], results[1]);
    assert.deepStrictEqual(results[1], results[2]);
    assert.strictEqual(addon.catalogMetaInFlight.size, 0, "in-flight entries should be cleared after completion");
}

async function testCatalogMetadataQueueDrainsWithoutLosingItems() {
    const addon = new M3UEPGAddon({ provider: "direct" });
    const count = 75;
    let active = 0;
    let maxActive = 0;
    const processed = [];
    addon.getCatalogMetaAsync = async (id) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        processed.push(id);
        active--;
        return { id, type: "movie", name: id };
    };

    for (let i = 0; i < count; i++) {
        addon.queueCatalogMetaEnrichment({ id: "movie-" + i, type: "movie", name: "Movie " + i });
    }

    const drainDeadline = Date.now() + 5000;
    while (addon.catalogMetaWorkers > 0 || addon.catalogMetaQueueHead < addon.catalogMetaQueue.length) {
        assert.ok(Date.now() < drainDeadline, "metadata enrichment queue should drain within five seconds");
        await new Promise(resolve => setImmediate(resolve));
    }

    assert.strictEqual(processed.length, count);
    assert.strictEqual(new Set(processed).size, count);
    assert.ok(maxActive <= 3, "metadata enrichment concurrency should remain capped at three");
    assert.deepStrictEqual(addon.catalogMetaQueue, []);
    assert.strictEqual(addon.catalogMetaQueueHead, 0);
}

async function testCataloguePrefetchRechecksChangedCatalogueBeforeDailyInterval() {
    const addon = new M3UEPGAddon({ provider: "direct" });
    addon.movies = [{ id: "movie-1", type: "movie", name: "Movie 1" }];
    addon.persistentCatalogMetaCache = {
        get: async () => null,
        set: async () => {},
        flush: async () => {},
    };
    const crypto = require("crypto");
    const fingerprint = items => crypto.createHash("sha256")
        .update(items.map(item => String(item?.id || "")).join("\n"))
        .digest("hex");
    addon.catalogPrefetchLastCompleted.set("movie", Date.now());
    addon.catalogPrefetchLastFingerprint.set("movie", fingerprint(addon.movies));

    let enriched = [];
    addon.enrichCatalogMetaItems = async batch => {
        enriched.push(...batch.map(item => item.id));
        for (const item of batch) {
            addon.cacheCatalogMetaPreview(item.id, { name: item.name, type: item.type, description: "Cached preview", metadataVersion: 3, metadataCheckedAt: Date.now(), missingMetadataCheckedAt: Date.now() });
        }
    };

    // An unchanged catalogue should respect the daily completion shortcut.
    addon.startContinuousCatalogPrefetch("movie", 10, 1);
    assert.strictEqual(addon.catalogPrefetchJobs.has("movie"), false);

    // A changed catalogue must bypass that shortcut and warm the newly added item.
    addon.movies.push({ id: "movie-2", type: "movie", name: "Movie 2" });
    addon.startContinuousCatalogPrefetch("movie", 10, 1);
    const job = addon.catalogPrefetchJobs.get("movie");
    assert.ok(job, "a changed catalogue should start a new warm-up");
    await job;
    assert.deepStrictEqual(enriched, ["movie-1", "movie-2"]);
    assert.strictEqual(addon.catalogPrefetchLastFingerprint.get("movie"), fingerprint(addon.movies));
}

async function testCataloguePrefetchSkipsWarmCatalogueAfterRestart() {
    const addon = new M3UEPGAddon({ provider: "direct" });
    addon.movies = [{ id: "movie-1", type: "movie", name: "Movie 1" }];
    const crypto = require("crypto");
    const fingerprint = crypto.createHash("sha256")
        .update(addon.movies.map(item => String(item?.id || "")).join("\n"))
        .digest("hex");
    const completedAt = Date.now();
    let enrichmentCalls = 0;
    addon.persistentCatalogMetaCache = {
        get: async key => key === "__catalog_prefetch_status__:movie"
            ? { value: { completedAt, catalogueFingerprint: fingerprint, version: 4 }, fresh: true }
            : key === "movie-1"
                ? { value: {
                    name: "Movie 1",
                    type: "movie",
                    description: "Cached preview",
                    poster: "https://example.com/poster.jpg",
                    background: "https://example.com/background.jpg",
                    genres: ["Drama"],
                    year: 2020,
                    runtime: "120 min",
                    tmdbRating: "7.2",
                    imdbRating: "7.5",
                    cast: ["Actor One"],
                    director: "Director One",
                    metadataVersion: 3,
                    metadataCheckedAt: Date.now(),
                    _tmdbId: null,
                    imdbId: "tt1234567",
                    imdbIdChecked: true,
                    omdbChecked: true,
                    omdbCheckedAt: Date.now()
                }, savedAt: Date.now(), fresh: true }
                : null,
        set: async () => {},
        flush: async () => {},
    };
    addon.enrichCatalogMetaItems = async () => { enrichmentCalls++; };

    addon.startContinuousCatalogPrefetch("movie", 10, 1);
    const job = addon.catalogPrefetchJobs.get("movie");
    assert.ok(job, "startup should check the persisted completion marker");
    await job;
    assert.strictEqual(enrichmentCalls, 0,
        "a matching recent persistent marker should avoid repeating the full warm-up after restart");
    assert.strictEqual(addon.catalogPrefetchLastFingerprint.get("movie"), fingerprint);
    assert.strictEqual(addon.catalogPrefetchLastCompleted.get("movie"), completedAt);
}

async function testCataloguePrefetchBacksOffAfterIncompleteWarmup() {
    const addon = new M3UEPGAddon({ provider: "direct" });
    addon.movies = [{ id: "movie-1", type: "movie", name: "Movie 1" }];
    let enrichmentCalls = 0;
    addon.enrichCatalogMetaItems = async () => {
        enrichmentCalls++;
        // Simulate a failed metadata lookup: no usable preview is cached.
    };

    addon.startContinuousCatalogPrefetch("movie", 10, 1);
    const firstJob = addon.catalogPrefetchJobs.get("movie");
    assert.ok(firstJob, "the first warm-up should start");
    await firstJob;
    assert.ok(
        addon.catalogPrefetchRetryAfter.get("movie") > Date.now(),
        "an incomplete warm-up should schedule a retry backoff"
    );

    addon.startContinuousCatalogPrefetch("movie", 10, 1);
    assert.strictEqual(
        enrichmentCalls, 1,
        "repeated catalogue requests should not immediately restart a failed full-catalogue scan"
    );
}

async function testConcurrentSeriesInfoLookupsAreDeduplicated() {
    const addon = new M3UEPGAddon({ provider: "direct" });
    addon.series = [{ id: "iptv_series_series-1", series_id: "series-1", name: "Series 1", type: "series" }];
    let calls = 0;
    const originalFetchSeriesInfo = require("./src/js/providers/directProvider").fetchSeriesInfo;
    const providerModule = require("./src/js/providers/directProvider");
    providerModule.fetchSeriesInfo = async (_addon, seriesId) => {
        calls++;
        await new Promise(resolve => setImmediate(resolve));
        return { tmdbId: "65251", videos: [{ id: "ep-1" }], seriesId };
    };

    try {
        const results = await Promise.all([
            addon.ensureSeriesInfo("series-1"),
            addon.ensureSeriesInfo("series-1"),
            addon.ensureSeriesInfo("series-1")
        ]);
        assert.strictEqual(calls, 1, "concurrent requests for one series should share provider lookup");
        assert.deepStrictEqual(results[0], results[1]);
        assert.deepStrictEqual(results[1], results[2]);
        assert.strictEqual(addon.providerInfoInFlight.size, 0);
    } finally {
        providerModule.fetchSeriesInfo = originalFetchSeriesInfo;
    }
}

async function testMovieTmdbMissIsCached() {
    const addon = new M3UEPGAddon({ provider: "xtream" });
    addon.seriesInfoCache = new LRUCache({ max: 100, ttl: 60000 });
    let calls = 0;
    const providerModule = {
        fetchMovieInfo: async () => {
            calls++;
            await new Promise(resolve => setImmediate(resolve));
            return { tmdbId: null };
        }
    };
    const item = { id: "iptv_vod_123", name: "Test movie", type: "movie" };
    addon.movies = [item];
    const results = await Promise.all([
        addon.resolveMovieTmdbId(item.id, item, providerModule),
        addon.resolveMovieTmdbId(item.id, item, providerModule),
        addon.resolveMovieTmdbId(item.id, item, providerModule)
    ]);
    assert.deepStrictEqual(results, [null, null, null]);
    assert.strictEqual(calls, 1, "concurrent lookups should share one Xtream request");
    await addon.resolveMovieTmdbId(item.id, item, providerModule);
    assert.strictEqual(calls, 1, "negative cache should prevent repeated requests on subsequent visits");
    assert.strictEqual(addon.providerInfoInFlight.size, 0);
}

async function testStreamingEpgParser() {
    const xml = [
        '<?xml version="1.0"?>',
        '<tv>',
        '<programme start="20261018120000 +0000" stop="20261018130000 +0000" channel="channel.one">',
        '<title lang="en">News &amp; Weather</title><desc>First <![CDATA[and second]]> part.</desc>',
        '</programme>',
        '<programme start="20261018130000 +0000" stop="20261018140000 +0000" channel="unused.channel">',
        '<title>Should not be retained</title></programme>',
        '</tv>'
    ].join('');
    const parsed = await parseEPGStream(Readable.from([xml.slice(0, 37), xml.slice(37, 112), xml.slice(112)]), new Set(['channel.one']));
    assert.deepStrictEqual(Object.keys(parsed), ['channel.one']);
    assert.strictEqual(parsed['channel.one'].length, 1);
    assert.strictEqual(parsed['channel.one'][0].title, 'News & Weather');
    assert.strictEqual(parsed['channel.one'][0].desc, 'First and second part.');
}

async function testStreamingEpgParserBoundsRetainedText() {
    const longTitle = "T".repeat(MAX_TITLE_CHARS + 500);
    const longDescription = "D".repeat(MAX_DESCRIPTION_CHARS + 5000);
    const xml = '<tv><programme start="20261018120000 +0000" stop="20261018130000 +0000" channel="channel.one">' +
        '<title>' + longTitle + '</title><desc>' + longDescription + '</desc></programme></tv>';
    const parsed = await parseEPGStream(Readable.from([xml]), new Set(["channel.one"]));
    assert.strictEqual(parsed["channel.one"][0].title.length, MAX_TITLE_CHARS);
    assert.strictEqual(parsed["channel.one"][0].desc.length, MAX_DESCRIPTION_CHARS);
    assert.strictEqual(parsed["channel.one"][0].title, "T".repeat(MAX_TITLE_CHARS));
    assert.strictEqual(parsed["channel.one"][0].desc, "D".repeat(MAX_DESCRIPTION_CHARS));
}

async function testStreamingEpgParserHonorsSharedAggregateBudget() {
    const budget = { programmes: MAX_PROGRAMMES_TOTAL - 1, textChars: 0 };
    const xml = '<tv>' +
        '<programme start="20261018120000 +0000" stop="20261018130000 +0000" channel="one"><title>One</title></programme>' +
        '<programme start="20261018130000 +0000" stop="20261018140000 +0000" channel="two"><title>Two</title></programme>' +
        '</tv>';
    const parsed = await parseEPGStream(Readable.from([xml]), null, budget);
    assert.strictEqual(budget.programmes, MAX_PROGRAMMES_TOTAL);
    assert.strictEqual(Object.values(parsed).reduce((sum, items) => sum + items.length, 0), 1);
}

function testCatalogMissingMetadataUsesTwelveHourRetryWindow() {
    const now = Date.now();
    const complete = {
        type: "movie",
        poster: "poster.jpg",
        background: "background.jpg",
        description: "A description",
        genres: ["Drama"],
        year: 2020,
        runtime: "120 min",
        tmdbRating: "7.2",
        imdbRating: "7.5",
        cast: ["Actor One"],
        director: "Director One",
        metadataCheckedAt: now
    };
    assert.strictEqual(catalogMetadataNeedsRefresh(complete), false,
        "complete metadata should not use the missing-data retry path");
    assert.strictEqual(catalogMetadataNeedsRefresh({
        ...complete, description: undefined, metadataCheckedAt: now
    }), false, "recently checked missing fields should respect the retry window");
    assert.strictEqual(catalogMetadataNeedsRefresh({
        ...complete, description: undefined, metadataCheckedAt: now - 12 * 60 * 60 * 1000 - 1000
    }), true, "missing description should retry after twelve hours");
    assert.strictEqual(catalogMetadataNeedsRefresh({
        ...complete, poster: undefined, metadataCheckedAt: now - 13 * 60 * 60 * 1000
    }), true, "missing poster should retry after twelve hours");
    assert.strictEqual(catalogMetadataNeedsRefresh({
        ...complete, background: undefined, metadataCheckedAt: now - 13 * 60 * 60 * 1000
    }), true, "missing backdrop should retry after twelve hours");
    assert.strictEqual(catalogMetadataNeedsRefresh({
        ...complete, runtime: undefined, metadataCheckedAt: now - 13 * 60 * 60 * 1000
    }), true, "missing runtime should retry after twelve hours");
    assert.strictEqual(catalogMetadataNeedsRefresh({
        ...complete, type: "series", director: undefined, metadataCheckedAt: now - 13 * 60 * 60 * 1000
    }), false, "series should not be considered incomplete solely for lacking a movie director");

    assert.strictEqual(catalogMetadataNeedsRefresh({
        ...complete,
        description: undefined,
        metadataCheckedAt: now - 20 * 24 * 60 * 60 * 1000,
        missingMetadataCheckedAt: now
    }), false, "a recent missing-field attempt must throttle retries independently of the normal refresh age");

    assert.strictEqual(catalogMetadataNeedsRefresh({
        ...complete,
        runtime: undefined,
        metadataCheckedAt: now,
        missingMetadataCheckedAt: now - 12 * 60 * 60 * 1000 - 1000
    }), true, "a missing field must retry after twelve hours even if normal metadata was refreshed recently");
}

function testOmdbMissingRatingOrRuntimeUsesTwelveHourRetryWindow() {
    const now = Date.now();
    const recentMissingRating = {
        imdbId: "tt1234567",
        runtime: "120 min",
        omdbChecked: true,
        omdbCheckedAt: now
    };
    assert.strictEqual(omdbMetadataNeedsRefresh(recentMissingRating), false,
        "a recently checked missing rating should respect the retry window");
    assert.strictEqual(omdbMetadataNeedsRefresh({
        ...recentMissingRating,
        omdbCheckedAt: now - 12 * 60 * 60 * 1000 - 1000
    }), true, "a missing rating should become refreshable after twelve hours");
    assert.strictEqual(omdbMetadataNeedsRefresh({
        imdbId: "tt1234567",
        imdbRating: "7.8",
        runtime: "120 min",
        omdbCheckedAt: now - 30 * 24 * 60 * 60 * 1000
    }), false, "complete OMDb rating and runtime should not be retried by the missing-data path");
    assert.strictEqual(omdbMetadataNeedsRefresh({
        imdbId: "tt1234567",
        imdbRating: "7.8",
        omdbCheckedAt: now - 13 * 60 * 60 * 1000
    }), true, "a missing runtime should also trigger a retry after twelve hours");
    assert.strictEqual(omdbMetadataNeedsRefresh({
        imdbId: "tt1234567",
        imdbRating: "7.8",
        omdbCheckedAt: now - 24 * 60 * 60 * 1000,
        missingMetadataCheckedAt: now
    }), false, "a recent shared metadata attempt must throttle an old OMDb timestamp");
    assert.strictEqual(omdbMetadataNeedsRefresh({
        name: "No IMDb ID"
    }), false, "items without an IMDb ID cannot be looked up by OMDb");
}

async function main() {
    const tests = [
        testEncryptedConfigRoundTrip,
        testTamperedConfigIsRejected,
        testMalformedTokensAreRejected,
        testLegacyTokensRequireExplicitOptIn,
        testConfigValidation,
        testXtreamTmdbIdNormalization,
        testSearchNormalisationIgnoresPunctuationAndExtraWhitespace,
        testSearchSupportsReorderedWordsAndPartialTyping,
        testNormalizedSearchMatcherAgreesWithPublicMatcher,
        testSearchRejectsTypoOnlyMatches,
        testCatalogueQueryResultCacheIsBoundedAndPreservesPagination,
        testBuildGenresNormalizesNumericXtreamCategories,
        testFailedGenreBuildDoesNotPersistProviderRefresh,
        // Keep search, cache, and prefetch regression checks ahead of metadata mapping checks.
        testScheduledProgramsCacheParsedTimestamps,
        testScheduledProgramsIndexReturnsOnlyOverlappingPrograms,
        testDirectEpisodeLookupUsesExactIndex,
        testPersistentCatalogMetadataCacheRoundTripAndStaleFallback,
        testPersistentCatalogMetadataCacheRetainsDirtyStateAfterWriteFailure,
        testPersistentAddonDataCacheRoundTripAndLastGoodSnapshot,
        testConcurrentCatalogMetadataLookupsAreDeduplicated,
        testCatalogMetadataQueueDrainsWithoutLosingItems,
        testCataloguePrefetchRechecksChangedCatalogueBeforeDailyInterval,
        testCataloguePrefetchSkipsWarmCatalogueAfterRestart,
        testCataloguePrefetchBacksOffAfterIncompleteWarmup,
        testOmdbMissingRatingOrRuntimeUsesTwelveHourRetryWindow,
        testCatalogMissingMetadataUsesTwelveHourRetryWindow,
        testConcurrentSeriesInfoLookupsAreDeduplicated,
        testMovieTmdbMissIsCached,
        testMovieMetadataMapping,
        testSeriesMetadataMapping,
        testEpisodeMetadataMapping,
        testTmdbIdValidationAndMissingKeyGracefulHandling,
        testStreamingEpgParser,
        testStreamingEpgParserBoundsRetainedText,
        testStreamingEpgParserHonorsSharedAggregateBudget,
        testGenreMatchingIgnoresCaseAndWhitespace,
        testSafeFetchRejectsPrivateAddresses,
        testValidatedConnectionReuseIsScopedToValidatedAddresses,
        testLruEvictionAndPromotion,
        testLruExpiry,
        testLruInvalidSettingsFallback,
        testPublicAndPrivateAddressClassification,
        testPrivateDestinationsAreRejected,
        ...require("./tests/providerRefresh.test"),
        ...require("./tests/manifestRefresh.test"),
        ...require("./tests/metadataRefresh.test"),
        ...require("./tests/seriesRuntime.test"),
    ];

    for (const test of tests) {
        await test();
        console.log("PASS", test.name);
    }

    console.log("All " + tests.length + " tests passed.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
