/**
 * Turn cost and context math, kept free of any host API so it can be unit
 * tested and shared by the opencode 1 and opencode 2 entrypoints.
 */

export type Entry = {
  /** Message id, used to dedupe live state against the backfill. */
  id: string
  /** A turn starts at every user message; everything else adds to the open turn. */
  user: boolean
  cost: number
  created: number
  /** Display label of the model that produced the cost. */
  model?: string
}

export type Child = {
  cost: number
  created: number
  model?: string
}

export type ModelSpend = {
  model: string
  cost: number
}

/** Rows shown before the rest fold into one "others" row. */
const MODEL_ROWS = 4

/**
 * Session spend per model, most expensive first. Empty when one model did all
 * the work, since the `spent` line already says it.
 *
 * `since` is the session's creation time: a fork copies its parent's messages
 * with their original costs and timestamps, and those were paid by the parent.
 */
export function computeModels(
  entries: Iterable<Entry>,
  children: Iterable<Child> = [],
  since = 0,
): ModelSpend[] {
  const byID = new Map<string, Entry>()
  for (const entry of entries) byID.set(entry.id, entry)

  const totals = new Map<string, number>()
  const add = (model: string | undefined, cost: number) => {
    if (cost <= 0) return
    const key = model ?? "subagents"
    totals.set(key, (totals.get(key) ?? 0) + cost)
  }
  for (const entry of byID.values()) if (!entry.user && entry.created >= since) add(entry.model, entry.cost)
  for (const child of children) add(child.model, child.cost)

  const rows = [...totals].map(([model, cost]) => ({ model, cost })).sort((a, b) => b.cost - a.cost)
  if (rows.length < 2) return []
  if (rows.length <= MODEL_ROWS) return rows
  const rest = rows.slice(MODEL_ROWS - 1)
  return [
    ...rows.slice(0, MODEL_ROWS - 1),
    { model: `${rest.length} others`, cost: rest.reduce((sum, row) => sum + row.cost, 0) },
  ]
}

/** `vercel` + `anthropic/claude-opus-5.5` + `max` -> `claude-opus-5.5 max`. */
export function modelLabel(id: string, variant?: string): string {
  const name = id.split("/").at(-1) || id
  return variant && variant !== "default" ? `${name} ${variant}` : name
}

export type Turns = {
  current: number
  previous: number
}

/**
 * Groups messages into turns and returns the cost of the last two.
 *
 * Entries may repeat by id (the live message window overlaps the backfill); the
 * last one wins. Subagent spend is attributed to the turn that was open when the
 * subagent session was created.
 */
export function computeTurns(entries: Iterable<Entry>, children: Iterable<Child> = []): Turns {
  const byID = new Map<string, Entry>()
  for (const entry of entries) byID.set(entry.id, entry)

  const sorted = [...byID.values()].sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1))

  const turns: { cost: number; start: number }[] = []
  for (const entry of sorted) {
    if (entry.user) turns.push({ cost: 0, start: entry.created })
    else if (turns.length > 0) turns[turns.length - 1]!.cost += entry.cost
  }

  for (const child of children) {
    // findLast: the most recent turn that had already started when the subagent did.
    const turn = turns.findLast((candidate) => child.created >= candidate.start)
    if (turn) turn.cost += child.cost
  }

  return {
    current: turns.at(-1)?.cost ?? 0,
    previous: turns.at(-2)?.cost ?? 0,
  }
}

export type TokenUsage = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

/** One message, reduced to what the context calculation needs. */
export type ContextMessage = {
  id: string
  /** True for an assistant message that reported token usage. */
  assistant: boolean
  /** True for a compaction message that finished; everything before it is out of context. */
  compacted: boolean
  tokens?: TokenUsage
}

export type Context = {
  tokens: number
  /** Undefined when the model reports no context limit. */
  percent?: number
}

/**
 * Context size as opencode itself computes it, so the numbers we render match
 * the ones the host would have shown.
 *
 * Reads the newest assistant message that reported tokens, ignoring anything at
 * or before the last completed compaction (those tokens are no longer in
 * context) and anything at or after a revert point. Returns undefined when
 * there is nothing to show, which is also how the host decides to hide the line.
 */
export function computeContext(
  messages: readonly ContextMessage[],
  limit: number | undefined,
  revertMessageID?: string,
): Context | undefined {
  const revertAt = revertMessageID ? messages.findIndex((m) => m.id === revertMessageID) : -1
  // A revert pointing at a message we have not loaded means we cannot trust any of it.
  if (revertMessageID && revertAt === -1) return undefined

  const end = revertAt === -1 ? messages.length : revertAt
  const compactedAt = messages.findLastIndex((m, i) => m.compacted && i < end)
  const latest = messages.findLast((m, i) => m.assistant && m.tokens !== undefined && i > compactedAt && i < end)
  if (!latest?.tokens) return undefined

  const t = latest.tokens
  const tokens = t.input + t.output + t.reasoning + t.cache.read + t.cache.write
  if (tokens <= 0) return undefined

  return {
    tokens,
    percent: limit ? Math.round((tokens / limit) * 100) : undefined,
  }
}
