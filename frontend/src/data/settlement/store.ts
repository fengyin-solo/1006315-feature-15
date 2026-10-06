import { LEGACY_RAW_OBSERVATIONS } from './legacy-seed'
import { backfillLegacy } from '@/api/settlement-service'
import type {
  BacklogItem,
  DutyTodo,
  MaintenanceTodo,
  SettlementObservation,
} from './types'

// 沉降整组处理的持久化键，独立于通用 entries，避免与其它模块串数据。
const KEYS = {
  ledger: 'urban-utility-tunnel:settlement:ledger',
  maintenance: 'urban-utility-tunnel:settlement:maintenance-todo',
  duty: 'urban-utility-tunnel:settlement:duty-todo',
  backlog: 'urban-utility-tunnel:settlement:backlog',
  seq: 'urban-utility-tunnel:settlement:seq',
  backfilled: 'urban-utility-tunnel:settlement:legacy-backfilled',
}

type SettlementDomain = {
  ledger: SettlementObservation[]
  maintenance: MaintenanceTodo[]
  duty: DutyTodo[]
  backlog: BacklogItem[]
  seq: number
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) return fallback
  const raw = window.localStorage.getItem(key)
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

let cache: SettlementDomain | null = null

/**
 * 读取沉降域。首次进入时按「设备投运日期 → 监测日期」幂等回填存量成果，
 * 回填只跑一次（有标记位）；点页面上的「重新回填」可重复执行（幂等，不重复入库）。
 */
export function settlementDomain(): SettlementDomain {
  if (cache) return cache
  const domain: SettlementDomain = {
    ledger: readJson<SettlementObservation[]>(KEYS.ledger, []),
    maintenance: readJson<MaintenanceTodo[]>(KEYS.maintenance, []),
    duty: readJson<DutyTodo[]>(KEYS.duty, []),
    backlog: readJson<BacklogItem[]>(KEYS.backlog, []),
    seq: readJson<number>(KEYS.seq, 0),
  }
  cache = domain
  const alreadyBackfilled = readJson<boolean>(KEYS.backfilled, false)
  if (!alreadyBackfilled) {
    backfillLegacy(clone(LEGACY_RAW_OBSERVATIONS))
    writeJson(KEYS.backfilled, true)
  }
  return cache
}

export function persistSettlement(domain: SettlementDomain): void {
  cache = domain
  writeJson(KEYS.ledger, domain.ledger)
  writeJson(KEYS.maintenance, domain.maintenance)
  writeJson(KEYS.duty, domain.duty)
  writeJson(KEYS.backlog, domain.backlog)
  writeJson(KEYS.seq, domain.seq)
}

export function nextSettlementId(domain: SettlementDomain): number {
  domain.seq += 1
  return domain.seq
}

/** 清掉沉降域并重新回填，回到「刚上线」状态。 */
export function resetSettlementDomain(): SettlementDomain {
  if (typeof window !== 'undefined' && window.localStorage) {
    Object.values(KEYS).forEach((key) => window.localStorage.removeItem(key))
  }
  cache = null
  settlementDomain() // 触发首次回填
  return settlementDomain()
}
