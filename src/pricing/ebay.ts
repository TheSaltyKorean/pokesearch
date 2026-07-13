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

const GRADED_RE = /\b(PSA|BGS|CGC|SGC|graded|gem\s*mint)\b/i

function percentiles(prices: number[]): { low: number; mid: number; high: number } {
  const s = [...prices].sort((a, b) => a - b)
  const pct = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))]
  return { low: pct(0.1), mid: pct(0.5), high: pct(0.9) }
}

/**
 * eBay Browse API via the price-proxy Worker (Settings → workerUrl). eBay
 * sends no CORS headers and its app tokens expire every 2 hours, so the
 * Worker owns the credentials and token refresh; the app never sees them.
 * Uses current active listings as a real-world range, split into raw vs
 * graded buckets (graded listings would otherwise skew the raw range badly).
 */
export async function fetchEbayPrices(
  card: CardEntry,
  settings: Settings,
): Promise<PriceQuote[]> {
  const base = settings.workerUrl?.replace(/\/+$/, '')
  if (!base) return []
  const qualifier = LANG_QUALIFIER[card.lang] ?? ''
  // eBay listings are titled in English (romanized set codes + collector
  // numbers), so searching a non-Latin card name finds almost nothing —
  // "SV2a 006" outperforms "リザードンex" ~30x. Use set code + number there.
  const terms = /[^\x20-\x7e]/.test(card.name)
    ? `pokemon ${qualifier} ${card.setId} ${card.number}`
    : `pokemon ${qualifier} ${card.name} ${card.number} ${card.set}`
  const q = encodeURIComponent(terms.replace(/\s+/g, ' ').trim())
  const res = await fetch(`${base}/ebay/search?q=${q}&category_ids=183454&limit=50`)
  if (!res.ok) throw new Error(`ebay proxy ${res.status}`)
  const data = await res.json()
  const items: { title?: string; price?: { value?: string; currency?: string } }[] =
    data.itemSummaries ?? []
  const now = new Date().toISOString()
  const currency = items[0]?.price?.currency ?? 'USD'
  const buckets: Record<'normal' | 'graded', number[]> = { normal: [], graded: [] }
  for (const it of items) {
    const v = Number(it.price?.value)
    if (!Number.isFinite(v) || v <= 0) continue
    buckets[GRADED_RE.test(it.title ?? '') ? 'graded' : 'normal'].push(v)
  }
  const quotes: PriceQuote[] = []
  for (const [variant, prices] of Object.entries(buckets)) {
    if (prices.length < 3) continue // too thin to call it a range
    const { low, mid, high } = percentiles(prices)
    quotes.push({
      source: `eBay (${prices.length} listings)`,
      variant,
      currency,
      low,
      mid,
      high,
      updatedAt: now,
    })
  }
  return quotes
}
