/**
 * Worker 协议端到端测试：用 worker_threads + self 垫片加载真实的
 * src/worker/solver.worker.js，验证：
 *  1) 正常 solve → done，结果正确；
 *  2) 草稿替换（新 solve 顶掉旧 run）后，旧 run 的结果永不回传；
 *  3) 显式 cancel 回 canceled；silent cancel 不回执；
 *  4) 成功复核后 audit → audited，区间结论正确；
 *  5) 草稿替换 / 取消后旧代际 audit → auditStale，绝不重新求解。
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

const sampleA = {
  probes: [{ lo: 0, hi: 0 }, { lo: 0, hi: 3 }, { lo: 0, hi: 3 }],
  edges: [
    { u: 0, v: 1, target: 1, weight: 10 },
    { u: 0, v: 2, target: 1, weight: 1 },
    { u: 1, v: 2, target: 1, weight: 10 },
  ],
  reference: 0,
};

test('Worker：正常复核返回 done 且结论精确', async () => {
  const s = spawnWorker();
  s.post({ type: 'solve', id: 1, input: sampleA });
  const m = await s.recv();
  assert.equal(m.type, 'done');
  assert.equal(m.id, 1);
  assert.equal(m.result.ok, true);
  assert.deepEqual(m.result.phases, [0, 1, 2]);
  assert.equal(m.result.cost, 1);
  await s.w.terminate();
});

test('Worker：校验失败以 done 返回错误而不崩溃', async () => {
  const s = spawnWorker();
  s.post({
    type: 'solve',
    id: 7,
    input: { probes: [{ lo: 1, hi: 0 }, { lo: 0, hi: 0 }], edges: [], reference: 0 },
  });
  const m = await s.recv();
  assert.equal(m.type, 'done');
  assert.equal(m.id, 7);
  assert.equal(m.result.ok, false);
  assert.ok(m.result.errors.length > 0);
  await s.w.terminate();
});

test('Worker：草稿替换后旧 run 结果绝不回传（核心失效策略）', async () => {
  const s = spawnWorker();

  // 重型输入：40 探针 × 宽范围 × 大量边，确保旧计算在让出点之前仍在运行。
  const heavy = {
    probes: [{ lo: 0, hi: 0 }, ...Array.from({ length: 39 }, () => ({ lo: -200, hi: 200 }))],
    edges: (() => {
      const es = [];
      let seed = 7;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      for (let k = 0; k < 200; k++) {
        const u = Math.floor(rnd() * 40);
        let v = Math.floor(rnd() * 40);
        if (v === u) v = (v + 1) % 40;
        es.push({ u, v, target: Math.floor(rnd() * 11) - 5, weight: 1 + Math.floor(rnd() * 8) });
      }
      return es;
    })(),
    reference: 0,
  };

  s.post({ type: 'solve', id: 100, input: heavy });
  // 立即用新草稿顶掉（模拟用户在计算中修改输入）。
  s.post({ type: 'solve', id: 101, input: sampleA });

  // 唯一允许到达的结论是 id=101；id=100 的 done 永远不能出现。
  const m = await s.recv();
  assert.equal(m.id, 101);
  assert.equal(m.type, 'done');
  assert.deepEqual(m.result.phases, [0, 1, 2]);

  // 等足够久确认旧计算没有迟到的回传。
  await s.quiet(600);
  await s.w.terminate();
});

test('Worker：显式 cancel 回执 canceled；silent cancel 不回执', async () => {
  const s = spawnWorker();
  s.post({ type: 'cancel', id: 200 });
  const m = await s.recv();
  assert.deepEqual(m, { type: 'canceled', id: 200 });

  s.post({ type: 'cancel', id: 201, silent: true });
  await s.quiet(400);
  await s.w.terminate();
});

test('Worker：成功复核后发起归属审计返回 audited 且区间正确', async () => {
  const s = spawnWorker();
  s.post({ type: 'solve', id: 300, input: sampleA });
  const done = await s.recv();
  assert.equal(done.type, 'done');
  assert.equal(done.id, 300);
  assert.deepEqual(done.result.phases, [0, 1, 2]);

  s.post({ type: 'audit', id: 300 });
  const m = await s.recv();
  assert.equal(m.type, 'audited');
  assert.equal(m.id, 300);
  assert.equal(m.audit.ok, true);
  assert.equal(m.audit.cost, 1);
  // 高权仲裁样例唯一最优：除参考点外全部单点固定。
  assert.ok(m.audit.probes.every((r) => r.min === r.max));
  assert.equal(m.audit.probes[0].status, 'reference');
  assert.equal(m.audit.probes[1].status, 'fixed');
  assert.equal(m.audit.probes[2].status, 'fixed');
  await s.w.terminate();
});

test('Worker：等权矛盾环审计观察到可变区间与联动见证', async () => {
  const tieCycle = {
    probes: [{ lo: 0, hi: 0 }, { lo: 0, hi: 3 }, { lo: 0, hi: 3 }],
    edges: [
      { u: 0, v: 1, target: 1, weight: 1 },
      { u: 1, v: 2, target: 0, weight: 1 },
      { u: 2, v: 0, target: -2, weight: 1 },
    ],
    reference: 0,
  };
  const s = spawnWorker();
  s.post({ type: 'solve', id: 301, input: tieCycle });
  assert.equal((await s.recv()).type, 'done');
  s.post({ type: 'audit', id: 301 });
  const m = await s.recv();
  assert.equal(m.type, 'audited');
  assert.deepEqual(
    m.audit.probes.map((r) => [r.min, r.max, r.status]),
    [
      [0, 0, 'reference'],
      [1, 2, 'variable'],
      [1, 2, 'variable'],
    ],
  );
  assert.deepEqual(m.audit.witnesses.min.phases, [0, 1, 1]);
  assert.deepEqual(m.audit.witnesses.max.phases, [0, 2, 2]);
  await s.w.terminate();
});

test('Worker：新复核顶掉旧现场后，旧代际审计回 auditStale 且不重算', async () => {
  const s = spawnWorker();
  s.post({ type: 'solve', id: 400, input: sampleA });
  assert.equal((await s.recv()).type, 'done');

  // 草稿编辑/新复核立即作废残量现场。
  s.post({ type: 'solve', id: 401, input: sampleA });
  assert.equal((await s.recv()).type, 'done');

  // 旧代际 400 的审计必须被拒绝。
  s.post({ type: 'audit', id: 400 });
  const stale = await s.recv();
  assert.deepEqual(stale, { type: 'auditStale', id: 400 });

  // 当前代际 401 的审计正常受理。
  s.post({ type: 'audit', id: 401 });
  const m = await s.recv();
  assert.equal(m.type, 'audited');
  assert.equal(m.id, 401);
  await s.w.terminate();
});

test('Worker：取消后审计因代际现场缺失回 auditStale', async () => {
  const s = spawnWorker();
  s.post({ type: 'solve', id: 500, input: sampleA });
  assert.equal((await s.recv()).type, 'done');
  s.post({ type: 'cancel', id: 500, silent: true });
  // 给事件循环一点时间处理取消。
  await new Promise((r) => setTimeout(r, 50));
  s.post({ type: 'audit', id: 500 });
  const m = await s.recv();
  assert.deepEqual(m, { type: 'auditStale', id: 500 });
  await s.w.terminate();
});

test('Worker：审计只认当前成功复核代际——从未成功过的 id 回 auditStale', async () => {
  const s = spawnWorker();
  s.post({ type: 'audit', id: 999 });
  const m = await s.recv();
  assert.deepEqual(m, { type: 'auditStale', id: 999 });
  await s.w.terminate();
});
