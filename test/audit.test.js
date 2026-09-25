import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveWithResidual } from '../src/lib/solver.js';
import { auditFromResidual } from '../src/lib/audit.js';

/** 暴力枚举全部最优赋值，返回每个探针在最优解集中的 min/max */
function bruteForceRange({ probes, edges, reference }) {
  const n = probes.length;
  const domains = probes.map((p) => {
    const a = [];
    for (let v = p.lo; v <= p.hi; v++) a.push(v);
    return a;
  });
  domains[reference] = [0];

  let best = Infinity;
  const mins = new Array(n).fill(Infinity);
  const maxs = new Array(n).fill(-Infinity);
  const x = new Array(n);
  const rec = (i) => {
    if (i === n) {
      let c = 0;
      for (const e of edges) c += e.weight * Math.abs(x[e.v] - x[e.u] - e.target);
      if (c < best) {
        best = c;
        for (let j = 0; j < n; j++) {
          mins[j] = x[j];
          maxs[j] = x[j];
        }
      } else if (c === best) {
        for (let j = 0; j < n; j++) {
          if (x[j] < mins[j]) mins[j] = x[j];
          if (x[j] > maxs[j]) maxs[j] = x[j];
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
  return { best, mins, maxs };
}

function mk(probes, edges, reference = 0) {
  return { probes: probes.map(([lo, hi]) => ({ lo, hi })), edges, reference };
}

function auditOf(input) {
  const { result, residual } = solveWithResidual(input);
  assert.equal(result.ok, true);
  const audit = auditFromResidual(residual, result.phases);
  return { audit, result };
}

test('闭环矛盾且同成本多相位面：可变区间与三种状态齐全', () => {
  // 路径 0→1→2 与直达边 0→2 目标差矛盾（1+1≠1），三边等权。
  // 最优代价 1 由 (0,0,1)、(0,1,1)、(0,1,2) 共享。
  const input = mk(
    [
      [0, 0],
      [0, 2],
      [0, 3],
    ],
    [
      { u: 0, v: 1, target: 1, weight: 1 },
      { u: 1, v: 2, target: 1, weight: 1 },
      { u: 0, v: 2, target: 1, weight: 1 },
    ],
  );
  const { audit, result } = auditOf(input);
  assert.equal(result.cost, 1);
  assert.deepEqual(result.phases, [0, 0, 1]); // 规范相位 = 字典序最小

  const [p0, p1, p2] = audit.probes;
  // 参考探针：参考点固定，单点 0
  assert.equal(p0.status, 'reference');
  assert.equal(p0.min, 0);
  assert.equal(p0.max, 0);
  // 探针 1：可变区间 [0,1]
  assert.equal(p1.status, 'variable');
  assert.equal(p1.min, 0);
  assert.equal(p1.max, 1);
  // 探针 2：可变区间 [1,2]
  assert.equal(p2.status, 'variable');
  assert.equal(p2.min, 1);
  assert.equal(p2.max, 2);

  assert.equal(audit.counts.variable, 2);
  assert.equal(audit.counts.reference, 1);
  assert.equal(audit.counts.fixed, 0);
  // 每行保留规范相位，且规范相位恒等于可取最小值（最小最小割逐分量最小）
  for (const p of audit.probes) {
    assert.equal(p.canonical, result.phases[p.index]);
    assert.equal(p.min, p.canonical);
  }
});

test('唯一最优（闭环矛盾三角形样例 A）：全部单点区间', () => {
  const input = mk(
    [
      [0, 0],
      [0, 3],
      [0, 3],
    ],
    [
      { u: 0, v: 1, target: 1, weight: 10 },
      { u: 0, v: 2, target: 1, weight: 1 },
      { u: 1, v: 2, target: 1, weight: 10 },
    ],
  );
  const { audit, result } = auditOf(input);
  assert.deepEqual(result.phases, [0, 1, 2]);
  assert.equal(audit.probes[0].status, 'reference');
  for (const p of audit.probes) {
    assert.equal(p.min, p.max, `探针 ${p.index} 应为单点`);
    assert.equal(p.min, p.canonical);
    if (p.index !== audit.reference) assert.equal(p.status, 'fixed');
  }
  assert.equal(audit.counts.variable, 0);
});

test('四环“局部累加失败”样例 B 的归属审计与暴力枚举一致', () => {
  const input = mk(
    [
      [0, 0],
      [-3, 5],
      [-3, 5],
      [-3, 5],
    ],
    [
      { u: 0, v: 1, target: 1, weight: 1 },
      { u: 1, v: 2, target: 1, weight: 1 },
      { u: 2, v: 3, target: 1, weight: 1 },
      { u: 3, v: 0, target: -2, weight: 10 },
    ],
  );
  const { audit } = auditOf(input);
  const want = bruteForceRange(input);
  for (const p of audit.probes) {
    assert.equal(p.min, want.mins[p.index], `探针 ${p.index} 最小值`);
    assert.equal(p.max, want.maxs[p.index], `探针 ${p.index} 最大值`);
  }
});

test('单点范围探针（非参考）：固定状态', () => {
  const input = mk(
    [
      [0, 0],
      [2, 2],
      [-2, 2],
    ],
    [{ u: 0, v: 2, target: 1, weight: 1 }],
  );
  const { audit } = auditOf(input);
  assert.equal(audit.probes[1].status, 'fixed');
  assert.equal(audit.probes[1].min, 2);
  assert.equal(audit.probes[1].max, 2);
});

test('无边实例：所有非参考探针取遍整个范围（可变）', () => {
  const input = mk(
    [
      [0, 0],
      [-2, 2],
      [-1, 3],
    ],
    [],
  );
  const { audit } = auditOf(input);
  assert.deepEqual(
    audit.probes.map((p) => [p.min, p.max, p.status]),
    [
      [0, 0, 'reference'],
      [-2, 2, 'variable'],
      [-1, 3, 'variable'],
    ],
  );
});

test('随机小规模实例：审计区间与暴力枚举全最优解完全一致', () => {
  let seed = 20260925;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));

  for (let trial = 0; trial < 400; trial++) {
    const n = ri(2, 4);
    const reference = ri(0, n - 1);
    const probes = [];
    for (let i = 0; i < n; i++) {
      if (i === reference) {
        probes.push({ lo: ri(-2, 0), hi: ri(0, 2) });
      } else {
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
    const { result, residual } = solveWithResidual(input);
    assert.equal(result.ok, true);
    const audit = auditFromResidual(residual, result.phases);
    const want = bruteForceRange(input);

    for (let i = 0; i < n; i++) {
      const p = audit.probes[i];
      assert.equal(p.min, want.mins[i], `trial ${trial} 探针 ${i} 最小值: ${JSON.stringify(input)}`);
      assert.equal(p.max, want.maxs[i], `trial ${trial} 探针 ${i} 最大值: ${JSON.stringify(input)}`);
      assert.equal(p.canonical, result.phases[i]);
      assert.equal(p.min, p.canonical, `trial ${trial} 探针 ${i} 规范相位应等于可取最小值`);
      const expectStatus = i === reference ? 'reference' : p.min === p.max ? 'fixed' : 'variable';
      assert.equal(p.status, expectStatus);
    }
    assert.equal(audit.counts.reference, 1);
    assert.equal(audit.reference, reference);
  }
});

test('超宽范围（20 万阈值层）：审计在同一残量网络上快速完成且结论精确', () => {
  const input = {
    probes: [
      { lo: 0, hi: 0 },
      { lo: -100000, hi: 100000 },
    ],
    edges: [
      { u: 0, v: 1, target: 50000, weight: 3 },
      { u: 0, v: 1, target: 50002, weight: 1 },
    ],
    reference: 0,
  };
  const { result, residual } = solveWithResidual(input);
  assert.equal(result.ok, true);
  const t0 = Date.now();
  const audit = auditFromResidual(residual, result.phases);
  assert.ok(Date.now() - t0 < 5000, `审计耗时过长：${Date.now() - t0}ms`);
  // x=50000 唯一最优（代价 2）；区间应为单点
  assert.equal(audit.probes[1].status, 'fixed');
  assert.equal(audit.probes[1].min, 50000);
  assert.equal(audit.probes[1].max, 50000);
});

test('交叉核对：篡改规范相位会触发内部一致性错误', () => {
  const input = mk(
    [
      [0, 0],
      [0, 2],
    ],
    [{ u: 0, v: 1, target: 1, weight: 1 }],
  );
  const { result, residual } = solveWithResidual(input);
  assert.equal(result.ok, true);
  assert.throws(() => auditFromResidual(residual, [0, result.phases[1] + 1]), /审计内部错误/);
});
