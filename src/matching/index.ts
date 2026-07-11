import { hamming16, cardHash } from '../lib/hash'
import type { CardIndex, MatchResult } from '../lib/types'

const BASE = import.meta.env.BASE_URL

/** Languages we attempt to load; missing files are skipped silently. */
export const INDEX_LANGS = ['en', 'ja', 'ko', 'zh-tw', 'de', 'fr', 'it', 'es'] as const

const loaded = new Map<string, CardIndex>()
let loadPromise: Promise<void> | null = null

async function loadLang(lang: string): Promise<void> {
  try {
    const [metaRes, binRes] = await Promise.all([
      fetch(`${BASE}carddata/index-${lang}.json`),
      fetch(`${BASE}carddata/hashes-${lang}.bin`),
    ])
    if (!metaRes.ok || !binRes.ok) return
    const meta = await metaRes.json()
    const hashes = new Uint8Array(await binRes.arrayBuffer())
    if (hashes.length !== meta.cards.length * 16) {
      console.warn(`index ${lang}: hash/meta length mismatch, skipping`)
      return
    }
    loaded.set(lang, { ...meta, hashes })
  } catch {
    /* index for this language not published yet */
  }
}

export function ensureIndexesLoaded(): Promise<void> {
  loadPromise ??= Promise.all(INDEX_LANGS.map(loadLang)).then(() => undefined)
  return loadPromise
}

export function loadedLanguages(): string[] {
  return [...loaded.keys()]
}

export function indexedCardCount(): number {
  let n = 0
  for (const idx of loaded.values()) n += idx.count
  return n
}

/** Match a 16-byte probe hash against every loaded language index. */
export function matchHash(probe: Uint8Array, topK = 8): MatchResult[] {
  const results: MatchResult[] = []
  for (const idx of loaded.values()) {
    for (let i = 0; i < idx.cards.length; i++) {
      const distance = hamming16(probe, idx.hashes, i)
      results.push({
        card: idx.cards[i],
        distance,
        confidence: Math.max(0, 1 - distance / 48),
      })
    }
  }
  results.sort((a, b) => a.distance - b.distance)
  return results.slice(0, topK)
}

/**
 * Match an uploaded/captured image. Tries the full frame plus a centered
 * card-aspect (63:88) crop, and returns the best candidate set.
 */
export function matchImage(
  src: CanvasImageSource,
  width: number,
  height: number,
  topK = 8,
): MatchResult[] {
  const probes: Uint8Array[] = [cardHash(src, width, height)]
  const cardAspect = 63 / 88
  const frameAspect = width / height
  if (Math.abs(frameAspect - cardAspect) > 0.06) {
    let cw: number, ch: number
    if (frameAspect > cardAspect) {
      ch = height
      cw = height * cardAspect
    } else {
      cw = width
      ch = width / cardAspect
    }
    const c = document.createElement('canvas')
    c.width = Math.round(cw)
    c.height = Math.round(ch)
    const ctx = c.getContext('2d')!
    ctx.drawImage(src, (width - cw) / 2, (height - ch) / 2, cw, ch, 0, 0, c.width, c.height)
    probes.push(cardHash(c, c.width, c.height))
  }
  const best = new Map<string, MatchResult>()
  for (const p of probes) {
    for (const r of matchHash(p, topK)) {
      const key = `${r.card.lang}:${r.card.id}`
      const prev = best.get(key)
      if (!prev || r.distance < prev.distance) best.set(key, r)
    }
  }
  return [...best.values()].sort((a, b) => a.distance - b.distance).slice(0, topK)
}

/** Plain text search across loaded catalogs (fallback / manual lookup). */
export function searchByName(q: string, limit = 30) {
  const needle = q.trim().toLowerCase()
  if (needle.length < 2) return []
  const out = []
  for (const idx of loaded.values()) {
    for (const c of idx.cards) {
      if (c.name.toLowerCase().includes(needle)) {
        out.push(c)
        if (out.length >= limit * 4) break
      }
    }
  }
  out.sort((a, b) => a.name.length - b.name.length)
  return out.slice(0, limit)
}
