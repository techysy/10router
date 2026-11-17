
import { writeFileSync } from "node:fs";
import { PROVIDERS } from "../open-sse/config/providers.js";
const rows = [];
for (const [pid, p] of Object.entries(PROVIDERS)) {
  const authModes = p.authModes || [];
  const isOAuth = authModes.includes("oauth");
  rows.push({ id: pid, authModes: authModes.join(","), isOAuth });
}
writeFileSync(process.env.OUT, JSON.stringify(rows, null, 1));
