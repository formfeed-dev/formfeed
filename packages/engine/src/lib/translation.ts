/** Template-level dictionaries: locale → key → text (USP-8). */
export type Dictionaries = Record<string, Record<string, string>>;

/**
 * The `t` helper's lookup, with where the text came from: the exact locale (`de-DE`), its language
 * (`de`), English, or — `from: null` — nowhere, in which case the key itself is shown. The editor uses
 * `from` to write an edited translation where the reader will find it (plan 16 §3.1).
 */
export function resolveTranslation(
  dictionaries: Dictionaries | undefined,
  locale: string,
  key: string,
): { text: string; from: string | null } {
  const lang = locale.split('-')[0] ?? locale;
  for (const candidate of [locale, lang, 'en']) {
    const text = dictionaries?.[candidate]?.[key];
    if (typeof text === 'string') return { text, from: candidate };
  }
  return { text: key, from: null };
}

/**
 * The dictionary an edit of `key` shown in `locale` belongs in: the one the text came from when that
 * is the reader's own language, otherwise the reader's locale (when it has a dictionary) or language —
 * never English on behalf of someone reading German.
 */
export function translationTarget(
  dictionaries: Dictionaries | undefined,
  locale: string,
  key: string,
): string {
  const lang = locale.split('-')[0] ?? locale;
  const { from } = resolveTranslation(dictionaries, locale, key);
  if (from === locale || from === lang) return from;
  return dictionaries?.[locale] ? locale : lang;
}
