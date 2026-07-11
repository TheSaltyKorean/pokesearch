import type { VariantKey } from '../lib/types'

/** Shared helpers for matching our catalog cards against external price APIs. */

/**
 * Normalize a collector number for cross-catalog comparison: "025" → "25",
 * "4/102" → "4", "SV2a 025" → "25" won't occur (numbers come in bare), but
 * suffixes like "025/165" and leading zeros differ between catalogs.
 */
export function normalizeCardNumber(n: string | undefined): string {
  if (!n) return ''
  return n.split('/')[0].trim().replace(/^0+(?=\d)/, '').toLowerCase()
}

/**
 * Loose match between our set name and an API's set name. Exact match after
 * normalization, or containment where the leftover has no digits — so
 * "Base" ~ "Base Set" but not "Base" ~ "Base Set 2" (a different set).
 */
export function setNamesOverlap(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  // Keep letters/digits of every script (set names can be Japanese etc.);
  // strip only punctuation and symbols.
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
  const na = norm(a)
  const nb = norm(b)
  if (!na || !nb) return false
  if (na === nb) return true
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na]
  return longer.includes(shorter) && !/\d/.test(longer.replace(shorter, ''))
}

/** Map an external "printing" label onto our variant keys. */
export function printingToVariant(printing: string | undefined): VariantKey | string {
  const p = (printing ?? 'Normal').toLowerCase()
  if (p.includes('1st')) return p.includes('holo') ? '1stEditionHolofoil' : '1stEditionNormal'
  if (p.includes('reverse')) return 'reverseHolofoil'
  if (p.includes('holo') || p.includes('foil')) return 'holofoil'
  if (p === 'unlimited') return 'unlimited'
  return 'normal'
}
