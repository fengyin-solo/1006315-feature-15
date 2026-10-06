/**
 * 结构沉降监测「整组处理」的领域逻辑。
 *
 * 这里只做纯计算，不直接碰 localStorage：页面与 local-service 负责存取，
 * 这样同一套规则可以被接口和脚本对账/测试共用，汇总与报表的读数天然同源。
 *
 * 关键口径（依据见 README《结构沉降整组处理口径》）：
 * - 一次提交同一测次的多条观测成果，逐条回执；同断面同测次只认第一条。
 * - 提交前先做硬检查（监测编号批内重号、累计沉降量缺失等），有硬伤整批不落库。
 * - 切换日 SWITCH_DATE（含）之后按新口径自动判定；切换日之前沿用原结论，不重判、不挂预警。
 * - 超阈值挂「超限预警」，并在设施检修清单生成一条「待安排」；同一(监测编号,测次)幂等。
 * - 两条回填路径：先按投运日期补点位台账，再按监测日期补观测成果；冲突不覆盖，进待补清单。
 */
import type { EntryRow } from './types'

// 新口径切换日：等于或晚于这一天的测次才参与自动判定与检修联动，早于它的沿用原结论。
export const SWITCH_DATE = '2026-10-06'

// 检修联动固定取值：清单里靠这个类别和幂等键对账。
export const MAINTENANCE_CATEGORY = '沉降超限预警'
export const MAINTENANCE_WAIT_STATUS = '待安排'
export const BATCH_PREFIX = 'BC'
export const BACKFILL_BATCH_PREFIX = 'BF'

/** 回填的两条路径：点位台账按投运日期、观测成果按监测日期。 */
export type BackfillPath = 'pointRegistry' | 'legacyRound'

/** 组内单条观测成果（测绘队表格一行）。 */
export type SettlementObservationInput = {
  监测编号: string
  监测断面: string
  累计沉降量: string
  沉降速率?: string
  预警阈值?: string
  监测日期: string
  监测人员?: string
  原结论?: string
}

/** 整组提交入参。 */
export type SettlementBatchInput = {
  测次编号: string
  监测人员?: string
  mode: 'normal' | 'backfill'
  rows: SettlementObservationInput[]
  operator: string
}

/** 点位台账一行（按设备投运日期回填那条路径用）。 */
export type SettlementPointInput = {
  监测编号: string
  监测断面: string
  所属舱室?: string
  投运日期: string
  预警阈值?: string
}

export type CheckIssueLevel = 'block' | 'row' | 'warn'

export type CheckIssue = {
  level: CheckIssueLevel
  index: number
  监测编号: string
  message: string
}

export type ReceiptStatus = 'accepted' | 'rejected'

/** 逐条回执：没交成的那几条靠 reason 另起一行说明原因。 */
export type SettlementReceipt = {
  index: number
  监测编号: string
  监测断面: string
  测次编号: string
  status: ReceiptStatus
  reason: string
  overLimit: boolean
  入库编号: number | null
  检修编号: string | null
}

export type SettlementBatchResult = {
  ok: boolean
  批次号: string
  测次编号: string
  mode: 'normal' | 'backfill'
  committed: boolean
  accepted: number
  rejected: number
  overLimit: number
  检修新增: number
  资料待补新增: number
  receipts: SettlementReceipt[]
}

export type MissingItem = {
  id: number
  监测编号: string
  监测断面: string
  path: BackfillPath
  测次编号: string
  缺失项: string
  监测日期: string
  状态: '待补录' | '已补录'
  批次号: string
  登记时间: string
}

export type PointBackfillReceipt = {
  index: number
  监测编号: string
  status: ReceiptStatus
  reason: string
  action: 'created' | 'updated' | 'unchanged' | 'skipped'
}

export type PointBackfillResult = {
  ok: boolean
  批次号: string
  committed: boolean
  accepted: number
  rejected: number
  资料待补新增: number
  receipts: PointBackfillReceipt[]
}

/** 领域服务运行时需要的全部状态：观测、点位、检修、台账、待补清单。 */
export type SettlementState = {
  settlement: EntryRow[]
  settlementPoints: EntryRow[]
  maintenance: EntryRow[]
  duty: EntryRow[]
  settlementMissing: MissingItem[]
}

export type ReconcileReport = {
  切换日: string
  检修预警总数: number
  检修待安排数: number
  台账检修待办登记数: number
  资料待补总数: number
  资料待补待录数: number
  台账资料待补登记数: number
  检修对账一致: boolean
  资料对账一致: boolean
  consistent: boolean
  batches: {
    批次号: string
    测次编号: string
    预警数: number
    检修新增: number
    资料待补新增: number
  }[]
  差异: string[]
}

// ---------- 基础工具 ----------

export function toNumberText(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (text === '' || text === '—') return null
  const num = Number(text.replace(/,/g, ''))
  return Number.isFinite(num) ? num : null
}

/** 累计沉降量取绝对值与阈值比较：向下沉的位移大小为准，正负号只是方向。 */
export function isOverLimit(累计沉降量: unknown, 阈值: unknown): boolean {
  const value = toNumberText(累计沉降量)
  const limit = toNumberText(阈值)
  if (value === null || limit === null) return false
  return Math.abs(value) > Math.abs(limit)
}

export function isLegacyDate(监测日期: string): boolean {
  return 监测日期 < SWITCH_DATE
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase()
}

function makeId(rows: { id: number }[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function maintenanceIdempotencyKey(监测编号: string, 测次编号: string): string {
  return `SETT#${normalizeCode(监测编号)}#${测次编号.trim()}`
}

function nextBatchNo(mode: 'normal' | 'backfill', state: SettlementState, stamp: string): string {
  const prefix = mode === 'backfill' ? BACKFILL_BATCH_PREFIX : BATCH_PREFIX
  const day = stamp.slice(0, 10).replace(/-/g, '')
  const head = `${prefix}-${day}-`
  const maxSeq = [...state.settlement, ...state.duty]
    .map((row) => String(row.批次号 ?? ''))
    .filter((no) => no.startsWith(head))
    .reduce((max, no) => {
      const seq = Number(no.slice(head.length))
      return Number.isFinite(seq) ? Math.max(max, seq) : max
    }, 0)
  return `${head}${String(maxSeq + 1).padStart(3, '0')}`
}

// ---------- 提交前检查 ----------

/**
 * 整组预检。block 级问题必须全部清零才允许落库；row 级只给提示，不拦整批；
 * 同测次同断面重复属于组内去重，不算硬伤，提交时第一条入账、后到的逐条挡回。
 */
export function checkBatch(input: SettlementBatchInput, state: SettlementState): CheckIssue[] {
  const issues: CheckIssue[] = []
  const rows = input.rows ?? []

  if (!input.测次编号.trim()) {
    issues.push({ level: 'block', index: -1, 监测编号: '', message: '测次编号缺失，整组成果无法归到同一测次' })
  }
  if (rows.length === 0) {
    issues.push({ level: 'block', index: -1, 监测编号: '', message: '本组没有任何观测成果行' })
  }

  const codeSeen = new Map<string, number>()
  // 断面+测次才是业务去重键：同一断面在同一测次里出现两次只算一次。
  const pairSeen = new Set<string>()
  const registered = new Set(
    state.settlementPoints.map((point) => normalizeCode(String(point.监测编号 ?? ''))),
  )

  rows.forEach((row, index) => {
    const code = String(row.监测编号 ?? '').trim()
    const section = String(row.监测断面 ?? '').trim()
    const pair = `${section}#${input.测次编号.trim()}`

    if (!code) {
      issues.push({ level: 'block', index, 监测编号: code, message: `第${index + 1}行监测编号为空` })
    } else if (codeSeen.has(code)) {
      // 监测编号重号：一张表同一测次里同点只该有一行，这里先提示；落库时后到的一条按重复挡回，
      // 不设成整批硬伤，避免和“同断面同测次去重”（断面可能被重复誊抄）互相打架。
      issues.push({
        level: 'row',
        index,
        监测编号: code,
        message: `监测编号 ${code} 在本组第 ${codeSeen.get(code)! + 1} 行与第 ${index + 1} 行重号，提交时只认第一条`,
      })
    } else {
      codeSeen.set(code, index)
    }

    if (!section) {
      issues.push({ level: 'block', index, 监测编号: code, message: `第${index + 1}行监测断面为空` })
    }

    if (toNumberText(row.累计沉降量) === null) {
      issues.push({ level: 'block', index, 监测编号: code, message: `第${index + 1}行累计沉降量缺失或不是数字` })
    }

    if (!String(row.监测日期 ?? '').trim()) {
      issues.push({ level: 'block', index, 监测编号: code, message: `第${index + 1}行监测日期缺失` })
    }

    if (pairSeen.has(pair)) {
      // 组内去重不算硬伤：这里只提示，真正落库时后到的一条按重复逐条挡回。
      issues.push({ level: 'row', index, 监测编号: code, message: `第${index + 1}行同断面同测次重复，提交时只认第一条` })
    } else {
      pairSeen.add(pair)
    }

    const threshold = toNumberText(row.预警阈值)
    if (threshold === null) {
      if (!registered.has(normalizeCode(code))) {
        issues.push({ level: 'block', index, 监测编号: code, message: `第${index + 1}行预警阈值缺失且点位台账查不到 ${code}` })
      } else {
        issues.push({ level: 'warn', index, 监测编号: code, message: `第${index + 1}行未带阈值，按点位台账阈值判定` })
      }
    }

    if (!String(row.沉降速率 ?? '').trim()) {
      issues.push({ level: 'warn', index, 监测编号: code, message: `第${index + 1}行沉降速率未誊，可后补（不计硬伤）` })
    }
  })

  return issues
}

export function hasBlockIssue(issues: CheckIssue[]): boolean {
  return issues.some((issue) => issue.level === 'block')
}

// ---------- 整组提交（新测次 / 存量按监测日期回填，共用一条落库通道）----------

function resolveThreshold(row: SettlementObservationInput, state: SettlementState): number | null {
  const inline = toNumberText(row.预警阈值)
  if (inline !== null) return inline
  const point = state.settlementPoints.find(
    (item) => normalizeCode(String(item.监测编号 ?? '')) === normalizeCode(row.监测编号),
  )
  return point ? toNumberText(point.预警阈值) : null
}

function pushMissing(
  state: SettlementState,
  draft: Omit<MissingItem, 'id' | '登记时间'>,
  stamp: string,
  kindCounts: { gap: number },
): void {
  state.settlementMissing.push({ ...draft, id: makeId(state.settlementMissing), 登记时间: stamp })
  kindCounts.gap += 1
}

/**
 * 整组提交。返回逐条回执；调用方先跑 checkBatch，有 block 时这里整批不落库。
 * 同断面同测次 / 同点同测次的后到一笔按重复挡回，只认先落库的那一笔。
 */
export function submitSettlementBatch(
  input: SettlementBatchInput,
  state: SettlementState,
  stamp: string,
): SettlementBatchResult {
  const issues = checkBatch(input, state)
  const 批次号 = nextBatchNo(input.mode, state, stamp)

  const base: SettlementBatchResult = {
    ok: !hasBlockIssue(issues),
    批次号,
    测次编号: input.测次编号.trim(),
    mode: input.mode,
    committed: false,
    accepted: 0,
    rejected: 0,
    overLimit: 0,
    检修新增: 0,
    资料待补新增: 0,
    receipts: [],
  }

  if (hasBlockIssue(issues)) {
    base.receipts = input.rows.map((row, index) => ({
      index,
      监测编号: String(row.监测编号 ?? '').trim(),
      监测断面: String(row.监测断面 ?? '').trim(),
      测次编号: input.测次编号.trim(),
      status: 'rejected' as const,
      reason: (issues.filter((item) => item.level === 'block' && item.index === index).map((item) => item.message)
        .join('；') || '预检未通过，整批未落库'),
      overLimit: false,
      入库编号: null,
      检修编号: null,
    }))
    base.rejected = base.receipts.length
    return base
  }

  const counts = { gap: 0 }
  // 两个去重键同时守：断面+测次（一个断面一测次只算一次）、编号+测次（同一行并发两笔只认先落的）。
  const acceptedPair = new Set<string>()
  const acceptedCode = new Set<string>()

  input.rows.forEach((row, index) => {
    const code = String(row.监测编号).trim()
    const section = String(row.监测断面).trim()
    const round = input.测次编号.trim()
    const pair = `${section}#${round}`
    const codeKey = `${normalizeCode(code)}#${round}`
    const receipt: SettlementReceipt = {
      index,
      监测编号: code,
      监测断面: section,
      测次编号: round,
      status: 'rejected',
      reason: '',
      overLimit: false,
      入库编号: null,
      检修编号: null,
    }

    // 同一行/同一断面被两笔同时提交（或同批誊了两遍）：只认先落库的那一笔，后到的挡回。
    if (acceptedPair.has(pair)) {
      receipt.reason = `断面 ${section} 在测次 ${round} 已先落一笔，同一断面同测次只算一次，本条按重复挡回`
    } else if (acceptedCode.has(codeKey)) {
      receipt.reason = `监测编号 ${code} 在测次 ${round} 已先落一笔，本条按重复挡回，只认先落的一笔`
    } else {
      const existedSection = state.settlement.find(
        (item) =>
          String(item.监测断面 ?? '') === section &&
          String(item.测次编号 ?? '') === round,
      )
      const existedCode = state.settlement.find(
        (item) =>
          normalizeCode(String(item.监测编号 ?? '')) === normalizeCode(code) &&
          String(item.测次编号 ?? '') === round,
      )
      if (existedSection) {
        receipt.reason = `断面 ${section} 在测次 ${round} 已有入账（编号 ${existedSection.id}），重复提交挡回，只认先落的一笔`
      } else if (existedCode) {
        receipt.reason = `监测编号 ${code} 在测次 ${round} 已入库（编号 ${existedCode.id}），重复提交挡回，只认先落的一笔`
      } else {
        const legacy = isLegacyDate(String(row.监测日期))
        const threshold = resolveThreshold(row, state)
        const over = !legacy && isOverLimit(row.累计沉降量, threshold)
        const status = legacy
          ? (String(row.原结论 ?? '').trim() || '沉降正常')
          : over
            ? '超限预警'
            : '沉降正常'
        const 监测人员 = String(row.监测人员 ?? input.监测人员 ?? '').trim()

        const saved: EntryRow = {
          id: makeId(state.settlement),
          status,
          pending: status !== '沉降正常' && status !== '历史归档',
          abnormal: status === '超限预警',
          监测编号: code,
          监测断面: section,
          测次编号: round,
          累计沉降量: String(row.累计沉降量).trim(),
          沉降速率: String(row.沉降速率 ?? '').trim() || '—',
          预警阈值: threshold === null ? '—' : String(threshold),
          监测日期: String(row.监测日期).trim(),
          监测人员,
          监测状态: status,
          口径: legacy ? '旧口径（沿用原结论）' : '新口径（系统判定）',
          批次号: 批次号,
          提交序号: index + 1,
        }
        state.settlement.push(saved)
        acceptedPair.add(pair)
        acceptedCode.add(codeKey)
        receipt.status = 'accepted'
        receipt.reason = legacy
          ? `监测日期早于切换日 ${SWITCH_DATE}，沿用原结论「${status}」，不重新判定`
          : over
            ? `累计沉降量 ${saved.累计沉降量} 超过阈值 ${saved.预警阈值}，已挂超限预警并回写检修清单`
            : `累计沉降量 ${saved.累计沉降量} 未超过阈值 ${saved.预警阈值}，沉降正常`
        receipt.overLimit = over
        receipt.入库编号 = saved.id

        if (over) {
          const key = maintenanceIdempotencyKey(code, round)
          // 幂等兜底：并发/重试下同一键只生成一条检修待办，保证对账对得上。
          const existingTodo = state.maintenance.find((row2) => String(row2.幂等键 ?? '') === key)
          if (existingTodo) {
            receipt.检修编号 = String(existingTodo.检修编号)
          } else {
            const no = `MAIN-SETT-${String(state.maintenance.length + 1).padStart(4, '0')}`
            state.maintenance.push({
              id: makeId(state.maintenance),
              status: MAINTENANCE_WAIT_STATUS,
              pending: true,
              abnormal: true,
              检修编号: no,
              检修对象: `${section}（${code}）`,
              检修类别: MAINTENANCE_CATEGORY,
              检修班组: '待安排',
              计划工期: '待安排',
              完工日期: '—',
              更换部件: '—',
              检修状态: MAINTENANCE_WAIT_STATUS,
              来源批次: 批次号,
              来源测次: round,
              预警结论: `累计沉降量 ${saved.累计沉降量} 超阈值 ${saved.预警阈值}（${row.监测日期}）`,
              幂等键: key,
            })
            receipt.检修编号 = no
            base.检修新增 += 1
          }
          base.overLimit += 1
        }

        if (!String(row.沉降速率 ?? '').trim()) {
          pushMissing(
            state,
            {
              监测编号: code,
              监测断面: section,
              path: 'legacyRound',
              测次编号: round,
              缺失项: '沉降速率',
              监测日期: String(row.监测日期).trim(),
              状态: '待补录',
              批次号,
            },
            stamp,
            counts,
          )
        }
      }
    }

    if (receipt.status === 'accepted') {
      base.accepted += 1
    } else {
      base.rejected += 1
    }
    base.receipts.push(receipt)
  })

  base.资料待补新增 = counts.gap
  base.committed = true
  base.ok = base.accepted > 0 || base.rejected === 0

  // 值班台账：一个批次一笔，写死本批产生的待办数，供逐条对账。
  const overLimitCount = base.overLimit
  state.duty.push({
    id: makeId(state.duty),
    status: '已交接',
    pending: false,
    abnormal: false,
    交接编号: `DUTY-SETT-${String(state.duty.length + 1).padStart(4, '0')}`,
    值班班组: '结构沉降监测组',
    值班日期: stamp.slice(0, 10),
    班次: input.mode === 'backfill' ? '存量回填' : '监测提交',
    值班人员: input.operator,
    交接事项: `${input.mode === 'backfill' ? '存量成果回填' : '沉降观测整组提交'}：测次 ${base.测次编号}，入账 ${base.accepted} 条，超限 ${overLimitCount} 条`,
    交接人员: input.operator,
    交接状态: '已交接',
    来源批次: 批次号,
    检修待办数: base.检修新增,
    资料待补数: counts.gap,
  })

  return base
}

// ---------- 路径二：点位台账按设备投运日期回填 ----------

/**
 * 点位台账回填：先于观测成果回填执行（阈值要从这里取）。
 * 同一监测编号已存在时不覆盖既有数据——阈值冲突属于兜底场景，挡回并进待补清单由人工裁决。
 */
export function backfillPoints(
  rows: SettlementPointInput[],
  state: SettlementState,
  stamp: string,
  operator: string,
): PointBackfillResult {
  const 批次号 = nextBatchNo('backfill', state, stamp)
  const result: PointBackfillResult = {
    ok: true,
    批次号,
    committed: false,
    accepted: 0,
    rejected: 0,
    资料待补新增: 0,
    receipts: [],
  }
  const seen = new Set<string>()
  let gapCount = 0

  rows.forEach((row, index) => {
    const code = String(row.监测编号 ?? '').trim()
    const receipt: PointBackfillReceipt = {
      index,
      监测编号: code,
      status: 'rejected',
      reason: '',
      action: 'skipped',
    }

    if (!code) {
      receipt.reason = `第${index + 1}行监测编号为空`
    } else if (seen.has(normalizeCode(code))) {
      receipt.reason = `监测编号 ${code} 在本批点位台账里重号，只保留第一条`
    } else {
      seen.add(normalizeCode(code))
      const missing = [
        !String(row.监测断面 ?? '').trim() ? '监测断面' : '',
        !String(row.投运日期 ?? '').trim() ? '投运日期' : '',
      ].filter(Boolean)

      const existed = state.settlementPoints.find(
        (item) => normalizeCode(String(item.监测编号 ?? '')) === normalizeCode(code),
      )
      if (existed) {
        const oldLimit = toNumberText(existed.预警阈值)
        const newLimit = toNumberText(row.预警阈值)
        if (newLimit !== null && oldLimit !== null && Math.abs(newLimit) !== Math.abs(oldLimit)) {
          receipt.reason = `点位 ${code} 已存在且阈值不一致（旧 ${oldLimit}/新 ${newLimit}），冲突不覆盖，进待补清单人工裁决`
          state.settlementMissing.push({
            id: makeId(state.settlementMissing),
            监测编号: code,
            监测断面: String(existed.监测断面 ?? row.监测断面 ?? ''),
            path: 'pointRegistry',
            测次编号: '—',
            缺失项: `预警阈值冲突（旧 ${oldLimit}/新 ${newLimit}）`,
            监测日期: String(row.投运日期 ?? '').trim(),
            状态: '待补录',
            批次号,
            登记时间: stamp,
          })
          gapCount += 1
        } else {
          receipt.status = 'accepted'
          receipt.action = 'unchanged'
          receipt.reason = `点位 ${code} 已按投运日期登记，无需重复回填`
        }
      } else if (missing.length > 0) {
        receipt.reason = `第${index + 1}行 ${missing.join('、')} 缺失，不进台账，转待补清单`
        state.settlementMissing.push({
          id: makeId(state.settlementMissing),
          监测编号: code,
          监测断面: String(row.监测断面 ?? '').trim(),
          path: 'pointRegistry',
          测次编号: '—',
          缺失项: missing.join('、'),
          监测日期: String(row.投运日期 ?? '').trim(),
          状态: '待补录',
          批次号,
          登记时间: stamp,
        })
        gapCount += 1
      } else {
        state.settlementPoints.push({
          id: makeId(state.settlementPoints),
          status: '运行中',
          pending: false,
          abnormal: false,
          监测编号: code,
          监测断面: String(row.监测断面).trim(),
          所属舱室: String(row.所属舱室 ?? '').trim() || '—',
          投运日期: String(row.投运日期).trim(),
          预警阈值: toNumberText(row.预警阈值) === null ? '—' : String(row.预警阈值).trim(),
          来源批次: 批次号,
          登记人员: operator,
        })
        receipt.status = 'accepted'
        receipt.action = 'created'
        receipt.reason = '点位台账已按投运日期建立'
      }
    }

    if (receipt.status === 'accepted') result.accepted += 1
    else result.rejected += 1
    result.receipts.push(receipt)
  })

  result.committed = true
  result.ok = result.rejected === 0
  result.资料待补新增 = gapCount

  state.duty.push({
    id: makeId(state.duty),
    status: '已交接',
    pending: false,
    abnormal: false,
    交接编号: `DUTY-SETT-${String(state.duty.length + 1).padStart(4, '0')}`,
    值班班组: '结构沉降监测组',
    值班日期: stamp.slice(0, 10),
    班次: '存量回填',
    值班人员: operator,
    交接事项: `点位台账按投运日期回填：新增/确认 ${result.accepted} 条，转待补 ${gapCount} 条`,
    交接人员: operator,
    交接状态: '已交接',
    来源批次: 批次号,
    检修待办数: 0,
    资料待补数: gapCount,
  })

  return result
}

// ---------- 测次汇总（列表统计、看板、报表导出统一从这里取数）----------

export type RoundSummary = {
  测次编号: string
  断面数: number
  正常: number
  超限: number
  待监测: number
  其他: number
  最早监测日期: string
  批次号: string
}

export function summarizeRounds(rows: EntryRow[]): RoundSummary[] {
  const map = new Map<string, RoundSummary>()
  for (const row of rows) {
    const round = String(row.测次编号 ?? '').trim() || '（未归测次）'
    let item = map.get(round)
    if (!item) {
      item = {
        测次编号: round,
        断面数: 0,
        正常: 0,
        超限: 0,
        待监测: 0,
        其他: 0,
        最早监测日期: String(row.监测日期 ?? ''),
        批次号: String(row.批次号 ?? '—'),
      }
      map.set(round, item)
    }
    item.断面数 += 1
    if (row.status === '沉降正常' || row.status === '历史归档') item.正常 += 1
    else if (row.status === '超限预警') item.超限 += 1
    else if (row.status === '待监测' || row.status === '监测中') item.待监测 += 1
    else item.其他 += 1
    const date = String(row.监测日期 ?? '')
    if (date && (!item.最早监测日期 || date < item.最早监测日期)) item.最早监测日期 = date
  }
  return [...map.values()].sort((a, b) => b.测次编号.localeCompare(a.测次编号, 'zh-Hans-CN'))
}

// ---------- 对账：检修待办数 / 资料待补数 与值班台账逐条核对 ----------

export function reconcile(state: SettlementState): ReconcileReport {
  const warningRows = state.settlement.filter((row) => row.status === '超限预警')
  const waitingTodos = state.maintenance.filter(
    (row) => String(row.检修类别 ?? '') === MAINTENANCE_CATEGORY && String(row.status ?? '') === MAINTENANCE_WAIT_STATUS,
  )
  const openGaps = state.settlementMissing.filter((item) => item.状态 === '待补录')

  const batchNos = new Set<string>()
  for (const row of warningRows) {
    const no = String(row.批次号 ?? '')
    if (no && !no.startsWith('SEED')) batchNos.add(no)
  }
  for (const item of state.settlementMissing) {
    if (!String(item.批次号 ?? '').startsWith('SEED')) batchNos.add(item.批次号)
  }

  const batches = [...batchNos].sort().map((批次号) => {
    const anyRow = state.settlement.find((row) => String(row.批次号 ?? '') === 批次号)
    return {
      批次号,
      测次编号: String(anyRow?.测次编号 ?? '回填批次'),
      预警数: state.settlement.filter(
        (row) => String(row.批次号 ?? '') === 批次号 && row.status === '超限预警',
      ).length,
      检修新增: state.maintenance.filter((row) => String(row.来源批次 ?? '') === 批次号).length,
      资料待补新增: state.settlementMissing.filter((item) => item.批次号 === 批次号).length,
    }
  })

  const 差异: string[] = []
  for (const batch of batches) {
    const ledger = state.duty.find((row) => String(row.来源批次 ?? '') === batch.批次号)
    if (!ledger) {
      差异.push(`批次 ${batch.批次号} 在值班台账缺登记`)
      continue
    }
    if (Number(ledger.检修待办数 ?? 0) !== batch.检修新增) {
      差异.push(`批次 ${batch.批次号} 检修待办台账 ${ledger.检修待办数} ≠ 清单 ${batch.检修新增}`)
    }
    if (Number(ledger.资料待补数 ?? 0) !== batch.资料待补新增) {
      差异.push(`批次 ${batch.批次号} 资料待补台账 ${ledger.资料待补数} ≠ 待补清单 ${batch.资料待补新增}`)
    }
  }

  const ledgerTodoSum = state.duty
    .filter((row) => String(row.来源批次 ?? '').startsWith(BATCH_PREFIX) || String(row.来源批次 ?? '').startsWith(BACKFILL_BATCH_PREFIX))
    .reduce((sum, row) => sum + Number(row.检修待办数 ?? 0), 0)
  const ledgerGapSum = state.duty
    .filter((row) => String(row.来源批次 ?? '').startsWith(BACKFILL_BATCH_PREFIX))
    .reduce((sum, row) => sum + Number(row.资料待补数 ?? 0), 0)
  const gapFromBackfill = state.settlementMissing.filter((item) =>
    String(item.批次号 ?? '').startsWith(BACKFILL_BATCH_PREFIX),
  ).length

  const 检修对账一致 = ledgerTodoSum === state.maintenance.filter(
    (row) => String(row.检修类别 ?? '') === MAINTENANCE_CATEGORY,
  ).length && 差异.filter((text) => text.includes('检修')).length === 0
  const 资料对账一致 = ledgerGapSum === gapFromBackfill && 差异.filter((text) => text.includes('资料')).length === 0

  return {
    切换日: SWITCH_DATE,
    检修预警总数: warningRows.length,
    检修待安排数: waitingTodos.length,
    台账检修待办登记数: ledgerTodoSum,
    资料待补总数: state.settlementMissing.length,
    资料待补待录数: openGaps.length,
    台账资料待补登记数: ledgerGapSum,
    检修对账一致,
    资料对账一致,
    consistent: 检修对账一致 && 资料对账一致,
    batches,
    差异,
  }
}
