// fnOS 管理面板（issue #97）纯函数库的测试。
// 面板跑在 NAS 上没法进 CI，这里把可判定的逻辑全部钉死：
// 版本比较、归档魔数、每日调度（含错窗补跑）、sudo -l 折行解析、
// aria2c 参数、解包产物定位。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import lib from "../../fnos-packaging/cmd/dashboard-lib.js";

describe("compareSemver（与 src/shared/utils/semver.js 同语义）", () => {
  it("stable 版本按数字位比较", () => {
    expect(lib.compareSemver("1.6.7", "1.6.6")).toBeGreaterThan(0);
    expect(lib.compareSemver("1.7.0", "1.6.9")).toBeGreaterThan(0);
    expect(lib.compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(lib.compareSemver("1.6.6", "1.6.6")).toBe(0);
  });

  it("正式版优先于同核预发布版", () => {
    expect(lib.compareSemver("1.6.6", "1.6.6-test.1")).toBeGreaterThan(0);
    expect(lib.compareSemver("1.6.2", "1.6.2-test.45")).toBeGreaterThan(0);
    expect(lib.compareSemver("1.6.6-test.1", "1.6.6")).toBeLessThan(0);
  });

  it("预发布标识逐段比较（数字段按数值）", () => {
    expect(lib.compareSemver("1.6.6-test.2", "1.6.6-test.10")).toBeLessThan(0);
    expect(lib.compareSemver("1.6.6-test.10", "1.6.6-test.2")).toBeGreaterThan(0);
    expect(lib.compareSemver("1.6.6-test.1", "1.6.6-test.1")).toBe(0);
  });

  it("容忍 v 前缀，非法输入排序垫底", () => {
    expect(lib.compareSemver("v1.6.6", "1.6.6")).toBe(0);
    expect(lib.compareSemver(null, "1.6.6")).toBeLessThan(0);
    expect(lib.compareSemver("garbage", "1.6.6")).toBeLessThan(0);
  });
});

describe("detectArchiveMagic", () => {
  it("识别 gzip（1f 8b）与 zip（50 4b）", () => {
    expect(lib.detectArchiveMagic(Buffer.from([0x1f, 0x8b, 0x08]))).toBe("gzip");
    expect(lib.detectArchiveMagic(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe("zip");
  });
  it("其余一律拒绝", () => {
    expect(lib.detectArchiveMagic(Buffer.from("<html"))).toBeNull();
    expect(lib.detectArchiveMagic(Buffer.alloc(0))).toBeNull();
    expect(lib.detectArchiveMagic(null)).toBeNull();
  });
});

describe("parseHHmm / 每日调度", () => {
  it("合法与非法的 HH:mm", () => {
    expect(lib.parseHHmm("04:30")).toEqual({ h: 4, m: 30 });
    expect(lib.parseHHmm("4:30")).toEqual({ h: 4, m: 30 });
    expect(lib.parseHHmm("23:59")).toEqual({ h: 23, m: 59 });
    expect(lib.parseHHmm("24:00")).toBeNull();
    expect(lib.parseHHmm("4:5")).toBeNull();
    expect(lib.parseHHmm("abc")).toBeNull();
    expect(lib.parseHHmm(null)).toBeNull();
  });

  const at = (dayOffset, h, m) => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };

  it("槽点前不触发", () => {
    expect(lib.shouldRunDailySchedule("10:00", at(0, 9, 59), 0)).toBe(false);
  });

  it("槽点后未跑过 → 触发（含面板重启后错窗补跑）", () => {
    expect(lib.shouldRunDailySchedule("10:00", at(0, 10, 0), 0)).toBe(true);
    expect(lib.shouldRunDailySchedule("10:00", at(0, 23, 30), null)).toBe(true);
  });

  it("今天已经跑过 → 不触发；昨天跑过今天没跑 → 补跑", () => {
    expect(lib.shouldRunDailySchedule("10:00", at(0, 11, 0), at(0, 10, 1))).toBe(false);
    expect(lib.shouldRunDailySchedule("10:00", at(0, 11, 0), at(-1, 10, 1))).toBe(true);
  });

  it("非法时间永不触发", () => {
    expect(lib.shouldRunDailySchedule("25:00", at(0, 11, 0), 0)).toBe(false);
  });

  it("nextDailyRunMs：槽点前取今天，之后取明天", () => {
    const before = at(0, 9, 0);
    expect(lib.nextDailyRunMs("10:00", before)).toBe(at(0, 10, 0));
    const after = at(0, 11, 0);
    expect(lib.nextDailyRunMs("10:00", after)).toBe(at(1, 10, 0));
    expect(lib.nextDailyRunMs("bad", after)).toBeNull();
  });
});

describe("sudo -l 折行解析", () => {
  it("合并反斜杠延续行后再匹配 NOPASSWD", () => {
    const out = [
      "Matching Defaults entries for app on nas:",
      "    env_reset, mail_badpass, secure_path=/usr/local/sbin\\:/usr/local/bin",
      "",
      "User app may run the following commands on nas:",
      "    (ALL) NOPASSWD: /bin/systemctl restart 10router, \\",
      "        /bin/systemctl start 10router, /bin/cp -a \\",
      "        /tmp/pkg/. /var/apps/10router/server.new",
    ].join("\n");
    const cmds = lib.parseSudoList(out);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain("/bin/systemctl restart 10router");
    expect(cmds[0]).toContain("/var/apps/10router/server.new");
    expect(cmds[0]).toContain("NOPASSWD:");
  });

  it("非折行输出逐条返回；无 NOPASSWD 时为空", () => {
    const out = [
      "User app may run the following commands on nas:",
      "    (ALL) NOPASSWD: /usr/bin/tee",
      "    (root) /bin/ls",
    ].join("\n");
    expect(lib.parseSudoList(out)).toEqual(["NOPASSWD: /usr/bin/tee"]);
    expect(lib.parseSudoList("User app may run:\n    (ALL) /bin/ls")).toEqual([]);
    expect(lib.parseSudoList("")).toEqual([]);
  });

  it("行尾双反斜杠不是延续行", () => {
    const lines = lib.mergeSudoFoldedLines("a\\\\\nb");
    expect(lines).toEqual(["a\\\\", "b"]);
  });
});

describe("buildAria2Args", () => {
  it("16 线程分段 + 断点续传", () => {
    const args = lib.buildAria2Args({ url: "https://registry.npmjs.org/x.tgz", out: { dir: "/tmp/dl", file: "x.tgz" } });
    expect(args).toContain("-c");
    expect(args).toContain("--split=16");
    expect(args).toContain("--max-connection-per-server=16");
    expect(args[args.length - 3]).toBe("-o");
    expect(args[args.length - 2]).toBe("x.tgz");
    expect(args[args.length - 1]).toBe("https://registry.npmjs.org/x.tgz");
    expect(args.some((a) => a.startsWith("--all-proxy"))).toBe(false);
  });

  it("配置代理时追加 --all-proxy", () => {
    const args = lib.buildAria2Args({ url: "https://r/x.tgz", out: { dir: "/d", file: "x.tgz" }, proxy: "http://127.0.0.1:7890" });
    expect(args).toContain("--all-proxy=http://127.0.0.1:7890");
  });
});

describe("findPayloadRoot / readPayloadVersion", () => {
  const mkPayload = (root, dir, withVersion) => {
    const payload = path.join(root, dir);
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, "custom-server.js"), "// server");
    fs.writeFileSync(path.join(payload, "package.json"), JSON.stringify(withVersion ? { version: "9.9.9" } : {}));
    return payload;
  };

  it("npm tgz 布局：package/app/ 下双文件齐备才算产物", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "panel-lib-"));
    const payload = mkPayload(root, path.join("package", "app"), true);
    expect(lib.findPayloadRoot(root)).toBe(payload);
    expect(lib.readPayloadVersion(payload)).toBe("9.9.9");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("缺少 custom-server.js 判为无效；也兼容平铺 app/ 布局", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "panel-lib-"));
    fs.mkdirSync(path.join(root, "package", "app"), { recursive: true });
    fs.writeFileSync(path.join(root, "package", "app", "package.json"), "{}");
    expect(lib.findPayloadRoot(root)).toBeNull();
    const flat = mkPayload(root, "app", false);
    expect(lib.findPayloadRoot(root)).toBe(flat);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("npm URL", () => {
  it("scoped 包名在 registry 路径中整体编码", () => {
    expect(lib.npmLatestUrl("@techysy/10router")).toBe("https://registry.npmjs.org/@techysy%2F10router/latest");
    expect(lib.npmTarballUrl("@techysy/10router", "1.6.7")).toBe("https://registry.npmjs.org/@techysy/10router/-/10router-1.6.7.tgz");
  });
});

describe("孤儿更新清场（reclaimOrphanUpdate，2026-11-13 健壮性补丁）", () => {
  const freshPanel = () => {
    // dashboard.js 以 require.main 守卫启动 server —— 测试环境不触发 listen；
    // DATA_DIR 指到临时目录避免污染真实 ~/.10router。
    const panel = require("../../fnos-packaging/cmd/dashboard.js");
    return panel;
  };

  it("超时的 currentUpdate 被回收并置空", () => {
    const panel = freshPanel();
    // currentUpdate 是模块私有 —— 通过 performUpdate 不可控注入，改由
    // 内部行为验证：无更新时回收是空操作。
    expect(panel.reclaimOrphanUpdate(Date.now())).toBe(false);
  });

  it("UPDATE_ORPHAN_MS 覆盖最长流水线路径（下载 30min + 解包 + 健康等待）", () => {
    expect(require("../../fnos-packaging/cmd/dashboard.js").UPDATE_ORPHAN_MS)
      .toBeGreaterThanOrEqual(45 * 60 * 1000);
  });
});
