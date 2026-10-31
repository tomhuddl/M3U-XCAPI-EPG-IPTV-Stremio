// direct-config.js (client pre-flight with CORS fallback via server /api/prefetch)
// Updated: If EPG fetch (browser + server) fails, continue WITHOUT EPG instead of aborting.
(function () {
    const form = document.getElementById('directForm');
    if (!form) {
        console.error('[DIRECT-CONFIG] #directForm not found');
        return;
    }

    const m3uInput       = document.getElementById('m3uUrl');
    const epgInput       = document.getElementById('epgUrl');
    const epgUrlsInput   = document.getElementById('epgUrls');
    const enableEpgChk   = document.getElementById('enableEpg');
    const epgOffsetInput = document.getElementById('epgOffsetHours');
    const debugChk       = document.getElementById('debugMode');

    const {
        showOverlay,
        hideOverlay,
        startPolling,
        buildUrls,
        setProgress,
        overlaySetMessage,
        appendDetail,
        prefillIfReconfigure,
        robustFetch,
        checkEpgStats, getGeneration, isCurrent
    } = window.ConfigureCommon || {};

    if (!window.ConfigureCommon) {
        console.error('[DIRECT-CONFIG] ConfigureCommon not loaded.');
        return;
    }

    const prefillReady = typeof prefillIfReconfigure === 'function' ? prefillIfReconfigure() : Promise.resolve();

    function validateUrl(u) {
        try {
            const x = new URL(u);
            return x.protocol === 'http:' || x.protocol === 'https:';
        } catch {
            return false;
        }
    }

    const parseM3U = window.M3UParser.parseM3U;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        await prefillReady;

        const m3uUrl = m3uInput.value.trim();
        const enableEpgInitial = enableEpgChk.checked;
        const epgUrl = epgInput.value.trim();
        const epgUrls = epgUrlsInput ? [...new Set(epgUrlsInput.value.split(/\r?\n/).map(u => u.trim()).filter(Boolean))] : [];
        if (epgUrls.length > 20) {
            alert('Please enter no more than 20 additional EPG URLs.');
            return;
        }
        const epgOffsetHours = epgOffsetInput.value ? parseFloat(epgOffsetInput.value) : 0;
        const debug = !!(debugChk && debugChk.checked);

        if (!validateUrl(m3uUrl)) {
            alert('Invalid M3U URL');
            return;
        }
        if (enableEpgInitial && epgUrl && !validateUrl(epgUrl)) {
            alert('Invalid EPG URL');
            return;
        }
        if (enableEpgInitial && epgUrls.some(url => !validateUrl(url))) {
            alert('One or more additional EPG URLs are invalid. Use HTTP(S) URLs, one per line.');
            return;
        }

        showOverlay(true);
        const generation = getGeneration();
        overlaySetMessage('Pre-flight: Validating inputs…');
        setProgress(4, 'Starting');
        appendDetail('== PRE-FLIGHT CHECKS ==');
        appendDetail('M3U URL supplied (hidden for privacy).');
        if (enableEpgInitial && epgUrl) appendDetail('EPG URL supplied (hidden for privacy).');
        appendDetail(`Debug logging: ${debug ? 'enabled' : 'disabled'}`);

        let enableEpgFinal = enableEpgInitial;
        try {
            // 1. Fetch Playlist
            setProgress(10, 'Fetching Playlist');
            const playlistText = await robustFetch(m3uUrl, 'playlist');
            if (!isCurrent(generation)) return;

            // 2. Parse M3U
            setProgress(28, 'Parsing Playlist');
            const items = parseM3U(playlistText);
            if (!items.length) throw new Error('Empty playlist after parse');

            // Stats
            const approxMovies = items.filter(i =>
                i.type === "movie"
            ).length;
            const approxTv = items.length - approxMovies;
            appendDetail(`Heuristic: ~${approxTv} TV / ~${approxMovies} Movie`);

            // 3. Optional EPG feeds (each source fails independently)
            const epgSources = [...new Set([...(epgUrl ? [epgUrl] : []), ...epgUrls])];
            if (enableEpgInitial && epgSources.length) {
                for (let index = 0; index < epgSources.length; index++) {
                    const sourceUrl = epgSources[index];
                    try {
                        await checkEpgStats(sourceUrl, index + 1);
                        if (!isCurrent(generation)) return;
                    } catch {
                        if (!isCurrent(generation)) return;
                        appendDetail('⚠ EPG source ' + (index + 1) + ' failed; continuing with other sources.');
                    }
                }
                // Retain selected sources so transient failures can recover on refresh.
            } else if (enableEpgInitial) {
                appendDetail('No EPG URL supplied; continuing without EPG.');
                enableEpgFinal = false;
            } else {
                appendDetail('EPG disabled by user.');
            }

            // 4. Build config token
            setProgress(60, 'Building token');
            const config = {
                provider: 'direct',
                m3uUrl,
                enableEpg: enableEpgFinal,
                debug: debug || undefined
            };
            if (enableEpgFinal && epgSources.length) {
                config.epgUrl = epgSources[0];
                config.epgUrls = epgSources.slice(1);
            }
            if (isFinite(epgOffsetHours) && epgOffsetHours !== 0) config.epgOffsetHours = epgOffsetHours;

            const { manifestUrl, stremioUrl } = await buildUrls(config);
            appendDetail('✔ Token built');
            appendDetail('Secure manifest and Stremio links created (links hidden for privacy).');

            // 5. Start manifest polling
            setProgress(70, 'Waiting for manifest');
            appendDetail('== SERVER BUILD PHASE ==');
            appendDetail('Polling server…');
            startPolling(70);
        } catch (err) {
            if (!isCurrent(generation)) return;
            console.error('[DIRECT-CONFIG] Pre-flight error', err);
            overlaySetMessage('Pre-flight failed');
            appendDetail('✖ Error: ' + (err.message || err.toString()));
            setProgress(100, 'Failed');
            appendDetail('Close overlay and adjust inputs to retry.');
            const status = document.getElementById('statusDetails');
            if (status && !document.getElementById('retryCloseBtn')) {
                const btn = document.createElement('button');
                btn.id = 'retryCloseBtn';
                btn.textContent = 'Close';
                btn.className = 'btn danger';
                btn.style.marginTop = '14px';
                btn.onclick = hideOverlay;
                status.parentElement.appendChild(btn);
            }
        }
    });
})();
