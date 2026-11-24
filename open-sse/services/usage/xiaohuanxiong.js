/**
 * 商汤小浣熊 usage — GET /api/web/points/v1/balance + /api/web/points/v1/tasks
 * Auth: Bearer <IAM access_token>
 *
 * 积分是任务制+邀请制（注册礼包/桌面登录/移动登录、拉新 1500 分/人上限20），
 * 完成后服务端自动发放 —— 没有每日签到/claim 端点。
 *
 * balance -> {code:0, data:{available_points, daily_points, monthly_points,
 *   reward_points, topup_points, enterprise_topup_points, total_chargeable_points,
 *   topup_frozen, ...}}
 * tasks   -> {code:0, data:{invite:{invite_code, register_reward_points,
 *   registered_invitee_count, remaining_reward_invitees, granted_points},
 *   invitee_task_states:[], new_user_task_states:[{key,status}]}}
 *   task keys: register_pack / desktop_login / mobile_login; status: completed|unfinished
 *
 * 邀请链接（官网 B.uX 拼法）：{site}/{locale}/events/refer?code={invite_code}
 *   &utm_source=friend_invitation_action —— 塞进 quota 行 note 供复制。
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { toFiniteNumber } from "./shared.js";

const SITE = "https://xiaohuanxiong.com";
const POINTS_API = `${SITE}/api/web/points/v1`;

const TASK_LABELS = {
  register_pack: "注册礼包",
  desktop_login: "桌面端登录",
  mobile_login: "移动端登录",
};

/**
 * @param {string|null|undefined} accessToken  IAM JWT（oauth 连接的 accessToken）
 * @param {object|null} proxyOptions
 */
export async function getXiaohuanxiongUsage(accessToken = null, proxyOptions = null) {
  const token = typeof accessToken === "string" ? accessToken.trim() : "";
  if (!token) {
    return { plan: "商汤小浣熊", message: "未连接：先扫码登录后查看配额。" };
  }

  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };

  let bal;
  try {
    const r = await proxyAwareFetch(`${POINTS_API}/balance`, { method: "GET", headers }, proxyOptions);
    if (r.status === 401 || r.status === 403) {
      return { plan: "商汤小浣熊", message: "登录已过期，请重新扫码。" };
    }
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.code !== 0 || !j.data) {
      return {
        plan: "商汤小浣熊",
        message: `积分接口异常 (HTTP ${r.status}${j?.message ? `: ${j.message}` : ""})。`,
      };
    }
    bal = j.data;
  } catch (e) {
    return { plan: "商汤小浣熊", message: `积分查询失败: ${e.message}` };
  }

  let tasks = null;
  try {
    const r = await proxyAwareFetch(`${POINTS_API}/tasks`, { method: "GET", headers }, proxyOptions);
    const j = await r.json().catch(() => null);
    if (j && j.code === 0 && j.data) tasks = j.data;
  } catch {}

  const N = (v) => toFiniteNumber(v, 0);
  const quotas = {};

  const avail = N(bal.available_points);
  const total = N(bal.total_chargeable_points) || avail;
  quotas["可用积分"] = {
    used: Math.max(0, total - avail),
    total,
    remaining: avail,
    remainingPercentage: total > 0 ? Math.max(0, Math.min(100, (100 * avail) / total)) : 0,
    resetAt: null,
    displayRemaining: true,
    unlimited: false,
  };

  const bucket = (label, v) => {
    const n = N(v);
    if (n > 0) {
      quotas[label] = {
        used: 0,
        total: n,
        remaining: n,
        remainingPercentage: 100,
        resetAt: null,
        displayRemaining: true,
        detailOnly: true,
        unlimited: false,
      };
    }
  };
  bucket("日常积分", bal.daily_points);
  bucket("月度积分", bal.monthly_points);
  bucket("奖励积分", bal.reward_points);
  bucket("充值积分", N(bal.topup_points) + N(bal.enterprise_topup_points));

  let plan = "商汤小浣熊";
  if (tasks) {
    const HINTS = { mobile_login: "装App登录" };
    const rows = [];
    for (const s of tasks.new_user_task_states || []) {
      const done = s.status === "completed";
      const hint = done ? "✓" : `○${HINTS[s.key] ? `(${HINTS[s.key]})` : ""}`;
      rows.push(`${TASK_LABELS[s.key] || s.key}:${hint}`);
    }
    const inv = tasks.invite || {};
    const inviteUrl = inv.invite_code
      ? `${SITE}/zh/events/refer?code=${inv.invite_code}&utm_source=friend_invitation_action`
      : null;
    rows.push(`邀请 ${N(inv.registered_invitee_count)}/${N(inv.remaining_reward_invitees)}人 已得${N(inv.granted_points)}分`);
    if (inviteUrl) rows.push(`邀请链接: ${inviteUrl}`);
    if (rows.length) {
      quotas["积分任务"] = {
        used: (tasks.new_user_task_states || []).filter((s) => s.status === "completed").length,
        total: (tasks.new_user_task_states || []).length || rows.length,
        remainingPercentage: 0,
        resetAt: null,
        detailOnly: true,
        recurring: true,
        note: rows.join(" · "),
      };
    }
  }
  if (bal.topup_frozen) plan += " (充值冻结)";

  return { plan, quotas, subscriptionInfo: { pointsTotal: avail } };
}
