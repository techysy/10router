import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const directory = new URL("../open-sse/providers/registry/", import.meta.url);
const index = new URL("index.js", directory);
const files = new Set(readdirSync(directory).filter((file) => file.endsWith(".js") && file !== "index.js"));
// Keep existing import order stable; new entries append without renumbering unrelated providers.
const previous = [...readFileSync(index, "utf8").matchAll(/from "\.\/([^"/]+\.js)"/g)].map((match) => match[1]);
const ordered = [...previous.filter((file) => files.delete(file)), ...[...files].sort()];
const source = [
  "// Auto-generated: static imports for all registry entries",
  ...ordered.map((file, i) => `import p${i} from "./${file}";`),
  "",
  "export default [",
  ...ordered.map((_, i) => `  p${i},`),
  "];",
  "",
].join("\n");
writeFileSync(index, source);
console.log(`Generated ${fileURLToPath(index)} (${ordered.length} providers)`);
