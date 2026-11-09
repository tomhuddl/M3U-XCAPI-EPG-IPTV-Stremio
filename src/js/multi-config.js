(function () {
    'use strict';
    const form = document.getElementById('multiForm');
    if (!form) return;
    const common = window.ConfigureCommon;
    const container = document.getElementById('providerSources');
    const template = document.getElementById('providerTemplate');
    const add = document.getElementById('addProviderBtn');
    const errorText = document.getElementById('formError');
    const cards = () => [...container.querySelectorAll('.provider-source')];
    const field = (card, name) => card.querySelector(`[data-field="${name}"]`);
    let busy = false;
    function updateControls() {
        const current = cards();
        add.disabled = current.length >= 4 || busy;
        current.forEach(card => { card.querySelector('[data-action="remove"]').disabled = current.length <= 1 || busy; });
    }
    function updateCard(card) {
        const provider = field(card, 'provider').value;
        for (const group of ['xtream', 'direct', 'guide']) {
            const node = card.querySelector(`[data-group="${group}"]`);
            const visible = group === 'guide' ? field(card, 'includeLive').checked : provider === group;
            node.classList.toggle('hidden', !visible);
            node.disabled = !visible;
        }
    }
    function addCard(source = {}) {
        const card = template.content.firstElementChild.cloneNode(true);
        const bytes = crypto.getRandomValues(new Uint8Array(6));
        card.dataset.sourceId = source.id || [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
        field(card, 'name').value = source.name || `Provider ${cards().length + 1}`;
        for (const name of ['provider', 'm3uUrl', 'xtreamUrl', 'xtreamUsername', 'xtreamPassword', 'xtreamOutput', 'epgOffsetHours']) {
            if (source[name] !== undefined) field(card, name).value = source[name];
        }
        for (const name of ['includeLive', 'includeMovies', 'includeSeries', 'enableEpg']) field(card, name).checked = source[name] !== false;
        field(card, 'xtreamUseM3U').checked = source.xtreamUseM3U === true;
        field(card, 'epgUrls').value = [...new Set([source.epgUrl, ...(source.epgUrls || [])].filter(Boolean))].join('\n');
        card.addEventListener('change', () => updateCard(card));
        card.querySelector('[data-action="remove"]').addEventListener('click', () => {
            if (cards().length > 1 && !busy) { card.remove(); updateControls(); }
        });
        container.append(card);
        updateCard(card); updateControls();
        return card;
    }
    function readCard(card) {
        const source = { id: card.dataset.sourceId, name: field(card, 'name').value.trim(), provider: field(card, 'provider').value };
        for (const name of ['includeLive', 'includeMovies', 'includeSeries']) source[name] = field(card, name).checked;
        if (!source.includeLive && !source.includeMovies && !source.includeSeries) throw new Error(`Choose some content for ${source.name}.`);
        if (source.provider === 'xtream') {
            for (const name of ['xtreamUrl', 'xtreamUsername', 'xtreamPassword']) source[name] = field(card, name).value;
            source.xtreamUrl = source.xtreamUrl.trim().replace(/\/+$/, '');
            source.xtreamUseM3U = field(card, 'xtreamUseM3U').checked;
            if (source.xtreamUseM3U && field(card, 'xtreamOutput').value) source.xtreamOutput = field(card, 'xtreamOutput').value;
        } else source.m3uUrl = field(card, 'm3uUrl').value.trim();
        source.enableEpg = source.includeLive && field(card, 'enableEpg').checked;
        if (source.enableEpg) {
            source.epgUrls = field(card, 'epgUrls').value.split(/\r?\n/).map(url => url.trim()).filter(Boolean);
            source.epgOffsetHours = Number(field(card, 'epgOffsetHours').value || 0);
        }
        return source;
    }
    add.addEventListener('click', () => { if (!busy && cards().length < 4) field(addCard(), 'name').focus(); });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy || !form.reportValidity()) return;
        errorText.textContent = '';
        let config;
        try { config = { sources: cards().map(readCard), debug: document.getElementById('debugMode').checked }; }
        catch (error) { errorText.textContent = error.message; return; }
        common.showOverlay();
        const generation = common.getGeneration();
        busy = true;
        form.querySelector('button[type="submit"]').disabled = true;
        updateControls();
        try {
            common.appendDetail('Saving the selected providers securely.');
            await common.buildUrls(config);
            if (!common.isCurrent(generation)) return;
            common.appendDetail('Loading selected content. Movie and series metadata will warm in the background.');
            common.startPolling(70);
        } catch (error) {
            if (common.isCurrent(generation)) { common.setProgress(0, 'Setup could not start'); common.appendDetail(error.message || 'Setup failed'); }
        } finally {
            busy = false;
            form.querySelector('button[type="submit"]').disabled = false;
            updateControls();
        }
    });
    async function prefill() {
        let token = window.location.pathname.split('/').filter(Boolean)[0] || '';
        try { token = decodeURIComponent(token); } catch { return; }
        if (!token.startsWith('enc:')) return;
        busy = true; updateControls();
        form.querySelector('button[type="submit"]').disabled = true;
        try {
            const { response, payload } = await common.fetchJson('/' + encodeURIComponent(token) + '/configuration.json', { cache: 'no-store' });
            if (!response.ok) throw new Error('Could not load saved provider settings.');
            container.replaceChildren();
            for (const source of payload.sources || [payload]) addCard(source);
            document.getElementById('debugMode').checked = payload.debug === true;
            form.querySelector('button[type="submit"]').textContent = 'Save / Update Addon';
        } catch (error) { errorText.textContent = error.message; }
        finally { busy = false; form.querySelector('button[type="submit"]').disabled = false; updateControls(); }
    }
    addCard();
    prefill();
})();
