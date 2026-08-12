# 批量账本与来源追溯

## 账本状态

正常路径：

`pending -> planned -> preflighted -> applied -> saved -> verified`

异常状态：

- `needs_review`：出现新模式、缺失或语义歧义；
- `conflict`：目标存在人工修改或并发变更；
- `failed`：已知未完成且可安全计划重试；
- `outcome_unknown`：写入结果未知，必须先回读，禁止盲目重试。

进入 `preflighted` 时写入完整 fingerprint，至少包含源快照哈希、样章快照哈希、目标写前哈希和已解析的
模板 ID。脚本据此结合 Skill 名称、版本和规则包哈希生成幂等键。

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

运行时元素/区块 ID 可以出现在绑定证据中，但不能反向成为下一本书的规则选择器。

既有成品缺少来源时，先用 `provenance-tools.mjs match-source` 按书名、学科、年级、册次和目录路径（或
目录名 + 顺序）输出候选、分数和证据。已知学科/年级/册次不一致是硬排除；元数据缺失会降低置信度。
工具永远返回 `automatic_write=false`，即使只有一个高分候选也必须让用户确认，再以当前成品为 baseline
建立新的语义来源记录。

## 现有接口内落盘

不要求新增后端字段或修改接口。使用现有区块更新能力，把完整 provenance 放在一个稳定的承载区块 JSON：

```text
template_data_content.ai_semantic_provenance
```

优先选择每个生成目录都存在且不会被规则删除的首个根区块。若区块 JSON 以字符串返回，解析后合并字段再
序列化，保留未知字段；不要字符串拼接。写后导出该页并校验来源对象哈希。多个区块可只保存摘要引用，
但承载区块必须保存完整对象。

## 恢复与并发

- 运行 `batch-ledger.mjs acquire-lock` 建立按目标书 ID（新书未创建时按稳定 `lock_key`）持久化的跨标签页/
 任务锁；锁使用原子 `wx` 创建，不会默认抢占。每次账本转换必须由同一 owner 持锁，完成或明确交接后运行
  `release-lock`。单页模块变量不能保护整本书。
- 每次状态转换追加历史，不覆盖之前证据。
- `saved` 只表示编辑器保存成功；只有导出回读、来源校验和错误级验收通过后才是 `verified`。
- 规则包哈希、样章哈希或目标写前哈希在 preflight 后变化时退回 `planned`，重新报告差异。
- 学生端跳转、音视频或题目交互未实测时记录为未验证，不得用结构存在代替体验验收。
