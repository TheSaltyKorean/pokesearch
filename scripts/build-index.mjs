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
 *   node scripts/build-index.mjs --source jpofficial --match '^(SM|S)'
 *
 * jpofficial scrapes the official pokemon-card.com card database (covers
 * XY era → present, including all SM/SWSH sets missing from TCGdex). It is
 * always lang=ja. Korean cards mirror Japanese sets 1:1 (same art), so this
 * catalog is also what Korean scans match against. --match filters set codes
 * by regex. Cards already indexed are skipped via the srcId field, which is
 * also back-filled onto TCGdex-sourced entries the first time they're seen.
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
const SOURCE = arg('source', 'ptcg') // ptcg | tcgdex | jpofficial
const LANG = SOURCE === 'ptcg' ? 'en' : SOURCE === 'jpofficial' ? 'ja' : arg('lang', 'en')
const OUT = arg('out', 'public/carddata')
const SETS = (arg('sets', '') || '').split(',').filter(Boolean)
const MATCH = arg('match', '') // jpofficial: regex filter on set codes
const CONCURRENCY = Number(arg('concurrency', SOURCE === 'jpofficial' ? '4' : '8'))
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

async function fetchImage(url, headers = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers })
      if (!res.ok) throw new Error(`${res.status} ${url}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (e) {
      if (attempt === 2) throw e
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
}

const JP_BASE = 'https://www.pokemon-card.com'
const JP_UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) pokesearch-index-builder' }

async function fetchTextRetry(url, headers = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers })
      if (!res.ok) throw new Error(`${res.status} ${url}`)
      return await res.text()
    } catch (e) {
      if (attempt === 2) throw e
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
}

/**
 * Enumerate the whole pokemon-card.com card DB (XY era → present).
 * Returns [{srcId, name, setCode, img}], newest first.
 */
async function jpListAll() {
  const out = []
  for (const type of ['pokemon', 'trainer', 'energy']) {
    const url = (page) =>
      `${JP_BASE}/card-search/resultAPI.php?keyword=&se_ta=${type}&regulation_sidebar_form=all&sm_and_keyword=true&page=${page}`
    const first = await fetchJson(url(1), JP_UA)
    const maxPage = Number(first.maxPage) || 1
    console.log(`[jpofficial/${type}] ${first.hitCnt} cards, ${maxPage} pages`)
    let pages = [first]
    for (let p = 2; p <= maxPage; p++) {
      pages.push(await fetchJson(url(p), JP_UA))
      if (p % 50 === 0) console.log(`  listed page ${p}/${maxPage}`)
    }
    for (const pg of pages) {
      for (const c of pg.cardList ?? []) {
        const m = /\/card_images\/large\/([^/]+)\//.exec(c.cardThumbFile ?? '')
        if (!m) continue
        out.push({
          srcId: String(c.cardID),
          name: c.cardNameAltText || c.cardNameViewText || '',
          setCode: m[1],
          img: JP_BASE + c.cardThumbFile,
        })
      }
    }
  }
  return out
}

/** Collection number ("081", "183", …) from the card details page. */
async function jpCardNumber(srcId) {
  const html = await fetchTextRetry(
    `${JP_BASE}/card-search/details.php/card/${srcId}/regu/all`,
    JP_UA,
  )
  const m = /&nbsp;([0-9A-Za-z-]+)&nbsp;\/&nbsp;[0-9A-Za-z-]+&nbsp;/.exec(html)
  return m ? m[1] : null
}

async function buildJpOfficial(existing) {
  const matchRe = MATCH ? new RegExp(MATCH) : null
  const knownSrc = new Set()
  for (const { entry } of existing.values()) if (entry.srcId) knownSrc.add(entry.srcId)

  const listed = await jpListAll()
  const todo = listed.filter(
    (c) => !knownSrc.has(c.srcId) && (!matchRe || matchRe.test(c.setCode)),
  )
  console.log(`[jpofficial] ${listed.length} listed, ${todo.length} new to process`)

  let done = 0
  const queue = [...todo]
  async function worker() {
    for (;;) {
      const item = queue.shift()
      if (!item) return
      done++
      try {
        const number = await jpCardNumber(item.srcId)
        const id = number ? `${item.setCode}-${number}` : `${item.setCode}-jp${item.srcId}`
        const prev = existing.get(id)
        if (prev) {
          // Same card already indexed (usually via TCGdex): keep its hash,
          // just record srcId so the next run skips the details fetch.
          prev.entry.srcId = item.srcId
          continue
        }
        const buf = await fetchImage(item.img, JP_UA)
        const hash = await cardHash(buf)
        existing.set(id, {
          entry: {
            id,
            name: item.name,
            set: item.setCode,
            setId: item.setCode,
            number: number ?? '',
            lang: 'ja',
            img: item.img,
            src: 'jpofficial',
            srcId: item.srcId,
          },
          hash,
        })
      } catch (e) {
        console.warn(`  skip jp:${item.srcId} (${item.setCode} ${item.name}): ${e.message}`)
      }
      if (done % 100 === 0) console.log(`  ${done}/${todo.length}`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  console.log(`[jpofficial] done (${done}/${todo.length})`)
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
  if (SOURCE !== 'jpofficial') {
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

  if (SOURCE === 'jpofficial') {
    await buildJpOfficial(existing)
    await writeIndex(existing, metaPath, binPath)
    return
  }

  let setsLoaded = 0
  for (const setId of sets) {
    console.log(`\n[${LANG}/${setId}] fetching card list…`)
    let cards
    try {
      cards = await loadSetCards(setId)
      setsLoaded++
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

  // Don't silently publish an empty/unchanged index when every requested set
  // failed (bad set id, TCGdex outage) — skipping is only OK within --sets all.
  if (setsLoaded === 0) {
    console.error('All requested sets failed to load; not writing index.')
    process.exit(1)
  }

  await writeIndex(existing, metaPath, binPath)
}

async function writeIndex(existing, metaPath, binPath) {
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
