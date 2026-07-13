import { useCallback, useEffect, useState } from 'react'
import { CameraScanner } from './scanner/CameraScanner'
import { ResultPanel } from './components/ResultPanel'
import { CollectionView } from './components/CollectionView'
import { SettingsView } from './components/SettingsView'
import {
  ensureIndexesLoaded,
  indexedCardCount,
  loadedLanguages,
  matchImage,
  searchByName,
} from './matching'
import { loadSettings, type CardEntry, type MatchResult } from './lib/types'
import { syncOnOpen } from './db/sync'
import { t, CARD_LANG_NAMES } from './i18n'
import './app.css'

type Tab = 'scan' | 'search' | 'collection' | 'settings'

export default function App() {
  const [tab, setTab] = useState<Tab>('scan')
  const [ready, setReady] = useState(false)
  const [matches, setMatches] = useState<MatchResult[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<CardEntry[]>([])

  useEffect(() => {
    ensureIndexesLoaded().then(() => setReady(true))
    syncOnOpen(loadSettings()).catch((err) => console.warn('collection sync failed:', err))
  }, [])

  const handleCapture = useCallback((canvas: HTMLCanvasElement) => {
    setBusy(true)
    // let the UI paint before the (fast) match
    requestAnimationFrame(() => {
      const results = matchImage(canvas, canvas.width, canvas.height)
      // Loose cutoff: show weak candidates too and let the user confirm by eye
      setMatches(results.filter((r) => r.distance <= 60))
      setBusy(false)
    })
  }, [])

  async function handleUpload(file: File) {
    setBusy(true)
    const bmp = await createImageBitmap(file)
    const results = matchImage(bmp, bmp.width, bmp.height)
    bmp.close()
    setMatches(results.filter((r) => r.distance <= 60))
    setBusy(false)
  }

  function handleSearch(q: string) {
    setQuery(q)
    setSearchResults(searchByName(q))
  }

  return (
    <div className="app">
      <header>
        <h1>{t.appName}</h1>
        <span className="muted tagline">{t.tagline}</span>
        <nav>
          {(['scan', 'search', 'collection', 'settings'] as Tab[]).map((tb) => (
            <button
              key={tb}
              className={tab === tb ? 'active' : ''}
              onClick={() => {
                setTab(tb)
                setMatches(null)
              }}
            >
              {tb === 'scan' ? t.navScan : tb === 'search' ? t.navSearch : tb === 'collection' ? t.navCollection : t.navSettings}
            </button>
          ))}
        </nav>
      </header>

      <main>
        {matches !== null ? (
          <ResultPanel matches={matches} onClose={() => setMatches(null)} />
        ) : tab === 'scan' ? (
          <div className="panel">
            {busy && <p>{t.matching}</p>}
            <CameraScanner onCapture={handleCapture} />
            <div className="upload">
              <label className="upload-label">
                {t.scanUpload}
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(ev) => ev.target.files?.[0] && handleUpload(ev.target.files[0])}
                />
              </label>
            </div>
          </div>
        ) : tab === 'search' ? (
          <div className="panel">
            <input
              className="search-box"
              type="search"
              placeholder={t.searchPlaceholder}
              value={query}
              onChange={(ev) => handleSearch(ev.target.value)}
            />
            <div className="collection-grid">
              {searchResults.map((c) => (
                <button
                  key={`${c.lang}:${c.id}`}
                  className="entry as-button"
                  onClick={() => setMatches([{ card: c, distance: 0, confidence: 1 }])}
                >
                  <img src={c.img} alt={c.name} loading="lazy" />
                  <div className="entry-body">
                    <b>{c.name}</b>
                    <small>
                      {c.set} · #{c.number} · {CARD_LANG_NAMES[c.lang] ?? c.lang}
                    </small>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : tab === 'collection' ? (
          <CollectionView />
        ) : (
          <SettingsView />
        )}
      </main>

      <footer className="muted">
        {ready
          ? t.indexStats(
              indexedCardCount(),
              loadedLanguages().map((l) => CARD_LANG_NAMES[l] ?? l).join(', '),
            )
          : 'Loading card index…'}
      </footer>
    </div>
  )
}
