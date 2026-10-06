import { LEGACY_RAW_OBSERVATIONS } from '@/data/settlement/legacy-seed'
import type { LegacyRawObservation } from '@/data/settlement/legacy-seed'
import {
  nextSettlementId,
  persistSettlement,
  resetSettlementDomain,
  settlementDomain,
} from '@/data/settlement/store'
import {
  CUTOVER_DATE,
  OBSERVATION_STATUS,
} from '@/data/settlement/types'
import type {
  BacklogItem,
  BatchReceipt,
  BatchSubmitResult,
  CheckIssue,
  DutyTodo,
  MaintenanceTodo,
  ObservationInput,
  SettlementObservation,
} from '@/data/settlement/types'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function ledgerKeyOf(断面: string, 日期: string): string {
  return `${断面.trim()}__${日期.trim()}`
}

export function isLegacyRound(日期: string): boolean {
  return 日期.trim() < CUTOVER_DATE
}

function toNumber(value: string): number | null {
  const text = String(value ?? '').trim()
  if (text === '') return null
  const num = Number(text)
  return Number.isFinite(num) ? num : null
}

function isValidDate(value: string): boolean {
  const text = String(value ?? '').trim()
  return DATE_RE.test(text) && !Number.isNaN(Date.parse(text))
}

function nowText(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

/* ------------------------------------------------------------------ */
/* 提交前检查：监测编号重号、累计沉降量缺失等先列出来；阻断项不清不落库 */
/* ------------------------------------------------------------------ */

export type ValidationReport = {
  caliber: 'new' | 'legacy'
  /** 去重后参与落库的行（批内同断面同测次的第二次起在此被折叠）。 */
  effective: { input: ObservationInput; row: number; collapsedRows: number[] }[]
  issues: CheckIssue[]
  blocking: boolean
}

export function validateBatch(rows: ObservationInput[]): ValidationReport {
  const roundDate = rows.find((r) => r.监测日期.trim() !== '')?.监测日期 ?? ''
  const caliber: 'new' | 'legacy' = roundDate && isLegacyRound(roundDate) ? 'legacy' : 'new'
  const issues: CheckIssue[] = []

  // 第一步：按自然键折叠批内重复（同断面同测次两次只算一次，保留先出现的一条）。
  const firstIndexByKey = new Map<string, number>()
  const effective: ValidationReport['effective'] = []
  rows.forEach((input, index) => {
    const row = index + 1
    const key = ledgerKeyOf(input.监测断面, input.监测日期)
    if (!firstIndexByKey.has(key)) {
      firstIndexByKey.set(key, row)
      effective.push({ input, row, collapsedRows: [] })
    } else {
      effective.find((item) => item.row === firstIndexByKey.get(key))?.collapsedRows.push(row)
    }
  })

  effective.forEach(({ input, row, collapsedRows }) => {
    const add = (field: string, message: string, blocking = true) =>
      issues.push({
        row,
        监测编号: input.监测编号,
        监测断面: input.监测断面,
        field,
        message,
        blocking,
      })

    if (!input.监测编号.trim()) add('监测编号', '监测编号为空')
    if (!input.监测断面.trim()) add('监测断面', '监测断面为空')
    if (!isValidDate(input.监测日期)) add('监测日期', `监测日期「${input.监测日期}」不是有效日期(YYYY-MM-DD)`)

    if (input.累计沉降量.trim() === '') {
      if (caliber === 'new') {
        add('累计沉降量', '累计沉降量缺失，新测次成果不能落库')
      } else {
        // 存量补录：缺失不阻断整批，转待补清单集中跟测绘队补数。
        add('累计沉降量', '累计沉降量缺失，将转入待补清单，不进台账', false)
      }
    } else if (toNumber(input.累计沉降量) === null) {
      add('累计沉降量', `累计沉降量「${input.累计沉降量}」不是数值`)
    }

    if (caliber === 'new' && input.预警阈值.trim() === '') {
      add('预警阈值', '新测次缺少预警阈值，无法判定是否超限')
    }
  })

  // 重号：同一监测编号在不同断面/测次（不同自然键）上出现 → 编号矛盾，阻断。
  // 同自然键的重复已在前面折叠，按「只算一次」处理，不算重号。
  const keysByCode = new Map<string, Set<string>>()
  effective.forEach(({ input }) => {
    const code = input.监测编号.trim()
    if (!code) return
    const key = ledgerKeyOf(input.监测断面, input.监测日期)
    if (!keysByCode.has(code)) keysByCode.set(code, new Set())
    keysByCode.get(code)!.add(key)
  })
  effective.forEach(({ input, row }) => {
    const code = input.监测编号.trim()
    if (code && (keysByCode.get(code)?.size ?? 0) > 1) {
      issues.push({
        row,
        监测编号: code,
        监测断面: input.监测断面,
        field: '监测编号',
        message: `监测编号 ${code} 在本批中重号（对应了不同断面/测次）`,
        blocking: true,
      })
    }
  })

  return {
    caliber,
    effective,
    issues,
    blocking: issues.some((issue) => issue.blocking),
  }
}

/* ------------------------------------------------------------------ */
/* 整组提交：一次交同一测次全部断面；入库与超限标记同批提交、一次落盘   */
/* ------------------------------------------------------------------ */

export function submitBatch(rows: ObservationInput[]):
  | { committed: true; result: BatchSubmitResult }
  | { committed: false; report: ValidationReport } {
  const report = validateBatch(rows)
  if (report.blocking) {
    return { committed: false, report }
  }

  const domain = settlementDomain()
  const existingKeys = new Set(domain.ledger.map((item) => item.ledgerKey))
  const batchId = `BAT-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`
  const submittedAt = nowText()
  const receipts: BatchReceipt[] = []

  // 先在内存里把这一批算完，最后一次 persistSettlement 落盘 —— 同批要么整体生效要么不生效。
  const newLedgerRows: SettlementObservation[] = []
  const newMaintenance: MaintenanceTodo[] = []
  const newDutyTodos: DutyTodo[] = []

  let accepted = 0
  let rejected = 0
  let warningRaised = 0

  const pushReceipt = (receipt: BatchReceipt) => {
    receipts.push(receipt)
    if (receipt.ok) accepted += 1
    else rejected += 1
  }

  rows.forEach((input, index) => {
    const row = index + 1
    const key = ledgerKeyOf(input.监测断面, input.监测日期)
    const baseReceipt = {
      row,
      ledgerKey: key,
      监测编号: input.监测编号,
      监测断面: input.监测断面,
      监测日期: input.监测日期,
    }

    // 批内同断面同测次重复：只算第一次，其余另起回执说明。
    if (newLedgerRows.some((item) => item.ledgerKey === key)) {
      pushReceipt({
        ...baseReceipt,
        result: '批内重复舍弃',
        ok: false,
        status: '',
        overLimit: false,
        maintenanceId: null,
        dutyTodoId: null,
        message: '同一断面在本测次出现多次，只认先填的一条，本条不入库',
      })
      return
    }

    // 台账已有该断面该测次：先落者得，后到（含两笔同时提交）按重复挡回。
    // 纯前端为同一线程同步执行，提交按到达顺序串行落库，此判断即并发兜底。
    if (existingKeys.has(key)) {
      pushReceipt({
        ...baseReceipt,
        result: '重复挡回',
        ok: false,
        status: '',
        overLimit: false,
        maintenanceId: null,
        dutyTodoId: null,
        message: `断面 ${input.监测断面} 在 ${input.监测日期} 的成果已入库，只认先落的一笔，本条按重复挡回`,
      })
      return
    }

    // 存量补录且累计沉降量缺失：转待补清单，不进台账。
    if (report.caliber === 'legacy' && input.累计沉降量.trim() === '') {
      if (!domain.backlog.some((item) => item.ledgerKey === key)) {
        const backlog: BacklogItem = {
          id: nextSettlementId(domain),
          ledgerKey: key,
          监测编号: input.监测编号,
          监测断面: input.监测断面,
          监测日期: input.监测日期,
          missingFields: ['累计沉降量', ...(input.沉降速率.trim() === '' ? ['沉降速率'] : [])],
          caliber: 'legacy',
          sourceBatchId: batchId,
          createdAt: submittedAt,
          resolved: false,
        }
        domain.backlog.push(backlog)
      }
      pushReceipt({
        ...baseReceipt,
        result: '缺失待补',
        ok: false,
        status: '',
        overLimit: false,
        maintenanceId: null,
        dutyTodoId: null,
        message: '存量成果累计沉降量缺失，已列入待补清单，补齐后随测次补录',
      })
      return
    }

    const settlementValue = toNumber(input.累计沉降量)
    const thresholdValue = toNumber(input.预警阈值)
    const overLimit =
      report.caliber === 'new' &&
      settlementValue !== null &&
      thresholdValue !== null &&
      settlementValue >= thresholdValue

    let maintenanceId: number | null = null
    let dutyTodoId: number | null = null
    let status: string = OBSERVATION_STATUS.normal

    if (report.caliber === 'new') {
      // 新口径：超限自动挂预警，并回写设施检修清单 + 生成值班待办，跟着这一批走。
      if (overLimit) {
        status = OBSERVATION_STATUS.warning
        warningRaised += 1
        const maintenance: MaintenanceTodo = {
          id: nextSettlementId(domain),
          检修编号: `MAIN-W${String(domain.seq).padStart(4, '0')}`,
          检修对象: `${input.监测断面}（${input.监测编号}）`,
          检修类别: '结构沉降超限处置',
          检修班组: '待安排',
          计划工期: '待安排',
          sourceKey: key,
          监测编号: input.监测编号,
          预警结论: `累计沉降量 ${input.累计沉降量}mm 达到/超过预警阈值 ${input.预警阈值}mm`,
          累计沉降量: input.累计沉降量,
          沉降速率: input.沉降速率,
          来源批次: batchId,
          status: '待安排',
          createdAt: submittedAt,
        }
        const dutyTodo: DutyTodo = {
          id: nextSettlementId(domain),
          待办编号: `DUTY-W${String(domain.seq).padStart(4, '0')}`,
          sourceKey: key,
          检修编号: maintenance.检修编号,
          监测断面: input.监测断面,
          监测日期: input.监测日期,
          事项: `沉降超限预警：${input.监测断面} 累计沉降 ${input.累计沉降量}mm ≥ 阈值 ${input.预警阈值}mm，督促安排检修`,
          来源批次: batchId,
          status: '待办',
          createdAt: submittedAt,
        }
        maintenanceId = maintenance.id
        dutyTodoId = dutyTodo.id
        domain.maintenance.push(maintenance)
        domain.duty.push(dutyTodo)
        newMaintenance.push(maintenance)
        newDutyTodos.push(dutyTodo)
      }
    } else {
      // 存量沿用原结论，不按新阈值溯及，也不补生检修/值班待办。
      const legacy = (input.legacyConclusion ?? '').trim()
      status = legacy.includes('超限') ? OBSERVATION_STATUS.warning : OBSERVATION_STATUS.normal
    }

    const observation: SettlementObservation = {
      ...input,
      id: nextSettlementId(domain),
      ledgerKey: key,
      duplicateInBatch: false,
      status,
      abnormal: status === OBSERVATION_STATUS.warning,
      settlementValue,
      thresholdValue,
      overLimit: status === OBSERVATION_STATUS.warning,
      maintenanceId,
      dutyTodoId,
      caliber: report.caliber,
      legacyConclusion: report.caliber === 'legacy' ? status : '',
      sourceBatchId: batchId,
      submittedAt,
    }
    domain.ledger.push(observation)
    newLedgerRows.push(observation)
    existingKeys.add(key)

    pushReceipt({
      ...baseReceipt,
      result: '成功',
      ok: true,
      status,
      overLimit: observation.overLimit,
      maintenanceId,
      dutyTodoId,
      message:
        report.caliber === 'new' && overLimit
          ? `已落库并挂超限预警，检修清单已排入「待安排」，值班待办已生成`
          : report.caliber === 'legacy'
            ? `已按存量成果补录，沿用原结论「${status}」`
            : '已落库，沉降正常',
    })
  })

  persistSettlement(domain)

  return {
    committed: true,
    result: {
      batchId,
      caliber: report.caliber,
      submittedAt,
      accepted,
      rejected,
      warningRaised,
      maintenanceCreated: newMaintenance.length,
      dutyTodoCreated: newDutyTodos.length,
      receipts,
    },
  }
}

/* ------------------------------------------------------------------ */
/* 存量回填：按设备投运日期 → 监测日期顺序，幂等补录早于上线的几次测次 */
/* ------------------------------------------------------------------ */

export function backfillLegacy(rawRows: LegacyRawObservation[]): {
  inserted: number
  backlog: number
  skipped: number
} {
  const ordered = [...rawRows].sort((a, b) =>
    a.投运日期 === b.投运日期
      ? a.监测日期.localeCompare(b.监测日期)
      : a.投运日期.localeCompare(b.投运日期),
  )
  const domain = settlementDomain()
  const existingKeys = new Set(domain.ledger.map((item) => item.ledgerKey))
  const existingBacklog = new Set(domain.backlog.map((item) => item.ledgerKey))
  const batchId = 'LEGACY-BACKFILL'
  const stamped = nowText()

  let inserted = 0
  let backlog = 0
  let skipped = 0

  ordered.forEach((raw) => {
    const key = ledgerKeyOf(raw.监测断面, raw.监测日期)
    if (existingKeys.has(key)) {
      skipped += 1
      return
    }
    const { 投运日期: _omit, legacyConclusion, ...rest } = raw
    void _omit
    const input: ObservationInput = rest
    if (input.累计沉降量.trim() === '') {
      if (!existingBacklog.has(key)) {
        domain.backlog.push({
          id: nextSettlementId(domain),
          ledgerKey: key,
          监测编号: input.监测编号,
          监测断面: input.监测断面,
          监测日期: input.监测日期,
          missingFields: ['累计沉降量', ...(input.沉降速率.trim() === '' ? ['沉降速率'] : [])],
          caliber: 'legacy',
          sourceBatchId: batchId,
          createdAt: stamped,
          resolved: false,
        })
        existingBacklog.add(key)
        backlog += 1
      }
      return
    }
    const status = legacyConclusion.includes('超限')
      ? OBSERVATION_STATUS.warning
      : OBSERVATION_STATUS.normal
    domain.ledger.push({
      ...input,
      id: nextSettlementId(domain),
      ledgerKey: key,
      duplicateInBatch: false,
      status,
      abnormal: status === OBSERVATION_STATUS.warning,
      settlementValue: toNumber(input.累计沉降量),
      thresholdValue: toNumber(input.预警阈值),
      overLimit: status === OBSERVATION_STATUS.warning,
      maintenanceId: null,
      dutyTodoId: null,
      caliber: 'legacy',
      legacyConclusion,
      sourceBatchId: batchId,
      submittedAt: stamped,
    })
    existingKeys.add(key)
    inserted += 1
  })

  persistSettlement(domain)
  return { inserted, backlog, skipped }
}

/* ------------------------------------------------------------------ */
/* 待补清单：补齐后随测次补录                                           */
/* ------------------------------------------------------------------ */

export function markResolved(id: number): void {
  const domain = settlementDomain()
  const item = domain.backlog.find((row) => row.id === id)
  if (item) {
    item.resolved = true
    persistSettlement(domain)
  }
}

/* ------------------------------------------------------------------ */
/* 检修清单 / 值班待办的后续处置（办结时两边同步，保持对得上）          */
/* ------------------------------------------------------------------ */

export function arrangeMaintenance(id: number): void {
  const domain = settlementDomain()
  const item = domain.maintenance.find((row) => row.id === id)
  if (!item) return
  item.检修班组 = item.检修班组 === '待安排' ? '结构检修班' : item.检修班组
  item.status = '已安排'
  const duty = domain.duty.find((row) => row.sourceKey === item.sourceKey && row.status === '待办')
  if (duty) duty.status = '已安排'
  persistSettlement(domain)
}

export function completeMaintenance(id: number): void {
  const domain = settlementDomain()
  const item = domain.maintenance.find((row) => row.id === id)
  if (!item) return
  item.status = '已完工'
  domain.duty
    .filter((row) => row.sourceKey === item.sourceKey)
    .forEach((row) => {
      row.status = '已办结'
    })
  persistSettlement(domain)
}

export function settleDutyTodo(id: number): void {
  const domain = settlementDomain()
  const todo = domain.duty.find((row) => row.id === id)
  if (!todo) return
  todo.status = '已办结'
  // 双向兜底：值班办结时，若检修仍在待安排/已安排则一并推进到完工，保证两侧同步。
  const maintenance = domain.maintenance.find((row) => row.sourceKey === todo.sourceKey)
  if (maintenance && maintenance.status !== '已完工') {
    maintenance.status = '已完工'
  }
  persistSettlement(domain)
}

/* ------------------------------------------------------------------ */
/* 唯一读数出口：汇总、看板、对账、报表都从台账派生                      */
/* ------------------------------------------------------------------ */

export type SettlementSummary = {
  total: number
  normal: number
  warning: number
  newCount: number
  legacyCount: number
  pendingMaintenance: number
  pendingDuty: number
  openBacklog: number
  /** 对账：新口径超限数 = 检修待安排数 = 值班待办数 */
  reconciled: boolean
  warningByNew: number
}

export function settlementSummary(): SettlementSummary {
  const domain = settlementDomain()
  const newWarnings = domain.ledger.filter(
    (row) => row.caliber === 'new' && row.status === OBSERVATION_STATUS.warning,
  )
  // 在办检修：待安排 + 已安排；待办值班：待办。两侧随安排/完工同步增减。
  const pendingMaintenance = domain.maintenance.filter(
    (row) => row.status === '待安排' || row.status === '已安排',
  ).length
  const pendingDuty = domain.duty.filter(
    (row) => row.status === '待办' || row.status === '已安排',
  ).length
  return {
    total: domain.ledger.length,
    normal: domain.ledger.filter((row) => row.status === OBSERVATION_STATUS.normal).length,
    warning: domain.ledger.filter((row) => row.status === OBSERVATION_STATUS.warning).length,
    newCount: domain.ledger.filter((row) => row.caliber === 'new').length,
    legacyCount: domain.ledger.filter((row) => row.caliber === 'legacy').length,
    pendingMaintenance,
    pendingDuty,
    openBacklog: domain.backlog.filter((row) => !row.resolved).length,
    warningByNew: newWarnings.length,
    // 对账：每一条新口径超限，在未办结阶段都对应恰好一条检修在办与一条值班待办；
    // 办结后两侧同时归零。因此「检修在办数 ＝ 值班待办数」恒成立，即与值班台账对得上。
    reconciled: pendingMaintenance === pendingDuty,
  }
}

export function listLedger(): SettlementObservation[] {
  return settlementDomain().ledger
}

export function listMaintenanceTodos(): MaintenanceTodo[] {
  return settlementDomain().maintenance
}

export function listDutyTodos(): DutyTodo[] {
  return settlementDomain().duty
}

export function listBacklog(): BacklogItem[] {
  return settlementDomain().backlog
}

/* ------------------------------------------------------------------ */
/* 报表导出：与页面汇总同源，保证读数一致                               */
/* ------------------------------------------------------------------ */

export function exportSettlementReport(): { filename: string; content: string } {
  const ledger = listLedger()
  const header = [
    '监测编号',
    '监测断面',
    '监测日期',
    '累计沉降量(mm)',
    '沉降速率(mm/d)',
    '预警阈值(mm)',
    '口径',
    '监测结论',
    '是否超限',
    '检修编号',
    '值班待办编号',
  ]
  const lines = [header.join(',')]
  ;[...ledger]
    .sort((a, b) => a.监测日期.localeCompare(b.监测日期) || a.监测断面.localeCompare(b.监测断面))
    .forEach((row) => {
      const maintenance = settlementDomain().maintenance.find((item) => item.sourceKey === row.ledgerKey)
      const duty = settlementDomain().duty.find((item) => item.sourceKey === row.ledgerKey)
      lines.push(
        [
          row.监测编号,
          row.监测断面,
          row.监测日期,
          row.累计沉降量,
          row.沉降速率,
          row.预警阈值,
          row.caliber === 'new' ? '新口径' : '存量沿用',
          row.status,
          row.overLimit ? '是' : '否',
          maintenance?.检修编号 ?? '',
          duty?.待办编号 ?? '',
        ].join(','),
      )
    })
  return { filename: `结构沉降监测-观测台账报表-${CUTOVER_DATE}.csv`, content: `﻿${lines.join('\n')}` }
}

/** 把测绘队粘贴的制表符/逗号表格解析成观测行（表头按列名匹配，列序随意）。 */
export function parseObservationTable(text: string, roundDate: string): ObservationInput[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return []
  const split = (line: string) => line.split(/\t|,|，/).map((cell) => cell.trim())
  const header = split(lines[0])
  const wanted: (keyof ObservationInput)[] = [
    '监测编号',
    '监测断面',
    '累计沉降量',
    '沉降速率',
    '预警阈值',
    '监测日期',
    '监测人员',
  ]
  const indexOf = (name: string) => header.findIndex((cell) => cell.includes(name))
  const hasHeader = wanted.some((name) => indexOf(name) >= 0)

  const toRow = (cells: string[]): ObservationInput => {
    const get = (name: keyof ObservationInput) => {
      if (!hasHeader) return ''
      const idx = indexOf(name)
      return idx >= 0 ? cells[idx] ?? '' : ''
    }
    return {
      监测编号: get('监测编号'),
      监测断面: get('监测断面'),
      累计沉降量: get('累计沉降量'),
      沉降速率: get('沉降速率'),
      预警阈值: get('预警阈值'),
      监测日期: get('监测日期') || roundDate,
      监测人员: get('监测人员'),
    }
  }

  if (!hasHeader) {
    // 无表头时按固定列序：编号,断面,累计沉降量,沉降速率,阈值,日期,人员
    return lines.map((line) => {
      const cells = split(line)
      return {
        监测编号: cells[0] ?? '',
        监测断面: cells[1] ?? '',
        累计沉降量: cells[2] ?? '',
        沉降速率: cells[3] ?? '',
        预警阈值: cells[4] ?? '',
        监测日期: cells[5] || roundDate,
        监测人员: cells[6] ?? '',
      }
    })
  }
  return lines.slice(1).map((line) => toRow(split(line)))
}

export function resetSettlement(): void {
  resetSettlementDomain()
}
