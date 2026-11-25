// Theos errors describe quota eligibility, not necessarily API-key validity.
// Keep sign-in and quota tracking consistent, without echoing upstream bodies
// (which can contain credentials or an HTML gateway challenge).
export function formatDeepaiQuotaError(status, payload, apiKey = "") {
  const rawCode = payload?.error?.code || payload?.error?.type || payload?.code;
  const code = typeof rawCode === "string" && /^[a-z][a-z0-9_]{0,63}$/i.test(rawCode)
    && !(apiKey && rawCode.includes(apiKey)) ? rawCode : "";
  const detail = `HTTP ${status}${code ? `，${code}` : ""}`;

  if (code === "machine_required") {
    return `DeepAI 免费 Theos 暂不可用（${detail}）：上游设备验证未通过，请检查运行 10router 的主机是否具有稳定的系统设备标识，或在官方客户端检查账户状态。此限制不表示 API Key 已失效；免费模型可单独测试使用。`;
  }
  if (code === "social_login_required") {
    return `DeepAI 额度查询受限（${detail}）：该账号需要通过 Google 或 Apple 登录后才能使用 DeepAI Code。`;
  }
  if (status === 401 || code === "auth_required") {
    return `DeepAI 额度接口未接受此凭据（${detail}），请检查 API Key 或重新授权。`;
  }
  return `DeepAI 额度查询失败（${detail}）。余额接口拒绝访问不一定代表 API Key 失效，请单独运行模型测试。`;
}
