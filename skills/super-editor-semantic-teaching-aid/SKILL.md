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
8. **批量执行**：先创建账本并逐本 preflight；持有目标书稳定锁后按
   `planned -> preflighted -> authorize-apply -> applied -> saved -> verified` 推进。只有写前重新读取的源、样章、
   规则包和目标写前指纹全部等于 preflight 冻结值，脚本才发放一次性写令牌；漂移立即回到 `planned`。
   跨账本命中同一逻辑工作且目标仍等于上次验证结果时只允许 `verified_skip`；目标漂移或未完成声明一律进入
   `conflict`。未知写入结果仍停在
   `outcome_unknown`，只能回读恢复，不能重试。
   新书在创建前必须同时持久化 `target_book_prospective_identity` 与独立 `lock_key`；二者在固定用户级注册表
   双向唯一。创建接口返回真实书本 ID 后，在原锁下运行 `promote-target`，logical identity 仍保留 prospective
   identity。`saved -> verified` 只接受 provenance 工具根据真实保存回执和导出回读生成的严格 receipt artifact，
   并校验 artifact 文件 SHA-256、canonical hash 和书/目录/运行绑定。

## 规则与执行边界

- 目标和来源用语义角色、可见锚点、阅读顺序、结构邻接和基数共同定位。稳定 sourceId/template 指纹可以
  作辅助锚点，但任何 ID 都不能成为唯一选择条件；运行时 ID 只进证据与来源追溯。
- 样章模板 ID 可以固定；特殊目录模板必须是有优先级的显式变体，用户锁定模板时禁止自动改路由。
- 默认保留样章布局和样式。仅在规则明确要求时复制原课件富文本样式或几何；内容变化后做视觉回流检查。
- 数字模块默认复用已有 `modelId` 关系。要求独立深克隆、多关系或覆盖已有关系而当前原子接口不能证明
  安全时停止。
- 单次微调可直接执行，但只有用户确认的规则变更才能进入专属 Skill。文字、样式、布局以及文本/图片元素
  增删应原位操作，不重建整个区块。微调前后都要确认当前目录恰好有一个完整
  `template_data_content.ai_semantic_provenance` 承载记录；复制承载区块时立即把副本中的该字段置空，删除或
  替换承载区块前先迁移记录。详细规则见 [batch-and-provenance.md](references/batch-and-provenance.md)。
  批量中禁止临场改全局规则。
- 任何书本写入都必须沿用总控技能的授权、checkpoint、保存回读和 `OUTCOME_UNKNOWN` 停止策略。

## 确定性脚本

从本 Skill 目录运行；脚本只校验、编译与记录，不分析课件或组织排版：

```powershell
node scripts/generate-capability-catalog.mjs --plugin-dir <super-editor-control> --out references/super-editor-capability-catalog.json
node scripts/semantic-rule-tools.mjs validate --input <rule-pack.json>
node scripts/semantic-rule-tools.mjs hash --input <rule-pack.json>
node scripts/compile-specialized-skill.mjs --input <rule-pack.json> --output-dir <skills-dir>
node scripts/provenance-tools.mjs create --rule-pack <rule-pack.json> --input <run.json> --out <provenance.json>
node scripts/provenance-tools.mjs validate --input <provenance.json>
node scripts/provenance-tools.mjs validate-readback --input <export-envelope.json> --save-receipt <save-envelope.json> --expected <provenance.json> --carrier-block-id <block-id> --out <readback-receipt.json>
node scripts/provenance-tools.mjs match-source --input <source-candidates.json>
node scripts/provenance-tools.mjs plan-refinement --input <three-way.json>
node scripts/batch-ledger.mjs init --rule-pack <rule-pack.json> --books <books.json> --out <ledger.json>
node scripts/batch-ledger.mjs acquire-lock --lock-key <stable-book-lock-key> --owner <run-id>
node scripts/batch-ledger.mjs promote-target --ledger <ledger.json> --item <item-id> --owner <run-id> --target-book-id <book-id> --evidence <promotion.json>
node scripts/batch-ledger.mjs transition --ledger <ledger.json> --item <item-id> --to planned --owner <run-id>
node scripts/batch-ledger.mjs transition --ledger <ledger.json> --item <item-id> --to preflighted --owner <run-id> --evidence <preflight.json>
node scripts/batch-ledger.mjs authorize-apply --ledger <ledger.json> --item <item-id> --owner <run-id> --fingerprint <fresh-fingerprint.json>
node scripts/batch-ledger.mjs transition --ledger <ledger.json> --item <item-id> --to applied --owner <run-id> --evidence <applied.json>
node scripts/batch-ledger.mjs summary --ledger <ledger.json>
node scripts/batch-ledger.mjs inspect-lock --lock-key <stable-book-lock-key>
node scripts/batch-ledger.mjs release-lock --lock-key <stable-book-lock-key> --owner <run-id>
```

`trial_approved`/`validated` 前必须刷新并绑定真实 `tools/list` capability catalog；`validated` 的 passed
前向案例必须引用规则包目录内可重算的 JSON evidence artifact 链。JSON Schema 只做结构基线，跨文件 SHA、
canonical hash、能力子集和案例绑定以 CLI 校验结果为准。

生产环境锁、prospective identity 和幂等注册表固定在当前用户的受控状态目录；CLI 不支持 `--lock-dir`。
新书创建前生成并持久保存均与 `item_id` 无关的 `target_book_prospective_identity` 和 `lock_key`，创建后继续沿用。
陈旧锁只能先 `inspect-lock`，再凭匹配 nonce、授权人和 owner 已失活证据执行 `transfer-lock` 或
`recover-lock`；本机 owner PID 仍运行时无条件拒绝 recover，不得删除锁文件或抢占活锁。

Windows 下让 Node 直接写 UTF-8 文件，不用 PowerShell 文本重定向处理中文 JSON。
推进 `saved -> verified` 时，transition evidence 必须给出 `provenance_readback_receipt_path` 和该文件原始字节的
`provenance_readback_receipt_sha256`，以及 receipt 对应的 run、provenance、carrier、slide 和来源/目标身份；
不得手写 receipt 或用截图/普通 JSON 摘要代替。

## 交付

分别报告：已冻结的源/样章、已确认规则和变体、试制与前向验证、账本状态、来源追溯、未验证的学生端
交互。不得把结构审计或 Mock 成功当作完整验收，也不得自动发布书本。
