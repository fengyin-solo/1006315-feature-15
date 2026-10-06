/**
 * 结构沉降整组处理的本地服务：页面只调这里，领域判定在 data/settlement.ts。
 *
 * 串行化：浏览器里没有数据库行锁，用一个进程内 Promise 队列把「检查-落库」串成
 * 原子段，两笔提交同时进来时一定有先后，后一笔查得到先一笔的数据，按重复挡回。
 * 每笔提交在内存草稿上改，全部判定通过才一次性写回 localStorage——即“检查通过才落库”。
 */
import {
  BACKFILL_BATCH_PREFIX,
  MAINTENANCE_CATEGORY,
  backfillPoints,
  checkBatch,
  isOverLimit,
  reconcile,
  submitSettlementBatch,
  summarizeRounds,
  SWITCH_DATE,
} from '@/data/settlement'
import type {
  MissingItem,
  PointBackfillResult,
  ReconcileReport,
  RoundSummary,
  SettlementBatchInput,
  SettlementBatchResult,
  SettlementObservationInput,
  SettlementPointInput,
  SettlementState,
} from '@/data/settlement'
import { listCollection, listRows, saveCollection, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

function snapshotState(): SettlementState {
  // 深拷贝：在草稿上完成整组判定，通过后一次性写回，保证“检查通过才落库”的交易边界。
  return JSON.parse(
    JSON.stringify({
      settlement: listRows('settlement'),
      settlementPoints: listCollection<EntryRow>('settlementPoints'),
      maintenance: listRows('maintenance'),
      duty: listRows('duty'),
      settlementMissing: listCollection<MissingItem>('settlementMissing'),
    }),
  ) as SettlementState
}

function commitState(state: SettlementState): void {
  saveRows('settlement', state.settlement)
  saveCollection('settlementPoints', state.settlementPoints)
  saveRows('maintenance', state.maintenance)
  saveRows('duty', state.duty)
  saveCollection('settlementMissing', state.settlementMissing)
}

// 提交队列：同一时刻只允许一笔整组提交在「检查-落库」段内。
let chain: Promise<unknown> = Promise.resolve()

function serialize<T>(task: () => T): Promise<T> {
  const run = chain.then(() => task())
  // 队列本身不能因为某笔失败而断掉：吞掉任务拒绝，结果通过 run 自己还给调用方。
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export type SettlementDetail = {
  rows: EntryRow[]
  points: EntryRow[]
  missing: MissingItem[]
  rounds: RoundSummary[]
  reconcile: ReconcileReport
}

export function loadSettlementDetail(): SettlementDetail {
  const state = snapshotState()
  return {
    rows: state.settlement,
    points: state.settlementPoints,
    missing: state.settlementMissing,
    rounds: summarizeRounds(state.settlement),
    reconcile: reconcile(state),
  }
}

export function previewBatch(input: SettlementBatchInput) {
  return checkBatch(input, snapshotState())
}

export async function submitBatch(
  input: SettlementBatchInput,
  stamp = new Date().toISOString(),
): Promise<SettlementBatchResult> {
  return serialize(() => {
    const state = snapshotState()
    const result = submitSettlementBatch(input, state, stamp)
    // 预检不通过时领域层不会改任何状态，commit 也无副作用；通过才真正写回。
    if (result.committed) commitState(state)
    return result
  })
}

export async function submitPointBackfill(
  rows: SettlementPointInput[],
  operator: string,
  stamp = new Date().toISOString(),
): Promise<PointBackfillResult> {
  return serialize(() => {
    const state = snapshotState()
    const result = backfillPoints(rows, state, stamp, operator)
    if (result.committed) commitState(state)
    return result
  })
}

/** 待补清单条目补录完成：只改状态，不改历史结论。 */
export function resolveMissing(id: number): { ok: boolean; message: string } {
  const missing = listCollection<MissingItem>('settlementMissing')
  const index = missing.findIndex((item) => item.id === id)
  if (index < 0) return { ok: false, message: `待补清单第 ${id} 项不存在` }
  if (missing[index].状态 === '已补录') return { ok: false, message: '该项已经补录过了' }
  missing[index] = { ...missing[index], 状态: '已补录' }
  saveCollection('settlementMissing', missing)
  return { ok: true, message: `待补项 ${missing[index].监测编号}（${missing[index].缺失项}）已标记补录` }
}

export function runReconcile(): ReconcileReport {
  return reconcile(snapshotState())
}

// ---------- 台账侧视图：检修清单里由沉降预警排进来的「待安排」 ----------

export function settlementWaitingTodos(): EntryRow[] {
  return listRows('maintenance').filter(
    (row) => String(row.检修类别 ?? '') === MAINTENANCE_CATEGORY && String(row.status ?? '') === '待安排',
  )
}

export { SWITCH_DATE, BACKFILL_BATCH_PREFIX }

// ---------- CSV 粘贴/文件解析（测绘队给的表直接粘进来）----------

const OBSERVATION_HEADERS: Record<string, keyof SettlementObservationInput> = {
  监测编号: '监测编号',
  点号: '监测编号',
  监测断面: '监测断面',
  断面: '监测断面',
  累计沉降量: '累计沉降量',
  沉降量: '累计沉降量',
  沉降速率: '沉降速率',
  速率: '沉降速率',
  预警阈值: '预警阈值',
  阈值: '预警阈值',
  监测日期: '监测日期',
  观测日期: '监测日期',
  监测人员: '监测人员',
  观测人员: '监测人员',
  原结论: '原结论',
  历史结论: '原结论',
}

const POINT_HEADERS: Record<string, keyof SettlementPointInput> = {
  监测编号: '监测编号',
  点号: '监测编号',
  监测断面: '监测断面',
  断面: '监测断面',
  所属舱室: '所属舱室',
  舱室: '所属舱室',
  投运日期: '投运日期',
  预警阈值: '预警阈值',
  阈值: '预警阈值',
}

function splitCsvLine(line: string): string[] {
  // 支持逗号/制表符分隔与引号包裹；测绘队的表从 Excel 复制时多为制表符。
  const cells: string[] = []
  let current = ''
  let quoted = false
  const text = line.includes('\t') && !line.includes(',') ? line.replace(/\t/g, ',') : line
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        current += '"'
        i += 1
      } else {
        quoted = !quoted
      }
    } else if (char === ',' && !quoted) {
      cells.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current.trim())
  return cells
}

type ParseOutcome<T> = { ok: true; rows: T[]; message: string } | { ok: false; rows: T[]; message: string }

function parseDelimited<T extends object>(
  text: string,
  headerMap: Record<string, keyof T>,
  build: (record: Partial<Record<keyof T, string>>) => T,
): ParseOutcome<T> {
  const lines = text.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length < 2) {
    return { ok: false, rows: [], message: '内容至少要含表头行和一行数据（可用逗号或制表符分隔）' }
  }
  const headers = splitCsvLine(lines[0])
  const indices: { column: keyof T; index: number }[] = []
  headers.forEach((header, index) => {
    const column = headerMap[header]
    if (column) indices.push({ column, index })
  })
  if (!indices.some((item) => item.column === '监测编号')) {
    return { ok: false, rows: [], message: '表头里找不到「监测编号」列，请按模板表头粘贴' }
  }
  const rows = lines.slice(1).map((line) => {
    const cells = splitCsvLine(line)
    const record: Partial<Record<keyof T, string>> = {}
    for (const { column, index } of indices) {
      record[column] = cells[index] ?? ''
    }
    return build(record)
  })
  return { ok: true, rows, message: `已识别 ${rows.length} 行，列映射：${indices.map((i) => String(i.column)).join('、')}` }
}

export function parseObservations(text: string): ParseOutcome<SettlementObservationInput> {
  return parseDelimited(text, OBSERVATION_HEADERS, (record) => ({
    监测编号: String(record.监测编号 ?? ''),
    监测断面: String(record.监测断面 ?? ''),
    累计沉降量: String(record.累计沉降量 ?? ''),
    沉降速率: String(record.沉降速率 ?? ''),
    预警阈值: String(record.预警阈值 ?? ''),
    监测日期: String(record.监测日期 ?? ''),
    监测人员: String(record.监测人员 ?? ''),
    原结论: String(record.原结论 ?? ''),
  }))
}

export function parsePoints(text: string): ParseOutcome<SettlementPointInput> {
  return parseDelimited(text, POINT_HEADERS, (record) => ({
    监测编号: String(record.监测编号 ?? ''),
    监测断面: String(record.监测断面 ?? ''),
    所属舱室: String(record.所属舱室 ?? ''),
    投运日期: String(record.投运日期 ?? ''),
    预警阈值: String(record.预警阈值 ?? ''),
  }))
}

export const OBSERVATION_CSV_TEMPLATE =
  '监测编号,监测断面,累计沉降量,沉降速率,预警阈值,监测日期,监测人员,原结论\n'

export const POINT_CSV_TEMPLATE =
  '监测编号,监测断面,所属舱室,投运日期,预警阈值\n'

// ---------- 报表导出：汇总（按测次）与明细（逐条）同一数据源，读数必然一致 ----------

export function exportSettlementRoundReport(): { filename: string; content: string } {
  const state = snapshotState()
  const rounds = summarizeRounds(state.settlement)
  const lines = [
    '测次编号,断面数,沉降正常,超限预警,待监测/监测中,其他,最早监测日期,入库批次',
  ]
  for (const round of rounds) {
    lines.push([
      round.测次编号,
      round.断面数,
      round.正常,
      round.超限,
      round.待监测,
      round.其他,
      round.最早监测日期,
      round.批次号,
    ].join(','))
  }
  // 报表末尾附对账行：打开 CSV 就能和值班台账核。
  const report = reconcile(state)
  lines.push('')
  lines.push(`对账,预警断面总数,${report.检修预警总数},检修待安排,${report.检修待安排数},台账登记,${report.台账检修待办登记数},一致,${report.检修对账一致 ? '是' : '否'}`)
  lines.push(`对账,资料待补总数,${report.资料待补总数},待补录,${report.资料待补待录数},台账登记,${report.台账资料待补登记数},一致,${report.资料对账一致 ? '是' : '否'}`)
  return { filename: '结构沉降-测次汇总报表.csv', content: `﻿${lines.join('\n')}` }
}

export function exportSettlementDetailReport(): { filename: string; content: string } {
  const rows = listRows('settlement')
  const header = ['监测编号', '监测断面', '测次编号', '累计沉降量', '沉降速率', '预警阈值', '监测日期', '监测人员', '监测状态', '口径', '批次号']
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push(header.map((field) => String(row[field] ?? '—')).join(','))
  }
  return { filename: '结构沉降-观测明细报表.csv', content: `﻿${lines.join('\n')}` }
}

export function downloadCsv(file: { filename: string; content: string }): void {
  const blob = new Blob([file.content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

// 供页面快速判定/演示用：不改数据。
export function previewOverLimit(累计沉降量: string, 预警阈值: string): boolean {
  return isOverLimit(累计沉降量, 预警阈值)
}
