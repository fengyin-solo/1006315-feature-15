<template>
  <section class="page" data-module="settlement">
    <header class="page-head">
      <div>
        <h2>结构沉降监测 · 整组处理</h2>
        <p class="page-desc">
          把同一测次测绘队给的几十个断面成果一次交上来：提交前先校验，通过后同批落库并自动挂超限预警；
          预警结论回写设施检修清单并生成值班待办；逐条回执，没交成的单列原因。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportReport">导出观测台账报表</button>
        <button class="btn ghost" type="button" @click="resetAll">回到刚上线状态</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">台账断面测次总数</span>
        <strong class="stat-value">{{ summary.total }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">超限预警（新口径 {{ summary.warningByNew }} / 存量沿用 {{ summary.warning - summary.warningByNew }}）</span>
        <strong class="stat-value" :class="{ warn: summary.warning > 0 }">{{ summary.warning }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">检修待安排/在办（对账）</span>
        <strong class="stat-value">{{ summary.pendingMaintenance }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">值班待办（对账）</span>
        <strong class="stat-value" :class="{ warn: !summary.reconciled }">{{ summary.pendingDuty }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">缺失待补清单</span>
        <strong class="stat-value" :class="{ warn: summary.openBacklog > 0 }">{{ summary.openBacklog }}</strong>
      </article>
    </div>

    <p class="reconcile" :class="{ ok: summary.reconciled, bad: !summary.reconciled }">
      对账结论：新口径累计超限 {{ summary.warningByNew }} 条；当前未办结的检修在办
      {{ summary.pendingMaintenance }} 条 ＝ 值班待办 {{ summary.pendingDuty }} 条 ——
      {{ summary.reconciled ? '与值班台账对得上 ✔' : '对不上，请核查 ✘' }}
    </p>

    <nav class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        class="tab"
        :class="{ active: activeTab === tab.key }"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
        <em v-if="tab.badge !== 0" class="tab-badge">{{ tab.badge }}</em>
      </button>
    </nav>

    <!-- ============ 整组提交 ============ -->
    <div v-if="activeTab === 'submit'" class="panel">
      <div class="batch-meta">
        <label class="filter-item">
          <span>本批测次日期（同批各断面共用）</span>
          <input v-model="roundDate" placeholder="YYYY-MM-DD" />
        </label>
        <label class="filter-item">
          <span>监测人员/班组</span>
          <input v-model="observer" placeholder="如：测绘一队" />
        </label>
        <label class="filter-item">
          <span>默认预警阈值(mm)</span>
          <input v-model="defaultThreshold" placeholder="如：20" />
        </label>
        <div class="path-hint" :class="caliberClass">
          <strong>{{ caliberHint.title }}</strong>
          <span>{{ caliberHint.body }}</span>
        </div>
      </div>

      <div class="batch-tools">
        <button class="btn" type="button" @click="addRow">加一行断面</button>
        <button class="btn" type="button" @click="rows.push(...sampleRows())">填一组示例</button>
        <button class="btn ghost" type="button" @click="rows = []">清空</button>
        <span class="tool-tip">也可直接把测绘队 Excel 的区域复制后粘到下面框里（支持表头/制表符）：</span>
      </div>

      <table class="data-table edit-table">
        <thead>
          <tr>
            <th style="width: 40px">#</th>
            <th>监测编号</th>
            <th>监测断面</th>
            <th>累计沉降量(mm)</th>
            <th>沉降速率(mm/d)</th>
            <th>预警阈值(mm)</th>
            <th>监测日期</th>
            <th>监测人员</th>
            <th style="width: 60px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, idx) in rows" :key="idx">
            <td>{{ idx + 1 }}</td>
            <td><input v-model="row.监测编号" /></td>
            <td><input v-model="row.监测断面" /></td>
            <td><input v-model="row.累计沉降量" class="num" :class="{ missing: row.累计沉降量.trim() === '' }" /></td>
            <td><input v-model="row.沉降速率" class="num" /></td>
            <td><input v-model="row.预警阈值" class="num" /></td>
            <td><input v-model="row.监测日期" placeholder="默认取本批日期" /></td>
            <td><input v-model="row.监测人员" /></td>
            <td><button class="link danger" type="button" @click="rows.splice(idx, 1)">删</button></td>
          </tr>
          <tr v-if="!rows.length">
            <td colspan="9" class="empty-state">还没有断面成果，点「加一行断面」或粘贴测绘队表格</td>
          </tr>
        </tbody>
      </table>

      <div class="paste-box">
        <textarea v-model="pasteText" placeholder="监测编号&#9;监测断面&#9;累计沉降量&#9;沉降速率&#9;预警阈值&#10;SETT-0301&#9;DM-01 人民路段&#9;6.1&#9;0.04&#9;20"></textarea>
        <div class="paste-actions">
          <button class="btn" type="button" @click="importPaste">解析粘贴内容到上表</button>
        </div>
      </div>

      <div class="submit-bar">
        <button class="btn" type="button" @click="runCheck">① 先过一遍检查</button>
        <button class="btn primary" type="button" :disabled="checkedBlocking" @click="doSubmit">
          ② 整组提交（{{ rows.length }} 个断面）
        </button>
        <span v-if="checkedBlocking" class="error-text">存在阻断问题，修正后才能落库</span>
      </div>

      <!-- 检查结果 -->
      <div v-if="checkReport" class="result-block">
        <h3>提交前检查</h3>
        <p v-if="!checkReport.issues.length" class="ok-text">检查通过：本批 {{ checkReport.effective.length }} 个断面测次可落库。</p>
        <ul v-else class="issue-list">
          <li v-for="(issue, i) in checkReport.issues" :key="i" :class="{ blocking: issue.blocking, warning: !issue.blocking }">
            <span class="tag">{{ issue.blocking ? '阻断' : '提示' }}</span>
            第{{ issue.row }}行 · {{ issue.监测断面 || '（断面空）' }} · {{ issue.field }}：{{ issue.message }}
          </li>
        </ul>
      </div>

      <!-- 提交回执 -->
      <div v-if="lastResult" class="result-block">
        <h3>
          整组提交回执 · 批次 {{ lastResult.batchId }}（{{ lastResult.caliber === 'new' ? '新口径' : '存量补录' }}）
        </h3>
        <p class="receipt-summary">
          成功 <strong class="ok-text">{{ lastResult.accepted }}</strong> 条，未成
          <strong class="error-text">{{ lastResult.rejected }}</strong> 条，挂超限预警
          <strong :class="{ warn: lastResult.warningRaised > 0 }">{{ lastResult.warningRaised }}</strong> 条，
          回写检修清单 {{ lastResult.maintenanceCreated }} 条，生成值班待办 {{ lastResult.dutyTodoCreated }} 条。
        </p>
        <table class="data-table receipt-table">
          <thead>
            <tr><th>行</th><th>断面</th><th>监测日期</th><th>结论</th><th>结果</th><th>原因/说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="receipt in lastResult.receipts" :key="receipt.row" :class="{ failed: !receipt.ok }">
              <td>{{ receipt.row }}</td>
              <td>{{ receipt.监测断面 }}<span class="code">{{ receipt.监测编号 }}</span></td>
              <td>{{ receipt.监测日期 }}</td>
              <td>{{ receipt.status || '—' }}</td>
              <td>
                <span class="tag" :class="receipt.ok ? 'ok' : 'fail'">{{ receipt.result }}</span>
                <em v-if="receipt.dutyTodoId" class="code">值班待办#{{ receipt.dutyTodoId }}</em>
              </td>
              <td>{{ receipt.message }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ============ 观测台账 ============ -->
    <div v-else-if="activeTab === 'ledger'" class="panel">
      <form class="filter-bar" @submit.prevent="reloadLedger">
        <label class="filter-item">
          <span>按断面/编号检索</span>
          <input v-model="ledgerFilter" placeholder="断面或监测编号" />
        </label>
        <label class="filter-item">
          <span>口径</span>
          <select v-model="caliberFilter">
            <option value="">全部</option>
            <option value="new">新口径（切换日起）</option>
            <option value="legacy">存量沿用</option>
          </select>
        </label>
        <button class="btn" type="submit">查询</button>
      </form>
      <table class="data-table">
        <thead>
          <tr>
            <th>监测编号</th><th>监测断面</th><th>监测日期</th><th>累计沉降量</th>
            <th>沉降速率</th><th>预警阈值</th><th>口径</th><th>结论</th><th>回写检修/待办</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in filteredLedger" :key="row.id" :class="{ overlimit: row.overLimit }">
            <td>{{ row.监测编号 }}</td>
            <td>{{ row.监测断面 }}</td>
            <td>{{ row.监测日期 }}</td>
            <td>{{ row.累计沉降量 }}</td>
            <td>{{ row.沉降速率 }}</td>
            <td>{{ row.预警阈值 }}</td>
            <td>{{ row.caliber === 'new' ? '新口径' : '存量沿用' }}</td>
            <td>{{ row.status }}</td>
            <td>
              <span v-if="row.maintenanceId" class="code">检修#{{ row.maintenanceId }}</span>
              <span v-if="row.dutyTodoId" class="code">值班#{{ row.dutyTodoId }}</span>
              <span v-if="!row.maintenanceId && !row.dutyTodoId">—</span>
            </td>
          </tr>
          <tr v-if="!filteredLedger.length">
            <td colspan="9" class="empty-state">暂无台账记录</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ============ 预警 → 设施检修清单 ============ -->
    <div v-else-if="activeTab === 'maintenance'" class="panel">
      <p class="page-desc">超过预警阈值的断面在此排进设施检修管理清单的「待安排」，可安排班组或确认完工。</p>
      <table class="data-table">
        <thead>
          <tr>
            <th>检修编号</th><th>检修对象</th><th>检修类别</th><th>预警结论</th>
            <th>检修班组</th><th>状态</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in maintenanceTodos" :key="item.id">
            <td>{{ item.检修编号 }}</td>
            <td>{{ item.检修对象 }}</td>
            <td>{{ item.检修类别 }}</td>
            <td>{{ item.预警结论 }}</td>
            <td>{{ item.检修班组 }}</td>
            <td><span class="tag" :class="item.status === '待安排' ? 'fail' : 'ok'">{{ item.status }}</span></td>
            <td class="row-actions">
              <button v-if="item.status === '待安排'" class="link" type="button" @click="doArrange(item.id)">安排检修班组</button>
              <button v-if="item.status !== '已完工'" class="link" type="button" @click="doComplete(item.id)">确认完工</button>
              <span v-else class="code">{{ item.来源批次 }}</span>
            </td>
          </tr>
          <tr v-if="!maintenanceTodos.length">
            <td colspan="7" class="empty-state">暂无沉降超限触发的检修待安排</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ============ 值班待办 + 对账 ============ -->
    <div v-else-if="activeTab === 'duty'" class="panel">
      <p class="page-desc">预警结论同步进值班台账的待办，逐条办结；底部对账口径与概览卡片一致。</p>
      <table class="data-table">
        <thead>
          <tr><th>待办编号</th><th>监测断面</th><th>监测日期</th><th>事项</th><th>关联检修</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="todo in dutyTodos" :key="todo.id">
            <td>{{ todo.待办编号 }}</td>
            <td>{{ todo.监测断面 }}</td>
            <td>{{ todo.监测日期 }}</td>
            <td>{{ todo.事项 }}</td>
            <td>{{ todo.检修编号 }}</td>
            <td><span class="tag" :class="todo.status === '待办' ? 'fail' : 'ok'">{{ todo.status }}</span></td>
            <td class="row-actions">
              <button v-if="todo.status === '待办'" class="link" type="button" @click="doSettle(todo.id)">办结待办</button>
            </td>
          </tr>
          <tr v-if="!dutyTodos.length">
            <td colspan="7" class="empty-state">暂无沉降预警值班待办</td>
          </tr>
        </tbody>
      </table>
      <p class="reconcile" :class="{ ok: summary.reconciled, bad: !summary.reconciled }">
        对账：检修在办 {{ summary.pendingMaintenance }} ＝ 值班待办 {{ summary.pendingDuty }}
        （新口径累计超限 {{ summary.warningByNew }}，办结后两边同步归零）——
        {{ summary.reconciled ? '一致' : '不一致' }}
      </p>
    </div>

    <!-- ============ 待补清单 ============ -->
    <div v-else-if="activeTab === 'backlog'" class="panel">
      <p class="page-desc">存量成果按设备投运日期回填时，累计沉降量等关键项缺失的集中在此，补齐后随测次走「存量补录」重交。</p>
      <table class="data-table">
        <thead>
          <tr><th>监测编号</th><th>监测断面</th><th>监测日期</th><th>缺失项</th><th>来源</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in backlogItems" :key="item.id" :class="{ resolved: item.resolved }">
            <td>{{ item.监测编号 }}</td>
            <td>{{ item.监测断面 }}</td>
            <td>{{ item.监测日期 }}</td>
            <td>{{ item.missingFields.join('、') }}</td>
            <td>{{ item.sourceBatchId === 'LEGACY-BACKFILL' ? '存量回填' : '存量补录批次' }}</td>
            <td><span class="tag" :class="item.resolved ? 'ok' : 'fail'">{{ item.resolved ? '已补齐' : '待补' }}</span></td>
            <td><button v-if="!item.resolved" class="link" type="button" @click="onBacklogResolved(item.id)">测绘队已补数，标记已补齐</button></td>
          </tr>
          <tr v-if="!backlogItems.length">
            <td colspan="7" class="empty-state">暂无缺失待补项</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ============ 规则说明 ============ -->
    <div v-else-if="activeTab === 'rules'" class="panel rules-panel">
      <h3>整组处理规则与取舍依据</h3>
      <ol>
        <li><strong>自然键与去重：</strong>以「监测断面＋监测日期（测次）」为唯一键。同一断面同一测次在一笔里出现两次，只认先填的一条，另一条回执为「批内重复舍弃」。</li>
        <li><strong>先落者得（并发兜底）：</strong>同一行被两笔同时提交，只认先落库的一笔，另一笔在落库前命中唯一键，回执「重复挡回」。纯前端为同步线程，提交按到达顺序串行判定，等价于后端唯一索引＋行锁的兜底效果。</li>
        <li><strong>提交前阻断式检查：</strong>监测编号重号（同编号对应不同断面/测次）、新测次累计沉降量缺失或非数值、日期非法、缺阈值、新口径误填切换日前日期，均为阻断项；检查不通过整批不落库。存量补录的累计沉降量缺失不是阻断项，转待补清单。</li>
        <li><strong>同批事务：</strong>入库、超限标记、检修回写、值班待办在一次提交内算完后统一落盘，要么整批生效要么不生效；每条各自回执。</li>
        <li><strong>超限判定与回写：</strong>新口径下累计沉降量 ≥ 预警阈值即挂「超限预警」，结论同步写进设施检修清单（状态「待安排」），并在值班台账生成同来源键待办；检修安排/办结时值班待办同步。</li>
        <li><strong>两条路径的先后与冲突：</strong>上线先执行存量回填（按设备投运日期→监测日期排序、幂等），再开放切换日 {{ cutover }} 起的新口径整组提交。存量沿用测绘队原结论，不按新阈值溯及、不补生待办；切换日起的新测次才自动判定并联动。两条路径共用同一落库台账与唯一键，后提交的同一断面测次一律「重复挡回」，因此回填与新提交不会产生两条结论。</li>
        <li><strong>缺失项：</strong>历史回填缺失累计沉降量的不入台账，集中列待补清单，测绘队补齐后随该测次补录。</li>
        <li><strong>对账与一致读数：</strong>每条新口径超限在未办结阶段都对应恰好一条检修在办与一条值班待办，安排/办结时两侧同步，故「检修在办数 ＝ 值班待办数」恒成立，这就是与值班台账的对账口径；累计超限数单独展示。概览卡片、台账、报表、对账全部从同一落库台账派生，不另存计数，汇总与报表读数一致。</li>
      </ol>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  arrangeMaintenance,
  completeMaintenance,
  exportSettlementReport,
  listBacklog,
  listDutyTodos,
  listLedger,
  listMaintenanceTodos,
  markResolved,
  parseObservationTable,
  resetSettlement,
  settleDutyTodo,
  settlementSummary,
  submitBatch,
  validateBatch,
} from '@/api/settlement-service'
import { CUTOVER_DATE } from '@/data/settlement/types'
import type {
  BacklogItem,
  BatchSubmitResult,
  DutyTodo,
  MaintenanceTodo,
  ObservationInput,
  SettlementObservation,
} from '@/data/settlement/types'

const cutover = CUTOVER_DATE

type RowDraft = ObservationInput

const roundDate = ref(CUTOVER_DATE)
const observer = ref('测绘一队')
const defaultThreshold = ref('20')
const rows = ref<RowDraft[]>([])
const pasteText = ref('')

const activeTab = ref('submit')
const ledgerRows = ref<SettlementObservation[]>([])
const maintenanceTodos = ref<MaintenanceTodo[]>([])
const dutyTodos = ref<DutyTodo[]>([])
const backlogItems = ref<BacklogItem[]>([])
const ledgerFilter = ref('')
const caliberFilter = ref('')

const checkReport = ref<ReturnType<typeof validateBatch> | null>(null)
const lastResult = ref<BatchSubmitResult | null>(null)

const summary = ref(settlementSummary())

const tabs = computed(() => [
  { key: 'submit', label: '整组提交', badge: 0 },
  { key: 'ledger', label: `观测台账（${summary.value.total}）`, badge: 0 },
  { key: 'maintenance', label: '预警检修清单', badge: summary.value.pendingMaintenance },
  { key: 'duty', label: '值班待办对账', badge: summary.value.pendingDuty },
  { key: 'backlog', label: '缺失待补', badge: summary.value.openBacklog },
  { key: 'rules', label: '规则说明', badge: 0 },
])

const caliberHint = computed(() => {
  const date = roundDate.value.trim()
  if (!date) return { title: '先填本批测次日期', body: '日期决定走新口径还是存量补录。', cls: '' }
  if (date < CUTOVER_DATE) {
    return {
      title: '路径 B · 存量补录',
      body: `日期早于切换日 ${CUTOVER_DATE}：沿用测绘队原结论，不按新阈值溯及、不生成待办；累计沉降量缺失转待补清单。`,
      cls: 'legacy',
    }
  }
  return {
    title: '路径 A · 新口径整组提交',
    body: `切换日 ${CUTOVER_DATE} 起：累计沉降量达阈值自动挂超限预警，回写检修清单并生成值班待办。`,
    cls: 'new',
  }
})
const caliberClass = computed(() => caliberHint.value.cls)

const checkedBlocking = computed(() => checkReport.value?.blocking ?? false)

const filteredLedger = computed(() => {
  const keyword = ledgerFilter.value.trim()
  return [...ledgerRows.value]
    .sort((a, b) => b.监测日期.localeCompare(a.监测日期) || a.监测断面.localeCompare(b.监测断面))
    .filter((row) => {
      if (caliberFilter.value && row.caliber !== caliberFilter.value) return false
      if (!keyword) return true
      return row.监测断面.includes(keyword) || row.监测编号.includes(keyword)
    })
})

function blankRow(): RowDraft {
  return {
    监测编号: '',
    监测断面: '',
    累计沉降量: '',
    沉降速率: '',
    预警阈值: defaultThreshold.value,
    监测日期: roundDate.value,
    监测人员: observer.value,
  }
}

function addRow() {
  rows.value.push(blankRow())
  checkReport.value = null
}

function sampleRows(): RowDraft[] {
  const date = roundDate.value
  const person = observer.value
  const threshold = defaultThreshold.value
  return [
    { 监测编号: 'SETT-0301', 监测断面: 'DM-01 人民路段', 累计沉降量: '6.1', 沉降速率: '0.04', 预警阈值: threshold, 监测日期: date, 监测人员: person },
    { 监测编号: 'SETT-0302', 监测断面: 'DM-02 解放路段', 累计沉降量: '4.2', 沉降速率: '0.05', 预警阈值: threshold, 监测日期: date, 监测人员: person },
    { 监测编号: 'SETT-0303', 监测断面: 'DM-03 建设大街段', 累计沉降量: '21.4', 沉降速率: '0.62', 预警阈值: '10', 监测日期: date, 监测人员: person },
    { 监测编号: 'SETT-0304', 监测断面: 'DM-04 滨江路段', 累计沉降量: '2.8', 沉降速率: '0.03', 预警阈值: threshold, 监测日期: date, 监测人员: person },
  ]
}

function importPaste() {
  const parsed = parseObservationTable(pasteText.value, roundDate.value)
  if (!parsed.length) return
  rows.value.push(...parsed.map((item) => ({ ...blankRow(), ...item })))
  pasteText.value = ''
  checkReport.value = null
}

function normalizedRows(): ObservationInput[] {
  return rows.value.map((row) => ({
    ...row,
    监测日期: row.监测日期.trim() || roundDate.value,
    监测人员: row.监测人员.trim() || observer.value,
    预警阈值: row.预警阈值.trim() || defaultThreshold.value,
  }))
}

function runCheck() {
  if (!rows.value.length) {
    checkReport.value = null
    return
  }
  checkReport.value = validateBatch(normalizedRows())
}

function doSubmit() {
  const outcome = submitBatch(normalizedRows())
  if (!outcome.committed) {
    checkReport.value = outcome.report
    lastResult.value = null
    return
  }
  lastResult.value = outcome.result
  checkReport.value = null
  rows.value = []
  refreshAll()
}

function doArrange(id: number) {
  arrangeMaintenance(id)
  refreshAll()
}
function doComplete(id: number) {
  completeMaintenance(id)
  refreshAll()
}
function doSettle(id: number) {
  settleDutyTodo(id)
  refreshAll()
}
function onBacklogResolved(id: number) {
  markResolved(id)
  refreshAll()
}

function reloadLedger() {
  ledgerRows.value = listLedger()
}

function refreshAll() {
  summary.value = settlementSummary()
  ledgerRows.value = listLedger()
  maintenanceTodos.value = listMaintenanceTodos()
  dutyTodos.value = listDutyTodos()
  backlogItems.value = listBacklog()
}

function exportReport() {
  const { filename, content } = exportSettlementReport()
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function resetAll() {
  resetSettlement()
  rows.value = []
  checkReport.value = null
  lastResult.value = null
  refreshAll()
}

onMounted(refreshAll)
</script>
