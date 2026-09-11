import path from "node:path";
import fs from "node:fs";
import { DATA_DIR, LEGACY_JSON_FILES } from "@/lib/dataDir.js";

export const DB_DIR = path.join(DATA_DIR, "db");
export const DATA_FILE = path.join(DB_DIR, "data.sqlite");
export const BACKUPS_DIR = path.join(DB_DIR, "backups");
export const LEGACY_FILES = Object.fromEntries(
  Object.entries(LEGACY_JSON_FILES).map(([key, name]) => [key, path.join(DATA_DIR, name)]),
);
export function ensureDirs() {
  for (const dir of [DATA_DIR, DB_DIR, BACKUPS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}
