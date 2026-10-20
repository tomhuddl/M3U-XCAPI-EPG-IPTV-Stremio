const assert = require("assert");
process.env.CONFIG_SECRET = "test-only-secret-with-more-than-32-characters";

const { encryptConfig, decryptConfig, tryParseConfigToken } = require("./cryptoConfig");
const LRUCache = require("./lruCache");
const { isPublicAddress, resolvePublicAddresses, safeFetch } = require("./urlSafety");
const { validateConfig } = require("./configValidation");
const { Readable } = require("stream");
const { parseEPGStream } = require("./src/js/epgStreamParser");
const { normalizeGenre, matchesGenre, normalizeSearchText, matchesSearchText, matchesNormalizedSearchText } = require("./addon");
const { validTmdbId, tmdbConfigured, getMovieMetadata, getSeriesMetadata, mapMovieMetadata, mapSeriesMetadata, mapSeasonEpisodes } = require("./src/js/tmdbMetadata");
const { normalizeTmdbId } = require("./src/js/providers/xtreamProvider");

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
    assert.strictEqual(normalizeSearchText("   ---   "), "");
}

function testSearchSupportsReorderedWordsAndPartialTyping() {
    assert.strictEqual(matchesSearchText("man spider", "Spider-Man: Brand New Day"), true);
    assert.strictEqual(matchesSearchText("spid man", "Spider-Man"), true);
    assert.strictEqual(matchesSearchText("brand day", "Spider-Man: Brand New Day"), true);
    assert.strictEqual(matchesSearchText("man man", "Spider-Man"), false);
}

function testNormalizedSearchMatcherPreservesSearchBehaviour() {
    const normalize = normalizeSearchText;
    const cases = [
        ["man spider", "Spider-Man: Brand New Day", true],
        ["spid man", "Spider-Man", true],
        ["spidr man", "Spider-Man", true],
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

function testSearchAllowsConservativeSingleCharacterTypos() {
    assert.strictEqual(matchesSearchText("spidr man", "Spider-Man"), true);
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
            crew: [{ id: 55, job: "Director", name: "Sample Director" }, { id: 56, job: "Director", name: "Co-Director" }, { job: "Writer", name: "Sample Writer" }],
            cast: Array.from({ length: 8 }, (_, index) => ({ id: 101 + index, name: "Actor " + (index + 1) }))
        },
        { results: [{ site: "YouTube", type: "Trailer", key: "abc123", name: "Official Trailer" }] }
    );
    assert.strictEqual(meta.name, "Spider-Man: Brand New Day");
    assert.strictEqual(meta.year, 2026);
    assert.strictEqual(meta.releaseInfo, "2026");
    assert.strictEqual(meta.runtime, "145 min");
    assert.strictEqual(meta.rating, "7.9");
    assert.deepStrictEqual(meta.genres, ["Action", "Adventure"]);
    assert.deepStrictEqual(meta.director, ["Sample Director", "Co-Director"]);
    assert.deepStrictEqual(meta.cast, ["Actor 1", "Actor 2", "Actor 3", "Actor 4", "Actor 5", "Actor 6", "Actor 7", "Actor 8"]);
    assert.deepStrictEqual(meta.links, [
        { name: "Action", category: "Genre", url: "https://www.themoviedb.org/genre/28" },
        { name: "Adventure", category: "Genre", url: "https://www.themoviedb.org/genre/12" },
        { name: "Actor 1", category: "Actor", url: "https://www.themoviedb.org/person/101" },
        { name: "Actor 2", category: "Actor", url: "https://www.themoviedb.org/person/102" },
        { name: "Actor 3", category: "Actor", url: "https://www.themoviedb.org/person/103" },
        { name: "Actor 4", category: "Actor", url: "https://www.themoviedb.org/person/104" },
        { name: "Actor 5", category: "Actor", url: "https://www.themoviedb.org/person/105" },
        { name: "Actor 6", category: "Actor", url: "https://www.themoviedb.org/person/106" },
        { name: "Actor 7", category: "Actor", url: "https://www.themoviedb.org/person/107" },
        { name: "Actor 8", category: "Actor", url: "https://www.themoviedb.org/person/108" },
        { name: "Sample Director", category: "Directors", url: "https://www.themoviedb.org/person/55" },
        { name: "Co-Director", category: "Directors", url: "https://www.themoviedb.org/person/56" }
    ]);
    assert.strictEqual(meta.poster, "https://image.tmdb.org/t/p/w500/poster.jpg");
    assert.strictEqual(meta.background, "https://image.tmdb.org/t/p/w1280/backdrop.jpg");
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
        { results: [] }
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
        { name: "Comedy", category: "Genre", url: "https://www.themoviedb.org/genre/35" },
        { name: "Series Actor", category: "Actor", url: "https://www.themoviedb.org/person/202" }
    ]);
    assert.strictEqual(meta.trailer, undefined);
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
        testNormalizedSearchMatcherPreservesSearchBehaviour,
        testSearchAllowsConservativeSingleCharacterTypos,
        testMovieMetadataMapping,
        testSeriesMetadataMapping,
        testEpisodeMetadataMapping,
        testTmdbIdValidationAndMissingKeyGracefulHandling,
        testStreamingEpgParser,
        testGenreMatchingIgnoresCaseAndWhitespace,
        testSafeFetchRejectsPrivateAddresses,
        testLruEvictionAndPromotion,
        testLruExpiry,
        testLruInvalidSettingsFallback,
        testPublicAndPrivateAddressClassification,
        testPrivateDestinationsAreRejected,
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
