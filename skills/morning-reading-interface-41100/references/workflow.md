# 示范驱动工作流

## 1. 冻结完整上下文

在源书仍连接时完成读取，至少保存：

- 书本名称、学科、年级、册次以及目录完整路径和顺序；
- 每个入选目录的原始区块、全部元素、层级、几何与画布尺寸；
- 富文本规范 HTML、runs、段落、嵌入内容、默认样式和文本框布局；
- 图片素材引用和可见语义；
- 每个按钮/元素绑定的数字模块原始关系；
- 大纲节点、区块关联、源快照哈希和读取时间。

当前插件只有一个有效编辑器连接时，必须先把源上下文冻结到本轮工作目录，再切换目标书。不要依靠模型
记忆恢复被截断的源数据。若返回可能被截断，缩小到目录/页分批读取并逐批哈希。

哈希来源必须区分：

- 源目录 provenance/fingerprint 使用 `editor_export_semantic_snapshot.snapshotStableHash`；
- `snapshotFileSha256` 只校验本机快照 artifact 文件，不代表编辑器内容身份；
- 样章使用 `editor_get_template` 的完整响应，经 `semantic-rule-tools.mjs hash` 做 canonical JSON 哈希；
- 目标页使用 `editor_export_slide` 完整响应经 `semantic-rule-tools.mjs hash` 计算的 canonical JSON 哈希，
  或使用 `editor_save_verified` 回读得到的页级稳定内容哈希。

不要把文件哈希、语义快照哈希和目标内容哈希相互替代。

## 2. 建立语义草案

同时观察源内容和指定样章，给它们标注临时语义角色，例如“本课主标题”“例题题干”“提交按钮”“答案
解析区”。角色来自当前书的意义，不来自固定插槽表。

将用户规则改写为可执行草案，并明确：

1. 哪类目录适用；
2. 来源与目标分别是什么语义角色；
3. 允许匹配几个；
4. 使用何种原子动作；
5. 保留样章样式、复制来源样式还是混合；
6. 缺失或多义时停止、保留还是进入人工复核；
7. 如何回读、审计或截图证明完成。

保持 `intent`、锚点和正反例为自然语言。结构字段只约束可重复执行所需的边界。

选择器证据写成 `class/kind/claim/observation`；ID 和 slot 只允许进入 `optional_fingerprints`。不得把
`title-slot`、`element_id` 或类似字符串改名为 role/evidence 来绕过语义与结构证据。

## 3. 试制与纠正

选择同时覆盖主要内容和潜在例外的一个目录。写前输出只读 preflight；获用户授权后：

1. 创建/进入试制目标并建立 checkpoint；
2. 应用样章；
3. 按规则顺序执行文本、图片、数字模块、区块、布局和大纲原子动作；既有同构成品遇到富文本往返保护或
   组内移动限制时，按 [block-preserving-batch-refinement.md](block-preserving-batch-refinement.md) 的门禁，
   使用 `editor_replace_block_safe` 或更窄的 `editor_replace_element_safe` 做保留身份的完整 JSON 原位替换；
4. 每个规则都记录运行时绑定与证据；条件不命中也要以 `skipped` 和证据覆盖，不能留下空的
   `rule_bindings`；
5. 保存回读，运行结构审计、规则内 `severity=error` 验收、规则包顶层错误级验收并截图核对；
6. 记录与本次模式一致的用户授权：试制为 `trial_authorization`，批量为 `batch_authorization`。授权、
   错误级验收和规则绑定均不能为空；
7. 把来源追溯放入现有区块 JSON 的 `ai_semantic_provenance` 字段。由于这次写入本身再次改变了页面，
   必须随后再次调用 `editor_save_verified`、`editor_export_slide`，并执行
   `provenance-tools.mjs validate-readback` 核对真实保存回执、页身份、页哈希以及承载区块中的 `run_id` 和
   `integrity_hash`。后置回读未通过时，目录不能标为 `verified`。

正常试制和批量的每条 `rule_bindings` 都必须有非空 `source_bindings`、`target_bindings` 和 `evidence`。
绑定项固定记录 `semantic_role/identity/snapshot_hash/binding_hash`；identity 固定记录
`side/book_id/catalog_id/block_id/entity_kind/entity_id`，且书本、目录必须等于本次 provenance 的真实来源或目标。
证据项固定记录 `kind/summary/identity/artifact_hash/evidence_hash`，identity 必须引用同规则已声明的绑定。
`binding_hash`、`evidence_hash` 和规则 `result_hash` 都是可复算的 canonical SHA-256，不能用自然语言、运行时
ID 或空数组代替。只有明确标记为 `legacy_inferred` 且保持 `restricted=true` 的旧记录可走受限兼容分支。

`validate-readback` 只接受插件当前真实 MCP 返回契约：外层必须是单一 `content[0].type=text`，其 `text`
分别解码为 `editor_save_verified` 的 current-scope 保存回执和 `editor_export_slide` 的
`{slideId, blocks}`。承载区块用导出对象的真实 `uuid` 唯一定位，来源对象必须直接位于
`blocks[i].template_data_content.ai_semantic_provenance`；任意 `data` 包装、`blockId` 替身、字符串
`template_data_content` 或其他嵌套对象都不能充当回读证据。保存回执必须同时证明 `saved=true`、
`verified=true`、`dirty=false`、相同 slide identity，且 `contentHash=persistedContentHash`；脚本按编辑器实际
算法从导出 blocks 重算 `fnv1a32` 页哈希并再次比对。

```powershell
node scripts/provenance-tools.mjs validate-readback `
  --input <editor-export-slide-envelope.json> `
  --save-receipt <editor-save-verified-envelope.json> `
  --expected <provenance.json> `
  --carrier-block-id <uuid> `
  --out <readback-receipt.json>
```

成功输出是 `semantic_provenance_readback_receipt` artifact，绑定 run、provenance integrity、来源/目标身份、
保存/导出 envelope hash、页哈希、blocks/carrier hash 和 `artifact_integrity.canonical_hash`，供账本终态读取。
单元测试只可严格仿真上述返回结构，并必须注明没有调用浏览器；真实运行仍必须实际调用两个编辑器工具，
测试 fixture 不能替代运行时回执。

`validate-readback` 的结果保存到运行证据/批量账本，不要再回写进同一个 provenance；否则每次写入验收结果
都会改变页面并产生无穷的“再保存”链。provenance 内保存的是可复算的预期哈希，外部运行证据证明该哈希已经
在保存后的页面中被回读。

`provenance-tools.mjs create` 会把规则包中的每条规则和所有错误级验收列入 coverage。旧运行记录缺少某个
错误级验收时只会生成 `legacy_inferred` 的 `not_tested` 覆盖并把运行标为受限，不能据此进入批量。正常试制和
批量必须补齐真实 `passed` 证据，不得把合成覆盖当作验收通过。

收到纠正时使用四类：

| 类型 | 含义 | 默认处理 |
|---|---|---|
| `instance_fix` | 只针对这本书/这个目录 | 修改结果，不改通用规则 |
| `rule_refinement` | 同类内容都应遵守 | 更新现有规则和正反例 |
| `new_variant` | 特殊目录或特殊样章分支 | 新增有优先级的模板/规则变体 |
| `acceptance_refinement` | 生成对但验收漏检 | 增补验收条件 |

分类存在歧义时先按 `instance_fix` 处理并向用户确认是否提升。

## 4. 导出与前向验证

先从当前安装的原子插件刷新能力目录，再把规则包状态设为 `trial_approved` 并编译草稿专属 Skill：

```powershell
node scripts/generate-capability-catalog.mjs --plugin-dir <super-editor-control> --out references/super-editor-capability-catalog.json
node scripts/semantic-rule-tools.mjs validate --input references/rule-pack.json
```

能力快照必须绑定生成目录的 `catalog_hash`，且声明能力只能是目录工具名的子集。编译后的 Skill 必须携带
同一目录及已登记的前向 evidence artifacts，脱离母 Skill 后仍能重新校验。

选至少两个不参与教授、结构有差异的同类
目录/书进行前向验证；不得把预期答案泄漏给验证过程。

每个前向案例先落盘真实 JSON evidence artifact，再登记状态。主 artifact 必须绑定自身 case ID，并引用：

- 源 `editor_export_semantic_snapshot` 文件、文件 SHA 和 `snapshotStableHash`；
- 完整样章 JSON、文件 SHA 和 canonical template hash；
- 同一目标的 before/after JSON、各自文件 SHA 和不同 canonical hash；
- `editor_save_verified` 保存回执 JSON 及 canonical hash；
- provenance 二次保存后的导出/回读 JSON 及 canonical hash；
- acceptance report JSON；报告中的每个验收必须引用实际 JSON evidence 文件及文件 SHA。

只填哈希、自然语言 evidence 或“已通过”状态不构成前向验证。外层与每个嵌套引用的文件 SHA、canonical
hash、case/source/target 绑定任一不匹配，都必须保持未验证状态。

只有以下条件同时满足才能设为 `validated`：

- 至少两个 `forward_tests` 为 `passed`；
- 所有错误级验收通过；
- 所有未解决反馈都有明确的 `instance_fix` 或停止策略；
- 样章变体优先级无并列歧义；
- 数字模块与来源追溯完成回读。

这里的“来源追溯完成回读”特指 provenance 写入后的第二次保存、导出和 `validate-readback`，不能用写入
provenance 之前的页面保存结果代替。

规则变化后版本递增、重新计算哈希并重跑受影响的验证，不在原版本上静默覆盖。

## 5. 批量

先对书单建立账本，再逐本运行。每本书只允许一个执行者；跨任务/标签页使用以目标书为键的共享锁。
每一项先完成元数据匹配、源快照、模板解析、目标冲突与接口能力检查，然后才能进入 `preflighted`。

同一幂等键已 `verified` 时跳过。`outcome_unknown` 必须依靠真实回读恢复，禁止直接重放写入。批量中发现
新模式时标记 `needs_review`，在试制流程产生新版本后再继续。

### 晨读美文 3-4 / 5-6 年级已验证执行约束

1. 开始前同时核对书名、分类、年级段和书 ID。源书与目标书必须都是“晨读美文”，并且
   `more_grade` 完全一致；已验证配对只有 `1814457 -> 1820810`（3-4 年级）和
   `1814549 -> 1820811`（5-6 年级）。任一项不一致就停止，禁止用相似书名猜配。
2. 41100 样章首次载入可能仍是 PC 画布。每个正式目录都必须明确设置页面级 `phone`，保存回读
   `totalWidth=375`；不能只把区块改窄后就当作手机页。
3. 每页从同一个干净手机基页复制，禁止从已经按上一篇长正文扩高的页面继续复制。写入本页标题和正文后，
   独立测量实际渲染高度并移动下游元素、调整主区块高度；这样长文扩容不会污染后续短文。
4. 优先使用 Bridge 的文本布局测量。若插件重连后该元素的像素测量暂时返回空，但已精确确认当前书、
   当前目录和元素 `data-id`，允许只读浏览器 DOM 的 `scrollHeight` 作为回退；浏览器回退只负责测量，
   不负责写页面内容。
5. 页面末尾固定追加独立空区块：`375x20`、`sizeType=phone`、零元素、背景 `#CECECE`。
6. 复制页面不会可靠复制数字模块。每页重新建立并回读 8 个关系：英文查看位置、中文查看位置、音频、
   口语 PK、AI 口语、重点词汇内层“查看”位置、记忆课件、自然拼读内层“查看”位置。重点词汇外层卡片
   不得保留重复跳转。
7. 位置模块的 `resourceId` 必须来自对应源目录区块数据库 ID，但 `catalogId` 必须是当前目标目录 ID；
   不能把源目录 ID 写进目标目录字段，也不能跨书复用其他“晨读”书资源。
8. 书级字体清单为空仅记 `FONT_MAPPING_EMPTY` 警告，不阻挡生成、保存或批量推进。其他来源缺失、
   目标错书、交互缺失和业务内容哈希不一致仍按错误处理。

既有成品缺少来源时只能走 `legacy_inferred` 受限分支：先运行 `match-source`，保留查询、完整候选集、逐项
分数和证据，再由用户明确确认候选。零分、没有可比较元数据或并列第一都不是唯一匹配。匹配输出始终为
`automatic_write=false`；只有把 `inference` 和人工确认一并写入 provenance 后，才可称为人工补录来源，
且该记录本身不能授权自动批量改写内容。
