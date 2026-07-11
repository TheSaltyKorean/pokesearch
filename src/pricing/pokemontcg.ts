import type { CardEntry, PriceQuote, Settings } from '../lib/types'

/**
 * Pokemon TCG API (pokemontcg.io) — free. TCGplayer (USD) and Cardmarket (EUR)
 * per-variant prices for English cards. Works without a key at a lower rate
 * limit; a free key can be added in Settings.
 */
export async function fetchPokemonTcgPrices(
  card: CardEntry,
  settings: Settings,
): Promise<PriceQuote[]> {
  if (card.lang !== 'en') return []
  const headers: Record<string, string> = {}
  if (settings.pokemonTcgApiKey) headers['X-Api-Key'] = settings.pokemonTcgApiKey
  const res = await fetch(`https://api.pokemontcg.io/v2/cards/${card.id}`, { headers })
  if (!res.ok) throw new Error(`pokemontcg.io ${res.status}`)
  const { data } = await res.json()
  const quotes: PriceQuote[] = []
  const now = new Date().toISOString()

  const tp = data?.tcgplayer
  if (tp?.prices) {
    for (const [variant, p] of Object.entries<Record<string, number | null>>(tp.prices)) {
      quotes.push({
        source: 'TCGplayer',
        variant,
        currency: 'USD',
        low: p.low ?? undefined,
        mid: p.mid ?? undefined,
        high: p.high ?? undefined,
        market: p.market ?? undefined,
        url: tp.url,
        updatedAt: tp.updatedAt ?? now,
      })
    }
  }

  const cm = data?.cardmarket
  if (cm?.prices) {
    quotes.push({
      source: 'Cardmarket',
      variant: 'normal',
      currency: 'EUR',
      low: cm.prices.lowPrice ?? undefined,
      mid: cm.prices.trendPrice ?? cm.prices.averageSellPrice ?? undefined,
      high: cm.prices.avg30 ?? undefined,
      market: cm.prices.averageSellPrice ?? undefined,
      url: cm.url,
      updatedAt: cm.updatedAt ?? now,
    })
    if (cm.prices.reverseHoloTrend || cm.prices.reverseHoloSell) {
      quotes.push({
        source: 'Cardmarket',
        variant: 'reverseHolofoil',
        currency: 'EUR',
        low: cm.prices.reverseHoloLow ?? undefined,
        mid: cm.prices.reverseHoloTrend ?? undefined,
        high: cm.prices.reverseHoloAvg30 ?? undefined,
        market: cm.prices.reverseHoloSell ?? undefined,
        url: cm.url,
        updatedAt: cm.updatedAt ?? now,
      })
    }
  }
  return quotes
}
