// Words of tasks and code, for relevance ranking (shared by the scanner and targeting).

const WORD = /[A-Za-z][A-Za-z0-9]+/g
const STOPWORDS = new Set(
  'the and for with that this from into when add make show use new all any are not but can its our their there than then them they were will would should could have has had into onto over under about which while also more most just only very each every some other such api app file files code return returns true false below above minimum maximum function method value values number string list based last first need needs like want get set using'.split(' ')
)

/** Light stemming so "cows"/"cow" and "categories"/"category" meet. */
export const stem = (w: string): string => (w.length > 4 ? w.replace(/ies$/, 'y').replace(/(?<=[^s])(es|s)$/, '') : w)

/** Word counts of a text (identifiers split, stemmed, capped), for body-text relevance. */
export function termCounts(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const w of text.match(WORD) ?? []) {
    for (const part of [w, ...w.split(/(?<=[a-z])(?=[A-Z])|_/)]) {
      const k = part.toLowerCase()
      if (k.length < 3 || STOPWORDS.has(k)) continue
      const s = stem(k)
      out[s] = Math.min(50, (out[s] ?? 0) + 1)
    }
  }
  return out
}

/** Keywords of a task, split camelCase/snake_case, for relevance ranking. */
export function keywords(text: string): string[] {
  const out = new Set<string>()
  for (const w of text.match(WORD) ?? []) {
    for (const part of [w, ...w.split(/(?<=[a-z])(?=[A-Z])|_/)]) {
      const k = part.toLowerCase()
      if (k.length >= 3 && !STOPWORDS.has(k)) out.add(k)
    }
  }
  return [...out]
}

