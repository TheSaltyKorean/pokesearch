# PokeSearch — Pokemon Card Scanner & Price Lookup

## What this is
Web app: point a camera at (or upload a photo of) a Pokemon card → identify the exact card, set, variant, and language → show a price range fast. Optional local collection with daily re-pricing.

## Architecture
- **Frontend:** Vite + React + TypeScript, static SPA, deployable to GitHub Pages. No backend.
- **Identification:** on-device perceptual hashing (16-byte hash: 64-bit dHash whole card + 64-bit dHash art region) matched by Hamming distance against a prebuilt index shipped as static assets (`public/carddata/`). Captures are matched with a jittered multi-probe grid (offsets ±3% × scales 0.88–1.06) because real camera framing is never exact; weak candidates (distance ≤60) are shown for visual confirmation. The hash algorithm lives in BOTH `src/lib/hash.ts` (browser) and `scripts/build-index.mjs` (sharp) — keep them in sync or rebuild the index.
- **Hash index build:** `scripts/build-index.mjs` pulls catalogs from Pokemon TCG API (English) and TCGdex (JA/KO/ZH/DE/FR/IT/ES), downloads card images, computes hashes, emits `index-<lang>.json` + `hashes-<lang>.bin` (merge is incremental; known ids skipped). Nightly GitHub Action (`refresh-index.yml`) maintains EN base1+sv3pt5 and the full JA catalog (`--sets all`). KNOWN LIMIT: TCGdex has no JA card data older than ~2022 (S9); older JA cards need a new source.
- **Pricing:** `src/pricing/` — pluggable sources behind a common interface:
  - `pokemontcg.ts` — free; TCGplayer (USD) + Cardmarket (EUR) per-variant prices.
  - `tcgdex.ts` — free; multilingual catalog + Cardmarket pricing where present.
  - `justtcg.ts` — free-tier user key (100 req/day); TCGplayer USD per condition×printing, EN + full JA catalog. Game slugs resolved at runtime via /games.
  - `pokemonpricetracker.ts` — free-tier user key (100 credits/day, 1/card); TCGplayer USD, EN + JA. Keep `limit` small: every returned card costs a credit.
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
