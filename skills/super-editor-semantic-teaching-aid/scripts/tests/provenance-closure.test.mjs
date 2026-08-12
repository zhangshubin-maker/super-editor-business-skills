import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { compileSpecializedSkill } from '../compile-specialized-skill.mjs'
import { hashCapabilitySnapshot, hashJson } from '../semantic-rule-tools.mjs'
import {
  createProvenance as createProvenanceRuntime,
  hashEditorExportBlocks,
  matchSourceCandidates,
  validateProvenance,
  validateProvenanceReadback
} from '../provenance-tools.mjs'
import { materializeExecutablePack } from './semantic-fixtures.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const skillRoot = path.resolve(__dirname, '..', '..')
const temporaryDirectories = []

function tempDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true })
})

function sha(character) {
  return `sha256:${character.repeat(64)}`
}

function pack({ status = 'trial_approved', twoRules = false } = {}) {
  const value = JSON.parse(fs.readFileSync(path.join(skillRoot, 'references', 'rule-pack.example.json'), 'utf8'))
  value.identity.status = status
  value.templates.default.snapshot_hash = sha('a')
  value.templates.variants.forEach((variant) => { variant.snapshot_hash = sha('b') })
  value.execution.trial_approval = { approved: true, evidence: ['explicit test fixture approval'] }
  if (twoRules) {
    const second = structuredClone(value.rules[0])
    second.id = 'copy-primary-button-module'
    second.order = 20
    second.intent = '复制来源主操作按钮的数字模块关系'
    second.validate = [{
      id: 'module-relation-readback',
      intent: '数字模块关系保存后与来源一致',
      severity: 'error',
      required_capabilities: ['editor_get_canvas_tree']
    }]
    value.rules.push(second)
    value.execution.capability_snapshot.capabilities.push('editor_get_canvas_tree')
    value.execution.capability_snapshot.snapshot_hash = hashCapabilitySnapshot(
      value.execution.capability_snapshot.capabilities
    )
  }
  if (status === 'validated') {
    const artifactRoot = tempDirectory('semantic-provenance-forward-')
    materializeExecutablePack(value, artifactRoot, { validated: true })
    Object.defineProperty(value, '__artifactRoot', { value: artifactRoot })
  }
  return value
}

function createProvenance(packValue, run) {
  return createProvenanceRuntime(packValue, run, { rulePackArtifactRoot: packValue.__artifactRoot })
}

function strictIdentity(side) {
  return {
    side,
    book_id: `${side}-book`,
    catalog_id: `${side}-catalog`,
    block_id: `${side}-title-block`,
    entity_kind: 'text',
    entity_id: `${side}-title-text`
  }
}

function strictBinding(side) {
  const value = {
    semantic_role: `${side} lesson title`,
    identity: strictIdentity(side),
    snapshot_hash: side === 'source' ? sha('6') : sha('7')
  }
  return { ...value, binding_hash: hashJson(value) }
}

function strictEvidence(identity) {
  const value = {
    kind: 'semantic_readback',
    summary: 'semantic role and cardinality match',
    identity,
    artifact_hash: sha('8')
  }
  return { ...value, evidence_hash: hashJson(value) }
}

function mcpEnvelope(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] }
}

// Contract simulation only: these envelopes model exact plugin responses, but
// they do not replace the required editor calls in a real browser run.
function simulatedReadback(created, blocks = null) {
  const exportedBlocks = blocks ?? [{
    uuid: 'carrier-root',
    template_data_content: {
      existing_field: { preserved: true },
      ai_semantic_provenance: created.provenance
    }
  }]
  const pageHash = hashEditorExportBlocks(exportedBlocks)
  return {
    exportEnvelope: mcpEnvelope({ slideId: 'target-catalog', blocks: exportedBlocks }),
    saveEnvelope: mcpEnvelope({
      scope: 'current',
      slideId: 'target-catalog',
      saved: true,
      savedScope: 'current',
      savedSlides: ['target-catalog'],
      verified: true,
      verifiedScope: 'current',
      verifiedSlides: ['target-catalog'],
      contentHash: pageHash,
      persistedContentHash: pageHash,
      dirty: false,
      warnings: []
    })
  }
}

function baseRun(overrides = {}) {
  return {
    run_id: 'run-closure-1',
    carrier_block_id: 'carrier-root',
    execution_mode: 'trial',
    source: {
      book_id: 'source-book',
      catalog_id: 'source-catalog',
      catalog_path: ['第一单元', '第1课'],
      snapshot_hash: sha('1')
    },
    template: {
      requested_template_id: '41073',
      resolved_template_id: '41073',
      variant_id: null,
      snapshot_hash: sha('2')
    },
    target: {
      book_id: 'target-book',
      catalog_id: 'target-catalog',
      before_hash: sha('3'),
      result_hash: sha('4')
    },
    rule_bindings: [{
      rule_id: 'replace-lesson-title',
      status: 'applied',
      action_summary: '替换标题',
      source_bindings: [strictBinding('source')],
      target_bindings: [strictBinding('target')],
      evidence: [strictEvidence(strictIdentity('target'))],
      result_hash: sha('5')
    }],
    baseline: { title: { text: 'before' } },
    instance_fixes: [],
    user_approvals: [{
      id: 'trial-approval',
      type: 'trial_authorization',
      status: 'confirmed',
      scope: 'trial',
      confirmed_by: 'user',
      confirmed_at: '2026-08-12T01:00:00.000Z',
      evidence: ['用户批准本目录试制写入']
    }],
    validation: [
      {
        id: 'title-visible-once',
        rule_id: 'replace-lesson-title',
        status: 'passed',
        evidence: ['唯一主标题已回读']
      },
      {
        id: 'page-save-readback',
        status: 'passed',
        evidence: ['保存、审计与导出回读通过']
      }
    ],
    created_at: '2026-08-12T01:00:00.000Z',
    ...overrides
  }
}

describe('provenance execution and coverage closure', () => {
  test('requires non-empty full rule coverage and mode-specific approval', () => {
    const twoRulePack = pack({ twoRules: true })
    assert.throws(
      () => createProvenance(twoRulePack, baseRun({
        validation: [
          ...baseRun().validation,
          {
            id: 'module-relation-readback',
            rule_id: 'copy-primary-button-module',
            status: 'passed',
            evidence: ['数字模块关系回读一致']
          }
        ]
      })),
      /must cover every rule.*copy-primary-button-module/
    )
    assert.throws(
      () => createProvenance(pack(), baseRun({ rule_bindings: [] })),
      /rule_bindings must be a non-empty array/
    )
    assert.throws(
      () => createProvenance(pack(), baseRun({ user_approvals: [] })),
      /user_approvals must be a non-empty array/
    )
    assert.throws(
      () => createProvenance(pack(), baseRun({
        validation: [{ id: 'page-save-readback', status: 'passed', evidence: ['page passed'] }]
      })),
      /must cover required error check: rule:replace-lesson-title:title-visible-once/
    )
    assert.throws(
      () => createProvenance(pack({ status: 'validated' }), baseRun({
        execution_mode: 'batch',
        user_approvals: [{
          id: 'wrong-kind',
          type: 'trial_authorization',
          status: 'confirmed',
          confirmed_by: 'user',
          confirmed_at: '2026-08-12T01:00:00.000Z',
          evidence: ['only trial']
        }]
      })),
      /must include a confirmed batch_authorization/
    )
  })

  test('covers every required error-level check and restricts legacy gaps', () => {
    const created = createProvenance(pack(), baseRun({
      execution_mode: 'legacy_inferred',
      user_approvals: [{
        id: 'legacy-confirmation',
        type: 'legacy_source_confirmation',
        status: 'confirmed',
        scope: 'legacy_inferred',
        confirmed_by: 'user',
        confirmed_at: '2026-08-12T01:00:00.000Z',
        evidence: ['用户确认把旧运行补录为受限来源记录']
      }],
      validation: [{
        id: 'page-save-readback',
        status: 'passed',
        evidence: ['page passed']
      }]
    }))
    assert.deepEqual(
      created.provenance.coverage.required_error_checks.map((check) => check.required_key),
      ['rule:replace-lesson-title:title-visible-once', 'acceptance:page-save-readback']
    )
    const inferred = created.provenance.validation.find((check) => check.id === 'title-visible-once')
    assert.equal(inferred.status, 'not_tested')
    assert.equal(inferred.coverage_origin, 'legacy_inferred')
    assert.equal(created.provenance.execution.restricted, true)
    assert.deepEqual(created.provenance.execution.restriction_reasons, [
      'required_error_validation_incomplete',
      'legacy_inferred_record_manual_only'
    ])
    assert.equal(validateProvenance(created).valid, true)
  })

  test('requires validated rules, batch authorization and passed error checks for batch', () => {
    assert.throws(
      () => createProvenance(pack(), baseRun({ execution_mode: 'batch' })),
      /batch provenance requires a validated rule pack/
    )
    const created = createProvenance(pack({ status: 'validated' }), baseRun({
      execution_mode: 'batch',
      user_approvals: [{
        id: 'batch-approved',
        type: 'batch_authorization',
        status: 'confirmed',
        scope: 'batch:book-list-001',
        confirmed_by: 'user',
        confirmed_at: '2026-08-12T01:00:00.000Z',
        evidence: ['用户批准指定书单批量生成']
      }]
    }))
    assert.equal(created.provenance.execution.batch_authorized, true)
    assert.equal(created.provenance.execution.required_error_validation_passed, true)
    assert.equal(created.provenance.execution.post_write_verification_pending, true)
    assert.equal(created.provenance.execution.restricted, false)
  })
})

describe('legacy source inference audit', () => {
  test('never calls a zero-evidence candidate unique and preserves the full audit input', () => {
    const result = matchSourceCandidates({
      query: {},
      candidates: [{ candidate_id: 'source-book' }]
    })
    assert.equal(result.top_score, 0)
    assert.equal(result.unique, false)
    assert.equal(result.top_candidate_id, null)
    assert.equal(result.automatic_write, false)
    assert.deepEqual(result.inference.query, {})
    assert.equal(result.inference.candidate_set.length, 1)
    assert.equal(result.inference.scores[0].score, 0)
    assert.equal(result.inference.manual_confirmation, null)
    assert.deepEqual(result.inference.query_input, {})
    assert.deepEqual(result.inference.candidate_set_input, [{ candidate_id: 'source-book' }])
  })

  test('embeds auditable query, candidates, scores, evidence and manual confirmation', () => {
    const matched = matchSourceCandidates({
      query: {
        book_name: '三年级数学上册同步练习',
        subject: '数学',
        grade: '三年级',
        volume: '上册',
        catalog_path: ['第一单元', '第1课']
      },
      candidates: [
        {
          candidate_id: 'source-book',
          book_name: '三年级数学上册同步练习',
          subject: '数学',
          grade: '三年级',
          volume: '上册',
          catalog_path: ['第一单元', '第1课']
        },
        {
          candidate_id: 'other-book',
          book_name: '四年级数学上册同步练习',
          subject: '数学',
          grade: '四年级',
          volume: '上册'
        }
      ],
      manual_confirmation: {
        candidate_id: 'source-book',
        confirmed_by: 'user',
        confirmed_at: '2026-08-12T02:00:00.000Z',
        reason: '核对教材封面和目录后确认'
      }
    })
    const created = createProvenance(pack(), baseRun({
      execution_mode: 'legacy_inferred',
      source: { ...baseRun().source, inference: matched.inference },
      user_approvals: [{
        id: 'source-confirmation',
        type: 'legacy_source_confirmation',
        status: 'confirmed',
        scope: 'legacy_inferred',
        confirmed_by: 'user',
        confirmed_at: '2026-08-12T02:00:00.000Z',
        evidence: ['核对教材封面和目录后确认 source-book']
      }]
    }))
    assert.equal(created.provenance.source.inference.automatic_write, false)
    assert.equal(created.provenance.source.inference.selected_candidate_id, 'source-book')
    assert.equal(created.provenance.source.inference.scores.length, 2)
    assert.equal(created.provenance.source.inference.candidate_set_input.length, 2)
    assert.match(created.provenance.execution.restriction_reasons.join(','), /legacy_inferred_record_manual_only/)
    assert.equal(validateProvenance(created).valid, true)
  })
})

describe('post-write provenance readback closure', () => {
  test('requires a second save/export/readback and detects stale or tampered carriers', () => {
    const created = createProvenance(pack(), baseRun())
    assert.deepEqual(
      created.post_write_verification.sequence.map((step) => step.tool ?? step.command.split(' ')[1]),
      ['editor_update_block', 'editor_save_verified', 'editor_export_slide', 'scripts/provenance-tools.mjs']
    )
    const fixture = simulatedReadback(created)
    const options = {
      saveReceipt: fixture.saveEnvelope,
      carrierBlockId: 'carrier-root',
      verifiedAt: '2026-08-12T03:00:00.000Z'
    }
    const valid = validateProvenanceReadback(fixture.exportEnvelope, created, options)
    assert.equal(valid.valid, true)
    assert.match(valid.matched_path, /ai_semantic_provenance/)
    assert.equal(valid.receipt.kind, 'semantic_provenance_readback_receipt')

    const duplicateBlocks = structuredClone(JSON.parse(fixture.exportEnvelope.content[0].text).blocks)
    duplicateBlocks.push({
      uuid: 'duplicate-provenance',
      template_data_content: { ai_semantic_provenance: created.provenance }
    })
    const duplicate = simulatedReadback(created, duplicateBlocks)
    assert.match(validateProvenanceReadback(duplicate.exportEnvelope, created, {
      ...options,
      saveReceipt: duplicate.saveEnvelope
    }).errors.join('\n'), /exactly one direct provenance carrier/)

    const stale = structuredClone(created)
    stale.provenance.run_id = 'different-run'
    assert.equal(validateProvenanceReadback(fixture.exportEnvelope, stale, options).valid, false)

    const tamperedBlocks = structuredClone(JSON.parse(fixture.exportEnvelope.content[0].text).blocks)
    const carrier = tamperedBlocks[0].template_data_content
    carrier.ai_semantic_provenance.target.result_hash = sha('9')
    const tampered = simulatedReadback(created, tamperedBlocks)
    assert.equal(validateProvenanceReadback(tampered.exportEnvelope, created, {
      ...options,
      saveReceipt: tampered.saveEnvelope
    }).valid, false)
  })

  test('compiled skill is self-contained with the same provenance workflow and validator', () => {
    const result = compileSpecializedSkill(pack(), tempDirectory('semantic-provenance-compiled-'))
    for (const filename of [
      'references/workflow.md',
      'references/batch-and-provenance.md',
      'scripts/provenance-tools.mjs'
    ]) {
      assert.equal(fs.existsSync(path.join(result.output, filename)), true, filename)
    }
    const generatedSkill = fs.readFileSync(path.join(result.output, 'SKILL.md'), 'utf8')
    assert.match(generatedSkill, /editor_save_verified/)
    assert.match(generatedSkill, /validate-readback/)
    const generatedProvenance = fs.readFileSync(path.join(result.output, 'scripts', 'provenance-tools.mjs'), 'utf8')
    assert.match(generatedProvenance, /validateProvenanceReadback/)

    const created = createProvenance(pack(), baseRun())
    const exportedFile = path.join(result.output, 'readback-fixture.json')
    const saveReceiptFile = path.join(result.output, 'save-receipt-fixture.json')
    const expectedFile = path.join(result.output, 'expected-provenance.json')
    const fixture = simulatedReadback(created)
    fs.writeFileSync(exportedFile, JSON.stringify(fixture.exportEnvelope), 'utf8')
    fs.writeFileSync(saveReceiptFile, JSON.stringify(fixture.saveEnvelope), 'utf8')
    fs.writeFileSync(expectedFile, JSON.stringify(created), 'utf8')
    const cli = spawnSync(process.execPath, [
      path.join(result.output, 'scripts', 'provenance-tools.mjs'),
      'validate-readback',
      '--input', exportedFile,
      '--save-receipt', saveReceiptFile,
      '--expected', expectedFile,
      '--carrier-block-id', 'carrier-root',
      '--verified-at', '2026-08-12T03:00:00.000Z'
    ], { encoding: 'utf8' })
    assert.equal(cli.status, 0, cli.stderr)
    const receipt = JSON.parse(cli.stdout)
    assert.equal(receipt.kind, 'semantic_provenance_readback_receipt')
    assert.equal(receipt.artifact_integrity.algorithm, 'sha256-canonical-json')
    assert.equal('valid' in receipt, false)
  })
})
