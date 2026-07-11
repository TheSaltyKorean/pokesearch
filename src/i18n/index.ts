import { en, type Dict } from './en'

/**
 * UI language table. English only for now; to add a language, create a file
 * exporting a Dict (e.g. ja.ts) and register it here. Card catalog languages
 * are independent of the UI language.
 */
const locales: Record<string, Dict> = { en }

let current = 'en'

export function setLocale(lang: string): void {
  if (locales[lang]) current = lang
}

export function getLocale(): string {
  return current
}

export function availableLocales(): string[] {
  return Object.keys(locales)
}

/** t.appName, t.scanPrompt, ... resolves against the active locale. */
export const t: Dict = new Proxy(en, {
  get(_target, prop: string) {
    return (locales[current] ?? en)[prop as keyof Dict] ?? en[prop as keyof Dict]
  },
})

/** Display names for card catalog languages. */
export const CARD_LANG_NAMES: Record<string, string> = {
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  'zh-tw': 'Chinese (Trad.)',
  'zh-cn': 'Chinese (Simp.)',
  de: 'German',
  fr: 'French',
  it: 'Italian',
  es: 'Spanish',
  pt: 'Portuguese',
  ru: 'Russian',
}
