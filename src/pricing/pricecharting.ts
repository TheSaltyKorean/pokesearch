import type { CardEntry, PriceQuote, Settings } from '../lib/types'

const LANG_QUALIFIER: Record<string, string> = {
  ja: 'japanese',
  ko: 'korean',
  'zh-tw': 'chinese',
  'zh-cn': 'chinese',
}

/**
 * PriceCharting — requires the user's API key (paid subscription), entered in
 * Settings. Strongest source for Japanese cards and graded values. The API
 * sends `access-control-allow-origin: *` (verified), so no CORS proxy is
 * needed. Prices come back as integer pennies. Limit: 1 call/second.
 */
export async function fetchPriceChartingPrices(
  card: CardEntry,
  settings: Settings,
): Promise<PriceQuote[]> {
  const key = settings.priceChartingKey
  if (!key) return []
  const qualifier = LANG_QUALIFIER[card.lang] ?? ''
  const q = encodeURIComponent(
    `pokemon ${qualifier} ${card.set} ${card.name} #${card.number}`.replace(/\s+/g, ' ').trim(),
  )
  const res = await fetch(`https://www.pricecharting.com/api/product?t=${key}&q=${q}`)
  if (!res.ok) throw new Error(`pricecharting ${res.status}`)
  const data = await res.json()
  if (data.status !== 'success') return []
  const cents = (v: unknown) => (typeof v === 'number' ? v / 100 : undefined)
  const now = new Date().toISOString()
  const quotes: PriceQuote[] = []
  const loose = cents(data['loose-price'])
  if (loose !== undefined) {
    quotes.push({
      source: 'PriceCharting',
      variant: 'normal',
      currency: 'USD',
      low: loose * 0.8,
      mid: loose,
      high: cents(data['cib-price']) ?? loose * 1.25,
      url: `https://www.pricecharting.com/game/${data.id ?? ''}`,
      updatedAt: now,
    })
  }
  const graded = cents(data['graded-price'])
  if (graded !== undefined) {
    quotes.push({
      source: 'PriceCharting',
      variant: 'graded',
      currency: 'USD',
      low: cents(data['cib-price']),
      mid: graded,
      high: cents(data['manual-only-price']) ?? cents(data['box-only-price']) ?? graded * 1.5,
      updatedAt: now,
    })
  }
  return quotes
}
