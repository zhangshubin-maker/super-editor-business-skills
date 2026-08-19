import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const runDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1'))
const skillRoot = path.resolve(runDir, '../..')
const semanticRoot = path.resolve(skillRoot, '../super-editor-semantic-teaching-aid')
const source = JSON.parse(fs.readFileSync(path.join(runDir, 'grade1-a-source-manifest.json'), 'utf8')).pages
const targets = JSON.parse(fs.readFileSync(path.join(runDir, 'grade1-a-target-progress.json'), 'utf8')).pages
const builder = path.join(runDir, 'build-page-provenance.mjs')
const provenanceTool = path.join(semanticRoot, 'scripts', 'provenance-tools.mjs')
const rulePack = path.join(skillRoot, 'references', 'rule-pack.json')
const generated = []

for (const target of targets) {
  if (target.provenanceReceipt) continue
  const src = source.find((item) => item.id === target.sourceId)
  const stem = `batch-a-${src.id}`
  const isAnalysis = target.route === 'a-analysis'
  const active = isAnalysis ? {
    'ab-block-and-copy': { source_block: String(src.locatorBlockId), target_block: target.carrierBlockId, source_role: 'A版解析目录与同序号练习知识点', target_role: '唯一保留的A版解析子区块与解析文案', summary: `保留 A 版解析子区块并写入${src.topic}解析说明。` },
    'ab-view-link': { source_block: String(src.locatorBlockId), target_block: target.carrierBlockId, source_role: '首个解析实质内容区块', target_role: '查看完整外层组', summary: '创建一个指向来源首个解析实质区块的定位模块。' }
  } : {
    'ab-block-and-copy': { source_block: String(src.locatorBlockId), target_block: target.carrierBlockId, source_role: 'A版练习目录与知识点名称', target_role: '唯一保留的A版练习子区块与基础巩固文案', summary: `保留 A 版练习子区块并写入${src.topic}基础巩固文案。` },
    'ab-exercise-modules': { source_block: String(src.blocks.find((block) => block.id !== src.locatorBlockId && block.texts.includes('解题灵感助手'))?.id || src.locatorBlockId), target_block: target.carrierBlockId, source_role: '前两个练习相邻的互动课程关系', target_role: '练习1与练习2完整卡片组', summary: '分别复制前两个相邻互动课程，目标页恰好两个互动课程。' },
    'ab-view-link': { source_block: String(src.locatorBlockId), target_block: target.carrierBlockId, source_role: '首个练习实质区块', target_role: '查看完整外层组', summary: '创建一个指向来源首个练习区块的定位模块。' }
  }
  const config = {
    run_id: `math-thinking-camp-batch-a-${src.id}-20260818`, carrier_block_id: target.carrierBlockId,
    route_label: isAnalysis ? 'A版解析页' : 'A版练习页', output: `${stem}.provenance-run.json`, execution_mode: 'batch',
    source: { book_id: '1819791', catalog_id: String(src.id), catalog_path: [src.name], snapshot_hash: src.snapshotStableHash },
    template: { requested_template_id: '41074', resolved_template_id: '41074', variant_id: isAnalysis ? 'a-analysis' : 'a-practice', snapshot_hash: 'sha256:2f1c4e44bda7eaddb6471209dd6a90880e214568f4c05e8e741a1f4f79786038' },
    target: { book_id: '1820816', catalog_id: String(target.targetSlideId), before_hash: target.targetBeforeHash, result_hash: target.targetResultHash },
    applied_rules: active,
    baseline: { template_id: '41074', source_semantic_snapshot: src.snapshotPath, target_before_artifact: `semantic-hash:${target.targetBeforeHash}` },
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
fs.writeFileSync(path.join(runDir, 'grade1-a-provenance-index.json'), `${JSON.stringify(generated, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ generated: generated.length }, null, 2))
