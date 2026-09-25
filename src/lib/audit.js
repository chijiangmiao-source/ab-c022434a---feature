/**
 * 最优解归属审计：在**同一次**精确最小割完成后的残量网络上，
 * 用 Picard–Queyranne 最小割格刻画全部最优割，求每个探针在保持
 * 最小总代价时可取到的完整整数相位区间。
 *
 * 原理（不重跑求解、不枚举赋值、无浮点）：
 *  - 最大流完成后，全部最小 s-t 割与残量网络的强连通分量（SCC）
 *    缩点 DAG 中“含源分量、不含汇分量的闭集”一一对应；
 *  - 从源分量沿偏序可达的分量在一切最小割中位于源侧（z 固定为 1）；
 *  - 可达汇分量的分量在一切最小割中位于汇侧（z 固定为 0）；
 *  - 其余分量自由：在最小/最大两个极值割中各居一侧。
 * 相位 x_i = lo_i + #{k : z_{i,k}=1}，链内 +∞ 弧保证“固定源侧”的
 * 阈值 k 必为前缀、“固定汇侧”必为后缀，因而：
 *  - 可取最小值 = lo_i + 固定源侧阈值数 —— 恰为最小最小割解码出的
 *    规范相位（逐分量最小 ⇒ 字典序最小）；
 *  - 可取最大值 = lo_i + 非固定汇侧阈值数 —— 即最大最小割
 *    （不可达汇点集的补集）解码出的逐分量最大最优解。
 */

/**
 * Kosaraju 强连通分量（迭代实现，宽范围不栈溢出）。
 * 残量弧 = 残余容量 > 0 的弧；每条弧的配对反向弧经 rev 下标直接读取，
 * 无需显式构建反向图。
 * @returns {{comp: Int32Array, count: number}} 每节点的分量编号与分量总数
 */
function stronglyConnectedComponents(dinic) {
  const n = dinic.n;
  const g = dinic.g;

  // 第一遍：正向残量图 DFS，记录完成次序。
  const order = [];
  const seen = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    seen[s] = 1;
    const stack = [[s, 0]]; // [节点, 下一条待扫描弧下标]
    while (stack.length) {
      const top = stack[stack.length - 1];
      const v = top[0];
      const adj = g[v];
      let i = top[1];
      while (i < adj.length && (adj[i][2] <= 0 || seen[adj[i][0]])) i++;
      if (i < adj.length) {
        top[1] = i + 1;
        const w = adj[i][0];
        seen[w] = 1;
        stack.push([w, 0]);
      } else {
        order.push(v);
        stack.pop();
      }
    }
  }

  // 第二遍：按逆完成序在反向残量图上扩张。弧 e=(v→w) 的配对弧
  // w→v 残余容量为 g[w][e.rev][2]，>0 即反向图中 v→w 可达。
  const comp = new Int32Array(n).fill(-1);
  let count = 0;
  for (let oi = order.length - 1; oi >= 0; oi--) {
    const s = order[oi];
    if (comp[s] >= 0) continue;
    comp[s] = count;
    const stack = [s];
    while (stack.length) {
      const v = stack.pop();
      for (const e of g[v]) {
        if (g[e[0]][e[1]][2] > 0 && comp[e[0]] < 0) {
          comp[e[0]] = count;
          stack.push(e[0]);
        }
      }
    }
    count++;
  }
  return { comp, count };
}

/** 在邻接表上从 start 做一次可达标记（BFS）。 */
function reachability(adj, start) {
  const seen = new Uint8Array(adj.length);
  seen[start] = 1;
  const q = [start];
  for (let h = 0; h < q.length; h++) {
    for (const w of adj[q[h]]) {
      if (!seen[w]) {
        seen[w] = 1;
        q.push(w);
      }
    }
  }
  return seen;
}

/**
 * 归属审计主入口。
 * @param residual solveWithResidual / solveAsyncWithResidual 保留的
 *   { probes, reference, dinic, id, S, T }（同一次最小割的残量网络）。
 * @param canonical 该次复核解码出的规范相位（字典序最小最优解），
 *   用于交叉核对。
 * @returns { ok:true, reference, probes:[{index,lo,hi,canonical,min,max,status}],
 *            components:{total,sourceFixed,sinkFixed,free},
 *            counts:{fixed,variable,reference} }
 *   status ∈ 'fixed'（单点）| 'variable'（可变区间）| 'reference'（参考点固定）。
 */
export function auditFromResidual(residual, canonical) {
  const { probes, reference, dinic, id, S, T } = residual;

  // 1) 残量网络的强连通分量 = 最小割格的原子。
  const { comp, count } = stronglyConnectedComponents(dinic);

  // 2) 缩点 DAG（最小割格偏序）的正/反邻接。
  const dagOut = Array.from({ length: count }, () => []);
  const dagIn = Array.from({ length: count }, () => []);
  for (let v = 0; v < dinic.n; v++) {
    const a = comp[v];
    for (const e of dinic.g[v]) {
      if (e[2] <= 0) continue;
      const b = comp[e[0]];
      if (a === b) continue;
      dagOut[a].push(b);
      dagIn[b].push(a);
    }
  }

  // 3) 偏序双向可达：源分量可达 ⇒ 一切最小割源侧；
  //    可达汇分量 ⇒ 一切最小割汇侧；其余自由。
  const compS = comp[S];
  const compT = comp[T];
  if (compS === compT) {
    throw new Error('审计内部错误：残量网络中源汇同分量（最大流未完成）');
  }
  const reachFromS = reachability(dagOut, compS);
  const reachToT = reachability(dagIn, compT);

  let sourceFixed = 0;
  let sinkFixed = 0;
  for (let c = 0; c < count; c++) {
    if (reachFromS[c]) sourceFixed++;
    else if (reachToT[c]) sinkFixed++;
  }

  // 4) 逐探针扫描阈值节点，求可取区间 [min, max]。
  const rows = [];
  const counts = { fixed: 0, variable: 0, reference: 0 };
  for (let i = 0; i < probes.length; i++) {
    const { lo, hi } = probes[i];
    let min = lo;
    let max = lo;
    for (let k = lo + 1; k <= hi; k++) {
      const c = comp[id(i, k)];
      if (reachFromS[c]) min = k; // 固定在源侧 ⇒ 一切最优解 x_i ≥ k
      if (!reachToT[c]) max = k; // 可在源侧 ⇒ 存在最优解 x_i ≥ k
    }

    // 交叉核对：最小最小割解码即规范相位（逐分量最小）；
    // 参考探针被 +∞ 钉死弧固定为 0，区间必为单点。
    if (min !== canonical[i]) {
      throw new Error(`审计内部错误：探针 ${i} 的最小最小割与规范相位不一致`);
    }
    if (i === reference && (min !== 0 || max !== 0)) {
      throw new Error('审计内部错误：参考探针未被钉死为 0');
    }

    const status = i === reference ? 'reference' : min === max ? 'fixed' : 'variable';
    counts[status]++;
    rows.push({ index: i, lo, hi, canonical: canonical[i], min, max, status });
  }

  return {
    ok: true,
    reference,
    probes: rows,
    components: {
      total: count,
      sourceFixed,
      sinkFixed,
      free: count - sourceFixed - sinkFixed,
    },
    counts,
  };
}
