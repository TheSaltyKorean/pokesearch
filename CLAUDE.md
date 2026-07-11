# PokeSearch — Pokemon Card Scanner & Price Lookup

## What this is
Web app: point a camera at (or upload a photo of) a Pokemon card → identify the exact card, set, variant, and language → show a price range fast. Optional local collection with daily re-pricing.

## Architecture
- **Frontend:** Vite + React + TypeScript, static SPA, deployable to GitHub Pages. No backend.
- **Identification:** on-device perceptual hashing (dHash 128-bit over card art region) matched by Hamming distance against a prebuilt hash index shipped as static assets (`public/carddata/`). Candidates confirmed by user tap or metadata.
- **Hash index build:** `scripts/build-index.mjs` pulls catalogs from Pokemon TCG API (English) and TCGdex (JA/KO/ZH/DE/FR/IT/ES), downloads card images, computes hashes, emits `index-<lang>.json` + `hashes-<lang>.bin`. Run by GitHub Action nightly (`.github/workflows/refresh-index.yml`) and expandable set-by-set.
- **Pricing:** `src/pricing/` — pluggable sources behind a common interface:
  - `pokemontcg.ts` — free; TCGplayer (USD) + Cardmarket (EUR) per-variant prices.
  - `tcgdex.ts` — free; multilingual catalog + Cardmarket pricing where present.
  - `pricecharting.ts` — requires user API key (Settings); best for Japanese/graded.
  - `ebay.ts` — requires user API key; sold-listing ranges, any language.
  Results merged into a low/mid/high range per variant.
- **Collection:** IndexedDB (`src/db/`). Export/import JSON. On app open, entries with prices >24h old are re-fetched.
- **i18n:** `src/i18n/` string table, `en` only for now; add locales by dropping a file. Card *catalog* languages (ja/ko/zh/de/fr/it/es) are separate from UI language.
- **Camera auto-capture:** `src/scanner/` — video frames sampled, edge density + frame stability inside the card guide box triggers auto-snap.

## Conventions
- No secrets in repo. User API keys live in localStorage via Settings.
- Keep everything static-hostable; no server code.
- Update `memory.md` with decisions/state at the end of each working session.
- All work via feature branches + PRs into `main` (branch protection on). PRs reviewed by tagging `@codex`; fix findings and re-tag until all-clear.

## Commands
- `npm run dev` — dev server
- `npm run build` — typecheck + production build to `dist/`
- `npm run lint` — oxlint
- `node scripts/build-index.mjs --lang en --sets base1,base2` — (re)build hash index for sets
