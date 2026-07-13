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

// Grader names also appear in compact forms ("PSA10", "BGS9.5") where no
// word boundary follows the name, so allow an optional attached grade.
const GRADED_RE = /\b(PSA|BGS|CGC|SGC)(\s*\d|\b)|\bgraded\b|\bgem\s*mint\b/i

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
  // "SV2a 006" outperforms "リザードンex" ~30x. Names that are merely
  // accented ("Pokémon Center", "Nidoran ♀") are folded to ASCII and kept;
  // only names with no real Latin word left fall back to set code + number.
  // Without a set code (old collection entries) a bare number would mix
  // unrelated sets, so skip rather than risk wrong prices.
  const ascii = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\x20-\x7e]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  const asciiName = ascii(card.name)
  // Mechanics suffixes (ex/GX/V/VMAX/VSTAR/BREAK…) survive folding but are
  // not names — "リザードンVSTAR" must not become a bare "VSTAR" search, and
  // different sets reuse numbers ("VSTAR 118" is both S9 Charizard and S12
  // Lugia). Any other Latin letter counts as a usable name though: real
  // short names exist ("Ho-Oh V", the trainer "N") and must keep their
  // name-based query — internal set ids like swsh12 mean nothing to sellers.
  const substantive = asciiName.replace(/\b(ex|gx|v|vmax|vstar|break|prism|lv\.?x)\b/gi, '').trim()
  const useName = /[a-z]/i.test(substantive)
  if (!useName && !card.setId) return []
  const terms = useName
    ? `pokemon ${qualifier} ${asciiName} ${card.number} ${ascii(card.set) || card.setId}`
    : `pokemon ${qualifier} ${card.setId} ${card.number}`
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
