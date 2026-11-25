import { NextResponse } from "next/server";
import { createProviderNode, getProviderNodes } from "@/models";
import { OPENAI_COMPATIBLE_PREFIX, ANTHROPIC_COMPATIBLE_PREFIX, CUSTOM_EMBEDDING_PREFIX } from "@/shared/constants/providers";
import { generateId } from "@/shared/utils";
import { checkPrefixConflict } from "@/shared/utils/providerPrefix";

export const dynamic = "force-dynamic";

const OPENAI_COMPATIBLE_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
};

const ANTHROPIC_COMPATIBLE_DEFAULTS = {
  baseUrl: "https://api.anthropic.com/v1",
};

const CUSTOM_EMBEDDING_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
};

// GET /api/provider-nodes - List all provider nodes
export async function GET() {
  try {
    const nodes = await getProviderNodes();
    return NextResponse.json({ nodes });
  } catch (error) {
    console.log("Error fetching provider nodes:", error);
    return NextResponse.json({ error: "Failed to fetch provider nodes" }, { status: 500 });
  }
}

// #149/#—: customHeaders rides per request (see executors/base.js), website is
// display-only (favicon logo + detail-page console link).
function sanitizeCustomHeaders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const clean = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof k === "string" && k.trim() && typeof v === "string") clean[k.trim()] = v;
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

function sanitizeWebsite(value) {
  const s = typeof value === "string" ? value.trim() : "";
  return /^https?:\/\//i.test(s) ? s : undefined;
}

// POST /api/provider-nodes - Create provider node
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, prefix, apiType, baseUrl, type, authHeaders, customHeaders, website } = body;
    const cleanCustomHeaders = sanitizeCustomHeaders(customHeaders);
    const cleanWebsite = sanitizeWebsite(website);

    if (!name?.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    if (!prefix?.trim()) {
      return NextResponse.json({ error: "Prefix is required" }, { status: 400 });
    }

    // Normalize prefix to lowercase so model routing is unambiguous and a node
    // can't shadow a built-in provider via case tricks (e.g. "CF" vs "cf").
    const normalizedPrefix = prefix.trim().toLowerCase();

    // Reject prefixes that collide with a built-in provider id/alias or another
    // custom node — otherwise model routing becomes ambiguous.
    const existingNodes = await getProviderNodes();
    const conflict = checkPrefixConflict(normalizedPrefix, existingNodes);
    if (conflict) {
      return NextResponse.json(conflict, { status: 400 });
    }

    // Determine type
    const nodeType = type || "openai-compatible";

    if (nodeType === "openai-compatible") {
      if (!apiType || !["chat", "responses"].includes(apiType)) {
        return NextResponse.json({ error: "Invalid OpenAI compatible API type" }, { status: 400 });
      }

      const node = await createProviderNode({
        id: `${OPENAI_COMPATIBLE_PREFIX}${apiType}-${generateId()}`,
        type: "openai-compatible",
        prefix: normalizedPrefix,
        apiType,
        baseUrl: (baseUrl || OPENAI_COMPATIBLE_DEFAULTS.baseUrl).trim(),
        name: name.trim(),
        authHeaders: authHeaders && typeof authHeaders === "object" ? authHeaders : undefined,
        ...(cleanCustomHeaders ? { customHeaders: cleanCustomHeaders } : {}),
        ...(cleanWebsite ? { website: cleanWebsite } : {}),
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    if (nodeType === "custom-embedding") {
      // Strip trailing slash and /embeddings if user pasted full endpoint
      let sanitizedBaseUrl = (baseUrl || CUSTOM_EMBEDDING_DEFAULTS.baseUrl).trim().replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/embeddings")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -"/embeddings".length);
      }

      const node = await createProviderNode({
        id: `${CUSTOM_EMBEDDING_PREFIX}${generateId()}`,
        type: "custom-embedding",
        prefix: normalizedPrefix,
        baseUrl: sanitizedBaseUrl,
        name: name.trim(),
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    if (nodeType === "anthropic-compatible") {
      // Sanitize Base URL: remove trailing slash, and remove trailing /messages if user added it
      // This prevents double-appending /messages at runtime
      let sanitizedBaseUrl = (baseUrl || ANTHROPIC_COMPATIBLE_DEFAULTS.baseUrl).trim().replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/messages")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -9); // remove /messages
      }

      const node = await createProviderNode({
        id: `${ANTHROPIC_COMPATIBLE_PREFIX}${generateId()}`,
        type: "anthropic-compatible",
        prefix: prefix.trim(),
        baseUrl: sanitizedBaseUrl,
        name: name.trim(),
        authHeaders: authHeaders && typeof authHeaders === "object" ? authHeaders : undefined,
        ...(cleanCustomHeaders ? { customHeaders: cleanCustomHeaders } : {}),
        ...(cleanWebsite ? { website: cleanWebsite } : {}),
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    return NextResponse.json({ error: "Invalid provider node type" }, { status: 400 });
  } catch (error) {
    console.log("Error creating provider node:", error);
    return NextResponse.json({ error: "Failed to create provider node" }, { status: 500 });
  }
}
