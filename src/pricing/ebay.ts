import type { CardEntry, PriceQuote, Settings } from '../lib/types'

const LANG_QUALIFIER: Record<string, string> = {
  ja: 'japanese',
  ko: 'korean',
  'zh-tw': 'chinese',
  'zh-cn': 'chinese',
  de: 'german',
  fr: 'french',
  it: 'italian',
  es: 'spanish',
}

/**
 * eBay Browse API — requires the user's OAuth application token (Settings).
 * Uses current active listings as a real-world range (the sold-items API
 * needs Marketplace Insights approval). eBay's API is not CORS-enabled, so
 * browser calls need the optional CORS proxy from Settings.
 */
export async function fetchEbayPrices(
  card: CardEntry,
  settings: Settings,
): Promise<PriceQuote[]> {
  const token = settings.ebayToken
  if (!token) return []
  const qualifier = LANG_QUALIFIER[card.lang] ?? ''
  const q = encodeURIComponent(`pokemon ${qualifier} ${card.name} ${card.number} ${card.set}`)
  const base = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${q}&category_ids=183454&limit=25`
  const url = settings.corsProxy ? settings.corsProxy + encodeURIComponent(base) : base
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`ebay ${res.status}`)
  const data = await res.json()
  const prices: number[] = (data.itemSummaries ?? [])
    .map((it: { price?: { value?: string } }) => Number(it.price?.value))
    .filter((v: number) => Number.isFinite(v) && v > 0)
    .sort((a: number, b: number) => a - b)
  if (prices.length < 3) return []
  const pct = (p: number) => prices[Math.min(prices.length - 1, Math.floor(prices.length * p))]
  return [
    {
      source: `eBay (${prices.length} listings)`,
      variant: 'normal',
      currency: data.itemSummaries[0]?.price?.currency ?? 'USD',
      low: pct(0.1),
      mid: pct(0.5),
      high: pct(0.9),
      updatedAt: new Date().toISOString(),
    },
  ]
}
