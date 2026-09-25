/**
 * 归属审计 Worker 协议端到端测试（worker_threads + self 垫片）：
 *  1) solve 成功后 audit（同代际）→ auditDone，区间正确；
 *  2) audit 代际不匹配（未知 id / 已被新复核顶掉 / 已取消）→ 静默不回传；
 *  3) 校验失败的复核不保留残量网络，audit 静默。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

const workerUrl = new URL('../src/worker/solver.worker.js', import.meta.url).href;

const BOOTSTRAP = `
const { parentPort } = require('node:worker_threads');
let handler = null;
const queue = [];
parentPort.on('message', (data) => {
  if (handler) handler({ data });
  else queue.push(data);
});
globalThis.self = {
  postMessage: (m) => parentPort.postMessage(m),
  set onmessage(fn) {
    handler = fn;
    while (queue.length) fn({ data: queue.shift() });
  },
  get onmessage() { return handler; },
};
import(${JSON.stringify(workerUrl)});
`;

function spawnWorker() {
  const w = new Worker(BOOTSTRAP, { eval: true });
  const inbox = [];
  const waiters = [];
  w.on('message', (m) => {
    if (waiters.length) waiters.shift()(m);
    else inbox.push(m);
  });
  const recv = (timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      if (inbox.length) return resolve(inbox.shift());
      const timer = setTimeout(() => reject(new Error('等待 Worker 消息超时')), timeoutMs);
      waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  const quiet = (ms = 400) =>
    new Promise((resolve) => setTimeout(resolve, ms)).then(() => {
      if (inbox.length) throw new Error(`预期无消息，但收到：${JSON.stringify(inbox)}`);
    });
  return { w, recv, quiet, post: (m) => w.postMessage(m) };
}

/** 闭环矛盾且同成本多相位面：探针 1∈[0,1]、探针 2∈[1,2] 可变 */
const multiOpt = {
  probes: [
    { lo: 0, hi: 0 },
    { lo: 0, hi: 2 },
    { lo: 0, hi: 3 },
  ],
  edges: [
    { u: 0, v: 1, target: 1, weight: 1 },
    { u: 1, v: 2, target: 1, weight: 1 },
    { u: 0, v: 2, target: 1, weight: 1 },
  ],
  reference: 0,
};

/** 唯一最优（闭环矛盾三角形样例 A） */
const uniqueOpt = {
  probes: [
    { lo: 0, hi: 0 },
    { lo: 0, hi: 3 },
    { lo: 0, hi: 3 },
  ],
  edges: [
    { u: 0, v: 1, target: 1, weight: 10 },
    { u: 0, v: 2, target: 1, weight: 1 },
    { u: 1, v: 2, target: 1, weight: 10 },
  ],
  reference: 0,
};

test('Worker 审计：同代际 audit 返回可变区间与三种状态', async () => {
  const s = spawnWorker();
  s.post({ type: 'solve', id: 1, input: multiOpt });
  const done = await s.recv();
  assert.equal(done.type, 'done');
  assert.equal(done.result.ok, true);
  assert.deepEqual(done.result.phases, [0, 0, 1]);

  s.post({ type: 'audit', id: 1 });
  const m = await s.recv();
  assert.equal(m.type, 'auditDone');
  assert.equal(m.id, 1);
  assert.equal(m.audit.ok, true);
  assert.deepEqual(
    m.audit.probes.map((p) => [p.canonical, p.min, p.max, p.status]),
    [
      [0, 0, 0, 'reference'],
      [0, 0, 1, 'variable'],
      [1, 1, 2, 'variable'],
    ],
  );
  assert.equal(m.audit.counts.variable, 2);
  await s.w.terminate();
});

test('Worker 审计：唯一最优样例全部单点', async () => {
  const s = spawnWorker();
  s.post({ type: 'solve', id: 2, input: uniqueOpt });
  await s.recv();
  s.post({ type: 'audit', id: 2 });
  const m = await s.recv();
  assert.equal(m.type, 'auditDone');
  assert.equal(m.audit.ok, true);
  for (const p of m.audit.probes) {
    assert.equal(p.min, p.max);
    assert.equal(p.min, p.canonical);
  }
  assert.equal(m.audit.counts.variable, 0);
  await s.w.terminate();
});

test('Worker 审计：代际不匹配的 audit 一律静默（未知 id / 被顶掉 / 已取消）', async () => {
  const s = spawnWorker();

  // 未知 id：从未有过成功复核
  s.post({ type: 'audit', id: 999 });
  await s.quiet(300);

  // 成功复核 id=10 后被新复核 id=11 顶掉：旧代际审计静默，新代际正常
  s.post({ type: 'solve', id: 10, input: multiOpt });
  const d10 = await s.recv();
  assert.equal(d10.type, 'done');
  s.post({ type: 'solve', id: 11, input: uniqueOpt });
  const d11 = await s.recv();
  assert.equal(d11.type, 'done');
  assert.equal(d11.id, 11);

  s.post({ type: 'audit', id: 10 }); // 旧代际：残量网络已被替换
  await s.quiet(300);

  s.post({ type: 'audit', id: 11 }); // 当前代际：正常回传
  const m = await s.recv();
  assert.equal(m.type, 'auditDone');
  assert.equal(m.id, 11);
  assert.equal(m.audit.ok, true);
  assert.equal(m.audit.counts.variable, 0);

  // 取消后：残量网络作废，审计静默
  s.post({ type: 'cancel', id: 12, silent: true });
  s.post({ type: 'audit', id: 11 });
  await s.quiet(300);
  await s.w.terminate();
});

test('Worker 审计：校验失败的复核不保留残量网络', async () => {
  const s = spawnWorker();
  s.post({
    type: 'solve',
    id: 20,
    input: { probes: [{ lo: 1, hi: 0 }, { lo: 0, hi: 0 }], edges: [], reference: 0 },
  });
  const done = await s.recv();
  assert.equal(done.result.ok, false);
  s.post({ type: 'audit', id: 20 });
  await s.quiet(300);
  await s.w.terminate();
});

test('Worker 审计：复核进行中（未成功）审计请求静默', async () => {
  const s = spawnWorker();
  // 重型输入使求解跨越若干让出点
  const heavy = {
    probes: [{ lo: 0, hi: 0 }, ...Array.from({ length: 39 }, () => ({ lo: -200, hi: 200 }))],
    edges: Array.from({ length: 200 }, (_, k) => ({
      u: k % 40,
      v: (k * 7 + 3) % 40,
      target: (k % 11) - 5,
      weight: (k % 8) + 1,
    })),
    reference: 0,
  };
  s.post({ type: 'solve', id: 30, input: heavy });
  s.post({ type: 'audit', id: 30 }); // 复核尚未成功，retained 为空
  const done = await s.recv();
  assert.equal(done.type, 'done');
  assert.equal(done.id, 30);
  // done 之后不应有迟到的 auditDone（请求已被静默丢弃）
  await s.quiet(400);
  await s.w.terminate();
});
