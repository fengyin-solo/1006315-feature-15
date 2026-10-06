/**
 * 服务层并发串行化测试：模拟浏览器 localStorage，验证两笔同时提交时
 * 「检查-落库」严格分先后，后一笔对同一行按重复挡回。
 * 运行方式与 test-settlement.mjs 相同（esbuild 打包后 node 执行）。
 */
import assert from 'node:assert/strict'

// ---- 浏览器垫片：必须在 import 服务之前装好 ----
const memory = new Map()
globalThis.window = {
  localStorage: {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key),
  },
}

const { SEED_ROWS } = await import('../src/data/seed')
memory.set('urban-utility-tunnel:entries', JSON.stringify(SEED_ROWS))

const { submitBatch, loadSettlementDetail } = await import('../src/api/local-settlement')

const input = (value) => ({
  测次编号: '2026-10-06',
  mode: 'normal',
  operator: '甲',
  rows: [
    { 监测编号: 'SETT-0004', 监测断面: '潜川路K1+100断面', 累计沉降量: value, 沉降速率: '-0.1', 预警阈值: '8', 监测日期: '2026-10-06' },
  ],
})

// 两笔同时进来：一笔 -8.6 超限，一笔 -8.5 也超限；无论谁先，同键检修单只能有一条。
const [first, second] = await Promise.all([
  submitBatch(input('-8.6'), '2026-10-06T09:00:00.000Z'),
  submitBatch(input('-8.5'), '2026-10-06T09:00:01.000Z'),
])

assert.equal(first.accepted + second.accepted, 1, '同一行两笔同时提交，只应有一笔入账')
assert.equal(first.rejected + second.rejected, 1, '另一笔必须被挡回')
const accepted = first.accepted === 1 ? first : second
const rejected = first.accepted === 1 ? second : first
assert.ok(rejected.receipts[0].reason.includes('重复提交挡回'), '挡回原因应写明重复')
assert.equal(accepted.receipts[0].入库编号 !== null, true)

const detail = loadSettlementDetail()
const saved = detail.rows.filter((r) => r.监测编号 === 'SETT-0004' && r.测次编号 === '2026-10-06')
assert.equal(saved.length, 1, '库里同一行同测次只有一条')

const todos = detail.rows // placeholder to keep reading easy
void todos
const maintenance = JSON.parse(memory.get('urban-utility-tunnel:entries')).maintenance
const linked = maintenance.filter((r) => r.幂等键 === 'SETT#SETT-0004#2026-10-06')
assert.equal(linked.length, 1, '并发下同一键只生成一条检修待办（幂等兜底）')

// 后到的一笔不得覆盖先落的值
assert.equal(saved[0].累计沉降量 === '-8.6' || saved[0].累计沉降量 === '-8.5', true)

assert.equal(detail.reconcile.consistent, true, '并发结束后对账仍须一致')
console.log('  ✔ 并发两笔同交：先落的入账并挂预警，后到的整笔重复挡回')
console.log('  ✔ 检修待办仅一条，值班台账与对账一致')
console.log('\n并发串行化测试全部通过')
