// Combo 条目软禁用（issue #91 方案 A）：combos 表加 disabledModels 列。
//
// models 列保持纯数组不动（排序位天然保留、所有消费者零改动）；disabledModels
// 是旁挂 JSON 数组，存被手动禁用的 provider/model 字符串。调度层展开时过滤，
// 禁用条目在编辑器里置灰保留位置，活动恢复时一键重新启用。
//
// 幂等：迁移框架按 version 只跑一次，但迁移链测试会直接重放 up()（重启恢复
// 场景），SQLite 没有 ADD COLUMN IF NOT EXISTS——先查列再 ALTER。
export default {
  version: 7,
  name: "combo-disabled-models",
  up(db) {
    const cols = db.all(`PRAGMA table_info(combos)`).map((c) => c.name);
    if (cols.includes("disabledModels")) return;
    db.exec(`ALTER TABLE combos ADD COLUMN disabledModels TEXT`);
  },
};
