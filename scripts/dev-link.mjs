import { lstat, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises"
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
const serverPackages = [{ name: "opencode-awake", directory: "packages/awake" }].map((plugin) => ({
  ...plugin,
  target: resolve(root, plugin.directory),
  link: resolve(configDir, "plugins", plugin.name),
}))

function isPackagePlugin(plugin, { name, directory, target }) {
  if (typeof plugin !== "string") return false
  return plugin === name || plugin.startsWith(`${name}@`) || plugin === target || plugin.endsWith(`/${directory}`)
}

async function removeLink(path) {
  const stat = await lstat(path).catch(() => undefined)
  if (stat?.isSymbolicLink()) await unlink(path)
}

async function link() {
  const cli = JSON.parse(await readFile(cliPath, "utf8"))
  const configured = cli.plugins ?? []
  const removed = configured.filter((plugin) => packages.some((item) => isPackagePlugin(plugin, item)))
  const paths = packages.map((plugin) => plugin.target)
  cli.plugins = [...configured.filter((plugin) => !removed.includes(plugin)), ...paths]
  for (const plugin of serverPackages) {
    await mkdir(resolve(configDir, "plugins"), { recursive: true })
    await removeLink(plugin.link)
    await symlink(plugin.target, plugin.link)
    console.log(`linked ${plugin.link}`)
  }
  await writeFile(statePath, `${JSON.stringify({ removed, paths, links: serverPackages.map((p) => p.link) }, null, 2)}\n`)
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
  for (const path of state.links ?? []) await removeLink(path)
  await writeFile(cliPath, `${JSON.stringify(cli, null, 2)}\n`)
  await unlink(statePath)
  console.log(`restored ${cliPath}`)
}

if (process.argv[2] === "link") await link()
else if (process.argv[2] === "unlink") await unlinkAll()
else throw new Error("usage: node scripts/dev-link.mjs <link|unlink>")
