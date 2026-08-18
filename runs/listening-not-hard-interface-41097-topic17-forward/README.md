# Topic 17 Daily Life 独立前向验证

本目录记录“听力不难”原课件 Topic 17（source catalog 6038）到“界面-听力不难”Topic 17
（target catalog 45080）的完整前向验证。

## 结果

- 手机端 375 宽，重新切页后保持。
- 基础标题为 `Words & Phrases` 与 `Sentences`。
- 来源课堂标题数为 1；目标删除第二张完整卡并收缩区块。
- 摘要 `听力绊脚石：弱读` 单行展示，箭头紧随文字，只有真实放不下才允许换行。
- Day 1 至 Day 6 保持顺序，Day 6 为“听力周周练”。
- 末尾追加 375×20 同底色空白区块。
- 13 个数字模块回读存在，其中 10 个来源定位均指向原书 Topic 17 对应区块。
- provenance 后置保存与严格回读通过。

## 主要文件

- `source-topic17-semantic-snapshot.json`：原课件冻结快照。
- `target-topic17-before-semantic-snapshot.json`：目标写前快照。
- `target-topic17-after-semantic-snapshot.json`：provenance 写入前的生成结果快照。
- `target-topic17-provenance-semantic-snapshot.json`：最终保存后的目标快照。
- `module-readback.json`：13 个模块的外层锚点与来源映射。
- `acceptance-report.json`：逐项验收和已知边界。
- `provenance.json`、`provenance-readback-receipt.json`：来源追溯与后置回读闭环。

本用例只证明一条独立前向样例通过；未授权整书批量或发布。
