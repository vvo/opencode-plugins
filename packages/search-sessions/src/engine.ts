import { mkdir } from "node:fs/promises"
import { basename, dirname } from "node:path"
import { openDatabase, type Database, type Row, type Statement } from "./sqlite.js"
import {
  clauseMatch,
  excerpt,
  highlight,
  isPlaceholderTitle,
  matchAll,
  parseQuery,
  pickVariants,
  rankCandidates,
  tidySegments,
  typoBudget,
  typoDistance,
  type Clause,
  type Matcher,
  type Near,
  type Segment,
} from "./query.js"

/** Bump to rebuild every index, e.g. after a tokenizer or schema change. */
export const INDEX_VERSION = 1

/** Sessions updated this recently get their messages rechecked: a streaming reply does not touch the session row. */
const HOT_MS = 15 * 60_000
/** Message ID of the doc holding a session's title. */
const TITLE = "title"
const OPTIMIZE_AFTER = 200
const FIRST_PROMPT_CHARS = 400
const WORD = /^\p{L}+$/u

export type Flavor = "v1" | "v2"
export type Role = "user" | "assistant"

export type Hit = {
  readonly sessionID: string
  readonly title: readonly Segment[]
  readonly project: string
  readonly updated: number
  /** Who wrote the message the snippet comes from. */
  readonly role?: Role
  readonly snippet: readonly Segment[]
}

export type SearchInput = {
  readonly query: string
  readonly limit?: number
  /** Limits results to the project that owns this directory. */
  readonly directory?: string
  /** The directory's project when the host knows it, so a fresh worktree still finds its repository. */
  readonly projectID?: string
}

export type SearchOutput = {
  readonly query: string
  readonly hits: readonly Hit[]
  /** Matching sessions, including those past the limit. */
  readonly total: number
  readonly elapsed: number
  /** The project the results are limited to, when scoped. */
  readonly scope?: string
}

export type Progress = {
  readonly sessions: number
  /** Sessions left to index in the current pass. */
  readonly pending: number
  readonly syncing: boolean
}

export type SyncOptions = {
  /** Sessions to recheck even when their row did not change. */
  readonly hints?: readonly string[]
  /** Called between sessions once a slice of work is spent; resolves when work may resume. */
  readonly pause?: () => Promise<void>
  readonly slice?: number
  readonly progress?: (progress: Progress) => void
}

type SessionRow = {
  readonly id: string
  readonly title: string | null
  readonly directory: string
  readonly projectID: string
  readonly parentID: string | null
  readonly created: number
  readonly updated: number
}

type Stamp = { readonly id: string; readonly role: Role; readonly created: number; readonly updated: number }
type Project = { readonly worktree: string; readonly name: string | null }

interface Source {
  sessions(): SessionRow[]
  stamps(sessionID: string): Stamp[]
  texts(sessionID: string): Map<string, string>
  text(messageID: string): string
  projects(): Map<string, Project>
  projectOf(directory: string): string | undefined
}

type Found = {
  readonly sessionID: string
  tier: number
  score: number
  count: number
  updated: number
  titleRow?: number
  body?: { row: number; score: number }
}

type Scope = { readonly sql: string; readonly params: readonly unknown[]; readonly label?: string }

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function hasTable(db: Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}

function projectsFrom(statement: Statement): Map<string, Project> {
  return new Map(
    statement.all().map((row) => [String(row.id), { worktree: String(row.worktree ?? ""), name: (row.name as string) || null }]),
  )
}

// OpenCode 2: one row per message, the text inside its JSON content.
function v2Source(db: Database): Source {
  const content =
    "CASE type WHEN 'user' THEN json_extract(data, '$.text') ELSE (SELECT group_concat(json_extract(part.value, '$.text'), char(10)) FROM json_each(data, '$.content') AS part WHERE json_extract(part.value, '$.type') = 'text') END"
  const sessions = db.prepare(
    "SELECT id, title, directory, project_id AS projectID, parent_id AS parentID, time_created AS created, time_updated AS updated FROM session_v2",
  )
  const stamps = db.prepare(
    "SELECT id, type AS role, time_created AS created, time_updated AS updated FROM session_message WHERE session_id = ? AND type IN ('user', 'assistant')",
  )
  const texts = db.prepare(
    `SELECT id, ${content} AS text FROM session_message WHERE session_id = ? AND type IN ('user', 'assistant')`,
  )
  const one = db.prepare(`SELECT ${content} AS text FROM session_message WHERE id = ?`)
  const projects = db.prepare("SELECT id, worktree, name FROM project")
  const directory = hasTable(db, "project_directory")
    ? db.prepare("SELECT project_id FROM project_directory WHERE directory = ? LIMIT 1")
    : undefined
  return {
    sessions: () => sessions.all() as SessionRow[],
    stamps: (sessionID) => stamps.all(sessionID) as Stamp[],
    texts: (sessionID) => new Map(texts.all(sessionID).map((row) => [String(row.id), text(row.text)])),
    text: (messageID) => text(one.get(messageID)?.text),
    projects: () => projectsFrom(projects),
    projectOf: (path) => directory?.get(path)?.project_id as string | undefined,
  }
}

// OpenCode 1: messages and their parts in two tables. A message changes when any part does.
function v1Source(db: Database): Source {
  const content =
    "(SELECT group_concat(json_extract(p.data, '$.text'), char(10)) FROM part p WHERE p.message_id = m.id AND json_extract(p.data, '$.type') = 'text' AND coalesce(json_extract(p.data, '$.synthetic'), 0) = 0 AND coalesce(json_extract(p.data, '$.ignored'), 0) = 0)"
  const sessions = db.prepare(
    "SELECT id, title, directory, project_id AS projectID, parent_id AS parentID, time_created AS created, time_updated AS updated FROM session",
  )
  const stamps = db.prepare(
    "SELECT m.id AS id, json_extract(m.data, '$.role') AS role, m.time_created AS created, max(m.time_updated, coalesce((SELECT max(p.time_updated) FROM part p WHERE p.message_id = m.id), 0)) AS updated FROM message m WHERE m.session_id = ? AND json_extract(m.data, '$.role') IN ('user', 'assistant')",
  )
  const texts = db.prepare(`SELECT m.id AS id, ${content} AS text FROM message m WHERE m.session_id = ?`)
  const one = db.prepare(`SELECT ${content} AS text FROM message m WHERE m.id = ?`)
  const projects = db.prepare("SELECT id, worktree, name FROM project")
  return {
    sessions: () => sessions.all() as SessionRow[],
    stamps: (sessionID) => stamps.all(sessionID) as Stamp[],
    texts: (sessionID) => new Map(texts.all(sessionID).map((row) => [String(row.id), text(row.text)])),
    text: (messageID) => text(one.get(messageID)?.text),
    projects: () => projectsFrom(projects),
    projectOf: () => undefined,
  }
}

// Docs are messages plus one title row per session; the FTS rowid is the doc id. Messages
// without text keep a doc row too, so a later pass knows they did not change.
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS session (key INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, title TEXT, directory TEXT NOT NULL, project_id TEXT NOT NULL, project TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS session_directory ON session (directory)",
  "CREATE INDEX IF NOT EXISTS session_project ON session (project_id, updated)",
  "CREATE INDEX IF NOT EXISTS session_updated ON session (updated)",
  "CREATE TABLE IF NOT EXISTS doc (id INTEGER PRIMARY KEY, session INTEGER NOT NULL, message_id TEXT NOT NULL, role INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS doc_session ON doc (session)",
  // No prefix indexes: they double the index, and an optimized index answers "de*" as fast without them.
  "CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5 (title, body, tokenize = 'unicode61 remove_diacritics 2')",
  "CREATE VIRTUAL TABLE IF NOT EXISTS vocab USING fts5vocab (fts, 'row')",
]

const ROLE = { title: 0, user: 1, assistant: 2 } as const
const ROLES: readonly (Role | undefined)[] = [undefined, "user", "assistant"]

function migrate(db: Database) {
  const meta = hasTable(db, "meta") ? db.prepare("SELECT value FROM meta WHERE key = 'version'").get() : undefined
  if (meta && Number(meta.value) !== INDEX_VERSION) {
    for (const table of ["vocab", "fts", "doc", "session", "meta"]) db.exec(`DROP TABLE IF EXISTS ${table}`)
  }
  for (const statement of SCHEMA) db.exec(statement)
  if (meta && Number(meta.value) === INDEX_VERSION) return
  // A title match outweighs the same words in a message.
  db.exec("INSERT INTO fts (fts, rank) VALUES ('rank', 'bm25(6.0, 1.0)')")
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('version', ?)").run(String(INDEX_VERSION))
}

function projectLabel(session: SessionRow, projects: Map<string, Project>): string {
  const project = session.projectID === "global" ? undefined : projects.get(session.projectID)
  return project?.name || basename(project?.worktree ?? "") || basename(session.directory) || session.directory
}

class Lexicon {
  private readonly buckets = new Map<number, { terms: string[]; docs: number[] }>()

  constructor(rows: Row[]) {
    for (const row of rows) {
      const term = String(row.term)
      if (term.length < 4 || term.length > 32 || !WORD.test(term)) continue
      let bucket = this.buckets.get(term.length)
      if (!bucket) this.buckets.set(term.length, (bucket = { terms: [], docs: [] }))
      bucket.terms.push(term)
      bucket.docs.push(Number(row.doc))
    }
  }

  near(token: string, max: number): Near[] {
    const found: Near[] = []
    const first = token.charCodeAt(0)
    const second = token.charCodeAt(1)
    for (let length = token.length - max; length <= token.length + max; length++) {
      const bucket = this.buckets.get(length)
      if (!bucket) continue
      for (let index = 0; index < bucket.terms.length; index++) {
        const term = bucket.terms[index]
        // People rarely mistype the first letter. Keeping swaps, insertions and deletions there
        // still skips about nine terms in ten, and the distance check is the slow part.
        if (term.charCodeAt(0) !== first && term.charCodeAt(0) !== second && term.charCodeAt(1) !== first) continue
        const distance = typoDistance(token, term, max)
        if (distance <= max) found.push({ term, distance, docs: bucket.docs[index] })
      }
    }
    return found
  }
}

export class Engine {
  private readonly statements = new Map<string, Statement>()
  private lexicon?: Lexicon
  private lexiconStale = true
  private projects = new Map<string, Project>()
  private running?: Promise<boolean>
  private queued?: { hints: Set<string> }

  private constructor(
    private readonly source: Source,
    private readonly sourceDb: Database,
    private readonly db: Database,
  ) {
    this.projects = source.projects()
  }

  static async open(options: { readonly database: string; readonly index: string; readonly flavor: Flavor }) {
    const sourceDb = await openDatabase(options.database, { readonly: true })
    try {
      const flavor = options.flavor === "v2" && !hasTable(sourceDb, "session_v2") ? "v1" : options.flavor
      const source = flavor === "v2" ? v2Source(sourceDb) : v1Source(sourceDb)
      await mkdir(dirname(options.index), { recursive: true })
      const db = await openDatabase(options.index)
      db.exec("PRAGMA busy_timeout = 5000")
      db.exec("PRAGMA journal_mode = WAL")
      db.exec("PRAGMA synchronous = NORMAL")
      migrate(db)
      return new Engine(source, sourceDb, db)
    } catch (error) {
      sourceDb.close()
      throw error
    }
  }

  close() {
    this.db.close()
    this.sourceDb.close()
  }

  private statement(sql: string): Statement {
    let statement = this.statements.get(sql)
    if (!statement) this.statements.set(sql, (statement = this.db.prepare(sql)))
    return statement
  }

  sessionCount(): number {
    return Number(this.statement("SELECT count(*) AS count FROM session").get()?.count ?? 0)
  }

  /** Brings the index up to date. Calls made while a pass runs are merged into one more pass. */
  sync(options: SyncOptions = {}): Promise<boolean> {
    if (this.running) {
      this.queued ??= { hints: new Set() }
      for (const hint of options.hints ?? []) this.queued.hints.add(hint)
      return this.running
    }
    const run = async () => {
      let changed = await this.pass(options)
      while (this.queued) {
        const { hints } = this.queued
        this.queued = undefined
        changed = (await this.pass({ ...options, hints: [...hints] })) || changed
      }
      return changed
    }
    this.running = run().finally(() => {
      this.running = undefined
    })
    return this.running
  }

  private async pass(options: SyncOptions): Promise<boolean> {
    const hints = new Set(options.hints ?? [])
    const now = Date.now()
    const sessions = this.source.sessions()
    this.projects = this.source.projects()
    const known = new Map(
      this.statement("SELECT id, updated FROM session").all().map((row) => [String(row.id), Number(row.updated)]),
    )
    const live = new Set<string>()
    const queue: SessionRow[] = []
    for (const session of sessions) {
      // Subagent sessions are the main agent talking to itself; their parent holds the conversation.
      if (session.parentID) continue
      live.add(session.id)
      const previous = known.get(session.id)
      if (previous === undefined || previous !== session.updated || now - session.updated < HOT_MS || hints.has(session.id)) {
        queue.push(session)
      }
    }
    let changed = false
    for (const id of known.keys()) {
      if (live.has(id)) continue
      this.write(() => this.removeSession(id))
      changed = true
    }
    // Newest first, so a first build makes recent work searchable within seconds.
    queue.sort((left, right) => right.updated - left.updated)
    const slice = options.slice ?? 30
    let started = performance.now()
    let pending = queue.length
    options.progress?.({ sessions: live.size, pending, syncing: pending > 0 })
    let indexed = 0
    for (const session of queue) {
      if (this.syncSession(session, known.has(session.id))) {
        changed = true
        indexed++
      }
      pending--
      if (performance.now() - started < slice) continue
      options.progress?.({ sessions: live.size, pending, syncing: pending > 0 })
      await options.pause?.()
      started = performance.now()
    }
    // A first build leaves many small segments; one merge makes every later query cheaper.
    if (indexed >= OPTIMIZE_AFTER) this.db.exec("INSERT INTO fts (fts) VALUES ('optimize')")
    if (changed) this.lexiconStale = true
    options.progress?.({ sessions: live.size, pending: 0, syncing: false })
    return changed
  }

  private write(work: () => void) {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      work()
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  private removeSession(id: string) {
    const key = this.statement("SELECT key FROM session WHERE id = ?").get(id)?.key
    if (key === undefined) return
    this.statement("DELETE FROM fts WHERE rowid IN (SELECT id FROM doc WHERE session = ?)").run(key)
    this.statement("DELETE FROM doc WHERE session = ?").run(key)
    this.statement("DELETE FROM session WHERE key = ?").run(key)
  }

  /** What the index lacks for a session, compared with the messages it has now. */
  private plan(session: SessionRow, stamps: readonly Stamp[], title: string) {
    const stored = this.statement("SELECT key, title, updated FROM session WHERE id = ?").get(session.id)
    const docs = new Map(
      stored
        ? this.statement("SELECT id, message_id, updated FROM doc WHERE session = ?")
            .all(stored.key)
            .map((row) => [String(row.message_id), { id: Number(row.id), updated: Number(row.updated) }])
        : [],
    )
    const titleChanged = !stored || (stored.title ?? "") !== title
    const changes = stamps.filter((stamp) => docs.get(stamp.id)?.updated !== stamp.updated)
    const current = new Set(stamps.map((stamp) => stamp.id))
    const removed = [...docs.entries()].filter(([id]) => id !== TITLE && !current.has(id))
    const unchanged = !titleChanged && changes.length === 0 && removed.length === 0
    const fresh = unchanged && stored !== undefined && Number(stored.updated) === session.updated
    return { docs, titleChanged, changes, removed, unchanged, fresh }
  }

  private syncSession(session: SessionRow, known: boolean): boolean {
    // A fork copies its parent's messages with their original times; the parent already has them.
    const stamps = this.source.stamps(session.id).filter((stamp) => stamp.created >= session.created)
    const title = isPlaceholderTitle(session.title) ? "" : (session.title ?? "")
    const first = this.plan(session, stamps, title)
    if (first.fresh) return false

    // A first sync reads every text of the session in one query; later passes only the changed messages.
    const texts = !known || first.changes.length > 16 ? this.source.texts(session.id) : undefined
    const contents = new Map(
      first.changes.map((stamp) => [stamp.id, texts ? (texts.get(stamp.id) ?? "") : this.source.text(stamp.id)]),
    )

    let wrote = false
    this.write(() => {
      // Planned again under the write lock: another OpenCode window may have indexed this session
      // meanwhile. Its plan can only need fewer changes, so every text it needs is already read.
      const { docs, titleChanged, changes, removed, unchanged, fresh } = this.plan(session, stamps, title)
      if (fresh) return
      wrote = !unchanged
      const key = Number(
        this.statement(
          "INSERT INTO session (id, title, directory, project_id, project, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET title = excluded.title, directory = excluded.directory, project_id = excluded.project_id, project = excluded.project, created = excluded.created, updated = excluded.updated RETURNING key",
        ).get(
          session.id,
          title || null,
          session.directory,
          session.projectID,
          projectLabel(session, this.projects),
          session.created,
          session.updated,
        )?.key,
      )
      const upsert = (messageID: string, role: number, created: number, updated: number) => {
        const existing = docs.get(messageID)
        if (existing) {
          this.statement("UPDATE doc SET role = ?, created = ?, updated = ? WHERE id = ?").run(role, created, updated, existing.id)
          this.statement("DELETE FROM fts WHERE rowid = ?").run(existing.id)
          return existing.id
        }
        return Number(
          this.statement("INSERT INTO doc (session, message_id, role, created, updated) VALUES (?, ?, ?, ?, ?) RETURNING id").get(
            key,
            messageID,
            role,
            created,
            updated,
          )?.id,
        )
      }
      if (titleChanged) {
        const row = upsert(TITLE, ROLE.title, session.created, session.updated)
        if (title) this.statement("INSERT INTO fts (rowid, title, body) VALUES (?, ?, '')").run(row, title)
      }
      for (const [, doc] of removed) {
        this.statement("DELETE FROM fts WHERE rowid = ?").run(doc.id)
        this.statement("DELETE FROM doc WHERE id = ?").run(doc.id)
      }
      for (const stamp of changes) {
        const row = upsert(stamp.id, ROLE[stamp.role], stamp.created, stamp.updated)
        const body = (contents.get(stamp.id) ?? "").trim()
        if (body) this.statement("INSERT INTO fts (rowid, title, body) VALUES (?, '', ?)").run(row, body)
      }
    })
    return wrote
  }

  /** Reloads the typo-correction vocabulary when the index changed since the last load. */
  refreshLexicon() {
    if (!this.lexiconStale && this.lexicon) return
    this.lexicon = new Lexicon(this.statement("SELECT term, doc FROM vocab WHERE length(term) BETWEEN 4 AND 32").all())
    this.lexiconStale = false
  }

  private variants(clause: Clause): string[] {
    if (clause.kind !== "term") return []
    const budget = typoBudget(clause.token.length)
    if (budget === 0 || /\d/.test(clause.token)) return []
    // While a word is being typed, a longer word starting with it is a match, not a typo.
    if (clause.prefix && this.statement("SELECT 1 AS found FROM vocab WHERE term > ? AND term < ? LIMIT 1").get(clause.token, `${clause.token}\uffff`)) {
      return []
    }
    if (!this.lexicon) this.refreshLexicon()
    const exact = Number(this.statement("SELECT doc FROM vocab WHERE term = ?").get(clause.token)?.doc ?? 0)
    return pickVariants(clause.token, this.lexicon!.near(clause.token, budget), exact)
  }

  // A parent folder can be a repository of its own, so a directory without a known project
  // is searched on its own rather than guessed into one.
  private scope(directory: string | undefined, known?: string): Scope {
    if (!directory) return { sql: "", params: [] }
    const projectID =
      known ??
      this.source.projectOf(directory) ??
      (this.statement("SELECT project_id FROM session WHERE directory = ? ORDER BY updated DESC LIMIT 1").get(directory)
        ?.project_id as string | undefined)
    if (!projectID || projectID === "global") return { sql: "AND s.directory = ?", params: [directory], label: basename(directory) }
    const project = this.projects.get(projectID)
    return { sql: "AND s.project_id = ?", params: [projectID], label: project?.name || basename(project?.worktree || directory) }
  }

  private collect(match: string, tier: number, found: Map<string, Found>, scope: Scope) {
    const rows = this.statement(
      `SELECT s.id AS sid, d.id AS row, d.role AS role, fts.rank AS rank, s.updated AS updated FROM fts CROSS JOIN doc d ON d.id = fts.rowid CROSS JOIN session s ON s.key = d.session WHERE fts MATCH ? ${scope.sql}`,
    ).all(match, ...scope.params)
    for (const row of rows) {
      const sessionID = String(row.sid)
      let item = found.get(sessionID)
      if (item && item.tier < tier) continue
      if (!item) {
        item = { sessionID, tier, score: 0, count: 0, updated: Number(row.updated) }
        found.set(sessionID, item)
      }
      const score = -Number(row.rank)
      item.count++
      item.score = Math.max(item.score, score)
      if (row.role === ROLE.title) item.titleRow = Number(row.row)
      else if (!item.body || score > item.body.score) item.body = { row: Number(row.row), score }
    }
  }

  /** Sessions where every clause matches, but not in the same message. */
  private collectSpread(matches: readonly string[], found: Map<string, Found>, scope: Scope) {
    const perClause = matches
      .map((match) => {
        const sessions = new Map<string, Found>()
        this.collect(match, 2, sessions, scope)
        return sessions
      })
      .sort((left, right) => left.size - right.size)
    for (const [sessionID, first] of perClause[0] ?? []) {
      if (found.has(sessionID)) continue
      const all = perClause.map((sessions) => sessions.get(sessionID))
      if (all.some((item) => !item)) continue
      const items = all as Found[]
      const body = items
        .map((item) => item.body)
        .filter((item) => item !== undefined)
        .sort((left, right) => right.score - left.score)[0]
      found.set(sessionID, {
        sessionID,
        tier: 2,
        score: items.reduce((sum, item) => sum + item.score, 0),
        count: items.reduce((sum, item) => sum + item.count, 0),
        updated: first.updated,
        titleRow: items.find((item) => item.titleRow !== undefined)?.titleRow,
        body,
      })
    }
  }

  search(input: SearchInput): SearchOutput {
    const started = performance.now()
    const limit = input.limit ?? 50
    const scope = this.scope(input.directory, input.projectID)
    const clauses = input.query.trim().length >= 2 ? parseQuery(input.query) : []
    if (clauses.length === 0) return this.recent(input, scope, limit, started)

    const variants = clauses.map((clause) => this.variants(clause))
    const exact = clauses.map((clause) => clauseMatch(clause))
    const fuzzy = clauses.map((clause, index) => clauseMatch(clause, variants[index]))
    const found = new Map<string, Found>()
    this.collect(matchAll(exact), 0, found, scope)
    if (variants.some((list) => list.length > 0)) this.collect(matchAll(fuzzy), 1, found, scope)
    if (clauses.length > 1 && found.size < limit) this.collectSpread(fuzzy, found, scope)

    const matcher: Matcher = { clauses, variants }
    const candidates = [...found.values()].map((item) => ({ ...item, titled: item.titleRow !== undefined }))
    const hits = rankCandidates(candidates, Date.now())
      .slice(0, limit)
      .flatMap((item) => this.hit(item, matcher) ?? [])
    return { query: input.query, hits, total: found.size, elapsed: performance.now() - started, scope: scope.label }
  }

  private recent(input: SearchInput, scope: Scope, limit: number, started: number): SearchOutput {
    const where = scope.sql ? `WHERE ${scope.sql.slice(4)}` : ""
    const rows = this.statement(
      `SELECT s.id AS id FROM session s ${where} ORDER BY s.updated DESC LIMIT ?`,
    ).all(...scope.params, limit)
    const total = Number(this.statement(`SELECT count(*) AS count FROM session s ${where}`).get(...scope.params)?.count ?? 0)
    return {
      query: input.query,
      hits: rows.flatMap((row) => this.hit({ sessionID: String(row.id), tier: 0, score: 0, count: 0, updated: 0 }) ?? []),
      total,
      elapsed: performance.now() - started,
      scope: scope.label,
    }
  }

  // Excerpts are cut in JS from the stored text. FTS5's snippet() re-expands a prefix like
  // "con*" over every matching term for each result, which cost over 100ms per keystroke.
  private hit(item: Found, matcher?: Matcher): Hit | undefined {
    const session = this.statement("SELECT key, title, project, updated FROM session WHERE id = ?").get(item.sessionID)
    if (!session) return undefined
    const title = String(session.title ?? "")
    const titleSegments =
      matcher && item.titleRow !== undefined && title
        ? highlight(title, matcher)
        : [{ text: title || "Untitled session", hit: false }]
    let role: Role | undefined
    let snippet: Segment[] = []
    if (matcher && item.body) {
      const row = this.statement("SELECT f.body AS body, d.role AS role FROM fts f CROSS JOIN doc d ON d.id = f.rowid WHERE f.rowid = ?").get(
        item.body.row,
      )
      snippet = excerpt(String(row?.body ?? ""), matcher)
      role = ROLES[Number(row?.role)]
    }
    if (snippet.length === 0) {
      // Recent sessions and title-only matches show the prompt that started the session.
      const first = this.statement(
        `SELECT f.body AS body FROM doc d CROSS JOIN fts f ON f.rowid = d.id WHERE d.session = ? AND d.role = ${ROLE.user} ORDER BY d.created LIMIT 1`,
      ).get(session.key)
      if (first) {
        role = "user"
        snippet = tidySegments([{ text: String(first.body).slice(0, FIRST_PROMPT_CHARS), hit: false }])
      }
    }
    return {
      sessionID: item.sessionID,
      title: titleSegments,
      project: String(session.project),
      updated: Number(session.updated),
      role,
      snippet,
    }
  }
}
