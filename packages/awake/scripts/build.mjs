import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { transformAsync } from "@babel/core"
import typescript from "@babel/preset-typescript"

const root = resolve(import.meta.dirname, "..")
for (const module of ["index.ts", "awake.ts"]) {
  const input = resolve(root, "src", module)
  const output = resolve(root, "dist", module.replace(/\.ts$/, ".js"))
  const result = await transformAsync(await readFile(input, "utf8"), {
    filename: input,
    configFile: false,
    babelrc: false,
    presets: [[typescript, { onlyRemoveTypeImports: true }]],
  })
  if (!result?.code) throw new Error(`babel produced no output for ${module}`)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, result.code + "\n")
}
