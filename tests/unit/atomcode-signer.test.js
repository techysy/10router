/**
 * atomcode-signing-v1 — fixed vector from the MIT Atom2Api fixture
 * (core_test.go TestAtomGitSigningMatchesIndependentFixture) plus timestamp /
 * nonce injection coverage.
 */
import { describe, expect, it } from "vitest";

import { signAtomcodeRequest } from "../../open-sse/executors/atomcode.js";

const NONCE = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
const FIXTURE = {
  method: "POST",
  path: "/v1/chat/completions",
  body: '{"model":"deepseek-v4-flash"}',
  accessToken: "token-fixture",
  userId: "user-fixture",
  clientVersion: "5.0.2",
  timestamp: 1767225600,
  nonce: NONCE,
};

describe("atomcode sign_v1", () => {
  it("matches the independent Atom2Api fixture", () => {
    const headers = signAtomcodeRequest(FIXTURE);

    expect(headers["X-AtomCode-Sig"]).toBe(
      "v1:c5bafa716c0fdc31a6e2738412d0b21a9d9e9d1ca09cc44eb17949a1b4fa4bdd"
    );
    expect(headers["X-AtomCode-Ts"]).toBe("1767225600");
    expect(headers["X-AtomCode-Nonce"]).toBe("000102030405060708090a0b0c0d0e0f");
    expect(headers["X-AtomCode-Alg"]).toBe("1");
    expect(headers["X-AtomCode-Ver"]).toBe("5.0.2");
    expect(Object.keys(headers)).toHaveLength(5);
  });

  it("injects the caller's timestamp and nonce verbatim", () => {
    const nonce = Buffer.alloc(16, 0xab);
    const headers = signAtomcodeRequest({
      ...FIXTURE,
      timestamp: 1893456000,
      nonce,
    });
    expect(headers["X-AtomCode-Ts"]).toBe("1893456000");
    expect(headers["X-AtomCode-Nonce"]).toBe("ab".repeat(16));
    expect(headers["X-AtomCode-Sig"]).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(headers["X-AtomCode-Sig"]).not.toBe(
      "v1:c5bafa716c0fdc31a6e2738412d0b21a9d9e9d1ca09cc44eb17949a1b4fa4bdd"
    );
  });

  it("is deterministic for identical inputs and changes with the nonce", () => {
    const a = signAtomcodeRequest(FIXTURE);
    const b = signAtomcodeRequest(FIXTURE);
    expect(a).toEqual(b);

    const otherNonce = Buffer.alloc(16, 1);
    const c = signAtomcodeRequest({ ...FIXTURE, nonce: otherNonce });
    expect(c["X-AtomCode-Sig"]).not.toBe(a["X-AtomCode-Sig"]);
  });

  it("signs string and Buffer bodies identically", () => {
    const fromString = signAtomcodeRequest(FIXTURE);
    const fromBuffer = signAtomcodeRequest({ ...FIXTURE, body: Buffer.from(FIXTURE.body) });
    expect(fromBuffer["X-AtomCode-Sig"]).toBe(fromString["X-AtomCode-Sig"]);
  });

  it("rejects missing token, missing user id and wrong nonce length", () => {
    expect(() => signAtomcodeRequest({ ...FIXTURE, accessToken: "" })).toThrow(/OAuth token/);
    expect(() => signAtomcodeRequest({ ...FIXTURE, userId: "" })).toThrow(/user id/);
    expect(() => signAtomcodeRequest({ ...FIXTURE, nonce: Buffer.alloc(8) })).toThrow(/nonce/);
    expect(() => signAtomcodeRequest({ ...FIXTURE, masterKeyHex: "00" })).toThrow(/master key/);
  });
});
