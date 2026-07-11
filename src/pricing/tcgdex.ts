import type { CardEntry, PriceQuote } from '../lib/types'

/**
 * TCGdex (tcgdex.net) — free, no key, CORS-friendly. Multilingual catalog;
 * some cards carry Cardmarket / TCGplayer pricing blocks.
 */
export async function fetchTcgdexPrices(card: CardEntry): Promise<PriceQuote[]> {
  if (card.src !== 'tcgdex') return []
  const res = await fetch(`https://api.tcgdex.net/v2/${card.lang}/cards/${card.id}`)
  if (!res.ok) throw new Error(`tcgdex ${res.status}`)
  const data = await res.json()
  const quotes: PriceQuote[] = []
  const now = new Date().toISOString()
  const pricing = data?.pricing
  if (!pricing) return quotes

  const cm = pricing.cardmarket
  if (cm) {
    for (const [variant, key] of [
      ['normal', ''],
      ['reverseHolofoil', '-reverse'],
    ] as const) {
      const trend = cm[`trend${key ? '-reverse' : ''}`] ?? cm.trend
      const low = cm[`low${key}`] ?? (variant === 'normal' ? cm.low : undefined)
      const avg30 = cm[`avg30${key}`] ?? (variant === 'normal' ? cm.avg30 : undefined)
      if (variant === 'reverseHolofoil' && cm['trend-reverse'] == null) continue
      if (trend == null && low == null) continue
      quotes.push({
        source: 'Cardmarket (TCGdex)',
        variant,
        currency: cm.unit ?? 'EUR',
        low: low ?? undefined,
        mid: trend ?? undefined,
        high: avg30 ?? undefined,
        updatedAt: cm.updated ?? now,
      })
    }
  }

  const tp = pricing.tcgplayer
  if (tp) {
    for (const variant of ['normal', 'holofoil', 'reverse-holofoil'] as const) {
      const p = tp[variant]
      if (!p) continue
      quotes.push({
        source: 'TCGplayer (TCGdex)',
        variant: variant === 'reverse-holofoil' ? 'reverseHolofoil' : variant,
        currency: tp.unit ?? 'USD',
        low: p.lowPrice ?? undefined,
        mid: p.marketPrice ?? undefined,
        high: p.highPrice ?? undefined,
        market: p.marketPrice ?? undefined,
        updatedAt: tp.updated ?? now,
      })
    }
  }
  return quotes
}
