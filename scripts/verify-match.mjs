#!/usr/bin/env node
/**
 * Sanity-check the index: hash a given card image (URL or file) and report
 * the top-5 nearest cards across all built indexes. Used by CI/visual checks.
 *   node scripts/verify-match.mjs https://images.pokemontcg.io/base1/4_hires.png
 */
import sharp from 'sharp'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const W = 9, H = 8
async function dhashRegion(img, region) {
  let pipe = sharp(img)
  if (region) pipe = pipe.extract(region)
  const { data } = await pipe.resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const g = new Float64Array(W * H)
  for (let i = 0; i < W * H; i++) g[i] = 0.299 * data[i * 3] + 0.587 * data[i * 3 + 1] + 0.114 * data[i * 3 + 2]
  const out = new Uint8Array(8)
  let bit = 0
  for (let y = 0; y < H; y++) for (let x = 0; x < W - 1; x++) {
    if (g[y * W + x] > g[y * W + x + 1]) out[bit >> 3] |= 1 << (bit & 7)
    bit++
  }
  return out
}
async function cardHash(buf) {
  const { width: w, height: h } = await sharp(buf).metadata()
  const out = new Uint8Array(16)
  out.set(await dhashRegion(buf), 0)
  out.set(await dhashRegion(buf, {
    left: Math.round(w * 0.08), top: Math.round(h * 0.08),
    width: Math.round(w * 0.84), height: Math.round(h * 0.47),
  }), 8)
  return out
}
const POP = new Uint8Array(256)
for (let i = 0; i < 256; i++) POP[i] = (i & 1) + POP[i >> 1]

const src = process.argv[2]
if (!src) { console.error('usage: verify-match.mjs <image url|path>'); process.exit(1) }
const buf = src.startsWith('http') ? Buffer.from(await (await fetch(src)).arrayBuffer()) : await readFile(src)
const probe = await cardHash(buf)

const dir = 'public/carddata'
const results = []
for (const f of await readdir(dir)) {
  if (!f.startsWith('index-')) continue
  const meta = JSON.parse(await readFile(path.join(dir, f), 'utf8'))
  const bin = new Uint8Array(await readFile(path.join(dir, `hashes-${meta.lang}.bin`)))
  meta.cards.forEach((c, i) => {
    let d = 0
    for (let b = 0; b < 16; b++) d += POP[probe[b] ^ bin[i * 16 + b]]
    results.push({ d, c })
  })
}
results.sort((a, b) => a.d - b.d)
for (const { d, c } of results.slice(0, 5)) {
  console.log(`${String(d).padStart(3)}  ${c.lang}  ${c.id}  ${c.name} (${c.set} #${c.number})`)
}
