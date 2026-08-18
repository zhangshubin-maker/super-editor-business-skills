# 批量账本与来源追溯

## 账本状态

正常路径：

`pending -> planned -> preflighted -> authorize-apply -> applied -> saved -> verified`

`authorize-apply` 是保持在 `preflighted` 状态的写前门，不是编辑器写操作。幂等注册表已存在同一逻辑工作且
状态为 `verified`，并且当前目标写前哈希仍等于上次验证结果哈希时，本项直接进入终态 `verified_skip`；
目标已漂移或该逻辑工作被其他账本声明但尚未验证时进入 `conflict`，不得因为换了 `item_id` 而重新执行。

异常状态：

- `needs_review`：出现新模式、缺失或语义歧义；
- `conflict`：目标存在人工修改或并发变更；
- `failed`：已知未完成且可安全计划重试；
- `outcome_unknown`：写入结果未知，必须先回读，禁止盲目重试。

进入 `preflighted` 时写入完整 fingerprint，至少包含源快照哈希、样章快照哈希、规则包哈希、目标写前哈希
和已解析的模板 ID。逻辑幂等键严格由以下值生成：源稳定快照哈希、样章完整 canonical 哈希、规则包哈希、
目标书稳定身份和目标目录范围。`item_id` 只是账本显示/寻址字段，目标写前哈希只做并发漂移门，二者都不进入
幂等身份。`init` 在书单附带 `preflight_fingerprint` 时可提前报告重复；最终仍由持锁的 `preflighted`
转换在固定用户级注册表中原子声明，因而不同账本、不同任务也不能重复执行。

调用任何编辑器写工具前，重新导出源、样章和目标并运行 `authorize-apply`。它会同时复核源稳定哈希、样章
canonical 哈希、规则包哈希、目标写前哈希和已解析模板 ID；任一漂移都会记录差异、撤销写权限并回到
`planned`。只有返回 `write_permitted=true` 后才能写，随后进入 `applied` 时必须提交同一目标锁下的一次性
`apply_authorization_token`。`outcome_unknown` 不走重新授权或重写，只能凭 `readback_recovery=true` 的回读
证据判断原写入实际落在哪个状态。

其中源快照哈希必须取 `editor_export_semantic_snapshot.snapshotStableHash`；本地 `snapshotFileSha256` 只做
artifact 文件完整性校验。样章哈希是 `editor_get_template` 完整响应的 canonical JSON 哈希；目标页用
`editor_export_slide` 完整响应经 `semantic-rule-tools.mjs hash` 计算 canonical JSON 哈希，或采用
`editor_save_verified` 回读得到的页级稳定内容哈希。三者不可混用。

## 来源对象

每次目录生成记录：

- 专属 Skill 名称、版本和规则包哈希；
- 源书/目录、完整源快照哈希；
- 请求和最终样章 ID、样章快照哈希及命中的变体；
- 目标书/目录与写前、写后哈希；
- 每条规则的运行时来源/目标绑定、匹配证据、执行结果；
- `instance_fix`、跳过项、冲突和用户批准；
- 保存回读、结构审计、截图和交互验收结果。

`rule_bindings` 必须逐条覆盖规则包中的全部规则；未执行规则也要记录 `skipped` 及原因证据。`validation`
必须覆盖每条规则内部和规则包顶层的全部 `severity=error` 验收；`user_approvals` 必须包含与运行模式一致的
试制或批量授权。批量授权是写前用户许可，与写后验收分开记录；只有这些错误级验收全部为有证据的
`passed` 且 provenance 完成后置回读时，批量项才可进入 `verified`。旧记录缺失验收时只允许合成
`legacy_inferred/not_tested` 的审计缺口，不能把缺失解释为通过。

正常试制/批量的每个来源或目标绑定固定为
`semantic_role/identity/snapshot_hash/binding_hash`，其中 identity 固定为
`side/book_id/catalog_id/block_id/entity_kind/entity_id`；每条 evidence 固定为
`kind/summary/identity/artifact_hash/evidence_hash`，且引用同规则已声明的绑定 identity。三组数组都必须
非空，canonical hash 必须可复算，书本/目录 identity 必须与 provenance 对应端一致。只有保持
`legacy_inferred`、`restricted=true` 且不能授权自动批量写入的旧记录可走受限兼容分支。

运行时元素/区块 ID 可以出现在绑定证据中，但不能反向成为下一本书的规则选择器。

既有成品缺少来源时，先用 `provenance-tools.mjs match-source` 按书名、学科、年级、册次和目录路径（或
目录名 + 顺序）输出候选、分数和证据。已知学科/年级/册次不一致是硬排除；元数据缺失会降低置信度。
工具永远返回 `automatic_write=false`，即使只有一个高分候选也必须让用户确认，再以当前成品为 baseline
建立新的语义来源记录。

零分、查询缺少全部可比较元数据、或最高分并列时 `unique=false`。`match-source` 的 `inference` 会保留：

- 原查询和完整候选集及其 canonical hash；
- 每个候选的分数、硬排除原因和命中证据；
- 最终人工确认人、确认时间、候选及依据；
- `automatic_write=false` 和 `legacy_inferred_source` 限制。

将这段 `inference` 放进运行输入的 `source.inference`，并使用 `execution_mode=legacy_inferred`；被确认候选必须
等于 `source.book_id`，且还需 `legacy_source_confirmation` 授权。该分支只能补录来源和进行人工受控微调，
不能自然升级为批量自动写权限。

## 现有接口内落盘

不要求新增后端字段或修改接口。使用现有区块更新能力，把完整 provenance 放在一个稳定的承载区块 JSON：

```text
template_data_content.ai_semantic_provenance
```

优先选择每个生成目录都存在且不会被规则删除的首个根区块。若区块 JSON 以字符串返回，解析后合并字段再
序列化，保留未知字段；不要字符串拼接。写后导出该页并校验来源对象哈希。多个区块可只保存摘要引用，
但承载区块必须保存完整对象。

### 生成后的轻量微调

文字内容与样式、元素位置和尺寸、区块尺寸，以及文本/图片元素的新增或删除，优先使用对应原子工具原位
修改；不要仅为省调用次数而调用 `editor_replace_block`、整页替换或重新套用样章。若逐元素富文本写入被
安全往返保护阻断、组内移动能力仍不可用，或同构批量需要联动修改多组叶子元素，只有完整满足
[block-preserving-batch-refinement.md](block-preserving-batch-refinement.md) 的 ID、未知字段、provenance、模块关系
和切页回读门禁，才允许以 `editor_export_slide` 的完整区块为基线调用 `editor_replace_block_safe`；先
dry-run 核对差异，再带 `expectedHash` 写入。只涉及一个元素/组树时改用 `editor_replace_element_safe`。
普通原位修改不重写
provenance，也不要把初次生成的 `target.result_hash` 改成当前页哈希；它继续作为生成基线，后续变化通过
refinement/current hash 记录。

开始微调和最终保存后各检查一次当前目录的完整承载记录，正常状态必须满足：

- 恰好一个根区块的 `template_data_content.ai_semantic_provenance` 是完整对象；
- 该区块仍与 provenance 中记录的 carrier block 和目录身份一致；
- 其他区块不得保存完整副本，允许不存在该字段或值为 `null`。

复制普通区块无需特殊处理。复制承载区块时，使用复制工具返回的新 `blockId`，立即调用
`editor_update_block` 把**副本**的 `ai_semantic_provenance` 置为 `null`，不得修改原承载区块；随后再继续修改
副本。若确实要删除承载区块，先选择另一个不会被删除的稳定根区块，将完整 provenance 合并过去，再删除
旧承载区块，最终只保存并验证一次唯一承载记录。若确实要用 `editor_replace_block_safe` 替换承载区块，则传入的
完整 `templateData.template_data_content` 必须显式带回原 provenance；不能依赖替换操作自动继承未知字段。

收尾时导出当前页检查承载数量。为零时停止保存交付并从本轮 provenance artifact 或人工确认的历史来源记录
恢复；大于一时停止并清空副本，只保留原始/已迁移的唯一记录。只有承载记录本身被迁移、恢复或更新时，才
需要重新执行下述完整后置闭环；普通文字和布局微调按当前页常规 `editor_save_verified` 保存即可。

来源写入是一次新的页面变更，必须执行完整后置闭环：

1. `editor_update_block` 合并 `template_data_content.ai_semantic_provenance`；
2. 再次 `editor_save_verified`；
3. 再次 `editor_export_slide`，保留完整承载区块 JSON；
4. 运行
   `node scripts/provenance-tools.mjs validate-readback --input <editor-export-slide-envelope.json> --save-receipt <editor-save-verified-envelope.json> --expected <provenance.json> --carrier-block-id <uuid> --out <readback-receipt.json>`；
5. 两个输入都必须是运行时保存的真实 MCP 返回 envelope；只有成功输出 canonical receipt artifact，且恰好一个
   承载区块同时匹配 `run_id`、`integrity_hash` 时，才允许账本进入 `verified`。

把 `validate-readback` 输出作为账本转换证据；不要把这份输出继续写回 provenance，否则会再次改变页面并
形成无限回写链。

自动测试里的 envelope 只用于契约模拟，不代表已经完成浏览器或编辑器真实调用；生产运行不能用模拟 fixture
替代第二次 `editor_save_verified` 和 `editor_export_slide`。输出 artifact 同时绑定 FNV 页面内容哈希与
`artifact_integrity.canonical_hash`。

`saved -> verified` 必须读取上述命令写出的 `semantic_provenance_readback_receipt` JSON artifact，而不是接收
调用方声称“已回读”的布尔值。transition evidence 同时提交 artifact 路径与原始文件字节 SHA-256；账本会
复算文件 SHA-256、`artifact_integrity.canonical_hash`、save/export 两段 `receipt_hash`，并校验：

- `run_id`、provenance integrity hash、carrier block、slide ID；
- 来源书/目录和目标书/目录与账本、transition evidence 一致；
- `editor_save_verified` 确实为 current、saved/verified、单一同页、dirty=false；
- 保存 content hash、persisted hash 与导出 page content hash 是同一真实 `fnv1a32`；
- 导出包含有效 blocks/carrier/envelope 哈希；
- `verified.result_hash` 等于上一状态 `saved.save_readback_hash`（该 SHA-256 不能冒充编辑器 FNV content hash）。

任何缺失、文件篡改、canonical 篡改或逻辑绑定不一致都拒绝进入 `verified`。

专属 Skill 编译器会一起复制本文件、`workflow.md` 和 provenance 脚本，编译后的 Skill 也必须执行同一
闭环，而不是依赖母 Skill 目录。

## 恢复与并发

- CLI 的锁、prospective identity 和幂等注册表目录固定在当前用户的受控状态目录，明确拒绝 `--lock-dir`；
  自定义目录只允许 `node:test` 通过库函数依赖注入，环境变量不能开启旁路。
  运行 `batch-ledger.mjs acquire-lock --lock-key <stable-key>` 建立持久化的跨标签页/任务锁，锁使用原子 `wx`
  创建，不会默认抢占。已有书可用稳定书本 ID；新书创建前必须生成并写入书单的
  `target_book_prospective_identity` 与独立 `lock_key`，两者都禁止退化为 `item_id`。固定注册表同时建立
  prospective -> lock、lock -> prospective 双向索引；创建成功后在同一锁下用 `promote-target` 增加真实
  bookId 索引，一个真实 bookId 也不能绑定多个 prospective identity。提升后 logical identity 继续使用
  prospective identity，账本另记 `promoted_book_id/target_book_id`。每次账本转换和 `authorize-apply` 都必须验证
  同一 owner、nonce 与目标锁。
- 锁看似陈旧时先运行 `inspect-lock` 并保留观察时间、heartbeat 年龄、owner、nonce 和进程活性提示。正常交接由
  当前 owner 使用 `transfer-lock`，证据必须含匹配 nonce、原因和授权人。只有超过陈旧阈值，并有
  `confirm_owner_inactive=true`、匹配 nonce、原因和授权人时才可 `recover-lock`；旧锁会进入恢复档案，不会
  静默删除。本机锁记录的 owner PID 仍在运行时，无论锁龄和声明证据如何都必须拒绝 recover。检查后 nonce
  变化时恢复必须失败，活锁不得抢占。完成后才由当前 owner `release-lock`。
- 每次状态转换追加历史，不覆盖之前证据。
- `saved` 只表示编辑器保存成功；只有导出回读、来源校验和错误级验收通过后才是 `verified`。
- 源稳定哈希、规则包哈希、样章 canonical 哈希、已解析模板或目标写前哈希在 preflight 后变化时退回
  `planned`，重新报告差异；未拿到写令牌时禁止调用编辑器写工具。
- 学生端跳转、音视频或题目交互未实测时记录为未验证，不得用结构存在代替体验验收。
