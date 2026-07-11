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
- Open items:
  - Randy to supply PriceCharting + eBay API keys (Settings page accepts them).
  - Hash index initially covers a subset of sets; nightly action expands coverage.
  - Deployment target: GitHub Pages preferred; p50 container as fallback.
