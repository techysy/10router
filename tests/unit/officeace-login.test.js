/**
 * OfficeAce login protocol (src/lib/oauth/providers/officeace.js).
 *
 * Pins the nine-step chain against the Rust provider's behaviour:
 *   ① state ② PKCE + P-256 DPoP ③ authorize URL ④ 202/404/200 polling
 *   ⑤ form + DPoP token exchange ⑥ validate ⑥a projects ⑥b subscription ⑦ payload.
 */
import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  OFFICEACE_LOGIN_CONFIG,
  OfficeAceLoginError,
  finishLogin,
  pollAuthorization,
  startLogin,
} from "../../src/lib/oauth/providers/officeace.js";

const { cloudBase, tokenUrl } = OFFICEACE_LOGIN_CONFIG;
const STATE_URL = `${cloudBase}/v1/claw/auth/state`;
const CODE_URL = `${cloudBase}/v1/claw/auth/code`;
const PERMISSION_URL = `${cloudBase}/v1/claw/client-permission-validate`;
const SUBSCRIPTION_URL = `${cloudBase}/v1/claw/client-subscription`;
const PROJECTS_URL = `${OFFICEACE_LOGIN_CONFIG.iamBase}/v3/projects`;
const REDIRECT_URI = "https://agentarts.cn-southwest-2.myhuaweicloud.com/v1/claw/auth/callback";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noContent = (status) => new Response(null, { status });

/** Route by exact URL prefix, collect every call. */
function fetchRouter(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, init });
    const entry = routes.find(([prefix]) => href.startsWith(prefix));
    if (!entry) throw new Error(`unexpected fetch: ${href}`);
    return typeof entry[1] === "function" ? entry[1](init, href) : entry[1];
  };
  fn.calls = calls;
  return fn;
}

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;

const PROFILE = {
  account_id: "acc-profile",
  account_name: "hid_synthetic-1",
  principal_id: "prin-profile",
};

function tokenPayload(extra = {}) {
  return {
    credentials: {
      access_key_id: "HSTA-AK",
      secret_access_key: "SK",
      security_token: "STS",
      expiration: "2030-01-01T00:00:00Z",
    },
    // The display name lives in refresh_token's nested user_profile.
    refresh_token: jwt({ user_profile: b64(PROFILE) }),
    ...extra,
  };
}

const GATEWAY_MODEL_INFO = {
  model_api_url_base: "modelgw-0004.officeace.cn-southwest-2.huaweicloudagentarts.com",
  model_auth_info: { model_app_key: "APPKEY", model_app_secret: "APPSECRET" },
};

function verifyDpop(proof, privateKeyPem) {
  const parts = String(proof).split(".");
  expect(parts).toHaveLength(3);
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  expect(header).toMatchObject({ alg: "ES256", typ: "dpop+jwt" });
  expect(header.jwk).toMatchObject({ kty: "EC", crv: "P-256" });
  expect(header.jwk.d).toBeUndefined();
  expect(claims.htm).toBe("POST");
  expect(claims.htu).toBe(tokenUrl);
  expect(claims.jti).toMatch(/^[0-9a-f]{64}$/);
  const publicKey = crypto.createPublicKey(privateKeyPem);
  const verified = crypto.verify(
    "sha256",
    Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(parts[2], "base64url")
  );
  expect(verified).toBe(true);
  return { header, claims };
}

describe("officeace startLogin", () => {
  it("asks the cloud for a state (unauthenticated) and returns PKCE + a P-256 DPoP key", async () => {
    const fetchMock = fetchRouter([[STATE_URL, json({ state: "st-1" })]]);
    const started = await startLogin({ fetchImpl: fetchMock });

    expect(started.state).toBe("st-1");
    expect(started.pkce.verifier.length).toBeGreaterThanOrEqual(43);
    expect(started.pkce.challenge).toBe(
      crypto.createHash("sha256").update(started.pkce.verifier).digest("base64url")
    );

    const [stateCall] = fetchMock.calls;
    expect(stateCall.url).toBe(STATE_URL);
    expect(stateCall.init.method).toBe("POST");
    expect(stateCall.init.body).toBe("{}");
    expect(stateCall.init.headers.Authorization).toBeUndefined();

    const outer = new URL(started.authorizeUrl);
    expect(`${outer.origin}${outer.pathname}`).toBe(
      "https://auth.huaweicloud.com/authui/login.html"
    );
    const inner = new URL(outer.searchParams.get("service"));
    expect(inner.origin).toBe("https://auth.huaweicloud.com");
    expect(inner.pathname).toBe("/authui/v1/oauth2/authorize");
    expect(inner.searchParams.get("client_id")).toBe("pdp5_for_agentarts");
    expect(inner.searchParams.get("code_challenge")).toBe(started.pkce.challenge);
    expect(inner.searchParams.get("code_challenge_method")).toBe("SHA-256");
    expect(inner.searchParams.get("state")).toBe("st-1");
    expect(inner.searchParams.get("scope")).toBe("openid");
    expect(inner.searchParams.get("response_type")).toBe("code");
    // The redirect points at the cloud, never at loopback.
    expect(inner.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(started.authorizeUrl).not.toContain("127.0.0.1");

    const privateKey = crypto.createPrivateKey(started.dpopPrivateKeyPem);
    expect(privateKey.asymmetricKeyType).toBe("ec");
    expect(privateKey.asymmetricKeyDetails.namedCurve).toBe("prime256v1");
  });

  it("fails with stage=state when the cloud returns no state", async () => {
    const fetchMock = fetchRouter([[STATE_URL, json({}, 200)]]);
    await expect(startLogin({ fetchImpl: fetchMock })).rejects.toMatchObject({
      name: "OfficeAceLoginError",
      stage: "state",
    });
  });
});

describe("officeace pollAuthorization", () => {
  it("202 → pending (state is percent-encoded in the query)", async () => {
    const fetchMock = fetchRouter([[CODE_URL, noContent(202)]]);
    const result = await pollAuthorization("st 1/2", { fetchImpl: fetchMock });
    expect(result).toEqual({ status: "pending" });
    expect(fetchMock.calls[0].url).toBe(`${CODE_URL}?state=st%201%2F2`);
    expect(fetchMock.calls[0].init.method).toBe("GET");
  });

  it("404 → expired (terminal), and the cached login context is dropped", async () => {
    const started = await startLogin({
      fetchImpl: fetchRouter([[STATE_URL, json({ state: "st-dead" })]]),
    });
    const result = await pollAuthorization("st-dead", {
      fetchImpl: fetchRouter([[CODE_URL, json({ error: "not found" }, 404)]]),
    });
    expect(result.status).toBe("expired");
    expect(result.error).toContain("重新发起登录");
    expect(started.state).toBe("st-dead");
    // A dead state can no longer be exchanged from the cache.
    await expect(
      finishLogin({ state: "st-dead", code: "c" }, { fetchImpl: fetchRouter([]) })
    ).rejects.toMatchObject({ stage: "session" });
  });

  it("200 → done with the code (accepts `authorization_code` too)", async () => {
    const primary = await pollAuthorization("st-1", {
      fetchImpl: fetchRouter([[CODE_URL, json({ code: "auth-code" })]]),
    });
    expect(primary).toEqual({ status: "done", code: "auth-code" });

    const alias = await pollAuthorization("st-1", {
      fetchImpl: fetchRouter([[CODE_URL, json({ authorization_code: "auth-code-2" })]]),
    });
    expect(alias).toEqual({ status: "done", code: "auth-code-2" });
  });

  it("200 + error envelope → expired with the upstream message", async () => {
    const result = await pollAuthorization("st-1", {
      fetchImpl: fetchRouter([[CODE_URL, json({ error: "access_denied", error_msg: "用户取消" })]]),
    });
    expect(result.status).toBe("expired");
    expect(result.error).toContain("用户取消");
  });

  it("200 without a code, or any other status, is a classified error", async () => {
    await expect(
      pollAuthorization("st-1", { fetchImpl: fetchRouter([[CODE_URL, json({ ok: true })]]) })
    ).rejects.toMatchObject({ stage: "poll", message: expect.stringContaining("没给授权码") });

    await expect(
      pollAuthorization("st-1", { fetchImpl: fetchRouter([[CODE_URL, json({}, 500)]]) })
    ).rejects.toMatchObject({ name: "OfficeAceLoginError", stage: "poll", status: 500 });
  });
});

describe("officeace finishLogin (⑤ form + DPoP, ⑥/⑥a/⑥b, ⑦ payload)", () => {
  it("exchanges the code with the exact form + a verifiable DPoP proof, then resolves ⑥a", async () => {
    const started = await startLogin({
      fetchImpl: fetchRouter([[STATE_URL, json({ state: "st-happy" })]]),
    });

    const fetchMock = fetchRouter([
      [tokenUrl, json(tokenPayload())],
      [
        PROJECTS_URL,
        json({
          projects: [
            { name: "cn-north-4", id: "proj-other", enabled: true },
            { name: "cn-southwest-2", id: "proj-1", enabled: true },
          ],
        }),
      ],
      [
        PERMISSION_URL,
        json({
          account_id: "acc-validate",
          principal_id: "prin-validate",
          subscription: { model_info: GATEWAY_MODEL_INFO },
        }),
      ],
    ]);

    const tokens = await finishLogin(
      { state: "st-happy", code: "the-code" },
      { fetchImpl: fetchMock }
    );

    // ⑤ form shape + DPoP header.
    const tokenCall = fetchMock.calls.find((call) => call.url === tokenUrl);
    expect(tokenCall.init.method).toBe("POST");
    expect(tokenCall.init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(tokenCall.init.body);
    expect(Object.fromEntries(form)).toEqual({
      client_id: "pdp5_for_agentarts",
      code: "the-code",
      code_verifier: started.pkce.verifier,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    });
    verifyDpop(tokenCall.init.headers.DPoP, started.dpopPrivateKeyPem);

    // ⑥a signed with SDK-HMAC; no project id yet, so it must not be signed.
    const projectsCall = fetchMock.calls.find((call) => call.url === PROJECTS_URL);
    expect(projectsCall.init.headers.Authorization).toMatch(/^SDK-HMAC-SHA256 Access=HSTA-AK/);
    expect(projectsCall.init.headers["X-Security-Token"]).toBe("STS");
    expect(projectsCall.init.headers["X-Project-ID"]).toBeUndefined();

    // ⑥ validate carries the subscription-type header and is signed.
    const validateCall = fetchMock.calls.find((call) => call.url === PERMISSION_URL);
    expect(validateCall.init.headers["x-subscription-type"]).toBe("v2");
    expect(validateCall.init.headers.Authorization).toMatch(/^SDK-HMAC-SHA256/);

    // ⑦ payload: non-expiring Basic pair as accessToken, temp creds in psd.
    expect(tokens.accessToken).toBe("APPKEY:APPSECRET");
    expect(tokens.refreshToken).toContain(".");
    expect(tokens.expiresAt).toBe(Date.parse("2030-01-01T00:00:00Z"));
    expect(tokens.expiresIn).toBeGreaterThan(0);
    expect(tokens.uid).toBe("acc-validate");
    // Name comes from refresh_token.user_profile.account_name.
    expect(tokens.name).toBe("hid_synthetic-1");
    expect(tokens.email).toBeNull();
    expect(tokens.providerSpecificData).toMatchObject({
      authMethod: "oauth",
      region: "cn-southwest-2",
      baseUrl: "https://modelgw-0004.officeace.cn-southwest-2.huaweicloudagentarts.com/v2",
      modelAppKey: "APPKEY",
      modelAppSecret: "APPSECRET",
      accessKeyId: "HSTA-AK",
      secretAccessKey: "SK",
      securityToken: "STS",
      projectId: "proj-1",
      accountId: "acc-validate",
      principalId: "prin-validate",
      name: "hid_synthetic-1",
      dpopPrivateKeyPem: started.dpopPrivateKeyPem,
    });
    // No ⑥b: model_info was already present.
    expect(fetchMock.calls.some((call) => call.url === SUBSCRIPTION_URL)).toBe(false);
  });

  it("empty model_info → ⑥b client-subscription (body `{}`), and ⑥a failure is fail-open", async () => {
    const fetchMock = fetchRouter([
      [tokenUrl, json(tokenPayload())],
      [PROJECTS_URL, json({ error: "boom" }, 500)],
      [
        PERMISSION_URL,
        json({ account_id: "acc-new", subscription: { model_info: {} } }),
      ],
      [SUBSCRIPTION_URL, json({ model_info: GATEWAY_MODEL_INFO })],
    ]);

    const tokens = await finishLogin(
      { state: "st-new", code: "code-new", pkceVerifier: "verifier-new", dpopPrivateKeyPem: makePem() },
      { fetchImpl: fetchMock }
    );

    const subscribeCall = fetchMock.calls.find((call) => call.url === SUBSCRIPTION_URL);
    expect(subscribeCall.init.method).toBe("POST");
    expect(subscribeCall.init.body).toBe("{}");
    expect(subscribeCall.init.headers["x-subscription-type"]).toBe("v2");
    expect(subscribeCall.init.headers.Authorization).toMatch(/^SDK-HMAC-SHA256/);

    // ⑥a failed ⇒ project stays empty, but login still succeeds.
    expect(tokens.providerSpecificData.projectId).toBe("");
    expect(tokens.providerSpecificData.baseUrl).toMatch(/\/v2$/);
    expect(tokens.uid).toBe("acc-new");
  });

  it("picks up project_id from the token response when the cloud returns it", async () => {
    const fetchMock = fetchRouter([
      [tokenUrl, json(tokenPayload({ credentials: {
        access_key_id: "AK",
        secret_access_key: "SK2",
        security_token: "STS2",
        expiration: "2030-01-01T00:00:00Z",
        project_id: "proj-token",
      } }))],
      [PERMISSION_URL, json({ account_id: "acc-1", model_info: GATEWAY_MODEL_INFO })],
    ]);

    const tokens = await finishLogin(
      { state: "st-token-project", code: "c", pkceVerifier: "v", dpopPrivateKeyPem: makePem() },
      { fetchImpl: fetchMock }
    );
    expect(tokens.providerSpecificData.projectId).toBe("proj-token");
    expect(fetchMock.calls.some((call) => call.url === PROJECTS_URL)).toBe(false);
    // project id present ⇒ validate signs X-Project-ID.
    const validateCall = fetchMock.calls.find((call) => call.url === PERMISSION_URL);
    expect(validateCall.init.headers["X-Project-ID"]).toBe("proj-token");
  });

  it("state mismatch / missing session is a stage=session error", async () => {
    await expect(
      finishLogin({ state: "never-started", code: "c" }, { fetchImpl: fetchRouter([]) })
    ).rejects.toMatchObject({ name: "OfficeAceLoginError", stage: "session" });
  });

  it("explicit PKCE + DPoP context works regardless of the session cache", async () => {
    const fetchMock = fetchRouter([
      [tokenUrl, json(tokenPayload())],
      [PERMISSION_URL, json({ account_id: "acc-1", model_info: GATEWAY_MODEL_INFO })],
    ]);
    const pem = makePem();
    await finishLogin(
      { state: "unregistered", code: "c", pkceVerifier: "explicit-verifier", dpopPrivateKeyPem: pem },
      { fetchImpl: fetchMock }
    );
    const form = new URLSearchParams(
      fetchMock.calls.find((call) => call.url === tokenUrl).init.body
    );
    expect(form.get("code_verifier")).toBe("explicit-verifier");
    verifyDpop(fetchMock.calls.find((call) => call.url === tokenUrl).init.headers.DPoP, pem);
  });
});

describe("officeace error classification", () => {
  const context = () => ({
    state: "st-err",
    code: "c",
    pkceVerifier: "v",
    dpopPrivateKeyPem: makePem(),
  });

  it("token endpoint rejection → stage=token with upstream detail", async () => {
    const fetchMock = fetchRouter([
      [tokenUrl, json({ error_description: "invalid_grant" }, 400)],
    ]);
    const error = await finishLogin(context(), { fetchImpl: fetchMock }).catch((err) => err);
    expect(error).toBeInstanceOf(OfficeAceLoginError);
    expect(error).toMatchObject({ stage: "token", status: 400 });
    expect(error.message).toContain("invalid_grant");
  });

  it("token 200 without AK/SK → stage=token", async () => {
    const fetchMock = fetchRouter([[tokenUrl, json({ credentials: {} })]]);
    await expect(finishLogin(context(), { fetchImpl: fetchMock })).rejects.toMatchObject({
      stage: "token",
      message: expect.stringContaining("临时凭据"),
    });
  });

  it("validate rejection → stage=validate, status preserved", async () => {
    const fetchMock = fetchRouter([
      [tokenUrl, json(tokenPayload())],
      [PROJECTS_URL, json({ projects: [] })],
      [PERMISSION_URL, json({ error_msg: "denied" }, 403)],
    ]);
    await expect(finishLogin(context(), { fetchImpl: fetchMock })).rejects.toMatchObject({
      stage: "validate",
      status: 403,
      message: expect.stringContaining("denied"),
    });
  });

  it("model_info without gateway keys → stage=gateway", async () => {
    const fetchMock = fetchRouter([
      [tokenUrl, json(tokenPayload())],
      [PROJECTS_URL, json({ projects: [] })],
      [PERMISSION_URL, json({ account_id: "a", model_info: { model_api_url_base: "gw.example" } })],
    ]);
    await expect(finishLogin(context(), { fetchImpl: fetchMock })).rejects.toMatchObject({
      stage: "gateway",
      message: expect.stringContaining("model_app_key"),
    });
  });

  it("⑥b promotion-code rejection carries the actionable hint", async () => {
    const fetchMock = fetchRouter([
      [tokenUrl, json(tokenPayload())],
      [PROJECTS_URL, json({ projects: [] })],
      [PERMISSION_URL, json({ account_id: "a", subscription: { model_info: {} } })],
      [SUBSCRIPTION_URL, json({ error_code: "AgentArts.11000008" }, 400)],
    ]);
    await expect(finishLogin(context(), { fetchImpl: fetchMock })).rejects.toMatchObject({
      stage: "subscribe",
      status: 400,
      message: expect.stringContaining("邀请码无效"),
    });
  });

  it("missing code → stage=token, broken DPoP key → stage=token", async () => {
    await expect(finishLogin({ state: "x" }, { fetchImpl: fetchRouter([]) })).rejects.toMatchObject({
      stage: "token",
    });
    const fetchMock = fetchRouter([]);
    await expect(
      finishLogin({ ...context(), dpopPrivateKeyPem: "not a pem" }, { fetchImpl: fetchMock })
    ).rejects.toMatchObject({
      stage: "token",
      message: expect.stringContaining("DPoP 私钥不可用"),
    });
  });
});

function makePem() {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}
