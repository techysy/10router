import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isLocalRequest, isAllowedHost, extractHostname } from "../../src/dashboardGuard.js";

function makeRequest({ host, origin, peerIp = "127.0.0.1", viaProxy = false } = {}) {
  const headers = new Headers();
  if (host) headers.set("host", host);
  if (origin) headers.set("origin", origin);
  if (viaProxy) headers.set("x-10r-via-proxy", "1");
  if (peerIp) {
    headers.set("x-10r-real-ip", peerIp);
    headers.set("x-10r-peer-token", process.env.TENROUTER_PEER_TOKEN || "test-token");
  }
  return {
    headers,
  };
}

describe("Issue #43 Item 1: Host header validation & DNS rebinding defense", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TENROUTER_PEER_TOKEN = "test-token";
    delete process.env.TRUSTED_HOSTS;
    delete process.env.BASE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("extractHostname", () => {
    it("handles IPv4 with port, bare IPv4, and domain with port", () => {
      expect(extractHostname("127.0.0.1:20128")).toBe("127.0.0.1");
      expect(extractHostname("127.0.0.1")).toBe("127.0.0.1");
      expect(extractHostname("localhost:20128")).toBe("localhost");
      expect(extractHostname("attacker.com:20128")).toBe("attacker.com");
      expect(extractHostname("attacker.com")).toBe("attacker.com");
    });

    it("handles IPv6 bracketed hosts and mapped IPv4", () => {
      expect(extractHostname("[::1]:20128")).toBe("::1");
      expect(extractHostname("[::1]")).toBe("::1");
      expect(extractHostname("::ffff:127.0.0.1")).toBe("127.0.0.1");
    });
  });

  describe("isAllowedHost", () => {
    it("allows loopback hosts by default", () => {
      expect(isAllowedHost("localhost")).toBe(true);
      expect(isAllowedHost("127.0.0.1:20128")).toBe(true);
      expect(isAllowedHost("[::1]:20128")).toBe(true);
    });

    it("rejects unauthorized external hosts by default", () => {
      expect(isAllowedHost("attacker.com")).toBe(false);
      expect(isAllowedHost("rebind.malicious.net:20128")).toBe(false);
      expect(isAllowedHost("192.168.1.100:20128")).toBe(false);
    });

    it("respects TRUSTED_HOSTS environment allowlist", () => {
      process.env.TRUSTED_HOSTS = "my-nas.lan, 10router.internal:20128";
      expect(isAllowedHost("my-nas.lan")).toBe(true);
      expect(isAllowedHost("my-nas.lan:20128")).toBe(true);
      expect(isAllowedHost("10router.internal:20128")).toBe(true);
      expect(isAllowedHost("other-nas.lan")).toBe(false);
    });

    it("respects BASE_URL host", () => {
      process.env.BASE_URL = "https://gw.company.org:8443";
      expect(isAllowedHost("gw.company.org:8443")).toBe(true);
      expect(isAllowedHost("gw.company.org")).toBe(true);
      expect(isAllowedHost("evil.com")).toBe(false);
    });
  });

  describe("isLocalRequest DNS rebinding defense", () => {
    it("accepts legitimate local requests with loopback Host", () => {
      const req = makeRequest({ host: "localhost:20128", peerIp: "127.0.0.1" });
      expect(isLocalRequest(req)).toBe(true);

      const reqIp = makeRequest({ host: "127.0.0.1:20128", peerIp: "127.0.0.1" });
      expect(isLocalRequest(reqIp)).toBe(true);

      const reqIpv6 = makeRequest({ host: "[::1]:20128", peerIp: "::1" });
      expect(isLocalRequest(reqIpv6)).toBe(true);
    });

    it("REFUSES DNS rebinding attacks: peer is 127.0.0.1 but Host is attacker domain", () => {
      // Concrete attack scenario:
      // Attacker binds rebind.attacker.com to 127.0.0.1.
      // Victim browser sends GET request to http://rebind.attacker.com:20128/api/settings
      // The socket connects to 127.0.0.1, but Host header contains rebind.attacker.com.
      const req = makeRequest({
        host: "rebind.attacker.com:20128",
        peerIp: "127.0.0.1",
      });
      expect(isLocalRequest(req)).toBe(false);
    });

    it("REFUSES DNS rebinding even if no origin header is provided", () => {
      const req = makeRequest({
        host: "attacker.com",
        peerIp: "127.0.0.1",
        origin: null,
      });
      expect(isLocalRequest(req)).toBe(false);
    });

    it("allows configured TRUSTED_HOSTS through isLocalRequest when from loopback proxy", () => {
      process.env.TRUSTED_HOSTS = "custom-proxy.local";
      const req = makeRequest({
        host: "custom-proxy.local:20128",
        peerIp: "127.0.0.1",
      });
      expect(isLocalRequest(req)).toBe(true);
    });

    it("still refuses proxy-forwarded requests via x-10r-via-proxy", () => {
      const req = makeRequest({
        host: "localhost:20128",
        peerIp: "127.0.0.1",
        viaProxy: true,
      });
      expect(isLocalRequest(req)).toBe(false);
    });
  });
});
