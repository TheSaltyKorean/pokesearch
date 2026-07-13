import type { CollectionEntry, Settings } from '../lib/types'
import { listCollection, putEntry, deleteEntry } from './collection'

/**
 * Collection sync through the price-proxy Worker (Settings → workerUrl +
 * syncToken). Concurrency model: server-issued revisions plus local
 * mutation sequence numbers — no client clocks anywhere.
 *
 * - The server blob carries a `rev` (issued inside a Durable Object, so the
 *   revision check-and-write is atomic). PUTs name their `baseRev`; a
 *   mismatch returns 409 with the current blob for merge-and-retry.
 * - Mutations increment a global `dirtySeq` and append the touched uid to a
 *   change log. Each endpoint remembers the sequence it has acknowledged
 *   (`ackedSeq`), so dirtiness and per-row "changed since last push" are
 *   both per-endpoint — switching Workers is a fresh relationship.
 * - Merges are three-way: `baseUids` (uids at last reconcile) decides
 *   adds vs deletes; the change log decides row content — a row is kept
 *   local only if it was actually edited here since the endpoint's last
 *   ack, otherwise the server's version (a remote edit) is adopted.
 */

const DIRTY_SEQ_KEY = 'pokesearch.collection.dirtySeq'
// Array of {uid, seq}; uid '*' means "an unattributed bulk change" (e.g. a
// JSON import) and makes merges conservatively keep all local rows.
const CHANGE_LOG_KEY = 'pokesearch.collection.changeLog'
const CHANGE_LOG_CAP = 1000
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
  ackedSeq: number
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
    return {
      rev: s.rev ?? null,
      everSynced: Boolean(s.everSynced),
      baseUids: s.baseUids ?? [],
      ackedSeq: Number(s.ackedSeq ?? 0),
    }
  } catch {
    return { rev: null, everSynced: false, baseUids: [], ackedSeq: 0 }
  }
}

function saveState(ep: Endpoint, state: EndpointState): void {
  localStorage.setItem(STATE_PREFIX + ep.url, JSON.stringify(state))
}

const dirtySeq = () => Number(localStorage.getItem(DIRTY_SEQ_KEY) ?? '0')

function changeLog(): { uid: string; seq: number }[] {
  try {
    return JSON.parse(localStorage.getItem(CHANGE_LOG_KEY) ?? '[]')
  } catch {
    return []
  }
}

/**
 * Flag an unpushed local change. Pass the entry's uid so merges can tell
 * "edited here" from "edited remotely"; omit it only for bulk operations
 * (imports), which make merges conservatively keep every local row.
 */
export function markCollectionMutated(uid?: string): void {
  const seq = dirtySeq() + 1
  localStorage.setItem(DIRTY_SEQ_KEY, String(seq))
  const log = changeLog()
  log.push({ uid: uid ?? '*', seq })
  localStorage.setItem(CHANGE_LOG_KEY, JSON.stringify(log.slice(-CHANGE_LOG_CAP)))
}

/** Uids changed locally since `ackedSeq`; null means "assume all changed". */
function changedSince(ackedSeq: number): Set<string> | null {
  const log = changeLog()
  const relevant = log.filter((c) => c.seq > ackedSeq)
  if (relevant.some((c) => c.uid === '*')) return null
  // The capped log drops oldest entries; if truncation may have swallowed
  // records newer than ackedSeq, be conservative.
  if (log.length === CHANGE_LOG_CAP && (log[0]?.seq ?? 0) > ackedSeq + 1) return null
  return new Set(relevant.map((c) => c.uid))
}

// Bumped whenever sync settings change/reconcile restarts; in-flight timers,
// pulls, and responses from the previous configuration stand down.
let generation = 0
let pushTimer: ReturnType<typeof setTimeout> | undefined
let pendingSettings: Settings | undefined
// Mirrors settledPromise for the page-hide flush, which cannot await.
// 'pending' until the current configuration's reconcile lands.
let settledState: 'pending' | 'ok' | 'failed' = 'pending'

/**
 * Three-way merge against the last reconciled state. Row content: locally
 * edited rows win, otherwise the server version is adopted (remote edits
 * propagate). Membership: rows the server dropped since base are deleted
 * locally (unless edited here); rows we dropped since base are not
 * re-added; local and remote adds survive.
 */
async function mergeServerBlob(ep: Endpoint, server: ServerBlob): Promise<void> {
  const state = loadState(ep)
  const base = new Set(state.baseUids)
  const changed = changedSince(state.ackedSeq) // null → keep all local rows
  const local = await listCollection()
  const localUids = new Set(local.map((e) => e.uid))
  const serverByUid = new Map(server.entries.map((e) => [e.uid, e]))
  for (const e of local) {
    const locallyEdited = changed === null || changed.has(e.uid)
    if (!serverByUid.has(e.uid)) {
      // Absent on server: a remote delete if we knew it at base and didn't
      // touch it; otherwise a local add/edit — keep it.
      if (base.has(e.uid) && !locallyEdited) await deleteEntry(e.uid)
    } else if (!locallyEdited) {
      await putEntry(serverByUid.get(e.uid)!) // adopt remote edit
    }
    // locally edited + present on server → local wins for this row
  }
  for (const e of server.entries) {
    if (!localUids.has(e.uid) && !base.has(e.uid)) await putEntry(e) // remote add
    // in base but locally absent → we deleted it; don't resurrect
  }
}

async function pushNow(settings: Settings, attempt = 0, flush = false): Promise<void> {
  const gen = generation
  const ep = endpoint(settings)
  if (!ep) return
  const carriedSeq = dirtySeq()
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
  const st = loadState(ep)
  saveState(ep, {
    rev: rev ?? null,
    everSynced: true,
    baseUids: entries.map((e) => e.uid),
    // Acknowledge only the mutations this push actually carried; an edit
    // made while the request was in flight keeps the endpoint dirty.
    ackedSeq: Math.max(st.ackedSeq, carriedSeq),
  })
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
    // for the pull so the push carries the reconciled DB.
    const settled = await whenSyncSettled()
    if (gen !== generation) return
    if (settled === 'failed') {
      // The startup pull failed (offline/5xx). This edit is a natural
      // moment to retry the reconcile — on success it schedules the push
      // itself; on another failure the NEXT edit retries again.
      void syncOnOpen(settings).catch(() => {
        console.warn('collection push deferred: sync still unreachable')
      })
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
    if (document.visibilityState !== 'hidden' || pushTimer === undefined || !pendingSettings) {
      return
    }
    const ep = endpoint(pendingSettings)
    if (!ep || settledState !== 'ok' || dirtySeq() <= loadState(ep).ackedSeq) return
    clearTimeout(pushTimer)
    pushTimer = undefined
    void pushNow(pendingSettings, 0, true)
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
    if (gen !== generation) return 'noop' as const // superseded reconcile
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
      saveState(ep, { ...state, rev: server.rev, everSynced: true })
      markCollectionMutated()
      await pushNow(settings)
      return 'merged' as const
    }

    let outcome: 'pulled' | 'pushed' | 'noop' = 'noop'
    if (dirtySeq() > state.ackedSeq) {
      // This endpoint hasn't acknowledged the latest local edits: merge and
      // push via pushNow's 409 path.
      schedulePush(settings)
      outcome = 'pushed'
    } else if ((server.rev ?? null) !== (state.rev ?? null)) {
      const keep = new Set(server.entries.map((e) => e.uid))
      for (const e of current) {
        if (!keep.has(e.uid)) await deleteEntry(e.uid)
      }
      for (const e of server.entries) await putEntry(e)
      saveState(ep, { ...state, rev: server.rev, everSynced: true, baseUids: [...keep] })
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
