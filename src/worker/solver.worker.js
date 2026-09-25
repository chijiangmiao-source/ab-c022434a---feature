/**
 * 求解 Worker：主线程仅做录入与渲染，最小割计算在后台进行，
 * 不阻塞页面交互。
 *
 * 协议（主线程 → Worker）：
 *   { type: 'solve',  id, input }  发起/替换一次复核
 *   { type: 'cancel', id, silent? } 取消当前复核；silent 时不回 canceled
 *   { type: 'audit',  id }          对代际 id 的成功复核发起最优解归属审计
 * 协议（Worker → 主线程）：
 *   { type: 'done',      id, result } 求解结束（成功或输入校验失败）
 *   { type: 'canceled',  id }         被显式取消中止
 *   { type: 'auditDone', id, audit }  归属审计完成
 *
 * 失效策略（代际令牌）：每次 solve 生成唯一 token 并替换 activeToken；
 * 正在运行的旧计算在让出点检测到令牌易主即退出，且退出后不再回传，
 * 因而草稿修改或取消之后，旧结论绝不可能覆盖当前界面状态。
 *
 * 归属审计的数据源是**同一次**精确最小割完成后的残量网络：复核成功时
 * 将其与代际 id 一起保留（retained）；草稿修改、取消或新复核会立即
 * 清空。audit 仅当代际 id 与 retained 匹配时才计算并回传，不匹配一律
 * 静默丢弃——Worker 不会为过期复核提交任何审计结果。
 */
import { solveAsyncWithResidual } from '../lib/solver.js';
import { auditFromResidual } from '../lib/audit.js';

let activeToken = null;
/** 最近一次成功复核保留的残量网络：{ id, residual, phases }；归属审计的唯一数据源 */
let retained = null;

self.onmessage = async (ev) => {
  const msg = ev.data;

  if (msg.type === 'solve') {
    const token = { id: msg.id };
    activeToken = token;
    retained = null; // 新复核发起即作废旧残量网络，旧审计不可能再产出
    try {
      const { result, residual } = await solveAsyncWithResidual(msg.input, () => activeToken !== token);
      // 计算途中若已易主（新草稿 / 取消），直接丢弃，不得回传。
      if (activeToken !== token) return;
      activeToken = null;
      // 仅成功复核保留残量网络；校验失败无网络可审计。
      if (result.ok && residual) retained = { id: msg.id, residual, phases: result.phases };
      self.postMessage({ type: 'done', id: msg.id, result });
    } catch (err) {
      if (activeToken !== token) return;
      activeToken = null;
      self.postMessage({
        type: 'done',
        id: msg.id,
        result: {
          ok: false,
          errors: [
            {
              kind: 'internal',
              message: `求解器内部错误：${err && err.stack ? err.stack : String(err)}`,
            },
          ],
        },
      });
    }
    return;
  }

  if (msg.type === 'audit') {
    // 代际闸门：只接受与当前保留的成功复核同代际的审计请求；
    // 草稿已改 / 已取消 / 已发起新复核时 retained 为空或 id 不符，静默丢弃。
    if (!retained || retained.id !== msg.id) return;
    const mine = retained;
    try {
      // 在同一残量网络上构造最小割格（SCC 偏序），线性时间一次完成。
      const audit = auditFromResidual(mine.residual, mine.phases);
      // 回传前再验代际：审计期间不得被新复核 / 取消顶掉。
      if (retained !== mine) return;
      self.postMessage({ type: 'auditDone', id: msg.id, audit });
    } catch (err) {
      if (retained !== mine) return;
      self.postMessage({
        type: 'auditDone',
        id: msg.id,
        audit: {
          ok: false,
          errors: [
            {
              kind: 'internal',
              message: `归属审计内部错误：${err && err.stack ? err.stack : String(err)}`,
            },
          ],
        },
      });
    }
    return;
  }

  if (msg.type === 'cancel') {
    // 置空令牌使正在运行的计算在最近的让出点停止；主循环的下一条
    // solve 消息也会同样顶掉旧令牌。草稿失效类取消为 silent，
    // 不回传以免覆盖主线程已经写好的状态。
    activeToken = null;
    retained = null; // 取消即作废归属审计的数据源
    if (!msg.silent) self.postMessage({ type: 'canceled', id: msg.id });
  }
};
