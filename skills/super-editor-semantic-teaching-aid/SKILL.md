---
name: super-editor-semantic-teaching-aid
description: 通过 Codex 对话和 super-editor-control 原子能力，以完整原课件与指定样章为依据试制界面型教辅、学习自然语言转换规则、按用户反馈迭代、导出“书类 + 样章”专属 Skill，并在前向验证后按书单批量生成。用户要求摆脱固定插槽、`_analyse.json` 或 lesson-engine，以语义方式控制文本、图片、数字模块、区块选择/复用/删除、布局和大纲时使用；本 Skill 不依赖旧 OpenCode 或固定插槽链路。
---

# Super Editor Semantic Teaching Aid

把用户的示范与纠正编译成可审计的语义规则包。让 Codex 负责理解和决策，让
`super-editor-control` 只负责完整读取、原子写入、保存回读和验收。不要调用旧任务体系或任何固定插槽
分析服务。

## 加载依赖

先加载 `super-editor-control` 总控技能及任务策略。按当前阶段最小化加载其 `state`、`books`、`assets`、
`blocks`、`text`、`elements`、`digital-modules`、`layout`、`outline`、`canvas`、`quality` 子技能。

首次教授、试制或修改规则前完整阅读 [workflow.md](references/workflow.md) 和
[rule-pack.md](references/rule-pack.md)。进入批量或写来源追溯时再读
[batch-and-provenance.md](references/batch-and-provenance.md)。

## 执行主流程

1. **冻结来源**：连接原课件，在切书前读取本轮所需目录的完整区块、元素、富文本、几何、数字模块、
   大纲与书本元数据，计算快照哈希。信息不完整时停止；不要退回旧的简化提取。
2. **理解样章**：读取用户指定的默认样章及特殊目录样章。区分样章视觉角色与来源教学角色，不把运行时
   元素 ID 编成规则。
3. **教授规则**：把用户自然语言整理为语义规则草案，只结构化作用域、基数、动作、样式/模块策略、
   缺失与歧义策略和验收。写书前向用户报告匹配依据、歧义和预计写入范围。
4. **试制**：经用户明确授权后创建或进入试制书，一次只完成一个代表性目录。建立 checkpoint，执行原子
   写入，保存回读、审计并截图；数字模块还要核对真实关系。
5. **学习反馈**：把每条纠正归为 `instance_fix`、`rule_refinement`、`new_variant` 或
   `acceptance_refinement`。先修试制结果，再询问是否提升为通用规则；不把一次特例悄悄泛化。
6. **导出专属 Skill**：规则经用户确认后，运行校验和编译脚本。专属 Skill 保存语义规则、样章路由、
   正反例与验收，不保存固定插槽。
7. **前向验证**：至少用两个结构不同的同类目录/书验证。修正后提升规则包状态为 `validated`，再批量运行。
8. **批量执行**：先创建账本并逐本 preflight；按 `planned -> preflighted -> applied -> saved -> verified`
   推进。歧义、冲突或未知结果立即停在对应状态，不猜测重试。

## 规则与执行边界

- 目标和来源用语义角色、可见锚点、阅读顺序、结构邻接和基数共同定位。稳定 sourceId/template 指纹可以
  作辅助锚点，但任何 ID 都不能成为唯一选择条件；运行时 ID 只进证据与来源追溯。
- 样章模板 ID 可以固定；特殊目录模板必须是有优先级的显式变体，用户锁定模板时禁止自动改路由。
- 默认保留样章布局和样式。仅在规则明确要求时复制原课件富文本样式或几何；内容变化后做视觉回流检查。
- 数字模块默认复用已有 `modelId` 关系。要求独立深克隆、多关系或覆盖已有关系而当前原子接口不能证明
  安全时停止。
- 单次微调可直接执行，但只有用户确认的规则变更才能进入专属 Skill。批量中禁止临场改全局规则。
- 任何书本写入都必须沿用总控技能的授权、checkpoint、保存回读和 `OUTCOME_UNKNOWN` 停止策略。

## 确定性脚本

从本 Skill 目录运行；脚本只校验、编译与记录，不分析课件或组织排版：

```powershell
node scripts/semantic-rule-tools.mjs validate --input <rule-pack.json>
node scripts/semantic-rule-tools.mjs hash --input <rule-pack.json>
node scripts/compile-specialized-skill.mjs --input <rule-pack.json> --output-dir <skills-dir>
node scripts/provenance-tools.mjs create --rule-pack <rule-pack.json> --input <run.json> --out <provenance.json>
node scripts/provenance-tools.mjs validate --input <provenance.json>
node scripts/provenance-tools.mjs match-source --input <source-candidates.json>
node scripts/provenance-tools.mjs plan-refinement --input <three-way.json>
node scripts/batch-ledger.mjs init --rule-pack <rule-pack.json> --books <books.json> --out <ledger.json>
node scripts/batch-ledger.mjs acquire-lock --lock-dir <lock-dir> --target-book <book-id-or-lock-key> --owner <run-id>
node scripts/batch-ledger.mjs transition --ledger <ledger.json> --item <item-id> --to planned --lock-dir <lock-dir> --owner <run-id>
node scripts/batch-ledger.mjs summary --ledger <ledger.json>
node scripts/batch-ledger.mjs release-lock --lock-dir <lock-dir> --target-book <book-id-or-lock-key> --owner <run-id>
```

Windows 下让 Node 直接写 UTF-8 文件，不用 PowerShell 文本重定向处理中文 JSON。

## 交付

分别报告：已冻结的源/样章、已确认规则和变体、试制与前向验证、账本状态、来源追溯、未验证的学生端
交互。不得把结构审计或 Mock 成功当作完整验收，也不得自动发布书本。
