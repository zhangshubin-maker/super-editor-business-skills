# 语义规则包

规则包的机器契约见 [semantic-rule-pack.schema.json](semantic-rule-pack.schema.json)，可编辑起点见
[rule-pack.example.json](rule-pack.example.json)。运行 `semantic-rule-tools.mjs validate` 后再试制或编译。

## 设计边界

- `identity` 标识书类、版本和成熟度；批量只接受 `validated`。
- `applicability.intent` 用自然语言说明适用书类，元数据只用于召回和排除，不替代语义判断。
- `templates.default` 是用户指定样章；`variants` 表达特殊目录样章，按唯一最高 `priority` 选择。
- `rules` 按 `order` 执行。每条规则必须包含语义作用域、目标角色、基数、动作、异常策略和验收。
- `training.feedback` 保存用户纠正的分类和是否确认；`forward_tests` 保存未参与教授的验证证据。

规则选择器可把稳定的 template/sourceId 当作可选指纹或锚点，但必须同时具有语义角色、基数、结构证据和
歧义策略；任何 ID 都不能成为唯一选择条件。运行时 elementId/blockId 只写进 provenance 绑定证据。
模板 ID 是用户选择的业务输入，可以保留。

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
- `trial_approved`：代表性目录已由用户确认，可导出草稿 Skill，但不允许生产批量。
- `validated`：至少两个前向案例通过，可以创建批量账本。
- `deprecated`：保留历史追溯，不再新运行。

规则、模板路由、错误级验收或默认策略变化时递增版本并生成新哈希。纯 `instance_fix` 不改变通用版本。
