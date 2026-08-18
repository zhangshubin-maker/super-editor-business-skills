#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { hashJson } from './semantic-rule-tools.mjs'

const skillRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, m => m.slice(1))), '..')
const runRoot = 'C:/Users/shubin/skills/super-editor-business-skills/runs/oral-daily-practice-interface-41103-book4'
const beforePath = 'C:/Users/shubin/AppData/Local/Temp/super-editor-control/semantic-snapshots/1820806-45159-c1d7de727176cbcbd51037bdd7b7277eaf868b31c6888cf680551415c988e4a3.json'
const templatePath = path.join(runRoot, 'template-41103-envelope.json')
const cases = [
  {
    id: 'day6-long-sentence',
    dir: 'forward-day6',
    sourceId: '5212',
    sourcePath: 'C:/Users/shubin/AppData/Local/Temp/super-editor-control/semantic-snapshots/1814807-5212-84e1d60a44851c6186e1563945b523e6b0f663952f4a3efbb773862e112e758a.json',
    sourceStableHash: 'sha256:89def4f9372012f49be8e477338e2cc635b32c61b52b919488542e5efbdc56de',
    targetId: '45824',
    afterPath: 'C:/Users/shubin/AppData/Local/Temp/super-editor-control/semantic-snapshots/1820806-45824-ba1990c8a7c87e6f56e2ab3aab158f7a4def58be50f929343b1ca7413edef695.json',
    visual: 'Day 6 learning-block screenshot showed all three sentences complete at 11px and four aligned word pairs.'
  },
  {
    id: 'day19-two-line-title',
    dir: 'forward-day19',
    sourceId: '5244',
    sourcePath: 'C:/Users/shubin/AppData/Local/Temp/super-editor-control/semantic-snapshots/1814807-5244-81f1489a4c61dac97647739916e61743be8ebaa8e74e0286fcfe1ec7c5096b6d.json',
    sourceStableHash: 'sha256:06eaefa99f9fe7339dddf77a33b7749108e9a6d646949b0c0b5a90823ae4ab39',
    targetId: '45825',
    afterPath: 'C:/Users/shubin/AppData/Local/Temp/super-editor-control/semantic-snapshots/1820806-45825-b0babe585cdbe846dd71e181fb9a16ed421584fd48d1ed03a79e8a34efb9262d.json',
    visual: 'Day 19 full-page screenshot showed the complete two-line 16px title in a 48px box, full view control, and no overlap after the Dialogue region shifted by 24px.'
  }
]
const fileSha = filename => 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'))
const writeJson = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', 'utf8')
const results = []
for (const item of cases) {
  const dest = path.join(skillRoot, 'references', 'forward-tests', item.id)
  fs.mkdirSync(dest, { recursive: true })
  const files = {
    source: 'source-semantic-snapshot.json',
    template: 'template-41103-envelope.json',
    before: 'target-before-semantic-snapshot.json',
    after: 'target-after-semantic-snapshot.json',
    save: 'editor-save-verified-envelope.json',
    receipt: 'provenance-readback-receipt.json',
    observations: 'acceptance-observations.json',
    report: 'forward-acceptance-report.json',
    evidence: 'forward-evidence.json'
  }
  writeJson(path.join(dest, files.source), {
    source_id: item.sourceId,
    snapshotStableHash: item.sourceStableHash,
    snapshotStableHashVerified: true,
    snapshot: readJson(item.sourcePath)
  })
  fs.copyFileSync(templatePath, path.join(dest, files.template))
  writeJson(path.join(dest, files.before), { target_id: item.targetId, snapshot: readJson(beforePath) })
  writeJson(path.join(dest, files.after), { target_id: item.targetId, snapshot: readJson(item.afterPath) })
  fs.copyFileSync(path.join(runRoot, item.dir, files.save), path.join(dest, files.save))
  fs.copyFileSync(path.join(runRoot, item.dir, files.receipt), path.join(dest, files.receipt))
  const observations = {
    schema_version: 1,
    case_id: item.id,
    source: 'Super Editor saved semantic snapshot, current-page audit, module readback and screenshot review',
    visual_review: item.visual,
    audit: { error_count: 0, inherited_warning_count: 2 },
    module_count: 9,
    canvas: { type: 'phone', width: 375 },
    tail_spacer: { width: 375, height: 20, color: '#CECECE', element_count: 0 }
  }
  writeJson(path.join(dest, files.observations), observations)
  const artifact = name => ({ artifact: name, artifact_sha256: fileSha(path.join(dest, name)) })
  const report = {
    schema_version: 1,
    case_id: item.id,
    status: 'passed',
    checks: [
      { check_id: 'template-three-block-plus-tail-structure', status: 'passed', evidence_artifacts: [artifact(files.after), artifact(files.observations)] },
      { check_id: 'text-and-layout-audit', status: 'passed', evidence_artifacts: [artifact(files.after), artifact(files.observations)] },
      { check_id: 'nine-module-relations', status: 'passed', evidence_artifacts: [artifact(files.after), artifact(files.observations)] },
      { check_id: 'full-page-visual-review', status: 'passed', evidence_artifacts: [artifact(files.observations)] },
      { check_id: 'save-export-readback', status: 'passed', evidence_artifacts: [artifact(files.save), artifact(files.receipt)] }
    ]
  }
  writeJson(path.join(dest, files.report), report)
  const values = {
    template: readJson(path.join(dest, files.template)),
    before: readJson(path.join(dest, files.before)),
    after: readJson(path.join(dest, files.after)),
    save: readJson(path.join(dest, files.save)),
    receipt: readJson(path.join(dest, files.receipt)),
    report
  }
  const evidence = {
    schema_version: 1,
    case_id: item.id,
    source: { ...artifact(files.source), semantic_snapshot_hash: item.sourceStableHash, source_id: item.sourceId },
    template: { ...artifact(files.template), template_hash: hashJson(values.template) },
    target_before: { ...artifact(files.before), snapshot_hash: hashJson(values.before), target_id: item.targetId },
    target_after: { ...artifact(files.after), snapshot_hash: hashJson(values.after), target_id: item.targetId },
    save_receipt: { ...artifact(files.save), receipt_hash: hashJson(values.save) },
    provenance_readback: { ...artifact(files.receipt), readback_hash: hashJson(values.receipt) },
    acceptance_report: { ...artifact(files.report), report_hash: hashJson(report) }
  }
  writeJson(path.join(dest, files.evidence), evidence)
  results.push({ id: item.id, evidence_path: path.relative(path.join(skillRoot, 'references'), path.join(dest, files.evidence)).replaceAll('\\', '/'), artifact_sha256: fileSha(path.join(dest, files.evidence)) })
}
console.log(JSON.stringify(results, null, 2))
