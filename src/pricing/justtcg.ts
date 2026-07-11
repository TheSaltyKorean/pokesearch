import type { CardEntry, PriceQuote, Settings, VariantKey } from '../lib/types'
import { normalizeCardNumber, setNamesOverlap } from './match'

const API = 'https://api.justtcg.com/v1'

interface JustTcgVariant {
  condition?: string
  printing?: string
  language?: string
  price?: number
  lastUpdated?: number
  minPrice7d?: number | null
  maxPrice7d?: number | null
  minPrice30d?: number | null
  maxPrice30d?: number | null
}

interface JustTcgCard {
  name?: string
  set_name?: string
  number?: string
  variants?: JustTcgVariant[]
}

/**
 * JustTCG (justtcg.com) — free tier: 1,000 calls/month, 100/day, CORS-enabled.
 * TCGplayer-sourced USD prices per condition × printing, including the full
 * Pokemon Japan catalog. Requires a free API key from justtcg.com (Settings).
 */

// Game slugs are resolved from /games once per session because the exact ids
// (e.g. Pokemon vs Pokemon Japan) are not documented publicly.
let gamesPromise: Promise<{ id: string; name: string }[]> | undefined

async function listGames(key: string): Promise<{ id: string; name: string }[]> {
  gamesPromise ??= fetch(`${API}/games`, { headers: { 'x-api-key': key } })
    .then(async (res) => {
      if (!res.ok) throw new Error(`justtcg games ${res.status}`)
      const body = await res.json()
      return (body.data ?? []) as { id: string; name: string }[]
    })
    .catch((err) => {
      gamesPromise = undefined // allow retry on the next quote fetch
      throw err
    })
  return gamesPromise
}

async function resolveGame(key: string, lang: string): Promise<string | undefined> {
  const games = await listGames(key)
  const pokemon = games.filter((g) => /pok[eé]mon/i.test(g.name) || /pokemon/i.test(g.id))
  const japan = pokemon.find((g) => /japan/i.test(g.name) || /japan/i.test(g.id))
  if (lang === 'ja') return japan?.id
  if (lang === 'en') return pokemon.find((g) => g !== japan)?.id
  return undefined
}

function printingToVariant(printing: string | undefined): VariantKey | string {
  const p = (printing ?? 'Normal').toLowerCase()
  if (p.includes('reverse')) return 'reverseHolofoil'
  if (p.includes('1st')) return p.includes('holo') ? '1stEditionHolofoil' : '1stEditionNormal'
  if (p.includes('holo') || p.includes('foil')) return 'holofoil'
  if (p.includes('normal') || p === 'unlimited') return p === 'unlimited' ? 'unlimited' : 'normal'
  return printing ?? 'normal'
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

export async function fetchJustTcgPrices(
  card: CardEntry,
  settings: Settings,
): Promise<PriceQuote[]> {
  const key = settings.justTcgKey
  if (!key) return []
  // JustTCG carries English and Japanese Pokemon catalogs.
  if (card.lang !== 'en' && card.lang !== 'ja') return []
  const game = await resolveGame(key, card.lang)
  if (!game) return []

  const params = new URLSearchParams({ query: card.name, game, limit: '20' })
  const res = await fetch(`${API}/cards?${params}`, { headers: { 'x-api-key': key } })
  if (!res.ok) throw new Error(`justtcg ${res.status}`)
  const body = await res.json()
  const cards: JustTcgCard[] = body.data ?? []

  // Same name can appear across many sets; require a collector-number match
  // and prefer a set-name match so we never quote the wrong card.
  const wantNumber = normalizeCardNumber(card.number)
  const numbered = cards.filter((c) => normalizeCardNumber(c.number) === wantNumber)
  const pool = numbered.length > 0 ? numbered : cards
  const match =
    pool.find((c) => setNamesOverlap(c.set_name, card.set)) ??
    (numbered.length > 0 ? numbered[0] : undefined)
  if (!match?.variants?.length) return []

  const quotes: PriceQuote[] = []
  const byPrinting = new Map<string, JustTcgVariant[]>()
  for (const v of match.variants) {
    const k = v.printing ?? 'Normal'
    byPrinting.set(k, [...(byPrinting.get(k) ?? []), v])
  }
  for (const [printing, vs] of byPrinting) {
    const nm =
      vs.find((v) => v.condition === 'Near Mint') ??
      vs.find((v) => v.condition === 'Lightly Played') ??
      vs[0]
    if (!finite(nm.price)) continue
    const lp = vs.find((v) => v.condition === 'Lightly Played')
    const lows = [lp?.price, nm.minPrice30d ?? nm.minPrice7d].filter(finite)
    const highs = [nm.maxPrice30d ?? nm.maxPrice7d].filter(finite)
    quotes.push({
      source: 'JustTCG',
      variant: printingToVariant(printing),
      currency: 'USD',
      low: lows.length ? Math.min(...lows, nm.price) : undefined,
      mid: nm.price,
      high: highs.length ? Math.max(...highs, nm.price) : undefined,
      updatedAt: nm.lastUpdated
        ? new Date(nm.lastUpdated * 1000).toISOString()
        : new Date().toISOString(),
    })
  }
  return quotes
}
