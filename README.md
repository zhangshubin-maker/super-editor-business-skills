# Super Editor Business Skills

面向具体业务场景的 Codex Skills 集合，以 `super-editor-control` 插件提供的原子化 MCP 能力为基础进行流程编排。

## 边界

- 本项目保存导书、批量制作、行业内容处理等业务工作流。
- `super-editor-control` 只维护书本、画布、元素、文件、数字模块等通用原子能力。
- 业务 Skill 不复制 MCP 服务代码；缺少通用原子能力时，应先在 `super-editor-control` 中补齐并验证，再由这里的 Skill 编排。
- 每个 Skill 必须独立保存于 `skills/<skill-name>/`，并通过 Codex Skill 校验器。

## Skills

- `super-editor-pdf-annotation-import`：根据 PDF 标注 JSON 和本地音频，搜索并切换目标书本，逐页换算 794 宽画布坐标，创建 Lottie 按钮并关联音频或图文数字模块。
- `super-editor-ai-interface-authoring`：复用 lesson-engine 的 47 份样章插槽规则与精确模板路由，通过 Codex 对话生成可追溯的界面型 AI 教辅，并支持历史来源回填和文本/布局三方微调。

## 使用

先安装并启用 `super-editor-control` 插件。整个仓库可作为 `super-editor-business-skills` 插件安装；也可以只把所需 Skill 目录复制到用户的 Codex Skills 目录：

```text
~/.codex/skills/<skill-name>/
```

重启 Codex 并新建任务后，通过 Skill 名称调用。例如：

```text
使用 $super-editor-pdf-annotation-import，把这个标注 JSON 和本地音频目录导入指定的 PDF 超媒书本。
使用 $super-editor-ai-interface-authoring，根据这本原课件和参考样章生成一套可追溯的界面教辅。
```

分享整个项目时，可以压缩项目目录或推送到 Git 仓库；接收方只需安装其中需要的 Skill。
