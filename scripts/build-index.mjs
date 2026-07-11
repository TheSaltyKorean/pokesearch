#!/usr/bin/env node
/**
 * Builds the card identification index: downloads card images from the
 * Pokemon TCG API (English) or TCGdex (all languages), computes 16-byte
 * perceptual hashes (same dHash algorithm as src/lib/hash.ts — keep in sync!)
 * and writes/merges:
 *   public/carddata/index-<lang>.json   card metadata, ordered
 *   public/carddata/hashes-<lang>.bin   16 bytes per card, same order
 *
 * Usage:
 *   node scripts/build-index.mjs --source ptcg   --sets base1,base2
 *   node scripts/build-index.mjs --source tcgdex --lang ja --sets sv8a,sv7
 *   node scripts/build-index.mjs --source tcgdex --lang ja --sets all
 *   node scripts/build-index.mjs --source tcgdex --lang ja --list-sets
 *
 * Existing entries are merged (upsert by card id), so the index grows
 * set-by-set. The nightly GitHub Action calls this for configured sets.
 */
import sharp from 'sharp'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const args = process.argv.slice(2)
function arg(name, def) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : def
}
const SOURCE = arg('source', 'ptcg') // ptcg | tcgdex
const LANG = SOURCE === 'ptcg' ? 'en' : arg('lang', 'en')
const OUT = arg('out', 'public/carddata')
const SETS = (arg('sets', '') || '').split(',').filter(Boolean)
const CONCURRENCY = Number(arg('concurrency', '8'))
const API_KEY = process.env.POKEMONTCG_API_KEY

const W = 9
const H = 8

/** 64-bit dHash of an image buffer region; mirrors src/lib/hash.ts. */
async function dhashRegion(img, region) {
  let pipe = sharp(img)
  if (region) pipe = pipe.extract(region)
  const { data } = await pipe
    .resize(W, H, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const g = new Float64Array(W * H)
  for (let i = 0; i < W * H; i++) {
    g[i] = 0.299 * data[i * 3] + 0.587 * data[i * 3 + 1] + 0.114 * data[i * 3 + 2]
  }
  const out = new Uint8Array(8)
  let bit = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      if (g[y * W + x] > g[y * W + x + 1]) out[bit >> 3] |= 1 << (bit & 7)
      bit++
    }
  }
  return out
}

/** 16-byte card hash: whole card + art region. Mirrors src/lib/hash.ts. */
async function cardHash(buf) {
  const meta = await sharp(buf).metadata()
  const w = meta.width
  const h = meta.height
  const whole = await dhashRegion(buf)
  const art = await dhashRegion(buf, {
    left: Math.round(w * 0.08),
    top: Math.round(h * 0.08),
    width: Math.round(w * 0.84),
    height: Math.round(h * 0.47),
  })
  const out = new Uint8Array(16)
  out.set(whole, 0)
  out.set(art, 8)
  return out
}

async function fetchJson(url, headers = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers })
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)))
        continue
      }
      if (!res.ok) throw new Error(`${res.status} ${url}`)
      return await res.json()
    } catch (e) {
      if (attempt === 2) throw e
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
}

async function fetchImage(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`${res.status} ${url}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (e) {
      if (attempt === 2) throw e
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
}

/** [{entry, imgUrlForHashing}] for one set. */
async function loadSetCards(setId) {
  if (SOURCE === 'ptcg') {
    const headers = API_KEY ? { 'X-Api-Key': API_KEY } : {}
    const cards = []
    let page = 1
    for (;;) {
      const data = await fetchJson(
        `https://api.pokemontcg.io/v2/cards?q=set.id:${setId}&pageSize=250&page=${page}`,
        headers,
      )
      cards.push(...data.data)
      if (data.data.length < 250) break
      page++
    }
    return cards.map((c) => ({
      entry: {
        id: c.id,
        name: c.name,
        set: c.set?.name ?? setId,
        setId,
        number: c.number,
        rarity: c.rarity,
        lang: 'en',
        img: c.images?.large ?? c.images?.small,
        src: 'ptcg',
      },
      hashImg: c.images?.small ?? c.images?.large,
    }))
  }
  // tcgdex
  const set = await fetchJson(
    `https://api.tcgdex.net/v2/${LANG}/sets/${encodeURIComponent(setId)}`,
  )
  return (set.cards ?? [])
    .filter((c) => c.image)
    .map((c) => ({
      entry: {
        id: c.id,
        name: c.name,
        set: set.name ?? setId,
        setId,
        number: c.localId,
        lang: LANG,
        img: `${c.image}/high.webp`,
        src: 'tcgdex',
      },
      hashImg: `${c.image}/low.webp`,
    }))
}

async function main() {
  if (args.includes('--list-sets')) {
    const sets = await fetchJson(`https://api.tcgdex.net/v2/${LANG}/sets`)
    for (const s of sets) console.log(`${s.id}\t${s.cardCount?.total ?? '?'}\t${s.name}`)
    return
  }
  let sets = SETS
  if (sets.length === 1 && sets[0] === 'all') {
    if (SOURCE === 'ptcg') {
      const data = await fetchJson('https://api.pokemontcg.io/v2/sets?pageSize=250', API_KEY ? { 'X-Api-Key': API_KEY } : {})
      sets = data.data.map((s) => s.id)
    } else {
      const data = await fetchJson(`https://api.tcgdex.net/v2/${LANG}/sets`)
      sets = data.map((s) => s.id)
    }
    console.log(`--sets all → ${sets.length} sets`)
  }
  if (sets.length === 0) {
    console.error('No --sets given.')
    process.exit(1)
  }

  await mkdir(OUT, { recursive: true })
  const metaPath = path.join(OUT, `index-${LANG}.json`)
  const binPath = path.join(OUT, `hashes-${LANG}.bin`)

  // Load existing index for merge
  const existing = new Map()
  try {
    const meta = JSON.parse(await readFile(metaPath, 'utf8'))
    const bin = new Uint8Array(await readFile(binPath))
    meta.cards.forEach((c, i) => existing.set(c.id, { entry: c, hash: bin.slice(i * 16, i * 16 + 16) }))
    console.log(`Loaded existing ${LANG} index: ${existing.size} cards`)
  } catch {
    /* fresh index */
  }

  for (const setId of sets) {
    console.log(`\n[${LANG}/${setId}] fetching card list…`)
    let cards
    try {
      cards = await loadSetCards(setId)
    } catch (e) {
      console.warn(`[${LANG}/${setId}] skipped: ${e.message}`)
      continue
    }
    console.log(`[${LANG}/${setId}] ${cards.length} cards; hashing images…`)
    let done = 0
    const queue = [...cards]
    async function worker() {
      for (;;) {
        const item = queue.shift()
        if (!item) return
        if (existing.has(item.entry.id)) {
          done++
          continue
        }
        try {
          const buf = await fetchImage(item.hashImg)
          const hash = await cardHash(buf)
          existing.set(item.entry.id, { entry: item.entry, hash })
        } catch (e) {
          console.warn(`  skip ${item.entry.id}: ${e.message}`)
        }
        done++
        if (done % 50 === 0) console.log(`  ${done}/${cards.length}`)
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    console.log(`[${LANG}/${setId}] done (${done}/${cards.length})`)
  }

  const all = [...existing.values()]
  const bin = new Uint8Array(all.length * 16)
  all.forEach((c, i) => bin.set(c.hash, i * 16))
  await writeFile(
    metaPath,
    JSON.stringify({ lang: LANG, count: all.length, cards: all.map((c) => c.entry) }),
  )
  await writeFile(binPath, bin)
  console.log(`\nWrote ${metaPath} + ${binPath}: ${all.length} cards`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
