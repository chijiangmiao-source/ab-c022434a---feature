/**
 * 页面主控：录入探针范围与有向观测边，通过 Web Worker 发起精确复核，
 * 渲染相位面结论或定位输入错误；复核成功后可发起最优解归属审计。
 *
 * 状态一致性：
 *  - 每次“发起复核”得到新的 runId；只有携带当前 runId 的结果允许上屏，
 *    Worker 返回的过期结果直接丢弃。
 *  - 草稿一旦修改（探针数/范围/边字段），立即作废 runId、中止 Worker 内
 *    旧计算并清除屏幕上的旧结论与归属审计，保证旧计算不可能覆盖当前状态。
 *  - 归属审计只对当前上屏的成功复核代际发起并接受；草稿编辑、取消或新复核
 *    会同时作废 Worker 内的残量网络现场，代际不匹配的审计回执直接丢弃。
 */
import './styles.css';
import SolverWorker from '../worker/solver.worker.js?worker';

const $ = (sel) => document.querySelector(sel);

const els = {
  probeCount: $('#probeCount'),
  referenceIdx: $('#referenceIdx'),
  probeTable: $('#probeTable'),
  edgeTable: $('#edgeTable'),
  edgeCount: $('#edgeCount'),
  addEdge: $('#addEdge'),
  runBtn: $('#runBtn'),
  cancelBtn: $('#cancelBtn'),
  auditBtn: $('#auditBtn'),
  statusLine: $('#statusLine'),
  resultPanel: $('#resultPanel'),
  errorList: $('#errorList'),
  resultBody: $('#resultBody'),
  loadSampleA: $('#loadSampleA'),
  loadSampleB: $('#loadSampleB'),
  loadSampleC: $('#loadSampleC'),
  setAllRanges: $('#setAllRanges'),
};

// ---- 草稿状态 ---------------------------------------------------------------
/** 探针范围行：[{lo, hi}]，字符串保留原始录入以便定位 */
let probeRows = [];
/** 观测边行：[{u, v, target, weight}] 均为字符串 */
let edgeRows = [];

/** 客户端代际令牌：自增即作废旧运行 */
let runId = 0;
let worker = null;
let computing = false;
/** 当前上屏的成功复核结论；草稿/取消/新复核时置空，审计按钮据此启停 */
let currentResult = null;
/** 归属审计状态：'idle' | 'pending' | 'done' */
let auditState = 'idle';
let currentAudit = null;

function workerEnsure() {
  if (!worker) {
    worker = new SolverWorker();
    worker.onmessage = onWorkerMessage;
    worker.onerror = (e) => {
      worker = null; // 允许下一次复核新建 Worker
      computing = false;
      // Worker 崩溃后残量现场随之消失，在途审计只能作废。
      auditState = 'idle';
      currentAudit = null;
      refreshButtons();
      setStatus(`Worker 错误：${e.message}`, 'bad');
    };
  }
  return worker;
}

function onWorkerMessage(ev) {
  const msg = ev.data;
  // 过期代际的一切回传（含 canceled/audited/auditStale）均丢弃，
  // 不允许触碰当前界面。
  if (msg.id !== runId) return;

  if (msg.type === 'canceled') {
    computing = false;
    refreshButtons();
    setStatus('计算已取消。', 'muted');
    return;
  }

  if (msg.type === 'done') {
    computing = false;
    refreshButtons();
    renderResult(msg.result);
    return;
  }

  if (msg.type === 'auditStale') {
    // Worker 侧残量网络现场已作废（草稿编辑/取消/新复核），审计拒绝。
    if (auditState !== 'pending') return;
    auditState = 'idle';
    refreshButtons();
    setStatus('归属审计已作废：复核代际已变更，请重新发起复核。', 'bad');
    return;
  }

  if (msg.type === 'audited') {
    if (auditState !== 'pending') return;
    auditState = 'done';
    refreshButtons();
    renderAudit(msg.audit);
  }
}

// ---- 整数录入解析 -----------------------------------------------------------
function parseIntStrict(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- 探针表 -----------------------------------------------------------------
function rebuildProbeRows(keepCount) {
  const next = [];
  for (let i = 0; i < keepCount; i++) {
    next.push(probeRows[i] ? { ...probeRows[i] } : { lo: '-5', hi: '5' });
  }
  probeRows = next;
  // 参考探针的默认范围始终包含 0。
  renderProbeTable();
}

function renderProbeTable() {
  const ref = parseIntStrict(els.referenceIdx.value);
  els.probeTable.innerHTML = probeRows
    .map((p, i) => {
      const isRef = i === ref;
      return `
      <tr data-probe="${i}" class="${isRef ? 'ref-row' : ''}">
        <td class="mono">${i}${isRef ? ' <span class="badge">参考 · 固定 0</span>' : ''}</td>
        <td><input data-field="lo" inputmode="numeric" value="${escapeHtml(p.lo)}" /></td>
        <td><input data-field="hi" inputmode="numeric" value="${escapeHtml(p.hi)}" /></td>
      </tr>`;
    })
    .join('');
}

// ---- 边表 -------------------------------------------------------------------
function renderEdgeTable() {
  els.edgeCount.textContent = `共 ${edgeRows.length} 条观测边`;
  els.edgeTable.innerHTML = edgeRows
    .map(
      (e, i) => `
      <tr data-edge="${i}">
        <td class="mono dim">${i + 1}</td>
        <td><input data-field="u" inputmode="numeric" value="${escapeHtml(e.u)}" /></td>
        <td><input data-field="v" inputmode="numeric" value="${escapeHtml(e.v)}" /></td>
        <td><input data-field="target" inputmode="numeric" value="${escapeHtml(e.target)}" /></td>
        <td><input data-field="weight" inputmode="numeric" value="${escapeHtml(e.weight)}" /></td>
        <td><button type="button" class="link danger-text" data-action="delEdge">删除</button></td>
      </tr>`,
    )
    .join('');
}

// ---- 状态条与按钮 -----------------------------------------------------------
function setStatus(text, kind = '') {
  els.statusLine.textContent = text;
  els.statusLine.className = `status ${kind}`;
}

function refreshButtons() {
  els.runBtn.disabled = computing;
  els.cancelBtn.disabled = !computing;
  // 归属审计仅在成功结论上屏、当前没有审计在途时可发起。
  els.auditBtn.disabled = computing || !currentResult || auditState === 'pending';
  els.auditBtn.textContent = auditState === 'pending' ? '归属审计计算中……' : '发起最优解归属审计';
}

/**
 * 作废当前运行：客户端代际自增 + 通知 Worker 中止 + 清除旧结论。
 * @param silent true=草稿失效类取消（Worker 静默不回执，避免覆盖此处
 *   已设置的状态）；false=用户显式取消，回执后显示“已取消”。
 */
function invalidateRunning(clearPanel = true, statusText = null, silent = true) {
  runId++;
  if (worker) worker.postMessage({ type: 'cancel', id: runId, silent });
  computing = false;
  // 草稿编辑 / 取消 / 新复核必须立即作废归属审计及其残量网络现场。
  currentResult = null;
  currentAudit = null;
  auditState = 'idle';
  refreshButtons();
  if (clearPanel) {
    els.resultPanel.hidden = true;
    els.resultBody.innerHTML = '';
    els.errorList.innerHTML = '';
    clearHighlights();
  }
  if (statusText !== null) setStatus(statusText, 'muted');
}

function clearHighlights() {
  document.querySelectorAll('tr.bad-row').forEach((tr) => tr.classList.remove('bad-row'));
  document.querySelectorAll('input.bad-input').forEach((inp) => inp.classList.remove('bad-input'));
}

// ---- 收集输入 ---------------------------------------------------------------
function collectInput() {
  const count = probeRows.length;
  const reference = parseIntStrict(els.referenceIdx.value);
  const probes = probeRows.map((p) => ({ lo: parseIntStrict(p.lo), hi: parseIntStrict(p.hi) }));
  const edges = edgeRows.map((e) => ({
    u: parseIntStrict(e.u),
    v: parseIntStrict(e.v),
    target: parseIntStrict(e.target),
    weight: parseIntStrict(e.weight),
  }));
  return { count, reference, probes, edges };
}

// ---- 结果渲染 ---------------------------------------------------------------
function renderResult(result) {
  clearHighlights();
  els.resultPanel.hidden = false;

  if (!result.ok) {
    // 输入错误：定位到具体探针/边并清除旧结论（面板只显示错误）。
    currentResult = null;
    currentAudit = null;
    auditState = 'idle';
    refreshButtons();
    els.resultBody.innerHTML = '';
    highlightErrors(result.errors);
    els.errorList.innerHTML = `
      <div class="error-banner">复核未执行：发现 ${result.errors.length} 处输入问题，旧结论已清除。</div>
      <ul class="error-items">
        ${result.errors
          .map(
            (e) => `<li><span class="tag tag-${e.kind}">${errorKindLabel(e.kind)}</span> ${escapeHtml(e.message)}</li>`,
          )
          .join('')}
      </ul>`;
    setStatus('输入校验未通过。', 'bad');
    return;
  }

  els.errorList.innerHTML = '';
  // 新的成功结论上屏：归属审计回到未发起状态，等待校准员点击。
  currentResult = result;
  currentAudit = null;
  auditState = 'idle';
  refreshButtons();
  const ref = result.reference;
  const phasesHtml = result.phases
    .map(
      (x, i) => `
      <tr>
        <td class="mono">${i}${i === ref ? ' <span class="badge">参考</span>' : ''}</td>
        <td class="mono phase">${x}</td>
      </tr>`,
    )
    .join('');

  const edgesHtml = result.edges
    .map(
      (e, idx) => `
      <tr>
        <td class="mono dim">${idx + 1}</td>
        <td class="mono">${e.u} → ${e.v}</td>
        <td class="mono">${e.target}</td>
        <td class="mono">${e.weight}</td>
        <td class="mono ${e.actual === e.target ? 'good' : ''}">${e.actual}</td>
        <td class="mono ${e.residual === 0 ? 'good' : 'warn'}">${formatSigned(e.residual)}</td>
        <td class="mono ${e.contribution === 0 ? 'good' : 'warn'}">${e.contribution}</td>
      </tr>`,
    )
    .join('');

  els.resultBody.innerHTML = `
    <div class="summary">
      <div class="summary-card">
        <div class="summary-label">最优总代价（加权绝对值和）</div>
        <div class="summary-value">${result.cost}</div>
      </div>
      <div class="summary-note">
        该赋值为所有范围内整数赋值中的精确最优；同成本下已按探针标识升序
        取字典序最小的相位向量。
      </div>
    </div>
    <h3>各探针整数相位</h3>
    <table class="grid result-phases">
      <thead><tr><th>探针标识</th><th>相位 x<sub>i</sub></th></tr></thead>
      <tbody>${phasesHtml}</tbody>
    </table>
    <h3>各观测边复核明细</h3>
    <table class="grid result-edges">
      <thead>
        <tr>
          <th>#</th><th>有向边</th><th>目标差值</th><th>权重</th>
          <th>实际差 x<sub>v</sub>−x<sub>u</sub></th>
          <th>残差（实际−目标）</th><th>贡献 w·|残差|</th>
        </tr>
      </thead>
      <tbody>${edgesHtml}</tbody>
    </table>
    <div id="auditMount"></div>`;
  setStatus(`复核完成：最优总代价 ${result.cost}。`, 'good');
}

// ---- 归属审计渲染 -----------------------------------------------------------
const AUDIT_STATUS_LABEL = {
  fixed: '固定',
  variable: '可变',
  reference: '参考点固定',
};

function renderAudit(audit) {
  const mount = document.querySelector('#auditMount');
  if (!mount) return;

  if (!audit.ok) {
    currentAudit = null;
    mount.innerHTML = `
      <h3>最优解归属审计</h3>
      <div class="error-banner">归属审计未完成：${escapeHtml(
        audit.errors?.map((e) => e.message).join('；') || '未知内部错误',
      )}</div>`;
    setStatus('归属审计发生内部错误。', 'bad');
    return;
  }

  currentAudit = audit;
  const ref = audit.reference;
  const rowsHtml = audit.probes
    .map((r) => {
      const isRef = r.i === ref;
      const single = r.min === r.max;
      return `
      <tr data-audit-probe="${r.i}" class="audit-row ${single ? '' : 'audit-variable'}">
        <td class="mono">${r.i}${isRef ? ' <span class="badge">参考</span>' : ''}</td>
        <td class="mono phase">${r.phase}</td>
        <td class="mono">${r.min}</td>
        <td class="mono ${single ? '' : 'warn'}">${r.max}</td>
        <td><span class="audit-tag audit-${r.status}">${AUDIT_STATUS_LABEL[r.status]}</span></td>
      </tr>`;
    })
    .join('');

  mount.innerHTML = `
    <h3>最优解归属审计（同一次最小割残量网络 · SCC 偏序）</h3>
    <p class="hint">
      下表给出每个探针在<strong>保持最小总代价 ${audit.cost} 不变</strong>时可取到的完整整数相位区间：
      规范相位为字典序最小最优解；最小值取自最小最小割（S 残量可达集），
      最大值取自最大最小割（不可达 T 的最大闭包）。点选任一探针行，
      查看使其取到区间两端值的最小割侧判定。
    </p>
    <table class="grid audit-table">
      <thead>
        <tr>
          <th>探针标识</th><th>规范相位</th><th>最小值</th><th>最大值</th><th>状态</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div id="auditDetail"></div>`;
  setStatus(`归属审计完成：最小总代价 ${audit.cost} 下各探针相位区间已给出。`, 'good');

  // 默认点选规范解所在行，便于立即查看侧判定说明。
  const first = mount.querySelector('tr[data-audit-probe]');
  if (first) showAuditDetail(Number(first.dataset.auditProbe));
}

/** 点选探针：列出使其取到区间最小/最大值的最小割侧判定 */
function showAuditDetail(i) {
  const detail = document.querySelector('#auditDetail');
  if (!detail || !currentAudit) return;
  const r = currentAudit.probes[i];
  if (!r) return;

  document.querySelectorAll('tr[data-audit-probe]').forEach((tr) => {
    tr.classList.toggle('selected', Number(tr.dataset.auditProbe) === i);
  });

  const fmtRange = (a, b) => (a > b ? '（空）' : `${a}…${b}`);
  const forcedSrc = r.lo >= r.forcedSourceUpTo ? '（空）' : `[${r.lo + 1}, ${r.forcedSourceUpTo}]`;
  const freeWin = single ? '（空：单点区间）' : `[${r.min + 1}, ${r.max}]`;
  const forcedSnk = r.forcedSinkFrom > r.hi ? '（空）' : `[${r.forcedSinkFrom}, ${r.hi}]`;

  // 自由 SCC 的联动成员（同一强连通分量必须同时翻转）。
  const couplingLines = [];
  const seenComp = new Set();
  for (const f of r.freeThresholds) {
    if (seenComp.has(f.comp)) continue;
    seenComp.add(f.comp);
    const others = (f.members || []).filter((m) => m !== `${i}@${f.k}`);
    couplingLines.push(
      `<li>阈值节点 (探针 ${i}, k=${f.k})${
        others.length ? ` 与 ${others.map((m) => `<code>${escapeHtml(m)}</code>`).join('、')} 同属一个自由强连通分量，取侧必须一致` : ' 独占一个自由强连通分量'
      }；分量之间还受残量偏序闭包约束，故各探针区间须<strong>联合</strong>取值，不能逐探针独立枚举。</li>`,
    );
  }

  const single = r.min === r.max;
  detail.innerHTML = `
    <div class="audit-detail">
      <div class="audit-detail-title">
        探针 ${i}${i === currentAudit.reference ? '（参考探针，钉死为 0）' : ''}：
        规范相位 <span class="mono">${r.phase}</span>，
        同成本区间 <span class="mono ${single ? '' : 'warn'}">[${r.min}, ${r.max}]</span>，
        状态「${AUDIT_STATUS_LABEL[r.status]}」
      </div>
      <table class="grid audit-cutgrid">
        <thead>
          <tr><th>阈值 k 区间</th><th>取到最小值 ${r.min} 时的割侧</th><th>取到最大值 ${r.max} 时的割侧</th><th>判定依据（残量网络）</th></tr>
        </thead>
        <tbody>
          <tr>
            <td class="mono">k ∈ ${forcedSrc}</td>
            <td>源侧（z=1，x≥k）</td>
            <td>源侧（z=1，x≥k）</td>
            <td>SCC 由源点 S 沿残量弧可达：<strong>一切</strong>最小割均强制源侧</td>
          </tr>
          <tr class="${single ? 'dim-row' : ''}">
            <td class="mono">k ∈ ${freeWin}</td>
            <td>汇侧（z=0）</td>
            <td>源侧（z=1）</td>
            <td>自由 SCC：S 不可达、也不可达 T，可在偏序闭包内翻转；最小最小割取汇侧，最大最小割取源侧</td>
          </tr>
          <tr>
            <td class="mono">k ∈ ${forcedSnk}</td>
            <td>汇侧（z=0）</td>
            <td>汇侧（z=0）</td>
            <td>SCC 沿残量弧可达汇点 T：<strong>一切</strong>最小割均强制汇侧</td>
          </tr>
        </tbody>
      </table>
      <p class="hint">
        解码：源侧阈值的最大 k 即相位 x<sub>${i}</sub>。取最小端时仅强制源侧区间
        <span class="mono">${forcedSrc}</span> 在源侧（窗口 ${fmtRange(r.min + 1, r.max)} 全部汇侧）⇒
        x<sub>${i}</sub>=${r.min}；取最大端时自由窗口也翻到源侧 ⇒ x<sub>${i}</sub>=${r.max}。
        两端割均经整数复算核对，总代价均为 ${currentAudit.cost}。
      </p>
      ${couplingLines.length ? `<ul class="audit-coupling">${couplingLines.join('')}</ul>` : ''}
    </div>`;
}

function formatSigned(n) {
  return n > 0 ? `+${n}` : `${n}`;
}

function errorKindLabel(kind) {
  return (
    {
      count: '探针数',
      reference: '参考点',
      range: '范围',
      edge: '观测边',
      internal: '内部错误',
    }[kind] || '输入'
  );
}

function highlightErrors(errors) {
  for (const e of errors) {
    if ((e.kind === 'range' || (e.kind === 'reference' && e.field === 'range')) && Number.isInteger(e.index)) {
      const tr = els.probeTable.querySelector(`tr[data-probe="${e.index}"]`);
      if (tr) {
        tr.classList.add('bad-row');
        if (e.field === 'bounds') {
          tr.querySelector('input[data-field="lo"]')?.classList.add('bad-input');
          tr.querySelector('input[data-field="hi"]')?.classList.add('bad-input');
        } else {
          // 空范围或 0 越界：上下界同时标红
          tr.querySelector('input[data-field="lo"]')?.classList.add('bad-input');
          tr.querySelector('input[data-field="hi"]')?.classList.add('bad-input');
        }
      }
    }
    if (e.kind === 'edge' && Number.isInteger(e.index)) {
      const tr = els.edgeTable.querySelector(`tr[data-edge="${e.index}"]`);
      if (tr && e.field) {
        tr.classList.add('bad-row');
        tr.querySelector(`input[data-field="${e.field}"]`)?.classList.add('bad-input');
      }
    }
    if (e.kind === 'reference' && e.field === 'index') {
      els.referenceIdx.classList.add('bad-input');
    }
    if (e.kind === 'count') {
      els.probeCount.classList.add('bad-input');
    }
  }
}

// ---- 发起复核 / 取消 --------------------------------------------------------
function runReview() {
  const input = collectInput();
  const id = ++runId;
  computing = true;
  // 发起新复核即撤下旧结论与归属审计，避免计算期间展示过期补偿面。
  currentResult = null;
  currentAudit = null;
  auditState = 'idle';
  refreshButtons();
  clearHighlights();
  els.resultPanel.hidden = true;
  els.resultBody.innerHTML = '';
  els.errorList.innerHTML = '';
  setStatus('Worker 计算中：整数最小割求解，请稍候……', 'pending');
  workerEnsure().postMessage({ type: 'solve', id, input });
}

function cancelReview() {
  invalidateRunning(true, '计算已取消，旧结论已清除。', false);
}

// ---- 发起最优解归属审计 -----------------------------------------------------
function requestAudit() {
  // 仅在当前成功复核上屏时可发起；Worker 侧同样校验代际与残量现场。
  if (!currentResult || auditState === 'pending') return;
  auditState = 'pending';
  refreshButtons();
  setStatus('归属审计进行中：在同一次最小割残量网络上构造 SCC 偏序……', 'pending');
  workerEnsure().postMessage({ type: 'audit', id: runId });
}

// 审计表动态渲染，事件委托：点选探针行查看两端割侧判定。
document.addEventListener('click', (ev) => {
  const tr = ev.target.closest('tr[data-audit-probe]');
  if (!tr) return;
  showAuditDetail(Number(tr.dataset.auditProbe));
});

// ---- 样例 -------------------------------------------------------------------
function loadSample(kind) {
  invalidateRunning(true, '已载入样例，旧结论已清除。');
  if (kind === 'A') {
    // 闭环矛盾三角形。按边录入顺序贪心选生成树 {0→1, 0→2} 做局部累加：
    // x=(0,1,1)，高权边 1→2（w=10）残差 -1，代价 10；
    // 精确最优 x=(0,1,2)：仅低权弦 0→2（w=1）残差 1，代价 1。
    els.probeCount.value = '3';
    els.referenceIdx.value = '0';
    probeRows = [
      { lo: '0', hi: '0' },
      { lo: '0', hi: '3' },
      { lo: '0', hi: '3' },
    ];
    edgeRows = [
      { u: '0', v: '1', target: '1', weight: '10' },
      { u: '0', v: '2', target: '1', weight: '1' },
      { u: '1', v: '2', target: '1', weight: '10' },
    ];
  } else if (kind === 'C') {
    // 等权闭环矛盾：三条边权重相同，闭环残差之和恒为 1，无论把唯一的
    // 残差放在哪条边上总代价都为 1 ⇒ 存在同成本多相位面。
    // 最优面有 (0,1,1)、(0,1,2)、(0,2,2)（字典序规范解为前者）；
    // (0,2,1) 残差和为 3、代价 3，被最小割格偏序闭包排除。归属审计中
    // 探针 1、2 应显示可变区间 [1,2]，探针 0（参考）为单点。
    els.probeCount.value = '3';
    els.referenceIdx.value = '0';
    probeRows = [
      { lo: '0', hi: '0' },
      { lo: '0', hi: '3' },
      { lo: '0', hi: '3' },
    ];
    edgeRows = [
      { u: '0', v: '1', target: '1', weight: '1' },
      { u: '1', v: '2', target: '0', weight: '1' },
      { u: '2', v: '0', target: '-2', weight: '1' },
    ];
  } else {
    // 四环：沿生成树 0→1→2→3 局部累加得 (0,1,2,3)，违背高权闭合边，
    // 代价 10；精确最优 (0,1,2,2)，代价 1。
    els.probeCount.value = '4';
    els.referenceIdx.value = '0';
    probeRows = [
      { lo: '0', hi: '0' },
      { lo: '-3', hi: '5' },
      { lo: '-3', hi: '5' },
      { lo: '-3', hi: '5' },
    ];
    edgeRows = [
      { u: '0', v: '1', target: '1', weight: '1' },
      { u: '1', v: '2', target: '1', weight: '1' },
      { u: '2', v: '3', target: '1', weight: '1' },
      { u: '3', v: '0', target: '-2', weight: '10' },
    ];
  }
  renderProbeTable();
  renderEdgeTable();
}

// ---- 事件绑定 ---------------------------------------------------------------
els.probeCount.addEventListener('change', () => {
  let n = parseIntStrict(els.probeCount.value);
  if (n === null || n < 2) n = 2;
  if (n > 40) n = 40;
  els.probeCount.value = String(n);
  invalidateRunning(true, '探针数量已修改，旧结论已清除。');
  rebuildProbeRows(n);
});

els.referenceIdx.addEventListener('change', () => {
  invalidateRunning(true, '参考探针已修改，旧结论已清除。');
  renderProbeTable();
});

els.probeTable.addEventListener('input', (ev) => {
  const tr = ev.target.closest('tr[data-probe]');
  if (!tr) return;
  const i = Number(tr.dataset.probe);
  probeRows[i][ev.target.dataset.field] = ev.target.value;
  invalidateRunning(true, '草稿已修改，上一次计算与旧结论已作废。');
});

els.addEdge.addEventListener('click', () => {
  edgeRows.push({ u: '0', v: '1', target: '0', weight: '1' });
  invalidateRunning(true, '已新增观测边，上一次计算与旧结论已作废。');
  renderEdgeTable();
});

els.edgeTable.addEventListener('input', (ev) => {
  const tr = ev.target.closest('tr[data-edge]');
  if (!tr) return;
  const i = Number(tr.dataset.edge);
  edgeRows[i][ev.target.dataset.field] = ev.target.value;
  invalidateRunning(true, '草稿已修改，上一次计算与旧结论已作废。');
});

els.edgeTable.addEventListener('click', (ev) => {
  if (ev.target.dataset.action !== 'delEdge') return;
  const tr = ev.target.closest('tr[data-edge]');
  const i = Number(tr.dataset.edge);
  edgeRows.splice(i, 1);
  invalidateRunning(true, '观测边已删除，旧结论已清除。');
  renderEdgeTable();
});

els.setAllRanges.addEventListener('click', () => {
  const lo = window.prompt('批量设置所有非参考探针的整数下界：', '-5');
  if (lo === null) return;
  const hi = window.prompt('批量设置所有非参考探针的整数上界：', '5');
  if (hi === null) return;
  if (parseIntStrict(lo) === null || parseIntStrict(hi) === null) {
    setStatus('批量设置失败：上下界必须是整数。', 'bad');
    return;
  }
  const ref = parseIntStrict(els.referenceIdx.value);
  for (let i = 0; i < probeRows.length; i++) {
    if (i !== ref) probeRows[i] = { lo, hi };
  }
  invalidateRunning(true, '范围已批量修改，旧结论已清除。');
  renderProbeTable();
});

els.runBtn.addEventListener('click', runReview);
els.cancelBtn.addEventListener('click', cancelReview);
els.auditBtn.addEventListener('click', requestAudit);
els.loadSampleA.addEventListener('click', () => loadSample('A'));
els.loadSampleB.addEventListener('click', () => loadSample('B'));
els.loadSampleC.addEventListener('click', () => loadSample('C'));

// ---- 初始状态：闭环矛盾样例 -------------------------------------------------
loadSample('A');
setStatus('已载入示例数据，可直接发起复核。', 'muted');
