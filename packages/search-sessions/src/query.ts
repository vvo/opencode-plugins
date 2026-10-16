// Pure query, ranking and display helpers. No SQLite and no UI, so tests can load them directly.

export type Clause =
  | { readonly kind: "term"; readonly token: string; readonly prefix: boolean }
  | { readonly kind: "phrase"; readonly tokens: readonly string[]; readonly prefix: boolean }

export type Segment = { readonly text: string; readonly hit: boolean }

export type Candidate = {
  readonly sessionID: string
  /** 0: one message has every word, 1: same with typo corrections, 2: words spread over the session. */
  readonly tier: number
  /** Positive BM25 relevance, higher is better. */
  readonly score: number
  readonly count: number
  readonly updated: number
  /** The session title matches too. */
  readonly titled?: boolean
}

export const MAX_CLAUSES = 8

const DAY = 86_400_000

// Function words that match nearly every message. Dropped when the query has other words.
const STOPWORDS = new Set(
  (
    "a an and are as at be but by can could did do does for from had has have how i if in into is it its me my no not of on or our so " +
    "than that the their them then there these they this to us was we were what when where which who why will with would you your " +
    "au aux avec ce ces cette dans de des du elle en est et il je la le les leur ma mais me mes mon ne nous on ou par pas pour qu que " +
    "qui sa se ses son sont sur ta te tes ton tu un une vous"
  ).split(" "),
)

const TOKEN = /[\p{L}\p{N}\p{Co}]+/gu

/** Mirrors SQLite's `unicode61 remove_diacritics 2` closely enough to look terms up in the index vocabulary. */
export function normalize(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase()
}

export function tokenize(text: string): string[] {
  return normalize(text).match(TOKEN) ?? []
}

export function parseQuery(input: string): Clause[] {
  const typing = !/\s$/.test(input)
  const words: { text: string; quoted: boolean; open: boolean }[] = []
  for (const match of input.matchAll(/"([^"]*)("?)|([^\s"]+)/g)) {
    if (match[3] !== undefined) words.push({ text: match[3], quoted: false, open: false })
    else words.push({ text: match[1] ?? "", quoted: true, open: match[2] !== '"' })
  }
  const clauses: (Clause & { stop: boolean })[] = []
  words.forEach((word, index) => {
    const tokens = tokenize(word.text)
    if (tokens.length === 0) return
    const last = index === words.length - 1
    // Quotes ask for an exact phrase; only an unclosed quote at the end is still being typed.
    const prefix = last && (word.quoted ? word.open : typing)
    if (!word.quoted && tokens.length === 1) {
      const token = tokens[0]
      clauses.push({ kind: "term", token, prefix: prefix && token.length >= 2, stop: !prefix && STOPWORDS.has(token) })
      return
    }
    // "dev:link" or "example.com/docs" tokenize to several words, matched next to each other.
    clauses.push({ kind: "phrase", tokens, prefix, stop: false })
  })
  const content = clauses.filter((clause) => !clause.stop)
  return (content.length > 0 ? content : clauses).slice(0, MAX_CLAUSES).map(({ stop: _, ...clause }) => clause)
}

/** Typos allowed for a word of this length: none under 5 letters, one up to 8, two from 9. */
export function typoBudget(length: number): number {
  if (length >= 9) return 2
  if (length >= 5) return 1
  return 0
}

const MAX_TERM = 64
let rowA = new Int32Array(MAX_TERM + 1)
let rowB = new Int32Array(MAX_TERM + 1)
let rowC = new Int32Array(MAX_TERM + 1)

/**
 * Optimal string alignment distance: insertions, deletions, substitutions and adjacent
 * transpositions ("serach") each cost one. Returns `max + 1` as soon as the distance exceeds `max`.
 */
export function typoDistance(a: string, b: string, max: number): number {
  if (a === b) return 0
  const n = a.length
  const m = b.length
  if (Math.abs(n - m) > max || m > MAX_TERM) return max + 1
  let before = rowA
  let previous = rowB
  let current = rowC
  for (let j = 0; j <= m; j++) previous[j] = j
  for (let i = 1; i <= n; i++) {
    current[0] = i
    let best = i
    const left = a.charCodeAt(i - 1)
    for (let j = 1; j <= m; j++) {
      const right = b.charCodeAt(j - 1)
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (left === right ? 0 : 1))
      if (i > 1 && j > 1 && left === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === right) {
        value = Math.min(value, before[j - 2] + 1)
      }
      current[j] = value
      if (value < best) best = value
    }
    if (best > max) return max + 1
    const recycled = before
    before = previous
    previous = current
    current = recycled
  }
  rowA = before
  rowB = previous
  rowC = current
  return previous[m] > max ? max + 1 : previous[m]
}

export type Near = { readonly term: string; readonly distance: number; readonly docs: number }

/**
 * Keeps corrections that are likely what the user meant. A word that exists in the index only
 * gets corrections at least ten times as common, so a misspelling repeated in old prompts
 * ("sesion") still finds every "session".
 */
export function pickVariants(token: string, near: readonly Near[], exactDocs: number, limit = 6): string[] {
  return near
    .filter((item) => item.term !== token && (exactDocs === 0 || item.docs >= exactDocs * 10))
    .toSorted(
      (left, right) =>
        left.distance - right.distance ||
        Number(right.term[0] === token[0]) - Number(left.term[0] === token[0]) ||
        right.docs - left.docs,
    )
    .slice(0, limit)
    .map((item) => item.term)
}

function quote(token: string): string {
  return `"${token.replaceAll('"', '""')}"`
}

/** One clause as an FTS5 expression, with typo corrections as alternatives. */
export function clauseMatch(clause: Clause, variants: readonly string[] = []): string {
  if (clause.kind === "phrase") return quote(clause.tokens.join(" ")) + (clause.prefix ? "*" : "")
  const exact = quote(clause.token) + (clause.prefix ? "*" : "")
  if (variants.length === 0) return exact
  return `(${[exact, ...variants.map(quote)].join(" OR ")})`
}

export function matchAll(expressions: readonly string[]): string {
  return expressions.join(" AND ")
}

export function recencyFactor(updated: number, now: number): number {
  const days = Math.max(0, now - updated) / DAY
  return 0.5 + 0.5 * 2 ** (-days / 30)
}

/**
 * BM25 relevance of the best message, raised when the title matches (the title says what a
 * session is about), a little for repeated mentions, and for recent activity.
 */
export function blendScore(candidate: Candidate, now: number): number {
  const mentions = 1 + 0.08 * Math.log2(Math.max(1, candidate.count))
  const titled = candidate.titled ? 1.6 : 1
  return candidate.score * mentions * titled * recencyFactor(candidate.updated, now)
}

export function rankCandidates<T extends Candidate>(candidates: readonly T[], now: number): T[] {
  return candidates.toSorted(
    (left, right) => left.tier - right.tier || blendScore(right, now) - blendScore(left, now),
  )
}

/** What a query matches, for highlighting: its clauses and each clause's typo corrections. */
export type Matcher = { readonly clauses: readonly Clause[]; readonly variants: readonly (readonly string[])[] }

type Token = { readonly start: number; readonly end: number; readonly norm: string }
type Range = { readonly start: number; readonly end: number; readonly clause: number }

const WORD_CHARS = /[\p{L}\p{N}\p{M}\p{Co}]+/gu
const MAX_RANGES = 400

function tokensOf(text: string): Token[] {
  const tokens: Token[] = []
  for (const match of text.matchAll(WORD_CHARS)) {
    tokens.push({ start: match.index, end: match.index + match[0].length, norm: normalize(match[0]) })
  }
  return tokens
}

/** The same matches FTS5 found, located in the text: words, prefixes, corrections and phrases. */
function matchRanges(text: string, matcher: Matcher): Range[] {
  const tokens = tokensOf(text)
  const variants = matcher.variants.map((list) => new Set(list))
  const ranges: Range[] = []
  for (let index = 0; index < tokens.length && ranges.length < MAX_RANGES; index++) {
    matcher.clauses.forEach((clause, number) => {
      const words = clause.kind === "term" ? [clause.token] : clause.tokens
      if (index + words.length > tokens.length) return
      for (let offset = 0; offset < words.length; offset++) {
        const token = tokens[index + offset].norm
        const last = offset === words.length - 1
        const matches =
          token === words[offset] ||
          (last && clause.prefix && token.startsWith(words[offset])) ||
          (clause.kind === "term" && variants[number]?.has(token))
        if (!matches) return
      }
      ranges.push({ start: tokens[index].start, end: tokens[index + words.length - 1].end, clause: number })
    })
  }
  return ranges
}

/** Markdown and Slack links read as their label. */
function readable(text: string): string {
  return text.replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, "$1").replace(/<https?:[^|>\s]*\|([^>\n]*)>/g, "$1")
}

function segmentsOf(text: string, ranges: readonly Range[], from: number, to: number): Segment[] {
  const segments: Segment[] = []
  let cursor = from
  for (const range of ranges) {
    if (range.end <= cursor || range.start >= to) continue
    const start = Math.max(range.start, cursor)
    if (start > cursor) segments.push({ text: text.slice(cursor, start), hit: false })
    const end = Math.min(range.end, to)
    segments.push({ text: text.slice(start, end), hit: true })
    cursor = end
  }
  if (cursor < to) segments.push({ text: text.slice(cursor, to), hit: false })
  return segments
}

/** Short text, such as a title, with every match highlighted. */
export function highlight(text: string, matcher: Matcher): Segment[] {
  const clean = readable(text)
  return tidySegments(segmentsOf(clean, matchRanges(clean, matcher), 0, clean.length))
}

/**
 * About `length` characters of a message around the densest group of matches: the window
 * that covers the most different query words, then the most matches, then the earliest.
 */
export function excerpt(text: string, matcher: Matcher, length = 240): Segment[] {
  // A pasted log can run to megabytes; scanning only its start keeps each excerpt to milliseconds.
  const clean = readable(text.slice(0, 200_000))
  const ranges = matchRanges(clean, matcher)
  let best = 0
  let bestClauses = -1
  let bestCount = -1
  for (let first = 0; first < ranges.length; first++) {
    const clauses = new Set<number>()
    let count = 0
    for (let last = first; last < ranges.length && ranges[last].end - ranges[first].start <= length; last++) {
      clauses.add(ranges[last].clause)
      count++
    }
    if (clauses.size > bestClauses || (clauses.size === bestClauses && count > bestCount)) {
      best = first
      bestClauses = clauses.size
      bestCount = count
    }
  }
  let start = ranges.length > 0 ? Math.max(0, ranges[best].start - 40) : 0
  // Start on a word, not in the middle of one.
  if (start > 0) {
    const space = clean.slice(start, ranges[best]?.start ?? start).search(/\s/)
    if (space >= 0) start += space + 1
  }
  const end = Math.min(clean.length, start + length)
  const segments = segmentsOf(clean, ranges, start, end)
  if (start > 0) segments.unshift({ text: "…", hit: false })
  if (end < clean.length) segments.push({ text: "…", hit: false })
  return tidySegments(segments)
}

/** One line of plain prose: collapsed whitespace, without the Markdown markers that read as noise. */
export function tidySegments(segments: readonly Segment[]): Segment[] {
  const merged: Segment[] = []
  for (const segment of segments) {
    const text = segment.text
      .replace(/\*\*|__|`+/g, "")
      .replace(/(^|\n)\s{0,3}(#{1,6}|>)\s+/g, "$1")
      .replace(/\s+/g, " ")
    if (!text) continue
    const last = merged.at(-1)
    if (last && last.hit === segment.hit) merged[merged.length - 1] = { text: last.text + text, hit: last.hit }
    else merged.push({ text, hit: segment.hit })
  }
  if (merged.length > 0) {
    merged[0] = { ...merged[0], text: merged[0].text.trimStart() }
    const end = merged.length - 1
    merged[end] = { ...merged[end], text: merged[end].text.trimEnd() }
  }
  return merged.filter((segment) => segment.text)
}

function sliceSegments(segments: readonly Segment[], from: number, to: number): Segment[] {
  const result: Segment[] = []
  let offset = 0
  for (const segment of segments) {
    const chars = Array.from(segment.text)
    const start = Math.max(from - offset, 0)
    const end = Math.min(to - offset, chars.length)
    if (end > start) result.push({ text: chars.slice(start, end).join(""), hit: segment.hit })
    offset += chars.length
  }
  return result
}

/**
 * Fits segments on one line of `width` cells and keeps the first match in view: when it sits
 * past the first 40% of the line, the start is dropped behind an ellipsis.
 */
export function fitSegments(segments: readonly Segment[], width: number): Segment[] {
  if (width <= 0) return []
  const lengths = segments.map((segment) => Array.from(segment.text).length)
  const total = lengths.reduce((sum, length) => sum + length, 0)
  if (total <= width) return [...segments]
  let firstHit = 0
  for (let index = 0; index < segments.length && !segments[index].hit; index++) firstHit += lengths[index]
  if (firstHit >= total) firstHit = 0
  let start = 0
  if (firstHit > width * 0.4) {
    start = Math.min(firstHit - Math.floor(width * 0.25), total - width + 1)
    // Cut between words: "…understood", not "…mat understood".
    const chars = Array.from(segments.map((segment) => segment.text).join(""))
    if (!/\s/.test(chars[start - 1] ?? " ")) {
      const space = chars.slice(start, firstHit).findIndex((char) => /\s/.test(char))
      if (space >= 0) start += space + 1
    }
  }
  const lead = start > 0 ? 1 : 0
  const room = width - lead
  const end = start + room < total ? start + room - 1 : total
  const fitted = sliceSegments(segments, start, end)
  if (lead) fitted.unshift({ text: "…", hit: false })
  if (end < total) fitted.push({ text: "…", hit: false })
  return tidyEdges(fitted)
}

function tidyEdges(segments: Segment[]): Segment[] {
  if (segments[1] && segments[0]?.text === "…") segments[1] = { ...segments[1], text: segments[1].text.trimStart() }
  return segments.filter((segment) => segment.text)
}

export function truncate(text: string, width: number): string {
  const chars = Array.from(text)
  if (chars.length <= width) return text
  if (width <= 1) return "…".slice(0, width)
  return chars.slice(0, width - 1).join("").trimEnd() + "…"
}

export function relativeTime(time: number, now: number): string {
  const diff = Math.max(0, now - time)
  if (diff < 60_000) return "now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < DAY) return `${Math.floor(diff / 3_600_000)}h`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d`
  const date = new Date(time)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  })
}

/** OpenCode's placeholder title until the first prompt names the session. */
export function isPlaceholderTitle(title: string | null | undefined): boolean {
  return !title || /^(New session|Child session) - \d{4}-\d{2}-\d{2}T/.test(title)
}
