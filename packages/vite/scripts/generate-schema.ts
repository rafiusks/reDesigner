import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createGenerator } from 'ts-json-schema-generator'

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, 'dist')
mkdirSync(outDir, { recursive: true })

const gen = createGenerator({
  path: path.join(root, 'src/core/manifestSchema.ts'),
  tsconfig: path.join(root, 'tsconfig.json'),
  type: 'Manifest',
})
const schema = gen.createSchema('Manifest')
const outPath = path.join(outDir, 'manifest-schema.json')
writeFileSync(outPath, `${JSON.stringify(schema, null, 2)}\n`)
console.log(`generated ${path.relative(root, outPath)}`)
