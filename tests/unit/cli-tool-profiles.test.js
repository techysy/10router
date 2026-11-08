/**
 * CLI-tools model-combo profiles (issue #17) — the pure core in
 * src/lib/cliToolProfiles.js: input sanitization (the writer merges into the
 * user's real ~/.claude/settings.json, so a tampered env must not smuggle
 * arbitrary keys in), upsert/remove semantics, and the "which profile do the
 * current settings equal" matcher the card uses to preselect.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_PROFILES,
  sanitizeProfileInput,
  upsertProfile,
  removeProfile,
  matchProfileByEnv,
} from "../../src/lib/cliToolProfiles.js";

const VALID_BODY = {
  name: "GLM coding",
  env: {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:20128",
    ANTHROPIC_AUTH_TOKEN: "sk_test",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "zcode/glm-5.3",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "zcode/glm-5.3-flash",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "zcode/glm-5.3-air",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "zcode/glm-5.3-flash",
    EVIL_KEY: "should be dropped",
  },
  exaMcpEnabled: true,
  maxContextTokens: "198000",
};

describe("sanitizeProfileInput", () => {
  it("normalizes a valid submission and drops unknown env keys", () => {
    const { ok, profile, error } = sanitizeProfileInput(VALID_BODY);
    expect(error).toBeUndefined();
    expect(ok).toBe(true);
    expect(profile.name).toBe("GLM coding");
    expect(profile.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:20128/v1");
    expect(profile.env.ANTHROPIC_AUTH_TOKEN).toBe("sk_test");
    expect(profile.env.EVIL_KEY).toBeUndefined();
    expect(Object.keys(profile.env).every((k) => !k.startsWith("EVIL"))).toBe(true);
    expect(profile.exaMcpEnabled).toBe(true);
    expect(profile.maxContextTokens).toBe("198000");
  });

  it("appends the /v1 suffix so a switch never writes a /v1-less base URL", () => {
    const { profile } = sanitizeProfileInput({
      ...VALID_BODY,
      env: { ...VALID_BODY.env, ANTHROPIC_BASE_URL: "http://host:20128/" },
    });
    expect(profile.env.ANTHROPIC_BASE_URL).toBe("http://host:20128/v1");
  });

  // #102: Fable joined the Claude card after this whitelist was written; the
  // original omission silently dropped the slot from every saved profile, so
  // switching schemes away and back cleared the row. This pins the slot in.
  it("keeps the Claude Fable slot through sanitization (issue #102)", () => {
    const { profile } = sanitizeProfileInput(VALID_BODY);
    expect(profile.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("zcode/glm-5.3-air");

    const withoutFable = sanitizeProfileInput({
      ...VALID_BODY,
      env: { ...VALID_BODY.env, ANTHROPIC_DEFAULT_FABLE_MODEL: undefined },
    });
    expect(withoutFable.profile.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBeUndefined();
  });

  it("rejects an empty or overlong name", () => {
    expect(sanitizeProfileInput({ ...VALID_BODY, name: "   " }).error).toContain("required");
    expect(sanitizeProfileInput({ ...VALID_BODY, name: "x".repeat(41) }).error).toContain("40");
  });

  it("rejects a profile without a base URL and junk env", () => {
    expect(sanitizeProfileInput({ ...VALID_BODY, env: {} }).error).toContain("base URL");
    expect(sanitizeProfileInput({ ...VALID_BODY, env: "http://x" }).error).toContain("env");
    expect(sanitizeProfileInput({ ...VALID_BODY, env: null }).error).toContain("env");
  });

  it("rejects a non-numeric context window, accepts empty", () => {
    expect(sanitizeProfileInput({ ...VALID_BODY, maxContextTokens: "big" }).error).toContain("number");
    const { profile } = sanitizeProfileInput({ ...VALID_BODY, maxContextTokens: "" });
    expect(profile.maxContextTokens).toBe("");
  });
});

describe("upsertProfile / removeProfile", () => {
  it("creates with an injected id and timestamps, and enforces the cap", () => {
    const full = Array.from({ length: MAX_PROFILES }, (_, i) => ({
      id: `p${i}`, name: `n${i}`, env: {}, exaMcpEnabled: false, maxContextTokens: "",
    }));
    const { ok, profile } = sanitizeProfileInput(VALID_BODY);
    const overflow = upsertProfile(full, profile, { newId: () => "new", now: () => 7 });
    expect(overflow.error).toContain(String(MAX_PROFILES));

    const result = upsertProfile(full.slice(0, MAX_PROFILES - 1), profile, { newId: () => "new", now: () => 7 });
    expect(result.error).toBeUndefined();
    expect(result.profiles).toHaveLength(MAX_PROFILES);
    expect(result.profile).toMatchObject({ id: "new", createdAt: 7, updatedAt: 7, name: "GLM coding" });
  });

  it("updates in place by id, keeping createdAt and position", () => {
    const existing = [{ id: "p1", name: "old", env: { ANTHROPIC_BASE_URL: "http://a/v1" }, createdAt: 1, updatedAt: 1 }];
    const { ok, profile } = sanitizeProfileInput(VALID_BODY);
    const result = upsertProfile(existing, profile, { id: "p1", now: () => 9 });
    expect(result.error).toBeUndefined();
    expect(result.profiles).toHaveLength(1);
    expect(result.profile).toMatchObject({ id: "p1", name: "GLM coding", createdAt: 1, updatedAt: 9 });
  });

  it("fails an update against an unknown id without touching the list", () => {
    const existing = [{ id: "p1", name: "old", env: {} }];
    const { ok, profile } = sanitizeProfileInput(VALID_BODY);
    const result = upsertProfile(existing, profile, { id: "nope" });
    expect(result.error).toContain("not found");
    expect(result.profiles).toBeUndefined();
  });

  it("removes by id and reports no-op for unknown ids", () => {
    const list = [{ id: "p1", name: "a", env: {} }, { id: "p2", name: "b", env: {} }];
    expect(removeProfile(list, "p1")).toEqual({ profiles: [list[1]], removed: true });
    expect(removeProfile(list, "zz")).toEqual({ profiles: list, removed: false });
  });
});

describe("matchProfileByEnv", () => {
  const env = {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:20128/v1",
    ANTHROPIC_AUTH_TOKEN: "sk_1",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "zcode/glm-5.3",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "zcode/glm-5.3-air",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "zcode/glm-5.3-flash",
  };

  it("matches on endpoint, key and the four model slots (missing == empty)", () => {
    expect(matchProfileByEnv({ env }, env)).toBe(true);
    expect(matchProfileByEnv({ env: { ...env, ANTHROPIC_DEFAULT_SONNET_MODEL: undefined } }, env)).toBe(true);
  });

  it("does not match when any rewritten field differs", () => {
    expect(matchProfileByEnv({ env: { ...env, ANTHROPIC_AUTH_TOKEN: "sk_2" } }, env)).toBe(false);
    expect(matchProfileByEnv({ env: { ...env, ANTHROPIC_BASE_URL: "http://other/v1" } }, env)).toBe(false);
    expect(matchProfileByEnv({ env: { ...env, ANTHROPIC_DEFAULT_HAIKU_MODEL: "x" } }, env)).toBe(false);
    // A pre-#102 profile (no FABLE key) must not match a settings file that has one.
    expect(matchProfileByEnv({ env: { ...env, ANTHROPIC_DEFAULT_FABLE_MODEL: undefined } }, env)).toBe(false);
  });

  it("tolerates junk input", () => {
    expect(matchProfileByEnv(null, env)).toBe(false);
    expect(matchProfileByEnv({}, env)).toBe(false);
  });
});
