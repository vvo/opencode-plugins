import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const configDir = resolve(homedir(), ".config/opencode")
const cliPath = resolve(configDir, "cli.json")
const statePath = resolve(configDir, "opencode-plugins-dev.json")
const packages = [
  { name: "opencode-cost-details", directory: "packages/cost-details/dist" },
  { name: "opencode-prs", directory: "packages/prs/dist" },
].map((plugin) => ({ ...plugin, target: resolve(root, plugin.directory) }))

function isPackagePlugin(plugin, { name, directory, target }) {
  if (typeof plugin !== "string") return false
  return plugin === name || plugin.startsWith(`${name}@`) || plugin === target || plugin.endsWith(`/${directory}`)
}

async function link() {
  const cli = JSON.parse(await readFile(cliPath, "utf8"))
  const configured = cli.plugins ?? []
  const removed = configured.filter((plugin) => packages.some((item) => isPackagePlugin(plugin, item)))
  const paths = packages.map((plugin) => plugin.target)
  cli.plugins = [...configured.filter((plugin) => !removed.includes(plugin)), ...paths]
  await writeFile(statePath, `${JSON.stringify({ removed, paths }, null, 2)}\n`)
  await writeFile(cliPath, `${JSON.stringify(cli, null, 2)}\n`)
  console.log(`updated ${cliPath}`)
}

async function unlinkAll() {
  const state = JSON.parse(await readFile(statePath, "utf8"))
  const cli = JSON.parse(await readFile(cliPath, "utf8"))
  cli.plugins = [
    ...(cli.plugins ?? []).filter((plugin) => !state.paths.includes(plugin)),
    ...state.removed.filter((plugin) => !(cli.plugins ?? []).includes(plugin)),
  ]
  await writeFile(cliPath, `${JSON.stringify(cli, null, 2)}\n`)
  await import("node:fs/promises").then(({ unlink }) => unlink(statePath))
  console.log(`restored ${cliPath}`)
}

if (process.argv[2] === "link") await link()
else if (process.argv[2] === "unlink") await unlinkAll()
else throw new Error("usage: node scripts/dev-link.mjs <link|unlink>")
