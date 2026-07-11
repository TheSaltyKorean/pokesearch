import { useEffect, useRef, useState } from 'react'
import { loadSettings, type CollectionEntry } from '../lib/types'
import {
  deleteEntry,
  exportCollection,
  importCollection,
  listCollection,
  putEntry,
  staleEntries,
} from '../db/collection'
import { fetchAllPrices, formatMoney, summarizeRange } from '../pricing'
import { t, CARD_LANG_NAMES } from '../i18n'
import { variantLabel } from '../lib/variants'

const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG', 'Graded'] as const

/**
 * The user's saved cards. On mount, any entry priced more than 24h ago is
 * re-priced automatically ("daily refresh" without a server).
 */
export function CollectionView() {
  const [entries, setEntries] = useState<CollectionEntry[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function reload() {
    setEntries(await listCollection())
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const all = await listCollection()
      if (cancelled) return
      setEntries(all)
      const stale = staleEntries(all, 24, loadSettings().currency ?? 'USD')
      if (stale.length === 0) return
      setRefreshing(true)
      for (const e of stale) {
        if (cancelled) break
        try {
          const quotes = await fetchAllPrices({
            id: e.cardId,
            name: e.name,
            set: e.set,
            setId: '',
            number: e.number,
            lang: e.lang,
            img: e.img,
            src: e.lang === 'en' ? 'ptcg' : 'tcgdex',
          }, { background: true })
          const range = summarizeRange(quotes, e.variant) ?? summarizeRange(quotes)
          await putEntry({ ...e, range: range ?? e.range, lastPricedAt: new Date().toISOString() })
        } catch {
          /* keep old price on failure */
        }
      }
      if (!cancelled) {
        setRefreshing(false)
        reload()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const total = entries.reduce((sum, e) => sum + (e.range?.mid ?? 0) * e.qty, 0)

  async function update(e: CollectionEntry, patch: Partial<CollectionEntry>) {
    await putEntry({ ...e, ...patch })
    reload()
  }

  async function doExport() {
    const blob = new Blob([await exportCollection()], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `pokesearch-collection-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  async function doImport(file: File) {
    await importCollection(await file.text())
    reload()
  }

  return (
    <div className="panel">
      <div className="collection-head">
        <div>
          <span className="label">{t.collectionTotal}</span>
          <span className="big">{formatMoney(total, entries[0]?.range?.currency ?? 'USD')}</span>
        </div>
        <div className="actions">
          <button className="secondary" onClick={doExport}>{t.exportBtn}</button>
          <button className="secondary" onClick={() => fileRef.current?.click()}>{t.importBtn}</button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            hidden
            onChange={(ev) => ev.target.files?.[0] && doImport(ev.target.files[0])}
          />
        </div>
      </div>
      {refreshing && <p className="muted">{t.refreshingStale}</p>}
      {entries.length === 0 && <p className="muted">{t.collectionEmpty}</p>}
      <div className="collection-grid">
        {entries.map((e) => (
          <div className="entry" key={e.uid}>
            <img src={e.img} alt={e.name} loading="lazy" />
            <div className="entry-body">
              <b>{e.name}</b>
              <small>
                {e.set} · #{e.number} · {CARD_LANG_NAMES[e.lang] ?? e.lang} · {variantLabel(e.variant)}
              </small>
              <small>
                {e.range
                  ? `${formatMoney(e.range.low, e.range.currency)} – ${formatMoney(e.range.high, e.range.currency)} (mid ${formatMoney(e.range.mid, e.range.currency)})`
                  : '—'}
              </small>
              <div className="entry-controls">
                <label>
                  {t.qty}
                  <input
                    type="number"
                    min={1}
                    value={e.qty}
                    onChange={(ev) => update(e, { qty: Math.max(1, Number(ev.target.value) || 1) })}
                  />
                </label>
                <label>
                  {t.condition}
                  <select
                    value={e.condition}
                    onChange={(ev) => update(e, { condition: ev.target.value as CollectionEntry['condition'] })}
                  >
                    {CONDITIONS.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <button
                  className="danger"
                  onClick={() => deleteEntry(e.uid).then(reload)}
                >
                  {t.remove}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
