import { proxyAwareFetch } from "../../utils/proxyFetch.js";

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  if (headers instanceof Map) return headers.get(name) || headers.get(name.toLowerCase()) || null;
  return headers[name] || headers[name.toLowerCase()] || null;
}

function setCookieValues(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const value = headerValue(headers, "set-cookie");
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

async function readBodyBytes(response) {
  if (typeof response.arrayBuffer === "function") return Buffer.from(await response.arrayBuffer());
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  return Buffer.from(await response.text());
}

export async function httpGet(url, { jar = null, timeoutMs = 20_000, signal, proxyOptions = null, headers: extraHeaders = {} } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const u = new URL(url);
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    Accept: "*/*",
    Referer: "https://login.bce.baidu.com/",
    ...(jar ? { Cookie: jar.header(u.hostname) } : {}),
    ...extraHeaders,
  };
  const response = await proxyAwareFetch(url, { method: "GET", redirect: "manual", headers, signal: merged }, proxyOptions);
  const setCookies = setCookieValues(response.headers);
  if (jar) jar.addSetCookie(setCookies, u.hostname);
  const body = await readBodyBytes(response);
  return {
    status: response.status,
    headers: {
      location: headerValue(response.headers, "location"),
      "set-cookie": setCookies,
      "content-type": headerValue(response.headers, "content-type"),
    },
    body,
  };
}

export function isBaiduUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "passport.baidu.com" || u.hostname === "wappass.baidu.com" || u.hostname === "login.bce.baidu.com" || u.hostname === "console.bce.baidu.com");
  } catch {
    return false;
  }
}
