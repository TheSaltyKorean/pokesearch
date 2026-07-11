import { useEffect, useRef, useState } from 'react'
import { cardHash, hamming16 } from '../lib/hash'
import { t } from '../i18n'

interface Props {
  onCapture: (canvas: HTMLCanvasElement) => void
}

/**
 * Live camera view with a card-shaped guide box. Frames inside the guide are
 * hashed ~4x/sec; when the hash is stable across 3 consecutive frames (the
 * card is being held steady) and the region has enough edge detail to look
 * like a card rather than empty background, we auto-capture.
 */
export function CameraScanner({ onCapture }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [status, setStatus] = useState<'starting' | 'ready' | 'nocamera'>('starting')
  const [steady, setSteady] = useState(0)
  const captured = useRef(false)

  useEffect(() => {
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    let prevHash: Uint8Array | null = null
    let stableCount = 0
    captured.current = false

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 } },
          audio: false,
        })
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        await video.play()
        setStatus('ready')

        const work = document.createElement('canvas')
        timer = setInterval(() => {
          if (captured.current || !video.videoWidth) return
          const g = guideRect(video.videoWidth, video.videoHeight)
          work.width = g.w
          work.height = g.h
          const ctx = work.getContext('2d', { willReadFrequently: true })!
          ctx.drawImage(video, g.x, g.y, g.w, g.h, 0, 0, g.w, g.h)

          if (edgeDensity(ctx, g.w, g.h) < 0.055) {
            stableCount = 0
            prevHash = null
            setSteady(0)
            return
          }
          const h = cardHash(work, g.w, g.h)
          if (prevHash && hamming16(h, prevHash, 0) <= 8) {
            stableCount++
          } else {
            stableCount = 0
          }
          prevHash = h
          setSteady(Math.min(stableCount, 3))
          if (stableCount >= 3) {
            captured.current = true
            const snap = document.createElement('canvas')
            snap.width = g.w
            snap.height = g.h
            snap.getContext('2d')!.drawImage(video, g.x, g.y, g.w, g.h, 0, 0, g.w, g.h)
            onCapture(snap)
          }
        }, 250)
      } catch {
        setStatus('nocamera')
      }
    }
    start()
    return () => {
      if (timer) clearInterval(timer)
      stream?.getTracks().forEach((tr) => tr.stop())
    }
  }, [onCapture])

  function manualCapture() {
    const video = videoRef.current
    if (!video || !video.videoWidth || captured.current) return
    captured.current = true
    const g = guideRect(video.videoWidth, video.videoHeight)
    const snap = document.createElement('canvas')
    snap.width = g.w
    snap.height = g.h
    snap.getContext('2d')!.drawImage(video, g.x, g.y, g.w, g.h, 0, 0, g.w, g.h)
    onCapture(snap)
  }

  return (
    <div className="scanner">
      {status === 'nocamera' ? (
        <p className="muted">{t.scanNoCamera}</p>
      ) : (
        <>
          <div className="viewport">
            <video ref={videoRef} playsInline muted />
            <div className={`guide steady-${steady}`} />
          </div>
          <p className="muted">{status === 'starting' ? t.scanStarting : t.scanPrompt}</p>
          <button onClick={manualCapture} disabled={status !== 'ready'}>
            {t.scanManual}
          </button>
        </>
      )}
    </div>
  )
}

/** Card-aspect (63:88) guide box centered in the video frame. */
function guideRect(vw: number, vh: number) {
  const aspect = 63 / 88
  let h = vh * 0.85
  let w = h * aspect
  if (w > vw * 0.85) {
    w = vw * 0.85
    h = w / aspect
  }
  return { x: (vw - w) / 2, y: (vh - h) / 2, w: Math.round(w), h: Math.round(h) }
}

/** Fraction of pixels that sit on a strong luminance edge (cheap Sobel-ish). */
function edgeDensity(ctx: CanvasRenderingContext2D, w: number, h: number): number {
  const sw = 64
  const sh = 64
  const c = document.createElement('canvas')
  c.width = sw
  c.height = sh
  const sctx = c.getContext('2d', { willReadFrequently: true })!
  sctx.drawImage(ctx.canvas, 0, 0, w, h, 0, 0, sw, sh)
  const d = sctx.getImageData(0, 0, sw, sh).data
  const g = new Float64Array(sw * sh)
  for (let i = 0; i < sw * sh; i++) {
    g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]
  }
  let edges = 0
  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      const i = y * sw + x
      const gx = Math.abs(g[i + 1] - g[i - 1])
      const gy = Math.abs(g[i + sw] - g[i - sw])
      if (gx + gy > 40) edges++
    }
  }
  return edges / ((sw - 2) * (sh - 2))
}
