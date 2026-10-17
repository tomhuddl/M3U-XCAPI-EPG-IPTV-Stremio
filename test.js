const assert = require("assert");
process.env.CONFIG_SECRET = "test-only-secret-with-more-than-32-characters";

const { encryptConfig, decryptConfig, tryParseConfigToken } = require("./cryptoConfig");
const LRUCache = require("./lruCache");
const { isPublicAddress, resolvePublicAddresses, safeFetch } = require("./urlSafety");
const { validateConfig } = require("./configValidation");
const { normalizeGenre, matchesGenre } = require("./addon");

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
    assert.strictEqual(normalizeGenre("Peacock\\u00a0"), "peacock");
    assert.strictEqual(matchesGenre("Peacock", "Peacock"), true);
    assert.strictEqual(matchesGenre("  PEACOCK  ", "Peacock"), true);
    assert.strictEqual(matchesGenre("Peacock\\u00a0", "Peacock"), true);
    assert.strictEqual(matchesGenre("USA | Peacock", "Peacock"), false);
    assert.strictEqual(matchesGenre("Peacock Plus", "Peacock"), false);
    assert.strictEqual(matchesGenre("TNT Sports", "Peacock"), false);
    assert.strictEqual(normalizeGenre("All   Channels"), "all channels");
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

async function main() {
    const tests = [
        testEncryptedConfigRoundTrip,
        testTamperedConfigIsRejected,
        testMalformedTokensAreRejected,
        testLegacyTokensRequireExplicitOptIn,
        testConfigValidation,
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
