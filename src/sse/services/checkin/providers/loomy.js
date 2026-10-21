// Loomy（讯飞）每日签到 = **每日首次登录刷新赠送积分** + 新手任务批量领取。
//
// ── 上游是什么（Rust loomy/{checkin,onboarding}.rs，实测 2026-10）──────
//   POST {base}/api/v1/points/first-login      body {}         每日赠送积分刷回
//   GET  {base}/api/v1/onboarding/tasks                        8 个一次性任务
//   POST {base}/api/v1/onboarding/tasks/complete body {"key"}  逐个上报领取
//
// first-login 是**按天幂等**的：当天已刷过也返回 `000000`，没有可区分的
// “already” 字段 —— 所以「今天已签到」由本适配器的日 memo 判定（第二次运行
// 不再打上游，符合 13.5 的重复执行验收）。
//
// 新手任务是一次性福利，但重复上报幂等（`alreadyCompleted=true`）。这里每天
// 只在 `GET tasks` 显示有未完成 key 时才 POST，全部领完后每天只剩一次只读
// 查询；领取分值用 Rust 的 TASK_POINTS 静态表，不信任上游回传的 earned。
//
// 业务错误仍是 HTTP 200 + `{code,desc}`：`000000` 成功，`020002` / `100002`
// 登录失效。登录失效一律 → needs-reauth（会话 14 天、无续期，只能重新导入）。

// Keep in sync with open-sse/executors/loomy.js QUOTA_STRONG_RE: a plain 429
// is rate limiting, only explicit "points exhausted" copy is a quota wall.
const QUOTA_STRONG_RE =
  /(积分|点数|额度|余额)\s*(已)?\s*(不足|用完|耗尽|用尽|超限|扣光)|insufficient\s+(quota|points|credits|balance)|quota\s+(exceeded|exhausted|depleted)|no\s+points\s+left|out\s+of\s+(points|credits)/i;

const LOOMY_BASE_URL = "https://loomyad.xunfei.cn";
const FIRST_LOGIN_PATH = "/api/v1/points/first-login";
const TASKS_PATH = "/api/v1/onboarding/tasks";
const COMPLETE_PATH = "/api/v1/onboarding/tasks/complete";
const REQUEST_TIMEOUT_MS = 20_000;

const SUCCESS_CODES = new Set(["", "0", "000000"]);
const AUTH_ERROR_CODES = new Set(["020002", "100002"]);

/** 每日赠送积分的名义值；响应里带了明确发放量时以响应为准。 */
export const LOOMY_DAILY_POINTS = 5000;

/** Rust onboarding.rs 的 TASK_POINTS（key 与分值都不可改，上游认 key）。 */
export const LOOMY_ONBOARDING_TASKS = [
  { key: "first_message", title: "发送你的第一条消息", points: 500 },
  { key: "pick_skill", title: "试试选择一个技能", points: 1000 },
  { key: "generate_ppt", title: "生成第一份 PPT", points: 1500 },
  { key: "set_schedule", title: "设置定时任务", points: 1000 },
  { key: "install_skill", title: "在技能广场安装一个技能", points: 1500 },
  { key: "configure_remote", title: "配置远程控制", points: 1000 },
  { key: "create_soul", title: "创建你的第一个搭子", points: 1500 },
  { key: "share_soul", title: "把搭子分享给朋友", points: 2000 },
];

const RUNNING = new Set();
const DAY_MEMO = new Map();
const MEMO_LIMIT = 500;

const tokenOf = (conn) =>
  String(conn?.accessToken || conn?.apiKey || "").trim().replace(/^Bearer\s+/i, "");

function accountKeyOf(conn) {
  return String(conn?.id || conn?.email || conn?.name || "loomy");
}

export function localDayKey(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const codeOf = (payload) =>
  payload?.code === undefined || payload?.code === null ? "" : String(payload.code).trim();

function messageOf(payload) {
  const candidates = [payload?.desc, payload?.message, payload?.msg, payload?.error?.message];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 500);
  }
  return "";
}

async function requestJson(fetchImpl, url, init) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    return { ok: false, status: 0, payload: null, text: "", error: error?.message || String(error) };
  }
  let payload = null;
  let text = "";
  try {
    if (typeof response.json === "function") {
      payload = await response.json();
      text = payload == null ? "" : JSON.stringify(payload);
    } else if (typeof response.text === "function") {
      text = await response.text();
      payload = text ? JSON.parse(text) : null;
    }
  } catch {
    payload = null;
  }
  const status = Number(response.status) || 0;
  return { ok: status >= 200 && status < 300, status, payload, text };
}

/** 明确的发放量字段；没有就返回 null（调用方回落到 5000）。 */
function dailyAmountOf(payload) {
  const outer = payload?.data && typeof payload.data === "object" ? payload.data : null;
  const inner = outer?.data && typeof outer.data === "object" ? outer.data : null;
  for (const data of [inner, outer]) {
    if (!data) continue;
    for (const key of ["amount", "gain", "reward", "grantedPoints", "rewardPoints"]) {
      const value = Number(data[key]);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return null;
}

function alreadyToday(payload) {
  const outer = payload?.data && typeof payload.data === "object" ? payload.data : null;
  const inner = outer?.data && typeof outer.data === "object" ? outer.data : null;
  for (const data of [inner, outer]) {
    if (!data) continue;
    if (data.already === true || data.alreadyFirstLogin === true) return true;
  }
  return false;
}

const timeoutSignal = () =>
  typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined;

/**
 * 无锁/无 memo 的完整网络流程（单测直接调用它）。
 * 返回 `{status, amount?, unit?, code?, message}`，status 取值见 registry 契约。
 */
export async function runLoomyCheckin(conn, ctx = {}) {
  const token = tokenOf(conn);
  if (!token) {
    return { status: "needs-reauth", code: "no-credentials", message: "Loomy 连接缺少 session，请重新导入。" };
  }
  if (ctx.dryRun) {
    return { status: "ok", amount: 0, unit: "积分", code: "dry-run", message: "dry-run：未提交签到" };
  }

  const fetchImpl = ctx.fetch || fetch;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    token,
    Authorization: `Bearer ${token}`,
  };

  // ── 第一步：每日首次登录刷新 ────────────────────────────────
  const login = await requestJson(fetchImpl, `${LOOMY_BASE_URL}${FIRST_LOGIN_PATH}`, {
    method: "POST",
    headers,
    body: "{}",
    signal: timeoutSignal(),
  });

  if (!login.ok) {
    if (login.status === 401 || login.status === 403) {
      return {
        status: "needs-reauth",
        code: "auth",
        message: "Loomy 登录态已失效（HTTP 401/403），请重新导入 session。",
      };
    }
    if (login.status === 429) {
      return { status: "limited", code: "rate-limited", message: "Loomy 每日刷新被限流（HTTP 429）。" };
    }
    return {
      status: "failed",
      code: login.status ? `http-${login.status}` : "network",
      message: login.status
        ? `Loomy 每日刷新返回 HTTP ${login.status}。`
        : `Loomy 每日刷新失败：${login.error}`,
    };
  }

  const code = codeOf(login.payload);
  if (AUTH_ERROR_CODES.has(code)) {
    return { status: "needs-reauth", code: "auth", message: "Loomy 登录态已失效（业务码），请重新导入 session。" };
  }
  const loginMessage = messageOf(login.payload);
  if (!SUCCESS_CODES.has(code)) {
    if (QUOTA_STRONG_RE.test(loginMessage)) {
      return { status: "limited", code: "quota", message: `Loomy 积分已耗尽：${loginMessage}` };
    }
    return {
      status: "failed",
      code: code ? `business-${code}` : "business",
      message: loginMessage ? `Loomy 每日刷新失败：${loginMessage}` : `Loomy 每日刷新失败（code=${code}）。`,
    };
  }
  if (alreadyToday(login.payload)) {
    return { status: "already", amount: 0, unit: "积分", code: "daily-done", message: "今天已刷新每日赠送积分。" };
  }

  const dailyAmount = dailyAmountOf(login.payload) ?? LOOMY_DAILY_POINTS;

  // ── 第二步：新手任务批量领取（一次性福利，只领未完成的）──────
  let claimed = 0;
  let claimedPoints = 0;
  let onboardingError = "";

  const tasksResult = await requestJson(fetchImpl, `${LOOMY_BASE_URL}${TASKS_PATH}`, {
    method: "GET",
    headers,
    signal: timeoutSignal(),
  });

  if (!tasksResult.ok) {
    if (tasksResult.status === 401 || tasksResult.status === 403) {
      return { status: "needs-reauth", code: "auth", message: "Loomy 登录态已失效（新手任务查询）。" };
    }
    onboardingError = tasksResult.status
      ? `新手任务查询返回 HTTP ${tasksResult.status}`
      : `新手任务查询失败：${tasksResult.error}`;
  } else {
    const tasksCode = codeOf(tasksResult.payload);
    if (AUTH_ERROR_CODES.has(tasksCode)) {
      return { status: "needs-reauth", code: "auth", message: "Loomy 登录态已失效（新手任务查询）。" };
    }
    if (!SUCCESS_CODES.has(tasksCode)) {
      onboardingError = messageOf(tasksResult.payload) || `新手任务查询失败（code=${tasksCode}）`;
    } else {
      const done = tasksResult.payload?.data?.tasks || tasksResult.payload?.data?.data?.tasks;
      const doneMap = done && typeof done === "object" ? done : {};
      for (const task of LOOMY_ONBOARDING_TASKS) {
        if (doneMap[task.key] === true) continue;
        const claim = await requestJson(fetchImpl, `${LOOMY_BASE_URL}${COMPLETE_PATH}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ key: task.key }),
          signal: timeoutSignal(),
        });
        if (!claim.ok) {
          if (claim.status === 401 || claim.status === 403) {
            return { status: "needs-reauth", code: "auth", message: "Loomy 登录态已失效（新手任务领取）。" };
          }
          onboardingError = claim.status
            ? `新手任务「${task.title}」领取返回 HTTP ${claim.status}`
            : `新手任务「${task.title}」领取失败：${claim.error}`;
          continue;
        }
        const claimCode = codeOf(claim.payload);
        if (AUTH_ERROR_CODES.has(claimCode)) {
          return { status: "needs-reauth", code: "auth", message: "Loomy 登录态已失效（新手任务领取）。" };
        }
        if (!SUCCESS_CODES.has(claimCode)) {
          onboardingError =
            messageOf(claim.payload) || `新手任务「${task.title}」领取失败（code=${claimCode}）`;
          continue;
        }
        claimed += 1;
        // alreadyCompleted=true 表示别的端刚领过：任务完成，但这轮没有再发分。
        if (claim.payload?.data?.alreadyCompleted !== true) {
          claimedPoints += task.points;
        }
      }
    }
  }

  const amount = dailyAmount + claimedPoints;
  let message = `每日赠送积分已刷新（+${dailyAmount} 积分）`;
  if (claimed > 0) {
    message += `；新手任务领取 ${claimed} 项${claimedPoints > 0 ? ` +${claimedPoints} 积分` : "（已由其他端领取）"}`;
  }
  if (onboardingError) {
    message += `；${onboardingError}`;
  }

  return {
    status: "ok",
    amount,
    unit: "积分",
    code: claimed > 0 ? "daily+onboarding" : "daily",
    message,
  };
}

export default {
  id: "loomy",
  providers: ["loomy"],
  settingsKey: "loomyCheckin",
  cadence: "daily",

  async run(conn, ctx = {}) {
    const day = ctx.today || localDayKey();
    const account = accountKeyOf(conn);
    const memoKey = `${account}|${day}`;

    const remembered = DAY_MEMO.get(memoKey);
    if (remembered) {
      return { status: "already", amount: 0, unit: "积分", code: "memo", message: remembered };
    }
    if (RUNNING.has(account)) {
      return { status: "limited", code: "already-running", message: "Loomy 签到正在进行中。" };
    }

    RUNNING.add(account);
    try {
      const outcome = await runLoomyCheckin(conn, ctx);
      if (outcome.status === "ok" || outcome.status === "already") {
        if (DAY_MEMO.size >= MEMO_LIMIT) DAY_MEMO.clear();
        DAY_MEMO.set(memoKey, outcome.message || "今天已签到");
      }
      return outcome;
    } finally {
      RUNNING.delete(account);
    }
  },
};

/** 单测 seam：清空进程内锁与日 memo。 */
export function __resetLoomyCheckinState() {
  RUNNING.clear();
  DAY_MEMO.clear();
}

export const __test__ = {
  dailyAmountOf,
  alreadyToday,
  accountKeyOf,
};
