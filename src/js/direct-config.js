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
        quickEpgStats
    } = window.ConfigureCommon || {};

    if (!window.ConfigureCommon) {
        console.error('[DIRECT-CONFIG] ConfigureCommon not loaded.');
        return;
    }

    if (typeof prefillIfReconfigure === 'function') prefillIfReconfigure('direct');

    function validateUrl(u) {
        try {
            const x = new URL(u);
            return x.protocol === 'http:' || x.protocol === 'https:';
        } catch {
            return false;
        }
    }

    function parseM3U(content) {
        const start = performance.now();
        const lines = content.split('\n');
        const items = [];
        let current = null;
        let processed = 0;
        for (const raw of lines) {
            const line = raw.trim();
            if (line.startsWith('#EXTINF:')) {
                const m = line.match(/#EXTINF:(-?\d+)(?:\s+(.*))?,(.*)/);
                if (m) {
                    current = {
                        duration: parseInt(m[1]),
                        attrs: parseAttrs(m[2] || ''),
                        name: (m[3] || '').trim()
                    };
                }
            } else if (line && !line.startsWith('#') && current) {
                current.url = line;
                items.push(current);
                current = null;
            }
            processed++;
            if (processed % 1500 === 0) {
                appendDetail(`… parsed ${processed}/${lines.length}`);
            }
        }
        const ms = (performance.now() - start).toFixed(1);
        appendDetail(`✔ Playlist parsed: ${items.length} entries (${ms} ms)`);
        return items;
    }

    function parseAttrs(str) {
        const out = {};
        const r = /(\w+(?:-\w+)*)="([^"]*)"/g;
        let m;
        while ((m = r.exec(str)) !== null) out[m[1]] = m[2];
        return out;
    }

    

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

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

            // 2. Parse M3U
            setProgress(28, 'Parsing Playlist');
            const items = parseM3U(playlistText);
            if (!items.length) throw new Error('Empty playlist after parse');

            // Stats
            const approxMovies = items.filter(i =>
                /movie/i.test(i.name) || /\(\d{4}\)/.test(i.name)
            ).length;
            const approxTv = items.length - approxMovies;
            appendDetail(`Heuristic: ~${approxTv} TV / ~${approxMovies} Movie`);

            // 3. Optional EPG feeds (each source fails independently)
            const epgSources = [...new Set([...(epgUrl ? [epgUrl] : []), ...epgUrls])];
            const validEpgSources = [];
            if (enableEpgInitial && epgSources.length) {
                for (let index = 0; index < epgSources.length; index++) {
                    const sourceUrl = epgSources[index];
                    try {
                        const epgTxt = await robustFetch(sourceUrl, 'epg ' + (index + 1));
                        const stats = quickEpgStats(epgTxt);
                        validEpgSources.push(sourceUrl);
                        appendDetail('✔ EPG source ' + (index + 1) + ': ' + stats.programmes.toLocaleString() + ' programmes');
                    } catch {
                        appendDetail('⚠ EPG source ' + (index + 1) + ' failed; continuing with other sources.');
                    }
                }
                if (!validEpgSources.length) enableEpgFinal = false;
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
            if (enableEpgFinal && validEpgSources.length) {
                config.epgUrl = validEpgSources[0];
                config.epgUrls = validEpgSources.slice(1);
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