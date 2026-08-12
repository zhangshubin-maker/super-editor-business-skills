# Codex + Super Editor 界面型教辅工作流

本工作流把旧 `/simple` 链路拆成两个明确阶段：

1. `lesson-engine` 只负责读取源快照与样章分析规则，给出权威决策骨架并校验生成 v2 map；
2. Codex 按 v2 map 调用 `super-editor-control` 的通用原子工具构造目录、写入来源追溯并逐页保存回读。

旧任务链路可以继续运行。这里不调用旧任务体系，不修改后端接口，也不把书级匹配、特殊目录路由、
历史匹配或三方微调等业务规则放进 `super-editor-control`。业务规则的唯一来源是本 Skill 的
`template-routing.json`、规则 registry、provenance contract 和本工作流。

## 1. 不可越过的边界

- 先完成整批只读 preflight，再进行任何书本、目录、画布或数字模块写入。
- 必须先执行书级模板匹配，再执行目录级特殊路由；只有得到 `resolved_template_id` 后才能调用
  `lesson-engine_analyze_transform_inputs`。不能先按书级 ID 分析，再在编辑阶段临时换样章。
- `template_block_id`、`slot_id`、源 `control_id` 和源区块 id 都是大小写敏感的不透明标识；只能复制工具
  返回值，不能手打、重算或凭相似名称猜测。
- 只接受 `lesson-engine_generate_lesson_map` 校验成功的 v2 map。不得手工拼装最终 map，也不得用旧 v1
  扁平 decisions 处理重复样章区块。
- 所有编辑器写入只调用 `editor_*` MCP 工具。只有没有专用工具时才可评估 `editor_rpc_call`，且不得借此
  绕过持久化或校验规则。
- 目录、大纲和数字模块是立即持久化域，当前页 checkpoint/rollback 无法恢复；`editor_batch` 也不是事务。
- `OUTCOME_UNKNOWN` 时先复读目标状态，禁止直接重放写操作。
- 不自动发布书本。静态结构、截图和保存回读也不能证明媒体可播放或学生端互动可用。

## 2. 工作产物

每次生成至少维护下列只读/中间产物；长任务可把路径和哈希保存在当前 Codex 任务的页清单中：

| 产物 | 权威来源 | 用途 |
|---|---|---|
| rule registry | `build-rule-registry.mjs` | 样章原始 JSON、`_analyse.json`、能力和哈希 |
| route result | `resolve-template-route.mjs` | 书级选择、目录级覆盖和最终模板 ID |
| source snapshot | `editor_export_lesson_source` | lesson-engine 输入和源数字模块 `model_id` |
| compact/detail analysis | lesson-engine MCP | 决策骨架、重复实例计划和按需源事实 |
| v2 map | lesson-engine MCP | 编辑器构造的唯一内容计划 |
| provenance | `provenance-tools.mjs` | 来源、规则、map 和文本/布局 baseline |
| page readback | `editor_save_verified` + `editor_export_slide` | 保存成功和 provenance 完整性证据 |

同一批整书制作使用一个 `run_id`；每个来源目录仍保留独立 source snapshot、route result、map hash 和逐页结果。

## 3. 阶段 A：全批只读 preflight

### 3.1 固定源书上下文

1. 调用 `editor_status`，确认只有预期编辑器页面持有连接租约。
2. 调用 `editor_get_state` 读取当前 `bookId`、目录和 dirty 状态；dirty 时先按用户意图处理，不能在未知改动上
   启动整书转换。
3. 用 `editor_get_book({ bookId })` 核对源书名称、学科、年级、上下册/学期等属性。
4. 用 `editor_list_slides` 或分页 `editor_get_book_manifest(detail=summary)` 建立源目录清单。记录稳定的
   `slideId/catalogId`、完整父级路径、名称和 sort；同名目录不能只按名称去重。
5. 区分可转换普通目录、父级容器和附录。只转换用户要求或业务规则明确纳入的目录。

### 3.2 在离开源书前导出所有源快照

对每个入选普通目录调用：

```text
editor_export_lesson_source({ slideId: "源目录 id" })
```

该工具只读导出当前已连接书本中的目录，不切页、不写库，也不接受跨书 `bookId`。返回：

```json
{
  "sourcePath": "本地绝对路径",
  "sourceSha256": "sha256",
  "meta": {
    "bookId": "源书 id",
    "catalogId": "源目录 id",
    "catalogName": "目录名",
    "catalogSort": 1,
    "blockCount": 1,
    "elementSummaryCount": 1,
    "digitalModuleCount": 1,
    "reusableDigitalModuleCount": 1,
    "incompleteDigitalModuleCount": 0,
    "digitalModuleWarnings": []
  }
}
```

`sourcePath` 中的 JSON 保持 lesson-engine 旧 source schema；每条 `digital_modules[]` 额外含
`name/type/control_id/model_id`，需要时含 `module_name`。必须先完成所有源目录导出并保存路径、哈希和 meta，
之后才允许创建或跳转目标书。目标构建期间不得依赖源书仍是编辑器当前上下文。

以下情况 preflight 失败：

- `meta.bookId/catalogId/catalogName` 与清单不一致；
- 要处理的源目录没有稳定 id；
- source snapshot 缺失、哈希缺失或 lesson-engine 无法读取；
- `incompleteDigitalModuleCount > 0` 且当前 map 会引用对应不完整模块；
- map 需要复制数字模块，但相应源项没有 `control_id` 或 `model_id`。

### 3.3 构建规则 registry

在本 Skill 根目录运行：

```text
node scripts/build-rule-registry.mjs --output <work-dir>/rule-registry.json
```

可按需显式传 `--template-dir` 和 `--routing`。必须使用 `--output` 让 Node 直接写 UTF-8；Windows 下不要用
PowerShell 管道把 stdout JSON 再喂给 Node，避免 BOM 或中文损坏。

registry 构建必须确认每个可路由模板的原始样章与 `_analyse.json` 成对存在且能规范化。后续记录并复用其
`registry_sha256`、`routing_sha256`、`raw_sha256`、`analyse_sha256`、`pair_sha256` 和 `capabilities`。

完成 preflight 后冻结本轮 registry、routing、raw、analyse、pair 哈希及 source snapshot 哈希。每个目录开始
写入前再读一次并与本轮冻结值比较；本轮执行期间有变化就停止。后期微调中，旧 provenance 的历史哈希与本轮
新规则哈希不同是产生 desired 的正常输入，不叫“执行期间漂移”；只有本轮 preflight 之后再次变化才阻断。

### 3.4 先书级、后目录级精确路由

每个源目录单独准备路由输入，并调用：

```text
node scripts/resolve-template-route.mjs \
  --input <work-dir>/route-request.json \
  --registry <work-dir>/rule-registry.json
```

直接读取工具 stdout 返回的 route result；不要通过 PowerShell 文本管道二次转码。也可使用显式 flags：

```text
node scripts/resolve-template-route.mjs \
  --book-name <源书名> \
  --grade-id <年级 id> \
  --subject <学科> \
  --catalog-name <目录名> \
  --registry <work-dir>/rule-registry.json
```

路由顺序不可交换：

1. 按 `template-routing.json` 中书级列表的原始顺序得到 `requested_template_id`；
2. 在其上按目录级规则优先级得到 `resolved_template_id`；
3. 使用 registry 校验最终模板的原始样章、分析文件、能力和哈希。

route result 至少要保留：

```text
selection_source
template_locked
requested_template_id
resolved_template_id
book_match
catalog_route.key / catalog_route.priority
registry.registry_sha256 / routing_sha256
registry.raw_sha256 / analyse_sha256 / pair_sha256 / capabilities
```

特殊目录和特殊情况的模板 ID 只能来自该路由结果，不能在 Codex 提示词或插件里再维护一份条件表。
显式指定模板时分清两种语义：

- `explicit_template_id`：作为显式书级选择，仍允许现有目录级特殊规则覆盖；
- `explicit_template_id + explicit_template_locked=true`，CLI 对应 `--lock-template`，或直接
  `--locked-template-id`：锁定最终模板并跳过所有目录覆盖。

锁定只用于用户明确要求某个模板不再被特殊目录规则改变的场景。普通手动选样章不能被擅自升级为锁定。
书级未命中、目录规则冲突、最终模板不在 registry 或哈希/能力缺失时停止该目录，不猜模板 ID。

### 3.5 lesson-engine：compact 优先，detail 按需

必须使用 route result 的 `resolved_template_id`：

```json
{
  "sourcePath": "<editor_export_lesson_source 返回的 sourcePath>",
  "analysePath": "模版/<resolved_template_id>_analyse.json",
  "viewMode": "compact",
  "maxTextLen": 120,
  "maxTextSamples": 24
}
```

调用 `lesson-engine_analyze_transform_inputs` 后：

- `reference.blocks[]`、`decision_template` 和 `occurrence_plan[].candidates[].decision_item` 是 block/slot ID
  的唯一权威来源；
- `source.outline_sections[]` 是真实一级大纲，`unoutlined_sections[]` 不得计入大纲序号；
- `expected_occurrences` 为数字时，其数量、顺序和 `section_key` 绑定是服务端结论，不得重算；
- 图片只能取对应 section 的 `images[].url`；`image_urls_included=false` 时不得猜 URL；
- 跳转目标必须取 compact/detail 给出的真实源 block id，不能把所有跳转退化为 section 首区块；
- `description`、`match_rule` 和 delete 条件是取值与显隐的唯一业务语义。

仅当 compact 无法证明某个结构选择、description、match 或 delete 条件时，汇总所有缺口后批量请求一次 detail：

```json
{
  "sourcePath": "<同一 sourcePath>",
  "analysePath": "模版/<同一 resolved_template_id>_analyse.json",
  "viewMode": "detail",
  "sectionRequests": [
    { "sectionKey": "<section_key>", "blockPositions": [2] }
  ],
  "maxTextLen": 1000
}
```

需要完整单条文本且 `text_truncated=true` 时，可对相应区块把 `maxTextLen` 提高到最多 8000 并重试一次。
compact/detail 整体输出被截断时缩小请求最多重试一次；仍截断则停止，禁止读取 MCP 截断落盘文件作为回退。

### 3.6 生成 v2 decisions 和 map

1. 从 `decision_template` 开始，先冻结普通区块与 repeat occurrence 的数量、顺序、候选和 section 绑定。
2. 每个 occurrence 的候选按 `occurrence_plan` 原顺序处理；选择候选时整项复制 `decision_item`。
3. 只填写确实取得新值的 slot；空值、空数组和未命中项直接省略，表示保留样章原状。
4. 最终 decisions 只保留：

```json
{
  "schema_version": 2,
  "blocks": [
    {
      "template_block_id": 123,
      "text_slots": [{ "slot_id": "opaque", "value": "纯文本" }],
      "image_slots": [{ "slot_id": "opaque", "url": "https://..." }],
      "button_slots": [{ "slot_id": "opaque", "control_ids": ["source-control-id"] }],
      "jump_slots": [{ "slot_id": "opaque", "catalog_id": 123 }],
      "delete_slots": ["opaque"]
    }
  ]
}
```

5. 调用 `lesson-engine_generate_lesson_map`，传入完全相同的 `sourcePath`、`analysePath` 和完整 decisions。
6. 校验失败时，只能根据错误从权威骨架重新整项复制并重试一次。成功结果逐字保留为该目录 v2 map，
   同时计算 canonical map hash；不能重新排序或用 JSON 再解释出另一套结构。

### 3.7 写入前可执行性门禁

在任何目标书写入前，输出目录级清单并确认：

- 源书/目录 id、名称、sort 和 source SHA-256；
- requested/resolved 模板 ID、特殊路由 key、锁定状态和全部规则哈希；
- map 区块数、重复实例数和五类 slot 数量；
- 每个 `template_block_id` 与 slot ID 都存在于对应原始样章；
- 每个 button `control_id` 都能在该目录 source snapshot 中唯一找到非空 `model_id`；
- 每个 jump `catalog_id` 都是该 snapshot 中的真实源区块 id；
- 目标书和目标目录是新建还是匹配已有内容，以及可能发生的立即持久化写入。

一个 `button_slot` 当前只能落到一个数字模块关系。如果 `control_ids` 多于一个，或同一未删除目标同时需要
button 模块与 jump 模块，当前原子工具无法无损表达旧批量关系：停止该目录并报告能力缺口，不能静默选第一个、
拆成猜测元素或覆盖已有模块。

## 4. 阶段 B：创建或进入目标书

### 4.1 新书

1. `editor_create_book({ sourceBookId, copyMode: "light", name, smartBookType: 4, ... })`。
2. 记录返回的目标 `bookId`；创建是立即持久化操作。
3. `editor_jump_to_book({ bookId, target: "current", saveBeforeSwitch: true })`。
4. 用 `editor_get_state` 和 `editor_get_book` 回读，确认目标书 ID、书名和界面交互型属性。

不要用 `copyMode=full` 代替界面型目录构造，除非用户明确要求先做完整副本。

### 4.2 已有目标书

用 `editor_search_books` 按名称、学科、年级、上下册/学期缩小候选，再用 `editor_get_book` 核对真实 ID。
多候选无法唯一确定时停止；不得仅凭相似书名跳转。切书后再次读取 state 确认上下文。

## 5. 阶段 C：按 map 逐目录构造

严格按源目录父子关系和 sort 从前到后执行。维护 `sourceCatalogId -> targetSlideId` 清单；父目录必须先创建，
子目录只能使用已回读确认的目标 `parentId`。

### 5.1 新建样章目录

```text
editor_apply_template({
  kind: "chapter",
  templateId: resolved_template_id,
  name: "源目录原名",
  parentId: "已确认的目标父目录 id",
  saveBeforeSwitch: true
})
```

`kind=chapter` 会立即新增、选中目录并写库，checkpoint 不能删除它。工具返回后立即用
`editor_get_state`、`editor_list_blocks` 和 `editor_export_slide` 核对新 `slideId`、目录名、样章区块和元素来源。
按源 sort 顺序创建通常即可保持顺序；确需修正时才调用 `editor_move_slide`，并在调用后回读目录清单。

改造已有目录时不得再应用 `kind=chapter`；应先执行历史匹配或使用 `kind=block` 插入缺失区块。

### 5.2 将样章区块调和为 map 的实例序列

`map.blocks[]` 的数组顺序就是最终区块顺序；相同 `template_block_id` 是多个独立实例。以
`editor_export_slide` 返回区块的 `template_id` 建立实例池：

1. 按 map 顺序为每一项消费一个尚未使用、`template_id == template_block_id` 的现有样章区块；
2. 同一模板需要更多实例时，对已确认的基准实例调用 `editor_clone_block`；
3. 样章中缺少基准实例时，调用
   `editor_apply_template({ kind: "block", templateId: template_block_id, ... })`；
4. map 未选择的样章实例用 `editor_delete_block` 删除；先完成所需 clone/apply，再删除唯一基准；
5. 用 `editor_move_block({ blockId, toIndex })` 逐项校正顺序；
6. 再次 `editor_export_slide`，固化 `map block index -> runtime blockId -> template_block_id` 对照。

结构调和属于中高风险当前页写入，开始前创建一次 `editor_checkpoint`。该 checkpoint 只能保护当前页工作副本，
不能回退已新建目录。

### 5.3 在每个实例内解析 slot 目标

重复实例会共享同一组样章 `slot_id`，因此必须在各自 runtime block 内单独解析，不能建立跨页或跨实例的
全局 `slot_id -> elementId` 映射。

优先规则：

- 普通元素/群组：runtime 元素的 `sourceId == slot_id`，得到真实 `elementId`；
- 表格单元格：先在原始样章区块中由 `slot_id` 定位表格源元素与 row/col，再在 runtime 区块中由表格
  `sourceId` 定位真实 tableId，生成 `{kind:"tableCell", tableId, row, col}`；
- 思维导图节点：先在原始样章中定位所属 mind 元素和节点，再用 runtime mind 元素的 `sourceId` 与真实 nodeId
  生成 `{kind:"mindNode", mindId, nodeId}`；
- 找不到、出现多个候选或结构路径已经漂移时，停止该目录。不得按元素名称或出现顺序猜写。

执行 delete 后必须重新 export 或读取 canvas tree 重建该实例索引。被删除父元素内的后续 slot 视为随父元素
有意删除并跳过；其他未命中仍是错误。

### 5.4 槽位执行顺序

对 map 中每个实例依次执行以下顺序。

#### A. delete_slots

先把每个样章 `slot_id` 解析成 runtime elementId，再调用：

```text
editor_delete_element({ elementId: "runtime id" })
```

删除前读取目标，确认它仍属于当前 block。删除群组意味着其全部子元素一起删除。完成后重新建立实例内索引，
避免后续文本、图片或模块写到已删除节点。

#### B. text_slots

对普通文本、表格单元格或思维导图节点：

1. `editor_text_document` 读取目标和最新 `contentHash`；
2. map value 是纯文本，先用 `editor_text_set_content(..., dryRun:true)` 预览；
3. 再带同一 `expectedContentHash` 正式调用，默认 `fitSize:true`；
4. 复读文本；若 `settled=false`、`deferredLayout=true` 或溢出，按文本技能完成适配和外层截图检查。

禁止用 `editor_update_element.patch.content`。同一个 slot 同时承担 text/jump/delete 职责时分别处理；delete
已经命中则不再执行其余职责。

#### C. image_slots

确认 runtime 目标类型为 image，再调用：

```text
editor_set_image_src({ elementId: "runtime id", url: "map 中的源图片 URL" })
```

复读 `src` 并检查图片比例、裁切和加载。URL 必须逐字来自已校验 map；不重新搜索“相似图片”。

#### D. 首次画布保存

所有区块结构、delete、文本和图片稳定后，先运行相关 current audit/check，再调用：

```text
editor_save_verified({
  scope: "current",
  expectedSlideId: "目标目录 id",
  verify: true
})
```

新 clone/apply 的区块需要先保存取得后端区块 id，之后才能安全建立数字模块关系。

#### E. button_slots

1. 用 map 的 `control_id` 在该目录的 source snapshot `digital_modules[]` 中唯一找到 `model_id`；
2. 确认 runtime 目标没有已有数字模块；
3. 调用：

```text
editor_copy_digital_module({
  modelId: "源快照中的 model_id",
  targetElementId: "runtime elementId"
})
```

该操作立即写库，并让源和目标关系共享同一 `model_id`，不是独立深克隆。缺 `model_id`、多候选、目标已有模块、
一个 slot 多个 control ID 时停止该 slot/目录，不猜配置、不静默覆盖，也不执行“delete 后 copy”伪原子流程。

#### F. jump_slots

跳转到源课件区块使用定位数字模块。先读取实时 type 80 Schema，再 validate-only：

```text
editor_create_digital_module({
  elementId: "runtime elementId",
  type: 80,
  name: "定位到源课件区块",
  config: {
    catalogId: "源目录 id",
    resourceId: "map jump_slots.catalog_id",
    targetType: "block"
  },
  validateOnly: true
})
```

这里的 `catalogId` 与 `resourceId` 是被定位的**源课件目录和源区块**；数字模块关系自身所属的目标书/目标目录
由 Bridge 根据 runtime element 自动填写。不能把当前目标目录 id 填入 config。校验后去掉 `validateOnly`
正式创建，再用 `editor_get_digital_module` 核对类型、目标资源和 modelId。
创建与回读均是立即持久化域；当前页 rollback 无法撤销。目标已有 button 模块或其他模块时不得覆盖。

### 5.5 写 provenance 并最终保存回读

provenance 的结构、哈希算法和三方 baseline 以 [provenance-contract.md](provenance-contract.md) 为准。
每个 runtime block 单独记录 `sample_block_id=template_block_id`，同一目录共享 source、route、map hash 和 run ID。

准备 spec 文件后运行：

```text
node scripts/provenance-tools.mjs create \
  --input <work-dir>/provenance-spec.json \
  --block-id <runtime-block-id> \
  --out <work-dir>/provenance-result.json
```

至少记录：

- `mode=generated`、`run_id`；
- 源书/目录 id、名称、sort；
- requested/resolved template ID 和当前区块 sample block ID；
- rule/template/map hash；同时把 `editor_export_lesson_source.sourceSha256` 写入 `artifacts.source_hash`，并可保留 routing、registry 与 pair hash；
- 当前生成结果的文本与布局 baseline hashes。

按脚本输出调用：

```text
editor_update_block({
  blockId: "runtime blockId",
  patch: { "ai_provenance": { "...": "完整对象" } }
})
```

`patch` 直接合并到 `template_data_content`；传对象，不手工序列化整个区块，也不新增后端字段。完成后：

1. 当前页 dirty 时再次 `editor_save_verified(scope=current, expectedSlideId, verify=true)`；
2. `editor_export_slide({ slideId })` 回读完整区块 JSON；
3. 校验来源：

```text
node scripts/provenance-tools.mjs validate \
  --input <work-dir>/exported-slide.json \
  --out <work-dir>/provenance-validation.json
```

4. 对 button/jump 目标逐个 `editor_get_digital_module` 回读；
5. 检查受影响区块截图；跨区块流向变化时追加 full-page 截图。

区块 clone 通常会随 JSON 保留 provenance；replace/import/重新实例化模板时必须显式继承或重建，然后再次
export + validate，不能仅凭“复制成功”推定追溯信息还在。

### 5.6 逐页完成再切页

只有当前目录同时满足下列条件才记为完成：

- v2 map 的区块数量、顺序和重复实例逐项一致；
- 所有未删除 slot 均命中唯一 runtime 目标并已复读；
- 数字模块逐项即时写入并回读；
- provenance 全部写入且 validate 成功；
- `editor_save_verified(scope=current)` 成功，页面不再 dirty；
- 相关 current audit 无未处理 error。

然后才用 `editor_select_slide({ slideId, saveBeforeSwitch:true })` 或创建下一目录。不能用
`editor_save_verified(scope=book)` 代替逐页保存。

## 6. 历史成品的无来源匹配与回填

历史匹配阶段只读，不能在“看起来像”时直接写 provenance。

### 6.1 匹配顺序

1. **书本**：优先精确书名，再联合学科、年级、上下册/学期；候选不唯一则停止。
2. **目录**：优先完整父级路径，其次精确目录名 + sort/序号；同名同序仍多候选则停止。
3. **实际样章**：先看区块原有 `template_id` 是否命中某个样章 child block ID。
4. **元素证据**：比较区块内 `sourceId` 集合与样章元素 ID，不用可变 runtime elementId。
5. **结构指纹**：最后才比较区块数、元素类型树、顺序和布局；只作为补强证据，不独立证明来源。

同时对匹配到的源目录运行当前路由器，作为“现行规则应使用什么模板”的证据；它不能冒充历史生成时实际
使用的 requested ID 或规则版本。

### 6.2 置信度和回填

把目标和候选的书本属性、目录路径/顺序、block template ID、sourceId 集合和结构指纹交给：

```text
node scripts/provenance-tools.mjs match-legacy \
  --input <work-dir>/legacy-candidates.json \
  --out <work-dir>/legacy-match-result.json
```

固定权重、硬拒条件、confidence 阈值和唯一性规则以 provenance contract 与脚本输出为准；Codex 不手工宣布
“高置信”。把选中候选输出的 evidence 原样写入 `inference.evidence`。无论候选是否唯一、是否 high，都只先
展示候选清单；必须取得用户对具体 source book/catalog 的确认后才能回填。

历史 provenance 使用 `mode=legacy_inferred`：

- `requested_template_id` 无直接证据时为 `null`；
- `resolved_template_id/sample_block_id` 只写实际结构证据支持的值；
- 不伪造历史 map hash、历史生成 run ID、规则版本或生成时 baseline；本次 `run_id` 只表示回填审计批次；
- 当前内容作为从回填时点开始追踪的 baseline 起点；
- 明确保留 inference confidence 和 evidence。

调用 `provenance-tools.mjs create` 生成标准对象，经
`editor_update_block({patch:{ai_provenance}})` 写入，逐页 save、export、validate。回填属于写入操作，开始前仍要
报告匹配结果与置信度。

## 7. 后期文本与布局微调：三方比较

微调不是重新覆盖整页。三方分别是：

- `baseline`：上次生成/确认后写进 provenance 的精简文本/布局快照及 hash；
- `current`：当前成品书实际文本和布局；
- `desired`：本次依据新源课件和参考样章计算出的目标文本与布局。

先只读导出当前页，并准备 current/desired request：

```text
node scripts/provenance-tools.mjs plan-update \
  --input <work-dir>/update-request.json \
  --block-id <runtime-block-id> \
  --out <work-dir>/update-plan.json
```

脚本分别对 text/layout 分类：

| 条件 | 结果 |
|---|---|
| `current == desired` | noop，目标已经实现 |
| `desired == baseline` | noop，本次来源/样章未要求变化，保留当前人工修改 |
| `current == baseline` 且 `desired != baseline` | safe，可自动应用 |
| 其他情况 | conflict，存在人工修改与新目标竞争 |

只自动执行 `safe_changes`：

- 文本用 `editor_text_document` + expectedContentHash + `editor_text_edit` 或
  `editor_text_set_content`，写后复读；
- 布局用 typed move/resize/align/distribute、文本适配和区块尺寸工具，写后检查 canvas tree 与截图；
- 一个明确文本小改不重建整个样章区块；布局小改不顺带改教学文案。

`conflicts` 默认不写。向用户展示当前值、baseline、desired、受影响元素与视觉后果；用户选择保留 current、
采用 desired 或手工合并后，才写入并把已确认结果更新为新的 baseline。若旧记录只有 baseline hash 而没有快照，
计划必须明确标为 baseline 值不可展示，不能伪造原值；必要时从现有持久版本读取或请用户决定。

当一次微调只有部分 safe 应用、仍有 conflict 时，`artifacts` 继续表示该区块最初或最近一次完整应用的
source/rule/template/map，不得替换成尚未完整落地的 desired map。另写 `refinement`，记录本轮 desired 的
source/rule/template/map hash、已应用 text/layout 目标、冲突目标和回读后的 current state hash。只有所有目标
完成、没有遗留冲突且 save/export 回读证明当前区块完整对应新 map 时，才把这些目标哈希提升到 `artifacts` 并
结束该 refinement。每页微调仍需 current save、export 和 provenance validate。参考样章只提供目标设计依据，
不能覆盖用户已明确保留的个性化修改。

## 8. 故障恢复与 OUTCOME_UNKNOWN

### 8.1 普通失败

- lesson-engine 返回 `isError`：除 v2 权威骨架整项复制后的单次校验重试外立即停止该目录。
- slot 找不到唯一 runtime 目标：停止当前目录，不按名称猜写。
- 保存 hash/expectedSlideId 不一致：停止后续页面，重新读取现状。
- 页面工作副本失败且 checkpoint 仍有效：可以 rollback 当前页；之后复读确认。目录/模块不会随之恢复。

### 8.2 OUTCOME_UNKNOWN

任何写工具返回 `OUTCOME_UNKNOWN`、连接中断或超时且无法判断结果时：

1. 不重放原调用；
2. 用 `editor_status`、`editor_get_state` 确认仍连接同一书本/目录；
3. 画布/区块/文本/图片用 `editor_export_slide` 或专用 get 工具复读；
4. 目录新增、重命名、移动用 `editor_list_slides`/manifest 复读；
5. 数字模块用 `editor_get_digital_module` 复读；
6. provenance 用 export + `provenance-tools.mjs validate` 复读；
7. 只有读回明确证明原写未发生，且重试仍符合幂等条件时才执行一次；无法证明则停止并报告未知状态。

长整书任务从最后一个“逐页保存 + export + provenance validate”完成点继续，不声称存在服务端 authoring job、
事务或自动 resume token。

### 8.3 立即持久化风险表

| 操作 | 持久化 | 回滚方式 |
|---|---|---|
| apply chapter、新增/移动/重命名/删除目录 | 立即写库 | checkpoint 无效；只可用明确的反向目录操作 |
| 大纲增删改、关联、锚点 | 立即写库 | checkpoint 无效；写前保留旧状态 |
| 数字模块 create/update/delete/copy | 立即写库 | checkpoint 无效；逐项回读，不把 delete+copy 当事务 |
| 区块、元素、文本、图片、provenance | 当前页工作副本 | checkpoint 可保护当前会话当前页；仍需 save_verified |
| 图片/媒体上传 | 产生独立资源 | 页面 rollback 不删除资源 |

## 9. 交付报告

完成后分别报告：

- 已处理/跳过/失败目录，requested/resolved 模板 ID 和特殊路由 key；
- 每页 map 区块与五类 slot 的应用数量；
- source、routing、rule、template、pair、map 和 provenance 校验哈希；
- 每页 `editor_save_verified` 与数字模块回读结果；
- 历史推断的 confidence/evidence，或三方微调的 safe/conflict 结果；
- 已知 `OUTCOME_UNKNOWN`、立即持久化残留和人工恢复步骤；
- 尚未验证的学生端媒体播放、跳转、互动效果和重要页面人工视觉验收。

不要把 Mock、静态 audit、单页截图或 `scope=book` 摘要成功表述为整书交付验收完成。
