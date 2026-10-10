/**
 * GET /api/external-quota/token-harbor
 *
 * Fetch Token Harbor free quota information using browser-based authentication.
 * Supports cookie persistence for logged-in sessions.
 */

import { NextResponse } from "next/server";
import http from "node:http";
import https from "node:https";

// Cookie jar to persist session cookies
const tokenHarborCookies = new Map();
const COOKIE_STORAGE_PATH = ".tokenharbor-cookies.json";

/**
 * Load saved cookies from file
 */
async function loadCookies() {
  try {
    const fs = await import("node:fs");
    if (fs.existsSync(COOKIE_STORAGE_PATH)) {
      const data = JSON.parse(await fs.promises.readFile(COOKIE_STORAGE_PATH, "utf-8"));
      tokenHarborCookies.set("tokenharbor.ai", data);
    }
  } catch (err) {
    console.log("[TokenHarbor] Failed to load cookies:", err.message);
  }
}

/**
 * Save cookies to file
 */
async function saveCookies() {
  try {
    const fs = await import("node:fs");
    const cookies = tokenHarborCookies.get("tokenharbor.ai");
    if (cookies) {
      await fs.promises.writeFile(
        COOKIE_STORAGE_PATH,
        JSON.stringify(cookies, null, 2),
        "utf-8"
      );
    }
  } catch (err) {
    console.log("[TokenHarbor] Failed to save cookies:", err.message);
  }
}

/**
 * Custom agent that persists cookies
 */
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });

/**
 * Parse HTTP response headers into cookie objects
 */
function parseHeadersToCookies(headers) {
  const cookieHeader = headers["set-cookie"];
  if (!cookieHeader) return [];

  const cookies = Array.isArray(cookieHeader) ? cookieHeader : [cookieHeader];
  return cookies.map((cookie) => {
    const [nameValue, ...rest] = cookie.split("; ");
    const [name, value] = nameValue.split("=");
    return { name, value, path: "/", domain: "tokenharbor.ai" };
  });
}

/**
 * Fetch Token Harbor dashboard with browser-like headers and cookie management
 */
async function fetchTokenHarborQuota() {
  await loadCookies();

  return new Promise((resolve, reject) => {
    const url = new URL("https://tokenharbor.ai/dashboard");

    const cookies = tokenHarborCookies.get("tokenharbor.ai") || [];
    const cookieString = cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        ...(cookieString ? { Cookie: cookieString } : {}),
      },
      agent: httpsAgent,
    };

    const req = https.request(options, (res) => {
      let data = "";

      // Persist incoming cookies
      if (res.headers["set-cookie"]) {
        const newCookies = parseHeadersToCookies(res.headers);
        const existingCookies = tokenHarborCookies.get("tokenharbor.ai") || [];
        const updatedCookies = [...new Set([...existingCookies, ...newCookies])];
        tokenHarborCookies.set("tokenharbor.ai", updatedCookies);
        saveCookies().catch(() => {});
      }

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", async () => {
        try {
          // Extract free quota information from HTML
          const quotaData = extractQuotaFromHTML(data);

          if (quotaData && quotaData.freeAllowance !== undefined) {
            resolve(quotaData);
          } else {
            resolve({
              success: false,
              error: "No quota data found - please login via browser first",
              requiresAuth: !cookieString,
            });
          }
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on("error", (err) => {
      reject(err);
    });

    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });

    req.end();
  });
}

/**
 * Extract free quota info from HTML using regex patterns
 */
function extractQuotaFromHTML(html) {
  const result = {
    provider: "tokenharbor",
    source: "https://tokenharbor.ai/dashboard",
    timestamp: new Date().toISOString(),
  };

  // Try to find "Free allowance" percentage (e.g., "80% used")
  const allowanceMatch = html.match(
    /Free allowance[\s\S]*?(\d+)%\s*(?:used|of total)/i
  );
  if (allowanceMatch) {
    result.freeAllowanceUsed = parseInt(allowanceMatch[1], 10);
    result.freeAllowanceRemaining = 100 - result.freeAllowanceUsed;
  }

  // Try to find reset time (e.g., "Resets in 5d 4h")
  const resetMatch = html.match(/Resets?\s+(in\s+)?([\d]+[dD]\s+)?[\d]+[hH][rR]?/i);
  if (resetMatch) {
    result.resetTimeDisplay = resetMatch[0].replace(/Resets?\s+/i, "");
  }

  // Look for upgrade offer (e.g., "$0.99 first month")
  const upgradeMatch = html.match(
    /\$([\d.]+)\s*(?:first month|intro)/i
  );
  if (upgradeMatch) {
    result.upgradePrice = parseFloat(upgradeMatch[1]);
  }

  // Success marker - found quota data means likely logged in
  if (result.freeAllowanceUsed !== undefined) {
    result.success = true;
    result.authenticated = true;
  }

  return result;
}

export async function GET(request) {
  try {
    const quota = await fetchTokenHarborQuota();

    return NextResponse.json({
      success: quota.success !== false,
      data: quota,
      message: quota.success
        ? "Token Harbor quota retrieved successfully"
        : "Unable to retrieve quota - check authentication",
      lastFetched: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[TokenHarbor API Error]:", err);

    return NextResponse.json(
      {
        success: false,
        error: err.message,
        data: null,
      },
      { status: 500 }
    );
  }
}

// Disable auto-transform for this route
export const dynamic = "force-dynamic";
export const revalidate = 0;
