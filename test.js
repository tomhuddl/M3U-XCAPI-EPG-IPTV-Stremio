const assert = require("assert");
process.env.CONFIG_SECRET = "test-only-secret-with-more-than-32-characters";

const { encryptConfig, decryptConfig, tryParseConfigToken } = require("./cryptoConfig");
const LRUCache = require("./lruCache");
const { isPublicAddress, resolvePublicAddresses, safeFetch } = require("./urlSafety");
const { validateConfig } = require("./configValidation");
const { Readable } = require("stream");
const { parseEPGStream } = require("./src/js/epgStreamParser");
const { normalizeGenre, matchesGenre } = require("./addon");
const { validTmdbId, tmdbConfigured, getMovieMetadata, getSeriesMetadata } = require("./src/js/tmdbMetadata");
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
