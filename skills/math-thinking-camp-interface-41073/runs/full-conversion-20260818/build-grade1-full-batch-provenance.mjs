import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const runDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1'))
const skillRoot = path.resolve(runDir, '../..')
const semanticRoot = path.resolve(skillRoot, '../super-editor-semantic-teaching-aid')
const source = JSON.parse(fs.readFileSync(path.join(runDir, 'grade1-full-source-manifest.json'), 'utf8')).pages
const builder = path.join(runDir, 'build-page-provenance.mjs')
const provenanceTool = path.join(semanticRoot, 'scripts', 'provenance-tools.mjs')
const rulePack = path.join(skillRoot, 'references', 'rule-pack.json')
const snapshotRoot = path.dirname(source[0].snapshotPath)
const targetIds = [
  46096, 46338, 46339, 46340, 46341, 46097, 46342,
  46343, 46344, 46345, 46346, 46347, 46368, 46369,
  46348, 46349, 46350, 46351, 46352, 46370, 46371,
  46353, 46354, 46355, 46356, 46357, 46372, 46373,
  46358, 46359, 46360, 46361, 46362, 46374, 46375,
  46363, 46364, 46365, 46366, 46367, 46376, 46377
]

if (source.length !== targetIds.length) throw new Error(`source/target count mismatch: ${source.length}/${targetIds.length}`)

function latestSnapshot(catalogId) {
  const prefix = `1820815-${catalogId}-`
  const candidates = fs.readdirSync(snapshotRoot)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => {
      const file = path.join(snapshotRoot, name)
      return { file, mtimeMs: fs.statSync(file).mtimeMs }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (!candidates.length) throw new Error(`missing target snapshot for ${catalogId}`)
  const artifact = JSON.parse(fs.readFileSync(candidates[0].file, 'utf8'))
  if (String(artifact.snapshot?.identity?.catalogId) !== String(catalogId)) {
    throw new Error(`snapshot identity mismatch for ${catalogId}`)
  }
  const warnings = artifact.snapshot?.completeness?.warnings || []
  const sections = artifact.snapshot?.completeness?.sections || {}
  const fullFidelity = Object.entries(sections).every(([key, value]) => value === true || key === 'fonts')
    && warnings.every((warning) => warning.code === 'FONT_MAPPING_EMPTY')
  const fileSha256 = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(candidates[0].file)).digest('hex')}`
  return {
    path: candidates[0].file,
    stableHash: artifact.stableHash,
    fileSha256,
    fullFidelity,
    moduleCount: artifact.meta?.digitalModuleCount,
    blockCount: artifact.meta?.blockCount,
    elementCount: artifact.meta?.elementCount,
    warnings
  }
}

const targets = source.map((src, index) => {
  const targetId = targetIds[index]
  const snapshot = latestSnapshot(targetId)
  const expectedModules = src.route === 'normal' ? 9 : 2
  if (!snapshot.fullFidelity || snapshot.moduleCount !== expectedModules) {
    throw new Error(`target ${targetId} failed snapshot gate: fullFidelity=${snapshot.fullFidelity}, modules=${snapshot.moduleCount}/${expectedModules}`)
  }
  return {
    sourceId: src.id,
    targetId,
    name: src.name,
    route: src.route,
    variant: src.variant || null,
    sourceSnapshotHash: src.snapshotStableHash,
    sourceSnapshotPath: src.snapshotPath,
    targetSnapshotHash: snapshot.stableHash,
    targetSnapshotPath: snapshot.path,
    targetSnapshotFileSha256: snapshot.fileSha256,
    fullFidelity: snapshot.fullFidelity,
    moduleCount: snapshot.moduleCount,
    blockCount: snapshot.blockCount,
    elementCount: snapshot.elementCount,
    warnings: snapshot.warnings,
    carrierBlockId: src.route === 'normal' ? 'QJYjbCqT4_41089' : 'UN3g1OkkzG41095'
  }
})

fs.writeFileSync(path.join(runDir, 'grade1-full-target-progress.json'), `${JSON.stringify({ pages: targets }, null, 2)}\n`, 'utf8')

const generated = []
for (let index = 0; index < source.length; index += 1) {
  const src = source[index]
  const target = targets[index]
  const normal = src.route === 'normal'
  const stem = `grade1-full-${src.id}`
  const appliedRules = normal ? {
    'full-problem-questions': {
      source_block: String(src.problemBlockId), target_block: target.carrierBlockId,
      source_role: '来源问题探索完整题目', target_role: '问题探索卡片与查看入口',
      summary: '完整保留来源问题探索题干与富文本内嵌对象，并创建来源区块定位。'
    },
    'full-solution-summary': {
      source_block: String(src.methodBlockId), target_block: target.carrierBlockId,
      source_role: '来源解题思路与名师总结', target_role: '解题思路引导语与总结入口',
      summary: '写入来源支持的解题引导语，并保留解题思路和名师总结查看入口。'
    },
    'full-primary-links': {
      source_block: String(src.problemBlockId), target_block: target.carrierBlockId,
      source_role: '问题探索、解题思路、名师总结三个来源区块', target_role: '三个完整外层查看组',
      summary: '创建问题探索、解题思路和名师总结三个可回读来源区块定位。'
    },
    'full-variant-links': {
      source_block: String(src.variants?.[0]?.analysisBlockId || src.problemBlockId), target_block: target.carrierBlockId,
      source_role: '两个变式的分析、解答与关键点区块', target_role: '两个变式各三个完整外层入口',
      summary: '两个变式分别创建思路分析、解答和关键点定位，共六个且不串题。'
    }
  } : {
    'ability-content': {
      source_block: String(src.contentBlockId), target_block: target.carrierBlockId,
      source_role: `能力达标${src.variant}及其前五个学习之旅目录`, target_role: `保留的能力达标${src.variant}卡片及五个知识标签`,
      summary: `只保留能力达标${src.variant}卡片，五个知识点按最近到最早显示，并保留基础巩固文案。`
    },
    'ability-modules': {
      source_block: String(src.contentBlockId), target_block: target.carrierBlockId,
      source_role: '来源智能体与首个实质内容区块', target_role: 'AI拍照批改完整外层组与查看完整外层组',
      summary: '创建一个来源智能体和一个来源区块定位；不复制核对答案或重复模块。'
    }
  }
  const template = normal
    ? { requested_template_id: '41073', resolved_template_id: '41073', variant_id: 'full-normal', snapshot_hash: 'sha256:18f0bccb7368b9bec006afb8a79f4b4f20b80d7d40493b9cf39a387fb88f1a33' }
    : { requested_template_id: '41075', resolved_template_id: '41075', variant_id: `ability-${src.variant.toLowerCase()}`, snapshot_hash: 'sha256:82ae50d30fd0eed9d64cc7fc6195a8cd30c1384707a2030867b803db451782e0' }
  const beforeHash = normal
    ? 'sha256:ebd6db226d868030e86ba99b9f0a2ccfe5684b84b730cb2aa531e54f9bd85e79'
    : 'sha256:94104e826e928286cce4822607d57b85a6bf880125a1f227460bff858f01c71a'
  const beforeArtifact = normal
    ? 'C:/Users/shubin/AppData/Local/Temp/super-editor-control/semantic-snapshots/1820815-46096-75e1b8f2fd11bc3240e7d2eadbd03ef492f576c2a1a519d58143f85133eaf544.json'
    : 'C:/Users/shubin/AppData/Local/Temp/super-editor-control/semantic-snapshots/1820815-46097-416fd715b7309050159cfbca96d87c6d0cebd49f66ec17e16a389deb1331db7f.json'
  const config = {
    run_id: `math-thinking-camp-grade1-full-${src.id}-20260819`,
    carrier_block_id: target.carrierBlockId,
    route_label: normal ? '全册普通学习之旅' : `全册能力达标${src.variant}`,
    output: `${stem}.provenance-run.json`,
    execution_mode: 'batch',
    source: { book_id: '1819783', catalog_id: String(src.id), catalog_path: [src.name], snapshot_hash: src.snapshotStableHash },
    template,
    target: { book_id: '1820815', catalog_id: String(target.targetId), before_hash: beforeHash, result_hash: target.targetSnapshotHash },
    applied_rules: appliedRules,
    baseline: { template_id: template.resolved_template_id, source_semantic_snapshot: src.snapshotPath, target_before_artifact: beforeArtifact },
    instance_fixes: [
      { kind: 'phone_canvas_correction', summary: '根据用户反馈把页面级画布由 PC 修正为 phone/375，并同步全部区块宽度。' },
      { kind: 'phone_group_bounds_correction', summary: normal ? '校正问题探索查看组的旧 PC 包围盒元数据，保持子元素位置和模块锚点不变。' : '校正能力卡片最外层组的旧 PC 包围盒元数据，保持子元素位置和模块锚点不变。' }
    ],
    user_approvals: [{
      id: 'full-conversion-approval-20260818', type: 'batch_authorization', status: 'confirmed',
      scope: '数学思维特训营未转换书本的逐目录全量转换', confirmed_by: 'user', confirmed_at: '2026-08-18T21:00:00+08:00',
      evidence: ['用户明确要求开始全量转换，并指定后续只在 http://127.0.0.1:8090/ 操作。', '用户于 2026-08-19 指出界面教辅必须使用 phone 宽度，已按该最新确认修正。']
    }],
    created_at: new Date().toISOString()
  }
  const configPath = path.join(runDir, `${stem}.config.json`)
  const runPath = path.join(runDir, `${stem}.provenance-run.json`)
  const provenancePath = path.join(runDir, `${stem}.provenance.json`)
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  execFileSync(process.execPath, [builder, configPath], { stdio: 'ignore' })
  execFileSync(process.execPath, [provenanceTool, 'create', '--rule-pack', rulePack, '--input', runPath, '--out', provenancePath], { stdio: 'ignore' })
  execFileSync(process.execPath, [provenanceTool, 'validate', '--input', provenancePath], { stdio: 'ignore' })
  generated.push({ sourceId: src.id, targetSlideId: target.targetId, carrierBlockId: target.carrierBlockId, stem, provenancePath, targetSnapshotHash: target.targetSnapshotHash })
}

fs.writeFileSync(path.join(runDir, 'grade1-full-provenance-index.json'), `${JSON.stringify(generated, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ generated: generated.length, targetProgress: path.join(runDir, 'grade1-full-target-progress.json'), provenanceIndex: path.join(runDir, 'grade1-full-provenance-index.json') }, null, 2))
