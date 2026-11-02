// One SQLite surface over bun:sqlite (OpenCode's runtime) and node:sqlite (tests, Node hosts).
// Both ship FTS5, so the plugin has no dependency of its own.

export type Row = Record<string, unknown>

export interface Statement {
  all(...params: unknown[]): Row[]
  get(...params: unknown[]): Row | undefined
  run(...params: unknown[]): void
}

export interface Database {
  prepare(sql: string): Statement
  exec(sql: string): void
  close(): void
}

type Driver = {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): unknown
  }
  exec(sql: string): unknown
  close(): void
}

function wrap(driver: Driver): Database {
  return {
    prepare(sql) {
      const statement = driver.prepare(sql)
      return {
        all: (...params) => statement.all(...params) as Row[],
        get: (...params) => (statement.get(...params) ?? undefined) as Row | undefined,
        run: (...params) => void statement.run(...params),
      }
    },
    exec: (sql) => void driver.exec(sql),
    close: () => driver.close(),
  }
}

// Kept out of static import positions: each runtime only has its own module.
const BUN_SQLITE = "bun:sqlite"
const NODE_SQLITE = "node:sqlite"

export async function openDatabase(file: string, options: { readonly?: boolean } = {}): Promise<Database> {
  if (process.versions.bun) {
    const { Database } = (await import(BUN_SQLITE)) as {
      Database: new (file: string, options: Record<string, boolean>) => Driver
    }
    return wrap(new Database(file, options.readonly ? { readonly: true } : { create: true, readwrite: true }))
  }
  const { DatabaseSync } = (await import(NODE_SQLITE)) as {
    DatabaseSync: new (file: string, options: Record<string, boolean>) => Driver
  }
  return wrap(new DatabaseSync(file, { readOnly: options.readonly === true }))
}
