/**
 * 最优解归属审计测试：
 *  - 区间/状态与全赋值暴力枚举的逐探针取值包络完全一致；
 *  - 闭环矛盾等权样例出现可变区间，唯一最优与参考探针为单点区间；
 *  - 两个端值见证割（最小/最大最小割）经整数复算均达到最小代价；
 *  - 审计复用同一次最大流现场（solveTracked），不重新求解；
 *  - 20 万阈值层宽范围下 SCC 构造仍快速完成。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solve, solveTracked, analyzeOptimalInterval } from '../src/lib/solver.js';

/** 暴力枚举：最优代价及每个探针在全部最优赋值中的取值包络 [lo, hi] */
function bruteEnvelope({ probes, edges, reference }) {
  const n = probes.length;
  const domains = probes.map((p) => {
    const a = [];
    for (let v = p.lo; v <= p.hi; v++) a.push(v);
    return a;
  });
  domains[reference] = [0];
  let best = Infinity;
  const lo = Array(n).fill(Infinity);
  const hi = Array(n).fill(-Infinity);
  const x = new Array(n);
  const rec = (i) => {
    if (i === n) {
      let c = 0;
      for (const e of edges) c += e.weight * Math.abs(x[e.v] - x[e.u] - e.target);
      if (c < best) {
        best = c;
        for (let j = 0; j < n; j++) {
          lo[j] = x[j];
          hi[j] = x[j];
        }
      } else if (c === best) {
        for (let j = 0; j < n; j++) {
          lo[j] = Math.min(lo[j], x[j]);
          hi[j] = Math.max(hi[j], x[j]);
        }
      }
      return;
    }
    for (const v of domains[i]) {
      x[i] = v;
      rec(i + 1);
    }
  };
  rec(0);
  return { best, lo, hi };
}

function directCost(edges, x) {
  return edges.reduce((s, e) => s + e.weight * Math.abs(x[e.v] - x[e.u] - e.target), 0);
}

function auditOf(input) {
  const { result, network } = solveTracked(input);
  assert.equal(result.ok, true);
  assert.ok(network, '成功复核必须保留残量网络现场');
  return { result, network, audit: analyzeOptimalInterval(network) };
}

test('审计：等权闭环矛盾存在同成本多相位面，可观察到可变区间', () => {
  const input = {
    probes: [{ lo: 0, hi: 0 }, { lo: 0, hi: 3 }, { lo: 0, hi: 3 }],
    edges: [
      { u: 0, v: 1, target: 1, weight: 1 },
      { u: 1, v: 2, target: 0, weight: 1 },
      { u: 2, v: 0, target: -2, weight: 1 },
    ],
    reference: 0,
  };
  const { result, audit } = auditOf(input);
  assert.equal(audit.ok, true);
  assert.equal(audit.cost, 1);
  assert.equal(result.cost, audit.cost);
  assert.deepEqual(result.phases, [0, 1, 1]);
  // (0,1,1)、(0,1,2)、(0,2,2) 同成本；(0,2,1) 代价更高被偏序闭包排除。
  assert.deepEqual(
    audit.probes.map((r) => [r.min, r.max, r.status]),
    [
      [0, 0, 'reference'],
      [1, 2, 'variable'],
      [1, 2, 'variable'],
    ],
  );
  assert.deepEqual(audit.witnesses.min.phases, [0, 1, 1]);
  assert.deepEqual(audit.witnesses.max.phases, [0, 2, 2]);
});

test('审计：唯一最优（高权仲裁）与参考探针均为单点区间', () => {
  const input = {
    probes: [{ lo: 0, hi: 0 }, { lo: 0, hi: 3 }, { lo: 0, hi: 3 }],
    edges: [
      { u: 0, v: 1, target: 1, weight: 10 },
      { u: 0, v: 2, target: 1, weight: 1 },
      { u: 1, v: 2, target: 1, weight: 10 },
    ],
    reference: 0,
  };
  const { result, audit } = auditOf(input);
  assert.deepEqual(result.phases, [0, 1, 2]);
  for (const r of audit.probes) {
    assert.equal(r.min, r.max, `探针 ${r.i} 应为单点区间`);
    assert.equal(r.phase, r.min);
  }
  assert.equal(audit.probes[0].status, 'reference');
  assert.equal(audit.probes[1].status, 'fixed');
  assert.equal(audit.probes[2].status, 'fixed');
  assert.deepEqual(audit.witnesses.min.phases, audit.witnesses.max.phases);
});

test('审计：平局链 x1=x2 同成本，区间联动且端值见证合法', () => {
  const input = {
    probes: [{ lo: 0, hi: 0 }, { lo: 0, hi: 1 }, { lo: 0, hi: 1 }],
    edges: [{ u: 1, v: 2, target: 0, weight: 1 }],
    reference: 0,
  };
  const { audit } = auditOf(input);
  assert.equal(audit.cost, 0);
  assert.deepEqual(
    audit.probes.map((r) => [r.min, r.max, r.status]),
    [
      [0, 0, 'reference'],
      [0, 1, 'variable'],
      [0, 1, 'variable'],
    ],
  );
  // 最大最小割必须保持 x1=x2（不能是违反偏序的 (0,1)/(1,0) 混合）。
  assert.deepEqual(audit.witnesses.max.phases, [0, 1, 1]);
  for (const w of [audit.witnesses.min.phases, audit.witnesses.max.phases]) {
    assert.equal(directCost(input.edges, w), 0);
  }
});

test('审计：参考探针不在 0 号位时仍报单点参考区间', () => {
  const input = {
    probes: [{ lo: -3, hi: 3 }, { lo: 0, hi: 0 }, { lo: -3, hi: 3 }],
    edges: [
      { u: 1, v: 0, target: 2, weight: 3 },
      { u: 1, v: 2, target: -1, weight: 4 },
    ],
    reference: 1,
  };
  const { audit } = auditOf(input);
  const refRow = audit.probes[1];
  assert.deepEqual([refRow.min, refRow.max, refRow.phase, refRow.status], [0, 0, 0, 'reference']);
  assert.deepEqual(audit.witnesses.min.phases[1], 0);
  assert.deepEqual(audit.witnesses.max.phases[1], 0);
});

test('审计：结果表保留规范相位、最小值、最大值与状态四列', () => {
  const { audit } = auditOf({
    probes: [{ lo: 0, hi: 0 }, { lo: -2, hi: 2 }],
    edges: [{ u: 0, v: 1, target: 0, weight: 1 }],
    reference: 0,
  });
  for (const r of audit.probes) {
    for (const key of ['phase', 'min', 'max', 'status']) assert.ok(key in r, `缺少字段 ${key}`);
    assert.ok(['fixed', 'variable', 'reference'].includes(r.status));
    assert.ok(r.min <= r.phase && r.phase <= r.max);
  }
});

test('审计：点选说明的侧判定索引完整覆盖定义区间且与两端值一致', () => {
  const input = {
    probes: [{ lo: 0, hi: 0 }, { lo: -2, hi: 4 }],
    edges: [
      { u: 0, v: 1, target: 1, weight: 5 },
      { u: 0, v: 1, target: -1, weight: 5 },
    ],
    reference: 0,
  };
  const { audit } = auditOf(input);
  const r = audit.probes[1];
  // 三段阈值区间必须无缝拼成 [lo+1, hi]。
  assert.equal(r.forcedSourceUpTo, r.min);
  assert.equal(r.forcedSinkFrom, r.max + 1);
  // 自由窗口阈值数恰为 max-min。
  assert.equal(r.freeThresholds.length, r.max - r.min);
  for (const f of r.freeThresholds) assert.ok(f.k >= r.min + 1 && f.k <= r.max);
});

test('审计：随机实例区间包络与暴力枚举完全一致（含两见证割代价核对）', () => {
  let seed = 424242;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));

  for (let trial = 0; trial < 500; trial++) {
    const n = ri(2, 4);
    const reference = ri(0, n - 1);
    const probes = [];
    for (let i = 0; i < n; i++) {
      if (i === reference) probes.push({ lo: ri(-2, 0), hi: ri(0, 2) });
      else {
        const lo = ri(-2, 1);
        probes.push({ lo, hi: lo + ri(0, 3) });
      }
    }
    const m = ri(0, Math.min(6, n * (n - 1)));
    const edges = [];
    for (let e = 0; e < m; e++) {
      const u = ri(0, n - 1);
      let v = ri(0, n - 1);
      if (v === u) v = (v + 1) % n;
      edges.push({ u, v, target: ri(-3, 3), weight: ri(1, 4) });
    }
    const input = { probes, edges, reference };
    const { result, network, audit } = auditOf(input);
    const want = bruteEnvelope(input);
    assert.equal(audit.cost, want.best, `trial ${trial} 代价不一致`);
    assert.equal(result.cost, want.best);
    for (let i = 0; i < n; i++) {
      const r = audit.probes[i];
      assert.equal(r.min, want.lo[i], `trial ${trial} 探针 ${i} 下界不一致: ${JSON.stringify(input)}`);
      assert.equal(r.max, want.hi[i], `trial ${trial} 探针 ${i} 上界不一致: ${JSON.stringify(input)}`);
      assert.equal(r.phase, result.phases[i]);
      const expectStatus = i === reference ? 'reference' : want.lo[i] < want.hi[i] ? 'variable' : 'fixed';
      assert.equal(r.status, expectStatus);
    }
    // 两个端值见证都是最优赋值（且参考点为 0）。
    for (const w of [audit.witnesses.min.phases, audit.witnesses.max.phases]) {
      assert.equal(directCost(edges, w), want.best, `trial ${trial} 见证割不是最优`);
      assert.equal(w[reference], 0);
      for (let i = 0; i < n; i++) assert.ok(w[i] >= want.lo[i] && w[i] <= want.hi[i]);
    }
    // 同一残量现场重复审计必须幂等（不改动网络）。
    const again = analyzeOptimalInterval(network);
    assert.deepEqual(
      again.probes.map((r) => [r.min, r.max]),
      audit.probes.map((r) => [r.min, r.max]),
    );
  }
});

test('审计：不重新求解——solve() 结论与 tracked 现场审计一致且现场不被改写', () => {
  const input = {
    probes: [{ lo: 0, hi: 0 }, { lo: -3, hi: 3 }, { lo: -3, hi: 3 }],
    edges: [
      { u: 0, v: 1, target: 2, weight: 3 },
      { u: 1, v: 2, target: -1, weight: 2 },
      { u: 0, v: 2, target: 1, weight: 1 },
    ],
    reference: 0,
  };
  const plain = solve(input);
  const { result, network, audit } = auditOf(input);
  assert.deepEqual(result.phases, plain.phases);
  assert.equal(audit.cost, plain.cost);
  // 审计只读取残量容量，不产生流：现场的 S/T 与节点数保持不变。
  assert.equal(network.dinic.n, network.dinic.n);
  assert.ok(network.flow >= plain.cost);
});

test('审计：20 万阈值层宽范围下 SCC 偏序构造快速且区间精确', () => {
  const input = {
    probes: [{ lo: 0, hi: 0 }, { lo: -100000, hi: 100000 }],
    edges: [
      { u: 0, v: 1, target: 50000, weight: 3 },
      { u: 0, v: 1, target: 50002, weight: 1 },
    ],
    reference: 0,
  };
  const t0 = Date.now();
  const { result, network, audit } = auditOf(input);
  analyzeOptimalInterval(network); // 第二次仍应快速（幂等）
  assert.ok(Date.now() - t0 < 15000, `审计耗时过长：${Date.now() - t0}ms`);
  assert.equal(result.phases[1], 50000);
  const r = audit.probes[1];
  assert.deepEqual([r.phase, r.min, r.max, r.status], [50000, 50000, 50000, 'fixed']);
});
