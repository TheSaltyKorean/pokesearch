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
        // Scaled to the display cutoff (60) so surfaced weak candidates
        // show a small-but-nonzero confidence instead of a misleading 0%
        confidence: Math.max(0, 1 - distance / 64),
      })
    }
  }
  results.sort((a, b) => a.distance - b.distance)
  return results.slice(0, topK)
}

/** Hash a sub-rectangle of the source (downscaled for speed). */
function hashCrop(
  src: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
): Uint8Array {
  const scale = Math.min(1, 256 / sw)
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(sw * scale))
  c.height = Math.max(1, Math.round(sh * scale))
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height)
  return cardHash(c, c.width, c.height)
}

/**
 * Match an uploaded/captured image. Real captures are never perfectly
 * framed, so a grid of jittered probes (small offsets and scales around the
 * best card-aspect rectangle) is hashed and the best distance per card wins.
 */
export function matchImage(
  src: CanvasImageSource,
  width: number,
  height: number,
  topK = 8,
): MatchResult[] {
  const cardAspect = 63 / 88
  const frameAspect = width / height
  // Largest centered card-aspect rectangle
  let cw: number, ch: number
  if (frameAspect > cardAspect) {
    ch = height
    cw = height * cardAspect
  } else {
    cw = width
    ch = width / cardAspect
  }
  const cx = (width - cw) / 2
  const cy = (height - ch) / 2

  const probes: Uint8Array[] = []
  // Whole frame (covers already-tight crops that aren't card aspect)
  probes.push(cardHash(src, width, height))
  // Jitter grid: offsets ±3% at every scale. Note the camera path passes an
  // already-tight 63:88 guide crop, where only the scaled-down probes have
  // room to shift — so offsets must combine with scaling, and out-of-bounds
  // probes are simply skipped.
  const offsets = [-0.03, 0, 0.03]
  const scales = [0.88, 0.94, 1, 1.06]
  for (const s of scales) {
    const jw = cw * s
    const jh = ch * s
    for (const ox of offsets) {
      for (const oy of offsets) {
        const sx = cx + (cw - jw) / 2 + ox * cw
        const sy = cy + (ch - jh) / 2 + oy * ch
        if (sx < 0 || sy < 0 || sx + jw > width || sy + jh > height) continue
        // Skip the probe identical to the whole-frame hash already pushed
        if (s === 1 && ox === 0 && oy === 0 && cx === 0 && cy === 0) continue
        probes.push(hashCrop(src, sx, sy, jw, jh))
      }
    }
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
