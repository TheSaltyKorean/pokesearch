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
    // Cardmarket blocks expose "" (normal) and "-holo" key suffixes. The
    // `trend` field is frequently an outlier, so the range is built from the
    // rolling averages instead. The "-holo" block covers whichever foil
    // variant the card actually has: true holo, or reverse holo when the
    // card only exists in normal + reverse (per data.variants).
    const foilVariant =
      data?.variants?.holo === false && data?.variants?.reverse
        ? 'reverseHolofoil'
        : 'holofoil'
    for (const [variant, sfx] of [
      ['normal', ''],
      [foilVariant, '-holo'],
    ] as const) {
      const low = cm[`low${sfx}`]
      const avgs = [cm[`avg1${sfx}`], cm[`avg7${sfx}`], cm[`avg30${sfx}`], cm[`avg${sfx}`]]
        .filter((v: unknown): v is number => typeof v === 'number' && v > 0)
      if (low == null && avgs.length === 0) continue
      quotes.push({
        source: 'Cardmarket (TCGdex)',
        variant,
        currency: cm.unit ?? 'EUR',
        low: low ?? Math.min(...avgs),
        mid: cm[`avg30${sfx}`] ?? cm[`avg${sfx}`] ?? avgs[0],
        high: avgs.length ? Math.max(...avgs) : undefined,
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
