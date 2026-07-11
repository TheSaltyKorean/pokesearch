import type { PriceQuote } from '../lib/types'

/**
 * Currency conversion via frankfurter.dev — free, no key, CORS-enabled,
 * daily ECB reference rates. Rates are cached in localStorage for 24h so a
 * session costs at most one fetch.
 */

const FX_CACHE_KEY = 'pokesearch.fxrates.usd'
const FX_TTL_MS = 24 * 60 * 60 * 1000

/** Display currencies offered in Settings (subset of ECB reference rates). */
export const SUPPORTED_CURRENCIES = [
  'USD',
  'EUR',
  'GBP',
  'JPY',
  'KRW',
  'CAD',
  'AUD',
  'CHF',
  'CNY',
  'HKD',
  'SGD',
  'NZD',
  'SEK',
  'NOK',
  'MXN',
  'BRL',
] as const

interface FxCache {
  fetchedAt: number
  /** Units of each currency per 1 USD; always includes USD: 1. */
  rates: Record<string, number>
}

/** Rates per 1 USD. Throws if the network fails and no cache exists. */
export async function getUsdRates(): Promise<Record<string, number>> {
  let cached: FxCache | undefined
  try {
    cached = JSON.parse(localStorage.getItem(FX_CACHE_KEY) ?? '')
  } catch {
    /* no cache */
  }
  if (cached && Date.now() - cached.fetchedAt < FX_TTL_MS) return cached.rates
  try {
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=USD')
    if (!res.ok) throw new Error(`frankfurter ${res.status}`)
    const data = await res.json()
    const rates: Record<string, number> = { USD: 1, ...data.rates }
    localStorage.setItem(FX_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), rates }))
    return rates
  } catch (err) {
    if (cached) return cached.rates // stale beats nothing
    throw err
  }
}

export function convertAmount(
  v: number | undefined,
  from: string,
  to: string,
  rates: Record<string, number>,
): number | undefined {
  if (v === undefined || !Number.isFinite(v)) return undefined
  if (from === to) return v
  const rFrom = rates[from]
  const rTo = rates[to]
  if (!rFrom || !rTo) return undefined
  return (v / rFrom) * rTo
}

/** Convert a quote to the target currency; returned unchanged if impossible. */
export function convertQuote(
  q: PriceQuote,
  to: string,
  rates: Record<string, number>,
): PriceQuote {
  if (q.currency === to) return q
  if (!rates[q.currency] || !rates[to]) return q
  return {
    ...q,
    currency: to,
    low: convertAmount(q.low, q.currency, to, rates),
    mid: convertAmount(q.mid, q.currency, to, rates),
    high: convertAmount(q.high, q.currency, to, rates),
    market: convertAmount(q.market, q.currency, to, rates),
  }
}
