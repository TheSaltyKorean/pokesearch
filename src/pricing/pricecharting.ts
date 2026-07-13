import type { CardEntry, PriceQuote, Settings } from '../lib/types'

const LANG_QUALIFIER: Record<string, string> = {
  ja: 'japanese',
  ko: 'korean',
  'zh-tw': 'chinese',
  'zh-cn': 'chinese',
}

// PriceCharting enforces 1 call/second per token (exceeding it can revoke
// API access). Space out request starts, sharing the budget across
// concurrent callers such as the collection's stale-refresh loop.
let nextSlot = 0
async function rateLimit(): Promise<void> {
  const now = Date.now()
  const wait = Math.max(0, nextSlot - now)
  nextSlot = Math.max(now, nextSlot) + 1100
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
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
  const base = key
    ? 'https://www.pricecharting.com/api/product'
    : settings.workerUrl && `${settings.workerUrl.replace(/\/+$/, '')}/pricecharting/product`
  if (!base) return []
  const qualifier = LANG_QUALIFIER[card.lang] ?? ''
  const params = new URLSearchParams({
    q: `pokemon ${qualifier} ${card.set} ${card.name} #${card.number}`.replace(/\s+/g, ' ').trim(),
  })
  if (key) params.set('t', key)
  // Direct calls hit PriceCharting with the user's own token, so the browser
  // spaces them; worker calls are throttled (and mostly edge-cached) there.
  if (key) await rateLimit()
  const res = await fetch(`${base}?${params}`)
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
