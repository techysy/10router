/**
 * SSRF guard on POST /api/cli-tools/cowork-mcp-tools (#3783).
 *
 * Remote callers must not be able to force server-side fetches to
 * internal URLs; local-host use (self-hosted MCP servers) keeps working.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
  },
}));

const { POST } = await import(
  "../../src/app/api/cli-tools/cowork-mcp-tools/route.js"
);

function remoteRequest(url) {
  return new Request("http://gateway.example.com/api/cli-tools/cowork-mcp-tools", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

describe("cowork-mcp-tools SSRF guard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("rejects loopback URLs from remote callers without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await POST(remoteRequest("http://127.0.0.1:18731/internal-admin"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "URL not allowed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects private-network URLs from remote callers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const url of ["http://10.0.0.5/mcp", "http://192.168.1.1/mcp", "http://localhost:3000/mcp"]) {
      const res = await POST(remoteRequest(url));
      expect(res.status).toBe(400);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lets local callers probe self-hosted MCP servers (dev loopback)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200 })
    );
    const req = new Request("http://127.0.0.1:20128/api/cli-tools/cowork-mcp-tools", {
      method: "POST",
      headers: { "content-type": "application/json", host: "127.0.0.1:20128" },
      body: JSON.stringify({ url: "http://127.0.0.1:18731/mcp" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalled();
  });
});
