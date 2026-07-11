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

/** Loose containment check between our set name and an API's set name. */
export function setNamesOverlap(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const na = a.toLowerCase()
  const nb = b.toLowerCase()
  return na.includes(nb) || nb.includes(na)
}
