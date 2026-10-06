/**
 * 结构沉降监测「整组处理」域模型。
 *
 * 这是纯前端版本，没有后端事务/唯一索引，下列约定模拟后端的同批入库语义：
 * - 自然键 ledgerKey = `${监测断面}__${监测日期}`，唯一标识「同一断面的同一测次」。
 *   一次观测（一个测次）对应一个监测日期，同一断面在该测次只允许落一条。
 * - 落库台账 settlementLedger 是唯一事实来源：汇总、看板、报表、对账都从它派生，
 *   不另存计数，保证「汇总与报表的读数一致」。
 * - 预警回写产生的检修待办（maintenance）与值班待办（dutyTodo）带来源键 sourceKey，
 *   与台账一一对应，用来做「对账结论产生的待办条数与值班台账对得上」。
 */

/** 口径切换日（上线日）：当日及以后走新口径（A 整组提交），之前走存量补录（B）。 */
export const CUTOVER_DATE = '2026-10-06'

/** 沉降监测点的业务状态（沿用 modules.ts 既有状态）。 */
export const OBSERVATION_STATUS = {
  pending: '待监测',
  normal: '沉降正常',
  warning: '超限预警',
} as const

/** 一行观测成果（测绘队表里的一条断面记录）。 */
export type ObservationInput = {
  监测编号: string
  监测断面: string
  累计沉降量: string
  沉降速率: string
  预警阈值: string
  监测日期: string
  监测人员: string
  /** 仅存量补录使用：测绘队原始结论，沿用不重新判定。 */
  legacyConclusion?: string
}

/** 已落库的观测台账行。 */
export type SettlementObservation = ObservationInput & {
  id: number
  /** 同断面同测次唯一键：`断面__日期`。 */
  ledgerKey: string
  /** 批量入库：同断面同测次在一笔里出现多次时，只保留第一次出现的那条。 */
  duplicateInBatch: boolean
  status: string
  abnormal: boolean
  /** 累计沉降量数值（mm），缺失时为 null，用于阈值判定与报表。 */
  settlementValue: number | null
  /** 预警阈值数值（mm），缺失时为 null。 */
  thresholdValue: number | null
  overLimit: boolean
  /** 回写到设施检修清单的检修记录 id（超限才有）。 */
  maintenanceId: number | null
  /** 对应值班待办 id（超限才有）。 */
  dutyTodoId: number | null
  /** 口径：new=切换日后新口径；legacy=存量补录，沿用原结论。 */
  caliber: 'new' | 'legacy'
  /** 存量补录时测绘队给的原结论；新口径行为空。 */
  legacyConclusion: string
  sourceBatchId: string
  submittedAt: string
}

/** 提交前检查发现的问题。blocking=true 的问题不解决，整批不予落库。 */
export type CheckIssue = {
  row: number
  监测编号: string
  监测断面: string
  field: string
  message: string
  blocking: boolean
}

/** 整组提交后每一行的回执。 */
export type BatchReceipt = {
  row: number
  ledgerKey: string
  监测编号: string
  监测断面: string
  监测日期: string
  /** 成功 / 重复挡回 / 批内重复舍弃 / 校验未过 / 缺失待补 */
  result: '成功' | '重复挡回' | '批内重复舍弃' | '校验未过' | '缺失待补'
  ok: boolean
  status: string
  overLimit: boolean
  maintenanceId: number | null
  dutyTodoId: number | null
  message: string
}

/** 一次整组提交的整体结果。 */
export type BatchSubmitResult = {
  batchId: string
  caliber: 'new' | 'legacy'
  submittedAt: string
  accepted: number
  rejected: number
  warningRaised: number
  maintenanceCreated: number
  dutyTodoCreated: number
  receipts: BatchReceipt[]
}

/** 存量缺失项集中待补清单的一条。 */
export type BacklogItem = {
  id: number
  ledgerKey: string
  监测编号: string
  监测断面: string
  监测日期: string
  missingFields: string[]
  caliber: 'legacy' | 'new'
  sourceBatchId: string
  createdAt: string
  resolved: boolean
}

/** 超限预警回写到「设施检修管理」的待安排记录。 */
export type MaintenanceTodo = {
  id: number
  检修编号: string
  检修对象: string
  检修类别: string
  检修班组: string
  计划工期: string
  sourceKey: string
  监测编号: string
  预警结论: string
  累计沉降量: string
  沉降速率: string
  来源批次: string
  status: string
  createdAt: string
}

/** 预警结论同步到值班台账的待办条目（对账依据）。 */
export type DutyTodo = {
  id: number
  待办编号: string
  sourceKey: string
  检修编号: string
  监测断面: string
  监测日期: string
  事项: string
  来源批次: string
  status: string
  createdAt: string
}
