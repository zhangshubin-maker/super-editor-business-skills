# 区块来源追溯与三方微调契约

## 目的与边界

本契约在**不新增或修改服务端接口**的前提下，为界面型 AI 教辅的每个生成区块记录来源、实际样章、规则版本和生成基线。追溯对象固定写入：

```text
block.template_data_content.ai_provenance
```

`template_data_content` 已由现有保存链路整体序列化为 JSON 字符串；不要另建服务端字段，也不要把本契约写进 `template_info`。本契约只记录可验证事实和哈希，不保存完整源课件、完整 lesson map 或敏感凭据。

辅助脚本为 `scripts/provenance-tools.mjs`。它生成或校验 JSON，并规划三方更新；它不直接调用编辑器或写书。

## 写入时机与持久化顺序

严格按以下顺序处理每个区块：

1. 用 `resolved_template_id` 的样章实例化真实区块，取得运行时 `blockId`。
2. 应用 lesson map 的文本、图片、按钮、跳转、删除等插槽转换。
3. 从**转换完成后的状态**提取文本与布局快照，创建 `ai_provenance`。
4. 调用：

   ```json
   {
     "blockId": "运行时区块 uuid",
     "patch": {
       "ai_provenance": { "...": "完整契约对象" }
     }
   }
   ```

   以上对象是 `editor_update_block` 的参数。`patch` 会合并到 `template_data_content`，不能包成 `patch.template_data_content.ai_provenance`。

5. 完成当前页所有写入后调用 `editor_save_verified`。
6. 调用 `editor_export_slide`，从返回的完整 `blocks[]` 找到相同 `uuid`，校验 `template_data_content.ai_provenance`。只有保存和导出回读都成功，才把该区块标记为追溯已落库。

不要在样章实例化前写入：初始化或整体替换可能重建 `template_data_content` 并丢弃扩展字段。

## `ai_provenance` v1

最小生成记录：

```json
{
  "schema_version": 1,
  "mode": "generated",
  "run_id": "018f2c2e-44c0-7dc8-bebf-20ff36e5fb4c",
  "source": {
    "book_id": "21380",
    "catalog_id": "99801",
    "catalog_name": "第3周 能力达标",
    "catalog_sort": 3,
    "book_name": "三年级语文上册",
    "subject": "语文",
    "grade": "三年级",
    "volume": "上册"
  },
  "template": {
    "requested_template_id": "41073",
    "resolved_template_id": "41075",
    "sample_block_id": "41133",
    "template_locked": false,
    "catalog_route": {
      "key": "math-thinking-ability-target",
      "priority": 3
    }
  },
  "artifacts": {
    "source_hash": "sha256:9999999999999999999999999999999999999999999999999999999999999999",
    "rule_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "template_hash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "map_hash": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "registry_hash": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    "routing_hash": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    "template_pair_hash": "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
  },
  "baseline": {
    "text_snapshots": {
      "source-element-1001": {
        "plain_text": "分数的初步认识",
        "document": { "type": "doc", "content": [] }
      }
    },
    "text_hashes": {
      "source-element-1001": "sha256:5b9ad798b3fe760f53ba632293e7df7f59dd8b14f3e0e78b715b97863055c2c9"
    },
    "layout_snapshots": {
      "source-element-1001": {
        "left": 48,
        "top": 92,
        "width": 310,
        "height": 56,
        "rotate": 0
      }
    },
    "layout_hashes": {
      "source-element-1001": "sha256:20ac8b93061399665f8a3898a330c1b9950c6e68cc351f2ccbc3a29136820640"
    }
  }
}
```

### 字段语义

| 字段 | 要求 |
|---|---|
| `schema_version` | 固定为 `1`。 |
| `mode` | `generated` 或 `legacy_inferred`。 |
| `run_id` | 同一次目录生成或回填任务的稳定标识；区块间可共享。 |
| `source.book_id/catalog_id` | 生成依据的原书、原目录 ID，统一存为字符串。 |
| `source.catalog_name/catalog_sort` | 原目录名称和序号；`catalog_sort` 是非负整数。 |
| `source.book_name/subject/grade/volume/catalog_path` | 可选匹配证据，用于历史查找和人工核对。 |
| `template.requested_template_id` | 书级或显式选择的模板 ID；`generated` 必填，历史无法推断时允许 `null`。 |
| `template.resolved_template_id` | 执行特殊目录路由后的实际模板 ID，必填。 |
| `template.sample_block_id` | v2 block plan 当前实例对应的原样章区块 ID，必填。重复区块的每个实例分别记录。 |
| `template.template_locked` | 显式锁定模板时为 `true`；锁定后 `catalog_route` 必须为 `null`。 |
| `template.catalog_route` | 命中的特殊目录规则 `{key,priority}`；无命中或锁定时为 `null`。 |
| `artifacts.source_hash` | **新生成记录必填**。必须直接使用 `editor_export_lesson_source` 返回的 `sourceSha256`；历史无法知道时为 `null`。 |
| `artifacts.rule_hash` | 实际 `_analyse.json` 的 SHA-256。 |
| `artifacts.template_hash` | 实际原始样章 JSON 的 SHA-256。 |
| `artifacts.map_hash` | 当前目录经 lesson-engine 验证后 map 的规范 JSON SHA-256。 |
| `artifacts.registry_hash/routing_hash/template_pair_hash` | 建议记录的 registry、路由配置和 raw/analyse 对哈希；均来自确定性模板路由结果。 |
| `baseline.text_snapshots/text_hashes` | 转换并确认后的逐目标文本实值及其哈希。 |
| `baseline.layout_snapshots/layout_hashes` | 同一时点逐目标布局实值及其哈希。 |

所有哈希写为小写 `sha256:<64 hex>`。baseline、map 和状态快照由脚本对递归排序对象键、保持数组顺序的 canonical JSON 计算。`source_hash` 是例外：其权威值是 `editor_export_lesson_source.sourceSha256`，对应落盘的 pretty JSON 加末尾换行的**字节哈希**，不能把解析后的对象交给 `hashJson` 重算，也不能拿两种算法做等值校验。registry 相关哈希直接沿用模板 registry 输出。

稳定目标键优先使用样章元素 `sourceId`。同一 `sourceId` 在重复实例中可能出现多次，因此基线仅在当前区块的 `ai_provenance` 内解释；区块之间不要合并。没有 `sourceId` 时才使用运行时元素 ID，并将其视为较弱锚点。

### 基线快照约定

脚本的 `create` 输入接受 `baseline.text` 和 `baseline.layout` 作为便捷别名，也接受正式字段 `text_snapshots` 和 `layout_snapshots`。输出会同时持久化快照和哈希：

```json
{
  "baseline": {
    "text_snapshots": {
      "source-element-1001": {
        "plain_text": "分数的初步认识",
        "document": { "type": "doc", "content": [] }
      }
    },
    "text_hashes": {
      "source-element-1001": "sha256:5b9ad798b3fe760f53ba632293e7df7f59dd8b14f3e0e78b715b97863055c2c9"
    },
    "layout_snapshots": {
      "source-element-1001": {
        "left": 48,
        "top": 92,
        "width": 310,
        "height": 56,
        "rotate": 0
      }
    },
    "layout_hashes": {
      "source-element-1001": "sha256:20ac8b93061399665f8a3898a330c1b9950c6e68cc351f2ccbc3a29136820640"
    }
  }
}
```

文本快照应包含会影响回放的富文本结构，而不只包含纯文本；布局快照应选定一致的坐标空间，并包含位置、尺寸、旋转及确实需要比较的排版字段。不要把与任务无关的瞬态渲染字段纳入快照，否则会产生伪冲突。`validate` 会逐目标重算并检查 snapshot/hash 一致性。

兼容早期仅有 `text_hashes/layout_hashes` 的记录：验证会给出 warning 而不是判坏，三方比较仍可按哈希分类；但冲突结果中的 `baseline_value` 为 `null`、`baseline_value_available=false`、`value_displayable=false`，调用方必须明确提示“旧记录没有可展示的基线实值”，不能伪造或用当前值代替。

## 历史成品回填

没有追溯信息的历史书本使用 `mode: "legacy_inferred"`。先按书名、学科、年级、上下册缩小源书，再按完整目录路径、目录名、序号匹配源目录；然后用区块 `template_id`、样章区块 ID、元素 `sourceId` 集合与结构指纹逐层交叉验证。

历史记录必须增加：

```json
{
  "mode": "legacy_inferred",
  "template": {
    "requested_template_id": null,
    "resolved_template_id": "41075",
    "sample_block_id": "41133",
    "template_locked": false,
    "catalog_route": null
  },
  "artifacts": {
    "source_hash": null,
    "rule_hash": null,
    "template_hash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "map_hash": null
  },
  "inference": {
    "confidence": "high",
    "confidence_reasons": [
      "score_at_least_75",
      "subject_grade_volume_known_and_equal"
    ],
    "evidence": [
      { "rule": "subject_exact", "points": 5, "query": "语文", "candidate": "语文" },
      { "rule": "grade_exact", "points": 5, "query": "三年级", "candidate": "三年级" },
      { "rule": "volume_exact", "points": 5, "query": "上册", "candidate": "上册" },
      { "rule": "catalog_name_sort_exact", "points": 15 },
      { "rule": "sample_block_exact", "points": 10 },
      { "rule": "source_id_fingerprint", "points": 15, "ratio": 1, "match": "exact_set" }
    ]
  }
}
```

未知字段写 `null`，不能用当前 source、规则、样章或 map 的哈希冒充历史生成时版本。回填前运行 `match-legacy`，人工确认候选后才能调用 `create` 和 `editor_update_block`；**即使结果为 high 且唯一，也不允许自动写入**。首次回填的 `baseline` 采用当前成品快照，含义是“从现在开始追踪”，不是声称它等于历史生成原值。

### 可审计候选评分

`match-legacy` 输入一个 `query` 和非空 `candidates[]`。字段可放在顶层，也可按 `source`、`template`、`fingerprints` 分组：

```json
{
  "query": {
    "book_name": "三年级语文上册同步训练",
    "subject": "语文",
    "grade": "三年级",
    "volume": "上册",
    "catalog_path": ["第一单元", "第3周 能力达标"],
    "catalog_name": "第3周 能力达标",
    "catalog_sort": 3,
    "template_id": 41075,
    "sample_block_id": 41133,
    "source_ids": ["slot-a", "slot-b"],
    "structure_fingerprint": { "blocks": 1, "elements": ["text", "image"] }
  },
  "candidates": [
    {
      "candidate_id": "book-21380/catalog-99801",
      "source": {
        "book_id": "21380",
        "catalog_id": "99801",
        "book_name": "三年级语文上册同步训练",
        "subject": "语文",
        "grade": "三年级",
        "volume": "上册",
        "catalog_path": "第一单元/第3周 能力达标",
        "catalog_name": "第3周 能力达标",
        "catalog_sort": 3
      },
      "template": { "resolved_template_id": 41075, "sample_block_id": 41133 },
      "fingerprints": {
        "source_ids": ["slot-a", "slot-b"],
        "structure_fingerprint": { "blocks": 1, "elements": ["text", "image"] }
      }
    }
  ]
}
```

固定评分表（满分 100）：

| 规则 | 分值 | 说明 |
|---|---:|---|
| 学科一致 | 5 | query 与 candidate 都已知且不一致时直接硬拒。 |
| 年级一致 | 5 | 同上。 |
| 册次一致 | 5 | `上`/`上册`、`下`/`下册`会归一；已知不一致硬拒。 |
| 书名 exact | 15 | 与 contains 互斥。 |
| 书名 contains | 8 | 任一归一化书名包含另一方。 |
| 目录 path exact | 20 | 与下一项互斥，优先使用完整路径。 |
| 目录 name + sort exact | 15 | path 未命中时的组合证据；名称或序号单独相同不计分。 |
| 实际 template exact | 15 | 对比 `resolved_template_id/template_id`。 |
| sample block exact | 10 | 对比原样章区块 ID。 |
| sourceId fingerprint | 最多 15 | 数组用 Jaccard 比例乘 15；预计算字符串仅 exact 得 15。 |
| structure fingerprint exact | 10 | 对象用 canonical JSON 哈希比较，字符串按归一值比较。 |

置信度规则固定为：

- `high` 必须同时满足 `score >= 75`，并且学科、年级、册次在 query 和 candidate **六个值都已知且归一后一致**。
- `score >= 75` 但任一核心值未知时，最高只能为 `medium`；输出 `core_metadata_complete=false`、`missing_core_metadata` 和 `confidence_reasons`，例如 `high_capped_missing_core_metadata:candidate.subject`。
- 完整核心信息下 `50 <= score < 75` 为 `medium`；其余 eligible 候选为 `low`；硬拒为 `rejected`。

每个候选输出 `score/confidence/confidence_reasons/core_metadata_complete/missing_core_metadata/evidence/rejection_reasons`。`unique=true` 仅表示最高分只有一个候选；并列最高时 `top_candidate_id=null`。输出始终带 `requires_human_confirmation=true`、`automatic_write=false`，且不会生成任何编辑器写入参数。

`evidence` 是可审计结构化数组，可以从 matcher 候选**原样**放进 legacy `create` 的 `inference.evidence`。每项固定字段为：

| 字段 | 要求 |
|---|---|
| `rule` | 必填非空字符串。 |
| `points` | 必填非负有限数。 |
| `hard_reject` | 可选布尔值。 |
| `query/candidate` | 可选 JSON 标量，用于记录比较双方。 |
| `ratio` | 可选 `0..1` 数值。 |
| `match/note` | 可选非空字符串。 |

不允许额外字段。`create` 会规范化并持久化结构化 evidence，`validate` 严格检查字段和类型。为兼容已经落库的旧记录，`validate` 仍接受非空字符串 evidence；新 `create` 收到旧字符串时统一转换为 `{rule:"legacy_note",points:0,note:"原字符串"}`。matcher 的 `confidence_reasons` 也可原样写入 inference。

## 三方微调规划

后期更新始终比较三方：

- `baseline`：上次确认并写入契约的生成状态哈希。
- `current`：`editor_export_slide` 回读的当前成品状态。
- `desired`：根据最新原课件、参考样章和规则计算出的目标状态。

逐目标分类：

| 条件 | 分类 | 行为 |
|---|---|---|
| `current == desired` | `noop` | 已达到目标，不写。 |
| `desired == baseline` | `noop` | 来源侧没有变化，不覆盖当前人工修改。 |
| `current == baseline` 且 `desired != baseline` | `safe` | 当前没有人工分叉，可自动更新。 |
| 其余情况 | `conflict` | 当前与目标都偏离基线，保留当前并请求确认。 |

文本与布局分别规划。文本冲突不能阻断无关元素的安全布局更新；同理，布局冲突不应覆盖已经确认的文本。`plan-update` 只返回计划，调用方只能自动执行 `safe_changes`，不能把 `conflicts` 静默降级为 safe。每个冲突项同时返回 `baseline_value/current_value/desired_value`、三方哈希和 present 标记，供人工比较。

安全更新真正应用并经 `editor_save_verified`、`editor_export_slide` 回读确认后，才用新 `current` 重新计算对应目标的 baseline 哈希并更新 `ai_provenance`。未应用、失败或冲突目标保持旧 baseline。

### 部分应用与 artifacts/refinement

顶层 `artifacts` 表示当前 provenance 所认定的**完整生成原点**。当一次微调同时存在 safe 和 conflict 时，只应用 safe 不能证明整块已经完全采用新的 source/rule/template/map，因此不得把顶层 artifacts 替换成 desired 哈希。此时增加可选记录：

```json
{
  "refinement": {
    "origin_artifacts": {
      "source_hash": "sha256:9999999999999999999999999999999999999999999999999999999999999999",
      "rule_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "template_hash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "map_hash": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    },
    "desired_artifacts": {
      "source_hash": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "rule_hash": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      "template_hash": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      "map_hash": "sha256:4444444444444444444444444444444444444444444444444444444444444444"
    },
    "applied_targets": {
      "text": ["source-element-safe"],
      "layout": ["source-element-layout-safe"]
    },
    "conflict_targets": {
      "text": ["source-element-manual"],
      "layout": []
    },
    "current_state_hash": "sha256:5555555555555555555555555555555555555555555555555555555555555555",
    "complete_application": false,
    "readback_verified": true,
    "origin_artifacts_promoted": false
  }
}
```

- `origin_artifacts` 和 `desired_artifacts` 各自四个哈希都必填。origin 是微调前顶层 `artifacts` 的不可变快照；desired `source_hash` 直接取新一轮 `editor_export_lesson_source.sourceSha256`。
- `applied_targets` 只记录已经应用并回读确认的目标；`conflict_targets` 记录仍需人工处理的目标。两者按 `text/layout` 分开，同一维度不得重叠或重复。
- `current_state_hash` 是应用后回读状态 `{text,layout}` 的 canonical JSON 哈希。
- 任何已经写入 `ai_provenance.refinement` 的记录都必须是保存/导出回读后的事实，因此 `readback_verified` 必须为 `true`；计划态不得提前落入 refinement。
- `complete_application=false` 时必须 `origin_artifacts_promoted=false`，顶层四个 artifacts 必须逐项等于 `origin_artifacts`，无论冲突列表是否为空。
- `complete_application=true` 时冲突列表必须为空、`origin_artifacts_promoted=true`，顶层四个 artifacts 必须逐项等于 `desired_artifacts`。
- 不允许“complete 但未提升”“partial 但已提升”“refinement 未回读”“partial 顶层已换 desired”或“complete 顶层仍是 origin”等中间状态落库；`validate` 会拒绝所有这些组合。

实际落库建议两阶段：先应用内容并保存/导出，基于回读计算 `current_state_hash` 和实际 applied/conflict；再更新 provenance，二次 `editor_save_verified` 和 `editor_export_slide` 确认元数据本身已经持久化。计划尚未执行时不能预先把 `safe_changes` 冒充为 `applied_targets`。

## CLI

```text
node scripts/provenance-tools.mjs create \
  --input create-spec.json --block-id <blockId> [--out create-result.json]

node scripts/provenance-tools.mjs validate \
  --input exported-slide.json [--block-id <blockId>] [--out validation.json]

node scripts/provenance-tools.mjs plan-update \
  --input update-request.json [--block-id <blockId>] [--out update-plan.json]

node scripts/provenance-tools.mjs match-legacy \
  --input query-and-candidates.json [--out scores.json]
```

`--input -` 从标准输入读取 JSON；不传 `--out` 时输出到标准输出。

### `create`

输入包含 `block_id`（也可由 `--block-id` 覆盖）、`mode`、`source`、`template`、`artifacts`、`map` 和 `baseline`。`generated` 的 `artifacts.source_hash` 必须显式传入 `editor_export_lesson_source.sourceSha256`；脚本不会从解析后的 source 对象推算它。如果同时传 `map` 和 `artifacts.map_hash`，脚本以 map 的 canonical hash 为准。模板路由 CLI 的整个结果也可放入 `route`，脚本会读取：

```text
requested_template_id
resolved_template_id
template_locked
catalog_route
registry.registry_sha256
registry.routing_sha256
registry.raw_sha256
registry.analyse_sha256
registry.pair_sha256
```

输出：

```json
{
  "provenance": { "...": "契约对象" },
  "editor_update_block": {
    "tool": "editor_update_block",
    "arguments": {
      "blockId": "block-uuid",
      "patch": { "ai_provenance": { "...": "契约对象" } }
    }
  }
}
```

### `validate`

支持以下输入形态：

- 直接 `ai_provenance` 对象；
- `editor_export_slide` 返回的 `{slideId, blocks}`；
- 单个完整区块，`template_data_content` 可以是对象或 JSON 字符串；
- MCP 包装 `{content:[{type:"text",text:"<JSON>"}]}`；
- `create` 的输出。

多区块导出可用 `--block-id` 精确筛选。验证失败退出码为 `1`，参数或解析错误退出码为 `2`。

验证会强制 `generated.artifacts.source_hash` 存在且格式正确；`legacy_inferred` 允许四个 origin 哈希为 `null`，但会产生 unknown warning。baseline snapshot 与 hash 不一致属于错误，旧 hash-only baseline 属于兼容 warning。可选 refinement 也会执行完整结构、目标集合和 promotion 门禁校验。

### `plan-update`

输入是任一可提取 provenance 的完整对象，再增加：

```json
{
  "blocks": [],
  "block_id": "block-uuid",
  "current": {
    "text": { "source-element-1001": { "plain_text": "当前值" } },
    "layout": { "source-element-1001": { "left": 48, "top": 92, "width": 310, "height": 56 } }
  },
  "desired": {
    "text": { "source-element-1001": { "plain_text": "目标值" } },
    "layout": { "source-element-1001": { "left": 56, "top": 92, "width": 310, "height": 56 } }
  }
}
```

`desired` 中 `{ "$delete": true }` 表示期望删除目标。输出包含：

- `summary.safe/noop/conflict`
- 逐目标 `text[]`、`layout[]` 分类、三方哈希、三方实值及存在标记
- `warnings`；旧 hash-only 基线遇到冲突时明确标记基线实值不可展示
- `current_state_hash`，用于回读后构建 refinement
- 可直接交给业务编排的 `safe_changes`
- 必须人工决策的 `conflicts`

脚本不读取任意 JSON 路径，也不生成编辑器元素调用；调用方根据稳定目标键定位真实元素后，再按 `super-editor-control` 原子工具契约执行。

### `match-legacy`

输入和固定权重见“可审计候选评分”。输出按 eligible、score 降序和 `candidate_id` 排序，包含每条 evidence 的规则与分值、硬拒原因、置信度、最高分是否唯一。该命令是只读候选分析器；不接受 `blockId`，不返回 `editor_update_block`，任何回填都必须由人工确认后另行执行。

## 复制、导入和替换例外

- **普通区块复制或整页复制：** 完整 JSON 深拷贝通常会保留 `ai_provenance`，但新块会继承旧 `run_id` 和来源。复制如果只是同一生成物的派生可保留，并在后续人工修改时照常三方比较；如果复制用于新的源目录，必须创建新的 provenance，不能只改 `catalog_id`。
- **跨页导入：** `editor_import_blocks` 会重生成区块和元素 ID。导入后用返回的新 `blockId` 重新读取；稳定目标键应继续依赖 `sourceId`，并再次保存、导出验证。
- **整体替换区块、替换整页或重新实例化样章：** 这些操作可能删除原 `template_data_content`。执行前导出备份；替换后显式重建或迁移 provenance，不能假设扩展字段自动保留。
- **历史复制链：** 如果无法证明复制与原源目录的关系，降级为 `legacy_inferred` 并记录证据，不沿用可能错误的 generated 事实。

任何复制/导入/替换路径都必须在最终 `editor_save_verified` 后用 `editor_export_slide` 回读确认；Mock 成功或内存对象存在不等于持久化验收通过。
