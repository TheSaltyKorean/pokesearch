# PokeSearch

Point your camera at a Pokemon card (or upload a photo) and get its value in seconds — including foreign printings (Japanese, Korean, Chinese, and European languages).

**Live app:** https://thesaltykorean.github.io/pokesearch/

## How it works

- **Identify on-device.** Card images from the Pokemon TCG API and TCGdex are pre-hashed (16-byte perceptual hashes) into a compact index shipped with the app. Your capture is hashed in the browser and matched by Hamming distance — no image ever leaves your device, and matching is instant.
- **Auto-capture.** Line the card up in the guide box; when the frame is steady and card-like, it snaps automatically. Or upload a photo.
- **Variants & versions.** Candidates show set, number, language, and rarity; prices are broken out per variant (holo, reverse holo, 1st edition, graded…).
- **Price ranges, aggregated.** Free sources work out of the box (TCGplayer + Cardmarket via pokemontcg.io, TCGdex). Add your own keys in Settings for PriceCharting (best for Japanese/graded) and eBay listing ranges.
- **Optional collection.** Save cards locally (IndexedDB) with quantity/condition; values re-refresh automatically when older than 24 hours. Export/import JSON.
- **i18n-ready.** English UI today; locales are drop-in files under `src/i18n/`.

## Development

```bash
npm install
npm run dev        # local dev server
npm run build      # typecheck + production build
npm run lint
```

### Card index

```bash
# English sets (Pokemon TCG API set ids)
node scripts/build-index.mjs --source ptcg --sets base1,sv3pt5

# Foreign sets via TCGdex (any of: ja ko zh-tw zh-cn de fr it es ...)
node scripts/build-index.mjs --source tcgdex --lang ja --sets SV2a
node scripts/build-index.mjs --source tcgdex --lang ja --list-sets   # discover set ids

# Sanity-check a match
node scripts/verify-match.mjs https://images.pokemontcg.io/base1/4_hires.png
```

The index is merged incrementally (per language) into `public/carddata/` and refreshed nightly by `.github/workflows/refresh-index.yml`. Add sets there to grow coverage.

## Contributing

`main` is protected — work on branches, open a PR, and reviews run via `@codex`. See `CLAUDE.md` for architecture notes and `memory.md` for the decision log.
