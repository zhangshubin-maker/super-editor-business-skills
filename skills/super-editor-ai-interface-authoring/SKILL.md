---
name: super-editor-ai-interface-authoring
description: 通过 Codex、lesson-engine 和 super-editor-control 生成、追溯及微调界面型 AI 教辅。用户要求从原课件和参考样章新建整本界面教辅、复用旧 `_analyse.json` 插槽规则与特殊模板路由、为历史成品匹配并回填来源，或依据原课件和样章对已生成教辅做文本/布局三方微调时使用；不依赖旧任务体系，也不替代或删除旧 OpenCode 链路。
---

# Super Editor AI Interface Authoring

在 `super-editor-control` 原子能力之上编排新的 Codex 对话链路。让 Codex 负责语义决策和整书调度，让
`lesson-engine` 继续提供权威插槽 ID、重复区块计划与 v2 map 校验。保留旧任务/OpenCode 链路并行运行。

## 加载依赖

开始前加载 `super-editor-control` 总控技能及其任务策略。按工作范围继续加载：

- 新建或扩充整书：`super-editor-book-authoring`、`super-editor-books`、`super-editor-state`、
  `super-editor-assets`、`super-editor-blocks`、`super-editor-canvas`、`super-editor-quality`；
- 写插槽：`super-editor-text`、`super-editor-elements`、`super-editor-layout`、
  `super-editor-digital-modules`；
- 涉及大纲时再加载 `super-editor-outline`。

确认 `lesson-engine` MCP 可用。缺少任一写入依赖时只完成只读 preflight，不用旧任务接口或任意 RPC 猜写。

## 选择工作模式

### 新生成或续做

完整阅读 [editor-workflow.md](references/editor-workflow.md) 和
[provenance-contract.md](references/provenance-contract.md)，然后严格执行其中阶段 A 到阶段 C：

1. 在源书上下文中一次性导出全部入选目录；源当前页 dirty 时先保存回读或停止。
2. 构建规则 registry，先做书级匹配，再做目录级特殊路由。
3. 只用最终 `resolved_template_id` 调用 lesson-engine compact/detail，生成并校验 v2 map。
4. 在任何目标书写入前报告源目录、模板、哈希、插槽、数字模块和幂等预检结果。
5. 得到用户已有授权后，创建/进入目标书，逐页调和样章区块并应用 map。
6. 每个区块写 `template_data_content.ai_provenance`，逐页保存、导出、验证后才进入下一页。

不把“用户说开始实现本 Skill 的代码”视为“授权修改某本线上书”。只有用户明确指定实际源书/目标书并要求
执行生成时，才进行书本写入。

### 历史成品来源回填

阅读上述两份参考，按“书名 + 学科 + 年级 + 册次”匹配源书，按完整目录路径或“目录名 + sort”匹配源目录，
再用区块样章 ID、元素 `sourceId` 集合和结构指纹交叉验证。先用确定性 legacy matcher 输出候选、分数、证据和
置信度；即使只有一个高置信候选，也必须经用户确认后才写 `mode=legacy_inferred`。未知历史哈希保持 `null`，
本次 `run_id` 只代表回填批次。

### 后期文本或布局微调

阅读 [provenance-contract.md](references/provenance-contract.md) 的三方协议。分别准备：

- baseline：上次确认后写入 provenance 的精简快照及 hash；
- current：当前成品的真实回读；
- desired：依据当前原课件、参考样章与规则生成的新目标。

用 `provenance-tools.mjs plan-update` 分类文本和布局。只自动执行 `safe_changes`；`conflict` 必须保留当前值并
向用户展示三方差异。一个文本小改不重建区块，一个布局小改不顺带改文案。部分应用时保留原始 artifacts，
另写 refinement 的目标哈希、已应用项和冲突项；只有完整应用且回读无冲突时才提升为新的完整 artifacts。
写后更新已确认目标的 baseline，保存、导出并重新验证 provenance。

## 复用既有规则

运行时不要复制或改写 822 条 description。`模版/<id>_analyse.json` 继续是每个样章的权威插槽规则，
`template-routing.json` 只保存可审计的书级与特殊目录路由，动态 registry 保存哈希与能力索引。

需要新增、修正规则或解释迁移边界时，阅读 [rule-governance.md](references/rule-governance.md)。必须使用
`lesson-engine_extract_template_analyse -> 精确补写 -> lesson-engine_save_template_analyse`，不能手写或复用
其他模板的元素 ID。

## 确定性脚本

从本 Skill 目录运行：

```powershell
node scripts/build-rule-registry.mjs --output <work-dir>\rule-registry.json
node scripts/resolve-template-route.mjs --input <route-request.json> --registry <work-dir>\rule-registry.json
node scripts/provenance-tools.mjs create --input <spec.json> --block-id <blockId>
node scripts/provenance-tools.mjs validate --input <exported-slide.json>
node scripts/provenance-tools.mjs match-legacy --input <candidates.json>
node scripts/provenance-tools.mjs plan-update --input <request.json> --block-id <blockId>
```

脚本只生成/校验计划和来源对象，不直接写书。Windows 下让脚本直接写 UTF-8 文件；不要用 PowerShell 文本
管道重定向含中文的 JSON。

## 停止条件

遇到以下任一情况停止当前目录并保留已完成页清单：

- 模板未命中、路由目标不在 registry，或同一轮 preflight 冻结后规则/样章 hash 又发生变化；微调时旧
  provenance 与本轮新规则的预期版本差异不属于这一类漂移；
- compact/detail 截断后按精确范围重试一次仍失败；
- slot 不能在当前 runtime 区块内由 `sourceId` 唯一定位；
- button 所需 `control_id/model_id` 不完整或不唯一；
- 同一目标需要多个数字模块关系，当前单关系接口无法表达；
- 写操作返回 `OUTCOME_UNKNOWN` 且回读无法证明是否已执行；
- provenance、保存回读或当前页审计失败。

不要发布书本。交付时分别报告已验证结构、保存与追溯结果，以及尚未验证的学生端跳转、媒体和互动效果。
