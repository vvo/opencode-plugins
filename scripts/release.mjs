// Release steps for .github/workflows/release.yml. Uses only Node and npm, so
// the job that holds the npm OIDC token never installs a dependency.
//
//   node scripts/release.mjs pack <dir>   tarball every package whose version is not on npm
//   node scripts/release.mjs stage <dir>  npm stage publish each tarball, print what was staged
//   node scripts/release.mjs tags         hand the staged versions to changesets/action for tags
import { execFileSync } from "node:child_process"
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const [command, dir] = process.argv.slice(2)

const npm = (args, options = {}) => execFileSync("npm", args, { encoding: "utf8", ...options })

function published(name, version) {
  try {
    return npm(["view", `${name}@${version}`, "version"], { stdio: ["ignore", "pipe", "ignore"] }).trim() !== ""
  } catch {
    // A package npm has never seen answers E404.
    return false
  }
}

if (command === "pack") {
  mkdirSync(dir, { recursive: true })
  const manifest = []
  for (const entry of readdirSync(join(root, "packages"))) {
    const cwd = join(root, "packages", entry)
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"))
    if (pkg.private || published(pkg.name, pkg.version)) continue
    const [{ filename }] = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", resolve(dir)], { cwd }))
    manifest.push({ name: pkg.name, version: pkg.version, file: filename })
    console.log(`packed ${pkg.name}@${pkg.version}`)
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
} else if (command === "stage") {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
  const staged = []
  for (const { name, version, file } of manifest) {
    try {
      npm(["stage", "publish", join(resolve(dir), file), "--provenance"], { stdio: ["ignore", "inherit", "pipe"] })
      staged.push({ name, version })
      console.log(`staged ${name}@${version}`)
    } catch (error) {
      const stderr = String(error.stderr ?? "")
      process.stderr.write(stderr)
      // A rerun, or a later push to main before the version was approved.
      if (/already (been )?staged|already exists|E409/i.test(stderr)) {
        console.log(`${name}@${version} is already staged, skipping`)
        continue
      }
      throw error
    }
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `staged=${JSON.stringify(staged)}\n`)
} else if (command === "tags") {
  // changesets/action reads git-tag events from this file to push tags and create GitHub releases.
  const staged = JSON.parse(process.env.STAGED || "[]")
  const output = process.env.CHANGESETS_OUTPUT
  for (const { name, version } of staged) {
    const line = JSON.stringify({ type: "git-tag", tag: `${name}@${version}`, packageName: name })
    if (output) appendFileSync(output, line + "\n")
    console.log(`tag ${name}@${version}`)
  }
  if (output && staged.length === 0) appendFileSync(output, "")
} else {
  console.error("usage: node scripts/release.mjs pack <dir> | stage <dir> | tags")
  process.exit(1)
}
