// Shared overlay & manifest polling logic (enhanced + strict disabling of action buttons until manifest ready)
(function () {
    const overlay         = document.getElementById('loaderOverlay');
    const progressBar     = document.getElementById('progressBar');
    const progressText    = document.getElementById('progressText');
    const loaderMessage   = document.getElementById('loaderMessage');
    const statusDetails   = document.getElementById('statusDetails');
    const copyBtn         = document.getElementById('copyManifestBtn');
    const openBtn         = document.getElementById('openStremioBtn');

    // Polling / timing constants
    const POLL_INTERVAL_MS     = 1500;
    const MAX_WAIT_MS          = 90000;
    const PROGRESS_ESTIMATE_MS = 45000;

    let pollTimer      = null;
    let autoOpened     = false;
    let manifestUrl    = '';
    let stremioUrl     = '';
    let startTime      = 0;
    let manualPhase    = false;
    let baselinePct    = 0;
    let ready          = false;

    /* -------- Utility UI helpers -------- */

    function disableActionButtons() {
        if (openBtn) {
            openBtn.disabled = true;
            openBtn.classList.add('locked');
            openBtn.style.display = 'none'; // HIDE until ready

        }
        if (copyBtn) {
            copyBtn.disabled = true;
            copyBtn.classList.add('locked');
            copyBtn.style.display = 'none'; // HIDE until ready
        }
    }

    function enableActionButtons() {
        if (openBtn) {
            openBtn.disabled = false;
            openBtn.classList.remove('locked');
            openBtn.style.display = ''; // SHOW when ready
        }
        if (copyBtn) {
            copyBtn.disabled = false;
            copyBtn.classList.remove('locked');
            copyBtn.style.display = ''; // SHOW when ready
        }
    }

    function showOverlay(isManualPrePhase = false) {
        manualPhase = isManualPrePhase;
        if (overlay) overlay.classList.remove('hidden');
        setProgress(0, 'Initializing…');
        statusDetails && (statusDetails.textContent = '');
        autoOpened = false;
        ready = false;
        disableActionButtons(); // ALWAYS ensure disabled on open
    }

    function hideOverlay() {
        if (overlay) overlay.classList.add('hidden');
        if (pollTimer) clearTimeout(pollTimer);
    }

    function setProgress(pct, label) {
        if (progressBar) progressBar.style.width = Math.min(100, pct) + '%';
        if (progressText) progressText.textContent = `${Math.round(pct)}%`;
        if (label) loaderMessage.textContent = label;
    }

    function appendDetail(line) {
        if (!statusDetails) return;
        statusDetails.textContent += (statusDetails.textContent ? '\n' : '') + line;
        statusDetails.scrollTop = statusDetails.scrollHeight;
    }

    function progressMessage(elapsed) {
        if (elapsed < 4000)  return 'Downloading playlist…';
        if (elapsed < 10000) return 'Parsing channels…';
        if (elapsed < 18000) return 'Grouping / movies…';
        if (elapsed < 26000) return 'Fetching EPG (if enabled)…';
        if (elapsed < 35000) return 'Parsing EPG data…';
        if (elapsed < 45000) return 'Finalizing manifest…';
        return 'Almost done…';
    }

    /* -------- Polling logic -------- */

    function attemptPoll() {
        if (manualPhase) return; // Pre-flight still running client-side
        if (ready) return;

        const elapsed = Date.now() - startTime;

        // Synthetic progress up to baseline + 95%
        if (progressBar && parseFloat(progressBar.style.width) < baselinePct + 95) {
            const synthetic = baselinePct + Math.min(95, (elapsed / PROGRESS_ESTIMATE_MS) * 95);
            setProgress(synthetic, progressMessage(elapsed));
        }

        fetch(manifestUrl + '?_=' + Date.now(), { cache: 'no-store' })
            .then(r => r.ok ? r.json() : Promise.reject(r.status))
            .then(json => {
                if (json && json.id) {
                    ready = true;
                    setProgress(100, 'Ready');
                    appendDetail('Manifest ready.');
                    enableActionButtons(); // ENABLE ONLY HERE
                    // Inject a Close button (success case) if not already present
                    try {
                        const status = document.getElementById('statusDetails');
                        if (status && !document.getElementById('successCloseBtn')) {
                            const btn = document.createElement('button');
                            btn.id = 'successCloseBtn';
                            btn.textContent = 'Close';
                            btn.className = 'btn secondary';
                            btn.style.marginTop = '14px';
                            btn.addEventListener('click', hideOverlay);
                            status.parentElement.appendChild(btn);
                        }
                    } catch (e) { /* ignore DOM injection errors */ }
                    if (!autoOpened) {
                        autoOpened = true;
                        // Do not force-open if user might want to copy first.
                        // To auto-open uncomment next line:
                        // window.location.href = stremioUrl;
                    }
                    if (pollTimer) clearTimeout(pollTimer);
                    return;
                }
                scheduleNext(elapsed);
            })
            .catch(() => scheduleNext(elapsed));
    }

    function scheduleNext(elapsed) {
        if (ready) return;
        if (elapsed > MAX_WAIT_MS) {
            loaderMessage.textContent = 'Taking longer than expected.';
            appendDetail('Timeout waiting for manifest. You may retry or open later.');
            setProgress(100, 'Timeout');
            // Still allow user to copy / open after timeout
            enableActionButtons();
            return;
        }
        pollTimer = setTimeout(attemptPoll, POLL_INTERVAL_MS);
    }

    function startPolling(startPct = 50) {
        baselinePct = startPct;
        manualPhase = false;
        startTime = Date.now();
        disableActionButtons(); // Ensure still disabled when entering polling
        attemptPoll();
    }

    /* -------- Clipboard / events -------- */

    function copyManifest() {
        if (!manifestUrl || copyBtn.disabled) return;
        navigator.clipboard.writeText(manifestUrl)
            .then(() => {
                const old = copyBtn.textContent;
                copyBtn.textContent = 'Copied!';
                setTimeout(() => copyBtn.textContent = old, 1600);
            })
            .catch(() => {
                const old = copyBtn.textContent;
                copyBtn.textContent = 'Copy Failed';
                setTimeout(() => copyBtn.textContent = old, 1600);
            });
    }

    function openInStremio() {
        if (!stremioUrl || openBtn.disabled) return;
        window.location.href = stremioUrl;
    }

    if (copyBtn) copyBtn.addEventListener('click', copyManifest);
    if (openBtn) openBtn.addEventListener('click', openInStremio);

    /* -------- Token / URL builder -------- */

    function quickEpgStats(xml) {
        const pattern = /<programme\s/gi;
        let programmes = 0;
        while (pattern.exec(xml) !== null) programmes += 1;
        return { programmes };
    }

    // Shared browser/server preflight fetchers. Limits and deadlines prevent a
    // malformed or unexpectedly large playlist/EPG from hanging the setup page.
    const MAX_BROWSER_RESPONSE_BYTES = 50000000;
    const BROWSER_FETCH_TIMEOUT_MS = 45000;
    const SERVER_FETCH_TIMEOUT_MS = 50000;

    async function fetchTextBrowser(url, phaseLabel) {
        appendDetail(`→ (Browser) Fetching ${phaseLabel} (URL hidden for privacy)`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), BROWSER_FETCH_TIMEOUT_MS);
        try {
            const response = await fetch(url, { method: 'GET', signal: controller.signal });
            if (!response.ok) throw new Error(`${phaseLabel} HTTP ${response.status}`);

            const contentLength = Number(response.headers.get('content-length'));
            if (Number.isFinite(contentLength) && contentLength > MAX_BROWSER_RESPONSE_BYTES) {
                try { await response.body?.cancel(); } catch { /* best effort */ }
                throw new Error(`${phaseLabel} exceeds the 50 MB browser preflight limit`);
            }

            if (!response.body || typeof response.body.getReader !== 'function') {
                const text = await response.text();
                if (new TextEncoder().encode(text).byteLength > MAX_BROWSER_RESPONSE_BYTES) {
                    throw new Error(`${phaseLabel} exceeds the 50 MB browser preflight limit`);
                }
                appendDetail(`✔ (Browser) ${phaseLabel} ${text.length.toLocaleString()} characters`);
                return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
            }

            const reader = response.body.getReader();
            const chunks = [];
            let totalBytes = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                totalBytes += value.byteLength;
                if (totalBytes > MAX_BROWSER_RESPONSE_BYTES) {
                    try { await reader.cancel(); } catch { /* best effort */ }
                    throw new Error(`${phaseLabel} exceeds the 50 MB browser preflight limit`);
                }
                chunks.push(value);
            }

            const bytes = new Uint8Array(totalBytes);
            let offset = 0;
            for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
            }
            let text = new TextDecoder('utf-8').decode(bytes);
            if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
            appendDetail(`✔ (Browser) ${phaseLabel} ${totalBytes.toLocaleString()} bytes`);
            return text;
        } catch (error) {
            if (controller.signal.aborted) throw new Error(`${phaseLabel} request timed out`);
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    async function fetchTextServer(url, purpose) {
        appendDetail(`→ (Server) Prefetch ${purpose} (URL hidden for privacy)`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), SERVER_FETCH_TIMEOUT_MS);
        try {
            const response = await fetch('/api/prefetch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, purpose }),
                signal: controller.signal
            });
            let payload = {};
            try { payload = await response.json(); } catch { /* handled below */ }
            if (!response.ok) {
                const message = payload.error || `HTTP ${response.status}`;
                const detail = payload.detail ? ` (${payload.detail})` : '';
                throw new Error(`Server prefetch failed ${response.status} - ${message}${detail}`);
            }
            if (!payload.ok || typeof payload.content !== 'string' || !payload.content.length) {
                throw new Error('Server prefetch returned empty content');
            }
            appendDetail(`✔ (Server) ${purpose} ${Number(payload.bytes || 0).toLocaleString()} bytes${payload.truncated ? ' (truncated)' : ''}`);
            if (payload.truncated) {
                throw new Error('Prefetch truncated: increase the server response limit or reduce the dataset.');
            }
            return payload.content;
        } catch (error) {
            if (controller.signal.aborted) throw new Error('Server prefetch request timed out');
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    async function robustFetch(url, purpose, browserFirst = true) {
        const mixedContent = window.location.protocol === 'https:' && /^http:\/\//i.test(url);
        if (browserFirst && !mixedContent) {
            try {
                return await fetchTextBrowser(url, purpose);
            } catch (error) {
                appendDetail('⚠ Browser fetch failed → server fallback (details hidden for privacy).');
            }
        }
        return await fetchTextServer(url, purpose);
    }

    async function buildUrls(config) {
        // Provider credentials must never be put into reversible Base64 JSON.
        // Fail closed unless the server returns an authenticated encrypted token.
        const response = await fetch('/encrypt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        let payload = {};
        try { payload = await response.json(); } catch { /* handled below */ }
        if (!response.ok || typeof payload.token !== 'string' || !payload.token.startsWith('enc:')) {
            throw new Error(payload.error || 'Secure token creation failed. Configure CONFIG_SECRET on the server (at least 16 characters) and redeploy.');
        }
        const token = payload.token;
        const origin = window.location.origin;
        manifestUrl = `${origin}/${token}/manifest.json`;
        const hostPart = origin.replace(/^https?:\/\//, '');
        stremioUrl = `stremio://${hostPart}/${token}/manifest.json`;
        return { token, manifestUrl, stremioUrl };
    }


    async function prefillIfReconfigure(provider) {
        const parts = window.location.pathname.split('/').filter(Boolean);
        // Stremio/browser URLs may expose the colon in `enc:` as `%3A`.
        // Decode the path segment once before re-encoding it for the fetch URL.
        let token = parts[0];
        try { token = decodeURIComponent(token || ''); } catch { /* keep original segment */ }
        if (!token || token === 'configure-direct' || token === 'configure-xtream') return;
        try {
            const response = await fetch('/' + encodeURIComponent(token) + '/configuration.json', { cache: 'no-store' });
            if (!response.ok) throw new Error('Could not load saved configuration');
            const config = await response.json();
            const setValue = (id, value) => {
                const el = document.getElementById(id);
                if (el && value !== undefined && value !== null) el.value = value;
            };
            const setChecked = (id, value) => {
                const el = document.getElementById(id);
                if (el) el.checked = !!value;
            };
            setValue('m3uUrl', config.m3uUrl);
            setValue('epgUrl', config.epgUrl);
            // Xtream uses a separate input for the primary custom EPG URL.
            setValue('customEpgUrl', config.epgUrl);
            setValue('epgUrls', Array.isArray(config.epgUrls) ? config.epgUrls.join('\n') : '');
            setValue('epgOffsetHours', config.epgOffsetHours);
            setChecked('enableEpg', config.enableEpg !== false);
            setChecked('debugMode', config.debug);
            setValue('xtreamUrl', config.xtreamUrl);
            setValue('xtreamUsername', config.xtreamUsername);
            setValue('xtreamPassword', config.xtreamPassword);
            setChecked('xtreamUseM3U', config.xtreamUseM3U);
            setValue('xtreamOutput', config.xtreamOutput);
            const mode = config.provider === 'xtream' ? (config.epgUrl ? 'custom' : 'xtream') : 'custom';
            document.querySelectorAll('input[name="epgMode"]').forEach(el => { el.checked = el.value === mode; });
            const pwd = document.getElementById('xtreamPassword');
            if (pwd) pwd.dataset.original = config.xtreamPassword || '';
            const outputGroup = document.getElementById('xtreamOutputGroup');
            if (outputGroup) outputGroup.classList.toggle('hidden', !config.xtreamUseM3U);
            const customGroup = document.getElementById('customEpgGroup');
            if (customGroup) customGroup.classList.toggle('hidden', !(config.enableEpg !== false && mode === 'custom'));
            const submit = document.querySelector('#directForm button[type="submit"], #xtreamForm button[type="submit"]');
            if (submit) submit.textContent = provider === 'xtream' ? 'Save / Update Addon' : 'Save / Update Addon';
            appendDetail('Existing settings loaded. You can edit them and generate an updated addon link.');
        } catch (error) {
            console.warn('[CONFIGURE] Could not prefill settings:', error.message);
            appendDetail('Could not load saved settings. You can still configure a new addon.');
        }
    }

    /* -------- Public API -------- */

    window.ConfigureCommon = {
        showOverlay,
        hideOverlay,
        startPolling,
        buildUrls,
        prefillIfReconfigure,
        robustFetch,
        quickEpgStats,
        overlaySetMessage(msg) { loaderMessage.textContent = msg; },
        setProgress,
        appendDetail,
        // For direct-config pre-flight to re-disable if needed
        forceDisableActions: disableActionButtons
    };
})();