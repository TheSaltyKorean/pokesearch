/**
 * Perceptual hashing (dHash) shared by the browser matcher.
 * The Node build script (scripts/build-index.mjs) implements the identical
 * algorithm with sharp; any change here must be mirrored there and the
 * index rebuilt.
 *
 * Card hash = 16 bytes:
 *   bytes 0-7  : 64-bit dHash of the whole card image
 *   bytes 8-15 : 64-bit dHash of the art region (top 8%..55% of the card)
 */

const W = 9
const H = 8

function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/** dHash of a region of a source canvas/image, returned as 8 bytes. */
function dhashRegion(
  src: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
): Uint8Array {
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, W, H)
  const d = ctx.getImageData(0, 0, W, H).data
  const g = new Float64Array(W * H)
  for (let i = 0; i < W * H; i++) {
    g[i] = luma(d[i * 4], d[i * 4 + 1], d[i * 4 + 2])
  }
  const out = new Uint8Array(8)
  let bit = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      if (g[y * W + x] > g[y * W + x + 1]) {
        out[bit >> 3] |= 1 << (bit & 7)
      }
      bit++
    }
  }
  return out
}

/** Full 16-byte card hash from an image/canvas assumed to be a tight card crop. */
export function cardHash(
  src: CanvasImageSource,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(16)
  out.set(dhashRegion(src, 0, 0, width, height), 0)
  // Art region: skip the name bar, take upper art area
  out.set(
    dhashRegion(src, width * 0.08, height * 0.08, width * 0.84, height * 0.47),
    8,
  )
  return out
}

const POP = new Uint8Array(256)
for (let i = 0; i < 256; i++) POP[i] = (i & 1) + POP[i >> 1]

/** Hamming distance between a 16-byte probe and entry i of a packed hash table. */
export function hamming16(probe: Uint8Array, table: Uint8Array, i: number): number {
  const off = i * 16
  let d = 0
  for (let b = 0; b < 16; b++) d += POP[probe[b] ^ table[off + b]]
  return d
}
