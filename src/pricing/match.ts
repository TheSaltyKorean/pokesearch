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
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim()
  const na = norm(a)
  const nb = norm(b)
  if (!na || !nb) return false
  if (na === nb) return true
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na]
  return longer.includes(shorter) && !/\d/.test(longer.replace(shorter, ''))
}
