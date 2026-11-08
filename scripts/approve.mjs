// Approves the versions release.yml staged on npm: `pnpm approve`.
// Logs in to npm if needed, lists what is waiting for each package, asks once, then approves each.
// npm asks for the 2FA code or opens the browser for every approval.
import { execFileSync, spawnSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline/promises"

const root = resolve(import.meta.dirname, "..")
const npm = (args) => execFileSync("npm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
const interactive = (args) => spawnSync("npm", args, { stdio: "inherit" }).status === 0

try {
  console.log(`npm user: ${npm(["whoami"]).trim()}`)
} catch {
  console.log("Not logged in to npm, opening npm login.")
  if (!interactive(["login"])) process.exit(1)
}

const names = readdirSync(join(root, "packages"))
  .map((entry) => JSON.parse(readFileSync(join(root, "packages", entry, "package.json"), "utf8")))
  .filter((pkg) => !pkg.private)
  .map((pkg) => pkg.name)

const done = /approved|published|rejected|expired/i
const pending = names.flatMap((name) => JSON.parse(npm(["stage", "list", name, "--json"]) || "[]"))
  .filter((item) => !done.test(item.status ?? ""))

if (pending.length === 0) {
  console.log("Nothing staged.")
  process.exit(0)
}

for (const item of pending) console.log(`  ${item.packageName}@${item.version}  staged ${item.createdAt}  ${item.status ?? ""}`)
const rl = createInterface({ input: process.stdin, output: process.stdout })
const answer = (await rl.question(`Approve ${pending.length === 1 ? "it" : `these ${pending.length}`}? [Y/n] `)).trim()
rl.close()
if (/^n/i.test(answer)) process.exit(0)

let failed = 0
for (const item of pending) {
  console.log(`\n${item.packageName}@${item.version}`)
  if (!interactive(["stage", "approve", item.id])) failed++
}
process.exit(failed ? 1 : 0)
