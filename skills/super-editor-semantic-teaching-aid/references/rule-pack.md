# 语义规则包

规则包的 JSON Schema 见 [semantic-rule-pack.schema.json](semantic-rule-pack.schema.json)，可编辑起点见
[rule-pack.example.json](rule-pack.example.json)。Schema 只提供单文件结构基线；跨字段关系、canonical hash、
能力目录、文件 SHA 和外部 evidence artifact 绑定以 `semantic-rule-tools.mjs validate` 为权威。二者不宣称
完全 parity。示例没有真实试制 evidence，因此明确保持 `draft`、未批准且没有前向案例。

## 设计边界

- `identity` 标识书类、版本和成熟度；批量只接受 `validated`。
- `applicability.intent` 用自然语言说明适用书类，元数据只用于召回和排除，不替代语义判断。
- `templates.default` 是用户指定样章；`variants` 表达特殊目录样章，按唯一最高 `priority` 选择。
- `rules` 按 `order` 执行。每条规则必须包含语义作用域、目标角色、基数、动作、异常策略和验收。
- `execution.capability_snapshot` 保存批准时实际可用的原子能力子集，并同时绑定审计目录路径、目录哈希和
  子集哈希。仓库目录 [super-editor-capability-catalog.json](super-editor-capability-catalog.json) 必须由安装的
  `super-editor-control` MCP 实际执行 `tools/list` 生成，含插件版本与排序后的完整工具名。
- `execution.trial_approval` 保存明确的人工试制批准；`execution.forward_cases` 保存不可由状态摘要替代的来源、目标和验收证据。
- `training.feedback` 同时记录 `confirmed`、`resolved` 和解决说明；`forward_tests` 只记录与 `forward_cases.id` 对应的运行状态摘要。

每个来源和目标选择器都必须填写 `role`、`cardinality` 和至少两项 `evidence`：至少一项
`class: semantic`，至少一项 `class: structure`。每项 evidence 是 `additionalProperties: false` 的严格对象，
只包含 `class`、`kind`、`claim` 与可从快照回读的 `observation`。固定 slot、运行时 ID、仅编号的值或把 ID
包装进 role/claim/observation 的写法一律拒绝。稳定的 template/sourceId/slot 指纹只能放在
`optional_fingerprints`，并说明 `intent`；即使指纹命中也仍须满足双类证据和基数。
运行时 elementId/blockId 只写进 provenance 绑定证据。模板 ID 是用户选择的业务输入，可以保留。

## 动作

| `action.type` | 用途 | 关键策略 |
|---|---|---|
| `set_rich_text` | 替换或改写文字 | `content_policy`、`style_policy` |
| `copy_image` | 从来源复制图片 | 来源/目标基数与素材可用性 |
| `copy_digital_module` | 复制按钮等元素的交互关系 | `module_policy` |
| `reuse_block` | 复用一个完整源区块 | 模块和大纲另行回读 |
| `choose_blocks` | 从候选区块中选一或多选 | `selection_policy` |
| `delete_block` | 条件删除区块 | `when` 与目标基数 |
| `delete_element` | 条件删除元素 | `when` 与目标基数 |
| `layout_adjust` | 语义重排或几何修复 | `layout_policy` |
| `outline_map` | 新增或映射大纲 | 大纲写入不可由页面 checkpoint 回退 |
| `atomic_sequence` | 用多个已有原子能力表达复合意图 | 每个子步骤分别声明能力和验收 |
| `other` 或新名称 | 当前表未覆盖的语义动作 | 必须声明 `intent`、原子能力、验收和歧义策略 |

`action.type` 不是封闭枚举。表中名称只是常见表达；不要为了套用动作名而牺牲用户原始语义。

`draft` 可以声明尚未安装的未来动作，用于继续教授。`action.type` 始终开放，`atomic_sequence` 可递归嵌套。
进入 `trial_approved` 或 `validated` 时，校验器会递归
展开 `atomic_sequence.steps`，把每层动作、规则验收和整体验收的 `required_capabilities` 与
`execution.capability_snapshot.capabilities` 比对，再验证该子集中的每个名字确实存在于所绑定的 capability
catalog。不存在的工具即使同时写入自报清单并重算 snapshot hash 也会被拒绝。

样式策略：

- `preserve_target`：保留样章字体与布局，只替换内容；默认使用。
- `copy_source_rich_text`：复制来源 runs/段落/嵌入及样式。
- `hybrid`：保留样章排版，迁移来源强调、公式、拼音和链接等语义格式。
- `none`：动作不涉及文本样式。

数字模块策略：

- `reuse_model_relation`：用现有接口复用来源 `modelId` 关系。
- `clone_if_supported`：只有当前插件明确提供可回读的深克隆原子能力时执行，否则停止。
- `none`：动作不涉及数字模块。

## 运行时匹配

按以下证据组合定位，不用单一字符串或 ID：

1. 语义角色和规则 `intent`；
2. 可见文本/图片含义与锚点；
3. 元素类型、父子层级、邻接关系和阅读顺序；
4. 目标/来源基数；
5. 版面区域和样章角色；
6. 正反例。

唯一匹配才能执行。多个候选同样合理时遵守 `on_ambiguous`；`stop`/`needs_review` 不得被“最佳猜测”覆盖。

## 版本

- `draft`：仍在教授，不允许批量。
- `trial_approved`：必须有绑定真实 capability catalog 的非空能力快照、样章快照和
  `trial_approval.approved: true` 的人工证据；可导出草稿 Skill，但不允许生产批量。
- `validated`：除试制门禁外，必须有至少两个 ID 唯一的 `passed` 前向案例；每个状态记录必须绑定同 ID 的
  `execution.forward_cases.evidence_artifact`。该相对路径必须落在规则包/Skill 的 artifact 根目录内，且
  `artifact_sha256` 必须匹配实际 JSON 文件。artifact 进一步绑定 case ID、源 semantic snapshot artifact/hash、
  样章 artifact/canonical hash、目标 before/after artifact/hash、保存回执、provenance 回读和验收报告；每个
  引用都要校验实际文件 SHA-256。至少两个案例必须使用不同 evidence artifact、源、目标和前后结果；所有
  顶层验收均须在各自 acceptance report 中为 `passed`，且不能存在未确认或未解决的反馈。
- `deprecated`：保留历史追溯，不再新运行。

规则、模板路由、错误级验收或默认策略变化时递增版本并生成新哈希。纯 `instance_fix` 不改变通用版本。
