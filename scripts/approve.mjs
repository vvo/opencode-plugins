// Approves the versions release.yml staged on npm: `pnpm approve`.
// Logs in to npm if needed, lists what is waiting for each package, asks once, then approves each.
// npm asks for the 2FA code or opens the browser for every approval.
import { execFileSync, spawnSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline/promises"

const root = resolve(import.meta.dirname, "..")
// A global .npmrc may point at a mirror; staging, login and approval only exist on the public registry.
const registry = ["--registry", "https://registry.npmjs.org/"]
const npm = (args) => execFileSync("npm", [...args, ...registry], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
const interactive = (args) => spawnSync("npm", [...args, ...registry], { stdio: "inherit" }).status === 0

const names = readdirSync(join(root, "packages"))
  .map((entry) => JSON.parse(readFileSync(join(root, "packages", entry, "package.json"), "utf8")))
  .filter((pkg) => !pkg.private)
  .map((pkg) => pkg.name)

// Staged versions are only visible to a maintainer, any other account just sees "Nothing staged".
const maintainers = new Set(
  JSON.parse(npm(["view", names[0], "maintainers", "--json"])).map((m) => (typeof m === "string" ? m : m.name).split(" ")[0]),
)
const whoami = () => {
  try {
    return npm(["whoami"]).trim()
  } catch {
    return undefined
  }
}
let user = whoami()
if (!user || !maintainers.has(user)) {
  console.log(user ? `npm user ${user} is not a maintainer (${[...maintainers].join(", ")}), opening npm login.` : "Not logged in to npm, opening npm login.")
  if (!interactive(["login"])) process.exit(1)
  user = whoami()
  if (!user || !maintainers.has(user)) {
    console.error(`Still logged in as ${user ?? "nobody"}, log in as ${[...maintainers].join(" or ")}.`)
    process.exit(1)
  }
}
console.log(`npm user: ${user}`)

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
