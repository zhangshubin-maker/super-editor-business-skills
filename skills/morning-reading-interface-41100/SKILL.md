---
name: morning-reading-interface-41100
description: "使用 super-editor-control 按已确认的语义规则制作“小学英语晨读美文”界面型教辅。用户要求从完整原课件生成或微调这类书、使用默认样章 41100 或其特殊目录变体、复制文本/图片/数字模块、复用或删除区块、调整布局与大纲，或按已验证规则批量处理书单时使用；以语义理解和原子编辑能力执行。"
---

<!-- managed-by: super-editor-semantic-teaching-aid -->

# 晨读美文界面型教辅（41100）

按版本 0.3.0 的已确认语义规则执行。完整读取
[rule-pack.json](references/rule-pack.json)、[workflow.md](references/workflow.md) 和
[batch-and-provenance.md](references/batch-and-provenance.md)，不得把其中的自然语言意图改写为固定插槽。

## 执行

1. 加载 `super-editor-control` 总控技能及当前任务需要的最小子技能。
2. 核对来源是否符合 `applicability`，并在切书前冻结完整源目录快照。
3. 默认选样章 `41100`；每页从干净基页独立测量，禁止复制上一页已经扩容的几何。仅当一个最高优先级
   `templates.variants.when` 语义命中时使用该变体。
4. 按 `order` 执行 5 条规则。用语义角色、基数、结构与锚点共同匹配；sourceId/template
   指纹只能辅助，不得用任意 ID 单独决定目标。
5. 写前报告匹配证据和歧义，获用户授权后建立 checkpoint，并只调用插件原子能力写入。
6. 遵守每条规则的 `on_missing`、`on_ambiguous` 和验收。未知动作按其 `intent`、
   `required_capabilities` 与 `validate` 组合执行，不把动作类型当封闭枚举。
7. 保存回读、审计和截图后，在稳定区块 JSON 的 `ai_semantic_provenance` 写入 Skill/版本、规则 ID、
   严格 source/target identity 绑定、可复算证据哈希及源/样章/结果哈希；保留未知区块字段。非 legacy
   运行的 source bindings、target bindings、evidence 均不得为空。写入 provenance 会再次改变页面，所以必须
   真实调用 `editor_save_verified(scope=current)`、`editor_export_slide`，保存两个完整 MCP envelope，再用
   `validate-readback` 校验 saved/verified、slide identity、编辑器 FNV 页哈希，以及明确 `uuid` 承载区块
   `template_data_content.ai_semantic_provenance` 中的 run ID 和完整性哈希；未生成 canonical readback receipt
   artifact 时不得把目录标为 verified。测试 fixture 不代表浏览器真实调用，不能替代运行时回执。

使用本 Skill 自带的脚本生成来源和账本：

```powershell
node scripts/provenance-tools.mjs create --rule-pack references/rule-pack.json --input <run.json> --out <provenance.json>
node scripts/provenance-tools.mjs validate-readback --input <editor-export-slide-envelope.json> --save-receipt <editor-save-verified-envelope.json> --expected <provenance.json> --carrier-block-id <uuid> --out <readback-receipt.json>
node scripts/batch-ledger.mjs init --rule-pack references/rule-pack.json --books <books.json> --out <ledger.json>
```

## 变更与批量

- 本 Skill 含 0 个特殊样章变体。未命中、并列命中或出现新目录模式时停止并回到母 Skill
  `super-editor-semantic-teaching-aid` 教授新版本。
- 用户对单个结果的纠正默认视为本书特例；只有明确确认后才可修改规则包并重新编译。
- 只有规则包状态为 `validated` 才批量运行；逐本使用账本、目标书锁和幂等检查。
- `OUTCOME_UNKNOWN`、数字模块深克隆能力不足或多关系无法表达时停止，依靠真实回读恢复。

交付时分别报告已验证内容、来源追溯、账本状态和未实测学生端交互。不得自动发布书本。
