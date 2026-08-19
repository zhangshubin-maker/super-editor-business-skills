import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const runDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1'))
const skillRoot = path.resolve(runDir, '../..')
const semanticRoot = path.resolve(skillRoot, '../super-editor-semantic-teaching-aid')
const grade = process.argv[2] || 'grade1'
const configs = {
  grade1: { sourceBookId: '1819790', targetBookId: '1820817', stem: 'b1' },
  grade2: { sourceBookId: '1819798', targetBookId: '1820818', stem: 'b2' },
  grade3: { sourceBookId: '1819803', targetBookId: '1820819', stem: 'b3' }
}
const selected = configs[grade]
if (!selected) throw new Error(`unknown B-grade config: ${grade}`)
const source = JSON.parse(fs.readFileSync(path.join(runDir, `${grade}-b-source-manifest.json`), 'utf8')).pages
const targets = JSON.parse(fs.readFileSync(path.join(runDir, `${grade}-b-target-progress.json`), 'utf8')).pages
const builder = path.join(runDir, 'build-page-provenance.mjs')
const provenanceTool = path.join(semanticRoot, 'scripts', 'provenance-tools.mjs')
const rulePack = path.join(skillRoot, 'references', 'rule-pack.json')
const templateHash = 'sha256:bc675960e627a0462917cc9be388caf29b7aa04024b5f3c8372cefc80a5d81e7'
const generated = []

for (const target of targets) {
  const src = source.find((item) => item.id === target.sourceId)
  const stem = `batch-${selected.stem}-${src.id}`
  const isAnalysis = target.isAnalysis
  const active = isAnalysis ? {
    'ab-block-and-copy': { source_block: String(src.locatorBlockId), target_block: target.carrierBlockId, source_role: 'B版解析目录与同序号练习知识点', target_role: '唯一保留的B版解析子区块与解析文案', summary: `保留 B 版解析子区块并写入${src.topic}解析说明。` },
    'ab-view-link': { source_block: String(src.locatorBlockId), target_block: target.carrierBlockId, source_role: '首个解析实质内容区块', target_role: '查看完整外层组', summary: '创建一个指向来源首个解析实质区块的定位模块。' }
  } : {
    'ab-block-and-copy': { source_block: String(src.locatorBlockId), target_block: target.carrierBlockId, source_role: 'B版练习目录与知识点名称', target_role: '唯一保留的B版练习子区块与拔高巩固文案', summary: `保留 B 版练习子区块并写入${src.topic}拔高巩固文案。` },
    'ab-exercise-modules': { source_block: String(src.blocks.find((block) => block.id !== src.locatorBlockId && block.texts.includes('解题灵感助手'))?.id || src.locatorBlockId), target_block: target.carrierBlockId, source_role: '前两个练习相邻的互动课程关系', target_role: '练习1与练习2完整卡片组', summary: '分别复制前两个相邻互动课程，目标页恰好两个互动课程。' },
    'ab-view-link': { source_block: String(src.locatorBlockId), target_block: target.carrierBlockId, source_role: '首个练习实质区块', target_role: '查看完整外层组', summary: '创建一个指向来源首个练习区块的定位模块。' }
  }
  const config = {
    run_id: `math-thinking-camp-batch-${selected.stem}-${src.id}-20260818`,
    carrier_block_id: target.carrierBlockId,
    route_label: isAnalysis ? 'B版解析页' : 'B版练习页',
    output: `${stem}.provenance-run.json`,
    execution_mode: 'batch',
    source: { book_id: selected.sourceBookId, catalog_id: String(src.id), catalog_path: [src.name], snapshot_hash: src.snapshotStableHash },
    template: { requested_template_id: '41076', resolved_template_id: '41076', variant_id: isAnalysis ? 'b-analysis' : 'b-practice', snapshot_hash: templateHash },
    target: { book_id: selected.targetBookId, catalog_id: String(target.targetSlideId), before_hash: templateHash, result_hash: target.snapshotStableHash },
    applied_rules: active,
    baseline: { template_id: '41076', source_semantic_snapshot: src.snapshotPath, target_before_artifact: `template-hash:${templateHash}` },
    user_approvals: [{ id: 'full-conversion-approval-20260818', type: 'batch_authorization', status: 'confirmed', scope: '数学思维特训营未转换书本的逐目录全量转换', confirmed_by: 'user', confirmed_at: '2026-08-18T21:00:00+08:00', evidence: ['用户明确要求开始全量转换，并指定后续只在 http://127.0.0.1:8090/ 操作。'] }],
    created_at: new Date().toISOString()
  }
  const configPath = path.join(runDir, `${stem}.config.json`)
  const runPath = path.join(runDir, `${stem}.provenance-run.json`)
  const provenancePath = path.join(runDir, `${stem}.provenance.json`)
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  execFileSync(process.execPath, [builder, configPath], { stdio: 'ignore' })
  execFileSync(process.execPath, [provenanceTool, 'create', '--rule-pack', rulePack, '--input', runPath, '--out', provenancePath], { stdio: 'ignore' })
  execFileSync(process.execPath, [provenanceTool, 'validate', '--input', provenancePath], { stdio: 'ignore' })
  generated.push({ sourceId: src.id, targetSlideId: target.targetSlideId, carrierBlockId: target.carrierBlockId, stem, provenancePath })
}
fs.writeFileSync(path.join(runDir, `${grade}-b-provenance-index.json`), `${JSON.stringify(generated, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ generated: generated.length }, null, 2))
