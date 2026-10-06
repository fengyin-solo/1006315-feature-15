import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'urban-utility-tunnel:entries'

// 除 EntryRow 形态的业务表外，整组处理还挂了点位台账、待补清单等异形表，存储层统一按行数组收。
type StoredTable = Record<string, unknown>[]
type StoreData = Record<string, StoredTable>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): StoreData {
  const fallback = clone(SEED_ROWS) as unknown as StoreData
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as StoreData
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: StoreData | null = null

export function allRows(): StoreData {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return (allRows()[key] as EntryRow[] | undefined) ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

// 结构沉降整组处理引入了非 EntryRow 形态的表（点位台账、待补清单），单独给一对泛型存取。
export function listCollection<T>(key: string): T[] {
  return (allRows()[key] as T[] | undefined) ?? []
}

export function saveCollection<T>(key: string, rows: T[]): void {
  const next = { ...allRows(), [key]: rows as unknown as StoredTable }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? []) as unknown as EntryRow[]
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
