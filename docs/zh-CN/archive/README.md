# 历史与过时文档归档 (Archive)

本目录存放已完成历史使命的发版审查、阶段性调研报告、过时任务状态以及已自愈/已关闭问题的排查记录。保持当前项目主文档目录 `docs/zh-CN/` 聚焦于现行架构、开发手册、排障指南及最新验证标准。

---

## 目录结构

```
docs/zh-CN/archive/
├── README.md                           # 本说明与归档总索引
├── reviews/                            # 历史版本发版前审查与全量审计报告
│   ├── release-review-v1.0.7.md        # v1.0.7 发版审查（23 提交逐笔审计）
│   ├── release-review-v1.1.0.md        # v1.1.0 发版范围评审（65 提交全量审查，原 1.0.9 决策记录）
│   └── release-review-v1.1.1.md        # v1.1.1 发版前审计报告（81 提交全量审读与回归门禁）
├── upstream-triage-v0.5.75.md          # 上游 v0.5.69 → v0.5.75 阶段性分诊决策（已于 v1.1.0 完成合入）
├── open-issues-status.md               # 2026-09-11 阶段性 Issue 快照（#12、#13、#14 现均已修复关闭）
├── zcode-plan-proxy-feasibility.md      # ZCode 订阅渠道接入可行性分析（结论：方案不可行已关闭）
├── catpaw-10router-feasibility.md       # 美团妙手（CatPaw）接入 10Router 可行性报告（调研结项，未实施反代）
├── contributors-cache-residue.md       # GitHub 贡献者页面幽灵数据诊断（已自愈）
└── contributors-cache-residue.en.md    # （英文版）Contributors cache residue diagnosis
```

---

## 归档文档说明

### 1. 历史发版审查（`reviews/`）

- [**v1.0.7 发版审查**](reviews/release-review-v1.0.7.md)：
  v1.0.7 发版前 23 笔提交逐笔审查记录，涵盖安全修复验证、上游 v0.5.69 重实现审计、测试回归门禁及打 tag 与 SignPath 检查单。
- [**v1.1.0 发版范围评审**](reviews/release-review-v1.1.0.md)：
  记录 v1.1.0 的范围与逐项决策（写于 1.0.9 尚在计划时；1.0.9 后作废并入 1.1.0）。
- [**v1.1.1 发版前审计报告**](reviews/release-review-v1.1.1.md)：
  v1.1.1 发版前全部 81 笔提交逐笔审读、全量回归门禁、P1/P2/P3 修复复核及最终发版检查单。
- [**v1.2.0 全量审查报告**](reviews/release-review-v1.2.0.md)：
  v1.1.3 → v1.2.0 共 91 笔提交（347 文件，+17873/−1865）五路并行审读，逐条给出 6 高危 / 8 中危 / 一批低危的修复提交与验证方式；含修复阶段新增的 CDP 无头浏览器探针及其方法论，以及「逐条核实后更正初稿错误结论」的记录。**代码侧已清，尚未发版。**

### 2. 阶段性调研与分诊报告

- [**上游 v0.5.69 → v0.5.75 分诊**](upstream-triage-v0.5.75.md)：
  2026-09-10 对上游 7 个版本的 26 个提交进行逐项内容对照与分类（无需动作 / 已自行解决 / 择优重写），决策结果已在 v1.1.0 中全部落地。
- [**未关闭 Issue 现状汇总**](open-issues-status.md)：
  2026-09-11 针对 open issues 的基线核查。其中 #12（jsonCatalog 500）、#13（小米桌面版专属模型友好提醒）、#14（连接禁用态即时刷新与 ModelRow 可用性）现已全部修复并关闭。
- [**ZCode 订阅渠道接入可行性**](zcode-plan-proxy-feasibility.md)：
  分析将 ZCode 订阅套餐作为 10Router 供应商的可行性。结论为官方风控与加密链路阻断，明确拒绝绕过风控的代理方案，调研已结项关闭。
- [**美团妙手（CatPaw）接入 10Router 可行性**](catpaw-10router-feasibility.md)：
  区分普通 AgentService、NoCode 与账户额度接口；确认客户端 SDK 层回答增量字段，同时记录原始 HTTP 协议与创建请求尚未验证。由于未发现增量签到额度、仅能消费有限的现有余额且反代闭环证据不足，决定不实施 provider / executor。
- [**Contributors 页面残留上游贡献者**](contributors-cache-residue.md)（[English](contributors-cache-residue.en.md)）：
  fork detach 之后 GitHub 侧边栏残留 248 名贡献者的排查记录，结论为等待缓存自愈，无需改动 git 历史。

---

> 如需查阅现行架构与开发运维指南，请返回 [文档导航首页](../../README.md)。
