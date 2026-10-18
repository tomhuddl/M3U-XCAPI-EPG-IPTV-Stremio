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
    robustFetch,
    checkEpgStats,
    quickEpgStats,
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

  function safeDisplayOrigin(raw) {
    try {
      return new URL(raw).origin;
    } catch {
      return "[invalid URL]";
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
    const additionalEpgUrls = epgUrlsInput ? [...new Set(epgUrlsInput.value.split(/\r?\n/).map(u => u.trim()).filter(Boolean))] : [];
    if (additionalEpgUrls.length > 20) {
      alert("Please enter no more than 20 additional EPG URLs.");
      return;
    }
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
    appendDetail(`Base origin: ${safeDisplayOrigin(baseUrl)} (credentials and path hidden)`);
    appendDetail(`Mode: 'JSON API'}`);
    appendDetail(
      `EPG Mode: ${enableEpgInitial ? (epgMode === "custom" ? "Custom URL" : "Panel XMLTV") : "Disabled"}`,
    );
    appendDetail(`Debug logging: ${debug ? "enabled" : "disabled"}`);

    let enableEpgFinal = enableEpgInitial;
    try {
      let liveCount = 0;
      let vodCount = 0;

      const base = `${baseUrl}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
      setProgress(12, "Fetching Live Streams");
      const liveJsonText = await robustFetch(
        `${base}&action=get_live_streams`,
        "live_streams",
      );
      let liveList = [];
      try {
        liveList = JSON.parse(liveJsonText);
      } catch {
        throw new Error("Failed to parse live streams JSON");
      }
      liveCount = Array.isArray(liveList) ? liveList.length : 0;
      appendDetail(`✔ Live streams: ${liveCount.toLocaleString()}`);

      setProgress(28, "Fetching VOD Streams");
      const vodJsonText = await robustFetch(
        `${base}&action=get_vod_streams`,
        "vod_streams",
      );
      let vodList = [];
      try {
        vodList = JSON.parse(vodJsonText);
      } catch {
        throw new Error("Failed to parse VOD streams JSON");
      }
      vodCount = Array.isArray(vodList) ? vodList.length : 0;
      appendDetail(`✔ VOD streams: ${vodCount.toLocaleString()}`);

      // EPG feeds (each source fails independently; merge occurs on the server).
      const primaryEpgUrl = enableEpgInitial
        ? (epgMode === "custom" ? customEpg : `${baseUrl}/xmltv.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`)
        : "";
      const epgSources = [...new Set([...(primaryEpgUrl ? [primaryEpgUrl] : []), ...additionalEpgUrls])];
      const validEpgSources = [];
      if (enableEpgInitial) {
        for (let index = 0; index < epgSources.length; index++) {
          try {
            const stats = await checkEpgStats(epgSources[index], index + 1);
            validEpgSources.push(epgSources[index]);
          } catch (error) {
            appendDetail("⚠ EPG source " + (index + 1) + " failed: " + (error.message || "check failed") + "; continuing with other sources.");
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
