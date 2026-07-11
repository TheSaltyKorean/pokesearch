import { useEffect, useMemo, useState } from 'react'
import type { CardEntry, MatchResult, PriceQuote } from '../lib/types'
import { fetchAllPrices, formatMoney, summarizeRange, variantsWithPrices } from '../pricing'
import { newUid, putEntry } from '../db/collection'
import { t, CARD_LANG_NAMES } from '../i18n'
import { variantLabel } from '../lib/variants'

interface Props {
  matches: MatchResult[]
  onClose: () => void
}

/** Candidate picker + per-variant price range for the selected card. */
export function ResultPanel({ matches, onClose }: Props) {
  const [selected, setSelected] = useState<CardEntry | null>(matches[0]?.card ?? null)
  const [quotes, setQuotes] = useState<PriceQuote[] | null>(null)
  const [variant, setVariant] = useState<string>('')
  const [added, setAdded] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setQuotes(null)
    setError('')
    setAdded(false)
    fetchAllPrices(selected)
      .then((q) => {
        if (cancelled) return
        setQuotes(q)
        const vs = variantsWithPrices(q)
        setVariant(vs[0] ?? 'normal')
      })
      .catch((e) => !cancelled && setError(String(e)))
    return () => {
      cancelled = true
    }
  }, [selected])

  const range = useMemo(
    () => (quotes ? summarizeRange(quotes, variant) : undefined),
    [quotes, variant],
  )
  const variants = useMemo(() => (quotes ? variantsWithPrices(quotes) : []), [quotes])

  async function addToCollection() {
    if (!selected) return
    await putEntry({
      uid: newUid(),
      cardId: selected.id,
      lang: selected.lang,
      name: selected.name,
      set: selected.set,
      number: selected.number,
      img: selected.img,
      variant: variant || 'normal',
      qty: 1,
      condition: 'NM',
      addedAt: new Date().toISOString(),
      lastPricedAt: quotes ? new Date().toISOString() : undefined,
      range,
    })
    setAdded(true)
  }

  if (matches.length === 0) {
    return (
      <div className="panel">
        <p>{t.noMatch}</p>
        <button onClick={onClose}>OK</button>
      </div>
    )
  }

  return (
    <div className="panel result">
      <div className="candidates">
        <h3>{t.candidates}</h3>
        {matches.map((m) => (
          <button
            key={`${m.card.lang}:${m.card.id}`}
            className={`candidate ${selected?.id === m.card.id && selected?.lang === m.card.lang ? 'active' : ''}`}
            onClick={() => setSelected(m.card)}
          >
            <img src={m.card.img} alt={m.card.name} loading="lazy" />
            <span>
              <b>{m.card.name}</b>
              <small>
                {m.card.set} · #{m.card.number} · {CARD_LANG_NAMES[m.card.lang] ?? m.card.lang}
              </small>
              <small className="conf">{Math.round(m.confidence * 100)}% {t.confidence}</small>
            </span>
          </button>
        ))}
      </div>

      {selected && (
        <div className="detail">
          <img className="hero" src={selected.img} alt={selected.name} />
          <h2>{selected.name}</h2>
          <p className="muted">
            {t.set}: {selected.set} · {t.number} {selected.number}
            {selected.rarity ? ` · ${selected.rarity}` : ''} ·{' '}
            {CARD_LANG_NAMES[selected.lang] ?? selected.lang}
          </p>

          {quotes === null && !error && <p>{t.loadingPrices}</p>}
          {error && <p className="error">{error}</p>}
          {quotes && variants.length > 0 && (
            <>
              <div className="variants">
                {variants.map((v) => (
                  <button
                    key={v}
                    className={`chip ${v === variant ? 'active' : ''}`}
                    onClick={() => setVariant(v)}
                  >
                    {variantLabel(v)}
                  </button>
                ))}
              </div>
              {range ? (
                <div className="range">
                  <span className="label">{t.priceRange}</span>
                  <span className="big">
                    {formatMoney(range.low, range.currency)} – {formatMoney(range.high, range.currency)}
                  </span>
                  <span className="mid">mid {formatMoney(range.mid, range.currency)}</span>
                </div>
              ) : (
                <p>{t.noPrices}</p>
              )}
              <details>
                <summary>{t.sources}</summary>
                <table>
                  <tbody>
                    {quotes
                      .filter((q) => q.variant === variant)
                      .map((q, i) => (
                        <tr key={i}>
                          <td>{q.url ? <a href={q.url} target="_blank" rel="noreferrer">{q.source}</a> : q.source}</td>
                          <td>{formatMoney(q.low, q.currency)}</td>
                          <td>{formatMoney(q.mid ?? q.market, q.currency)}</td>
                          <td>{formatMoney(q.high, q.currency)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </details>
            </>
          )}
          {quotes && variants.length === 0 && <p>{t.noPrices}</p>}

          <div className="actions">
            <button onClick={addToCollection} disabled={added}>
              {added ? t.addedToCollection : t.addToCollection}
            </button>
            <button className="secondary" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
