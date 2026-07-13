/** A card entry in the prebuilt identification index. */
export interface CardEntry {
  /** Source card id, e.g. "base1-4" (PTCG) or "base1-4" (TCGdex ids overlap for EN) */
  id: string
  name: string
  set: string
  setId: string
  number: string
  rarity?: string
  /** Catalog language: en, ja, ko, zh-tw, zh-cn, de, fr, it, es, pt, ru */
  lang: string
  /** Full-size image URL for display */
  img: string
  /** Which catalog this came from */
  src: 'ptcg' | 'tcgdex'
}

export interface CardIndex {
  lang: string
  count: number
  cards: CardEntry[]
  /** 16 bytes per card, same order as cards[] */
  hashes: Uint8Array
}

export interface MatchResult {
  card: CardEntry
  /** Hamming distance 0..128, lower is better */
  distance: number
  /** 0..1 confidence derived from distance */
  confidence: number
}

export type VariantKey =
  | 'normal'
  | 'holofoil'
  | 'reverseHolofoil'
  | '1stEditionNormal'
  | '1stEditionHolofoil'
  | 'unlimited'
  | 'graded'

export interface PriceQuote {
  source: string
  variant: VariantKey | string
  currency: string
  low?: number
  mid?: number
  high?: number
  market?: number
  url?: string
  updatedAt: string
}

export interface PriceRange {
  low: number
  mid: number
  high: number
  currency: string
}

export interface CollectionEntry {
  uid: string
  cardId: string
  lang: string
  name: string
  set: string
  /** Set code (e.g. "SV2a"); absent on entries saved before it was added. */
  setId?: string
  number: string
  img: string
  variant: string
  qty: number
  condition: 'NM' | 'LP' | 'MP' | 'HP' | 'DMG' | 'Graded'
  paid?: number
  addedAt: string
  lastPricedAt?: string
  range?: PriceRange
}

export interface Settings {
  pokemonTcgApiKey?: string
  justTcgKey?: string
  pokemonPriceTrackerKey?: string
  priceChartingKey?: string
  /**
   * Price-proxy (Cloudflare Worker) base URL. Holds shared API keys
   * server-side and fronts sources that lack CORS (eBay). Used by a source
   * whenever its per-user key above is empty.
   */
  workerUrl?: string
  /** Shared token for collection sync through the Worker (/collection). */
  syncToken?: string
  /** Display currency for all prices (quotes are FX-converted); default USD */
  currency?: string
}

export const SETTINGS_KEY = 'pokesearch.settings'

export function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')
    // Settings that no longer exist (pre-worker eBay token / CORS proxy)
    // have no UI to view or clear them; scrub them from storage too so the
    // stale credential doesn't sit in localStorage indefinitely.
    if ('ebayToken' in s || 'corsProxy' in s) {
      delete s.ebayToken
      delete s.corsProxy
      saveSettings(s)
    }
    return s
  } catch {
    return {}
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
}
