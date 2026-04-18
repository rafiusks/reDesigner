import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import _generate from '@babel/generator'
import * as parser from '@babel/parser'
import _traverse from '@babel/traverse'
import { describe, expect, it } from 'vitest'
import { redesignerBabelPlugin } from '../../src/babel/plugin'
import type { PerFileBatch } from '../../src/core/types-internal'

// CJS interop: @babel/traverse and @babel/generator expose .default.default in ESM
const traverse = (_traverse as unknown as { default: typeof _traverse }).default ?? _traverse
const generate = (_generate as unknown as { default: typeof _generate }).default ?? _generate

const ROOT = import.meta.dirname
const UPDATE = process.env.REDESIGNER_FIXTURE_UPDATE === '1'

async function listFixtures(): Promise<string[]> {
  const dirs = await readdir(ROOT, { withFileTypes: true })
  return dirs.filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name)
}

async function runFixture(name: string): Promise<{ code: string; batch: PerFileBatch }> {
  const dir = path.join(ROOT, name)
  const input = await readFile(path.join(dir, 'input.tsx'), 'utf8')
  const ast = parser.parse(input, { sourceType: 'module', plugins: ['jsx', 'typescript'] })
  const batch: PerFileBatch = { filePath: 'src/input.tsx', components: {}, locs: {} }
  const plugin = redesignerBabelPlugin({ relPath: 'src/input.tsx', batch })
  traverse(ast, plugin.visitor)
  const { code } = generate(ast, { retainLines: true })
  return { code, batch }
}

describe('fixture runner', async () => {
  const fixtures = await listFixtures()
  for (const name of fixtures) {
    it(name, async () => {
      const dir = path.join(ROOT, name)
      const { code, batch } = await runFixture(name)
      const expectedOutput = await readFile(path.join(dir, 'output.tsx'), 'utf8').catch(() => '')
      const expectedManifest = JSON.parse(
        await readFile(path.join(dir, 'expected-manifest.json'), 'utf8').catch(() => '{}'),
      )
      if (UPDATE) {
        await writeFile(path.join(dir, 'output.tsx'), code)
        await writeFile(
          path.join(dir, 'expected-manifest.json'),
          `${JSON.stringify(batch, null, 2)}\n`,
        )
        return
      }
      expect(code.trim()).toBe(expectedOutput.trim())
      expect(batch).toEqual(expectedManifest)
    })
  }
})
