import { describe, it, expect } from "vitest";
import { resolveEndpointAuthHeaders } from "../../src/shared/utils/endpointAuthHeaders.js";

describe("resolveEndpointAuthHeaders (Issue #92)", () => {
  const defaultHeaders = {
    "Content-Type": "application/json",
    "Authorization": "Bearer my-secret-key-123",
  };

  it("returns default headers when authHeaders is missing, null, or empty", () => {
    expect(resolveEndpointAuthHeaders(null, "models", "my-secret-key-123", defaultHeaders)).toEqual(defaultHeaders);
    expect(resolveEndpointAuthHeaders(undefined, "models", "my-secret-key-123", defaultHeaders)).toEqual(defaultHeaders);
    expect(resolveEndpointAuthHeaders({}, "models", "my-secret-key-123", defaultHeaders)).toEqual(defaultHeaders);
    expect(resolveEndpointAuthHeaders({ chat: { "x-custom": "1" } }, "models", "my-secret-key-123", defaultHeaders)).toEqual(defaultHeaders);
  });

  it("replaces {apiKey} placeholder and strips default Authorization when template defines custom token header (Loomy case)", () => {
    const authHeaders = {
      models: {
        token: "{apiKey}",
      },
    };

    const result = resolveEndpointAuthHeaders(authHeaders, "models", "loomy-session-token-xyz", defaultHeaders);

    expect(result).toEqual({
      "Content-Type": "application/json",
      token: "loomy-session-token-xyz",
    });
    expect(result.Authorization).toBeUndefined();
  });

  it("supports {token} placeholder as alias to {apiKey}", () => {
    const authHeaders = {
      models: {
        "x-api-token": "{token}",
      },
    };

    const result = resolveEndpointAuthHeaders(authHeaders, "models", "my-token-456", defaultHeaders);

    expect(result).toEqual({
      "Content-Type": "application/json",
      "x-api-token": "my-token-456",
    });
    expect(result.Authorization).toBeUndefined();
  });

  it("preserves Authorization header if the template explicitly specifies it", () => {
    const authHeaders = {
      models: {
        Authorization: "Token {apiKey}",
        "x-client": "10router",
      },
    };

    const result = resolveEndpointAuthHeaders(authHeaders, "models", "custom-key-789", defaultHeaders);

    expect(result).toEqual({
      "Content-Type": "application/json",
      Authorization: "Token custom-key-789",
      "x-client": "10router",
    });
  });

  it("handles empty apiKey safely", () => {
    const authHeaders = {
      models: {
        token: "{apiKey}",
      },
    };

    const result = resolveEndpointAuthHeaders(authHeaders, "models", "", defaultHeaders);

    expect(result.token).toBe("");
    expect(result.Authorization).toBeUndefined();
  });
});
