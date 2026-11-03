#!/usr/bin/env node
/**
 * Audit GitHub Release Notes markdown against required release standards.
 *
 * Validates that release notes contain all mandatory sections:
 * 1. Title matching ## vX.Y.Z
 * 2. Theme summary blockquote (> 本版主题：...)
 * 3. ⚠️ 升级须知
 * 4. ✨ 新增亮点 / ✨ 新增
 * 5. 🐛 修复 / 🐛 重要修复
 * 6. 📦 安装 table (covering fnOS, Windows, macOS, Docker, npm CLI, server)
 * 7. **Full Changelog**: https://github.com/techysy/10router/compare/vPREV...vX.Y.Z
 *
 * Usage:
 *   node scripts/audit-release-notes.mjs <notes-file>
 *   node scripts/audit-release-notes.mjs --tag v1.6.5
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node scripts/audit-release-notes.mjs <notes-file> | --tag <tag>");
  process.exit(1);
}

let content = "";
let targetName = "";

if (args[0] === "--tag") {
  const tag = args[1];
  if (!tag) {
    console.error("Error: --tag requires a tag argument (e.g. v1.6.5)");
    process.exit(1);
  }
  targetName = tag;
  try {
    content = execFileSync("gh", ["release", "view", tag, "--json", "body", "-q", ".body"], {
      encoding: "utf8",
    });
  } catch (err) {
    console.error(`Failed to fetch release ${tag} via gh:`, err.message);
    process.exit(1);
  }
} else {
  const file = args[0];
  targetName = file;
  try {
    content = readFileSync(file, "utf8");
  } catch (err) {
    console.error(`Failed to read file ${file}:`, err.message);
    process.exit(1);
  }
}

const errors = [];

// 1. Version header
const versionMatch = content.match(/^##\s+v?(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?)/m);
if (!versionMatch) {
  errors.push("Missing version title (e.g. ## v1.6.6)");
}
const currentVersion = versionMatch ? versionMatch[1] : null;

// 2. Theme blockquote
if (!content.match(/^>\s+本版主题：/m)) {
  errors.push("Missing theme summary blockquote (e.g. > 本版主题：...)");
}

// 3. Upgrade notes
if (!content.match(/###\s+⚠️\s*升级须知/m)) {
  errors.push("Missing section: ### ⚠️ 升级须知");
}

// 4. Highlights / Features
if (!content.match(/###\s+✨\s*(?:新增亮点|新增)/m)) {
  errors.push("Missing section: ### ✨ 新增亮点");
}

// 5. Fixes
if (!content.match(/###\s+🐛\s*(?:重要修复|修复)/m)) {
  errors.push("Missing section: ### 🐛 重要修复 / 修复");
}

// 6. Installation section & table
if (!content.match(/##\s+📦\s*安装/m)) {
  errors.push("Missing section: ## 📦 安装");
} else {
  const channels = ["fnOS", "Windows", "macOS", "Docker", "npm CLI", "独立服务端"];
  const missingChannels = channels.filter((c) => !content.includes(c));
  if (missingChannels.length > 0) {
    errors.push(`Installation table is missing key channels: ${missingChannels.join(", ")}`);
  }
}

// 7. Full Changelog comparison link
const changelogMatch = content.match(/\*\*Full Changelog\*\*:\s*(https:\/\/github\.com\/[^\s]+compare\/v[^\s]+)/m);
if (!changelogMatch) {
  errors.push("Missing comparison link: **Full Changelog**: https://github.com/techysy/10router/compare/vPREV...vCURR");
}

if (errors.length > 0) {
  console.error(`\n❌ Release Notes Audit FAILED for [${targetName}]:`);
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}

console.log(`\n✅ Release Notes Audit PASSED for [${targetName}] (v${currentVersion || "unknown"})`);
console.log("   - Version title & Theme blockquote verified");
console.log("   - ⚠️ 升级须知, ✨ 新增亮点, 🐛 修复 present");
console.log("   - 📦 安装 table with all 6 distribution channels verified");
console.log("   - **Full Changelog** compare URL verified");
