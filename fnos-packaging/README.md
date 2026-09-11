# fnOS fpk 打包（10router-fnos）

> 将 10Router 打包为飞牛 fnOS 应用（appname=10router，端口 20127，可与 9router 20128 并存）。

## 目录结构

```
fnos-packaging/
├── manifest          # fnOS app 清单（appname=10router, service_port=20127）
├── cmd/              # 生命周期脚本（main 含 HOME=DATA_DIR 修复）
├── config/           # privilege / resource（share 名 10router）
├── wizard/           # 安装向导
├── docs/             # 测试报告等
├── app/ui/           # 桌面入口配置（url/iframe 双模式切换）
└── ICON*.PNG
```

## 构建步骤

```bash
# 0. 前置：本仓库 npm install && npm run build 已完成（生成 .next/standalone）
#    构建前自动同步版本：npm run prebuild:fpk（manifest version ← package.json）

# 1. 同步到 NAS 构建目录（骨架，server 产物单独传）
tar czf /tmp/10rf-skel.tar -C fnos-packaging cmd config wizard manifest docs app/ui ICON.PNG ICON_256.PNG
scp /tmp/10rf-skel.tar nas:"'/vol1/1000/fnOS Dev/10router-fnos/'"

# 2. server 产物（standalone，含 node_modules 约 76MB）
cd .next/standalone
tar czf /tmp/10rf-server.tar --exclude='./logs' .
scp /tmp/10rf-server.tar nas:/tmp/

# 3. 在 NAS 上组装 + 打包
ssh nas
mkdir -p '/vol1/1000/fnOS Dev/10router-fnos/app/server'
tar xzf /tmp/10rf-server.tar -C '/vol1/1000/fnOS Dev/10router-fnos/app/server/'
rm -rf '/vol1/1000/fnOS Dev/10router-fnos'   # 若首次：先解骨架
cd '/vol1/1000/fnOS Dev/10router-fnos'
chmod +x cmd/*
# url 版
python3 -c "import json;p='app/ui/config';d=json.load(open(p));d['.url']['10router.Application']['type']='url';json.dump(d,open(p,'w'),ensure_ascii=False,indent=2)"
fnpack build && mv 10router.fpk 10router-$(version)-x86.fpk
# iframe 版
...同上 type='iframe'...
```

## 测试构建（不发布）

本地/真机验证未发布的改动时，用测试版本号而不是已发布版本号重建（否则得到「同号不同内容」的 fpk）：

```bash
npm run test-version 1.1.0-test.1   # 三处 package.json + 本目录 manifest 同号
npm run prebuild:fpk                # manifest version ← package.json（测试号进 fpk 文件名）
npm run build
# 再到 NAS 上组装 + fnpack build（见上）
npm run test-version -- --revert     # 测完回退
```

两条通道（Windows 桌面版 / fpk）共用的流程、验证方法论与踩坑：`docs/zh-CN/local-build-and-verify.md`。

## 关键修复记录

- **HOME=EACCES**：fnOS 应用用户 home（/home/10router）不存在，
  `cmd/main` 启动时注入 `HOME="${DATA_DIR}"`，`.9router` 落在数据目录内。
- 端口 **20127**（9router 占 20128），数据目录 `@appdata/10router`，可并存安装。
