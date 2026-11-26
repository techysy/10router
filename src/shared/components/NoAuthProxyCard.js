"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import Card from "./Card";
import Select from "./Select";
import Badge from "./Badge";
import { translate } from "@/i18n/runtime";

const NONE_PROXY_POOL_VALUE = "__none__";
const STRATEGIES = [
  { value: "none", label: "None (single pool)" },
  { value: "round-robin", label: "Round-robin" },
  { value: "random", label: "Random" },
];

// CreditDaddy 网关线（zcode-free / trae-free 共用同一 daemon:主机/端口设置
// 键共享,路径按线分开。CreditDaddy 侧统一按品牌分线:zcode = /gateway/zcode/
// v1/messages、minimax = /gateway/minimax/…、trae = /gateway/trae/…。三条线
// 的默认路径都由 CreditDaddy 自己的版本决定,10Router 这边只跟随。
// （旧的裸端点 /gateway/v1/messages 是 CreditDaddy 迁移前的形状,已不存在;
//  把它当成「可直连 zcode-api」的可选值会让人填出一个必然 404 的路径。）
// 网关路径同样允许覆盖。defaultPath 同时用作占位符与预填值(输入框显示
// 的就是生效路径),故不另设 pathPlaceholder。非 CreditDaddy 线不渲染网关区。
const CREDITDADDY_LINES = {
  "zcode-free": { pathKey: "zcodeGatewayPath", defaultPath: "/gateway/zcode/v1/messages" },
  "minimax-free": { pathKey: "minimaxGatewayPath", defaultPath: "/gateway/minimax/v1/messages" },
  "trae-free": { pathKey: "traeGatewayPath", defaultPath: "/gateway/trae/v1/messages" },
};

export default function NoAuthProxyCard({ providerId }) {
  const [proxyPools, setProxyPools] = useState([]);
  const [proxyPoolId, setProxyPoolId] = useState(NONE_PROXY_POOL_VALUE);
  const [rotateStrategy, setRotateStrategy] = useState("none");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [gatewayHost, setGatewayHost] = useState("");
  const [gatewayPort, setGatewayPort] = useState("");
  const [gatewayPath, setGatewayPath] = useState("");
  // CreditDaddy 网关连通性（#49 兑现）：免费线卡片对网关端口做服务端 TCP 探测，
  // 不通时就地给出「装 CreditDaddy」的引导——这是不合并两个应用前提下，
  // 对「不知道要装第二个」这一诉求的兑现。
  const [gatewayProbe, setGatewayProbe] = useState({ state: "idle" });

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/proxy-pools?isActive=true", { cache: "no-store" }).then((r) => r.ok ? r.json() : { proxyPools: [] }),
      fetch("/api/settings", { cache: "no-store" }).then((r) => r.ok ? r.json() : {}),
    ]).then(([poolData, settingsData]) => {
      if (cancelled) return;
      setProxyPools(poolData.proxyPools || []);
      const override = (settingsData.providerStrategies || {})[providerId] || {};
      setProxyPoolId(override.proxyPoolId || NONE_PROXY_POOL_VALUE);
      setRotateStrategy(override.rotateStrategy || "none");
      setGatewayHost(CREDITDADDY_LINES[providerId] ? settingsData.zcodeGatewayHost || "" : "");
      setGatewayPort(CREDITDADDY_LINES[providerId] ? settingsData.zcodeGatewayPort || "" : "");
      // 路径预填为“生效值”：留空时后端走的是这条线的内置默认（auth.js 的兜底），
      // 卡片显示占位符会让用户以为没配置。预填出实际会用的路径。
      setGatewayPath(
        CREDITDADDY_LINES[providerId]
          ? settingsData[CREDITDADDY_LINES[providerId].pathKey] || CREDITDADDY_LINES[providerId].defaultPath
          : ""
      );
      // 设置加载后立即探测一次网关连通性。值直接取 settings（绕开 state 的
      // 异步时序）；结果以服务端 TCP 探测为准，浏览器侧跨源探测不可靠。
      if (CREDITDADDY_LINES[providerId]) {
        const host = encodeURIComponent(settingsData.zcodeGatewayHost?.trim() || "127.0.0.1");
        const port = encodeURIComponent(settingsData.zcodeGatewayPort?.trim() || "47860");
        setGatewayProbe({ state: "probing" });
        fetch(`/api/gateway-probe?host=${host}&port=${port}`, { cache: "no-store" })
          .then((r) => r.ok ? r.json() : { reachable: false })
          .then((d) => { if (!cancelled) setGatewayProbe({ state: d.reachable ? "online" : "offline" }); })
          .catch(() => { if (!cancelled) setGatewayProbe({ state: "offline" }); });
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [providerId]);

  const save = useCallback(async (poolId, strategy) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const current = data.providerStrategies || {};
      const override = { ...(current[providerId] || {}) };
      if (poolId === NONE_PROXY_POOL_VALUE) delete override.proxyPoolId;
      else override.proxyPoolId = poolId;
      if (strategy === "none") delete override.rotateStrategy;
      else override.rotateStrategy = strategy;
      // 单 provider 原子写入：整块回写会覆盖别的 provider 的策略（见 api/settings）。
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategyPatch: { [providerId]: override } }),
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      console.log("Save proxy config error:", e);
    } finally {
      setSaving(false);
    }
  }, [providerId]);

  const handlePoolChange = (newPoolId) => {
    setProxyPoolId(newPoolId);
    save(newPoolId, rotateStrategy);
  };

  const handleStrategyChange = (newStrategy) => {
    setRotateStrategy(newStrategy);
    save(proxyPoolId, newStrategy);
  };

  // CreditDaddy 网关线:主机/端口共享（同一 daemon,本机留空 = 127.0.0.1;局域网填 IP;端口留空 = 47860）,路径按线分开

  // 手动重探：按当前输入框的值探测（即即将保存的值）；保存成功后也会自动触发。
  // 服务端 TCP 探测（/api/gateway-probe）——浏览器侧跨源连通性判断不可靠。
  const probeGateway = useCallback(async () => {
    if (!CREDITDADDY_LINES[providerId]) return;
    setGatewayProbe({ state: "probing" });
    try {
      const host = encodeURIComponent(gatewayHost.trim() || "127.0.0.1");
      const port = encodeURIComponent(gatewayPort.trim() || "47860");
      const res = await fetch(`/api/gateway-probe?host=${host}&port=${port}`, { cache: "no-store" });
      const data = res.ok ? await res.json() : { reachable: false };
      setGatewayProbe({ state: data.reachable ? "online" : "offline" });
    } catch {
      setGatewayProbe({ state: "offline" });
    }
  }, [providerId, gatewayHost, gatewayPort]);

  const saveGatewayHost = useCallback(async (host, port, reqPath) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const patch = {
        zcodeGatewayHost: String(host || "").trim(),
        zcodeGatewayPort: String(port || "").trim(),
        [CREDITDADDY_LINES[providerId]?.pathKey || "zcodeGatewayPath"]: String(reqPath || "").trim(),
      };
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
      // 保存成功后按新配置重探网关连通性
      probeGateway();
    } catch (e) {
      console.log("Save gateway host error:", e);
    } finally {
      setSaving(false);
    }
  }, [providerId, probeGateway]);

  const canRotate = proxyPools.length >= 2;
  const isRotation = rotateStrategy !== "none";

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-green-500/10 text-green-500">
          <span className="material-symbols-outlined text-[20px]">lock_open</span>
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium">No authentication required</p>
          <p className="text-xs text-text-muted">This provider is ready to use. Optionally route requests through a proxy pool to bypass IP-based limits.</p>
        </div>
        {savedFlash && <Badge variant="success" size="sm">Saved</Badge>}
      </div>

      <Select
        label="Proxy Pool"
        value={proxyPoolId}
        onChange={(e) => handlePoolChange(e.target.value)}
        disabled={saving || isRotation}
        options={[
          { value: NONE_PROXY_POOL_VALUE, label: "None (direct)" },
          ...proxyPools.map((pool) => ({ value: pool.id, label: pool.name })),
        ]}
        hint={isRotation ? "Pool selector is ignored when rotation is active — all active pools are used." : undefined}
      />

      <div className="flex flex-col gap-2 mt-4">
        <label className="text-sm font-medium text-text-main">Rotation Strategy</label>
        <select
          value={rotateStrategy}
          onChange={(e) => handleStrategyChange(e.target.value)}
          disabled={saving}
          className="py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all disabled:opacity-50"
        >
          {STRATEGIES.map((s) => (
            <option key={s.value} value={s.value} disabled={s.value !== "none" && !canRotate}>
              {s.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-text-muted">
          {!canRotate
            ? `Need at least 2 active proxy pools for rotation.`
            : isRotation
              ? rotateStrategy === "round-robin"
                ? `Rotating through all ${proxyPools.length} active pools in order. State is in-memory (resets on restart).`
                : `Picking a random pool from ${proxyPools.length} active pools each request.`
              : `Uses the selected pool above. Set to Round-robin or Random to rotate across all active pools.`}
        </p>
      </div>
      {CREDITDADDY_LINES[providerId] && (
        <div className="flex flex-col gap-2 mt-4 pt-4 border-t border-black/5 dark:border-white/5">
          <div className="flex items-center justify-between gap-2">
            <label className="text-sm font-medium text-text-main">{translate("CreditDaddy gateway host")}</label>
            <div className="flex items-center gap-1.5">
              {gatewayProbe.state === "probing" && (
                <span className="flex items-center gap-1 text-[11px] text-text-muted">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-gray-400 animate-pulse" />
                  {translate("Probing gateway...")}
                </span>
              )}
              {gatewayProbe.state === "online" && (
                <span className="flex items-center gap-1 text-[11px] text-green-600 dark:text-green-400">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500" />
                  {translate("Gateway reachable")}
                </span>
              )}
              {gatewayProbe.state === "offline" && (
                <span className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" />
                  {translate("Gateway unreachable")}
                </span>
              )}
              <button
                type="button"
                onClick={probeGateway}
                disabled={saving}
                className="text-[11px] text-text-muted hover:text-primary transition-colors"
              >
                {translate("Re-probe")}
              </button>
            </div>
          </div>
          {gatewayProbe.state === "offline" && (
            <div className="rounded-md bg-amber-500/10 border border-amber-500/20 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-300">
              {translate("Gateway unreachable — install/launch CreditDaddy and enable the gateway, then re-probe here.")}{" "}
              <a
                href="https://github.com/techysy/CreditDaddy/releases/latest"
                target="_blank"
                rel="noreferrer"
                className="underline font-medium"
              >
                {translate("Download CreditDaddy")}
              </a>
            </div>
          )}
          <div className="flex gap-2">
            <input
              value={gatewayHost}
              onChange={(e) => setGatewayHost(e.target.value)}
              placeholder={translate("Empty = this machine (127.0.0.1); LAN = CreditDaddy host IP")}
              className="flex-1 py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all"
            />
            <input
              value={gatewayPort}
              onChange={(e) => setGatewayPort(e.target.value)}
              placeholder="47860"
              className="w-24 py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all"
            />
            <input
              value={gatewayPath}
              onChange={(e) => setGatewayPath(e.target.value)}
              placeholder={CREDITDADDY_LINES[providerId].defaultPath}
              className="w-56 py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all"
            />
            <button
              onClick={() => saveGatewayHost(gatewayHost, gatewayPort, gatewayPath)}
              disabled={saving}
              className="px-3 py-2 text-sm rounded-md bg-primary text-white disabled:opacity-50"
            >
              {translate("Save")}
            </button>
          </div>
          <p className="text-xs text-text-muted">
            {providerId === "trae-free"
              ? translate('Local: enable the gateway switch under "Trae → Interface settings" in CreditDaddy desktop and add a Trae (SOLO) account (default 127.0.0.1:47860).')
              : providerId === "minimax-free"
              ? translate('Local: enable the gateway switch under "MiniMax → Interface settings" in CreditDaddy desktop and add a MiniMax account (default 127.0.0.1:47860).')
              : translate('Local: enable the gateway switch under "ZCode → Interface settings" in CreditDaddy desktop (default 127.0.0.1:47860).')}{" "}
            {translate('LAN (NAS, etc.): put the CreditDaddy machine IP above, then in the same CreditDaddy panel turn on "Allow LAN access" and add this 10Router machine\'s IP to the allowlist, then restart CreditDaddy.')}{" "}
            {translate("The gateway is protected by an IP allowlist and checks no key, so there is nothing to enter here.")}{" "}
            {translate("Getting a 404? The path must keep its brand segment (e.g. /gateway/zcode/v1/messages) — CreditDaddy serves only the branded endpoints, and a build older than the rename still serves the old /gateway/v1/messages, so upgrade CreditDaddy rather than editing this field.")}
          </p>
        </div>
      )}
    </Card>
  );
}

NoAuthProxyCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
