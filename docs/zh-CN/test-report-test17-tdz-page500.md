# 测试报告：1.1.1-test.17「health 全绿但页面 500」（2026-09-12）

> 归属：本地测试轮（`desktop/test-local.ps1`）验证方法论，见
> `docs/zh-CN/local-build-and-verify.md` §5 的报告索引。本文是一次真实事故的完整
> 复盘，核心结论：**轮次绿 ≠ 页面能用**。

## 1. 时间线与现象

- `78c403a9`（#13/#14 修复）跑 `test-local.ps1 -Version 1.1.1-test.17`：版本、health、
  feature marker 全过，轮次 **exit 0**。
- 用户打开 provider 详情页 → **"This page couldn't load"**；`/api/health`、`/v1/models`
  全正常。
- `server.log` 里唯一的线索（压缩后标识符 `b1` 无从对回源码）：

```
⨯ ReferenceError: Cannot access 'b1' before initialization
    at T (…\.next-cli-build\server\app\(dashboard)\dashboard\providers\[id]\page.js:14:10956)
```

## 2. 根因

#14 新增的 `refreshAfterConnectionChange` 写成了
`useCallback(..., [fetchConnections, fetchDisabledModels])`，但位置在 **`fetchConnections`
声明（约 100 行之后）的前面**。组件函数体内的 `const` 按序求值，依赖数组**每次渲染都立即
求值**，前向引用直接踩暂时性死区——该页 SSR 每次渲染必炸，客户端路由同样进不去。
`node --check`、TypeScript、Next build 全部不报错：语法合法、类型合法，只有运行时非法。

## 3. 为什么测试轮没拦住（三层全漏过）

1. step 7 只打 `/api/health`——它**不经过任何页面组件的渲染**；
2. 未鉴权 `curl /dashboard` 得 307 → `/login`，middleware 在渲染前就短路，同样测不到；
3. 源码文本守卫用例（`disabled-models-ux.test.js`）断言的是「接线存在」，
   不是「声明顺序合法」——按仓库惯例它是文本断言，本就不该背这个锅。

feature marker 反而**命中**了（新字符串在产物 chunk 里）——代码进包 ≠ 页面能渲染。

## 4. 修复与防复发

- 修复（`6879715a`）：声明移到 `fetchConnections` 之后，注释写明顺序不可换的原因。
- **test-local.ps1 step 7 新增登录态 SSR 冒烟**（治本的一道闸）：

```powershell
# 用本地 jwt-secret 铸 10 分钟 JWT(与 src/lib/auth/dashboardSession.js 同源, jose HS256),
# 以 auth_token cookie 打 /dashboard —— 非 200 判轮次失败
$token = node --input-type=module -e '…SignJWT…' "$env:APPDATA\10router\jwt-secret"
curl.exe -s -o NUL -w "%{http_code}" -H "Cookie: auth_token=$token" http://127.0.0.1:20128/dashboard
```

手工复现同一验证：数据目录下的 `jwt-secret` 文件即签名密钥，`jose` 铸 `{sub:"…"}`
的 HS256 token，`curl -H "Cookie: auth_token=<jwt>"` 打任意 dashboard 路由即可拿到
**真实渲染**（200 = RSC 渲染走通；500 = 看 server.log 的 digest）。

## 5. 教训（浓缩版）

- **验证强度 = 它实际执行到的代码**：health 证明 sidecar 活着，不证明任何一页能渲染；
  测试轮里必须有至少一个「登录态 + 真页面」的断言。
- **hook 依赖数组是即时代码**：组件体内声明顺序即求值顺序，前向引用 = 运行时炸；
  lint/构建/类型检查全都不拦（合法语法）。
- **正向 marker 命中 ≠ 可用**：字符串进了 chunk 只说明代码进包，渲染路径要单独证。
- 压缩产物的 `Cannot access 'x' before initialization` 优先怀疑 **TDZ（声明顺序/循环
  引用）**：先看最近一次改动新增的声明位置，别在产物里找 `x`。
