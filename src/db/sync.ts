import type { CollectionEntry, Settings } from '../lib/types'
import { listCollection, putEntry, deleteEntry } from './collection'

/**
 * Collection sync through the price-proxy Worker (Settings → workerUrl +
 * syncToken). Concurrency model: server-issued revisions plus local
 * mutation sequence numbers — no client clocks anywhere.
 *
 * - The server blob carries a `rev` (issued inside a Durable Object, so
 *   revision check-and-write is atomic). PUTs name their `baseRev`; a
 *   mismatch returns 409 with the current blob for merge-and-retry.
 * - Local dirtiness is a pair of counters (dirtySeq/pushedSeq): an old
 *   push's success can only acknowledge the mutations it actually carried.
 * - Per-endpoint sync state ({rev, everSynced, baseUids}) is keyed by the
 *   worker URL, so pointing Settings at a different Worker is a fresh
 *   relationship, not a continuation.
 * - `baseUids` — the uids present at the last successful reconcile — gives
 *   merges three-way semantics: a row absent from the server that WAS in
 *   the base was deleted remotely (drop it); one not in the base is a local
 *   add (keep it). Same logic implicitly honors local deletes.
 */

const DIRTY_SEQ_KEY = 'pokesearch.collection.dirtySeq'
const PUSHED_SEQ_KEY = 'pokesearch.collection.pushedSeq'
const STATE_PREFIX = 'pokesearch.collection.syncstate:'
const PUSH_DEBOUNCE_MS = 3000
const PUSH_MAX_RETRIES = 3
// fetch(keepalive) rejects bodies over 64KB (in bytes, not string length);
// only the page-hide flush needs keepalive.
const KEEPALIVE_MAX_BYTES = 60_000

interface ServerBlob {
  rev: string | null
  entries: CollectionEntry[]
}

interface EndpointState {
  rev: string | null
  everSynced: boolean
  baseUids: string[]
}

interface Endpoint {
  url: string
  headers: Record<string, string>
}

function endpoint(settings: Settings): Endpoint | undefined {
  if (!settings.workerUrl || !settings.syncToken) return undefined
  return {
    url: `${settings.workerUrl.replace(/\/+$/, '')}/collection`,
    headers: { Authorization: `Bearer ${settings.syncToken}` },
  }
}

function loadState(ep: Endpoint): EndpointState {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_PREFIX + ep.url) ?? '')
    return { rev: s.rev ?? null, everSynced: Boolean(s.everSynced), baseUids: s.baseUids ?? [] }
  } catch {
    return { rev: null, everSynced: false, baseUids: [] }
  }
}

function saveState(ep: Endpoint, state: EndpointState): void {
  localStorage.setItem(STATE_PREFIX + ep.url, JSON.stringify(state))
}

const seq = (key: string) => Number(localStorage.getItem(key) ?? '0')

/** Flag unpushed local changes; acknowledged per-sequence by pushes. */
export function markCollectionMutated(): void {
  localStorage.setItem(DIRTY_SEQ_KEY, String(seq(DIRTY_SEQ_KEY) + 1))
}

const isDirty = () => seq(DIRTY_SEQ_KEY) > seq(PUSHED_SEQ_KEY)

// Bumped whenever sync settings change/reconcile restarts; in-flight timers,
// pulls, and responses from the previous configuration stand down.
let generation = 0
let pushTimer: ReturnType<typeof setTimeout> | undefined
let pendingSettings: Settings | undefined
// Mirrors settledPromise for the page-hide flush, which cannot await.
// 'pending' until the first reconcile of the current configuration lands.
let settledState: 'pending' | 'ok' | 'failed' = 'pending'

/**
 * Three-way merge against the last reconciled state. Local rows win; rows
 * the server dropped since base are deleted locally; rows we dropped since
 * base are not re-added. Returns the resulting local entries.
 */
async function mergeServerBlob(ep: Endpoint, server: ServerBlob): Promise<CollectionEntry[]> {
  const base = new Set(loadState(ep).baseUids)
  const local = await listCollection()
  const serverUids = new Set(server.entries.map((e) => e.uid))
  const localUids = new Set(local.map((e) => e.uid))
  for (const e of local) {
    if (!serverUids.has(e.uid) && base.has(e.uid)) await deleteEntry(e.uid) // remote delete
  }
  for (const e of server.entries) {
    if (!localUids.has(e.uid) && !base.has(e.uid)) await putEntry(e) // remote add
    // present in base but locally absent → we deleted it; don't resurrect
  }
  return listCollection()
}

async function pushNow(settings: Settings, attempt = 0, flush = false): Promise<void> {
  const gen = generation
  const ep = endpoint(settings)
  if (!ep) return
  const carriedSeq = seq(DIRTY_SEQ_KEY)
  const entries = await listCollection()
  const body = JSON.stringify({ baseRev: loadState(ep).rev, entries })
  let res: Response
  try {
    res = await fetch(ep.url, {
      method: 'PUT',
      headers: { ...ep.headers, 'Content-Type': 'application/json' },
      body,
      // Lets a page-hide flush outlive the page; byte-limited by browsers.
      keepalive: flush && new TextEncoder().encode(body).length < KEEPALIVE_MAX_BYTES,
    })
  } catch (err) {
    return retryPush(settings, attempt, err, gen)
  }
  if (gen !== generation) return // settings changed mid-flight; discard
  if (res.status === 409) {
    // Another device advanced the rev: three-way merge, adopt, retry.
    const server: ServerBlob = await res.json()
    if (gen !== generation) return
    await mergeServerBlob(ep, server)
    const st = loadState(ep)
    saveState(ep, { ...st, rev: server.rev })
    if (attempt < PUSH_MAX_RETRIES) return pushNow(settings, attempt + 1)
    console.warn('collection push gave up after repeated conflicts')
    return
  }
  // The DO serializes writes; bursts from another device surface as 429/5xx
  // and just need another try.
  if (res.status === 429 || res.status >= 500) return retryPush(settings, attempt, res.status, gen)
  if (!res.ok) {
    console.warn('collection push failed:', res.status)
    return
  }
  const { rev } = await res.json()
  if (gen !== generation) return
  saveState(ep, { rev: rev ?? null, everSynced: true, baseUids: entries.map((e) => e.uid) })
  // Acknowledge only the mutations this push actually carried; a mutation
  // made while the request was in flight keeps the collection dirty.
  if (seq(PUSHED_SEQ_KEY) < carriedSeq) {
    localStorage.setItem(PUSHED_SEQ_KEY, String(carriedSeq))
  }
}

function retryPush(settings: Settings, attempt: number, why: unknown, gen: number): void {
  if (attempt >= PUSH_MAX_RETRIES) {
    console.warn('collection push gave up:', why)
    return
  }
  setTimeout(
    () => {
      if (gen === generation) void pushNow(settings, attempt + 1)
    },
    1500 * (attempt + 1) + Math.random() * 1000,
  )
}

/** Debounced whole-collection upload; safe to call after every mutation. */
export function schedulePush(settings: Settings): void {
  if (!endpoint(settings)) return
  pendingSettings = settings
  clearTimeout(pushTimer)
  const gen = generation
  pushTimer = setTimeout(async () => {
    pushTimer = undefined
    // A mutation made while the startup pull is in flight stays dirty; wait
    // for the pull so the push carries the reconciled DB. If the pull
    // failed we can't know what the server holds — keep it local for now.
    if ((await whenSyncSettled()) === 'failed' || gen !== generation) {
      if (gen === generation) console.warn('collection push skipped: startup sync failed')
      return
    }
    void pushNow(settings)
  }, PUSH_DEBOUNCE_MS)
}

/** Drop queued/in-flight pushes; the next reconcile decides what syncs. */
function cancelPendingPush(): void {
  generation++
  clearTimeout(pushTimer)
  pushTimer = undefined
  pendingSettings = undefined
}

// An edit made just before closing the tab must not die in the debounce
// timer — flush it the moment the page hides. Only when the CURRENT
// configuration's reconcile has succeeded ('ok', not 'pending'/'failed'):
// the flush can't await the pull, and pushing a pre-pull DB would overwrite
// server state this session never saw.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (
      document.visibilityState === 'hidden' &&
      pushTimer !== undefined &&
      pendingSettings &&
      settledState === 'ok' &&
      isDirty()
    ) {
      clearTimeout(pushTimer)
      pushTimer = undefined
      void pushNow(pendingSettings, 0, true)
    }
  })
}

let settledPromise: Promise<'ok' | 'failed'> = Promise.resolve('ok')

/**
 * Resolves when the startup sync has settled — 'failed' when sync is
 * configured but the pull didn't complete. Consumers that snapshot and then
 * write back the local DB (CollectionView's stale-refresh) must wait for
 * this and STOP on 'failed': pushing rows the unreachable server blob had
 * deleted would resurrect them.
 */
export function whenSyncSettled(): Promise<'ok' | 'failed'> {
  return settledPromise
}

/**
 * Pull the server blob and reconcile. Also called after saving sync
 * settings, so enabling/changing sync reconciles without a reload.
 */
export async function syncOnOpen(
  settings: Settings,
): Promise<'pulled' | 'pushed' | 'merged' | 'noop'> {
  // Pushes queued under the previous settings must not fire against an old
  // endpoint/token; this reconcile supersedes them.
  cancelPendingPush()
  const gen = generation
  settledState = 'pending'
  const run = (async () => {
    const ep = endpoint(settings)
    if (!ep) return 'noop' as const
    const res = await fetch(ep.url, { headers: ep.headers })
    if (gen !== generation) return 'noop' as const // superseded by a newer reconcile
    if (!res.ok) throw new Error(`sync pull ${res.status}`)
    const server: ServerBlob = await res.json()
    if (gen !== generation) return 'noop' as const
    const current = await listCollection()
    const state = loadState(ep)

    // First reconcile of this browser with THIS endpoint while local cards
    // exist: no base to merge against, so union both sides and push.
    if (!state.everSynced && current.length > 0) {
      const localUids = new Set(current.map((e) => e.uid))
      for (const e of server.entries) {
        if (!localUids.has(e.uid)) await putEntry(e)
      }
      saveState(ep, { rev: server.rev, everSynced: true, baseUids: [] })
      markCollectionMutated()
      await pushNow(settings)
      return 'merged' as const
    }

    let outcome: 'pulled' | 'pushed' | 'noop' = 'noop'
    if (isDirty()) {
      // Local unpushed changes: merge/push via pushNow's 409 path.
      schedulePush(settings)
      outcome = 'pushed'
    } else if ((server.rev ?? null) !== (state.rev ?? null)) {
      const keep = new Set(server.entries.map((e) => e.uid))
      for (const e of current) {
        if (!keep.has(e.uid)) await deleteEntry(e.uid)
      }
      for (const e of server.entries) await putEntry(e)
      saveState(ep, { rev: server.rev, everSynced: true, baseUids: [...keep] })
      outcome = 'pulled'
    } else if (!state.everSynced) {
      saveState(ep, { ...state, everSynced: true })
    }
    return outcome
  })()
  settledPromise = run.then(
    () => {
      if (gen === generation) settledState = 'ok'
      return 'ok' as const
    },
    () => {
      if (gen === generation) settledState = 'failed'
      return 'failed' as const
    },
  )
  return run
}
