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
- Open items:
  - Randy to supply PriceCharting + eBay API keys (Settings page accepts them).
  - Hash index initially covers a subset of sets; nightly action expands coverage.
  - Deployment target: GitHub Pages preferred; p50 container as fallback.
