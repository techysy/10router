/**
 * 展示层模型名映射：统计/健康度/请求明细里把供应商的内部代号翻译成真实产品名
 * （如 qoder-cn 的 kmodel_latest → Kimi-K3.1-Pro、lmodel → QoDuck、qmodel_latest → Qwen3.7-Max）。
 *
 * 只读注册表数据，绝不改写请求链路 —— executor/translator 仍按注册表原始 id 寻址，
 * 上游收到的还是 `kmodel_latest` 这些 key；这里仅服务于 dashboard 展示。
 * 查不到（自定义节点、未知 id、无 provider）原样返回，调用方无需判空。
 */
import { findModelName } from "open-sse/config/providerModels.js";

export function modelDisplayName(provider, model) {
  const raw = typeof model === "string" ? model : model == null ? "" : String(model);
  if (!raw || !provider) return raw;
  try {
    return findModelName(provider, raw) || raw;
  } catch {
    return raw;
  }
}
