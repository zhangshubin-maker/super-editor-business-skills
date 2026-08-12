# 既有样章规则复用与治理

## 运行时三层资产

1. `D:/GIT-web/web-tool/ai简化界面型教辅/模版/<id>.json` 保存真实样章结构。
2. 同目录 `<id>_analyse.json` 保存该样章的权威插槽 description、区块匹配和重复规则。
3. 本 Skill 的 `template-routing.json` 保存旧 Web 端的书级选择顺序与目录级特殊模板路由；
   `build-rule-registry.mjs` 每次从前两层动态生成哈希和能力索引。

不要把每个样章的 description 复制进 Skill、插件代码或提示词。Codex 替换 OpenCode 的语义判断角色，
`lesson-engine` 仍是不可绕过的 ID 和 v2 协议校验层。

## 当前兼容约定

- 已登记 47 对原始样章/分析文件；缺少分析文件或原始样章时 registry 构建失败关闭。
- 分析文件当前没有显式 `schema_version`，按隐式规则版本 1 读取。不要把 decisions 的
  `schema_version: 2` 写到分析文件顶层。
- 旧 `slots` 只作为 `text_slots` 兼容别名；缺失 `image_slots/delete_slots/repeat_groups` 归一为空数组。
- 同一元素 ID 可同时承担 text+jump、button+delete 等职责。禁止把规则扁平化为
  `elementId -> 单一动作`。
- `repeat_groups`、`match_rule` 和 `source_scope` 按文件现状执行。没有结构化 `source_scope` 时，不能根据
  自然语言擅自补范围。
- 41058、41063、41196 已登记但不在旧两处显式自动路由中，只能显式选择；不要推断成废弃或自动接入。

## 修改规则时的强制流程

只有用户明确要求创建或修正规则时才写 `_analyse.json`：

1. 完整阅读旧项目 `PROJECT_MEMORY.md` 与 `.opencode/commands/analyse.md`。
2. 对当前模板重新调用 `lesson-engine_extract_template_analyse`；截图、相似模板或旧 ID 只能帮助理解，不能当
   ID 来源。
3. 依据真实元素树补 description。文字、图片、模块、跳转、删除、match 各守职责；条件显隐只进
   `delete_slots`。
4. 调用 `lesson-engine_save_template_analyse` 保存，由服务端校验区块、slot 与重复元数据。
5. 再调用 compact 分析和真实或代表性 source 做回归；生成 decisions 时只复制权威骨架 ID。
6. 重建 registry，确认 pair 数、路由目标、hash 与能力统计。

不要直接给旧分析文件批量补 `schema_version/template_hash`。当前 `save_template_analyse` 的 normalize 白名单会
剥离未知顶层字段；版本与哈希先由外部 registry 管理，等保存器明确扩展契约后再迁移。

## 规则职责速查

| 字段 | 唯一职责 |
|---|---|
| `text_slots` | 替换纯文本，不承载显隐或模块逻辑 |
| `image_slots` | 替换内容图片 URL，不选装饰图 |
| `button_slots` | 选择源数字模块 `control_id` |
| `jump_slots` | 选择真实源大纲/区块目标 ID |
| `delete_slots` | 条件删除元素或完整视觉组 |
| `match_rule` | 决定整个样章区块是否保留 |

组合控件要定位真实子动作；单一动作整卡才使用父组。视觉第 N 项按真实坐标与截图核对，不按元素数组或图层
顺序猜测。新增规则的详细案例继续维护在旧项目 `PROJECT_MEMORY.md`，避免这里复制一份会漂移的模板专属 ID。
