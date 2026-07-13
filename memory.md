# memory.md — session log & decisions

## 2026-07-11 — project start
- Randy's goals: fast card value lookup from camera/photo, price *ranges*, variant/version detection, strong focus on foreign (JA/KO/ZH/EU) cards, optional personal collection DB with daily value refresh, English UI now but i18n-capable.
- Decisions (confirmed with Randy):
  - Stack: Vite + React + TS, static SPA on GitHub Pages.
  - Collection: browser-local IndexedDB + JSON export/import. "Daily refresh" = re-price stale (>24h) entries on app open (no server).
  - Price sources: Pokemon TCG API + TCGdex free/default; PriceCharting + eBay as key-gated adapters (Randy has/wants paid sources but keys not yet provided).
  - Identification: prebuilt perceptual-hash index (built from Pokemon TCG API + TCGdex images) matched on-device; ~16 bytes/card so full catalog stays small. Nightly GitHub Action refreshes index.
- Repo: github.com/TheSaltyKorean/pokesearch (was empty, remote preconfigured).
- Process: branch protection on main, PR review loop via @codex until all-clear.
- Built & verified 2026-07-11:
  - Initial index: 519 cards (EN base1 + sv3pt5, JA SV2a) ≈ 105KB static assets.
  - Match quality: Charizard base1-4 hires → distance 2 (runner-up 29); JA Pikachu SV2a-025 → distance 4, EN twin surfaces as candidate.
  - Live on GitHub Pages: https://thesaltykorean.github.io/pokesearch/ (Actions build_type=workflow).
  - Branch protection on main: PRs required, 0 approvals (so index-bot PRs can automerge), no force pushes.
  - Visual checks via Playwright MCP on live site: EN Charizard 65% match, Holofoil $510–$1500; JA Pikachu 88% match. Found & fixed bug: TCGdex cardmarket `trend` is an outlier-prone field and variant suffixes are `-holo` (not `-reverse`); summarizeRange now clamps mid into [low, high].
  - Gotcha: pushes must use TheSaltyKorean@users.noreply.github.com (GitHub email privacy blocks live.com address).
- Codex loop (PR #1): flagged 2 P2s — `-holo` block mapped blindly to holofoil (now uses `data.variants` to pick reverseHolofoil) and `-Infinity` range bounds when a quote has only `low` (now falls back to mids). Fixed, re-tagged, got all-clear ("Didn't find any major issues"), squash-merged. Post-merge live check: JA Pikachu range €0.02–€19.99 mid €4.55 ✓.
- Process notes: Codex reacts 👀 when it picks up "@codex review", then reviews in ~5-10 min; poll with `gh api repos/.../pulls/N/reviews` + issue comments. Visual checks: Playwright MCP against the live Pages site; inject test images via in-page fetch→File→DataTransfer (MCP filesystem is isolated from the repo host).

## 2026-07-11 (later) — real-card scan failures fixed
- Randy reported none of his real cards (Japanese, live camera) matched. Two causes: only SV2a indexed, and rigid single center-crop hashing brittle vs. real framing.
- PR #3 (Codex loop, all-clear on 2nd round): JA index 210 → 3,297 cards (--sets all; every set TCGdex has JA images for = full SV era + late S era); jittered multi-probe matching (offsets ±3% × scales 0.88–1.06); cutoff 40 → 60 with confidence rescaled to /64; build-index now skips bad sets in --sets all but exits 1 if every requested set fails.
- Codex caught: offset probes degenerated to zero in the tight camera-crop path (offsets must combine with down-scaling); empty-index publish risk; misleading 0% confidence labels.
- Verified live with synthetic degraded photo (rotation 2.5°, brightness 0.85, table margin, light gradient) of SV4a-205: top match 64%.
- LIMIT: TCGdex has no JA card data older than ~S9 (2022). If Randy's cards are older JA, need another catalog source (candidate: Limitless TCG scrape). Asked Randy for era.
- NOTE: many JA cards have no free pricing (TCGdex pricing sparse for JA); PriceCharting key in Settings is the real JA pricing path.

## 2026-07-11 (later still) — more pricing sources + display currency (PR #6)
- Added JustTCG + PokemonPriceTracker adapters (both free-tier keys, both CORS `*`, both cover JA). Verified live with Randy's JustTCG key: JA SV2a-006 → $2.74–3.64 holofoil; EN base1-4 → $528–728.
- JustTCG API gotchas (cost a debugging loop): REST search param is `q` (`query` from the SDK docs is silently ignored — returns the whole 24k-card catalog); JA catalog names are ENGLISH so name-search from our Japanese-named index finds nothing — resolve instead via set code + collector number (their set_name embeds JA set codes: "SV2a: Pokemon Card 151"); game slugs are `pokemon` / `pokemon-japan` (adapter resolves via /games at runtime). Free tier: 1k/mo, 100/day, 20 cards/request.
- PokemonPriceTracker: 100 credits/day, bills 1 credit PER CARD RETURNED → keep limit=5. `language=japanese` param for JA. Not yet live-tested (Randy hasn't signed up).
- Display currency setting (Randy's ask): all quotes FX-converted via frankfurter.dev (free, CORS, ECB daily, cached 24h in localStorage); default USD; collection entries in a stale currency re-price on open.
- Codex round 1 caught 4 real P2s: no-number-match fallback quoted wrong cards; '1st Edition Holofoil' mapped to plain holofoil (check '1st' before 'holo'); "Base" substring-matched "Base Set 2" (digit-guard added to setNamesOverlap); background collection refresh could silently burn free-tier quotas (fetchAllPrices now takes {background:true} which skips JustTCG+PPT).
- PriceCharting: docs claim + curl confirm CORS `*` — removed the proxy requirement from the adapter (memory previously said proxy needed; wrong). Prices are integer pennies; 1 req/sec limit. Randy's PC account is FREE tier — API needs a paid sub, so still no key.
- Claude-in-Chrome ops notes: two browsers connected (work/Windows, Linux local); Randy's logins land on the Linux one. To read a dashboard-masked API key: hook `navigator.clipboard.writeText` via javascript_tool, click the site's copy button, read `window.__copied`. Don't call `navigator.clipboard.readText()` — its permission prompt freezes the tab for ~45s.
- Account/key status: JustTCG ✅ (key with Randy to paste into Settings); eBay dev account created, pending eBay review (≥1 business day); pokemontcg.io + PokemonPriceTracker accounts not created yet; PriceCharting needs paid sub for API.

## 2026-07-12 — eBay live + price-proxy Worker (PR #7)
- eBay dev account approved. Created production keyset "pokesearch" via Claude-in-Chrome (Randy filled the primary-contact form himself — personal data). Keyset ships DISABLED until Marketplace Account Deletion compliance: applied the exemption ("I do not persist eBay data" — truthful, nothing is stored server-side) via the toggle → Confirm → questionnaire → Submit flow on developer.ebay.com/my/push. Enabled: 5,000 calls/day.
- eBay creds: App ID RandyWal-pokesear-PRD-e5387b949-16e43353 (Cert ID is in the dev portal / worker secrets — do not commit). Tokens: client_credentials, scope api_scope, expire 7200s. Browse API + token endpoint send NO CORS headers → browser can't call eBay directly, hence the Worker.
- `worker/` — Cloudflare Worker `pokesearch-prices`: holds all source keys as secrets, read-only GET routes (/ebay/search, /justtcg/*, /ppt/*, /pricecharting/*), per-URL edge cache (6–12h) to stretch free quotas, CORS locked to the Pages origin + localhost. This is Randy's requested "persist keys for the whole app" answer (he vetoed GCP). Wrangler must be v3 (`npx wrangler@3`) — machine is Node 20, wrangler 4 needs 22.
- eBay adapter rewritten: worker-only (ebayToken + corsProxy settings removed), splits raw vs graded listings by title regex (PSA|BGS|CGC|SGC|graded|gem mint) into separate variants, and for non-Latin card names queries `pokemon <lang> <setId> <number>` — "SV2a 006" gets ~30x more listings than "リザードンex". Verified via local wrangler dev: JA SV2a-006 → raw $2.99–45 mid $4.99 (37 listings), graded mid $49 (13) — consistent with JustTCG NM $3.37 and observed PSA-10 asks.
- justtcg/ppt/pricecharting adapters: use per-user key if set, else workerUrl route. Settings gains workerUrl.
- DEPLOY STILL PENDING: needs Randy's Cloudflare account + `npx wrangler@3 login`, then `cd worker && npx wrangler@3 deploy` + `secret put` EBAY_CLIENT_ID / EBAY_CLIENT_SECRET / JUSTTCG_KEY, then paste the workers.dev URL into Settings→workerUrl.

- Open items:
  - Deploy the worker (blocked on Cloudflare login); paste workerUrl into live Settings.
  - Randy: JustTCG key into Settings (or rely on worker); PriceCharting Pro sub decision; PokemonPriceTracker + pokemontcg.io accounts still uncreated.
  - Hash index initially covers a subset of sets; nightly action expands coverage.
  - Deployment target: GitHub Pages preferred; p50 container as fallback.
