import type { CardEntry, PriceQuote, Settings } from '../lib/types'
import { normalizeCardNumber, printingToVariant, setNamesOverlap } from './match'

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
 *
 * Lookup strategy (verified against the live API):
 * - JA: JustTCG stores English card names, so searching our Japanese catalog
 *   names finds nothing. But their set names embed the Japanese set code
 *   ("SV2a: Pokemon Card 151"), so cards resolve exactly via set + number.
 * - EN: `q` name search + client-side collector-number match. (The REST
 *   search param is `q`; `query` is the SDK's name for it and is ignored.)
 */

const SETS_CACHE_PREFIX = 'pokesearch.justtcg.sets.'
const SETS_TTL_MS = 24 * 60 * 60 * 1000

// The game list rarely changes; fetch it once per session.
let gamesPromise: Promise<{ id: string; name: string }[]> | undefined

async function apiGet(key: string, path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, { headers: { 'x-api-key': key } })
  if (!res.ok) throw new Error(`justtcg ${res.status}`)
  return res.json()
}

async function listGames(key: string): Promise<{ id: string; name: string }[]> {
  gamesPromise ??= apiGet(key, '/games')
    .then((body) => ((body as { data?: { id: string; name: string }[] }).data ?? []))
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

/** Find the JustTCG set id for a Japanese set code like "SV2a" (cached 24h). */
async function resolveJaSet(key: string, game: string, setId: string): Promise<string | undefined> {
  const cacheKey = SETS_CACHE_PREFIX + game
  let sets: { id: string; name: string }[] | undefined
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) ?? '')
    if (Date.now() - cached.fetchedAt < SETS_TTL_MS) sets = cached.sets
  } catch {
    /* no cache */
  }
  if (!sets) {
    const body = (await apiGet(key, `/sets?game=${encodeURIComponent(game)}&limit=500`)) as {
      data?: { id: string; name: string }[]
    }
    sets = (body.data ?? []).map((s) => ({ id: s.id, name: s.name }))
    if (sets.length > 0) {
      localStorage.setItem(cacheKey, JSON.stringify({ fetchedAt: Date.now(), sets }))
    }
  }
  const code = setId.toLowerCase()
  return (
    sets.find((s) => s.name.toLowerCase().startsWith(`${code}:`)) ??
    sets.find((s) => s.id.toLowerCase().startsWith(`${code}-`))
  )?.id
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

function variantsToQuotes(match: JustTcgCard): PriceQuote[] {
  const quotes: PriceQuote[] = []
  const byPrinting = new Map<string, JustTcgVariant[]>()
  for (const v of match.variants ?? []) {
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

  let cards: JustTcgCard[]
  if (card.lang === 'ja') {
    const set = await resolveJaSet(key, game, card.setId)
    if (!set) return []
    const params = new URLSearchParams({ game, set, number: card.number, limit: '20' })
    cards = ((await apiGet(key, `/cards?${params}`)) as { data?: JustTcgCard[] }).data ?? []
  } else {
    const params = new URLSearchParams({ q: card.name, game, limit: '20' })
    cards = ((await apiGet(key, `/cards?${params}`)) as { data?: JustTcgCard[] }).data ?? []
  }

  // Same name+number pairs repeat across sets, so both a collector-number
  // match and a set match are required — no quote is better than the wrong
  // card's quote. The JA path is already scoped to the exact set by the
  // request; EN must find a set-name overlap among the name-search results.
  const wantNumber = normalizeCardNumber(card.number)
  const numbered = cards.filter((c) => normalizeCardNumber(c.number) === wantNumber)
  const match =
    card.lang === 'ja'
      ? numbered[0]
      : numbered.find((c) => setNamesOverlap(c.set_name, card.set))
  if (!match?.variants?.length) return []
  return variantsToQuotes(match)
}
