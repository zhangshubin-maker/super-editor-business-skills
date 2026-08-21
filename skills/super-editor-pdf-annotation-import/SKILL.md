---
name: super-editor-pdf-annotation-import
description: 将外部 PDF 标注 JSON 和本地音频批量导入 Super Editor 的 PDF 型超媒书本。用户要求搜索并切换目标书本、解析页尺寸与按钮标注、按 794 宽画布逐页换算坐标、上传 MP3、创建 Lottie 音频/听力原文按钮、关联 77 音频与 76 图文数字模块、逐页保存回读或验收整书时使用。
---

# Super Editor PDF Annotation Import

通过已安装的 `super-editor-control` 插件，把标注 JSON 转为可点击的 PDF 超媒书本。此 Skill 只编排插件提供的书本、文件、元素、数字模块、保存和审计等原子能力，不实现或复制 MCP 服务。把预检、单页样例、逐页写入和最终回读视为一个不可跳步的流水线。

## 1. 加载依赖与输入

同时加载 `super-editor-control`、`super-editor-books`、`super-editor-state`、
`super-editor-elements`、`super-editor-digital-modules`、`super-editor-canvas` 和
`super-editor-quality`；多页任务再加载 `super-editor-book-authoring`。

读取 [annotation-contract.md](references/annotation-contract.md)；使用默认 Lottie 按钮时再读取
[button-styles.json](references/button-styles.json)。

确认标注 JSON、本地音频目录、目标书名或 bookId、目标 PDF 文件名。画布宽度默认 `794`；用户明确提供其他宽度时才覆盖。用户未授权写入前只做预检。

## 2. 先生成确定性导入计划

运行：

```powershell
node scripts/analyze-annotations.mjs --json "<annotations.json>" --audio-dir "<audio-dir>" --canvas-width 794
```

脚本必须返回零错误后才能写书。核对 PDF 页数、受影响页、每页原始宽高、标注 ID/类型、音频存在性与 70MB 上限，以及计划总数。每页使用
`scale = canvasWidth / sourcePageWidth`，不要沿用其他页的比例。

## 3. 搜索并锁定目标书本

1. 用 `editor_search_books` 搜索候选，再用 `editor_get_book` 核对 bookId、书名、PDF 文件名和页数。
2. 用 `editor_jump_to_book` 或正确路由切换；`book_id`、`catalog_id`、`ai_control=1` 必须作为路由后的 query 参数。
3. 用 `editor_status`、`editor_connect`、`editor_get_state` 确认 Bridge、bookId 和当前目录。
4. 读取 manifest/slide 列表。不要假设 slideId 连续或等于某个基数加 PDF 页码。
5. 对每个命中页选择候选 slide，读取 `pdfpage.page_natural_code`；只有它等于 JSON 的 PDF 页码才建立映射，并定位承载该背景的 blockId。

发现书名、PDF、页码或背景不匹配时停止，不在“相似书本”上试写。

## 4. 建立幂等与安全基线

写入前检查每个命中页是否已有 `component_id=265/506` 且位置在目标坐标 `0.5px` 容差内的按钮，以及对应 77/76 模块。精确匹配项记为完成，不重复创建；部分匹配时停在该页读清状态。

调用 `editor_list_digital_module_types` 读取当前 76、77 schema。数字模块立即写库，而 checkpoint 只能恢复画布，因此：

- 每页写入前创建 `editor_checkpoint`；
- 页面未保存时禁止热更新 Bridge、刷新浏览器或切走；
- 失败后停留当前页，先删除本轮已创建模块，再 `editor_rollback`；
- 不依赖 rollback 清除已经写入后台的数字模块。

## 5. 先完成一页样例

选择同时含音频和原文的代表页：

1. 安全切页、核对 pdfpage，并创建 checkpoint。
2. 按 `left=x*scale`、`top=y*scale` 创建按钮。精确 Lottie 样式保留其宽高；没有样式覆盖时再缩放 JSON 的 `width/height`。
3. 通过 `addElements` 一次加入按钮，按 JSON 顺序保存返回 elementId 映射。
4. 音频先调用 `editor_upload_file`；要求同时返回非空 URL 和正整数 fileId，否则停止。
5. 先 `validateOnly=true` 验证 77/76 payload，再逐个创建数字模块。
6. 回读模块：音频必须有 URL、fileId、文件名；原文必须有非空 HTML。
7. 调用 `editor_save_verified(scope=current)`，运行 current 资源/布局审计并截图。

样例未全部通过时不要批量继续。

## 6. 批量逐页导入

每页严格执行：切页 → 核对 pdfpage → checkpoint → 加按钮 → 上传本页音频 → 建模块 → 回读 → 保存 → current 审计。

- `audio`：使用音频 Lottie；type `77`；配置 `{ audio: { url, fileId, name } }`；名称 `播放 <unit>`。
- `transcript`：使用原文 Lottie；type `76`；`question` 放入 `<strong>`，转义后的 `text` 换行转为 `<br>`；名称 `查看听力原文：<question>`。
- HTML 必须转义 `& < > " '`。
- 保持 JSON 原始顺序，elementId 与 annotation 以数组索引一一对应。

分小批执行并维护已保存页清单。任何一页失败都不能把后续页面声称为完成。

## 7. 整书验收

逐页验证元素数、模块数、77/76 分类数、音频 URL/fileId、原文 content 和 dirty 状态。对全部命中 slideId 调用 `editor_audit_content(scope=book)`，单批最多 40 页；至少截图前后两种源页宽的代表页。

能打开学生预览时实际点击一个音频和一个原文按钮；弹窗不可接管时明确报告未做交互试听，不能把结构回读表述为学生端验证。

最终报告 bookId、命中页数、按钮/模块总数、音频/原文分类数、坐标公式、保存和审计结果、未验证项。

## 8. 恢复策略

连接中断或结果未知时，重新连接同一 bookId，从最后一个保存成功页开始回读；用元素位置、component_id 和模块类型判断已完成项，只补缺失项。绝不因 MCP 超时直接重试立即写库操作。

## 9. 已验证经验（2026-08 高二上册 1820741 整书导入）

- `editor_select_slide` 的 `slideId` 必须传字符串；数字会被 schema 校验拒绝为“slideId 不能为空”。
- 新式 `-PDF-annotations.json`（144 标注：22 音频 + 122 原文）会在“第二节”页面把整段原文按钮
  拆成逐题按钮（`听第X段材料，回答第X题`），并保留 Ⅰ./Ⅱ./Ⅲ./Ⅳ./Ⅴ. 与“第一节”按钮；不同版本的
  同数字 ID 不代表同一逻辑按钮，映射必须按 `question`（原文模块题干）或音频文件名匹配，不能按 ID 或顺序。
- 逐页写入前先 `editor_get_slide` 紧凑读取（剥离 pdfpage 的 textLayer），核对
  `page_natural_code`、定位承载 pdfpage 的 blockUuid，并拒绝已存在按钮的页面（幂等保护）。
- MCP 页面租约 TTL 约 30 秒；并发任务或本任务残留客户端会造成 `INSTANCE_BUSY`，等待约 35 秒后
  重试同一次调用即可，不要在同一进程内重复消费已返回的错误响应。
- 整书导入用持久化 stdio 客户端顺序执行：切页 → 核对页 → checkpoint → `addElements`（保持 JSON 顺序，
  返回 elementIds 与标注一一对应）→ 音频 `editor_upload_file` 后建 77 → 原文建 76 → `editor_list_digital_modules`
  回读 → `editor_save_verified(scope=current)`；每页独立保存，任何一页失败先删本轮模块再 rollback。
