// Web Fetch handler — dispatches to firecrawl, jina-reader, tavily, exa,
// tinyfish, keenable
// Returns normalized shape across all providers

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_FORMAT = "markdown";

/**
 * @typedef {Object} FetchResult
 * @property {boolean} success
 * @property {number} [status]
 * @property {string} [error]
 * @property {Object} [data]
 */

/**
 * Fetch with timeout abort.
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 */
// Strip non-ASCII chars from header values (HTTP headers must be ByteString).
function sanitizeHeaders(headers) {
  if (!headers) return headers;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = typeof v === "string" ? v.replace(/[^\x00-\xFF]/g, "").trim() : v;
  }
  return out;
}

async function tryFetch(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, headers: sanitizeHeaders(init.headers), signal: ctrl.signal });
    return { ok: true, res };
  } catch (err) {
    const isAbort = err?.name === "AbortError";
    return { ok: false, timeout: isAbort, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function truncate(text, max) {
  if (!text || typeof text !== "string") return text || "";
  if (!max || max <= 0) return text;
  return text.length > max ? text.slice(0, max) : text;
}

function parseJinaTitle(text) {
  const source = String(text || "");
  const metadataTitle = source.match(/^\s*Title:\s*(.+)$/mi);
  if (metadataTitle) return metadataTitle[1].trim();
  const m = source.match(/^\s*#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function buildData({ provider, url, title, format, text, costUsd, responseMs, upstreamMs }) {
  return {
    provider,
    url,
    title: title || null,
    content: { format, text: text || "", length: (text || "").length },
    metadata: { author: null, published_at: null, language: null },
    usage: { fetch_cost_usd: costUsd ?? null },
    metrics: { response_time_ms: responseMs, upstream_latency_ms: upstreamMs }
  };
}

async function readJsonOrText(res) {
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try { return { json: await res.json() }; } catch { return { text: "" }; }
  }
  return { text: await res.text() };
}

/**
 * Main handler.
 * @param {Object} params
 * @param {string} params.url
 * @param {string} [params.format]
 * @param {number} [params.maxCharacters]
 * @param {string} params.provider
 * @param {Object} [params.providerConfig]
 * @param {Object} [params.credentials]
 * @param {Function} [params.log]
 * @returns {Promise<FetchResult>}
 */
export async function handleFetchCore({ url, format, maxCharacters, provider, providerConfig, credentials, log }) {
  if (!url || typeof url !== "string") {
    return { success: false, status: 400, error: "url is required" };
  }
  if (!provider) {
    return { success: false, status: 400, error: "provider is required" };
  }

  const fmt = format || DEFAULT_FORMAT;
  const timeoutMs = providerConfig?.timeoutMs || DEFAULT_TIMEOUT_MS;
  const apiKey = credentials?.apiKey || credentials?.key || credentials?.token || "";
  const costPerQuery = providerConfig?.costPerQuery ?? null;
  const startedAt = Date.now();

  try {
    if (provider === "firecrawl") {
      return await runFirecrawl({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt });
    }
    if (provider === "jina-reader") {
      return await runJina({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt });
    }
    if (provider === "tavily") {
      return await runTavily({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt });
    }
    if (provider === "exa") {
      return await runExa({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt });
    }
    if (provider === "tinyfish") {
      return await runTinyFish({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt, baseUrl: providerConfig?.baseUrl });
    }
    if (provider === "keenable") {
      return await runKeenable({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt, baseUrl: providerConfig?.baseUrl });
    }
    return { success: false, status: 400, error: `Unsupported provider: ${provider}` };
  } catch (err) {
    log?.("fetch handler error:", err?.message || err);
    return { success: false, status: 502, error: err?.message || "Internal fetch error" };
  }
}

async function runFirecrawl({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt }) {
  const upstreamStart = Date.now();
  const r = await tryFetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ url, formats: [fmt] })
  }, timeoutMs);

  if (!r.ok) {
    return { success: false, status: r.timeout ? 504 : 502, error: r.error };
  }
  const upstreamMs = Date.now() - upstreamStart;
  const { json } = await readJsonOrText(r.res);
  if (!r.res.ok) {
    return { success: false, status: r.res.status, error: json?.error || `Firecrawl error: ${r.res.status}` };
  }
  const d = json?.data || {};
  const text = truncate(d.markdown || d.html || d.text || "", maxCharacters);
  const title = d.metadata?.title || null;
  return {
    success: true,
    data: buildData({
      provider: "firecrawl", url, title, format: fmt, text,
      costUsd: costPerQuery, responseMs: Date.now() - startedAt, upstreamMs
    })
  };
}

async function runJina({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt }) {
  const upstreamStart = Date.now();
  const r = await tryFetch("https://r.jina.ai/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ url })
  }, timeoutMs);

  if (!r.ok) {
    return { success: false, status: r.timeout ? 504 : 502, error: r.error };
  }
  const upstreamMs = Date.now() - upstreamStart;
  const body = await r.res.text();
  if (!r.res.ok) {
    return { success: false, status: r.res.status, error: body?.slice(0, 500) || `Jina error: ${r.res.status}` };
  }
  const text = truncate(body, maxCharacters);
  return {
    success: true,
    data: buildData({
      provider: "jina-reader", url, title: parseJinaTitle(body), format: fmt, text,
      costUsd: costPerQuery, responseMs: Date.now() - startedAt, upstreamMs
    })
  };
}

async function runTavily({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt }) {
  const upstreamStart = Date.now();
  const r = await tryFetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ urls: [url], extract_depth: "basic" })
  }, timeoutMs);

  if (!r.ok) {
    return { success: false, status: r.timeout ? 504 : 502, error: r.error };
  }
  const upstreamMs = Date.now() - upstreamStart;
  const { json } = await readJsonOrText(r.res);
  if (!r.res.ok) {
    return { success: false, status: r.res.status, error: json?.error || `Tavily error: ${r.res.status}` };
  }
  const first = json?.results?.[0] || {};
  const text = truncate(first.raw_content || "", maxCharacters);
  return {
    success: true,
    data: buildData({
      provider: "tavily", url, title: null, format: fmt, text,
      costUsd: costPerQuery, responseMs: Date.now() - startedAt, upstreamMs
    })
  };
}

async function runExa({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt }) {
  const upstreamStart = Date.now();
  const r = await tryFetch("https://api.exa.ai/contents", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {})
    },
    body: JSON.stringify({ ids: [url], text: true })
  }, timeoutMs);

  if (!r.ok) {
    return { success: false, status: r.timeout ? 504 : 502, error: r.error };
  }
  const upstreamMs = Date.now() - upstreamStart;
  const { json } = await readJsonOrText(r.res);
  if (!r.res.ok) {
    return { success: false, status: r.res.status, error: json?.error || `Exa error: ${r.res.status}` };
  }
  const first = json?.results?.[0] || {};
  const text = truncate(first.text || "", maxCharacters);
  return {
    success: true,
    data: buildData({
      provider: "exa", url, title: first.title || null, format: fmt, text,
      costUsd: costPerQuery, responseMs: Date.now() - startedAt, upstreamMs
    })
  };
}

// ── TinyFish Fetch ──────────────────────────────────────────────────────
// POST https://api.fetch.tinyfish.ai { urls: [...], format } →
// { results: [{ url, final_url, title, text, … }], errors: [...] }.
// Free at any balance (no wallet draw). Upstream offers html/markdown/json —
// our "text" request maps to its markdown, the LLM-facing default.
async function runTinyFish({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt, baseUrl }) {
  const endpoint = (baseUrl || "https://api.fetch.tinyfish.ai").replace(/\/+$/, "");
  const format = fmt === "html" ? "html" : "markdown";
  const upstreamStart = Date.now();
  const r = await tryFetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {})
    },
    body: JSON.stringify({ urls: [url], format })
  }, timeoutMs);

  if (!r.ok) {
    return { success: false, status: r.timeout ? 504 : 502, error: r.error };
  }
  const upstreamMs = Date.now() - upstreamStart;
  const { json } = await readJsonOrText(r.res);
  if (!r.res.ok) {
    return { success: false, status: r.res.status, error: json?.error || `TinyFish error: ${r.res.status}` };
  }
  const first = json?.results?.[0];
  if (!first) {
    const upstreamErr = Array.isArray(json?.errors) && json.errors[0]?.error;
    return { success: false, status: 502, error: upstreamErr || `TinyFish returned no result for ${url}` };
  }
  // format "json" yields a document tree — stringify so content.text stays a string.
  const raw = typeof first.text === "string" ? first.text : first.text ? JSON.stringify(first.text) : "";
  const text = truncate(raw, maxCharacters);
  return {
    success: true,
    data: buildData({
      provider: "tinyfish", url, title: first.title || null, format: fmt, text,
      costUsd: costPerQuery, responseMs: Date.now() - startedAt, upstreamMs
    })
  };
}

// ── Keenable Fetch ──────────────────────────────────────────────────────
// GET https://api.keenable.ai/v1/fetch?url=…&max_chars=… →
// { url, title, description, author, content, published_at } (markdown).
// `live=true` overrides upstream's indexed-only default so arbitrary URLs
// still resolve — without it un-indexed targets error out.
async function runKeenable({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt, baseUrl }) {
  const endpoint = (baseUrl || "https://api.keenable.ai/v1/fetch").replace(/\/+$/, "");
  const qp = new URLSearchParams({ url, live: "true" });
  if (maxCharacters && maxCharacters > 0) qp.set("max_chars", String(maxCharacters));

  const upstreamStart = Date.now();
  const r = await tryFetch(`${endpoint}?${qp}`, {
    method: "GET",
    headers: { ...(apiKey ? { "x-api-key": apiKey } : {}) }
  }, timeoutMs);

  if (!r.ok) {
    return { success: false, status: r.timeout ? 504 : 502, error: r.error };
  }
  const upstreamMs = Date.now() - upstreamStart;
  const { json } = await readJsonOrText(r.res);
  if (!r.res.ok) {
    return { success: false, status: r.res.status, error: json?.error || `Keenable error: ${r.res.status}` };
  }
  const text = truncate(json?.content || "", maxCharacters);
  return {
    success: true,
    data: buildData({
      provider: "keenable", url, title: json?.title || null, format: fmt, text,
      costUsd: costPerQuery, responseMs: Date.now() - startedAt, upstreamMs
    })
  };
}
