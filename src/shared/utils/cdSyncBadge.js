// CD Sync 徽章的单一事实源。ConnectionRow（连接行）与 ProviderLimits（配额页）
// 各自渲染样式，但「哪些 provider 亮徽章、旗标判定、Native 提示文案」必须同源
// ——白名单此前在两处手抄，已经漂移过一次（loomy 只加了一边）。CD 新增同步
// 渠道时只改 NATIVE_AUTH_LABELS 一处，并补齐三语词条。
const NATIVE_AUTH_LABELS = {
  qoder: "Native Qoder authorization",
  "qoder-cn": "Native Qoder authorization",
  "codebuddy-cn": "Native CodeBuddy authorization",
  "codebuddy-intl": "Native CodeBuddy authorization",
  loomy: "Native Loomy authorization",
  "minimax-code": "Native MiniMax Code authorization",
  "minimax-code-global": "Native MiniMax Code (Global) authorization",
  // 2026-11-15 用户定版：meoo 的登录授权放 CreditDaddy（上游 OAuth 应用只
  // 注册回环 redirect_uri，仪表盘发起必然 invalid_redirect_uri）。
  meoo: "Native Meoo authorization",
};

/** 该 provider 的连接行是否渲染 CD Sync / Native 徽章。 */
export function hasCdSyncBadge(provider) {
  return Boolean(provider) && provider in NATIVE_AUTH_LABELS;
}

/** 连接是否来自 CreditDaddy 同步（qoder 走网页会话旗标，其余走统一 apikey 旗标）。 */
export function isCdSyncedConnection(connection) {
  return Boolean(
    connection?.providerSpecificData?.creditDaddyWebSession ||
    connection?.providerSpecificData?.creditDaddySync
  );
}

/** 徽章 title 的词条 key（调用方自行 translate；白名单内 provider 必命中映射）。 */
export function cdSyncBadgeTitleKey(connection) {
  if (connection?.providerSpecificData?.creditDaddyWebSession) {
    return "Synced via CreditDaddy web session (issue feedback goes to CreditDaddy)";
  }
  if (isCdSyncedConnection(connection)) {
    return "Synced from CreditDaddy (issue feedback goes to CreditDaddy)";
  }
  return NATIVE_AUTH_LABELS[connection?.provider] || "Native authorization";
}
