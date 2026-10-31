# Fresh deployment and manual checks

The addon supports a long-running Node 22 or 24 service on Railway, Docker or a normal host. The incomplete serverless adapter has been removed.

## Railway configuration

For the setup described in this project:

| Setting | Value |
|---|---|
| Volume mount path | /app/data |
| PERSISTENT_DATA_DIR | /app/data |
| CONFIG_SECRET | A private, strong random secret; keep the existing value if installed addon links should keep working. |
| TMDB_API_KEY | Your existing TMDb key, if enrichment is wanted. |
| OMDB_API_KEY | Your existing OMDb key, if IMDb ratings/OMDb runtimes are wanted. |
| LOG_LEVEL | info for normal testing; debug adds limited slow-request diagnostics. |
| DEBUG_MODE | false unless debug output is specifically needed. |

The committed railway.json starts Node directly, requests one replica and allows 30 seconds of deployment draining. The application has a 15-second shutdown budget by default. Railway otherwise documents a zero-second default shutdown allowance; see the official [deployment reference](https://docs.railway.com/deployments/reference). If you use a different deployment configuration, allow at least 30 seconds before forced termination. Docker Compose includes the same 30-second grace period.

The directory value must match an actual attached volume. A writable directory alone does not prove it survives deployment. Startup checks directory creation, writing and atomic rename; a configured path that fails these checks prevents the service from becoming healthy. The health route verifies the HTTP service and storage checks, not completion of all catalogue enrichment.

Keep one process writing to each cache directory. Optional Redis accelerates caching; it does not coordinate multiple file writers. Keep staging and production storage separate. Use an OMDB_DAILY_REQUEST_LIMIT that matches the account allowance and account for other services using the same key. Clearing a volume removes the local usage counter without resetting the provider account's real usage.

No new metadata settings are required. The existing defaults remain:

- Provider catalogue/guide refresh: 12 hours, with hourly due checks.
- Missing metadata and incomplete/failed runtime lookup retry: 12 hours.
- Complete metadata and successful runtime-average refresh: normally 14 days.
- Failed provider/guide refresh recheck: normally one hour.
- Full enrichment of each requested catalogue/search page before its cards are returned.

EPG sources now process in configured order by default. This gives earlier feeds priority when the aggregate retained-programme/text limit is reached. EPG_FETCH_CONCURRENCY=2 to 4 enables parallel processing if preferred; those workers share the same cap, so arrival order can affect retention at that cap. A limited guide is explicitly marked in saved state and logs, and follows the normal guide interval rather than repeatedly retrying an unchanged size limit every hour. Network/source failures retain their separate retry behavior.

For a private setup, SETUP_PASSWORD optionally protects setup pages, token creation and preflight with an owner login. It must contain at least 16 characters; SETUP_USERNAME defaults to admin. Use HTTPS. Leaving it unset keeps the public configuration flow. Installed token routes continue to work. The original donation recipient is retained in an isolated frame; its script has no same-origin access to the configuration form.

## Starting with an empty volume

1. Deploy the reviewed version with the volume and directory configured consistently.
2. Look for the startup storage-check result. Create or open an addon configuration to start provider loading; an unconfigured server has no provider account to warm.
3. With no saved snapshot, the first provider load must finish. Movie and series metadata scans then run in the background. An individual first page still waits for its available card metadata, so a cold load can take longer than a warm one.
4. Keep the configuration token/private installation URL safe. Do not post provider URLs, credentials or the token in public logs/issues.
5. Allow the initial scans to finish. Missing-field totals can remain nonzero when sources do not provide the information. The logs distinguish incomplete records from retries currently due.
6. Redeploy gracefully without replacing the volume, then confirm the saved catalogue, card metadata and opened-series details are restored. This is the check that demonstrates your host is using the durable volume.

The runtime policy remains: valid series-level TMDb, provider or OMDb runtime first; otherwise use a TMDb episode average across regular seasons, excluding known future air dates. Provider episodes are fetched on demand for playback/detail pages and are never used for bulk background runtime averages or TMDb ID recovery.

## Manual Stremio checks

| Area | Checks |
|---|---|
| Discover | First 50 cards, a later page and a genre filter retain available descriptions, artwork, dates, ratings and runtimes before display. |
| Search | Exact titles rank ahead of broader matches. Law and Order / Law & Order match equivalently; apostrophes and accents retain existing behavior; typo-only matches remain disabled. |
| Movie details | Description, year/release, cast/directors, rating, artwork, trailer where available, and playable stream URL. |
| Series details | Episode list, season selection, episode titles/dates/thumbnails/overviews and stream loading. The series runtime agrees with its card. |
| Live and EPG | Live playback, current/next programme and day guide. Real programme durations remain. The artificial channel runtime Live is omitted. |
| iOS | Writer credits remain available on details. Other clients retain their existing writer filtering. |
| Devices | Test playback on the actual Windows/iPhone/Firestick players you use; source certificate/codec/network compatibility is independent of metadata-cache success. |
| Setup | Direct and Xtream setup, edit/save, cancellation/retry, clipboard copying and the original donation button. |
| Refresh/restart | Wait for the scheduled refresh and verify cards/guide; redeploy on the same volume and confirm saved data loads. |

## Automated checks

Run npm ci, npm test and npm audit. CI covers Node 22/24 on Linux, Node 22 on Windows, and a production Docker image that saves/restores all three persistent stores across separate containers on a fresh named volume as the non-root runtime user. Tests use fabricated providers and temporary storage; they do not access your account or volume.

Passing these checks supports a manual staging test. It is not a guarantee that external providers always return complete metadata or that every player can decode every provider stream.
