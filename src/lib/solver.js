/**
 * 整数相位面精确求解器。
 *
 * 问题：
 *   为每个探针 i 赋整数相位 x_i ∈ [lo_i, hi_i]（参考探针固定为 0），
 *   对每条有向观测边 e: u→v（目标差 t_e、正整数权 w_e）最小化
 *       Σ_e w_e · |(x_v - x_u) - t_e|，
 *   并在同成本的最优解中取按探针标识升序的相位向量字典序最小者。
 *
 * 归约（凸有序整数标签 / Ishikawa 链式最小割）：
 *   二值变量 z_{i,k} = [x_i ≥ k]，节点 (i,k) 在源侧 S ⇔ z=1，
 *   k ∈ [lo_i+1, hi_i]。
 *   - 链内 +∞ 弧 (i,k+1)→(i,k)：禁止 z_k=0 而 z_{k+1}=1，截集必为阈值；
 *   - 成对项 φ(x_u,x_v)=w·|x_v-x_u-t| 是子模凸函数：在单位方格
 *     (k,l) 上的受限二阶差分仅当 l-k=t 时为 2w，加弧 (u,k)→(v,l)；
 *   - 有限定义域边界的一阶项用源/汇弧精确补偿（A_k、B_l，
 *     正者加 (节点)→T，负者加 S→(节点)）；
 *   - 参考探针固定 0 用 +∞ 钉死弧实现。
 *
 * 字典序：所有最小割在并/交下封闭（子模格）。最大流后从源点沿
 *   残量弧可达的集合是唯一的“最小最小割”（包含于一切最小割的源侧），
 *   即 z 逐分量最少 ⇒ x 逐分量最小 ⇒ 按标识升序字典序最小。
 *   因而只需一次整数最小割，无局部传播、无浮点、无全赋值枚举、
 *   也无需逐坐标重算。
 */
import { Dinic } from './maxflow.js';

/** 大于一切有限可行总代价的容量；求和保持在 2^53 安全整数内 */
const INF = 0x1fffffffffffff;

const isInt = Number.isInteger;

/**
 * 校验输入。
 * @returns {{kind:string,index?:number,field?:string,message:string}[]}
 */
export function validateInput(input) {
  const errors = [];
  const probes = Array.isArray(input?.probes) ? input.probes : [];
  const edges = Array.isArray(input?.edges) ? input.edges : [];
  const n = probes.length;

  if (!Array.isArray(input?.probes) || n < 2 || n > 40) {
    errors.push({ kind: 'count', message: `探针数量必须在 2…40 之间（收到 ${Array.isArray(input?.probes) ? n : '无效值'}）` });
  }

  if (!isInt(input?.reference) || input.reference < 0 || input.reference >= n) {
    errors.push({
      kind: 'reference',
      field: 'index',
      message: `参考探针标识 ${input.reference} 越界：必须位于 0…${Math.max(n - 1, 0)}`,
    });
  }

  for (let i = 0; i < n; i++) {
    const p = probes[i] || {};
    if (!isInt(p.lo) || !isInt(p.hi)) {
      errors.push({
        kind: 'range',
        index: i,
        field: 'bounds',
        message: `探针 ${i} 的相位范围上下界必须是整数（收到 ${p.lo}…${p.hi}）`,
      });
    } else if (p.lo > p.hi) {
      errors.push({
        kind: 'range',
        index: i,
        field: 'range',
        message: `探针 ${i} 的范围为空：下界 ${p.lo} 大于上界 ${p.hi}`,
      });
    }
  }

  // 参考探针固定为 0；0 不在其范围内即“参考点越界”。
  if (isInt(input?.reference) && input.reference >= 0 && input.reference < n) {
    const p = probes[input.reference];
    if (p && isInt(p.lo) && isInt(p.hi) && p.lo <= p.hi && (p.lo > 0 || p.hi < 0)) {
      errors.push({
        kind: 'reference',
        index: input.reference,
        field: 'range',
        message: `参考探针 ${input.reference} 固定为 0，但 0 不在其相位范围 [${p.lo}, ${p.hi}] 内`,
      });
    }
  }

  for (let e = 0; e < edges.length; e++) {
    const edge = edges[e] || {};
    if (!isInt(edge.u) || edge.u < 0 || edge.u >= n) {
      errors.push({
        kind: 'edge',
        index: e,
        field: 'u',
        message: `第 ${e + 1} 条边的起点标识 “${edge.u}” 不存在：须在 0…${Math.max(n - 1, 0)}`,
      });
    }
    if (!isInt(edge.v) || edge.v < 0 || edge.v >= n) {
      errors.push({
        kind: 'edge',
        index: e,
        field: 'v',
        message: `第 ${e + 1} 条边的终点标识 “${edge.v}” 不存在：须在 0…${Math.max(n - 1, 0)}`,
      });
    }
    if (!isInt(edge.weight) || edge.weight <= 0) {
      errors.push({
        kind: 'edge',
        index: e,
        field: 'weight',
        message: `第 ${e + 1} 条边的权重必须是正整数（收到 ${edge.weight}）`,
      });
    }
    if (!isInt(edge.target)) {
      errors.push({
        kind: 'edge',
        index: e,
        field: 'target',
        message: `第 ${e + 1} 条边的目标差值必须是整数（收到 ${edge.target}）`,
      });
    }
  }

  return errors;
}

/**
 * 构造链式最小割网络。
 * 返回 { dinic, id, S, T, cutArcs }（cutArcs 供容量复核）。
 */
function buildNetwork(probes, edges, reference) {
  const n = probes.length;

  // 节点 (i,k)，k = lo_i+1 … hi_i；在源侧 ⇔ x_i ≥ k。
  const base = new Int32Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    base[i] = total;
    total += probes[i].hi - probes[i].lo;
  }
  const S = total;
  const T = total + 1;
  const dinic = new Dinic(total + 2);
  const id = (i, k) => base[i] + (k - probes[i].lo - 1);

  // 1) 阈值链 +∞ 弧：(i,k+1)∈S 而 (i,k)∈T 时被截断（罚 INF），
  //    从而禁止 z_k=0、z_{k+1}=1。
  for (let i = 0; i < n; i++) {
    for (let k = probes[i].lo + 1; k < probes[i].hi; k++) {
      dinic.addEdge(id(i, k + 1), id(i, k), INF);
    }
  }

  // 2) 成对项 w·|x_v - x_u - t|。
  for (const { u, v, target: t, weight: w } of edges) {
    const loU = probes[u].lo;
    const hiU = probes[u].hi;
    const loV = probes[v].lo;
    const hiV = probes[v].hi;

    // 受限二阶差分：C(k,l)=φ(k,l-1)+φ(k-1,l)-φ(k-1,l-1)-φ(k,l)，
    // 仅当 l-k=t 时等于 2w（其余为 0）。截弧 (u,k)→(v,l) 容量 C。
    for (let k = loU + 1; k <= hiU; k++) {
      const l = k + t;
      if (l >= loV + 1 && l <= hiV) {
        dinic.addEdge(id(u, k), id(v, l), 2 * w);
      }
    }

    // 边界一阶补偿：
    //   B_l = φ(loU,l)-φ(loU,l-1)（|·| 的离散增量恒为 ±w）
    //       = -w 当 l ≤ loU+t；+w 当 l ≥ loU+t+1。
    //   A_k = φ(k,loV)-φ(k-1,loV) - Σ_l C(k,l)
    //       一阶差 = -w 当 k ≤ loV-t；+w 当 k ≥ loV-t+1，
    //       若 (k, k+t) 处存在对角缝再减去 2w。
    // 正系数：节点→T（z=1 时付费）；负系数：S→节点（z=0 时付费）。
    for (let l = loV + 1; l <= hiV; l++) {
      const B = l <= loU + t ? -w : w;
      if (B > 0) dinic.addEdge(id(v, l), T, B);
      else dinic.addEdge(S, id(v, l), w);
    }
    for (let k = loU + 1; k <= hiU; k++) {
      let A = k <= loV - t ? -w : w;
      if (k + t >= loV + 1 && k + t <= hiV) A -= 2 * w;
      if (A > 0) dinic.addEdge(id(u, k), T, A);
      else if (A < 0) dinic.addEdge(S, id(u, k), -A);
    }
  }

  // 3) 参考探针钉死为 0：k≤0 的节点强制源侧（S→node, INF），
  //    k>0 的节点强制汇侧（node→T, INF）。
  for (let k = probes[reference].lo + 1; k <= probes[reference].hi; k++) {
    if (k <= 0) dinic.addEdge(S, id(reference, k), INF);
    else dinic.addEdge(id(reference, k), T, INF);
  }

  return { dinic, id, S, T };
}

/** 从最大流后的残量网络解码字典序最小最优解，并复算明细 */
function decodeResult(probes, edges, reference, dinic, id, S, T, flow) {
  void T;
  if (flow >= INF) {
    // 理论不可达：可行赋值总是存在（范围非空、参考点合法），代价有限。
    throw new Error('求解内部错误：最小割截断了无限容量弧（问题不可行）');
  }

  // 残量可达集 = 包含于一切最小割源侧的唯一最小最小割，
  // 解码得到逐分量最小（即字典序最小）的最优赋值。
  const side = dinic.sourceSide(S);
  const phases = new Array(probes.length);
  for (let i = 0; i < probes.length; i++) {
    let val = probes[i].lo;
    for (let k = probes[i].lo + 1; k <= probes[i].hi; k++) {
      if (side[id(i, k)]) val = k;
      else break;
    }
    phases[i] = val;
  }
  phases[reference] = 0;

  // 按定义整数复算总代价与逐边明细。
  let cost = 0;
  const edgeReports = edges.map((e) => {
    const actual = phases[e.v] - phases[e.u];
    const residual = actual - e.target;
    const contribution = e.weight * Math.abs(residual);
    cost += contribution;
    return {
      u: e.u,
      v: e.v,
      target: e.target,
      weight: e.weight,
      actual,
      residual,
      contribution,
    };
  });

  // 交叉核对：残量可达割必为阈值割（z_k=1 ⇒ z_{k-1}=1），且参考点为 0。
  for (let i = 0; i < probes.length; i++) {
    for (let k = probes[i].lo + 2; k <= probes[i].hi; k++) {
      if (side[id(i, k)] && !side[id(i, k - 1)]) {
        throw new Error('求解内部错误：截集不是阈值割');
      }
    }
  }
  if (phases[reference] !== 0) throw new Error('求解内部错误：参考探针未固定为 0');

  return { ok: true, phases, cost, reference, edges: edgeReports };
}

/**
 * 同步主入口（测试/Node 侧使用）。
 * @returns 成功 {ok:true, phases, cost, reference, edges:[...]}；
 *          失败 {ok:false, errors:[...]}。
 * @param {(() => boolean)|null} [shouldCancel] 协作式取消。
 */
export function solve(input, shouldCancel = null) {
  return solveTracked(input, shouldCancel).result;
}

/**
 * 同步求解并保留同一次最大流后的完整现场（残量网络）。
 * 归属审计必须复用该现场，禁止重新求解：
 * @returns {{result:object, network:object|null}} result 失败/取消时 network 为 null。
 */
export function solveTracked(input, shouldCancel = null) {
  const errors = validateInput(input);
  if (errors.length) return { result: { ok: false, errors }, network: null };

  const { probes, edges, reference } = input;
  const built = buildNetwork(probes, edges, reference);
  const flow = built.dinic.maxflow(built.S, built.T, shouldCancel);
  if (shouldCancel && shouldCancel()) return { result: { ok: false, canceled: true }, network: null };
  const result = decodeResult(probes, edges, reference, built.dinic, built.id, built.S, built.T, flow);
  const network = { probes, edges, reference, dinic: built.dinic, id: built.id, S: built.S, T: built.T, flow };
  return { result, network };
}

/**
 * 异步主入口（Web Worker 使用）：计算途中周期性让出事件循环，
 * 使“取消 / 草稿已变更”能及时生效；返回 canceled 时调用方必须丢弃结果。
 * @param {((network:object)=>void)|null} [onSolved]
 *   成功后回调，交出同一次最大流的残量网络现场供归属审计复用；
 *   校验失败/取消时绝不调用。
 */
export async function solveAsync(input, shouldCancel = null, yieldEvery = 100000, onSolved = null) {
  const errors = validateInput(input);
  if (errors.length) return { ok: false, errors };

  const { probes, edges, reference } = input;
  const built = buildNetwork(probes, edges, reference);
  const flow = await built.dinic.maxflowAsync(built.S, built.T, shouldCancel, yieldEvery);
  if (shouldCancel && shouldCancel()) return { ok: false, canceled: true };
  const result = decodeResult(probes, edges, reference, built.dinic, built.id, built.S, built.T, flow);
  if (onSolved) {
    onSolved({ probes, edges, reference, dinic: built.dinic, id: built.id, S: built.S, T: built.T, flow });
  }
  return result;
}

/**
 * 最优解归属审计：在【同一次】精确最小割完成后的残量网络上，求每个探针
 * 在保持当前最小总代价时能够取到的完整整数相位区间。
 *
 * 方法（最小割格的强连通分量偏序，不逐探针重跑、不浮点近似、不枚举赋值）：
 *   最大流后的残量网络（仅取残量容量 > 0 的弧）中，
 *   - 彼此残量可达的节点属于同一强连通分量（SCC）；SCC 缩点得到一张
 *     偏序 DAG（最小割格的可达序）；
 *   - 阈值节点 (i,k)（在源侧 ⇔ z_{i,k}=1 ⇔ x_i≥k）：
 *       · S 沿残量弧可达 ⇒ 在一切最小割中必在源侧（z 恒为 1）；
 *       · 自身沿残量弧可达 T ⇒ 在一切最小割中必在汇侧（z 恒为 0）；
 *       · 两者皆否 ⇒ 自由 SCC，可在偏序闭包约束内翻转取侧；
 *   - 最小最小割 = S 的残量可达集（逐 z 最小，即字典序规范解），
 *     给出每个探针的 min；
 *   - 最大最小割 = 不能沿残量弧到达 T 的节点全集（最大闭包），
 *     给出每个探针的 max。
 *   阈值链的单调性保证投影为连续整数区间 [min, max]。
 *
 * @param {object} network solveTracked/onSolved 交出的同一次求解现场。
 * @returns 审计表（含规范相位、最小/最大值、状态与自由 SCC 成员说明）。
 */
export function analyzeOptimalInterval(network) {
  const { probes, edges, reference, dinic, id, S, T, flow } = network;
  if (flow >= INF) throw new Error('审计内部错误：最小割截断了无限容量弧');

  const n = dinic.n;

  // ---- 1) 残量网络（仅残量容量 > 0 的弧）压缩为 CSR 正/反邻接 -------------
  const off = new Int32Array(n + 1);
  const indeg = new Int32Array(n);
  for (let v = 0; v < n; v++) {
    for (const e of dinic.g[v]) {
      if (e[2] > 0) {
        off[v + 1]++;
        indeg[e[0]]++;
      }
    }
  }
  for (let v = 0; v < n; v++) off[v + 1] += off[v];
  const roff = new Int32Array(n + 1);
  for (let v = 0; v < n; v++) roff[v + 1] = roff[v] + indeg[v];
  const m = off[n];
  const to = new Int32Array(m);
  const rto = new Int32Array(m);
  const fp = off.slice(0, n);
  const rp = roff.slice(0, n);
  for (let v = 0; v < n; v++) {
    for (const e of dinic.g[v]) {
      if (e[2] <= 0) continue;
      const w = e[0];
      to[fp[v]++] = w;
      rto[rp[w]++] = v;
    }
  }

  // ---- 2) Kosaraju SCC（显式栈迭代，宽范围不栈溢出） ----------------------
  // 第一趟：正图 DFS 记录完成序。
  const seen = new Uint8Array(n);
  const order = new Int32Array(n);
  let orderLen = 0;
  const nxt = new Int32Array(n);
  const stack = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    nxt[start] = off[start];
    while (sp > 0) {
      const v = stack[sp - 1];
      let p = nxt[v];
      while (p < off[v + 1] && seen[to[p]]) p++;
      if (p < off[v + 1]) {
        const w = to[p];
        nxt[v] = p + 1;
        seen[w] = 1;
        nxt[w] = off[w];
        stack[sp++] = w;
      } else {
        order[orderLen++] = v;
        sp--;
      }
    }
  }
  // 第二趟：按完成序逆序在反图 DFS，标号即 SCC。
  const comp = new Int32Array(n).fill(-1);
  let compCount = 0;
  for (let oi = n - 1; oi >= 0; oi--) {
    const root = order[oi];
    if (comp[root] >= 0) continue;
    const c = compCount++;
    comp[root] = c;
    let sp = 0;
    stack[sp++] = root;
    while (sp > 0) {
      const v = stack[--sp];
      for (let p = roff[v]; p < roff[v + 1]; p++) {
        const w = rto[p];
        if (comp[w] < 0) {
          comp[w] = c;
          stack[sp++] = w;
        }
      }
    }
  }

  if (comp[S] === comp[T]) throw new Error('审计内部错误：S/T 残量互通，最大流未完成');

  // ---- 3) SCC 缩点偏序 DAG（跨分量残量弧），求两类可达 --------------------
  const coff = new Int32Array(compCount + 1);
  for (let v = 0; v < n; v++) {
    for (let p = off[v]; p < off[v + 1]; p++) {
      if (comp[v] !== comp[to[p]]) coff[comp[v] + 1]++;
    }
  }
  for (let c = 0; c < compCount; c++) coff[c + 1] += coff[c];
  const cto = new Int32Array(coff[compCount]);
  const cp = coff.slice(0, compCount);
  for (let v = 0; v < n; v++) {
    for (let p = off[v]; p < off[v + 1]; p++) {
      const cv = comp[v];
      const cw = comp[to[p]];
      if (cv !== cw) cto[cp[cv]++] = cw;
    }
  }

  // reachS：S 的 SCC 沿偏序可达（分量内节点在一切最小割中强制源侧）；
  // reachT：能沿偏序到达 T 的 SCC（其中节点强制汇侧）。
  const reachS = new Uint8Array(compCount);
  {
    let sp = 0;
    stack[sp++] = comp[S];
    reachS[comp[S]] = 1;
    while (sp > 0) {
      const c = stack[--sp];
      for (let p = coff[c]; p < coff[c + 1]; p++) {
        const d = cto[p];
        if (!reachS[d]) {
          reachS[d] = 1;
          stack[sp++] = d;
        }
      }
    }
  }
  const reachT = new Uint8Array(compCount);
  {
    // 缩点反图 CSR：在反图上从 T 的 SCC 反向传播，标记所有能到达 T 的 SCC。
    const ioff = new Int32Array(compCount + 1);
    for (let p = 0; p < coff[compCount]; p++) ioff[cto[p] + 1]++;
    for (let c = 0; c < compCount; c++) ioff[c + 1] += ioff[c];
    const ito = new Int32Array(coff[compCount]);
    const ip = ioff.slice(0, compCount);
    for (let c = 0; c < compCount; c++) {
      for (let p = coff[c]; p < coff[c + 1]; p++) ito[ip[cto[p]]++] = c;
    }
    let sp = 0;
    stack[sp++] = comp[T];
    reachT[comp[T]] = 1;
    while (sp > 0) {
      const c = stack[--sp];
      for (let p = ioff[c]; p < ioff[c + 1]; p++) {
        const d = ito[p];
        if (!reachT[d]) {
          reachT[d] = 1;
          stack[sp++] = d;
        }
      }
    }
  }
  if (reachS[comp[T]] || reachT[comp[S]]) throw new Error('审计内部错误：残量网络存在 S→T 路径');

  // ---- 4) 逐探针阈值归类，解码两端见证割并整数复算代价 --------------------
  const directCost = (phases) => {
    let c = 0;
    for (const e of edges) c += e.weight * Math.abs(phases[e.v] - phases[e.u] - e.target);
    return c;
  };

  // 自由 SCC 成员清单（跨探针），用于说明翻转时的闭包联动。
  const freeMembers = new Map();
  for (let i = 0; i < probes.length; i++) {
    for (let k = probes[i].lo + 1; k <= probes[i].hi; k++) {
      const c = comp[id(i, k)];
      if (!reachS[c] && !reachT[c]) {
        if (!freeMembers.has(c)) freeMembers.set(c, []);
        freeMembers.get(c).push(`${i}@${k}`);
      }
    }
  }

  const minPhases = new Array(probes.length);
  const maxPhases = new Array(probes.length);
  const rows = probes.map((p, i) => {
    let loK = p.lo; // 强制源侧阈值上确界（min）
    let hiK = p.lo; // 非强制汇侧阈值上确界（max）
    for (let k = p.lo + 1; k <= p.hi; k++) {
      const c = comp[id(i, k)];
      const forcedS = reachS[c] === 1;
      const forcedT = reachT[c] === 1;
      if (forcedS && forcedT) throw new Error('审计内部错误：阈值节点同时被强制两侧');
      if (forcedS) {
        if (k !== loK + 1) throw new Error('审计内部错误：强制源侧阈值不构成前缀');
        loK = k;
      }
      if (!forcedT) {
        if (k !== hiK + 1) throw new Error('审计内部错误：强制汇侧阈值不构成后缀');
        hiK = k;
      }
    }
    if (loK > hiK) throw new Error('审计内部错误：相位区间为空');
    const min = i === reference ? 0 : loK;
    const max = i === reference ? 0 : hiK;
    minPhases[i] = loK;
    maxPhases[i] = hiK;

    // 可变窗口 k = min+1 … max：全部是自由 SCC 阈值。
    const freeThresholds = [];
    for (let k = loK + 1; k <= hiK; k++) {
      const c = comp[id(i, k)];
      if (reachS[c] || reachT[c]) throw new Error('审计内部错误：区间窗口内存在强制阈值');
      freeThresholds.push({ k, comp: c, members: freeMembers.get(c) });
    }
    const status = i === reference ? 'reference' : min < max ? 'variable' : 'fixed';
    return {
      i,
      lo: p.lo,
      hi: p.hi,
      phase: min, // 规范相位即最小最小割解码值（字典序最小最优解）
      min,
      max,
      status,
      // 侧判定索引：源侧阈值区间 [lo+1, min]；汇侧阈值区间 [max+1, hi]；
      // 中间 freeThresholds 在最小见证割取汇侧、最大见证割取源侧。
      forcedSourceUpTo: loK,
      forcedSinkFrom: hiK + 1,
      freeThresholds,
    };
  });

  // 参考探针两端见证都必须为 0（钉死弧保证）。
  minPhases[reference] = 0;
  maxPhases[reference] = 0;

  // 交叉核对：两个见证割都必须是最优赋值，代价等于本次最小割对应总代价。
  const costMin = directCost(minPhases);
  const costMax = directCost(maxPhases);
  if (costMin !== costMax) {
    throw new Error(`审计内部错误：两端见证代价不一致 ${costMin} ≠ ${costMax}`);
  }

  return {
    ok: true,
    cost: costMin,
    reference,
    sccCount: compCount,
    witnesses: { min: { phases: minPhases }, max: { phases: maxPhases } },
    probes: rows,
  };
}
