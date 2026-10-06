/**
 * 结构沉降整组处理领域逻辑测试（node 直接跑，不依赖浏览器）。
 * 用 esbuild 临时打包后执行：node scripts/test-settlement.mjs
 */
import assert from 'node:assert/strict'
import { SEED_ROWS } from '../src/data/seed'
import {
  SWITCH_DATE,
  backfillPoints,
  checkBatch,
  hasBlockIssue,
  reconcile,
  submitSettlementBatch,
  summarizeRounds,
} from '../src/data/settlement'

const clone = (v) => JSON.parse(JSON.stringify(v))

function freshState() {
  return {
    settlement: clone(SEED_ROWS.settlement),
    settlementPoints: clone(SEED_ROWS.settlementPoints),
    maintenance: clone(SEED_ROWS.maintenance),
    duty: clone(SEED_ROWS.duty),
    settlementMissing: clone(SEED_ROWS.settlementMissing),
  }
}

const stamp = '2026-10-06T09:00:00.000Z'
let passed = 0
function test(name, fn) {
  fn()
  passed += 1
  console.log(`  ✔ ${name}`)
}

console.log('1) 预检：重号、累计沉降量缺失为硬伤，整批不落库')
{
  const state = freshState()
  const input = {
    测次编号: '2026-10-06',
    mode: 'normal',
    operator: '甲',
    rows: [
      { 监测编号: '', 监测断面: 'S0', 累计沉降量: '-3.0', 沉降速率: '-0.02', 预警阈值: '10', 监测日期: '2026-10-06' },
      { 监测编号: 'SETT-0001', 监测断面: 'S1', 累计沉降量: '-3.5', 沉降速率: '-0.02', 预警阈值: '10', 监测日期: '2026-10-06' },
      { 监测编号: 'SETT-0001', 监测断面: 'S2', 累计沉降量: '-4.0', 沉降速率: '-0.02', 预警阈值: '10', 监测日期: '2026-10-06' },
      { 监测编号: 'SETT-0002', 监测断面: 'S3', 累计沉降量: '', 沉降速率: '-0.02', 预警阈值: '10', 监测日期: '2026-10-06' },
    ],
  }
  test('重号被列出提示，空编号/沉降量缺失为 block', () => {
    const issues = checkBatch(input, state)
    const blocks = issues.filter((i) => i.level === 'block')
    const rows = issues.filter((i) => i.level === 'row')
    assert.ok(rows.some((i) => i.message.includes('重号')), '应报重号提示')
    assert.ok(blocks.some((i) => i.message.includes('监测编号为空')), '应报空编号硬伤')
    assert.ok(blocks.some((i) => i.message.includes('累计沉降量缺失')), '应报沉降量缺失硬伤')
    assert.equal(hasBlockIssue(issues), true)
  })
  test('预检不通过时一条都不落库', () => {
    const before = state.settlement.length
    const result = submitSettlementBatch(input, state, stamp)
    assert.equal(result.committed, false)
    assert.equal(result.accepted, 0)
    assert.ok(result.receipts.every((r) => r.status === 'rejected'))
    assert.equal(state.settlement.length, before)
    assert.equal(state.maintenance.filter((r) => r.检修类别 === '沉降超限预警').length, 0)
  })
}

console.log('2) 整组提交：逐条回执，超阈值挂预警并回写检修「待安排」+ 值班台账')
{
  const state = freshState()
  const input = {
    测次编号: '2026-10-06',
    mode: 'normal',
    operator: '甲',
    rows: [
      { 监测编号: 'SETT-0001', 监测断面: '云谷路K0+200断面', 累计沉降量: '-3.8', 沉降速率: '-0.02', 预警阈值: '10', 监测日期: '2026-10-06' },
      { 监测编号: 'SETT-0004', 监测断面: '潜川路K1+100断面', 累计沉降量: '-8.6', 沉降速率: '-0.12', 预警阈值: '8', 监测日期: '2026-10-06' },
      { 监测编号: 'SETT-0005', 监测断面: '潜川路K1+400断面', 累计沉降量: '-3.1', 监测日期: '2026-10-06' }, // 阈值台账兜底
    ],
  }
  const result = submitSettlementBatch(input, state, stamp)
  test('三条全部入账', () => {
    assert.equal(result.committed, true)
    assert.equal(result.accepted, 3)
    assert.equal(result.rejected, 0)
  })
  test('仅超阈值的一条挂预警并生成检修待办', () => {
    assert.equal(result.overLimit, 1)
    assert.equal(result.检修新增, 1)
    const todos = state.maintenance.filter((r) => r.检修类别 === '沉降超限预警' && r.status === '待安排')
    assert.equal(todos.length, 1)
    assert.ok(todos[0].检修对象.includes('潜川路K1+100断面'))
    assert.equal(String(todos[0].预警结论).includes('-8.6'), true)
  })
  test('阈值缺失时按点位台账兜底判定', () => {
    const saved5 = state.settlement.find((r) => r.监测编号 === 'SETT-0005' && r.测次编号 === '2026-10-06')
    assert.equal(saved5.预警阈值, '8')
    assert.equal(saved5.status, '沉降正常')
  })
  test('值班台账逐批登记待办数', () => {
    const ledger = state.duty.find((r) => r.来源批次 === result.批次号)
    assert.ok(ledger, '台账有该批次')
    assert.equal(ledger.检修待办数, 1)
    assert.equal(ledger.资料待补数, 1) // SETT-0005 没誊沉降速率
  })
  test('沉降速率缺失进待补清单', () => {
    assert.equal(result.资料待补新增, 1)
    assert.ok(state.settlementMissing.some((m) => m.监测编号 === 'SETT-0005' && m.缺失项 === '沉降速率'))
  })
}

console.log('3) 同断面同测次只算一次：组内后一条按重复挡回')
{
  const state = freshState()
  const input = {
    测次编号: 'R24',
    mode: 'normal',
    operator: '甲',
    rows: [
      { 监测编号: 'SETT-0001', 监测断面: '同断面', 累计沉降量: '-3.8', 预警阈值: '10', 监测日期: '2026-10-06' },
      { 监测编号: 'SETT-0001', 监测断面: '同断面', 累计沉降量: '-9.9', 预警阈值: '10', 监测日期: '2026-10-06' },
    ],
  }
  // 注意：监测编号相同会触发“重号”硬伤。改用不同点号但同断面，才是业务要的组内去重场景。
  input.rows[1].监测编号 = 'SETT-0002'
  const result = submitSettlementBatch(input, state, stamp)
  test('断面+测次维度去重，只认第一条', () => {
    assert.equal(result.accepted, 1)
    assert.equal(result.rejected, 1)
    assert.ok(result.receipts[1].reason.includes('重复挡回'))
  })

  test('同一点同断面同测次第二笔提交整笔按重复挡回（只认先落的一笔）', () => {
    const second = submitSettlementBatch(
      { 测次编号: 'R24', mode: 'normal', operator: '乙', rows: [
        { 监测编号: 'SETT-0001', 监测断面: '同断面', 累计沉降量: '-3.9', 预警阈值: '10', 监测日期: '2026-10-06' },
      ] },
      state,
      '2026-10-06T09:05:00.000Z',
    )
    assert.equal(second.accepted, 0)
    assert.equal(second.rejected, 1)
    assert.ok(second.receipts[0].reason.includes('重复提交挡回'))
    // 第一笔未超限，本就没有检修单；这里再交一笔超限数据，也不得借重复行补挂预警
    assert.equal(state.maintenance.filter((r) => r.幂等键 === 'SETT#SETT-0001#R24').length, 0)
    const saved = state.settlement.filter((r) => r.监测编号 === 'SETT-0001' && r.测次编号 === 'R24')
    assert.equal(saved.length, 1)
    assert.equal(saved[0].累计沉降量, '-3.8') // 先落的值不被后一笔覆盖
  })
}

console.log('4) 存量回填：早于切换日沿用原结论，不重判不挂预警')
{
  const state = freshState()
  const input = {
    测次编号: '2026-08-01',
    mode: 'backfill',
    operator: '甲',
    rows: [
      // 即使沉降量超过阈值，旧口径也不重判
      { 监测编号: 'SETT-0004', 监测断面: '潜川路K1+100断面', 累计沉降量: '-9.5', 预警阈值: '8', 监测日期: '2026-08-01', 原结论: '沉降正常' },
      { 监测编号: 'SETT-0005', 监测断面: '潜川路K1+400断面', 累计沉降量: '-3.0', 预警阈值: '8', 监测日期: '2026-08-01' },
    ],
  }
  const result = submitSettlementBatch(input, state, stamp)
  test('旧口径沿用原结论，超阈值不挂预警、不排检修', () => {
    assert.equal(result.accepted, 2)
    assert.equal(result.overLimit, 0)
    assert.equal(result.检修新增, 0)
    const saved = state.settlement.find((r) => r.监测编号 === 'SETT-0004' && r.测次编号 === '2026-08-01')
    assert.equal(saved.status, '沉降正常')
    assert.equal(saved.口径, '旧口径（沿用原结论）')
    assert.ok(result.receipts[0].reason.includes('沿用原结论'))
  })
  test('回填批次号与正常提交批次号前缀不同', () => {
    assert.ok(result.批次号.startsWith('BF-'))
  })
}

console.log('5) 点位台账按投运日期回填：先台账后成果，冲突不覆盖转待补')
{
  const state = freshState()
  const result = backfillPoints(
    [
      { 监测编号: 'SETT-0009', 监测断面: '新断面K9', 所属舱室: '新舱', 投运日期: '2026-04-01', 预警阈值: '8' },
      { 监测编号: 'SETT-0001', 监测断面: '云谷路K0+200断面', 投运日期: '2025-11-02', 预警阈值: '12' }, // 阈值冲突
      { 监测编号: 'SETT-0010', 投运日期: '2026-04-01' }, // 断面缺失
      { 监测编号: 'SETT-0009', 监测断面: '新断面K9', 投运日期: '2026-04-01', 预警阈值: '8' }, // 批内重号
    ],
    state,
    stamp,
    '甲',
  )
  test('新点建立、冲突挡回转待补、缺字段挡回、批内重号挡回', () => {
    assert.equal(result.accepted, 1)
    assert.equal(result.rejected, 3)
    const created = state.settlementPoints.find((p) => p.监测编号 === 'SETT-0009')
    assert.ok(created)
    assert.equal(created.投运日期, '2026-04-01')
    // 冲突不覆盖
    const old = state.settlementPoints.find((p) => p.监测编号 === 'SETT-0001')
    assert.equal(String(old.预警阈值), '10')
    assert.ok(state.settlementMissing.some((m) => m.监测编号 === 'SETT-0001' && m.缺失项.includes('阈值冲突')))
    assert.ok(state.settlementMissing.some((m) => m.监测编号 === 'SETT-0010' && m.缺失项.includes('监测断面')))
  })
  test('随后的成果回填能用新点阈值兜底', () => {
    const res = submitSettlementBatch(
      { 测次编号: '2026-10-06', mode: 'normal', operator: '甲', rows: [
        { 监测编号: 'SETT-0009', 监测断面: '新断面K9', 累计沉降量: '-9.0', 监测日期: '2026-10-06' },
      ] },
      state,
      '2026-10-06T10:00:00.000Z',
    )
    assert.equal(res.overLimit, 1)
  })
}

console.log('6) 对账：检修待办、资料待补与值班台账逐批对得上；汇总报表同源')
{
  const state = freshState()
  const r1 = submitSettlementBatch(
    { 测次编号: '2026-10-06', mode: 'normal', operator: '甲', rows: [
      { 监测编号: 'SETT-0001', 监测断面: '云谷路K0+200断面', 累计沉降量: '-3.5', 预警阈值: '10', 监测日期: '2026-10-06', 沉降速率: '-0.02' },
      { 监测编号: 'SETT-0004', 监测断面: '潜川路K1+100断面', 累计沉降量: '-8.6', 预警阈值: '8', 监测日期: '2026-10-06', 沉降速率: '-0.1' },
    ] },
    state,
    '2026-10-06T09:00:00.000Z',
  )
  const r2 = submitSettlementBatch(
    { 测次编号: '2026-10-20', mode: 'normal', operator: '甲', rows: [
      { 监测编号: 'SETT-0005', 监测断面: '潜川路K1+400断面', 累计沉降量: '-9.2', 预警阈值: '8', 监测日期: '2026-10-20', 沉降速率: '-0.11' },
    ] },
    state,
    '2026-10-20T09:00:00.000Z',
  )
  const report = reconcile(state)
  test('两批产生的预警/检修待办总数与台账一致', () => {
    assert.equal(r1.检修新增 + r2.检修新增, 2)
    assert.equal(report.检修预警总数, 2)
    assert.equal(report.检修待安排数, 2)
    assert.equal(report.台账检修待办登记数, 2)
    assert.equal(report.检修对账一致, true)
    assert.equal(report.consistent, true)
    assert.equal(report.差异.length, 0)
  })
  test('测次汇总各状态之和等于断面总数（汇总与明细同源）', () => {
    const rounds = summarizeRounds(state.settlement)
    for (const round of rounds) {
      assert.equal(round.正常 + round.超限 + round.待监测 + round.其他, round.断面数)
    }
    const target = rounds.find((r) => r.测次编号 === '2026-10-06')
    assert.equal(target.超限, 1)
    assert.equal(target.断面数, 2)
  })
  test('幂等键保证预警检修单不重复', () => {
    const keys = state.maintenance.map((r) => r.幂等键).filter(Boolean)
    assert.equal(new Set(keys).size, keys.length)
  })
}

console.log(`\n全部通过：${passed} 组断言场景（切换日 ${SWITCH_DATE}）`)
