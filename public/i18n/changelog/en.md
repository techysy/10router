# Changelog

User-facing highlights per release. See [CHANGELOG.md](https://github.com/techysy/10router/blob/main/CHANGELOG.md) for the full developer log.

## v1.4.0 (2026-10-10)

### ✨ New

- **Daily token limit per API key** — every client key can carry a daily cap (e.g. 100M/day); over the cap, `/v1/*` returns 429 `rate_limit_error` until the server's local midnight reset. A global master switch lives on the Endpoint page; limits can be edited or cleared per key at any time, and each row shows today's usage share live.
- **Quota card icons link to provider sites** — the provider logo on every quota card now opens the provider's website/console in a new tab.
- **"Hide zero-balance provider cards" toggle** — a second view filter on the Experiments page: connections whose packs are all at 0 balance/credits can now be hidden wholesale, independent of — and stackable with — the existing "hide cards with no quota" toggle.
- **"Needs re-auth" account state** — when an OAuth account's refresh token becomes unrecoverable, the connection row lights up "Needs re-auth" and the account is cooled down for 24h instead of being hammered every 2 minutes; re-authorizing recovers it instantly.
- **CodeBuddy catalogs aligned with the official credit page** — the international line gains the entire Claude family (Opus 5.5 / Sonnet 5.5 and 6 more), Grok-4.7, Gemini-3.8-Flash and GPT-6.1-Sol; the CN line gains GLM-5.3-FlashX (0.14x) and StepFun Step-5-Preview (0.43x); Space-Bunny returns to 0.08x as the promo window ends. New "Paid tier" and "Subscription priority" model badges.
- **New OpenCode / Token Harbor models** — the OpenCode paid lines pick up freshly listed models including Claude Haiku 5.5 (capability declaration corrected to 1M context); Token Harbor gains `claude-haiku-5.5:free`.
- **Trae Free catalog aligned with upstream** (issue #54) — 18 models added, 10 removed that upstream delisted.
- **CreditDaddy gateway status on the free-provider cards** (issue #49) — already shipped in the revised Windows v1.3.5 assets; this release brings it to every channel.
- **Platform-clustered release asset names** — Windows / macOS / fnOS packages now follow a `Name-Platform-…` convention, so same-platform assets sort together on the Release page.

### 🐛 Fixed

- **Combo context windows now reach clients** — combo entries previously wrote the aggregated capability only into a nested block; clients matching the top-level `context_window` got nothing and guessed the window from the model name — too high — until the upstream hard-failed.
- **Streaming accounting corrected both ways**: a client disconnecting right after the full answer no longer records a failure (issues #48 / #50); a truncated clean EOF no longer records success — it is logged as "truncated"; dropped malformed SSE data lines are now counted and shown in the request detail.
- **Refresh-token handling, three fixes**: a failed persist of a rotated refresh token now errors immediately instead of silently reusing the dead token and getting the whole account signed out upstream; sql.js flush failures reschedule with backoff; when the automatic 401 → refresh → retry fails, the real upstream reason is surfaced to the client.
- **StepFun CN real-name gate no longer misreported as "out of quota"** — the 403 for incomplete face verification no longer locks the model for 2 minutes; the dashboard links straight to the real-name page and combos pass through to the next candidate instantly.
- **GitHub Copilot quota split per category** — chat / completions monthly windows are no longer summed into the resource-pack total, matching the Antigravity presentation.
- **Custom connection names shown first** — connection rows no longer bury a user-set name behind the account's username/email.
- **Model catalog and capability corrections** — clients now receive context/output ceilings aligned with each provider's real values (alias drift, catalog lookup misses and combo aggregation gaps fixed together).
- **Windows installer, three fixes**: upgrades no longer pop "unable to close" or run the old version's uninstaller; a declined UAC prompt no longer fails silently.
- **fnOS packaging fix** — the standalone build's bundled slim `next` module is no longer overwritten (the root cause of installs that would not start).

## v1.3.5 (2026-10-05)

### ✨ New

- **CreditDaddy gateway status on the free-provider cards** (issue #49) — the ZCode Free / MiniMax Free / Trae Free cards now probe the local gateway port (server-side TCP probe) and show at a glance whether CreditDaddy's gateway is reachable, with a download link and guidance when it is not.
- **New Trae Free provider (`trae-free`)** — use Trae (SOLO) remote-agent credits through the local CreditDaddy gateway, same wiring as ZCode Free / MiniMax Free: no login card, shared host/port with a per-line path, 12 models (Doubao Seed Code, MiniMax M2.7, GLM 5 family, DeepSeek V4, Kimi K2.5/2.6, Qwen 3.5/3.6) and thinking-stream support. Its card now shows the official Trae (SOLO) desktop icon, extracted from the client executable.

### 🐛 Fixed

- **Upgrading no longer hits the "cannot close 10Router" dialog (Windows installers in-place updated)** — the installer now removes the previous version's uninstaller entry itself and skips that frozen code entirely, preventing the ghost-process dialog and silent exit code 2; user data is untouched.
- **A stream that dies mid-flight no longer leaves a green 0-token "success" row** (issue #48) — streaming requests write a placeholder row up front, and it was marked successful before the stream had produced anything. When the upstream then dropped, the abort path never touched the database, so that row was never corrected: a killed request sat in the Details list looking like a completed, free one. In-flight rows now read as in-flight, and an aborted stream is recorded as failed.
- **One model failing no longer marks the whole connection unavailable** (issue #46) — this was the root of it: the per-model lock was being written alongside an account-level "unavailable" flag, even though routing only ever consulted the per-model lock. Sibling models kept working while the connection showed as dead. The flag is now only set for genuinely account-wide failures.
- **A 404 on the CreditDaddy lines is no longer reported as "model not found"** (issue #47) — CreditDaddy moved its gateway endpoints to brand-scoped paths (`/gateway/zcode/…`, `/gateway/minimax/…`, `/gateway/trae/…`), so a 404 means the endpoint, not your model. The message now says so, and the card tells you what to check: that the path keeps its brand segment, and that a CreditDaddy build from before the rename still serves only the old unbranded path and should be upgraded.
- **A partially rate-limited connection now shows amber, not red** (issue #46) — a connection with one model in cooldown is still serving its other models, so it gets its own "Partial" state instead of being painted as a dead account. The status rule also had four hand-written copies that could disagree; they now share one implementation.
- **One model's quota running out no longer reads as "this account is unavailable"** (issue #46) — Google/Antigravity quota is bucketed per model, and so is the lock we store, but the message always said the account was used up. Other models on the same connection keep working for the whole window. The message now names the model and says so; requests that genuinely exhaust the whole account are worded as before.
- **Usage Overview is no longer empty while Details lists 0-token rows** (issue #48) — the two tabs read different tables, and a response that carried no token counts was dropped entirely from one while still being written (as 0 in / 0 out) to the other. The streaming path always estimated a fallback; the non-streaming paths did not. Both tabs now show the same, estimated, counts. Estimates are recorded in the dashboard only — the usage reported to your client is still exactly what the provider returned.
- **Auto-compact default trigger ratio 0.9 → 0.95** — auto-compaction now fires closer to the context limit (threshold levels and the master switch are unchanged; still adjustable on the "Experimental" card).
- **Claude Code / mirasim no longer force compaction at 160K** — the model list reported context windows using the OpenAI convention only, so Claude CLI fell back to its built-in 200K default and started compacting models like Qwen3.8-Max (1M actual) client-side. The Anthropic-convention field is now published as well, so clients read the real window.
- **Dashboard model cards no longer show 1M models as 200K** — Qoder (`qd` / `qdc`), Kiro (`kr`), CodeBuddy CN (`cbcn`) and Antigravity (`ag`) resolved capabilities by alias and fell through to the 200K floor (losing the vision / reasoning badges); Kiro's gpt-5.6 models additionally read a 1.05M window, 5× the real 272K. All four lines are now normalized to the correct 1M values.
- **Trae Free card icon now shows** — the integration shipped without the icon asset, so the card fell back to plain text initials while other screens showed a different (colored) mark. The card now uses the Trae (SOLO) desktop mark everywhere.
- **Trae Free gateway host/port settings now apply** — a missed code path in this release's integration meant LAN host and port configuration had no effect for Trae Free; requests still went to the default local address. Fixed.
- **Qoder plan credits no longer vanish without explanation** (issue #44) — when a CreditDaddy-synced web session expires, the plan-credits row silently fell back to an aggregate that reads zero. The quota card now warns that the session expired, and importing connections validates each account's web session and names the failures.
- **Windows upgrade installs no longer stall on "cannot close 10Router"** — the old app runs elevated (required for MITM on port 443), which a normal-permission installer could not kill. The installer now requests one administrator prompt to close it; declining falls back to the previous behavior, never worse. Both `10Router.Setup` and `10Router-Web-Setup` are covered.
- **Desktop update downloads are now timeout-protected** — a stalled network no longer hangs the update flow forever, and failures clean up leftover temp files.

## v1.3.3 (2026-10-04)

### ✨ New

- **New MiniMax Code Free provider (`minimax-free`)** — use MiniMax free credits (M3.1-Flash-Preview / M3 / M2.7) through the local CreditDaddy gateway, same wiring as ZCode Free: no login card, shared host/port with a per-line path, official icon and a gateway-settings section on the detail page.
- **MiniMax capability wiring matches the official client** — M3.1-Flash-Preview exposes the five official thinking-depth levels (default/low/medium/high/xhigh/max) as pass-through; M3 thinking is an on/off toggle; context reported as 1M.

### 🐛 Fixed

- **zcode-free gateway endpoint** — the ZCode gateway path now carries the `/zcode` segment, matching CreditDaddy's migration (the MiniMax line already used the same shape).
- **CreditDaddy gateway card** — the path field now shows the value that actually takes effect (prefilled, not a hidden placeholder); the remote-access instructions were corrected: the gateway is protected by an IP allowlist and checks no key, so there is nothing to enter (the old text wrongly asked for a key-bearing connection).
- **CodeBuddy CN no longer blocks tool-heavy Claude Code / codex sessions** — the `>60 tools` local cutoff locked out real MCP sessions; tool count is now reported in the rejection diagnostic only, with the 3.2MB size and message-count guards unchanged.

## v1.3.2 (2026-10-03)

### ✨ New

- **Desktop: unified HTML update window** — checking, download progress, cancel and install all live in one branded window consistent with the dashboard; fixed stray scrollbars under Windows fractional display scaling.
- **Desktop: "Update via desktop shell" button** — when the dashboard finds a new version, one click hands the download → SHA-256 verify → install flow to the tray shell; works from remote dashboards (LAN / Tailscale) too.
- **Desktop: installer & About window match the dashboard design language** — the installer/uninstaller gain a branded sidebar; "About 10Router" moved from the native dialog to a branded window.
- **Fixed: Windows upgrades no longer blocked by stale processes (important)** — the old uninstaller could not kill the background service, failing upgrades with "cannot close"; the new installer clears processes up front and the app stops its service deterministically on quit.
- **Space-Bunny added to CodeBuddy CN** (0.03x limited-time, 10/2–10/7); **APInex is back** with a live-refreshed 36-model catalog (free tier grown to 18).
- **Vendor catalog & icon refresh** — Token Harbor free tier gains qwen3.8-flash / mimo-v2.6-flash (1M window, vision); fledge-alpha-free capability row; Atria key link points to the official console; new official icons for Atria / Token Harbor / OpenCode Zen; Dahl Inference retired.

### 🐛 Fixed

- **Model capability reporting is complete** — login-free vendors (zcode-free etc.), custom models of unconnected vendors (opencode-zen etc.) and login-free static models now all publish "context window / max output" so clients stop guessing.
- **Cache hit rate algorithm fixed** — cache-dense requests are no longer silently dropped from the stat (684 rows); cache-write tokens count toward the denominator, making the number honest (agent traffic legitimately sits in the high 90s).
- **Provider detail page** — invite code chip no longer shows twice; provider notice texts fully translated (zh-CN / zh-TW).

## v1.3.1 (2026-10-02)

### ✨ New

- **GLM Coding: Z.ai OAuth sign-in (dual-auth)**: browser authorization alongside pasting an API key; quota cards work with either.
- **New Meta Muse provider (OAuth + model catalog)**: Meta's official Muse Code channel with device-flow sign-in; five Muse Spark models at official pricing.
- **New System One decision provider v1m (v1m.ir)**: a second Jev-compatible decision backend alongside Drex.
- **Codex exposes GPT-6 / GPT-5.6 `[1m]` long-context variants**: 872K window — just suffix the model name with `[1m]`.
- **Experimental "nested cycle quota bars"**: a toggle on the Experimental page restores the concentric nested track for rolling ⊂ weekly ⊂ monthly chains.

### 🐛 Fixes

- **Four upstream 9router v0.5.95 port batches (20+ items)**: codex CLI identity bumped to 0.159 plus a fix for accounts being logged out by auto-ping (refresh-token reuse); grok-cli bumped to 1.0.44 (upstream 426 wall); codebuddy 6004 rate-limit → precise cooldown; Claude trailing-turn retention and thinking-format adaptation plus tool-loop cache breakpoint; new Claude Sonnet 5.5 / Kiro Opus 5.5 models; official GPT-6 pricing and real context windows; same-name tool dedupe for DeepSeek; broader Gemini tool-schema cleaning; strict proxy no longer falls back to direct connections on resolution failure; Responses completion watchdog.
- **Quota fix pack**: reset dates become adaptive countdowns (day+hour / hour+minute / minute+second); the 5-hour timeline centers on now (±12h); the monthly window anchors the bottom of the card; qoder / qoder-cn Auto & Efficient tiers and display-name aliases no longer fall to default capabilities.
- **Sign-in & security**: enabling "Require login" no longer kicks you to the login page; the "Forgot your password?" entry is localized and documents the reset-password file format (any extension works — .txt, .md, …); hidden providers are excluded from usage stats.
- **Drex key link now points at the official invite registration** (Nace is invite-only).

## v1.3.0 (2026-10-01)

### ✨ New

- **CLI Tools "Model Combo Profiles" (Claude Card, #17)**: The Claude tool card introduces a Profiles section, enabling you to save Opus/Sonnet/Haiku mappings, API Key, and context window settings as named presets. Selecting a preset from the dropdown instantly writes to `~/.claude/settings.json` without requiring an Apply click (parity with CC-Switch). Profiles persist server-side and synchronize across NAS, Tailscale, and tunnel connections.
- **Quota Visualization Redesign: QuotaToolbar & Window Timeline**: The usage view features a responsive quota toolbar and cycle timeline (`QuotaWindowTimeline`), visualizing rolling reset countdowns across providers. Includes a non-persisted view tab toggle ("Cards" vs. "Quota windows") that always defaults to Cards on fresh page loads. Segmented pack bars align with CreditDaddy visual semantics with absolute nearest-expiry displays.
- **New Search & Fetch Providers: TinyFish & Keenable (#26)**:
  - **TinyFish** (Free Tier): Full automated support for Web Search and Web Fetch with zero balance deduction;
  - **Keenable** (Standard API Key): Realtime/pro search modes and high-fidelity webpage scraping with `live=true`;
  - Seamlessly integrated across Media Providers and `/v1/search` / `/v1/web/fetch`.
- **ZCode Free Trial Provider (`zcode-free`)**: Route Start Plan and Trust Build credits (GLM-5.3-Flash) through CreditDaddy desktop gateway, supporting remote/LAN gateway host configuration and detailed architecture documentation.
- **Qoder Itemized Resource Packs via CreditDaddy Web Session**: Uses synced browser cookies to directly query exact per-pack remaining credits and expiration dates from the web console, avoiding heuristic approximations while validating account ownership.
- **LongCat-2.5-Preview & International Portal**: Added LongCat-2.5-Preview (1M context, multimodal image/video input, thinking mode toggle) and separate `longcat.ai` provider card.
- **Desktop In-Container Password Management (`639f77a8`)**: Automatically captures and auto-fills credentials for web apps running in desktop shell containers (WorkBuddy, CodeBuddy), securely encrypted at rest via OS-level safeStorage (DPAPI).
- **System Theme Adaptive Mode**: Login and dashboard interfaces automatically track OS day/night mode, powered by pre-paint scripts to prevent screen flashing.

### 🐛 Fixes

- **Adaptive reset countdowns**: quota cards and pack bars no longer show a bare reset date — future resets now read as a countdown whose precision follows magnitude (day+hour / hour+minute / minute+second), with the full absolute time still on hover.
- **5-hour quota view centered on now**: the timeline axis is now the 12 hours around the current moment instead of the calendar day, so "now" always sits mid-track instead of clamped to the right edge by evening.
- **Usage Input Tokens Normalization**: Fixed an issue where prompt tokens on unfolded Claude usage shapes were overridden by cached token counts, resolving the 1:1 display skew for high-cache providers like `zcode-free`.
- **Fresh Install Static Model Exposure**: Ensures `noAuth` providers (opencode, mimo-free, zcode-free) expose models in `/v1/models` on brand-new installs with empty connection tables.
- **OpenAI Responses Content Filter Mapping**: Correctly maps Responses `incomplete_details.reason === "content_filter"` to Chat completion `finish_reason: "content_filter"` instead of `"length"`, preventing client SDKs from assuming context cutoffs.
- **Schemeless Proxy Normalization & Leak Prevention (#36)**: Accepts proxy URLs without explicit schemes (e.g. `127.0.0.1:7890`, normalized to `http://`). Keeps encrypted strings on parse failures to strictly prevent direct IP leak fallbacks.
- **Antigravity Upstream Stability**: Removed obsolete `requestType: "agent"` to eliminate spurious 429 errors; fixed empty string tool response 400s; added bidirectional long tool name mapping; reinforced tool schema sanitization with local `$ref` resolution.
- **Strict Bare Model Resolution (#34)**: Rejects unknown bare model names with a clear 400 error rather than guessing upstream providers and producing misleading 404s.
- **Remote Provider Management Authorization (#38)**: Restored permission for valid virtual dashboard keys to POST `/api/providers` and `/api/provider-nodes`.
- **MITM Security Hardening (#31)**: Passed `ROUTER_API_KEY` via stdin in sudo invocation scripts rather than leaking it through process command line arguments.

## v1.2.1 (2026-09-26)

### 🔒 Security

- **[Important] Locked out after turning on the log-in check (#33)**: with no password of your own, switching "Require login" on left only the hidden first-login password (on fnOS it is generated at install time into a file you never see), so every password you tried was rejected. The log-in check can no longer be turned on before you set a password, empty passwords are refused, and there is now a way back in: **"Forgot your password?"** on the login page. On fnOS, just enter a new password in **App Center → 10Router → Settings**; on any install, drop a `reset-password` file into the data folder.

### ✨ New

- **CreditDaddy integration: read-only quota overview for external dashboards**: `GET /api/usage/quotas` returns every quota-capable connection in one call, normalized the same way as the dashboard's Provider Limits, and accepts a dashboard virtual key (`sk-…`). Results are cached for 5 minutes; a forced refresh (`?force=1`) is limited to once per connection every 30 seconds, and simultaneous requests share one upstream call. No credentials are returned — note that account emails are visible to anyone holding a virtual key.
- **Imported usage now shows an estimated cost**: rows synced in by the 10router-sync plugin or CreditDaddy used to land at $0. New imports are priced on arrival, and existing history is repaired automatically at startup (a source-computed cost is never overwritten; models without a price stay at $0).
- **The "log-in check is off" banner can be hidden**: Settings → Security gains a switch under *Require login*, shown only while the check is off. Hiding the banner takes a confirmation, and it comes back automatically once you turn log-in back on and off again.
- **Automatic update checks can be turned off** (Settings → Security): for installs pinned to a version on purpose. When off, 10Router no longer contacts the update server on its own or shows new-version notices — the dashboard, the tray balloon and the CLI launcher all go quiet. "Check now" and the tray's "Check for updates" still work.
- **Encrypted OAuth import/export on single-auth cards**: the transfer buttons now appear on OAuth-only cards as well — most importantly **MiMo Desktop**, whose signed-in session is the credential you move between machines.
- **Official Qwen pricing**: new-generation Qwen flagships were priced at the cheap wildcard rate (e.g. qwen3.8-max billed at a quarter of its real price); they now use the official per-model rates.

### 🐛 Fixes

- **[Important] After a restart, remote access stayed down until someone opened the dashboard**: tunnel / Tailscale / MITM auto-resume and the other startup tasks only ran on the first page render — on a NAS used purely through `/v1` they could wait indefinitely. They now start with the server.
- **Qoder's queue throttle was returned as the model's reply**: a queued request (`10605`) reached the client as `[qoder error 403: …]` text and was logged as a success. It now fails over to the next account and cools the throttled one for the time Qoder asks for (about 30 seconds).
- **OAuth transfer import was blocked on passwordless dashboards** even from the machine itself; same-machine imports work again.
- **10router-sync plugin v1.5.0**: follows ZCode's new plan-channel ids (Start Plan traffic had stopped syncing since 09-18), counts mirasim cache in input so dashboards stop showing "input 638, cache 113M", and the mirasim correction script no longer adds the cache twice.

### 🔧 Other

- **Auth header names aligned with 10Router**: `x-10r-cli-token` / `x-10r-password` replace the inherited `x-9r-*` names. The old names are still accepted, so existing CLI launchers, plugins and scripts keep working.

## v1.2.0 (2026-09-24)

### ✨ New

- **Xiaomi MiMo splits into three cards, each owning its own account**: cloud (`xiaomi-mimo`: browser sign-in / API key, standard billing), Desktop (`mimo-desktop`: session comes from the MiMo Desktop app signed in on this machine — no API key), and Token Plan (`tp-` subscription keys). One card used to cover two credential kinds, so weekly quota and connection tests were judged by the looser side — the cloud card advertised a desktop-only weekly quota it cannot read. Existing connections created wrong under v1.1.3 are moved back by a migration.
- **MiMo V2.6 in, V2.5 retired**: the whole V2.6 line is in, and MiMo models now declare a **real context window** (1M / 128K output; they previously fell through to guessed defaults). **V2.6 Pro UltraSpeed** joins the cloud and Token Plan cards — a custom-service model: usable straight away with a contract, an upstream error without one, and nothing you have to add by hand.
- **Full StepFun integration**: four channels — China / international × pay-as-you-go / Step Plan — with short aliases `step-cn` / `step` / `stepp-cn` / `stepp`. Step Plan channels spend subscription Credits, expose a native Anthropic API (Claude Code can connect directly), and add the plan-only `step-router-v1`. LLM / TTS / STT are isolated per menu (image generation is not exposed — the provider announced its shutdown); live balance and voucher queries included.
- **ComfyUI local image generation**: connect a local ComfyUI, checkpoints are discovered automatically, SD / SDXL / Flux text-to-image workflows are assembled and served through `/v1/images/generations`.
- **Media provider lists are now drag-sortable with connected-first ordering**, sharing one sort and persistence model with the main providers page; `/v1/models` order follows suit.
- **Combos gained an "switch on empty reply" strategy** (off by default): upstreams that express content filtering as an HTTP 200 empty stream now fall through to the next model — at most 2 by default. Replaying re-bills the full input context, so be careful with large-combination prompts.
- **Pick the model for a one-by-one connection test**: the dropdown defaults to "provider default" because some credentials only cover part of the catalogue — a Desktop session only reaches the desktop models. Qoder now verifies the chosen alias against **that account's live model list** (free), and Qoder CN no longer answers "not supported".
- **"Hide no-quota" moved to Settings → Experimental**, as the quota toolbar had run out of room.

### 🔒 Security

- **No built-in default password.** With no password set (and no SSO) the dashboard **opens on this machine only**; remote requests are refused with a pointer to set one. `INITIAL_PASSWORD` is the only non-interactive bootstrap password. **If you used the old default to sign in from another device, set a password on the host once after upgrading.**
- **Provider credentials are encrypted at rest** (AES-256-GCM), with the key kept outside the database (`$DATA_DIR/credential-key`, or set `CREDENTIAL_SECRET`). A copied or synced database is no longer a credential dump. **Back the key file up with the database — without the key, credentials cannot be recovered.**
- **Usage logs no longer store full API keys** — a readable prefix plus a one-way digest; per-key stats keep working.
- **New Security card (Settings → Experimental)**: listener, password and log-in-check state, effective access and credential storage in one place, plus a **"dashboard: local access only"** switch that applies per request (the `/v1` gateway is unaffected). A warning banner sits on every page while no password is set or the check is off, and turning the check off now needs confirmation.
- **Sessions tightened**: 24h shortened to 2h with sliding renewal (no interruption while working), and this version adds an **absolute cap** — re-authentication after 30 days from the original sign-in, so a stolen session cannot be extended forever.
- **fnOS no longer resets the bootstrap password on upgrade.** The random password now lives in the data directory, which survives upgrades; previously every fpk upgrade replaced it and locked out anyone using the old one.
- **A backup taken with the wrong key no longer silently drops credentials**: it keeps the ciphertext and warns that the original key is needed to restore it (it used to report "downloaded" with none in it).
- **`/api/health` no longer echoes local paths** — the raw driver-load error it returned routinely contained absolute paths.
- **Key files on Windows are restricted by ACL** (encryption and session secrets, like the Root CA key already was); the MITM sudo password no longer encrypts with a fallback key hardcoded in the source.

### 🐛 Fixes

- **[Important] Starting with the wrong key permanently destroyed stored credentials**: restoring the database onto a machine without its key and starting once erased every OAuth token and API key, beyond recovery even after the key came back. Ciphertext is now preserved and comes back with the key.
- **[Important] Some response streams were malformed**: the stop-sequence guard injected its holdover line without a separator, merging it into the terminating frame so some clients (official SDKs included) failed to parse it; Anthropic responses also lacked the event line and used a hard-coded block index. All fixed, and non-text blocks are now dropped whole after a cut (they used to remain as an argument-less tool call a client might execute).
- **[Important] A reply that only called a tool was treated as empty**: with "switch on empty reply" enabled, a model choosing to call a tool was discarded and the next model **re-billed the entire input context**. Tool calls and reasoning now count as content, and the abandoned call's usage is still recorded.
- **Claude Code's auto-mode classifier was always unavailable through the gateway (#18)**: some upstreams accept `stop` / `stop_sequences` and ignore them. The gateway now enforces the client's stop contract in the streaming relay (the sequence itself is not emitted, usage accounting is kept, a truncated `length` is rewritten to a proper stop) and maps stop parameters in both translation directions.
- **MiMo browser sign-in was completely broken over LAN / HTTP**: OAuth `state` generation relied on an API that only exists in secure contexts, so clicking "browser" from another device via `http://LAN-IP` — the normal way a NAS install is used — threw before the flow could start.
- **SiliconFlow CN's short alias was hijacked**: `sfcn` was claimed by two providers, so SiliconFlow requests went to StepFun. It is back with its owner, and a global alias-uniqueness check guards the class.
- **StepFun connection tests answered "not supported"** even for healthy keys; they now run the standard OpenAI-compatible check.
- **Token Plan browser sign-in routed to the wrong cluster**: chat / TTS / connection tests went to the pay-as-you-go host; they now follow the endpoint the platform handed back and we stored.
- **Quota page display and interaction**: under a view filter, "Showing 1-10 of 46" disagreed with the cards on screen (it now reports what is rendered); clicking several "Hidden" chips quickly dropped most of the clicks (five restored two) — all land now; and "Only with balance" is reconnected to manual hiding, so bulk-hidden rows appear in the "Hidden" list and can be brought back by name.
- **Per-key usage merged every key on a machine into one bucket** — the grouping key was a mask identical across keys on the same machine; it now groups by key digest.
- **MiMo miscellany**: an exhausted weekly quota no longer dumps the provider's raw JSON into the connection row; bare TTS model names are no longer silently rewritten; pending browser-login sessions are capped at 8, matching the desktop app.

### 🔧 Other

- Restored 258 UI translations that had gone dead behind the brand rename (they were silently showing English).
- Expiry countdowns no longer collapse across days: 41 hours is `1d 17h`, not `1d`.
- The dashboard's Change Log now only renders released versions — you will not be told about features you do not have yet.
- Installers and docs no longer point users at an unrelated fork's package name.

## v1.1.3 (2026-09-20)

### ✨ New

- **Qoder CN fully restored + daily credits auto-claim**: qoder-cn OAuth device-code / PAT auth, model catalog and usage tracking are back; daily credit auto-claim (experimental toggle + per-card manual claim) with per-pack resource-package display (individual expiry dates, first-expiry-first-spend); official Qoder icons plus live Qwen price multipliers and off-peak half-price countdown.
- **Per-model context-window / max-output pins**: a tune icon on every model row (including auto-discovered ones) overrides `contextWindow` / `maxOutput`; leave blank to fall back to defaults. Applies to model listings and usage accounting alike.
- **Server-side auto-compaction for oversized contexts**: when a request is estimated past 90% of the effective window (threshold selectable 80/90/95%, on by default), older turns are summarized by the same model before dispatch — clients that don't self-compress (ZCode / OpenClaw / custom agents) no longer hit "prompt is too long", with reasoning models handled too; any failure passes the original through untouched. Master toggle lives under Experimental.
- **Drag-to-reorder provider cards** with persistence; disabled providers auto-sort to the bottom; the model API listing now follows card order.
- **OpenCode Free anti-abuse fix, enabled by default**; Antigravity image models added (gemini-3-pro-image / imagen-3.0 etc.); 10router-sync plugin v1.5.0 (ZCode plan-channel id adaptation + sync hardening).

### 🛠️ Improvements & Fixes

- **CodeBuddy CN strict-gateway tool-schema compatibility**: tool parameter roots shaped as anyOf/oneOf/allOf, `$ref` or type arrays are now downgraded to a plain object root before forwarding, fixing whole-request `11129` rejections from clients like ZCode (#27).
- **Quota reset badge no longer disappears**: recurring windows (e.g. MiMo weekly quota) keep showing "resets in N days" even when fully drained.
- **Qoder quota parsing fix**: daily/campaign credits on free accounts no longer show 0/0.
- **CodeBuddy intl DeepSeek reasoning_effort mapping fix** (#23).
- **Stability backports**: 4xx request-level errors no longer trip healthy accounts; successful connection tests clear stale backoff locks; stalled silent streams report in-band error frames instead of looking like normal short replies.

## v1.1.2 (2026-09-18)

### ✨ New

- **Usage dashboard overhaul**: Lifetime stats cards, a GitHub-style activity heatmap (day/week views with hover details), and a node health score table (success rate / latency / speed weighted, expandable per-model rows) on the Usage Details page. The unit-abbreviation toggle now applies globally — overview cards follow the same switch.
- **Xiaomi Token Plan egress-region matching**: Adding or editing a connection auto-selects the cn / sgp / ams cluster based on your network egress (multi-source probing, fail-open), and the connection test button now routes to the selected cluster. MiMo 429 responses carry friendly guidance, and cooldowns honor the upstream "retry after N seconds" hint.
- **10router-sync plugin v1.4.0**: New `/10router-sync:status` command — instance status and today's usage without opening the dashboard.

### 🛠️ Improvements & Fixes

- **CodeBuddy 11128 channel-level circuit breaker**: Channel-wide risk-control hits now trip a provider-level cooldown (no more per-account retry bursts amplifying risk), with bilingual guidance in the error response; extreme request sizes are backstopped locally.
- **Credential auto-refresh fixed (Cline / ClinePass)**: Background refresh no longer fails with 400 — credentials renew automatically before expiry; dead credentials are explicitly flagged as needing re-authorization.
- **Provider & chart cleanup**: Retired public endpoints removed; OpenCode Free / MiMo Code Free moved to a hidden-by-default "Trial" category; model family aggregation fixed (gpt-6, hy4, qwen3.8 etc. are no longer split); Model Type chart legend moved to the top-right with mobile responsiveness.
- **Security**: The single-connection API no longer echoes the Xiaomi desktop session credential in plaintext.

## v1.1.1 (2026-09-14)

### ✨ New

- **Earliest Expiry First multi-account routing strategy**: Solves the pain point of repeatedly exhausting a primary account while short-term promotional packages on other accounts expire unused. A dedicated toggle on the provider details page automatically prioritizes valid packages closest to expiration, with zero blocking and zero request latency.
- **Command Code usage tracking & quota dashboard (#16)**: Full support for 5-hour session rolling windows, 7-day weekly limits, and monthly plan credit allowances/spend. Dynamically detects Go / GOAT / Pro subscription tiers, with countdown timers and balance countdowns.
- **Bulk enable/disable for custom & passthrough models**: One-click bulk enable or disable for custom model catalogs on both OpenAI-compatible endpoints and built-in providers, plus a fix preventing single model updates from overwriting capability attributes.
- **Universal OAuth credential transfer with AES-256-GCM encryption**: Export credentials across all OAuth providers into secure password-protected backups (`10router-oauth-secure-v1`), with smart multi-tier deduplication during import.
- **Official brand SVG icons**: Integrated `@lobehub/icons` with official vector brand icons for 58 providers, supporting automatic light/dark theme adaptation.
- **CodeBuddy check-in & international daily active session**: Check-in upgraded to continuous background scheduling with persistent daily memo deduplication; added daily active session toggle for CodeBuddy International.
- **Desktop client improvements**: Full tri-lingual localization for menu bars, new "Go" navigation menu (open URL / return to 10Router / recent URLs manager), and long-term server log archiving by date.

### 🐛 Fixed

- **Quota panel 0 total & sentinel countdown bug**: Fixed logic where zero-credit accounts were rendered as infinite quota `0 / ∞`, and filtered out far-future sentinel timestamps (such as year 9999) that produced 2.9-million-day countdowns.
- **Quota percentage calculation**: Fixed balance-denominated quotas (e.g. Command Code $9.98) being misread as raw percentages displaying `10% 🔴`.
- **CodeBuddy quota display direction**: Inverted credit pack displays to "Remaining / Total" countdown, aligning numbers with progress bars.
- **CodeBuddy International connection testing**: Added missing IDE transport headers and auth verification handling, resolving "Provider test not supported".
- **Xiaomi MiMo Desktop Preview model errors**: Clarified errors when calling preview models without desktop login, eliminating misleading rate-limit cooldowns.
- **Instant refresh for model disabled states**: Synchronized model availability state immediately upon connection changes, allowing disabled models to be tested directly.
- **Extensive i18n cleanup**: Full English and Traditional Chinese localization across the Endpoint page, provider notices, and API key buttons.

## v1.1.0 (2026-09-11)

> **Version note**: v1.0.9 was skipped and never released — its planned content (Xiaomi MiMo desktop support, etc.) was folded into this release, which grew to minor-level scope; the version number moved straight to v1.1.0. No v1.0.9 tag or artifacts exist.

### ✨ New

- **Xiaomi MiMo Desktop support (one provider, two ways to sign in)**: `xiaomi-mimo` now accepts both an sk- API key (cloud API) and a Xiaomi MiMo desktop-app account — the desktop-exclusive `mimo-x-pro-preview` / `mimo-x-flash-preview` only accept the account cookie, so an API key alone cannot reach them. Both credentials share one provider card; enable whichever you need.
- **Xiaomi MiMo authorization-code sign-in**: after the official authorize page opens in your browser, you can **paste the code shown on that page** straight into the dialog to finish signing in — even if the local callback never connected, or already timed out. The credential is decrypted server-side only and never passes through the browser.
- **CodeBuddy international catalog completed**: every entry was re-checked against the live gateway with real requests, adding five models that were served but missing (GLM-5.1 / GLM-5v-Turbo / MiniMax-M3 / Kimi-K2.7 / DeepSeek-V4.1-Flash) plus `GPT 6.0 Astra`.
- **opencode-go catalog aligned with the official public list (18 models), with a declared endpoint per model**: some models used to fail outright because a missing endpoint declaration sent them down the wrong path; each one now declares its endpoint from the official table.
- **New `gpt-image-2.5` image-model family for Codex / OpenAI**: `gpt-image-2.5` (incl. `-flare` / `-sunburst`), `gpt-image-2`, `gpt-image-1.5` — text-to-image, editing, and multi-image references.
- **Credit-multiplier badge supports limited-time free promos**: the badge shows green `free` during the promo and **automatically** returns to the real multiplier when it ends — no one has to remember to change it back.

### 🐛 Fixed

- **Windows desktop upgrades no longer silently discard old data**: the desktop data directory is also Electron's own config directory, so Chromium fills it with files first and makes it look "non-empty", permanently skipping the old-data migration. The check is now "does the directory already contain our own database".
- **Several real Xiaomi MiMo authorization-code bugs**: the decrypted payload layout was reversed (the actual cause of `decrypt_failed`), the platform requires `app=MiMo`, the callback path is now a random string, and the result is handed back with a 302; pasting a code also keeps working after the callback listener times out.
- **Kiro requests no longer carry a top-level `systemPrompt`** (kiro.dev answers it with an immediate 400 and no retry); endpoint order now prefers the Amazon surface.
- **Claude tool `type` is now decided per provider**: this fixes MiniMax's Claude endpoint (rejected tools without `type`) without breaking DeepSeek's Claude endpoint (which only accepts its own `type` values).
- **Codex strips `\p{...}` regexes it cannot parse from tool schemas**: previously a single property escape in a tool parameter `pattern` failed the whole request with a 400, identically for every account.
- **`better-sqlite3` is skipped on Node 24**: its native addon crashes the process on load there, which used to take the whole server down.
- **AMD Token Factory catalog and capabilities rebuilt from live measurements**: missing chat models were added and a "text-only" misclassification was fixed (images were being silently dropped).
- **CodeBuddy CN's DeepSeek-V4.1-Flash output ceiling lowered to the server-published 128K**: asking for more never errors, it just makes over-limit requests more likely to hit a 400.
- **One provider no longer stores two contradictory disabled-model records**: this fixes models that appeared not to be disabled.

## v1.0.8 (2026-09-09)

### ✨ New
- **AMD Token Factory provider**: free shared OpenAI-compatible endpoints from AMD Radeon Cloud (`DeepSeek-V4-Flash` 1M context + `Qwen3.8-Flash-Next` 262K context); thinking via reasoning_effort with per-model level pickers; same shape as NVIDIA NIM
- **Antigravity quota host fix**: quota summary now queries the correct daily host (matching the native IDE), fixing systematically stale numbers; percentage reads from the backend value instead of re-deriving in the frontend
- **CodeBuddy catalogs aligned to the server (CN + intl)**: the international catalog is re-aligned (adds the Hy4-Preview / Hy3 free tier, GPT-5.6 Sol/Terra/Luna, GLM-5.3, Kimi-K3; drops retired models); the CN catalog now matches too — `DeepSeek-V4.1-Flash` supersedes `DeepSeek-V4-Flash` and the duplicate `Kimi-K3 (1)` slot is gone; every model on both gateways now carries the published credit multiplier
- **Credit-multiplier badges on the model list**: free-quota models show a green `free` chip, the rest show their modifier as `0.79x` (hover for an explanation); providers with no credit system show nothing

### 🔒 Security
- **API key HMAC secret hardening**: built-in fallback secret now triggers a production startup warning; experimental **Key secret rotation** (off by default) auto-generates a per-install secret; `generateKeyId` switched from `Math.random` to `crypto.randomBytes`
- **Dangerous-action confirm dialogs**: "Require API key" off, key-rotation enable/disable, and "Rotate all" now require explicit confirmation; rotation is double-submit protected (server 409 + client guard)

### 🐛 Fixed
- **Non-streaming requests defaulted to SSE (issue #4)**: omitting `stream` now correctly defaults to JSON (OpenAI/Anthropic spec); previously returned `text/event-stream` with trailing `data: [DONE]` that broke strict JSON clients (OpenAI SDK, WorkBuddy, curl)
- **Key rotation confirm dialog stuck open / repeated rotation**: confirm modal now auto-closes before executing; repeated rotations no longer stack "(rotated)" suffixes
- **MCP SSE idle disconnect**: long-lived MCP SSE connections now send a 25s comment heartbeat, preventing NAT/firewall silent drops
- **CodeBuddy CN whitelist false-positive (PR #5)**: Claude Code's own system prompt no longer matches the agent-identity whitelist (was triggering 11128)
- **GLM-4.6V-Flash missing vision (PR #5)**: free vision model now registered with correct capabilities
- **DeepSeek effort "max" rejected by SenseNova (PR #5)**: clamped to "xhigh" for cross-provider compatibility
- **Fetched/imported models now default to disabled (enable on demand)**: bulk imports via "Import from /models" and "Fetch Qoder Models" no longer switch everything on at once — they land in the "Disabled models" area for you to enable as needed, and `/v1/models` now only serves enabled models (a disabled model was previously still listed). Single manual adds stay enabled
- **CodeBuddy CN listing intl-only models (fixed)**: the CN catalog had picked up the GPT/Gemini family that only the international gateway serves, which failed with "model service info not found" when selected; removed from CN (kept in intl) with a test guard
- **DeepSeek-V4.1-Flash output ceiling under-reported (fixed)**: its capabilities capped output at 50K (a leftover from the pre-rename id), which truncated client requests; corrected to the model card's 1M context / 384K output / image input / switchable thinking, and the model's two alias ids now carry the same caps

## v1.0.7 (2026-09-07)

### ✨ New
- **CodeBuddy CN built-in "Total Points" quota row**: the CodeBuddy CN card now leads with a Total Points row summing the live balance of every pack (monthly refills + bonus packs) — no more adding them up yourself; it auto-hides under the "Only with balance" filter once drained; "Bonus Pack" row names are now localized
- **ZCode usage sync plugin (10router-sync)**: import ZCode's local model-usage ledger into 10Router in one step — providers pointed at 10Router are auto-excluded to prevent double counting; re-runs are idempotent via dedup; imported usage shows up in the usage page and the details tab
- **Upstream v0.5.69 selective port**: ① Google-family multi-account background refresh → serial + tiered jitter to dodge anti-abuse risk control; ② Anthropic-compatible nodes on real Claude auto-add context-management beta headers (no more silent model-swap); ③ opencode-go stable sessions (free pool no longer trips risk control); ④ Responses parallel tool-call fix (no longer merges N calls into one); ⑤ Claude Fable weekly-quota tracking; ⑥ codex adds gpt-6-astra etc.; ⑦ codebuddy-cn model catalog aligned to server contract
- **qoder catalog refresh + image passthrough**: model list aligned to server, base64 image direct send; dashboard Antigravity quota grouped by family (per-connection isolation, better than upstream)
- **Desktop tray update path + leaner menu**: desktop update banner now points to GitHub Releases; tray menu merges check-update / about / start-stop into one compact flow
- **copilot switched to VS Code extension guide**: no more MITM intercept — three-step extension config (engine layer retained, manually revertible)
- **Tray icon monochrome**: macOS template icon + Windows dark/light theme black-white adaptive

### 🐛 Fixed
- **`/responses` root-path auth gap (security)**: prefix added, path now enforces API-key check
- **Foreign `server_tool_use` poisoning history after Claude combo fallback (400)**: validate `srvtoolu_` prefix and drop foreign tool blocks
- **MCP deferred tool breaking cache anchors (400)**: anchor now pinned to the last cacheable tool
- **gemini schema tuple validation 400**: `prefixItems` conversion + array missing `items` placeholder
- **antigravity system-prompt competitor brand-clean generalization**: OpenCode naming no longer triggers 429
- **Free-model background-refresh noise + connection-test hang**: de-noised + 15s timeout

## v1.0.6 (2026-09-05)

### ✨ New

- **CodeBuddy CN auto daily check-in** (experimental, off by default): with "CodeBuddy CN auto daily check-in" enabled under Settings → Experimental, the Import / Export buttons on the CodeBuddy CN page are replaced by an automatic daily check-in (each account checks in at a random 00:00–06:00 local time to renew free quota; failures never interrupt the service and a 401 triggers one token refresh + retry) plus a manual "Check in now" button
- **Antigravity quota aligned with the official site (5h + weekly dual window)**: Antigravity quotas on the usage page now use the official retrieveUserQuotaSummary RPC as the primary source, showing exactly **4 cards** per account (Gemini Models / Claude and GPT models × {5-hour, weekly}), normalized to a 0–100 scale; falls back to the old per-model parse when the RPC is unavailable
- **OpenCode Free catalog aligned with the official free list**: adds Big Pickle / MiMo-V2.5 / Ling 3.0 Flash Fin / Nemotron 3 Ultra / Nemotron 3.5 Lightning; deliberately excludes the DeepSeek / Laguna free tiers the official docs have dropped (avoids accidental paid calls)

### 🐛 Fixes
- **Antigravity `ag/gemini-3.8-flash-*` 404**: model addressing now uses per-tier tiered entities and the IDE fingerprint is bumped to 2.11.0 (bare ids 404 with "Requested entity was not found"); adds the un-tiered `ag/gemini-3.8-flash` (routed to the medium tier)
- **"Only with balance" misses newly-checked-in quota packs**: fixed a case where CodeBuddy CN's daily full packs were hidden after older packs were renumbered and the persistent hide never cleared — the hidden set is now recomputed live so any pack with remaining balance (including fresh full packs) always shows
- **Friendly message for free-model 429 rate limits**: when a free-tier model (`oc/*-free`, `contributor-free`, APInex `free/`-prefixed, etc.) hits an upstream rate limit and returns 429, the raw English `rate_limit_exceeded` is no longer passed through — instead a friendly Chinese message is returned showing an estimated wait ("try again in ~N sec/min/hr") when the upstream supplied a reset time, otherwise advising to retry later or switch to a paid tier. Paid models and multi-account fallback are untouched

## v1.0.5 (2026-09-03)

### ✨ New

- **Desktop tray app (Windows / macOS)**: an install-and-go desktop app — system tray menu (open console / start / restart / stop / launch at login) plus an embedded window; closing the window minimizes to the tray. Shares data, keys and port with the npm CLI (the two forms run exclusively). Windows ships an NSIS installer (silent `/S` supported) and a portable exe; macOS ships separate Intel + Apple Silicon dmgs
- **CLI / desktop UI localization**: the npm CLI and the desktop tray now follow the system language (Simplified Chinese / Traditional Chinese / English); override with the `TENROUTER_LANG` env var (`zh-CN` / `zh-TW` / `en`)
- **Self-serve custom providers + new Skills-page skill**: register a custom OpenAI/Anthropic-compatible endpoint (baseUrl + upstream key + models) at runtime with a dashboard LLM key — no source change, no repackage. The Dashboard **Skills** page gains a **10router-add-provider** card and now links to the `main` branch (previously `master`, which 404'd)
- **CodeBuddy CN account JSON bulk import / export** (experimental, off by default): after enabling "CodeBuddy CN OAuth import / export" under Settings → Providers, the CodeBuddy CN detail page shows Import / Export buttons to bulk-import or export account credentials in the third-party (wb) JSON format (import dedupes by identity and skips non-CodeBuddy issuers). Import / export now require a dashboard-password confirmation (prevents anonymous token export in no-login mode)
- **Community welfare providers show by default**: GoRouter / TaBiAI now appear by default (no need to toggle them on), consistent across the provider list / Profile toggle / usage topology
- **Community welfare providers sort into one group**: in the Free Tier list, community providers (GoRouter / TaBiAI) now cluster into one adjacent block per rank group instead of interleaving with regular freeTier providers by priority/name
- **New Agnes AI dual-site providers**: international **Agnes AI** (com) + **Agnes AI (CN)** — each with Agnes 2.5 Flash / 2.5 Pro text models (512K / 1M context, vision + reasoning), plus Agnes Image 2.x Flash image models (standard images/generations endpoint; image-to-image / editing)
- **New "Experimental" settings group**: Profile gains a dedicated Experimental card gathering the developer-oriented default-off toggles (Fetch models from GitHub JSON + CodeBuddy CN import/export) for easy future expansion
- **New provider APInex (apinex.bond)**: prepaid USD-credit third-party gateway (OpenAI-compatible) with 18 models (13 paid + 5 `free/`-prefixed free models); provider pages show a copyable invite-code chip (APInex: `SLEWP68C`)
- **Upstream v0.5.65 catalog sync + new search providers**: adds GLM-5.3-Flash(Vision), GLM-4.6V, DeepSeek-V4-Flash-Vision-Exp, Grok-4.6, Claude-Fable-5.1 and more; new search providers Ollama-Search (reuses your local Ollama key) and Xquik (X/Twitter search)

### 🐛 Fixes
- **Usage table corruption after Cost/Token switch**: toggling the display mode and sorting no longer reverts some rows to currency values; Traditional Chinese usage-table headers are now fully translated
- **Usage table sorting semantics**: token / cost columns now sort model groups by their totals, matching the header arrow direction

## v1.0.4 (2026-09-01)

### ✨ New
- **3 new providers**: **TokenBom** (decentralized token marketplace — idle API keys earn credits, credits call many models; 79-model online catalog), **GoRouter** (free gateway, no recharge entry), **TaBiAI** (free gateway, no recharge entry)
- **Usage history import**: import usage data from 9Router backups (SQLite files) — merged into stats without touching config
- **Notification overhaul**: global toasts moved to top-center; browser-native alert() dialogs replaced with friendly notifications
- **Community welfare providers**: GoRouter / TaBiAI are hidden by default with a "community" badge; toggle them on in **Settings → Providers → Show community welfare providers**

### 🐛 Fixes
- **Provider ordering fixed**: connected providers first, disabled sink to bottom — no longer scrambled by priority
- **JSON catalog models invisible after enabling**: stale disable records are now cleared ("enabled but not listed" resolved)
- **B.AI / CodeBuddy CN model catalogs completed**: missing models that caused "not found" when switching are added
- **Friendly maintenance hints on connection tests**: endpoint down / Cloudflare-blocked shows a maintenance note instead of a misleading "Invalid API key"
- **Account filter reminder**: quota-pack account filter persists; an amber reminder bar shows when a non-default filter is active
- **CodeBuddy CN DeepSeek 11150**: DeepSeek-series calls no longer fail with 400 on the reasoning-effort param (auto/off); coding agents (dsh, etc.) work normally
- **CodeBuddy empty tool name (11133 / unknown tool)**: empty `function.name` in streaming tool calls is normalized, so standard clients no longer mis-detect the tool name
- **Topology still shows hidden community providers**: the usage topology now honors the "Show community providers" toggle — community welfare sites (GoRouter/TaBiAI) are hidden when it's off
- **Skills page i18n + Chinese links**: Skills page text is now localized; in Chinese (zh-CN) the links point to the Chinese skill files

## v1.0.3 (2026-08-30)

### ✨ New
- **4 new providers**: **LongCat** (Meituan), **SenseNova** (SenseTime, free beta), **Dots** (Xiaohongshu Dots Studio, free beta), **B.AI** (aggregator — one key for GPT / Claude / Gemini / DeepSeek / GLM / Kimi / Qwen and more)
- **Model JSON catalogs for custom providers**: custom nodes can pull an online model list, toggle models on/off individually, and manage them in bulk
- **fpk update check goes straight to Releases**: fnOS installs jump directly to the matching release download

### 🔒 Security
- **Progressive login rate-limit**: 5 failed password attempts → 30s / 2m / 10m / 30m lockout
- **Reject placeholder JWT keys**: copying the public `.env.example` key is ignored; a random key is generated instead
- **Fix npm package leaking build-machine secrets**: no more keys / machine IDs / data snapshots in the build artifact

### ⚠️ Notes
- npm package renamed to **`@techysy/10router`** (the old `10router` is an unrelated fork). If you installed `10router-cli`, switch to the new package; data directory unchanged.

## v1.0.2 (2026-08-29)

### 🐛 Fixes
- **Update check no longer points at a third-party package** (affected 1.0.1): version check, update command, and sidebar install command all target the correct package
- **postinstall no longer aborts install**: npm install no longer fails from the warm-up script on WSL paths

### ⚙️ Engineering
- **Test CI added**: tests + regression gate run automatically on push / PR

> ⚠️ **1.0.1 users should upgrade**: its built-in "check for updates" points to an unrelated third-party package.

## v1.0.1 (unreleased; delivered with v1.0.2)

> 1.0.1 was never published as a release (only the npm `10router-cli@1.0.1` briefly existed). The following reached Docker / fpk / standalone users with **v1.0.2**.

### 🔒 Security
- **4 MITM security fixes**: upstream TLS cert validation restored, root CA private key locked to 0600, no longer blindly killing the process on port 443, auto-cleanup of leftover hosts entries (MITM is off by default)

### ✨ New
- **Disabled providers sink to the bottom** via a settings toggle
- **Collapsible desktop sidebar**
- **OpenCode Go quota usage**
- **Gitee mirror fallback for model catalogs** (faster in CN)

### 🐛 Fixes
- **/v1/models no longer returns orphan custom models**
- **Custom node prefix uniqueness check**
- **Fix CodeBuddy executor dropping the Agent system prompt**

### ⚙️ Engineering
- **New npm distribution channel**: `npm i -g 10router-cli`
- **Generic "fetch models from GitHub JSON" capability** (Fetch Models)

## v1.0.0 (2026-08-26)

### ⚠️ Notes
1. **Data directory renamed**: `~/.9router/` → `~/.10router/` (Windows: `%APPDATA%\10router`), auto-migrated on first start
2. **SAML entityID changed**: default issuer is now `urn:10router:sp`; re-register in your IdP
3. **MITM CA renamed**: re-trust the new CA

### ✨ New
- **Rebrand**: 9Router → 10Router
- **i18n multi-region currency**: en / pt-BR / pt-PT / es / de
- **Multi-platform distribution**: Docker (amd64 / arm64), fnOS fpk (x86 / arm × url / iframe), Standalone
