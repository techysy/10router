import { NextResponse } from "next/server";
import net from "node:net";
import dns from "node:dns";

// 免费线（zcode-free / minimax-free / trae-free）卡片的网关连通性探测（#49）。
// CreditDaddy 的本地网关默认 127.0.0.1:47860，局域网部署时是宿主机 IP——
// 浏览器侧对跨源端口做连通性判断不可靠（CORS/混合内容），由 10Router 服务端
// 发起 TCP connect 探测，卡片只读结果。
//
// SSRF 守卫：本端点的唯一用途是探测 CreditDaddy 网关（本机或局域网），只放行
// 私有网段与 localhost——公网地址直接 400，不让它变成任意端口扫描器。

const PROBE_TIMEOUT_MS = 2500;
const DEFAULT_PORT = 47860;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127 || a === 10 || a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / Tailscale (100.64.0.0/10)
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
  }
  return false;
}

function resolveHost(host) {
  return new Promise((resolve) => {
    if (net.isIP(host)) return resolve(host);
    // 仅 localhost 豁免解析；其它主机名不放行（探测端点不需要域名）。
    // 强制 IPv4：Windows 上 localhost 常先解析为 ::1，而 CreditDaddy 网关
    // 默认只听 IPv4 回环——探测 ::1 会把「在线」误报成「未连通」。
    if (host === "localhost") {
      dns.lookup("localhost", { family: 4 }, (err, address) => resolve(err ? "127.0.0.1" : address));
      return;
    }
    resolve(null);
  });
}

function probeTcp(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (reachable) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const hostInput = (searchParams.get("host") || "127.0.0.1").trim().toLowerCase();

    // 显式给出但非法的端口 → 400；缺省/留空 → CreditDaddy 默认端口。
    // 不能用 `|| DEFAULT_PORT` 兜底：那会把 port=0 这类非法值静默吞成有效端口。
    const portParam = searchParams.get("port");
    let port = DEFAULT_PORT;
    if (portParam !== null && portParam !== "") {
      port = parseInt(portParam, 10);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        return NextResponse.json({ error: "invalid port" }, { status: 400 });
      }
    }

    const ip = await resolveHost(hostInput);
    if (!ip || !isPrivateIp(ip)) {
      return NextResponse.json(
        { error: "only loopback/private-network hosts are probeable" },
        { status: 400 },
      );
    }

    const reachable = await probeTcp(ip, port);
    return NextResponse.json({ reachable, host: hostInput, port });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "probe failed" }, { status: 500 });
  }
}
