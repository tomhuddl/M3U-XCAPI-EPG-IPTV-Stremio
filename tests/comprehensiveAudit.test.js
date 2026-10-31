"use strict";
const assert = require("assert"),
    path = require("path"),
    { spawnSync } = require("child_process");
const names = [
    "journal",
    "recoveryInterrupted",
    "redis",
    "shutdown",
    "queue",
    "dnsAbort",
    "playlist",
    "m3useries",
    "epg",
    "epgSpecialIds",
    "fallback",
    "fallbackException",
    "trailers",
    "trailerRetention",
    "quota",
    "polling",
    "pollrace",
    "preflight",
    "errorbody",
    "launcher"
];
module.exports = names.map((name) =>
    Object.defineProperty(
        function () {
            const run = spawnSync(
                process.execPath,
                [
                    path.join(__dirname, "fixtures/comprehensiveAuditProbe.js"),
                    name
                ],
                { encoding: "utf8", timeout: 12000, windowsHide: true }
            );
            assert.strictEqual(run.status, 0, run.stdout + run.stderr);
            assert.match(run.stdout, /AUDIT_RESULT/);
        },
        "name",
        { value: "testComprehensiveAudit_" + name }
    )
);

async function testFreshDeploymentRestoresCardsEpisodesStreamsAndGuideAcrossProcesses() {
    const fs = require("fs/promises"),
        os = require("os");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fresh-addon-"));
    try {
        for (const phase of ["write", "read"]) {
            const run = spawnSync(
                process.execPath,
                [
                    path.join(__dirname, "fixtures/freshDeploymentProbe.js"),
                    phase,
                    directory
                ],
                { encoding: "utf8", timeout: 15000, windowsHide: true }
            );
            assert.strictEqual(run.status, 0, run.stdout + run.stderr);
            assert.match(run.stdout, /FRESH_DEPLOYMENT/);
        }
    } finally {
        const resolved = path.resolve(directory),
            parent = path.resolve(os.tmpdir());
        assert(
            resolved.startsWith(parent + path.sep) &&
                path.basename(resolved).startsWith("fresh-addon-")
        );
        await fs.rm(resolved, { recursive: true, force: true });
    }
}
async function testStorageChecksConfiguredDirectoriesAndRejectsAnInvalidMountPath() {
    const fs = require("fs/promises"),
        os = require("os"),
        { checkPersistence } = require("../storageStatus");
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "storage-addon-")
    );
    try {
        assert.strictEqual(
            (await checkPersistence({ PERSISTENT_DATA_DIR: directory }))
                .directoriesChecked,
            3
        );
        const file = path.join(directory, "file");
        await fs.writeFile(file, "not a directory");
        await assert.rejects(checkPersistence({ PERSISTENT_DATA_DIR: file }));
        assert(
            !(await fs.readdir(directory)).some((name) =>
                name.startsWith(".storage-check-")
            )
        );
    } finally {
        const resolved = path.resolve(directory),
            parent = path.resolve(os.tmpdir());
        assert(
            resolved.startsWith(parent + path.sep) &&
                path.basename(resolved).startsWith("storage-addon-")
        );
        await fs.rm(resolved, { recursive: true, force: true });
    }
}
async function testSchedulerGlobalBudgetAndCancelledTicketsDoNotLeak() {
    const Scheduler = require("../requestScheduler"),
        scheduler = new Scheduler({
            globalLimit: 2,
            maxOrigins: 2,
            maxQueuedTotal: 2
        });
    const a = await scheduler.acquire("a"),
        b = await scheduler.acquire("b");
    await assert.rejects(
        scheduler.acquire("c"),
        (error) => error.code === "LOAD_CAPACITY"
    );
    const controller = new AbortController(),
        queued = scheduler.acquire("a", "foreground", {
            signal: controller.signal
        });
    controller.abort();
    await assert.rejects(queued, (error) => error.name === "AbortError");
    assert.strictEqual(scheduler.queuedTotal, 0);
    a();
    b();
    assert.strictEqual(scheduler.activeTotal, 0);
    assert.strictEqual(scheduler.origins.size, 0);
}
function testGrowingCacheEntriesReapplyTheMemoryBudget() {
    const Cache = require("../lruCache"),
        cache = new Cache({
            max: 5,
            maxWeight: 10,
            sizeOf: (item) => item.weight
        });
    const a = { weight: 3 },
        b = { weight: 3 };
    cache.set("a", a);
    cache.set("b", b);
    b.weight = 9;
    cache.set("b", b);
    assert.strictEqual(cache.has("a"), false);
    assert.strictEqual(cache.totalWeight, 9);
}
function testSetupOwnerProtectionAndDonationIsolation() {
    const access = require("../setupAccess"),
        fs = require("fs");
    const old = process.env.SETUP_PASSWORD;
    process.env.SETUP_PASSWORD = "test-password-at-least-16";
    try {
        let next = false,
            status,
            headers = {};
        const res = {
            setHeader(k, v) {
                headers[k] = v;
            },
            status(code) {
                status = code;
                return this;
            },
            json() {}
        };
        access({ path: "/encrypt", headers: {} }, res, () => (next = true));
        assert.strictEqual(status, 401);
        assert.strictEqual(next, false);
        access(
            {
                path: "/encrypt",
                headers: {
                    authorization:
                        "Basic " +
                        Buffer.from(
                            (process.env.SETUP_USERNAME || "admin") +
                                ":" +
                                process.env.SETUP_PASSWORD
                        ).toString("base64")
                }
            },
            res,
            () => (next = true)
        );
        assert(next);
        next = false;
        access(
            { path: "/enc:installed/manifest.json", headers: {} },
            res,
            () => (next = true)
        );
        assert(next);
        for (const file of [
            "src/index.html",
            "src/html/direct-config.html",
            "src/html/xtream-config.html"
        ]) {
            const html = fs.readFileSync(
                path.join(__dirname, "..", file),
                "utf8"
            );
            assert(!/<script[^>]*src="https:/i.test(html));
            assert.match(
                html,
                /sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"/
            );
        }
        assert.match(
            fs.readFileSync(
                path.join(__dirname, "../src/support.html"),
                "utf8"
            ),
            /data-slug="K3QSoR2"/
        );
    } finally {
        if (old === undefined) delete process.env.SETUP_PASSWORD;
        else process.env.SETUP_PASSWORD = old;
    }
}

function testHttpStartupSecurityAndShutdownStayBounded() {
    for (const mode of ["normal", "deadline", "invalid-storage"]) {
        const run = spawnSync(
            process.execPath,
            [path.join(__dirname, "fixtures/serverLifecycleProbe.js"), mode],
            { encoding: "utf8", timeout: 8000, windowsHide: true }
        );
        assert.strictEqual(
            run.status,
            mode === "normal" ? 0 : 1,
            run.stdout + run.stderr
        );
        const line = run.stdout
            .split(/\r?\n/)
            .find((value) => value.startsWith("LIFECYCLE_RESULT "));
        assert(line, run.stdout + run.stderr);
        const result = JSON.parse(line.slice(17));
        assert(
            result.elapsed < 2500,
            "shutdown must honor the overall deadline"
        );
        assert(
            result.flushed >= 3,
            "completed cache data must be flushed before process exit"
        );
    }
}
async function testGlobalBackgroundWorkReservesInteractiveCapacity() {
    const Scheduler = require("../requestScheduler"),
        scheduler = new Scheduler({ globalLimit: 2, globalBackgroundLimit: 1 });
    const background = await scheduler.acquire("a", "background");
    let secondStarted = false;
    const queued = scheduler.acquire("b", "background").then((release) => {
        secondStarted = true;
        return release;
    });
    const foreground = await scheduler.acquire("c", "foreground");
    assert.strictEqual(secondStarted, false);
    foreground();
    background();
    (await queued)();
    assert.strictEqual(scheduler.backgroundTotal, 0);
    assert.strictEqual(scheduler.origins.size, 0);
}

async function testPartialGuideStatusPersistsAndDoesNotCauseHourlyLimitRetries() {
    const { M3UEPGAddon } = require("../addon");
    const provider = require("../src/js/providers/directProvider");
    const fetchEpg = provider.fetchEpg;
    const originalNow = Date.now;
    let now = originalNow();
    const addon = new M3UEPGAddon({
        provider: "direct",
        m3uUrl: "https://example.com/list.m3u",
        enableEpg: true
    });
    addon.log = { info() {}, warn() {}, error() {}, debug() {} };
    addon.lastUpdate = now;
    addon.lastEpgUpdate = now - 13 * 3600000;
    const status = {
        truncated: true,
        retainedProgrammes: 1,
        omittedProgrammes: 2,
        omittedTextCharacters: 0
    };
    const programmes = [
        {
            start: "20261031010000 +0000",
            stop: "20261031020000 +0000",
            title: "Saved guide"
        }
    ];
    let snapshot;
    addon.persistProviderSnapshot = async () => {
        snapshot = structuredClone(addon.providerSnapshot());
    };
    Date.now = () => now;
    try {
        provider.fetchEpg = async (target) => {
            target.epgData = { one: programmes };
            target.epgRetentionStatus = status;
            target.epgRefreshFailed = false;
        };
        await addon._updateEpg();
        assert.deepStrictEqual(snapshot.epgRetentionStatus, status);
        assert.strictEqual(addon.isEpgRefreshDue(), false);
        const successfulAt = addon.lastEpgUpdate;
        now += 13 * 3600000;
        provider.fetchEpg = async (target) => {
            target.epgData = {};
            target.epgRetentionStatus = null;
            target.epgRefreshFailed = true;
        };
        await addon._updateEpg();
        assert.strictEqual(addon.lastEpgUpdate, successfulAt);
        assert.deepStrictEqual(addon.epgData.one, programmes);
        assert.deepStrictEqual(snapshot.epgRetentionStatus, status);
    } finally {
        provider.fetchEpg = fetchEpg;
        Date.now = originalNow;
    }
}

module.exports.push(
    testFreshDeploymentRestoresCardsEpisodesStreamsAndGuideAcrossProcesses,
    testStorageChecksConfiguredDirectoriesAndRejectsAnInvalidMountPath,
    testSchedulerGlobalBudgetAndCancelledTicketsDoNotLeak,
    testGrowingCacheEntriesReapplyTheMemoryBudget,
    testSetupOwnerProtectionAndDonationIsolation,
    testHttpStartupSecurityAndShutdownStayBounded,
    testGlobalBackgroundWorkReservesInteractiveCapacity,
    testPartialGuideStatusPersistsAndDoesNotCauseHourlyLimitRetries
);
