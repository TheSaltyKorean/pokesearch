import type { CardEntry, PriceQuote, Settings } from '../lib/types'
import { normalizeCardNumber, setNamesOverlap } from './match'

const API = 'https://www.pokemonpricetracker.com/api/v2'

interface PptVariant {
  printing?: string
  marketPrice?: number
  lowPrice?: number
}

interface PptCard {
  name?: string
  setName?: string
  cardNumber?: string
  tcgPlayerUrl?: string
  prices?: { market?: number; low?: number; lastUpdated?: string }
  variants?: Record<string, PptVariant>
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

/**
 * PokemonPriceTracker (pokemonpricetracker.com) — free tier: 100 credits/day
 * (1 credit per card returned), CORS-enabled. TCGplayer USD prices for the
 * English AND Japanese catalogs. Requires a free API key (Settings).
 * `limit` is kept small because every returned card bills one credit.
 */
export async function fetchPokemonPriceTrackerPrices(
  card: CardEntry,
  settings: Settings,
): Promise<PriceQuote[]> {
  const key = settings.pokemonPriceTrackerKey
  if (!key) return []
  if (card.lang !== 'en' && card.lang !== 'ja') return []

  const params = new URLSearchParams({ search: card.name, limit: '5' })
  if (card.lang === 'ja') params.set('language', 'japanese')
  const res = await fetch(`${API}/cards?${params}`, {
    headers: { Authorization: `Bearer ${key}` },
  })
  if (!res.ok) throw new Error(`pokemonpricetracker ${res.status}`)
  const body = await res.json()
  const cards: PptCard[] = body.data ?? []

  const wantNumber = normalizeCardNumber(card.number)
  const numbered = cards.filter((c) => normalizeCardNumber(c.cardNumber) === wantNumber)
  const match = numbered.find((c) => setNamesOverlap(c.setName, card.set)) ?? numbered[0]
  if (!match) return []

  const now = new Date().toISOString()
  const updatedAt = match.prices?.lastUpdated ?? now
  const quotes: PriceQuote[] = []
  for (const [printing, v] of Object.entries(match.variants ?? {})) {
    if (!finite(v.marketPrice) && !finite(v.lowPrice)) continue
    const p = printing.toLowerCase()
    // "1st" must win over the generic holo check so 1st-edition premiums
    // don't get averaged into unlimited holofoil.
    quotes.push({
      source: 'PokemonPriceTracker',
      variant: p.includes('1st')
        ? p.includes('holo')
          ? '1stEditionHolofoil'
          : '1stEditionNormal'
        : p.includes('reverse')
          ? 'reverseHolofoil'
          : p.includes('holo') || p.includes('foil')
            ? 'holofoil'
            : 'normal',
      currency: 'USD',
      low: finite(v.lowPrice) ? v.lowPrice : undefined,
      mid: finite(v.marketPrice) ? v.marketPrice : v.lowPrice,
      url: match.tcgPlayerUrl,
      updatedAt,
    })
  }
  if (quotes.length === 0 && (finite(match.prices?.market) || finite(match.prices?.low))) {
    quotes.push({
      source: 'PokemonPriceTracker',
      variant: 'normal',
      currency: 'USD',
      low: finite(match.prices?.low) ? match.prices!.low : undefined,
      mid: finite(match.prices?.market) ? match.prices!.market : match.prices?.low,
      url: match.tcgPlayerUrl,
      updatedAt,
    })
  }
  return quotes
}
