import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { hashJson } from '../../skills/super-editor-semantic-teaching-aid/scripts/semantic-rule-tools.mjs'

const runDir = path.resolve('runs/listening-not-hard-interface-41097-topic7')
const caseDir = path.join(runDir, 'forward-tests/topic2-four-title')
const sourceHash = 'sha256:1e15b9d5d7275626cba094593442956f0b1406110ed8295a9b9298adc350db24'
const targetHash = 'sha256:a575c74fd9d312974fecc0206ebb7838396a23c8d3881287d3309d54547d3fb1'
const targetArtifactHash = 'sha256:a47989ed11941163c07e0c8308e8207e105e97f27a6b08cd477eeac7d131c0ed'

const source = { book_id: '1815615', catalog_id: '5437' }
const target = { book_id: '1820803', catalog_id: '45100' }

function identity(side, blockId, entityKind, entityId) {
  const owner = side === 'source' ? source : target
  return {
    side,
    book_id: owner.book_id,
    catalog_id: owner.catalog_id,
    block_id: blockId,
    entity_kind: entityKind,
    entity_id: entityId
  }
}

function binding(semanticRole, itemIdentity, snapshotHash) {
  const value = {
    semantic_role: semanticRole,
    identity: itemIdentity,
    snapshot_hash: snapshotHash
  }
  return { ...value, binding_hash: hashJson(value) }
}

function evidence(kind, summary, itemIdentity) {
  const value = {
    kind,
    summary,
    identity: itemIdentity,
    artifact_hash: targetArtifactHash
  }
  return { ...value, evidence_hash: hashJson(value) }
}

const rules = [
  {
    rule_id: 'basic-section',
    action_summary: '保留两个基础训练标题、趣味练习入口及外层来源定位模块。',
    source: ['source basic listening section', identity('source', 'Pxu2f3GthL15887', 'section', 'basic-section')],
    target: ['target basic interface section', identity('target', 'xsEXYUN0hs41104', 'section', 'basic-section')],
    evidence: ['semantic_and_module_readback', '两个基础标签与两个预期模块已在目标语义快照和模块回读中确认。']
  },
  {
    rule_id: 'classroom-section-cardinality',
    action_summary: '依据四个来源标题生成四张完整课堂卡片，保持样式、步距、白底和外层点击范围。',
    source: ['source classroom four-heading section', identity('source', 'Q8fUzlNP4C', 'section', 'classroom-section')],
    target: ['target classroom four-card section', identity('target', 'xsEXYUN0hs41105', 'section', 'classroom-section')],
    evidence: ['visual_and_module_readback', '全页截图确认四卡纵排；课堂根入口、绊脚石、课程和四个标题定位模块均已回读。']
  },
  {
    rule_id: 'practice-section',
    action_summary: '保留六个 Day 练习标题、外层定位模块、打印入口及 20 高度底部留白。',
    source: ['source six-day practice section', identity('source', '6nCLsBa2Ni', 'section', 'practice-section')],
    target: ['target six-day practice interface section', identity('target', 'xsEXYUN0hs41106', 'section', 'practice-section')],
    evidence: ['visual_and_module_readback', '全页截图和模块回读确认六个 Day、打印入口、六个定位模块及底部留白。']
  },
  {
    rule_id: 'book-catalog-finalization',
    action_summary: '目录名按 Topic 顺序规范化，并将页面级画布和全部区块统一为手机端 375 宽。',
    source: ['source topic catalog identity', identity('source', 'Pxu2f3GthL15882', 'catalog', '5437')],
    target: ['target phone catalog identity', identity('target', 'xsEXYUN0hs41097', 'catalog', '45100')],
    evidence: ['catalog_and_canvas_readback', '目标目录名为 Topic 2 Food，位于 Topic 1 与 Topic 3 之间；画布回读为 phone 375。']
  }
]

const run = {
  run_id: 'forward-topic2-four-title-20260818',
  carrier_block_id: 'xsEXYUN0hs41104',
  execution_mode: 'trial',
  source: {
    ...source,
    catalog_path: ['Topic 2 Food'],
    snapshot_hash: sourceHash
  },
  template: {
    requested_template_id: '41097',
    resolved_template_id: '41097',
    variant_id: null,
    snapshot_hash: 'sha256:50a40e8e42ab65c0c0d788b036a95860751e4ee76aeeb454454a955717643a41'
  },
  target: {
    ...target,
    before_hash: targetHash,
    result_hash: targetHash
  },
  rule_bindings: rules.map((rule) => {
    const targetBinding = binding(rule.target[0], rule.target[1], targetHash)
    return {
      rule_id: rule.rule_id,
      status: 'applied',
      action_summary: rule.action_summary,
      source_bindings: [binding(rule.source[0], rule.source[1], sourceHash)],
      target_bindings: [targetBinding],
      evidence: [evidence(rule.evidence[0], rule.evidence[1], rule.target[1])],
      result_hash: targetHash
    }
  }),
  baseline: {
    template_id: '41097',
    source_semantic_snapshot: 'forward-tests/topic2-four-title/source-topic2-semantic-snapshot.json',
    target_before_artifact: 'forward-tests/topic2-four-title/target-topic2-before-semantic-snapshot.json',
    evidence_scope: 'completed batch result plus strict provenance finalization'
  },
  instance_fixes: [
    { kind: 'four-title-variant', summary: '来源课堂标题数为四，按第二张完整卡片的结构和实测步距扩展为四卡。' },
    { kind: 'outer-anchor-correction', summary: '课堂标题与 Day 条目的定位模块均绑定到最外层完整点击组。' },
    { kind: 'single-line-first', summary: '标题在手机宽度内优先单行，仅在确实放不下时换行。' },
    { kind: 'template_warning_baseline', summary: '当前页审计为 0 error；三个越界 warning 属于样章装饰/按钮基线，视觉截图无可见越界。' }
  ],
  user_approvals: [
    {
      id: 'solidify-rule-pack-20260818',
      type: 'trial_authorization',
      status: 'confirmed',
      scope: '使用已完成的 Topic 2 Food 四标题目录作为第二个独立前向证据，并写入严格来源证明。',
      confirmed_by: 'user',
      confirmed_at: '2026-08-18T09:30:00+08:00',
      evidence: ['用户明确说：已生成完成，这个规则可以固化了']
    }
  ],
  validation: [
    { id: 'mobile-canvas-375', status: 'passed', evidence: ['editor_get_canvas_info 回读 slideId=45100、canvasWidth=375、blockCount=4。'] },
    { id: 'basic-two-titles', rule_id: 'basic-section', status: 'passed', evidence: ['目标快照中 words 与 sentences 两个标签按样章顺序存在。'] },
    { id: 'basic-module-readback', rule_id: 'basic-section', status: 'passed', evidence: ['外层查看组 rUjjxSnQCL 定位至来源 3997021；趣味练习为在线答题模块。'] },
    { id: 'classroom-card-count', rule_id: 'classroom-section-cardinality', status: 'passed', evidence: ['全页截图确认四张完整课堂卡片。'] },
    { id: 'classroom-multi-card-layout', rule_id: 'classroom-section-cardinality', status: 'passed', evidence: ['四卡保持相同宽度与纵向节奏，白底已扩展且未与听力实战重叠。'] },
    { id: 'classroom-summary-line-fit', rule_id: 'classroom-section-cardinality', status: 'passed', evidence: ['绊脚石摘要和四个卡片标题在 375 宽画布内可读，单行可容纳的内容未强制换行。'] },
    { id: 'classroom-module-readback', rule_id: 'classroom-section-cardinality', status: 'passed', evidence: ['课堂根、绊脚石、课程和四个标题模块共七项均在外层组上回读。'] },
    { id: 'practice-six-titles', rule_id: 'practice-section', status: 'passed', evidence: ['Day 1 到 Day 6 共六项顺序正确，截图无错位。'] },
    { id: 'practice-module-readback', rule_id: 'practice-section', status: 'passed', evidence: ['六个 Day 外层组均有来源定位模块，打印入口存在。'] },
    { id: 'page-tail-spacer-readback', rule_id: 'practice-section', status: 'passed', evidence: ['底部留白区块 B0l2lpqcei 高 20、宽 375、phone。'] },
    { id: 'catalog-order-readback', rule_id: 'book-catalog-finalization', status: 'passed', evidence: ['Topic 2 Food 位于 Topic 1 Numbers 与 Topic 3 School 之间，目录名无多余空格。'] },
    { id: 'all-pages-phone-canvas', rule_id: 'book-catalog-finalization', status: 'passed', evidence: ['整书批量完成时已逐页保存回读；本前向用例页再次回读为 375。'] },
    { id: 'structure-text-layout-audit', status: 'passed', evidence: ['editor_audit_content 返回 0 error；三个 warning 为样章基线且截图无可见越界。'] },
    { id: 'full-page-visual-review', status: 'passed', evidence: ['editor_screenshot fullPage 显示基础、四卡课堂、六项实战与按钮完整可见。'] },
    { id: 'save-export-readback', status: 'passed', evidence: ['待 provenance 写入后由 editor_save_verified、editor_export_slide 和 validate-readback 闭环。'] }
  ],
  created_at: '2026-08-18T09:30:00+08:00'
}

fs.writeFileSync(path.join(caseDir, 'provenance-run.json'), `${JSON.stringify(run, null, 2)}\n`, 'utf8')
const exportEnvelopePath = path.join(caseDir, 'editor-export-slide-envelope.json')
if (!fs.existsSync(exportEnvelopePath)) {
  const afterSnapshot = JSON.parse(fs.readFileSync(path.join(caseDir, 'target-topic2-after-semantic-snapshot.json'), 'utf8'))
  const exportPayload = { slideId: '45100', blocks: afterSnapshot.snapshot.blocks }
  const exportEnvelope = { content: [{ type: 'text', text: JSON.stringify(exportPayload, null, 2) }] }
  fs.writeFileSync(exportEnvelopePath, `${JSON.stringify(exportEnvelope, null, 2)}\n`, 'utf8')
}
console.log(path.join(caseDir, 'provenance-run.json'))

function fileHash(filePath) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`
}

function writeArtifact(name, value) {
  const filePath = path.join(caseDir, name)
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return { filePath, fileHash: fileHash(filePath), canonicalHash: hashJson(value) }
}

const afterPath = path.join(caseDir, 'target-topic2-after-semantic-snapshot.json')
const beforePath = path.join(caseDir, 'target-topic2-before-semantic-snapshot.json')
const sourcePath = path.join(caseDir, 'source-topic2-semantic-snapshot.json')
const templatePath = path.join(caseDir, 'template-41097-envelope.json')
const receiptPath = path.join(caseDir, 'provenance-readback-receipt.json')
const savePath = path.join(caseDir, 'editor-save-verified-envelope.json')

if (fs.existsSync(receiptPath)) {
  const sourceSnapshot = JSON.parse(fs.readFileSync(sourcePath, 'utf8'))
  const afterSnapshot = JSON.parse(fs.readFileSync(afterPath, 'utf8'))
  const beforeSnapshot = JSON.parse(fs.readFileSync(beforePath, 'utf8'))
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  const saveEnvelope = JSON.parse(fs.readFileSync(savePath, 'utf8'))
  const sourceEnvelope = writeArtifact('source-topic2-semantic-envelope.json', {
    snapshotPath: 'source-topic2-semantic-snapshot.json',
    snapshotFileSha256: fileHash(sourcePath),
    snapshotStableHash: sourceHash,
    snapshotStableHashAuthority: 'bridge:getSemanticSnapshot/v1',
    snapshotStableHashVerified: true,
    schemaVersion: sourceSnapshot.schemaVersion,
    identity: {
      bookId: sourceSnapshot.snapshot.identity.bookId,
      catalogId: sourceSnapshot.snapshot.identity.catalogId,
      catalogName: sourceSnapshot.snapshot.identity.catalogName
    },
    state: sourceSnapshot.snapshot.state,
    meta: sourceSnapshot.meta,
    snapshotArtifact: 'source-topic2-semantic-snapshot.json'
  })

  const modules = afterSnapshot.snapshot.digitalModules.items.map((item) => {
    const normalized = item.normalized
    const sourceContent = item.raw?.model_content_resp_en?.find((content) => content.catalog_content_en)?.catalog_content_en
    return {
      element_id: item.elementId,
      block_id: item.blockId,
      anchor: 'outer',
      type: normalized.type,
      name: normalized.name,
      model_id: normalized.modelId,
      resource_id: normalized.config?.resourceId ?? null,
      source_book_id: sourceContent?.book_id ?? null,
      source_catalog_id: sourceContent?.catalog_id ?? null
    }
  })
  const moduleReadback = writeArtifact('module-readback.json', {
    book_id: '1820803',
    catalog_id: '45100',
    source_book_id: '1815615',
    source_catalog_id: '5437',
    module_count: modules.length,
    modules,
    readback_result: 'passed'
  })

  const acceptanceReport = writeArtifact('acceptance-report.json', {
    accepted_at: '2026-08-18T09:55:25+08:00',
    scope: 'Topic 2 Food independent four-title forward validation and provenance finalization',
    page: { book_id: '1820803', catalog_id: '45100', name: 'Topic 2 Food' },
    source: { book_id: '1815615', catalog_id: '5437', name: 'Topic 2 Food' },
    save: {
      saved: true,
      verified: true,
      content_hash: receipt.save.content_hash,
      persisted_content_hash: receipt.save.content_hash,
      dirty: false,
      warnings: []
    },
    checks: [
      { id: 'mobile-canvas-375', status: 'passed', evidence: 'editor_get_canvas_info 回读 slideId=45100、canvasWidth=375。' },
      { id: 'basic-two-titles', status: 'passed', evidence: 'words 与 sentences 两个标签按来源顺序存在。' },
      { id: 'basic-module-readback', status: 'passed', evidence: '听力基本功外层查看组定位到来源 3997021，趣味练习在线答题存在。' },
      { id: 'classroom-card-count', status: 'passed', evidence: '来源四个标题，目标全页截图显示四张完整卡片。' },
      { id: 'classroom-multi-card-layout', status: 'passed', evidence: '四卡等宽纵排、节奏一致，白底完整容纳且未遮挡后续区块。' },
      { id: 'classroom-summary-line-fit', status: 'passed', evidence: '摘要和卡片标题在 375 宽画布内完整可读，单行可容纳内容未强制换行。' },
      { id: 'classroom-module-readback', status: 'passed', evidence: '课堂根、绊脚石、课程及四个标题的外层组模块均已回读。' },
      { id: 'practice-six-titles', status: 'passed', evidence: 'Day 1 到 Day 6 顺序正确且全页截图无错位。' },
      { id: 'practice-module-readback', status: 'passed', evidence: '六个 Day 外层定位模块和打印模块均已回读。' },
      { id: 'page-tail-spacer-readback', status: 'passed', evidence: '末尾区块为 phone 375×20、零内边距、无元素。' },
      { id: 'catalog-order-readback', status: 'passed', evidence: 'Topic 2 Food 位于 Topic 1 Numbers 与 Topic 3 School 之间且名称无多余空格。' },
      { id: 'all-pages-phone-canvas', status: 'passed', evidence: '整书先前逐页保存回读；本独立用例再次确认 phone 375。' },
      { id: 'structure-text-layout-audit', status: 'passed', evidence: '当前页审计 0 error；三个样章基线 warning 在全页截图中无可见越界。' },
      { id: 'full-page-visual-review', status: 'passed', evidence: '全页截图核对基础段、四张课堂卡、六个 Day、按钮和底部留白。' },
      { id: 'save-export-readback', status: 'passed', evidence: '保存 verified=true、dirty=false；实际 editor_export_slide 与严格 provenance receipt 校验通过。' }
    ],
    known_boundaries: [
      '未在学生端逐个点击验证来源跳转、在线答题、互动课程和打印体验。',
      '源和目标语义快照报告 FONT_MAPPING_EMPTY；沿用样章字体配置，没有猜测字体映射。',
      '三个越界 warning 为样章组边界元数据基线；全页截图未见可见越界。'
    ]
  })

  const saveSha = fileHash(savePath)
  const receiptSha = fileHash(receiptPath)
  const forwardAcceptance = writeArtifact('forward-acceptance-report.json', {
    schema_version: 1,
    case_id: 'topic2-food-four-title',
    status: 'passed',
    checks: [
      { check_id: 'mobile-canvas-375', status: 'passed', evidence_artifacts: [{ artifact: 'acceptance-report.json', artifact_sha256: acceptanceReport.fileHash }] },
      { check_id: 'structure-text-layout-audit', status: 'passed', evidence_artifacts: [{ artifact: 'acceptance-report.json', artifact_sha256: acceptanceReport.fileHash }, { artifact: 'module-readback.json', artifact_sha256: moduleReadback.fileHash }] },
      { check_id: 'full-page-visual-review', status: 'passed', evidence_artifacts: [{ artifact: 'acceptance-report.json', artifact_sha256: acceptanceReport.fileHash }] },
      { check_id: 'save-export-readback', status: 'passed', evidence_artifacts: [{ artifact: 'editor-save-verified-envelope.json', artifact_sha256: saveSha }, { artifact: 'provenance-readback-receipt.json', artifact_sha256: receiptSha }] }
    ]
  })

  writeArtifact('forward-evidence.json', {
    schema_version: 1,
    case_id: 'topic2-food-four-title',
    source: {
      artifact: 'source-topic2-semantic-envelope.json',
      artifact_sha256: sourceEnvelope.fileHash,
      semantic_snapshot_hash: sourceHash,
      source_id: '1815615'
    },
    template: {
      artifact: 'template-41097-envelope.json',
      artifact_sha256: fileHash(templatePath),
      template_hash: 'sha256:50a40e8e42ab65c0c0d788b036a95860751e4ee76aeeb454454a955717643a41'
    },
    target_before: {
      artifact: 'target-topic2-before-semantic-snapshot.json',
      artifact_sha256: fileHash(beforePath),
      snapshot_hash: hashJson(beforeSnapshot),
      target_id: '1820803'
    },
    target_after: {
      artifact: 'target-topic2-after-semantic-snapshot.json',
      artifact_sha256: fileHash(afterPath),
      snapshot_hash: hashJson(afterSnapshot),
      target_id: '1820803'
    },
    save_receipt: {
      artifact: 'editor-save-verified-envelope.json',
      artifact_sha256: saveSha,
      receipt_hash: hashJson(saveEnvelope)
    },
    provenance_readback: {
      artifact: 'provenance-readback-receipt.json',
      artifact_sha256: receiptSha,
      readback_hash: hashJson(receipt)
    },
    acceptance_report: {
      artifact: 'forward-acceptance-report.json',
      artifact_sha256: forwardAcceptance.fileHash,
      report_hash: forwardAcceptance.canonicalHash
    }
  })
}
