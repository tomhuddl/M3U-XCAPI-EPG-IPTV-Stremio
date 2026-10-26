# ☄️ Stremio IPTV Addon (Direct M3U • Xtream Codes • XMLTV EPG • Series Support)

> A self‑hostable, token‑based, privacy‑friendly IPTV addon for **Stremio** supporting:
> - Direct M3U playlists (TV + Movie + heuristic Series detection)
> - Xtream Codes API (JSON mode + m3u_plus mode)
> - Panel XMLTV or custom EPG feeds, including multiple merged XMLTV sources
> - Channel Logos, Live Now info, Upcoming programme snippets
> - Movies & VOD catalog
> - Series catalog (Xtream native + M3U heuristic grouping)
> - Client pre‑flight validation with CORS bypass fallback
> - Encrypted configuration tokens (AES-256-GCM)
> - Bounded in-memory LRU caches + optional Redis data cache
> - Lightweight logo proxy & EPG parsing
> - Graceful degradation (EPG failures do not block usage)

---

## 🎬 Demo Flow (How Users Install)

1. Visit your hosted base URL (`https://your-host/`)
2. Pick a mode:
   - “Direct M3U / EPG” → paste playlist + optional XMLTV feeds (one URL per line)
   - “Xtream Codes API” → enter panel URL + credentials (or toggle m3u_plus), then add optional extra XMLTV feeds
3. (Optional) Provide or override EPG source
4. Pre‑flight runs:
   - Fetch + parse playlist (client; server fallback if CORS)
   - Fetch + quick-scan EPG (non-fatal)
   - Build a configuration token
5. A Stremio manifest URL appears (disabled buttons enable when ready):
   ```
   https://your-host/<TOKEN>/manifest.json
   stremio://your-host/<TOKEN>/manifest.json
   ```
6. Open in Stremio → catalogs appear:
   - IPTV Channels (tv)
   - IPTV Movies (movie)
   - IPTV Series (series)

---

## 🧪 Quick Start (Local Dev)

Requires **Node.js 22 or newer**.

```bash
git clone https://github.com/tomhuddl/M3U-XCAPI-EPG-IPTV-Stremio.git
cd M3U-XCAPI-EPG-IPTV-Stremio
cp .env.example .env   # create your env (or export vars manually)
npm ci
npm run dev
# Server runs on PORT (default 7000)
open http://localhost:7000/
```

Minimal `.env`:
```env
PORT=7000
CACHE_ENABLED=true
CACHE_TTL_MS=21600000
MAX_CACHE_ENTRIES=10
CACHE_MEMORY_MAX_BYTES=268435456
DEBUG_MODE=false
# Optional: set this to the path of a mounted durable volume in your host.
# PERSISTENT_DATA_DIR=/data
# Provider + EPG refresh (default 12 hours)
DATA_REFRESH_INTERVAL_MS=43200000
# Optional:
# REDIS_URL=redis://localhost:6379
# CONFIG_SECRET=use-a-unique-long-random-secret (required for encrypted tokens)
# ALLOW_LEGACY_CONFIG_TOKENS=false
# PREFETCH_MAX_CONCURRENT=4
# MAX_ACTIVE_INTERFACE_BUILDS=4
# PREFETCH_ENABLED=true
# PREFETCH_MAX_BYTES=50000000    (50 MB default; 150 MB hard cap)
# PROVIDER_MAX_BYTES=50000000     (50 MB default; 150 MB hard cap)
```

---

## 🐳 Docker (Standalone)

```bash
docker build -t stremio-iptv-addon .
docker run -d \
  -e PORT=7000 \
  -e DEBUG_MODE=false \
  -e CACHE_ENABLED=true \
  -e PERSISTENT_DATA_DIR=/data \
  -v stremio-data:/data \
  -p 7000:7000 \
  --name stremio-addon \
  stremio-iptv-addon
```

### Docker Compose (with Redis for shared cache)

The repository `docker-compose.yml` builds the checked-out source. Run `docker compose up --build` after pulling or changing the code so the container uses that checkout.

```yaml
services:
  redis:
    image: redis:7-alpine
    restart: unless-stopped
  addon:
    build: .
    restart: unless-stopped
    environment:
      PORT: 7000
      REDIS_URL: redis://redis:6379
      CACHE_ENABLED: "true"
      CACHE_TTL_MS: 21600000
      PERSISTENT_DATA_DIR: /data
      MAX_CACHE_ENTRIES: 400
      PREFETCH_ENABLED: "true"
      PREFETCH_MAX_BYTES: 6000000
      CONFIG_SECRET: "generate_a_long_random_string"
      DEBUG_MODE: "false"
    depends_on:
      - redis
    ports:
      - "7000:7000"
    volumes:
      - addon-data:/data
volumes:
  addon-data:
```

Then open: `http://localhost:7000/`

---

## 🔐 Configuration Tokens

| Type | Format | Notes |
|------|--------|-------|
| Plain Token | Base64URL JSON (no prefix) | Disabled by default; set `ALLOW_LEGACY_CONFIG_TOKENS=true` temporarily only if migrating old links |
| Encrypted Token | `enc:<ciphertext>` | Required for newly generated links; AES-256-GCM via `/encrypt` and `CONFIG_SECRET` |
| Manifest URL | `https://host/<TOKEN>/manifest.json` | Supply to Stremio |
| Stremio Protocol | `stremio://host/<TOKEN>/manifest.json` | Auto-open from UI |

Decryption / parsing is done server-side before addon build.

---

## 📡 HTTP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Landing + mode selection |
| `/configure-direct` | GET | Direct config page (no token) |
| `/configure-xtream` | GET | Xtream config page (no token) |
| `/:token/configure` | GET | Stremio Configure entry point; redirects to the matching prefilled form |
| `/:token/configure-direct` | GET | Reconfigure direct (pre-filled from token) |
| `/:token/configure-xtream` | GET | Reconfigure Xtream (pre-filled from token) |
| `/:token/configuration.json` | GET | Token-specific configuration used to prefill the Configure page (no-store) |
| `/:token/manifest.json` | GET | Stremio manifest |
| `/:token/catalog/:type/:id/:extra?.json` | GET | Catalog resource (SDK handled) |
| `/:token/stream/:type/:id.json` | GET | Stream resource |
| `/:token/meta/:type/:id.json` | GET | Meta resource |
| `/:token/logo/:tvgId.png` | GET | Logo proxy (tries multiple sources) |
| `/api/prefetch` | POST | Server-side fetch (CORS bypass, size limited) |
| `/encrypt` | POST | Returns encrypted token (requires `CONFIG_SECRET`) |
| `/health` | GET | Health probe (JSON) |

### Prefetch Example
```bash
curl -X POST http://localhost:7000/api/prefetch \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/playlist.m3u","purpose":"playlist"}'
```

---

## 🧬 Features Breakdown

| Feature | Direct M3U | Xtream JSON | Xtream m3u_plus | Notes |
|---------|------------|-------------|-----------------|-------|
| Live Channels Catalog | ✅ | ✅ | ✅ | Unified tv catalog |
| Movies Catalog | Heuristic (by title/year/group) | ✅ | ✅ | Filtering rules |
| Series Catalog | Heuristic (SxxEyy / Season X) | Native `get_series` + `get_series_info` | Heuristic | Per-episode videos |
| EPG | One or more XMLTV URLs | Panel XMLTV/custom plus extra XMLTV URLs | Panel XMLTV/custom plus extra XMLTV URLs | Merged by channel ID; duplicate programmes removed; offset supported |
| Logos | tvg-logo / fallback proxy | Uses stream_icon / cover | tvg-logo where present | Multiple sources attempted |
| CORS Bypass | Yes (prefetch) | Yes (prefetch) | Yes (prefetch) | Browser first, fallback server |
| Encryption | Token-level | Token-level | Token-level | Optional |
| Caching | LRU + optional Redis | Same | Same | Cache key = hashed config |
| Series Episodes | Local heuristic grouping | On-demand per series (lazy) | Heuristic | Episode IDs = `iptv_series_ep_*` |

---

## 💾 Persistent Catalogue, Metadata and EPG

Set **PERSISTENT_DATA_DIR** to the mount path of a persistent volume, such as **/data**. The same volume and path must be attached after every restart or redeploy. With the default paths, the volume contains configuration-namespaced files:

| File | Contents |
|------|----------|
| addon-data-[24-char config hash].json | Last successful provider snapshot: live channels, movies, series, parsed EPG programmes, successful refresh timestamp, and the Direct-M3U episode index. It also stores pending large-removal confirmation fingerprints. The file has a format version and save timestamp. Each direct episode record includes its IPTV episode ID, title, season/episode numbers, thumbnail, release value, playable URL, and stream ID. |
| catalog-meta/catalog-meta-[24-char config hash].json and its .wal companion | Enriched movie/series metadata previews: artwork, descriptions, genres, year/release, runtime, rating, cast/director, IMDb/TMDb IDs, and metadata check timestamps. The append-only journal is compacted into the snapshot periodically. |
| series-info/series-info-[24-char config hash].json and its .wal companion | Xtream series details fetched on demand: episode IDs/titles, season and episode numbers, release values, thumbnails, playable URLs, stream IDs, series TMDb ID, fetch/save timestamps, and the provider-catalogue timestamp used to decide freshness. |
| omdb-usage.json | Current UTC day and OMDb requests reserved that day, so restarts do not reset the daily request limit. |

The provider snapshots and metadata files are namespaced by a hash of the provider configuration. They do not store the raw configuration token, but episode URLs may contain provider credentials or playlist access tokens. Keep the volume private. CATALOG_META_CACHE_DIR and SERIES_INFO_CACHE_DIR can move their respective cache files elsewhere. The OMDb counter uses PERSISTENT_DATA_DIR, or ./data if it is unset. Cache files older than PERSISTENT_CACHE_RETENTION_DAYS (90 days by default) are removed, except for the active configuration; abandoned .tmp files are removed after 24 hours. The metadata and episode journals are append-only write-ahead logs next to their .json snapshots. Keep one application process writing to a given persistent cache directory; the files do not use cross-process locks.

Direct-M3U episode indexes are loaded from and saved in the provider snapshot, so episode lookup works immediately after a restart. Xtream does not download every season's episodes during catalogue refresh: the first series-detail request fetches them from get_series_info, stores the response in memory, and schedules a batched journal write (normally within 500 ms) without waiting for disk before returning the episode list. A graceful shutdown flushes pending journal writes. Later requests reuse the saved result. An entry is fresh for the provider refresh interval (12 hours by default) only while the provider catalogue timestamp is unchanged. After a successful catalogue refresh, the next series-detail request fetches a fresh episode list. If Xtream is unavailable, a saved list can be served as a fallback for up to 30 days.

The provider catalogue and EPG are checked hourly and refreshed after 12 hours by default. A successful refresh stores the new timestamp. A failed refresh restores the previous catalogue, EPG and timestamp, leaving the refresh overdue for the next hourly check. A blank EPG result keeps the previous non-empty guide. A successful provider deletion removes the item from the saved catalogue; removed channels also lose orphaned EPG groups when no current channel uses that XMLTV ID, and removed movies/series lose their enriched metadata and series details. A few deletions are accepted immediately. By default, a large section drop is held on its first observation and accepted only after a second refresh returns the same remaining item IDs; an emptied non-empty section is also held for confirmation, including small sections. The first observation persists its fingerprint and leaves the last-good snapshot and refresh timestamp in place, so the hourly checker can confirm it on its next attempt. A failed provider request does not count as confirmation. Set PROVIDER_REMOVAL_GUARD_MIN_ITEMS, PROVIDER_REMOVAL_GUARD_PERCENT, and PROVIDER_REMOVAL_CONFIRMATIONS to tune the safeguard.

Complete enriched catalogue metadata stays fresh for 14 days by default. If a normal refresh of a complete entry fails, the app waits 12 hours by default before retrying it (CATALOG_METADATA_FAILURE_RETRY_MS). Missing artwork, description, genres, year/release information, runtime, IMDb rating, cast, or movie director becomes eligible for another lookup after 12 hours (OMDB_MISSING_DATA_RETRY_MS). A known TMDb ID without an IMDb ID is also retried. The raw TMDb and OMDb API-response caches are process-memory only: their response TTLs do not make those raw responses survive a restart. TMDb's default response TTL is 14 days and confirmed 404 responses are cached for five minutes; OMDb's response TTL is 14 days. A persistent last-good catalogue preview can be used as a fallback for up to 30 days.

### Metadata source priority

TMDb is used when a provider item has a TMDb ID or the Xtream JSON lookup resolves one. It does not title-search as a general fallback. If no TMDb result is available, provider fields and the prior saved preview are used where present.

| Metadata | Priority / behavior |
|----------|---------------------|
| Movie/series name | TMDb title/name, then provider title/name |
| Poster | TMDb poster, then provider poster/cover/logo; previous saved non-empty value is retained if a refresh omits it |
| Background and title logo | TMDb only; a previous saved value can be retained |
| Description | TMDb overview, then provider plot/playlist plot; previous saved non-empty value can be retained |
| Genres | TMDb genres, then provider category/group-title |
| Year/release information | TMDb dates, then provider year or a year parsed from a movie title when using the provider fallback |
| Runtime | TMDb, then provider runtime, then OMDb runtime |
| IMDb ID | TMDb external IMDb ID; OMDb is queried using that known ID and does not perform a title search |
| IMDb rating | OMDb only. A missing rating is retried after 12 hours when the record is revisited/warmed; without a resolvable IMDb ID or OMDb API key, the rating cannot be fetched |
| Director and main cast | TMDb credits; cast is limited to the main cast returned by the TMDb mapper |
| Episode title, description, artwork, release and episode credits | TMDb season/episode data when matched, then the provider episode record |
| Playable episode ID and URL | Provider is authoritative; TMDb never supplies stream IDs or URLs |
| Live-channel name, logo and category | Provider playlist/Xtream data; programme title, description and times come from XMLTV |

TMDb's numeric score is not substituted for IMDb rating. The user-facing IMDb rating badge comes from OMDb.

**Important:** setting PERSISTENT_DATA_DIR alone does not create durable storage; configure a mounted volume in the hosting service. Without it, catalogue snapshots and persistent metadata/episode files are disabled and those caches remain in memory/optional Redis. The OMDb usage counter still writes to local ./data, which may be ephemeral.

## ⛽ Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `7000` | HTTP server port |
| `REDIS_URL` | unset | Optional shared cache for provider data only |
| `TMDB_API_KEY` | unset | Server-side TMDb API key used for movie, series and episode metadata; without it, TMDb metadata is unavailable |
| `TMDB_CACHE_TTL_MS` | 1209600000 (14d) | Process-memory cache lifetime for TMDb API responses |
| `TMDB_CACHE_MAX_ENTRIES` | 1000 | Maximum number of cached TMDb responses (bounded by the server) |
| `TMDB_NEGATIVE_CACHE_TTL_MS` | 300000 (5m) | Cache lifetime for confirmed TMDb 404 responses; transient failures are not cached as 404s |
| `OMDB_API_KEY` | unset | OMDb API key for IMDb rating/runtime lookups |
| `OMDB_DAILY_RESERVATION_BLOCK_SIZE` | 25 | Persist OMDb daily quota in blocks to reduce volume writes; unused reserved requests count against the quota until the next UTC day |
| `OMDB_RETRY_FAILURE_MAX_ENTRIES` | 10000 | Maximum retryable OMDb lookup failures retained in process memory |
| `OMDB_CACHE_TTL_MS` | 1209600000 (14d) | Process-memory cache lifetime for OMDb API responses |
| `CACHE_ENABLED` | `true` | Enables/disables the provider-data LRU and Redis layers; provider refresh scheduling, the bounded addon-interface cache, separate metadata/episode caches, and configured disk persistence still operate |
| `CACHE_TTL_MS` | `21600000` (6h) | TTL for provider catalogue data in the in-memory LRU, Redis snapshot, and series-info LRU |
| `PERSISTENT_DATA_DIR` | unset | Mounted persistent directory for provider snapshots, direct episode indexes, enhanced metadata and Xtream episode details; set to the mount path (commonly /data) |
| `PERSISTENT_DATA_MAX_BYTES` | 134217728 (128 MiB) | Maximum provider snapshot file size; bounded by 512 MiB |
| `PERSISTENT_CACHE_RETENTION_DAYS` | 90 | Remove inactive config cache files after this many days (1–365) |
| `CATALOG_META_CACHE_DIR` | unset | Optional override for the persistent movie/series metadata cache directory |
| `SERIES_INFO_CACHE_DIR` | unset | Optional override for the persistent Xtream episode-detail cache directory |
| `DATA_REFRESH_INTERVAL_MS` | 43200000 (12h) | Minimum interval between successful provider catalogue and EPG refreshes |
| `DATA_REFRESH_CHECK_INTERVAL_MS` | 3600000 (1h) | How often the scheduler checks whether a provider refresh is due |
| `SERIES_INFO_PERSISTENT_TTL_MS` | same as DATA_REFRESH_INTERVAL_MS | Freshness window for persisted Xtream episode details (bounded to 1h–30d) |
| `SERIES_INFO_STALE_RETENTION_MS` | 2592000000 (30d) | Maximum stale Xtream episode-detail fallback age |
| `SERIES_INFO_PERSISTENT_MAX_ENTRIES` | 20000 | Maximum persistent Xtream series-detail entries |
| `EPG_FETCH_CONCURRENCY` | 2 | Concurrent EPG sources fetched and parsed per provider (capped at 4) |
| `SERIES_EPISODE_METADATA_CONCURRENCY` | 6 | Concurrent TMDb season episode requests on a series detail page (capped at 12) |
| `SERIES_EPISODE_CACHE_MAX` | 50000 | Maximum in-memory episode ID lookup entries (bounded to 1,000–200,000) |
| `CATALOG_META_MEMORY_TTL_MS` | `21600000` (6h) | In-memory LRU lifetime for enriched movie/series metadata |
| `CATALOG_META_PERSISTENT_TTL_MS` | `1209600000` (14d) | Freshness window for persisted enhanced movie/series metadata; legacy fallback: `CATALOG_META_CACHE_TTL_MS` |
| `CATALOG_METADATA_REFRESH_MS` | 1209600000 (14d) | Normal per-item refresh interval for enriched catalogue metadata |
| `CATALOG_METADATA_FAILURE_RETRY_MS` | 43200000 (12h) | Delay before retrying a failed normal refresh of complete metadata |
| `CATALOG_META_STALE_RETENTION_MS` | `2592000000` (30d) | How long last-good enhanced metadata may be retained as a fallback |
| `CATALOG_PREFETCH_REFRESH_MS` | `43200000` (12h) | How often the full catalogue warm-up rechecks metadata completeness; per-item metadata retains its own freshness window |
| `OMDB_MISSING_DATA_RETRY_MS` | 43200000 (12h) | Retry interval for items with missing key metadata fields across provider/TMDb/OMDb |
| `PROVIDER_REMOVAL_GUARD_MIN_ITEMS` | 10 | Minimum deleted items for the configurable large-drop safeguard |
| `PROVIDER_REMOVAL_GUARD_PERCENT` | 25 | Percentage removed for the configurable large-drop safeguard |
| `PROVIDER_REMOVAL_CONFIRMATIONS` | 2 | Matching refresh observations required before accepting a guarded section drop |
| `MAX_CACHE_ENTRIES` | 10 | Maximum provider-data LRU entries (also bounded by its memory limit) |
| `CACHE_MEMORY_MAX_BYTES` | 268435456 (256 MiB) | Approximate memory budget for the provider-data LRU |
| `MAX_INTERFACE_CACHE_ENTRIES` | 3 | Maximum addon interfaces retained in process memory |
| `INTERFACE_CACHE_MAX_BYTES` | 268435456 (256 MiB) | Approximate memory budget for addon interfaces; eviction stops refresh timers and flushes persistent caches |
| `INTERFACE_CACHE_TTL_MS` | 0 (no expiry) | Optional interface expiry; memory limits still evict least-recently-used interfaces |
| `CONFIG_SECRET` | unset | Required to create/decrypt encrypted tokens; use a unique random secret (prefer 32+ random bytes; minimum 16 characters) |
| `LOG_LEVEL` | `info` | Minimum deploy log detail: `debug`, `info`, `warn`, or `error` |
| `DEBUG_MODE` | `false` | Enables concise debug diagnostics regardless of `LOG_LEVEL` |
| `PREFETCH_ENABLED` | `true` | Enable server-side prefetch CORS bypass |
| `PREFLIGHT_RATE_MAX` | `120` per minute | Per-IP limit for public setup/preflight and `/encrypt` requests (process-local) |
| `ADDON_REQUEST_RATE_MAX` | `1200` per minute | Per-IP limit for tokenized addon requests (process-local; bounded to 60–6,000) |
| `PREFETCH_MAX_BYTES` | `50000000` (50 MB) | Maximum bytes retained from one `/api/prefetch` response; hard cap 150 MB |
| `PREFETCH_MAX_CONCURRENT` | `2` | Concurrent server-side prefetch limit (maximum 8) |
| `PROVIDER_MAX_BYTES` | `50000000` (50 MB) | Max bytes read from each playlist, API or EPG response; hard cap 150 MB |
| `EPG_MAX_BYTES` | `150000000` (150 MB) | Maximum bytes accepted for each XMLTV guide, also used by `/api/epg-stats`; configurable from 1 MiB to the 150 MB hard cap |
| `MAX_ACTIVE_INTERFACE_BUILDS` | `2` | Concurrent addon build limit (maximum 8) |
| `ALLOW_LEGACY_CONFIG_TOKENS` | `false` | Temporary opt-in for old plaintext Base64 configuration links |
| `NODE_ENV` | (user value) | Standard Node semantics |

> Redis is optional. Without it, only in‑process LRU is used (per container).

---

## 🧱 Architecture (High-Level)

```
┌───────────────────────────┐
│      Browser Client       │
│ (Direct/Xtream Config UI) │
└──────────┬────────────────┘
           │ Pre-flight (fetch playlist & optional EPG)
           ▼
┌───────────────────────────┐
│      /api/prefetch        │  ← CORS bypass, size-limited, SSRF guarded
└──────────┬────────────────┘
           │ Token JSON
           ▼
┌───────────────────────────┐
│        server.js          │
│  - decrypt (if enc:)      │
│  - cache interface        │
│  - createAddon(config)    │
└──────────┬────────────────┘
           │
           ▼
┌───────────────────────────┐
│        addon.js           │
│  - load cache             │
│  - fetch provider data    │
│  - parse M3U / EPG        │
│  - build catalogs         │
└──────────┬────────────────┘
           │ Stremio resource routes
           ▼
┌───────────────────────────┐
│      Stremio Client       │
│  Catalog / Meta / Stream  │
└───────────────────────────┘
```

---

## 🔍 Series Handling

### Xtream JSON Mode
- Fetches `get_series`
- Per-series episode stream IDs and URLs are retained from `get_series_info`
- TMDb IDs identify movie and series records; all displayed movie, series and episode metadata is fetched from TMDb
- TMDb responses are cached server-side; set `TMDB_API_KEY` on the host
- Each episode remains streamable by its original Xtream ID

### Direct / m3u_plus / Heuristic
- Detects patterns:
  - `S01E05`, `S1E2`, `Season 2 Episode 4`, `Season 3 Ep 09`
- Groups by *base series name* (title with season/episode suffix removed)
- Builds synthetic series entities with episodes list
- Missing season or episode → defaults to `season=1`, `episode=0`

---

## 🛡️ Security Considerations

| Area | Current Defense | Recommendation |
|------|------------------|----------------|
| Server-side fetches | Reject private/reserved IPv4 and IPv6 destinations, pin DNS answers, revalidate redirects, cap response sizes and timeouts | Use public HTTP(S) provider and EPG URLs |
| Token Leakage | Newly generated tokens encrypted with AES-256-GCM | Set a strong `CONFIG_SECRET`; keep links private; rotate provider credentials if a plain token was exposed |
| EPG Size | Streaming byte caps and deadlines | Adjust `EPG_MAX_BYTES` for XMLTV feeds, up to the 150 MB hard cap |
| DoS / Abuse | Bounded caches, build/concurrency caps, per-IP fixed-window limits on `/encrypt`, public preflight, and tokenized addon requests | Limits are process-local; each replica maintains its own counters. Railway uses its validated `X-Real-IP` header, and Render trusts one configured proxy hop. |
| Sensitive credentials | New links use authenticated encryption; plaintext legacy tokens are disabled by default | Keep `CONFIG_SECRET` private, keep manifest links private, and rotate credentials if a plaintext token was exposed |

---

## 🧭 Usage Examples

### Direct Playlist (Plain)
1. Go to `/configure-direct`
2. Paste: `https://example.com/playlist.m3u`
3. (Optional) EPG: `https://example.com/guide.xml`
4. Copy manifest URL: `https://host/<TOKEN>/manifest.json`
5. Add to Stremio

### Xtream (JSON)
- Base URL: `http://panel.example.com:8080`
- Username / Password
- Leave “Use m3u_plus” unchecked
- Enable EPG (panel or custom)
- Install via generated manifest

### Xtream (m3u_plus)
- Tick “Use m3u_plus playlist”
- Optional output format: `ts` / `hls`
- EPG source choice + offset
- Install generated manifest

---

## 🧰 Local Testing (Catalog & Stream)

After configuration:

```bash
TOKEN=<paste-token>
HOST=http://localhost:7000

curl "$HOST/$TOKEN/manifest.json" | jq '.name,.version'

# TV catalog
curl "$HOST/$TOKEN/catalog/tv/iptv_channels.json" | jq '.metas[0]'

# Movie catalog search example
curl "$HOST/$TOKEN/catalog/movie/iptv_movies.json?search=action" | jq '.metas | length'

# Series meta (example ID)
curl "$HOST/$TOKEN/meta/series/iptv_series_<id>.json" | jq '.meta.videos[0]'
```

---

## 🧾 Logging & Debugging

| Mode | How |
|------|-----|
| Normal deploy logs | `LOG_LEVEL=info` (default): startup, provider refresh summaries, cache-load status, warnings and errors |
| Show diagnostic details | `LOG_LEVEL=debug` or `DEBUG_MODE=true` |
| Warnings and errors only | `LOG_LEVEL=warn` |
| Errors only | `LOG_LEVEL=error` |
| Per-token debug | Check “Enable Debug Logging” in UI |

Routine cache writes and per-item TMDb/OMDb request logs are suppressed. `LOG_LEVEL=debug` shows catalogue warm-up start, progress at 25%, 50%, and 75%, very slow catalogue/EPG requests, and aggregate metadata diagnostics. Warm-up completion reports provider-fallback counts and reasons in one line; it does not print a per-series list.

---

## 🗄️ Caching Strategy

| Layer | Scope | Contents |
|-------|-------|----------|
| In-Memory LRU | Per process | Addon data (channels/movies/series/epg) |
| Redis (optional) | Cross replicas | Provider data cache (JSON) |
| Build Promise Cache | Prevents simultaneous duplicate warm builds |

Cache key = SHA-256 of a normalized configuration subset, including provider credentials. The digest is never logged.

---

## ✨ Roadmap Ideas

- [ ] Genre filtering optimization
- [ ] Optional transcode / proxy (HLS rewriting)
- [x] Multi-EPG source merge
- [ ] Channel-to-XMLTV ID mapping UI
- [ ] Webhook or schedule-based background refresh
- [ ] Token revocation list
- [ ] Light theme toggle + user theme persistence
- [ ] Add channel favorites (local storage layer)

Want to help? See **Contributing** below.

---

## 🙋 FAQ

**Q: The playlist fetch fails with a CORS error.**  
A: The browser first attempt failed; server `/api/prefetch` will retry. Ensure `PREFETCH_ENABLED=true`.

**Q: EPG shows zero programmes.**  
A: The quick scan counts `<programme>` tags only. If compressed or gzipped, ensure server delivers uncompressed or extend prefetch to decompress.

**Q: Some logos missing.**  
A: The proxy tries multiple templates; contribute additional logo source patterns.

**Q: Secure token creation fails.**  
A: Set `CONFIG_SECRET` on the server to a long random value of at least 16 characters, then redeploy. New configuration links are encrypted; do not reuse or share old plain-token links.

**Q: Series episodes missing (M3U).**  
A: Ensure naming matches patterns (`S01E01` or `Season 1 Episode 1`). Heuristic grouping cannot infer arbitrary naming.

---

## 🧑‍💻 Contributing

1. Fork & branch: `feat/your-feature`
2. Keep changes modular (UI / provider / core)
3. Run lint/tests (add if expanding)
4. Open PR with:
   - Summary + reproduction steps
   - Performance / memory notes if heavy parsing changes
   - Screenshots (UI changes) preferred

### Code Style Guidelines
- Prefer async/await over callbacks
- Avoid blocking large buffers (stream if >10MB future tasks)
- Keep provider logic separated (`providers/`)
- Guard network operations with timeouts

---

## 🐞 Reporting Issues

Please include:
- Node version
- Hosting method (Docker / bare / serverless)
- Provider type (direct / xtream-json / xtream-m3u)
- Sample (sanitized) playlist or line count
- Logs with debug enabled only when needed (scrub credentials and tokens before sharing)

Create an issue: https://github.com/Inside4ndroid/IPTV-Stremio-Addon/issues

---

# ☕ Sponsorship / Support Development

Your sponsorship is vital in helping me achieve my goals. With your support, I can:

- Dedicate more time to developing and improving my projects.
- Cover costs for essential tools, services and premium hosting to run public projects.
- Provide detailed documentation and support for users.
- Every contribution, no matter the size, makes a significant impact.

[Sonate / Sponsor Me!](https://github.com/sponsors/Inside4ndroid)

Thank you for considering supporting my work!

---

## ⚖️ Legal Notice

This project **does not provide** IPTV content.  
You are solely responsible for ensuring that playlists and streams you load are legal in your jurisdiction.  
The authors are not liable for misuse.

---

## 📄 License

MIT License (see `LICENSE` file).  
Attribution appreciated but not required.

---

## 🧪 Serverless Note

The included `serverless.js` / `vercel.json` adapter is experimental and does not parse tokenized per-request configuration. It is not suitable for the normal Railway/Docker deployment path or for deployments that require durable volume-backed catalogue and metadata caches. Use `server.js` on a persistent Node service unless the adapter is completed for your platform.

---

## 🔍 Internal: Episode & Stream ID Patterns

| Kind | Pattern |
|------|---------|
| Live Channel | `iptv_live_<stream_id | md5>` |
| Movie | `iptv_vod_<stream_id | md5>` |
| Series | `iptv_series_<series_id | hash>` |
| Episode | `iptv_series_ep_<episode_hash | xtream_id>` |

---

## 🛠️ Example Encrypted Token Flow

```bash
# 1. Start server with CONFIG_SECRET
# 2. POST JSON config you would otherwise encode

curl -X POST http://localhost:7000/encrypt \
  -H 'Content-Type: application/json' \
  -d '{
        "provider":"direct",
        "m3uUrl":"https://example.com/list.m3u",
        "enableEpg":true,
        "epgUrl":"https://example.com/epg.xml"
      }'

# Response:
# { "token": "enc:..." }
# Manifest URL: https://host/enc:.../manifest.json
```

---

## 🧵 Troubleshooting Matrix

| Symptom | Likely Cause | Action |
|---------|--------------|--------|
| Buttons never enable | Manifest build error | Check server logs (addon build), ensure playlist accessible |
| 502 on `/api/prefetch` | Remote host blocked / TLS error | Try direct browser fetch or adjust server CA bundle |
| High memory usage | Massive playlist & no Redis | Increase RAM or add Redis to share cache across restarts |
| Missing search results | Stremio partial search | Use shorter, distinctive search terms; ensure case-insensitive |
| EPG times off | Timezone difference | Set `EPG Offset` in config (+/- hours) |

---

## 🧩 Extending Providers

Add new provider:
1. Create `providers/myProvider.js` exporting `fetchData(addonInstance)` and optionally `fetchSeriesInfo`.
2. Normalize items to: `{ id, name, type: tv|movie|series, url, poster/logo, attributes:{...} }`.
3. Update config UI to set `provider: 'myProvider'`.
4. Adjust `addon.js` logic if custom behavior needed.

---

## 🌈 Theming

Current UI theme mimics Stremio’s dark violet aesthetic:
- Accent gradient: `#7043ff → #c58cff`
- Panels: layered deep navy/indigo
- Accessible contrast for logs/forms
- Responsive overlay with progress stripes

Feel free to PR:
- Alternate light mode
- High contrast accessibility mode
- User theme selector (localStorage)

---

## ✅ Final Checklist (Self-Host Launch)

| Step | Done? |
|------|-------|
| Playlist reachable via server & browser | ☐ |
| EPG XML reachable (or disabled gracefully) | ☐ |
| `CONFIG_SECRET` set (if sharing public) | ☐ |
| Reverse proxy passes through paths | ☐ |
| Optional HTTPS cert configured | ☐ |
| Redis deployed (optional scaling) | ☐ |
| Firewall restricts internal networks | ☐ |

---

**Happy streaming!**  
For ideas, feature requests, or large refactors — open a discussion first so we can align on direction.  
PRs welcome ❤️

---
