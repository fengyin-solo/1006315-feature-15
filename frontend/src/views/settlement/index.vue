<template>
  <section class="page" data-module="settlement">
    <header class="page-head">
      <div>
        <h2>结构沉降监测管理</h2>
        <p class="page-desc">
          同一测次的观测成果整组提交：预检通过才落库，逐条回执；累计沉降量超阈值自动挂超限预警，
          预警结论回写设施检修清单排「待安排」。新口径自切换日 {{ SWITCH_DATE }} 起算，更早的测次沿用原结论。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openBatchDialog">整组提交观测成果</button>
        <button class="btn" type="button" @click="openPointDialog">存量点位回填</button>
        <button class="btn" type="button" @click="exportRoundReport">导出测次汇总</button>
        <button class="btn" type="button" @click="exportDetailReport">导出观测明细</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div class="tab-bar">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-item"
        :class="{ active: activeTab === tab.key }"
        type="button"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
        <em v-if="tab.badge" class="tab-badge">{{ tab.badge }}</em>
      </button>
    </div>

    <!-- 观测成果明细 -->
    <template v-if="activeTab === 'observations'">
      <form class="filter-bar" @submit.prevent="reload">
        <label class="filter-item">
          <span>测次编号</span>
          <input v-model="filters.测次编号" placeholder="按测次编号检索" />
        </label>
        <label class="filter-item">
          <span>监测编号</span>
          <input v-model="filters.监测编号" placeholder="按监测编号检索" />
        </label>
        <label class="filter-item">
          <span>监测断面</span>
          <input v-model="filters.监测断面" placeholder="按监测断面检索" />
        </label>
        <label class="filter-item">
          <span>监测状态</span>
          <select v-model="filters.status">
            <option value="">全部</option>
            <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
          </select>
        </label>
        <button class="btn" type="submit">查询</button>
        <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
      </form>

      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in observationColumns" :key="column">{{ column }}</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in filteredRows" :key="String(row.id)" :class="{ 'row-warning': row.status === '超限预警' }">
            <td v-for="column in observationColumns" :key="column">{{ row[column] ?? '—' }}</td>
            <td class="row-actions">
              <button
                v-for="action in actions"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </td>
          </tr>
          <tr v-if="!filteredRows.length">
            <td :colspan="observationColumns.length + 1" class="empty-state">暂无观测成果，点右上角「整组提交观测成果」</td>
          </tr>
        </tbody>
      </table>
    </template>

    <!-- 测次汇总 + 对账 -->
    <template v-else-if="activeTab === 'rounds'">
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in roundColumns" :key="column">{{ column }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="round in detail.rounds" :key="round.测次编号">
            <td v-for="column in roundColumns" :key="column">
              <strong v-if="column === '超限' && round.超限 > 0" class="error-text">{{ round[column as keyof typeof round] }}</strong>
              <template v-else>{{ round[column as keyof typeof round] }}</template>
            </td>
          </tr>
          <tr v-if="!detail.rounds.length">
            <td :colspan="roundColumns.length" class="empty-state">还没有归组的测次</td>
          </tr>
        </tbody>
      </table>

      <h3 class="block-title">对账结论（与值班台账核对）</h3>
      <div class="stat-row">
        <article class="stat-card">
          <span class="stat-label">超限预警断面</span>
          <strong class="stat-value">{{ detail.reconcile.检修预警总数 }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">检修清单·待安排</span>
          <strong class="stat-value" :class="{ 'error-text': !detail.reconcile.检修对账一致 }">{{ detail.reconcile.检修待安排数 }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">值班台账登记待办</span>
          <strong class="stat-value">{{ detail.reconcile.台账检修待办登记数 }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">待补录资料</span>
          <strong class="stat-value" :class="{ 'error-text': !detail.reconcile.资料对账一致 }">{{ detail.reconcile.资料待补待录数 }}</strong>
        </article>
      </div>
      <p class="reconcile-line" :class="detail.reconcile.consistent ? 'ok-text' : 'error-text'">
        {{ detail.reconcile.consistent ? '✔ 对账一致：每笔批次的检修待办、资料待补都能在值班台账里逐条对上。' : '✘ 对账存在差异：' }}
        <span v-for="(diff, i) in detail.reconcile.差异" :key="i" class="diff-item">{{ diff }}</span>
      </p>
    </template>

    <!-- 点位台账 -->
    <template v-else-if="activeTab === 'points'">
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in pointColumns" :key="column">{{ column }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="point in detail.points" :key="String(point.id)">
            <td v-for="column in pointColumns" :key="column">{{ point[column] ?? '—' }}</td>
          </tr>
          <tr v-if="!detail.points.length">
            <td :colspan="pointColumns.length" class="empty-state">暂无点位台账，先用「存量点位回填」按投运日期建点</td>
          </tr>
        </tbody>
      </table>
    </template>

    <!-- 待补清单 -->
    <template v-else-if="activeTab === 'missing'">
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in missingColumns" :key="column">{{ column }}</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in detail.missing" :key="item.id">
            <td v-for="column in missingColumns" :key="column">{{ missingCell(item, column) }}</td>
            <td>
              <button
                v-if="item.状态 === '待补录'"
                class="link"
                type="button"
                @click="markResolved(item.id)"
              >
                标记已补录
              </button>
              <span v-else class="muted-text">已闭环</span>
            </td>
          </tr>
          <tr v-if="!detail.missing.length">
            <td :colspan="missingColumns.length + 1" class="empty-state">没有待补项</td>
          </tr>
        </tbody>
      </table>
    </template>

    <footer class="page-foot">
      <span>共 {{ filteredRows.length }} 条观测成果 · 同断面同测次系统只认先落库的一笔</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 整组提交弹窗 -->
    <div v-if="batchDialog.open" class="modal-mask" @click.self="closeBatchDialog">
      <div class="modal-box modal-wide">
        <h3 class="modal-title">整组提交观测成果（测绘队表格一次交一组）</h3>
        <div class="form-grid">
          <label class="filter-item">
            <span>测次编号 *</span>
            <input v-model="batchDialog.round" placeholder="如 2026-10-06 或第24期" />
          </label>
          <label class="filter-item">
            <span>监测人员</span>
            <input v-model="batchDialog.observer" placeholder="整组默认监测人" />
          </label>
          <label class="filter-item">
            <span>提交性质</span>
            <select v-model="batchDialog.mode">
              <option value="normal">本期测次提交</option>
              <option value="backfill">存量成果按监测日期回填</option>
            </select>
          </label>
          <label class="filter-item">
            <span>表格文件（可选）</span>
            <input type="file" accept=".csv,.txt" @change="onFile($event, 'batch')" />
          </label>
        </div>
        <p class="modal-hint">
          把测绘队的表整段粘进下面文本框（逗号或制表符分隔，首行表头）。
          表头支持：监测编号、监测断面、累计沉降量、沉降速率、预警阈值、监测日期、监测人员、原结论。
          <button class="link" type="button" @click="fillTemplate('batch')">填入示例表头</button>
        </p>
        <textarea v-model="batchDialog.text" class="paste-area" rows="6" placeholder="监测编号,监测断面,累计沉降量,沉降速率,预警阈值,监测日期,监测人员"></textarea>

        <div class="dialog-actions">
          <button class="btn" type="button" @click="parseBatchText">解析表格</button>
          <button class="btn primary" type="button" :disabled="!batchDialog.rows.length" @click="runPrecheck">提交前检查</button>
          <button
            class="btn primary"
            type="button"
            :disabled="!canCommit"
            @click="commitBatch"
          >
            检查通过·整组落库
          </button>
          <button class="btn ghost" type="button" @click="closeBatchDialog">关闭</button>
        </div>
        <p v-if="batchDialog.parseMessage" class="modal-hint">{{ batchDialog.parseMessage }}</p>

        <div v-if="batchDialog.issues.length" class="issue-box">
          <h4 class="block-title">预检结果（硬伤清零才允许落库）</h4>
          <ul class="issue-list">
            <li v-for="(issue, i) in batchDialog.issues" :key="i" :class="`issue-${issue.level}`">
              <template v-if="issue.level === 'block'">【拦截】</template>
              <template v-else-if="issue.level === 'row'">【提示】</template>
              <template v-else>【可后补】</template>
              {{ issue.message }}
            </li>
          </ul>
        </div>

        <table v-if="batchDialog.rows.length" class="data-table mini-table">
          <thead>
            <tr>
              <th>行</th><th>监测编号</th><th>监测断面</th><th>累计沉降量</th><th>沉降速率</th>
              <th>预警阈值</th><th>监测日期</th><th>判定预览</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in batchDialog.rows" :key="i">
              <td>{{ i + 1 }}</td>
              <td>{{ row.监测编号 }}</td>
              <td>{{ row.监测断面 }}</td>
              <td>{{ row.累计沉降量 }}</td>
              <td>{{ row.沉降速率 || '—' }}</td>
              <td>{{ row.预警阈值 || thresholdFromRegistry(row.监测编号) }}</td>
              <td>{{ row.监测日期 }}</td>
              <td :class="previewClass(row)">{{ previewLabel(row) }}</td>
            </tr>
          </tbody>
        </table>

        <div v-if="batchDialog.result" class="receipt-box">
          <h4 class="block-title">
            整组回执 · 批次 {{ batchDialog.result.批次号 }} ·
            入账 {{ batchDialog.result.accepted }} 条 / 挡回 {{ batchDialog.result.rejected }} 条 /
            超限 {{ batchDialog.result.overLimit }} 条 / 检修待办新增 {{ batchDialog.result.检修新增 }} 条 /
            待补登记 {{ batchDialog.result.资料待补新增 }} 条
          </h4>
          <table class="data-table mini-table">
            <thead>
              <tr><th>行</th><th>监测编号</th><th>监测断面</th><th>结果</th><th>原因说明（没交成的逐条另起一行）</th></tr>
            </thead>
            <tbody>
              <tr v-for="receipt in batchDialog.result.receipts" :key="receipt.index">
                <td>{{ receipt.index + 1 }}</td>
                <td>{{ receipt.监测编号 }}</td>
                <td>{{ receipt.监测断面 }}</td>
                <td :class="receipt.status === 'accepted' ? 'ok-text' : 'error-text'">
                  {{ receipt.status === 'accepted' ? '已入账' : '未交成' }}
                </td>
                <td>{{ receipt.reason }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 点位台账回填弹窗 -->
    <div v-if="pointDialog.open" class="modal-mask" @click.self="closePointDialog">
      <div class="modal-box modal-wide">
        <h3 class="modal-title">存量点位按设备投运日期回填（先于观测成果回填执行）</h3>
        <p class="modal-hint">
          表头：监测编号、监测断面、所属舱室、投运日期、预警阈值。点位已存在且阈值不一致时不覆盖，转待补清单人工裁决。
          <button class="link" type="button" @click="fillTemplate('point')">填入示例表头</button>
        </p>
        <div class="dialog-actions">
          <label class="btn ghost file-btn">
            选择表格文件
            <input type="file" accept=".csv,.txt" @change="onFile($event, 'point')" hidden />
          </label>
          <button class="btn ghost" type="button" @click="closePointDialog">关闭</button>
        </div>
        <textarea v-model="pointDialog.text" class="paste-area" rows="6"></textarea>
        <div class="dialog-actions">
          <button class="btn" type="button" @click="parsePointText">解析表格</button>
          <button class="btn primary" type="button" :disabled="!pointDialog.rows.length" @click="commitPoints">按投运日期回填</button>
        </div>
        <p v-if="pointDialog.message" class="modal-hint">{{ pointDialog.message }}</p>

        <div v-if="pointDialog.result" class="receipt-box">
          <h4 class="block-title">
            回填回执 · 批次 {{ pointDialog.result.批次号 }} · 成功 {{ pointDialog.result.accepted }} 条 /
            挡回 {{ pointDialog.result.rejected }} 条 / 待补登记 {{ pointDialog.result.资料待补新增 }} 条
          </h4>
          <table class="data-table mini-table">
            <thead><tr><th>行</th><th>监测编号</th><th>结果</th><th>处理</th><th>原因说明</th></tr></thead>
            <tbody>
              <tr v-for="receipt in pointDialog.result.receipts" :key="receipt.index">
                <td>{{ receipt.index + 1 }}</td>
                <td>{{ receipt.监测编号 }}</td>
                <td :class="receipt.status === 'accepted' ? 'ok-text' : 'error-text'">
                  {{ receipt.status === 'accepted' ? '已处理' : '未交成' }}
                </td>
                <td>{{ receipt.action }}</td>
                <td>{{ receipt.reason }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  OBSERVATION_CSV_TEMPLATE,
  POINT_CSV_TEMPLATE,
  SWITCH_DATE,
  downloadCsv,
  exportSettlementDetailReport,
  exportSettlementRoundReport,
  loadSettlementDetail,
  parseObservations,
  parsePoints,
  previewBatch,
  resolveMissing,
  submitBatch,
  submitPointBackfill,
} from '@/api/local-settlement'
import { runAction as applyAction } from '@/api/local-service'
import type {
  MissingItem,
  PointBackfillResult,
  SettlementBatchResult,
  SettlementObservationInput,
  SettlementPointInput,
} from '@/data/settlement'
import type { EntryRow } from '@/data/types'

const moduleKey = 'settlement'
const observationColumns = [
  '监测编号', '监测断面', '测次编号', '累计沉降量', '沉降速率', '预警阈值',
  '监测日期', '监测人员', '监测状态', '口径', '批次号',
]
const roundColumns = ['测次编号', '断面数', '正常', '超限', '待监测', '其他', '最早监测日期', '批次号']
const pointColumns = ['监测编号', '监测断面', '所属舱室', '投运日期', '预警阈值', '来源批次', '登记人员']
const missingColumns = ['监测编号', '监测断面', '路径', '测次编号', '缺失项', '监测日期', '状态', '批次号']
const actions = ['提交监测', '判定正常', '标记预警']
const statuses = ['待监测', '监测中', '沉降正常', '超限预警', '历史归档']

const activeTab = ref<'observations' | 'rounds' | 'points' | 'missing'>('observations')
const errorMessage = ref('')
const filters = ref<Record<string, string>>({ 测次编号: '', 监测编号: '', 监测断面: '', status: '' })

const detail = ref(loadSettlementDetail())
const rows = computed<EntryRow[]>(() => detail.value.rows)

const filteredRows = computed(() =>
  rows.value.filter((row) => {
    if (filters.value.测次编号 && !String(row.测次编号 ?? '').includes(filters.value.测次编号.trim())) return false
    if (filters.value.监测编号 && !String(row.监测编号 ?? '').includes(filters.value.监测编号.trim())) return false
    if (filters.value.监测断面 && !String(row.监测断面 ?? '').includes(filters.value.监测断面.trim())) return false
    if (filters.value.status && String(row.status) !== filters.value.status) return false
    return true
  }),
)

const stats = computed(() => [
  { label: '观测成果总数', value: rows.value.length },
  { label: '测次组数', value: detail.value.rounds.length },
  { label: '沉降正常断面', value: rows.value.filter((r) => r.status === '沉降正常').length },
  { label: '超限预警断面', value: rows.value.filter((r) => r.status === '超限预警').length },
  { label: '待补录资料', value: detail.value.missing.filter((i) => i.状态 === '待补录').length },
])

const tabs = computed(() => [
  { key: 'observations' as const, label: '观测成果', badge: 0 },
  { key: 'rounds' as const, label: '测次汇总与对账', badge: 0 },
  { key: 'points' as const, label: '点位台账', badge: detail.value.points.length },
  { key: 'missing' as const, label: '待补清单', badge: detail.value.missing.filter((i) => i.状态 === '待补录').length },
])

function reload() {
  errorMessage.value = ''
  detail.value = loadSettlementDetail()
}

function resetFilters() {
  filters.value = { 测次编号: '', 监测编号: '', 监测断面: '', status: '' }
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(moduleKey, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function missingCell(item: MissingItem, column: string): string {
  if (column === '路径') return item.path === 'pointRegistry' ? '点位台账(投运日期)' : '观测成果(监测日期)'
  return String(item[column as keyof MissingItem] ?? '—')
}

function markResolved(id: number) {
  const result = resolveMissing(id)
  errorMessage.value = result.ok ? '' : result.message
  reload()
}

function exportRoundReport() {
  downloadCsv(exportSettlementRoundReport())
}

function exportDetailReport() {
  downloadCsv(exportSettlementDetailReport())
}

// ---------- 整组提交弹窗 ----------

const batchDialog = reactive({
  open: false,
  round: '',
  observer: '',
  mode: 'normal' as 'normal' | 'backfill',
  text: '',
  rows: [] as SettlementObservationInput[],
  issues: [] as ReturnType<typeof previewBatch>,
  parseMessage: '',
  result: null as SettlementBatchResult | null,
})

function openBatchDialog() {
  Object.assign(batchDialog, {
    open: true,
    round: '',
    observer: '',
    mode: 'normal',
    text: '',
    rows: [],
    issues: [],
    parseMessage: '',
    result: null,
  })
}

function closeBatchDialog() {
  batchDialog.open = false
  reload()
}

function fillTemplate(kind: 'batch' | 'point') {
  if (kind === 'batch') batchDialog.text = OBSERVATION_CSV_TEMPLATE
  else pointDialog.text = POINT_CSV_TEMPLATE
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

async function onFile(event: Event, kind: 'batch' | 'point') {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const text = await readFile(file)
  if (kind === 'batch') batchDialog.text = text
  else pointDialog.text = text
}

function parseBatchText() {
  batchDialog.result = null
  const parsed = parseObservations(batchDialog.text)
  batchDialog.parseMessage = parsed.message
  batchDialog.rows = parsed.rows
  batchDialog.issues = []
}

function runPrecheck() {
  batchDialog.result = null
  if (!batchDialog.rows.length) {
    batchDialog.parseMessage = '请先粘贴并解析表格'
    return
  }
  batchDialog.issues = previewBatch({
    测次编号: batchDialog.round,
    监测人员: batchDialog.observer,
    mode: batchDialog.mode,
    rows: batchDialog.rows,
    operator: '值班管理员',
  })
}

const canCommit = computed(() => {
  if (!batchDialog.rows.length || !batchDialog.round.trim()) return false
  if (!batchDialog.issues.length) return false
  return !batchDialog.issues.some((issue) => issue.level === 'block')
})

async function commitBatch() {
  const result = await submitBatch({
    测次编号: batchDialog.round.trim(),
    监测人员: batchDialog.observer,
    mode: batchDialog.mode,
    rows: batchDialog.rows,
    operator: '值班管理员',
  })
  batchDialog.result = result
  // 落库后刷新对账视图，但弹窗保留回执；关闭弹窗时再 reload 明细。
  detail.value = loadSettlementDetail()
  if (result.committed) {
    batchDialog.issues = []
  }
}

function thresholdFromRegistry(code: string): string {
  const point = detail.value.points.find((p) => String(p.监测编号) === code)
  return point ? String(point.预警阈值 ?? '—') : '台账无此点'
}

function previewLabel(row: SettlementObservationInput): string {
  if (!String(row.监测日期 ?? '').trim()) return '日期缺失'
  if (String(row.监测日期) < SWITCH_DATE) return '旧口径：沿用原结论'
  const threshold = row.预警阈值 || thresholdFromRegistry(row.监测编号)
  const value = Number(String(row.累计沉降量 ?? '').replace(/,/g, ''))
  if (!Number.isFinite(value)) return '沉降量缺失'
  return Math.abs(value) > Math.abs(Number(threshold)) ? '超限预警→排检修待安排' : '沉降正常'
}

function previewClass(row: SettlementObservationInput): string {
  const label = previewLabel(row)
  if (label.includes('超限')) return 'error-text'
  if (label.includes('缺失')) return 'warn-text'
  return 'muted-text'
}

// ---------- 点位回填弹窗 ----------

const pointDialog = reactive({
  open: false,
  text: '',
  rows: [] as SettlementPointInput[],
  message: '',
  result: null as PointBackfillResult | null,
})

function openPointDialog() {
  Object.assign(pointDialog, { open: true, text: '', rows: [], message: '', result: null })
}

function closePointDialog() {
  pointDialog.open = false
  reload()
}

function parsePointText() {
  pointDialog.result = null
  const parsed = parsePoints(pointDialog.text)
  pointDialog.message = parsed.message
  pointDialog.rows = parsed.rows
}

async function commitPoints() {
  pointDialog.result = await submitPointBackfill(pointDialog.rows, '值班管理员')
  detail.value = loadSettlementDetail()
}

onMounted(reload)
</script>

<style scoped>
.tab-bar { display: flex; gap: 8px; margin: 4px 0 12px; flex-wrap: wrap; }
.tab-item { border: 1px solid var(--border); background: #fff; border-radius: 999px; padding: 5px 14px; cursor: pointer; font-size: 13px; position: relative; }
.tab-item.active { background: var(--brand); border-color: var(--brand); color: #fff; }
.tab-badge { font-style: normal; background: #b42318; color: #fff; border-radius: 999px; padding: 0 7px; font-size: 11px; margin-left: 6px; }
.row-warning { background: #fef3f2; }
.block-title { font-size: 14px; margin: 16px 0 8px; }
.ok-text { color: #067647; }
.warn-text { color: #b54708; }
.muted-text { color: var(--muted); }
.diff-item { margin-left: 10px; }
.reconcile-line { font-size: 13px; }
.modal-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; align-items: flex-start; justify-content: center; padding: 32px 16px; z-index: 50; overflow: auto; }
.modal-box { background: #fff; border-radius: 10px; padding: 18px 20px; width: 640px; max-width: 100%; }
.modal-wide { width: 1040px; }
.modal-title { margin: 0 0 12px; font-size: 16px; }
.form-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.paste-area { width: 100%; border: 1px solid var(--border); border-radius: 6px; padding: 8px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; margin: 8px 0; }
.dialog-actions { display: flex; gap: 8px; align-items: center; margin: 6px 0; flex-wrap: wrap; }
.file-btn { cursor: pointer; }
.modal-hint { font-size: 12px; color: var(--muted); margin: 4px 0; }
.issue-box, .receipt-box { border-top: 1px dashed var(--border); margin-top: 10px; padding-top: 6px; }
.issue-list { margin: 0; padding-left: 4px; list-style: none; font-size: 12px; max-height: 140px; overflow: auto; }
.issue-list li { padding: 2px 0; }
.issue-block { color: #b42318; }
.issue-row { color: #b54708; }
.issue-warn { color: var(--muted); }
.mini-table { font-size: 12px; margin-top: 8px; }
.mini-table th, .mini-table td { padding: 5px 7px; }
</style>
