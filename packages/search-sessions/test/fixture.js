// Minimal OpenCode databases, with only the columns the engine reads.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

export const DAY = 86_400_000
export const NOW = Date.now()

export function temp() {
  return mkdtempSync(join(tmpdir(), "opencode-search-sessions-"))
}

export function v2Database(dir) {
  const file = join(dir, "opencode.db")
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT);
    CREATE TABLE project_directory (project_id TEXT NOT NULL, directory TEXT NOT NULL);
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, directory TEXT NOT NULL,
      title TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `)
  let messages = 0
  const api = {
    file,
    project(id, worktree) {
      db.prepare("INSERT INTO project (id, worktree) VALUES (?, ?)").run(id, worktree)
      db.prepare("INSERT INTO project_directory (project_id, directory) VALUES (?, ?)").run(id, worktree)
      return api
    },
    session(id, { title, project = "global", directory = "/home/me", parent = null, created = NOW - DAY, updated = created }) {
      db.prepare(
        "INSERT INTO session_v2 (id, project_id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(id, project, parent, directory, title ?? null, created, updated)
      return api
    },
    /** A user prompt, or an assistant reply made of text, reasoning and tool parts. */
    message(sessionID, type, content, { id = `msg_${++messages}`, created = NOW - DAY + messages, updated = created } = {}) {
      const data =
        type === "user"
          ? { text: content, files: [], agents: [] }
          : { content: Array.isArray(content) ? content : [{ type: "text", text: content }] }
      db.prepare(
        "INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(id, sessionID, type, created, updated, JSON.stringify(data))
      return api
    },
    run(sql, ...params) {
      db.prepare(sql).run(...params)
      return api
    },
    close: () => db.close(),
  }
  return api
}

export function v1Database(dir) {
  const file = join(dir, "opencode-v1.db")
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, directory TEXT NOT NULL,
      title TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `)
  let rows = 0
  const api = {
    file,
    session(id, title, created = NOW - DAY) {
      db.prepare(
        "INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated) VALUES (?, 'global', NULL, '/home/me', ?, ?, ?)",
      ).run(id, title, created, created)
      return api
    },
    message(sessionID, role, parts) {
      const id = `msg_${++rows}`
      const time = NOW - DAY + rows
      db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)").run(
        id,
        sessionID,
        time,
        time,
        JSON.stringify({ role }),
      )
      for (const part of parts) {
        db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)").run(
          `prt_${++rows}`,
          id,
          sessionID,
          time,
          time,
          JSON.stringify(part),
        )
      }
      return api
    },
    close: () => db.close(),
  }
  return api
}
