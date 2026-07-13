import type { CardEntry, PriceQuote, Settings } from '../lib/types'
import { normalizeCardNumber, printingToVariant, setNamesOverlap } from './match'

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
  prices?: { market?: number; low?: number; primaryPrinting?: string; lastUpdated?: string }
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
  const base = key ? API : settings.workerUrl && settings.workerUrl.replace(/\/+$/, '') + '/ppt'
  if (!base) return []
  if (card.lang !== 'en' && card.lang !== 'ja') return []

  // Filter by set in the request itself (their `set` param matches loosely,
  // e.g. "temporal" → Temporal Forces): common names have far more hits than
  // one page, and every returned card bills a credit.
  const params = new URLSearchParams({ search: card.name, set: card.set, limit: '5' })
  if (card.lang === 'ja') params.set('language', 'japanese')
  const res = await fetch(`${base}/cards?${params}`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  })
  if (!res.ok) throw new Error(`pokemonpricetracker ${res.status}`)
  const body = await res.json()
  const cards: PptCard[] = body.data ?? []

  // Name search + number match alone can still hit the wrong card (the same
  // name+number pair repeats across sets, and with limit=5 the right set may
  // be absent entirely), so a set-name overlap is required before quoting.
  const wantNumber = normalizeCardNumber(card.number)
  const match = cards.find(
    (c) =>
      normalizeCardNumber(c.cardNumber) === wantNumber && setNamesOverlap(c.setName, card.set),
  )
  if (!match) return []

  const now = new Date().toISOString()
  const updatedAt = match.prices?.lastUpdated ?? now
  const quotes: PriceQuote[] = []
  for (const [printing, v] of Object.entries(match.variants ?? {})) {
    if (!finite(v.marketPrice) && !finite(v.lowPrice)) continue
    quotes.push({
      source: 'PokemonPriceTracker',
      variant: printingToVariant(v.printing ?? printing),
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
      variant: printingToVariant(match.prices?.primaryPrinting),
      currency: 'USD',
      low: finite(match.prices?.low) ? match.prices!.low : undefined,
      mid: finite(match.prices?.market) ? match.prices!.market : match.prices?.low,
      url: match.tcgPlayerUrl,
      updatedAt,
    })
  }
  return quotes
}
