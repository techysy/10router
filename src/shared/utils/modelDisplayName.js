/**
 * 展示层模型名映射：统计/健康度/请求明细里把供应商的内部代号翻译成真实产品名
 * （如 qoder-cn 的 kmodel_latest → Kimi-K3.1-Pro、qmodel_latest → Qwen4-Max-Preview）。
 *
 * 只读注册表数据，绝不改写请求链路 —— executor/translator 仍按注册表原始 id 寻址，
 * 上游收到的还是 `kmodel_latest` 这些 key；这里仅服务于 dashboard 展示。
 * 查不到（自定义节点、未知 id、无 provider）原样返回，调用方无需判空。
 */
import { findModelName } from "open-sse/config/providerModels.js";
import { resolveProviderAlias } from "open-sse/services/model.js";

// 退役模型：注册表行已撤（上游下线/转正），但 usageHistory 里的历史行还会在
// 统计/健康度里出现多年。查注册表必然落空（行已不在），这里给最后一跳的
// 静态退役名 —— 展示"它当年叫什么"，而不是裸 id。键为 "provider/model"，
// provider 侧按规范 id 存（调用方传 alias 时先归一化）。
const RETIRED_MODEL_NAMES = {
  // QoDuck 2026-11-11 转正 Qwen4-Max-Preview（key qmodel_latest），旧 key 上游 400
  "qoder/lmodel": "QoDuck (retired → Qwen4-Max-Preview)",
  "qoder-cn/lmodel": "QoDuck (retired → Qwen4-Max-Preview)",
};

export function modelDisplayName(provider, model) {
  const raw = typeof model === "string" ? model : model == null ? "" : String(model);
  if (!raw || !provider) return raw;
  let canonical = provider;
  try {
    canonical = resolveProviderAlias(provider) || provider;
  } catch { /* non-registry provider: use as-is */ }
  const retired = RETIRED_MODEL_NAMES[`${canonical}/${raw}`];
  if (retired) return retired;
  try {
    return findModelName(provider, raw) || raw;
  } catch {
    return raw;
  }
}
