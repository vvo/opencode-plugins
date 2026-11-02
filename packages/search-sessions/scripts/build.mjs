import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { transformAsync } from "@babel/core"
import typescript from "@babel/preset-typescript"
import solid from "babel-preset-solid"

const root = resolve(import.meta.dirname, "..")
// dist/worker.js runs in its own thread and imports the engine, so every module ships.
for (const module of ["index.ts", "tui.tsx", "query.ts", "sqlite.ts", "engine.ts", "worker.ts", "client.ts"]) {
  const input = resolve(root, "src", module)
  const output = resolve(root, "dist", module.replace(/\.tsx?$/, ".js"))
  const presets = [[typescript]]
  if (module.endsWith(".tsx")) presets.unshift([solid, { moduleName: "@opentui/solid", generate: "universal" }])
  const result = await transformAsync(await readFile(input, "utf8"), {
    filename: input,
    configFile: false,
    babelrc: false,
    presets,
  })
  if (!result?.code) throw new Error(`babel produced no output for ${module}`)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, result.code + "\n")
}
