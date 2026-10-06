/**
 * 用仓库里已有的 esbuild 把 TS 领域逻辑/服务层测试临时打包成 node 可执行文件再跑，
 * 不引入额外测试框架依赖。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = resolve(root, 'node_modules/.tmp')
existsSync(outDir) || mkdirSync(outDir, { recursive: true })

const { build } = await import('esbuild')

const cases = [
  { entry: 'scripts/test-settlement.mjs', outfile: `${outDir}/test-settlement.cjs`, format: 'cjs' },
  { entry: 'scripts/test-concurrent.mjs', outfile: `${outDir}/test-concurrent.mjs`, format: 'esm' },
]

for (const test of cases) {
  await build({
    entryPoints: [resolve(root, test.entry)],
    bundle: true,
    platform: 'node',
    format: test.format,
    outfile: test.outfile,
    alias: { '@': resolve(root, 'src') },
    logLevel: 'silent',
  })
  console.log(`\n=== ${test.entry} ===`)
  await import(`file://${test.outfile}`)
}
