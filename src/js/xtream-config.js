// xtream-config.js
// Updated: If EPG fetch (browser + server) fails, continue WITHOUT EPG instead of aborting.
// Supports custom EPG or panel XMLTV; failing both attempts disables EPG gracefully.

(function () {
  const form = document.getElementById("xtreamForm");
  if (!form) {
    console.error("[XTREAM-CONFIG] #xtreamForm not found");
    return;
  }

  const xtreamUrlInput = document.getElementById("xtreamUrl");
  const userInput = document.getElementById("xtreamUsername");
  const pwdInput = document.getElementById("xtreamPassword");
  const togglePwdBtn = document.getElementById("togglePwd");
  const enableEpgChk = document.getElementById("enableEpg");
  const epgOffsetInput = document.getElementById("epgOffsetHours");
  const debugChk = document.getElementById("debugMode");
  const customEpgGroup = document.getElementById("customEpgGroup");
  const customEpgUrlInp = document.getElementById("customEpgUrl");
  const epgUrlsInput = document.getElementById("epgUrls");
  const xtreamUseM3UChk = document.getElementById("xtreamUseM3U");
  const xtreamOutputGroup = document.getElementById("xtreamOutputGroup");

  const epgModeRadios = () => [
    ...document.querySelectorAll('input[name="epgMode"]'),
  ];

  const {
    showOverlay,
    hideOverlay,
    startPolling,
    buildUrls,
    appendDetail,
    setProgress,
    overlaySetMessage,
    forceDisableActions,
    prefillIfReconfigure,
  } = window.ConfigureCommon || {};

  if (!window.ConfigureCommon) {
    console.error("[XTREAM-CONFIG] ConfigureCommon not loaded.");
    return;
  }

  if (typeof prefillIfReconfigure === "function")
    prefillIfReconfigure("xtream");

  function selectedEpgMode() {
    const r = epgModeRadios().find((r) => r.checked);
    return r ? r.value : "xtream";
  }

  function syncCustomEpgVisibility() {
    const mode = selectedEpgMode();
    customEpgGroup.classList.toggle(
      "hidden",
      !(enableEpgChk.checked && mode === "custom"),
    );
  }

  if (togglePwdBtn && pwdInput) {
    togglePwdBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (pwdInput.type === "password") {
        pwdInput.type = "text";
        togglePwdBtn.textContent = "Hide";
      } else {
        pwdInput.type = "password";
        togglePwdBtn.textContent = "Show";
      }
    });
  }

  if (xtreamUseM3UChk) {
    xtreamUseM3UChk.addEventListener("change", () => {
      if (xtreamOutputGroup)
        xtreamOutputGroup.classList.toggle("hidden", !xtreamUseM3UChk.checked);
    });
  }

  enableEpgChk.addEventListener("change", syncCustomEpgVisibility);
  epgModeRadios().forEach((r) =>
    r.addEventListener("change", syncCustomEpgVisibility),
  );
  syncCustomEpgVisibility();

  function validateUrl(u) {
    try {
      const parsed = new URL(u);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  function normalizedBaseUrl(raw) {
    if (!raw) return "";
    let s = raw.trim();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  }

  async function fetchTextBrowser(url, phaseLabel) {
    // Avoid mixed content fetch attempts (HTTPS page -> HTTP resource) which browsers block.
    if (window.location.protocol === "https:" && /^http:\/\//i.test(url)) {
      throw new Error(
        "Mixed content blocked (forcing server prefetch fallback)",
      );
    }
    appendDetail(`→ (Browser) Fetching ${phaseLabel} (URL hidden for privacy)`);
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) throw new Error(`${phaseLabel} HTTP ${res.status}`);
    const txt = await res.text();
    appendDetail(
      `✔ (Browser) ${phaseLabel} ${txt.length.toLocaleString()} bytes`,
    );
    return txt;
  }

  async function fetchTextServer(url, purpose) {
    appendDetail(`→ (Server) Prefetch ${purpose} (URL hidden for privacy)`);
    const res = await fetch("/api/prefetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, purpose }),
    });
    let payload = {};
    try {
      payload = await res.json();
    } catch {}
    if (!res.ok) {
      const msg = payload.error || `HTTP ${res.status}`;
      const detail = payload.detail ? ` (${payload.detail})` : "";
      throw new Error(`Server prefetch failed ${res.status} - ${msg}${detail}`);
    }
    if (!payload.ok || !payload.content)
      throw new Error("Server prefetch empty content");
    appendDetail(
      `✔ (Server) ${purpose} ${payload.bytes.toLocaleString()} bytes${payload.truncated ? " (truncated)" : ""}`,
    );
    if (payload.truncated) {
      throw new Error(
        "Prefetch truncated: increase server PREFETCH_MAX_BYTES or reduce dataset (e.g. fetch categories incrementally)",
      );
    }
    return payload.content;
  }

  async function robustFetch(url, purpose, browserFirst = true) {
    // If mixed content would occur, skip browser attempt.
    const mixed =
      window.location.protocol === "https:" && /^http:\/\//i.test(url);
    if (browserFirst && !mixed) {
      try {
        return await fetchTextBrowser(url, purpose);
      } catch (e) {
        appendDetail('⚠ Browser fetch failed → server fallback (details hidden for privacy).');
      }
    }
    return await fetchTextServer(url, purpose);
  }

  function quickEpgStats(xml) {
    const prog = xml.match(/<programme\s/gi);
    const ch = xml.match(/<channel\s/gi);
    return {
      programmes: prog ? prog.length : 0,
      channels: ch ? ch.length : 0,
    };
  }

  function uuid() {
    return crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : "id-" +
          Math.random().toString(36).slice(2, 10) +
          Date.now().toString(36);
  }

  async function sha256Fragment(str) {
    try {
      const enc = new TextEncoder().encode(str);
      const digest = await crypto.subtle.digest("SHA-256", enc);
      const hex = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      return hex.slice(0, 10) + "…";
    } catch {
      return "(hash-unavailable)";
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const baseUrlRaw = xtreamUrlInput.value.trim();
    const baseUrl = normalizedBaseUrl(baseUrlRaw);
    const username = userInput.value.trim();
    let password = pwdInput.value;
    const enableEpgInitial = enableEpgChk.checked;
    const epgMode = enableEpgInitial ? selectedEpgMode() : "disabled";
    const customEpg = epgMode === "custom" ? customEpgUrlInp.value.trim() : "";
    const additionalEpgUrls = epgUrlsInput ? [...new Set(epgUrlsInput.value.split(/\\r?\\n/).map(u => u.trim()).filter(Boolean))] : [];
    const epgOffset = epgOffsetInput.value
      ? parseFloat(epgOffsetInput.value)
      : 0;
    const debug = !!(debugChk && debugChk.checked);

    if (!validateUrl(baseUrl)) {
      alert("Invalid Xtream base URL");
      return;
    }
    if (!username || !password) {
      alert("Username / password required");
      return;
    }
    if (password === "********" && pwdInput.dataset.original) {
      password = pwdInput.dataset.original;
    }

    if (enableEpgInitial && additionalEpgUrls.some(url => !validateUrl(url))) {
      alert("One or more additional EPG URLs are invalid. Use HTTP(S) URLs, one per line.");
      return;
    }
    if (epgMode === "custom" && enableEpgInitial) {
      if (!customEpg) {
        alert("Custom EPG URL is empty");
        return;
      }
      if (!validateUrl(customEpg)) {
        alert("Invalid Custom EPG URL");
        return;
      }
    }

    showOverlay(true);
    forceDisableActions && forceDisableActions();
    overlaySetMessage("Pre-flight: Validating Xtream inputs…");
    setProgress(5, "Starting");
    appendDetail("== PRE-FLIGHT (XTREAM) ==");
    appendDetail(`Base URL: ${baseUrl}`);
    appendDetail(`Mode: 'JSON API'}`);
    appendDetail(
      `EPG Mode: ${enableEpgInitial ? (epgMode === "custom" ? "Custom URL" : "Panel XMLTV") : "Disabled"}`,
    );
    appendDetail(`Debug logging: ${debug ? "enabled" : "disabled"}`);

    let enableEpgFinal = enableEpgInitial;
    try {
      let liveCount = 0;
      let vodCount = 0;
      let categories = new Set();
      let epgStats = { programmes: 0, channels: 0 };

      const base = `${baseUrl}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
      setProgress(12, "Fetching Live Streams");
      let liveJsonText;
      try {
        liveJsonText = await robustFetch(
          `${base}&action=get_live_streams`,
          "live_streams",
          true,
        );
      } catch (lErr) {
        appendDetail('⚠ Live streams browser fetch failed; trying server fallback.');
        liveJsonText = await robustFetch(
          `${base}&action=get_live_streams`,
          "live_streams",
          false,
        );
      }
      let liveList = [];
      try {
        liveList = JSON.parse(liveJsonText);
      } catch {
        throw new Error("Failed to parse live streams JSON");
      }
      liveCount = Array.isArray(liveList) ? liveList.length : 0;
      appendDetail(`✔ Live streams: ${liveCount.toLocaleString()}`);

      setProgress(28, "Fetching VOD Streams");
      let vodJsonText;
      try {
        vodJsonText = await robustFetch(
          `${base}&action=get_vod_streams`,
          "vod_streams",
          true,
        );
      } catch (vErr) {
        appendDetail('⚠ VOD browser fetch failed; trying server fallback.');
        vodJsonText = await robustFetch(
          `${base}&action=get_vod_streams`,
          "vod_streams",
          false,
        );
      }
      let vodList = [];
      try {
        vodList = JSON.parse(vodJsonText);
      } catch {
        throw new Error("Failed to parse VOD streams JSON");
      }
      vodCount = Array.isArray(vodList) ? vodList.length : 0;
      appendDetail(`✔ VOD streams: ${vodCount.toLocaleString()}`);

      if (Array.isArray(liveList)) {
        for (const l of liveList) {
          const c = l.category_name || l.category || "";
          if (c) categories.add(c);
        }
      }
      if (Array.isArray(vodList)) {
        for (const v of vodList) {
          const c = v.category_name || v.category || "";
          if (c) categories.add(c);
        }
      }

      // EPG feeds (each source fails independently; merge occurs on the server).
      const primaryEpgUrl = enableEpgInitial
        ? (epgMode === "custom" ? customEpg : `${baseUrl}/xmltv.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`)
        : "";
      const epgSources = [...new Set([...(primaryEpgUrl ? [primaryEpgUrl] : []), ...additionalEpgUrls])];
      const validEpgSources = [];
      if (enableEpgInitial) {
        for (let index = 0; index < epgSources.length; index++) {
          try {
            let epgTxt;
            try { epgTxt = await robustFetch(epgSources[index], "epg " + (index + 1), true); }
            catch { epgTxt = await robustFetch(epgSources[index], "epg " + (index + 1), false); }
            const stats = quickEpgStats(epgTxt);
            epgStats.programmes += stats.programmes;
            epgStats.channels = Math.max(epgStats.channels, stats.channels);
            validEpgSources.push(epgSources[index]);
            appendDetail("✔ EPG source " + (index + 1) + ": " + stats.programmes.toLocaleString() + " programmes");
          } catch {
            appendDetail("⚠ EPG source " + (index + 1) + " failed; continuing with other sources.");
          }
        }
        if (!validEpgSources.length) enableEpgFinal = false;
      } else {
        appendDetail("EPG disabled by user.");
      }

      setProgress(60, "Building token");
      const config = {
        provider: "xtream",
        xtreamUrl: baseUrl,
        xtreamUsername: username,
        xtreamPassword: password,
        enableEpg: enableEpgFinal,
        debug: debug || undefined,
      };

      if (xtreamUseM3UChk && xtreamUseM3UChk.checked) {
        config.xtreamUseM3U = true;
        const outVal = document.getElementById("xtreamOutput")
          ? document.getElementById("xtreamOutput").value.trim()
          : "";
        if (outVal) config.xtreamOutput = outVal;
      }

      if (enableEpgFinal && validEpgSources.length) {
        if (epgMode === "custom") config.epgUrl = validEpgSources[0];
        else config.epgUrl = "";
        config.epgUrls = epgMode === "custom" ? validEpgSources.slice(1) : validEpgSources.filter(url => url !== primaryEpgUrl);
      }
      if (isFinite(epgOffset) && epgOffset !== 0)
        config.epgOffsetHours = epgOffset;

      config.prescan = {
        liveCount,
        vodCount,
        categoryCount: categories.size,
        epgProgrammes: enableEpgFinal ? epgStats.programmes : 0,
        epgChannels: enableEpgFinal ? epgStats.channels : 0,
        mode: "json",
        epgSource: enableEpgFinal
          ? epgMode === "custom"
            ? "custom"
            : "xtream"
          : "disabled",
      };

      config.instanceId = config.instanceId || uuid();

      const { manifestUrl, stremioUrl } = await buildUrls(config);
      appendDetail("✔ Token built");
      appendDetail("Secure manifest and Stremio links created (links hidden for privacy).");

      setProgress(70, "Waiting for manifest");
      appendDetail("== SERVER BUILD PHASE ==");
      appendDetail("Polling server…");
      startPolling(70);
    } catch (err) {
      console.error("[XTREAM-CONFIG] Pre-flight error", err);
      overlaySetMessage("Pre-flight failed");
      appendDetail("✖ Error: " + (err.message || err.toString()));
      setProgress(100, "Failed");
      appendDetail("Close overlay and adjust inputs to retry.");

      const status = document.getElementById("statusDetails");
      if (status && !document.getElementById("retryCloseXtreamBtn")) {
        const btn = document.createElement("button");
        btn.id = "retryCloseXtreamBtn";
        btn.textContent = "Close";
        btn.className = "btn danger";
        btn.style.marginTop = "14px";
        btn.onclick = hideOverlay;
        status.parentElement.appendChild(btn);
      }
    }
  });
})();
