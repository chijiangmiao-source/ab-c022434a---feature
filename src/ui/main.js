/**
 * 页面主控：录入探针范围与有向观测边，通过 Web Worker 发起精确复核，
 * 渲染相位面结论或定位输入错误。
 *
 * 状态一致性：
 *  - 每次“发起复核”得到新的 runId；只有携带当前 runId 的结果允许上屏，
 *    Worker 返回的过期结果直接丢弃。
 *  - 草稿一旦修改（探针数/范围/边字段），立即作废 runId、中止 Worker 内
 *    旧计算并清除屏幕上的旧结论，保证旧计算不可能覆盖当前状态。
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
/** 归属审计请求是否飞行中（随复核代际一并作废） */
let auditing = false;
/** 当前展开割侧判定说明的探针（-1 表示无） */
let openAuditProbe = -1;

function workerEnsure() {
  if (!worker) {
    worker = new SolverWorker();
    worker.onmessage = onWorkerMessage;
    worker.onerror = (e) => {
      worker = null; // 允许下一次复核新建 Worker
      computing = false;
      auditing = false;
      refreshButtons();
      setStatus(`Worker 错误：${e.message}`, 'bad');
    };
  }
  return worker;
}

function onWorkerMessage(ev) {
  const msg = ev.data;
  // 过期代际的一切回传（含 canceled）均丢弃，不允许触碰当前界面。
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

  // 归属审计回传：代际校验已在上方完成（msg.id !== runId 直接丢弃），
  // 此处到达的必为当前成功复核代际的结果。
  if (msg.type === 'auditDone') {
    auditing = false;
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
  auditing = false; // 归属审计随复核代际一并作废
  openAuditProbe = -1;
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
    <h3>最优解归属审计</h3>
    <div class="audit-section">
      <p class="hint">
        在本次复核的同一残量网络上构造最小割格（强连通分量偏序），给出每个探针
        在保持当前最小总代价时可取到的完整整数相位区间；不重跑求解、不枚举赋值。
      </p>
      <button type="button" id="auditBtn" class="secondary">发起最优解归属审计</button>
      <div id="auditResult"></div>
    </div>`;
  $('#auditBtn').addEventListener('click', runAudit);
  setStatus(`复核完成：最优总代价 ${result.cost}。`, 'good');
}

// ---- 最优解归属审计 -----------------------------------------------------------
/** 发起归属审计：仅当当前存在成功复核结论（面板可见且非计算中）时可用。 */
function runAudit() {
  if (auditing || computing) return;
  auditing = true;
  openAuditProbe = -1;
  const btn = $('#auditBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '归属审计计算中……';
  }
  setStatus('Worker 计算中：在同一残量网络上构造最小割格……', 'pending');
  // 代际 = 当前成功复核的 runId；Worker 只对匹配的代际提交结果。
  workerEnsure().postMessage({ type: 'audit', id: runId });
}

function auditStatusBadge(status) {
  return (
    {
      fixed: '<span class="audit-tag tag-fixed">固定（单点）</span>',
      variable: '<span class="audit-tag tag-variable">可变区间</span>',
      reference: '<span class="audit-tag tag-reference">参考点固定</span>',
    }[status] || ''
  );
}

function renderAudit(audit) {
  const host = $('#auditResult');
  if (!host) return; // 面板已被作废清空
  const btn = $('#auditBtn');
  if (btn) {
    btn.disabled = false;
    btn.textContent = '重新发起最优解归属审计';
  }
  if (!audit.ok) {
    const msg = audit.errors && audit.errors.length ? audit.errors[0].message : '未知错误';
    host.innerHTML = `<div class="error-banner">归属审计失败：${escapeHtml(msg)}</div>`;
    setStatus('归属审计失败。', 'bad');
    return;
  }

  const rowsHtml = audit.probes
    .map(
      (p) => `
      <tr data-audit-probe="${p.index}" class="audit-row" title="点选查看最小割侧判定说明">
        <td class="mono">${p.index}${p.index === audit.reference ? ' <span class="badge">参考</span>' : ''}</td>
        <td class="mono phase">${p.canonical}</td>
        <td class="mono">${p.min}</td>
        <td class="mono">${p.max}</td>
        <td>${auditStatusBadge(p.status)}</td>
      </tr>`,
    )
    .join('');

  host.innerHTML = `
    <div class="summary">
      <div class="summary-card">
        <div class="summary-label">可变区间探针数</div>
        <div class="summary-value">${audit.counts.variable}</div>
      </div>
      <div class="summary-note">
        最小割格共 ${audit.components.total} 个强连通分量：源侧固定 ${audit.components.sourceFixed}、
        汇侧固定 ${audit.components.sinkFixed}、自由 ${audit.components.free}。
        探针归属：固定 ${audit.counts.fixed}、可变 ${audit.counts.variable}、参考点固定 ${audit.counts.reference}。
        点选探针行可查看使其取到两端值的最小割侧判定说明。
      </div>
    </div>
    <table class="grid audit-table">
      <thead>
        <tr>
          <th>探针标识</th><th>规范相位 x<sub>i</sub></th>
          <th>可取最小值</th><th>可取最大值</th><th>归属状态</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div id="auditDetail" class="audit-detail" hidden></div>`;

  host.querySelectorAll('tr[data-audit-probe]').forEach((tr) => {
    tr.addEventListener('click', () => toggleAuditDetail(audit, Number(tr.dataset.auditProbe), tr));
  });
  setStatus(
    audit.counts.variable > 0
      ? `归属审计完成：${audit.counts.variable} 个探针在保持最小总代价下存在可变区间。`
      : '归属审计完成：全部探针均为单点（最优相位面唯一）。',
    'good',
  );
}

/** 点选探针行：展开/收起使其取到两端值的最小割侧判定说明。 */
function toggleAuditDetail(audit, idx, tr) {
  const detail = $('#auditDetail');
  if (!detail) return;
  if (openAuditProbe === idx) {
    openAuditProbe = -1;
    detail.hidden = true;
    detail.innerHTML = '';
    tr.classList.remove('selected');
    return;
  }
  openAuditProbe = idx;
  detail.closest('.audit-section').querySelectorAll('tr.audit-row.selected').forEach((r) => r.classList.remove('selected'));
  tr.classList.add('selected');
  detail.innerHTML = auditDetailHtml(audit.probes[idx]);
  detail.hidden = false;
}

/** 单探针割侧判定说明：三段阈值判定 + 取到两端值的两个极值最小割。 */
function auditDetailHtml(p) {
  const { index: i, lo, hi, min, max, status } = p;
  const items = [];
  items.push(
    `<strong>探针 ${i}</strong>：范围 [${lo}, ${hi}]，规范相位 ${p.canonical}，` +
      `保持最小总代价时可取区间 [${min}, ${max}]。`,
  );

  if (status === 'reference') {
    items.push(
      '参考探针由 +∞ 钉死弧固定为 0：k ≤ 0 的阈值节点被源点钉死弧强制在源侧、' +
        'k &gt; 0 的被汇点钉死弧强制在汇侧，故一切最小割中 x<sub>i</sub> = 0。',
    );
  } else if (lo === hi) {
    items.push(`范围为单点 ${lo}，无阈值节点，一切最优解中 x<sub>i</sub> = ${lo}。`);
  } else {
    if (min > lo) {
      items.push(
        `k ∈ [${lo + 1}, ${min}]：节点 (i,k) 从源点沿残量弧可达 ⇒ 在<strong>一切</strong>最小割中位于源侧（z=1）。`,
      );
    }
    if (max > min) {
      items.push(
        `k ∈ [${min + 1}, ${max}]：节点 (i,k) 所属分量既不可从源分量可达、也不可达汇分量 ⇒ 自由，` +
          '在取到最小值的最小割中位于汇侧、在取到最大值的最小割中位于源侧。',
      );
    }
    if (hi > max) {
      items.push(
        `k ∈ [${max + 1}, ${hi}]：节点 (i,k) 沿残量弧可达汇点 ⇒ 在<strong>一切</strong>最小割中位于汇侧（z=0）。`,
      );
    }
    const seg = (a, b, side) => (a <= b ? `(i, ${a})…(i, ${b}) 在${side}侧` : '');
    items.push(
      `取到最小值 ${min} 的最小割：最小最小割——最大流后从源点沿残量弧可达的节点集` +
        `（规范相位所在割）；其中 ${[seg(lo + 1, min, '源'), seg(min + 1, hi, '汇')].filter(Boolean).join('，')}。`,
    );
    items.push(
      `取到最大值 ${max} 的最小割：最大最小割——残量网络中不可达汇点的节点集；` +
        `其中 ${[seg(lo + 1, max, '源'), seg(max + 1, hi, '汇')].filter(Boolean).join('，')}。`,
    );
  }

  if (status === 'variable') {
    items.push(`结论：x<sub>${i}</sub> 在保持最小总代价下可取 [${min}, ${max}] 内全部整数。`);
  } else if (status === 'fixed') {
    items.push(`结论：x<sub>${i}</sub> 在一切最优解中恒为 ${min}（单点）。`);
  } else {
    items.push('结论：参考点固定，区间为单点 [0, 0]。');
  }
  return `<ul class="audit-detail-list">${items.map((t) => `<li>${t}</li>`).join('')}</ul>`;
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
  auditing = false; // 新复核立即作废进行中的归属审计
  openAuditProbe = -1;
  refreshButtons();
  clearHighlights();
  // 发起新复核即撤下旧结论，避免计算期间展示过期补偿面。
  els.resultPanel.hidden = true;
  els.resultBody.innerHTML = '';
  els.errorList.innerHTML = '';
  setStatus('Worker 计算中：整数最小割求解，请稍候……', 'pending');
  workerEnsure().postMessage({ type: 'solve', id, input });
}

function cancelReview() {
  invalidateRunning(true, '计算已取消，旧结论已清除。', false);
}

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
    // 闭环矛盾且同成本存在多张相位面：路径 0→1→2 与直达边 0→2 的目标差
    // 互相矛盾（1+1≠1），三条边等权。最优代价 1 由三张相位面共享：
    // (0,0,1)、(0,1,1)、(0,1,2) —— 探针 1 可取 [0,1]、探针 2 可取 [1,2]，
    // 归属审计中可观察到可变区间；规范相位为字典序最小的 (0,0,1)。
    els.probeCount.value = '3';
    els.referenceIdx.value = '0';
    probeRows = [
      { lo: '0', hi: '0' },
      { lo: '0', hi: '2' },
      { lo: '0', hi: '3' },
    ];
    edgeRows = [
      { u: '0', v: '1', target: '1', weight: '1' },
      { u: '1', v: '2', target: '1', weight: '1' },
      { u: '0', v: '2', target: '1', weight: '1' },
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
els.loadSampleA.addEventListener('click', () => loadSample('A'));
els.loadSampleB.addEventListener('click', () => loadSample('B'));
els.loadSampleC.addEventListener('click', () => loadSample('C'));

// ---- 初始状态：闭环矛盾样例 -------------------------------------------------
loadSample('A');
setStatus('已载入示例数据，可直接发起复核。', 'muted');
