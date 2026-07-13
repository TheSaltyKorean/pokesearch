import type { CardEntry, PriceQuote, PriceRange } from '../lib/types'
import { loadSettings } from '../lib/types'
import { fetchPokemonTcgPrices } from './pokemontcg'
import { fetchTcgdexPrices } from './tcgdex'
import { fetchJustTcgPrices } from './justtcg'
import { fetchPokemonPriceTrackerPrices } from './pokemonpricetracker'
import { fetchPriceChartingPrices } from './pricecharting'
import { fetchEbayPrices } from './ebay'
import { convertQuote, getUsdRates } from './fx'

/**
 * Fetch quotes from every configured source; individual failures are
 * non-fatal. `background: true` (the collection's automatic stale-refresh)
 * skips every shared-quota source (JustTCG 100 req/day, PokemonPriceTracker
 * 100 credits/day, eBay and worker-routed PriceCharting on the shared
 * Worker keys) so re-pricing a collection can't silently burn quotas —
 * only unmetered sources and the user's own PriceCharting key run there.
 */
export async function fetchAllPrices(
  card: CardEntry,
  opts: { background?: boolean } = {},
): Promise<PriceQuote[]> {
  const settings = loadSettings()
  const results = await Promise.allSettled([
    fetchPokemonTcgPrices(card, settings),
    fetchTcgdexPrices(card),
    ...(opts.background
      ? settings.priceChartingKey
        ? [fetchPriceChartingPrices(card, settings)]
        : []
      : [
          fetchJustTcgPrices(card, settings),
          fetchPokemonPriceTrackerPrices(card, settings),
          fetchEbayPrices(card, settings),
          fetchPriceChartingPrices(card, settings),
        ]),
  ])
  const quotes: PriceQuote[] = []
  for (const r of results) {
    if (r.status === 'fulfilled') quotes.push(...r.value)
    else console.warn('price source failed:', r.reason)
  }
  // Convert everything into the user's display currency (default USD). If the
  // FX fetch fails, quotes keep their native currencies and summarizeRange
  // falls back to picking one.
  const target = settings.currency ?? 'USD'
  if (quotes.some((q) => q.currency !== target)) {
    try {
      const rates = await getUsdRates()
      return quotes.map((q) => convertQuote(q, target, rates))
    } catch (err) {
      console.warn('fx rates unavailable:', err)
    }
  }
  return quotes
}

/** Collapse quotes (optionally for one variant) into a single displayable range. */
export function summarizeRange(
  quotes: PriceQuote[],
  variant?: string,
): PriceRange | undefined {
  const usable = quotes.filter(
    (q) => (!variant || q.variant === variant) && (q.mid ?? q.market ?? q.low) !== undefined,
  )
  if (usable.length === 0) return undefined
  // Quotes are normally pre-converted to the display currency; if FX was
  // unavailable, prefer the display currency, then USD, then what we have.
  const target = loadSettings().currency ?? 'USD'
  const currencies = new Set(usable.map((q) => q.currency))
  const currency = currencies.has(target) ? target : currencies.has('USD') ? 'USD' : usable[0].currency
  const filtered = usable.filter((q) => q.currency === currency)
  const lows = filtered.map((q) => q.low ?? q.mid ?? q.market!).filter(Number.isFinite)
  const mids = filtered.map((q) => q.mid ?? q.market ?? q.low!).filter(Number.isFinite)
  const highs = filtered.map((q) => q.high ?? q.mid ?? q.market!).filter(Number.isFinite)
  if (mids.length === 0) return undefined
  // Quotes may carry only a subset of low/mid/high; fall back to mids so the
  // bounds always stay finite.
  let low = Math.min(...(lows.length ? lows : mids))
  let high = Math.max(...(highs.length ? highs : mids))
  if (low > high) [low, high] = [high, low]
  const mid = Math.min(high, Math.max(low, mids.reduce((a, b) => a + b, 0) / mids.length))
  return { low, mid, high, currency }
}

export function variantsWithPrices(quotes: PriceQuote[]): string[] {
  return [...new Set(quotes.map((q) => q.variant))]
}

export function formatMoney(v: number | undefined, currency: string): string {
  if (v === undefined || !Number.isFinite(v)) return '—'
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(v)
}
