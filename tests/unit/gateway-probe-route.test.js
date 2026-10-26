// /api/gateway-probe —— #49 兑现：免费线卡片探测 CreditDaddy 网关连通性。
// 服务端 TCP 探测（浏览器跨源探测不可靠），私有网段守卫防它变成任意端口扫描器。
// 真实 socket 集成测试：探测目标用 net.Server 监听在 127.0.0.1:0 现起现测，不 mock。
import { describe, it, expect, afterAll } from "vitest";
import net from "node:net";
import { GET } from "@/app/api/gateway-probe/route.js";

let listener;

function listenOn(port) {
  return new Promise((resolve) => {
    listener = net.createServer();
    listener.listen(port, "127.0.0.1", () => resolve(listener.address().port));
  });
}

function get(host, port) {
  const url = new URL(`http://localhost/api/gateway-probe?host=${encodeURIComponent(host)}&port=${port}`);
  return GET(new Request(url));
}

afterAll(() => {
  if (listener) listener.close();
});

describe("gateway-probe route", () => {
  it("reports reachable=true for a live local port", async () => {
    const port = await listenOn(0);
    const res = await get("127.0.0.1", port);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reachable).toBe(true);
    expect(body.host).toBe("127.0.0.1");
    expect(body.port).toBe(port);
  });

  it("reports reachable=false for a closed local port", async () => {
    // 127.0.0.1:9 (discard) 通常无人监听；即便个别环境占用，退而取一个刚关闭的端口
    let closedPort = 9;
    const srv = net.createServer();
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    closedPort = srv.address().port;
    await new Promise((r) => srv.close(r)); // 拿到端口号后立即释放
    const res = await get("127.0.0.1", closedPort);
    const body = await res.json();
    expect(body.reachable).toBe(false);
  });

  it("resolves localhost to loopback", async () => {
    const port = await listenOn(0);
    const res = await get("localhost", port);
    expect((await res.json()).reachable).toBe(true);
  });

  it("rejects public hosts with 400 (SSRF guard)", async () => {
    const res = await get("8.8.8.8", 53);
    expect(res.status).toBe(400);
  });

  it("rejects non-private hostnames with 400", async () => {
    const res = await get("example.com", 47860);
    expect(res.status).toBe(400);
  });

  it("rejects invalid ports with 400", async () => {
    expect((await get("127.0.0.1", 99999)).status).toBe(400);
    expect((await get("127.0.0.1", 0)).status).toBe(400);
    expect((await get("127.0.0.1", -1)).status).toBe(400);
  });

  it("treats an empty host as 127.0.0.1 (the CreditDaddy default)", async () => {
    const port = await listenOn(0);
    const res = await get("", port);
    expect((await res.json()).reachable).toBe(true);
  });

  it("permits 100.64.0.0/10 CGNAT / Tailscale IPs and rejects outside boundaries", async () => {
    // 100.64.0.1 is in 100.64.0.0/10 -> permitted by SSRF guard (fails TCP probe as unreachable, but returns 200 JSON)
    const validCgnat = await get("100.64.0.1", 9);
    expect(validCgnat.status).toBe(200);
    const validBody = await validCgnat.json();
    expect(validBody.reachable).toBe(false);

    // 100.63.255.255 and 100.128.0.1 are outside -> rejected with 400
    expect((await get("100.63.255.255", 9)).status).toBe(400);
    expect((await get("100.128.0.1", 9)).status).toBe(400);
  }, 10000);
});
