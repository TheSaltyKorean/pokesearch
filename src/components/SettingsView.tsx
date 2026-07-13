import { useState } from 'react'
import { loadSettings, saveSettings, type Settings } from '../lib/types'
import { SUPPORTED_CURRENCIES } from '../pricing/fx'
import { syncOnOpen } from '../db/sync'
import { t } from '../i18n'

export function SettingsView() {
  const [s, setS] = useState<Settings>(loadSettings())
  const [savedMsg, setSavedMsg] = useState(false)

  function field(key: keyof Settings, label: string, placeholder = '') {
    return (
      <label className="settings-field">
        {label}
        <input
          type="text"
          value={s[key] ?? ''}
          placeholder={placeholder}
          autoComplete="off"
          onChange={(ev) => setS({ ...s, [key]: ev.target.value || undefined })}
        />
      </label>
    )
  }

  return (
    <div className="panel">
      <h2>{t.settingsTitle}</h2>
      <p className="muted">{t.settingsIntro}</p>
      <label className="settings-field">
        {t.currencyLabel}
        <select
          value={s.currency ?? 'USD'}
          onChange={(ev) =>
            setS({ ...s, currency: ev.target.value === 'USD' ? undefined : ev.target.value })
          }
        >
          {SUPPORTED_CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      {field('pokemonTcgApiKey', t.ptcgKeyLabel)}
      {field('justTcgKey', t.justTcgKeyLabel, 'free key: justtcg.com → dashboard')}
      {field('pokemonPriceTrackerKey', t.pptKeyLabel, 'free key: pokemonpricetracker.com → account → API')}
      {field('priceChartingKey', t.pcKeyLabel)}
      {field('workerUrl', t.workerUrlLabel, 'https://pokesearch-prices.<you>.workers.dev')}
      {field('syncToken', t.syncTokenLabel)}
      <div className="actions">
        <button
          onClick={() => {
            saveSettings(s)
            // Reconcile right away when sync was just enabled/changed, so a
            // stale local collection can't later overwrite the server copy.
            syncOnOpen(s).catch((err) => console.warn('sync after save failed:', err))
            setSavedMsg(true)
            setTimeout(() => setSavedMsg(false), 1500)
          }}
        >
          {t.save}
        </button>
        {savedMsg && <span className="muted">{t.saved}</span>}
      </div>
    </div>
  )
}
