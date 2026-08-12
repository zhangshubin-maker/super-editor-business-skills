import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  LEGACY_MATCH_WEIGHTS,
  createProvenance,
  hashJson,
  matchLegacyCandidates,
  planUpdate,
  validateInput,
  validateProvenance
} from '../provenance-tools.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const cliPath = path.resolve(__dirname, '..', 'provenance-tools.mjs')
const temporaryDirectories = []

afterEach(() => {
  while (temporaryDirectories.length) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true })
  }
})

function sha(character) {
  return `sha256:${character.repeat(64)}`
}

function generatedSpec(overrides = {}) {
  return {
    block_id: 'block-101',
    mode: 'generated',
    run_id: 'run-20260812-001',
    source: {
      book_id: 21380,
      catalog_id: 99801,
      catalog_name: '第3周 能力达标',
      catalog_sort: 3,
      book_name: '三年级语文上册',
      subject: '语文',
      grade: '三年级',
      volume: '上册'
    },
    route: {
      requested_template_id: 41073,
      resolved_template_id: 41075,
      template_locked: false,
      catalog_route: { key: 'math-thinking-ability-target', priority: 3 },
      registry: {
        registry_sha256: sha('d').slice(7),
        routing_sha256: sha('e').slice(7),
        raw_sha256: sha('b').slice(7),
        analyse_sha256: sha('a').slice(7),
        pair_sha256: sha('f').slice(7)
      }
    },
    template: { sample_block_id: 41133 },
    artifacts: { source_hash: sha('9') },
    map: { schema_version: 2, blocks: [{ template_block_id: 41133 }] },
    baseline: {
      text: {
        'source-text-1': { plain_text: '分数的初步认识', marks: [] }
      },
      layout: {
        'source-text-1': { left: 48, top: 92, width: 310, height: 56, rotate: 0 }
      }
    },
    ...overrides
  }
}

function createGenerated(overrides = {}) {
  return createProvenance(generatedSpec(overrides)).provenance
}

function makeBlock(provenance, { uuid = 'block-101', stringContent = false } = {}) {
  const content = {
    name: '讲解区块',
    size: { width: 794, height: 300 },
    elements: [{ id: 'runtime-text-1', sourceId: 'source-text-1', type: 'text' }],
    ai_provenance: provenance
  }
  return {
    id: 501,
    uuid,
    template_type: 2,
    template_data_content: stringContent ? JSON.stringify(content) : content
  }
}

describe('provenance create and validate', () => {
  test('canonical JSON hash is independent of object key order but preserves arrays', () => {
    assert.equal(hashJson({ b: 2, a: { z: 3, y: 4 } }), hashJson({ a: { y: 4, z: 3 }, b: 2 }))
    assert.notEqual(hashJson({ items: [1, 2] }), hashJson({ items: [2, 1] }))
  })

  test('create builds route-aware provenance and exact editor_update_block patch', () => {
    const result = createProvenance(generatedSpec())
    const provenance = result.provenance

    assert.deepEqual(result.editor_update_block, {
      tool: 'editor_update_block',
      arguments: {
        blockId: 'block-101',
        patch: { ai_provenance: provenance }
      }
    })
    assert.equal(provenance.schema_version, 1)
    assert.equal(provenance.mode, 'generated')
    assert.equal(provenance.source.book_id, '21380')
    assert.equal(provenance.source.catalog_id, '99801')
    assert.equal(provenance.template.requested_template_id, '41073')
    assert.equal(provenance.template.resolved_template_id, '41075')
    assert.equal(provenance.template.sample_block_id, '41133')
    assert.deepEqual(provenance.template.catalog_route, { key: 'math-thinking-ability-target', priority: 3 })
    assert.equal(provenance.artifacts.rule_hash, sha('a'))
    assert.equal(provenance.artifacts.template_hash, sha('b'))
    assert.equal(provenance.artifacts.registry_hash, sha('d'))
    assert.equal(provenance.artifacts.routing_hash, sha('e'))
    assert.equal(provenance.artifacts.template_pair_hash, sha('f'))
    assert.equal(provenance.artifacts.source_hash, sha('9'))
    assert.equal(provenance.artifacts.map_hash, hashJson(generatedSpec().map))
    assert.equal(
      provenance.baseline.text_hashes['source-text-1'],
      hashJson({ plain_text: '分数的初步认识', marks: [] })
    )
    assert.equal(
      provenance.baseline.layout_hashes['source-text-1'],
      hashJson({ left: 48, top: 92, width: 310, height: 56, rotate: 0 })
    )
    assert.deepEqual(
      provenance.baseline.text_snapshots['source-text-1'],
      { marks: [], plain_text: '分数的初步认识' }
    )
    assert.deepEqual(
      provenance.baseline.layout_snapshots['source-text-1'],
      { height: 56, left: 48, rotate: 0, top: 92, width: 310 }
    )
    assert.equal('text' in provenance.baseline, false, 'input alias must be normalized to text_snapshots')
    assert.deepEqual(validateProvenance(provenance), { valid: true, errors: [], warnings: [] })
  })

  test('generated provenance rejects missing artifact hashes and inconsistent supplied baseline hashes', () => {
    assert.throws(
      () => createProvenance(generatedSpec({ artifacts: {} })),
      /artifacts\.source_hash must be a SHA-256 string/
    )
    assert.throws(
      () => createProvenance(generatedSpec({ map: undefined })),
      /artifacts\.map_hash must be a SHA-256 string/
    )
    assert.throws(
      () => createProvenance(generatedSpec({
        baseline: {
          text: { a: 'value' },
          text_hashes: { a: sha('9') },
          layout: {}
        }
      })),
      /baseline\.text_snapshots does not match baseline\.text_hashes/
    )

    const provenance = createGenerated()
    delete provenance.artifacts.source_hash
    const validation = validateProvenance(provenance)
    assert.equal(validation.valid, false)
    assert.match(validation.errors.join('\n'), /artifacts\.source_hash/)
  })

  test('locked templates cannot claim that a special catalog route changed the template', () => {
    assert.throws(
      () => createProvenance(generatedSpec({
        route: {
          ...generatedSpec().route,
          template_locked: true
        }
      })),
      /catalog_route must be null when template\.template_locked is true/
    )
    const lockedRoute = {
      ...generatedSpec().route,
      template_locked: true,
      resolved_template_id: 41073,
      catalog_route: null
    }
    const locked = createProvenance(generatedSpec({ route: lockedRoute })).provenance
    assert.equal(locked.template.template_locked, true)
    assert.equal(locked.template.catalog_route, null)
    assert.equal(locked.template.requested_template_id, locked.template.resolved_template_id)
  })

  test('legacy inference keeps unknowable historical hashes null and requires evidence', () => {
    const result = createProvenance({
      block_id: 'legacy-block',
      mode: 'legacy_inferred',
      run_id: 'legacy-audit-1',
      source: {
        book_id: 'old-source-book',
        catalog_id: 'old-source-catalog',
        catalog_name: '期中测试',
        catalog_sort: 8,
        subject: '英语',
        grade: '六年级',
        volume: '下册'
      },
      template: {
        requested_template_id: null,
        resolved_template_id: 36959,
        sample_block_id: 40101,
        template_locked: false,
        catalog_route: null
      },
      artifacts: {
        rule_hash: null,
        template_hash: sha('b'),
        map_hash: null
      },
      baseline: {
        text: { 'source-old': { plain_text: '当前成品作为追踪起点' } },
        layout: { 'source-old': { left: 10, top: 20, width: 300, height: 40 } }
      },
      inference: {
        confidence: 'high',
        evidence: ['book:subject+grade+volume', 'catalog:name+sort', 'elements:source_id_fingerprint']
      }
    })

    assert.equal(result.provenance.template.requested_template_id, null)
    assert.equal(result.provenance.artifacts.source_hash, null)
    assert.equal(result.provenance.artifacts.rule_hash, null)
    assert.equal(result.provenance.artifacts.map_hash, null)
    assert.deepEqual(result.provenance.inference.evidence[0], {
      rule: 'legacy_note',
      points: 0,
      note: 'book:subject+grade+volume'
    })
    const validation = validateProvenance(result.provenance)
    assert.equal(validation.valid, true)
    assert.deepEqual(validation.warnings.sort(), [
      'artifacts.map_hash is unknown for legacy provenance',
      'artifacts.rule_hash is unknown for legacy provenance',
      'artifacts.source_hash is unknown for legacy provenance'
    ])
    assert.throws(
      () => createProvenance({
        ...generatedSpec(),
        mode: 'legacy_inferred',
        inference: { confidence: 'medium', evidence: [] }
      }),
      /inference\.evidence must be a non-empty array/
    )

    const oldPersistedStrings = structuredClone(result.provenance)
    oldPersistedStrings.inference.evidence = ['legacy evidence remains readable']
    assert.equal(validateProvenance(oldPersistedStrings).valid, true)

    const invalidStructuredEvidence = structuredClone(result.provenance)
    invalidStructuredEvidence.inference.evidence = [{ rule: 'template_exact', points: 15, extra: true }]
    const invalidEvidenceValidation = validateProvenance(invalidStructuredEvidence)
    assert.equal(invalidEvidenceValidation.valid, false)
    assert.match(invalidEvidenceValidation.errors.join('\n'), /unknown fields: extra/)

    const wrongEvidenceTypes = structuredClone(result.provenance)
    wrongEvidenceTypes.inference.evidence = [{ rule: 'template_exact', points: '15', ratio: '1' }]
    const wrongTypeValidation = validateProvenance(wrongEvidenceTypes)
    assert.equal(wrongTypeValidation.valid, false)
    assert.match(wrongTypeValidation.errors.join('\n'), /points must be a non-negative finite number/)
  })

  test('validate reads complete editor_export_slide blocks with object or JSON string content', () => {
    const first = createGenerated()
    const second = createGenerated({ block_id: 'block-102', run_id: 'run-2' })
    const exportedSlide = {
      slideId: '99801',
      blocks: [
        makeBlock(first),
        makeBlock(second, { uuid: 'block-102', stringContent: true })
      ]
    }

    const all = validateInput(exportedSlide)
    assert.equal(all.valid, true)
    assert.deepEqual(all.results.map((item) => item.block_id), ['block-101', 'block-102'])
    const selected = validateInput(exportedSlide, { blockId: 'block-102' })
    assert.equal(selected.valid, true)
    assert.deepEqual(selected.results.map((item) => item.block_id), ['block-102'])
  })

  test('validate reads MCP text wrappers and reports tampering instead of accepting it', () => {
    const provenance = createGenerated()
    const wrapped = {
      content: [{ type: 'text', text: JSON.stringify({ slideId: '99801', blocks: [makeBlock(provenance)] }) }]
    }
    assert.equal(validateInput(wrapped).valid, true)

    provenance.artifacts.map_hash = 'not-a-hash'
    const invalid = validateInput({ blocks: [makeBlock(provenance)] })
    assert.equal(invalid.valid, false)
    assert.match(invalid.errors.join('\n'), /artifacts\.map_hash/)
  })

  test('validate detects baseline snapshot tampering and warns for old hash-only records', () => {
    const tampered = createGenerated()
    tampered.baseline.text_snapshots['source-text-1'].plain_text = '被篡改'
    const invalid = validateProvenance(tampered)
    assert.equal(invalid.valid, false)
    assert.match(invalid.errors.join('\n'), /text_snapshots\.source-text-1 does not match/)

    const hashOnly = createGenerated()
    delete hashOnly.baseline.text_snapshots
    delete hashOnly.baseline.layout_snapshots
    const compatible = validateProvenance(hashOnly)
    assert.equal(compatible.valid, true)
    assert.deepEqual(compatible.warnings, [
      'baseline.text_snapshots is missing; baseline values cannot be displayed',
      'baseline.layout_snapshots is missing; baseline values cannot be displayed'
    ])
  })

  test('refinement keeps origin artifacts for partial application and strictly gates promotion', () => {
    const originArtifacts = {
      source_hash: sha('9'),
      rule_hash: sha('a'),
      template_hash: sha('b'),
      map_hash: hashJson(generatedSpec().map)
    }
    const desiredArtifacts = {
      source_hash: sha('1'),
      rule_hash: sha('2'),
      template_hash: sha('3'),
      map_hash: sha('4')
    }
    const partial = createGenerated({
      refinement: {
        origin_artifacts: originArtifacts,
        desired_artifacts: desiredArtifacts,
        applied_targets: { text: ['safe-text'], layout: ['safe-layout'] },
        conflict_targets: { text: ['manual-text'], layout: [] },
        current_state_hash: sha('5'),
        complete_application: false,
        readback_verified: true,
        origin_artifacts_promoted: false
      }
    })
    assert.equal(partial.artifacts.source_hash, sha('9'), 'partial refinement must preserve origin artifacts')
    assert.deepEqual(partial.refinement.desired_artifacts, desiredArtifacts)
    assert.equal(validateProvenance(partial).valid, true)

    const premature = structuredClone(partial)
    premature.refinement.origin_artifacts_promoted = true
    const prematureValidation = validateProvenance(premature)
    assert.equal(prematureValidation.valid, false)
    assert.match(prematureValidation.errors.join('\n'), /partial refinement requires origin_artifacts_promoted=false/)

    const completeButMismatched = structuredClone(partial)
    completeButMismatched.refinement.conflict_targets.text = []
    completeButMismatched.refinement.complete_application = true
    completeButMismatched.refinement.origin_artifacts_promoted = true
    const mismatchValidation = validateProvenance(completeButMismatched)
    assert.equal(mismatchValidation.valid, false)
    assert.match(mismatchValidation.errors.join('\n'), /complete refinement artifacts\.source_hash/)

    const promoted = createProvenance(generatedSpec({
      map: undefined,
      artifacts: desiredArtifacts,
      refinement: {
        origin_artifacts: originArtifacts,
        desired_artifacts: desiredArtifacts,
        applied_targets: { text: ['safe-text'], layout: ['safe-layout'] },
        conflict_targets: { text: [], layout: [] },
        current_state_hash: sha('6'),
        complete_application: true,
        readback_verified: true,
        origin_artifacts_promoted: true
      }
    })).provenance
    assert.deepEqual(validateProvenance(promoted), { valid: true, errors: [], warnings: [] })

    const partialWithoutConflicts = structuredClone(partial)
    partialWithoutConflicts.refinement.conflict_targets.text = []
    assert.equal(
      validateProvenance(partialWithoutConflicts).valid,
      true,
      'a verified partial application may have no conflicts but still preserve origin artifacts'
    )

    const illegalStates = [
      {
        name: 'unverified persisted refinement',
        mutate(value) { value.refinement.readback_verified = false },
        message: /persisted refinement requires readback_verified=true/
      },
      {
        name: 'complete with conflicts',
        mutate(value) {
          value.refinement.complete_application = true
          value.refinement.origin_artifacts_promoted = true
        },
        message: /complete refinement requires empty conflict_targets/
      },
      {
        name: 'complete without promotion',
        mutate(value) {
          value.refinement.conflict_targets.text = []
          value.refinement.complete_application = true
          value.refinement.origin_artifacts_promoted = false
        },
        message: /complete refinement requires origin_artifacts_promoted=true/
      },
      {
        name: 'complete promoted but not read back',
        mutate(value) {
          value.refinement.conflict_targets.text = []
          value.refinement.complete_application = true
          value.refinement.origin_artifacts_promoted = true
          value.refinement.readback_verified = false
          value.artifacts = { ...value.artifacts, ...desiredArtifacts }
        },
        message: /persisted refinement requires readback_verified=true/
      },
      {
        name: 'partial with desired artifacts at top level',
        mutate(value) {
          value.artifacts = { ...value.artifacts, ...desiredArtifacts }
        },
        message: /partial refinement artifacts\.source_hash must equal refinement\.origin_artifacts\.source_hash/
      }
    ]
    for (const state of illegalStates) {
      const value = structuredClone(partial)
      state.mutate(value)
      const result = validateProvenance(value)
      assert.equal(result.valid, false, state.name)
      assert.match(result.errors.join('\n'), state.message, state.name)
    }

    assert.throws(
      () => createProvenance(generatedSpec({
        refinement: {
          desired_artifacts: desiredArtifacts,
          applied_targets: { text: [], layout: [] },
          conflict_targets: { text: [], layout: [] },
          current_state_hash: sha('5'),
          complete_application: false,
          readback_verified: true,
          origin_artifacts_promoted: false
        }
      })),
      /refinement\.origin_artifacts must be an object/
    )
  })
})

describe('three-way update planning', () => {
  test('separates safe, noop, and conflict for text and layout', () => {
    const old = { plain_text: '旧生成文本' }
    const baseline = {
      text: {
        safe: old,
        already: old,
        unchanged: old,
        conflict: old,
        remove: old
      },
      layout: {
        safeLayout: { left: 10, top: 20, width: 100, height: 40 },
        conflictLayout: { left: 10, top: 20, width: 100, height: 40 }
      }
    }
    const provenance = createGenerated({ baseline })
    const input = {
      ...makeBlock(provenance),
      current: {
        text: {
          safe: old,
          already: { plain_text: '最新目标' },
          unchanged: { plain_text: '人工文本' },
          conflict: { plain_text: '人工文本' },
          remove: old
        },
        layout: {
          safeLayout: { left: 10, top: 20, width: 100, height: 40 },
          conflictLayout: { left: 12, top: 20, width: 100, height: 40 }
        }
      },
      desired: {
        text: {
          safe: { plain_text: '来源更新' },
          already: { plain_text: '最新目标' },
          unchanged: old,
          conflict: { plain_text: '来源更新' },
          remove: { $delete: true }
        },
        layout: {
          safeLayout: { left: 20, top: 20, width: 100, height: 40 },
          conflictLayout: { left: 30, top: 20, width: 100, height: 40 }
        }
      }
    }

    const plan = planUpdate(input)
    assert.deepEqual(plan.summary, { safe: 3, noop: 2, conflict: 2 })
    assert.deepEqual(
      Object.fromEntries(plan.text.map((item) => [item.target, [item.classification, item.reason]])),
      {
        already: ['noop', 'current_already_matches_desired'],
        conflict: ['conflict', 'current_and_desired_diverged_from_baseline'],
        remove: ['safe', 'current_matches_baseline'],
        safe: ['safe', 'current_matches_baseline'],
        unchanged: ['noop', 'desired_did_not_change_from_baseline']
      }
    )
    assert.deepEqual(plan.safe_changes.text, [
      { target: 'remove', operation: 'delete' },
      { target: 'safe', operation: 'set', value: { plain_text: '来源更新' } }
    ])
    assert.deepEqual(plan.safe_changes.layout, [
      { target: 'safeLayout', operation: 'set', value: { left: 20, top: 20, width: 100, height: 40 } }
    ])
    assert.deepEqual(plan.conflicts.text.map((item) => item.target), ['conflict'])
    assert.deepEqual(plan.conflicts.layout.map((item) => item.target), ['conflictLayout'])
    assert.deepEqual(plan.conflicts.text[0].baseline_value, old)
    assert.deepEqual(plan.conflicts.text[0].current_value, { plain_text: '人工文本' })
    assert.deepEqual(plan.conflicts.text[0].desired_value, { plain_text: '来源更新' })
    assert.equal(plan.conflicts.text[0].baseline_value_available, true)
    assert.equal(plan.conflicts.text[0].value_displayable, true)
    assert.deepEqual(plan.warnings, [])
    assert.equal(plan.current_state_hash, hashJson(input.current))
  })

  test('hash-only legacy baseline still classifies conflicts but marks baseline value undisplayable', () => {
    const provenance = createGenerated({
      baseline: {
        text: { target: { plain_text: '旧值' } },
        layout: {}
      }
    })
    delete provenance.baseline.text_snapshots
    delete provenance.baseline.layout_snapshots
    const plan = planUpdate({
      ...makeBlock(provenance),
      current: { text: { target: { plain_text: '人工值' } }, layout: {} },
      desired: { text: { target: { plain_text: '来源新值' } }, layout: {} }
    })
    assert.equal(plan.summary.conflict, 1)
    assert.equal(plan.conflicts.text[0].baseline_value, null)
    assert.equal(plan.conflicts.text[0].baseline_value_available, false)
    assert.equal(plan.conflicts.text[0].value_displayable, false)
    assert.match(plan.warnings.join('\n'), /baseline snapshot is missing/)
  })

  test('requires block selection when an exported slide has more than one provenance record', () => {
    const first = createGenerated()
    const second = createGenerated({ block_id: 'block-102', run_id: 'run-2' })
    const request = {
      slideId: '99801',
      blocks: [makeBlock(first), makeBlock(second, { uuid: 'block-102' })],
      current: { text: {}, layout: {} },
      desired: { text: {}, layout: {} }
    }
    assert.throws(() => planUpdate(request), /requires exactly one provenance record/)
    assert.equal(planUpdate(request, { blockId: 'block-102' }).block_id, 'block-102')
  })
})

describe('auditable legacy candidate matching', () => {
  const query = {
    book_name: '三年级语文上册同步训练',
    subject: '语文',
    grade: '三年级',
    volume: '上册',
    catalog_path: ['第一单元', '第3周 能力达标'],
    catalog_name: '第3周 能力达标',
    catalog_sort: 3,
    template_id: 41075,
    sample_block_id: 41133,
    source_ids: ['slot-a', 'slot-b'],
    structure_fingerprint: { blocks: 1, elements: ['text', 'image'] }
  }

  function exactCandidate(candidateId = 'candidate-exact') {
    return {
      candidate_id: candidateId,
      source: {
        book_id: 'book-1',
        catalog_id: 'catalog-1',
        book_name: query.book_name,
        subject: query.subject,
        grade: query.grade,
        volume: query.volume,
        catalog_path: '第一单元/第3周 能力达标',
        catalog_name: query.catalog_name,
        catalog_sort: query.catalog_sort
      },
      template: {
        resolved_template_id: query.template_id,
        sample_block_id: query.sample_block_id
      },
      fingerprints: {
        source_ids: [...query.source_ids].reverse(),
        structure_fingerprint: { elements: ['text', 'image'], blocks: 1 }
      }
    }
  }

  test('uses fixed weights, returns evidence, and identifies one exact 100-point candidate', () => {
    const result = matchLegacyCandidates({
      query,
      candidates: [
        exactCandidate(),
        {
          ...exactCandidate('candidate-contains'),
          source: {
            ...exactCandidate().source,
            book_name: '三年级语文上册',
            catalog_path: null
          },
          fingerprints: {
            ...exactCandidate().fingerprints,
            source_ids: ['slot-a', 'slot-c']
          }
        }
      ]
    })
    assert.deepEqual(result.weights, LEGACY_MATCH_WEIGHTS)
    assert.equal(result.candidates[0].score, 100)
    assert.equal(result.candidates[0].confidence, 'high')
    assert.equal(result.candidates[0].is_unique_top, true)
    assert.equal(result.top_candidate_id, 'candidate-exact')
    assert.equal(result.unique, true)
    assert.equal(result.requires_human_confirmation, true)
    assert.equal(result.automatic_write, false)
    assert.deepEqual(
      result.candidates[0].evidence.map((item) => item.rule),
      [
        'subject_exact',
        'grade_exact',
        'volume_exact',
        'book_name_exact',
        'catalog_path_exact',
        'template_exact',
        'sample_block_exact',
        'source_id_fingerprint',
        'structure_fingerprint_exact'
      ]
    )
    const contains = result.candidates.find((item) => item.candidate_id === 'candidate-contains')
    assert.equal(contains.score, 78)
    assert.equal(contains.evidence.find((item) => item.rule === 'source_id_fingerprint').ratio, 0.3333)
  })

  test('known subject, grade, or volume mismatch is a hard rejection', () => {
    const result = matchLegacyCandidates({
      query,
      candidates: [
        { ...exactCandidate('wrong-subject'), source: { ...exactCandidate().source, subject: '数学' } },
        { ...exactCandidate('wrong-grade'), source: { ...exactCandidate().source, grade: '四年级' } },
        { ...exactCandidate('wrong-volume'), source: { ...exactCandidate().source, volume: '下册' } },
        { ...exactCandidate('unknown-metadata'), source: { ...exactCandidate().source, subject: null, grade: null, volume: null } }
      ]
    })
    const byId = Object.fromEntries(result.candidates.map((item) => [item.candidate_id, item]))
    assert.deepEqual(byId['wrong-subject'].rejection_reasons, ['subject_mismatch'])
    assert.deepEqual(byId['wrong-grade'].rejection_reasons, ['grade_mismatch'])
    assert.deepEqual(byId['wrong-volume'].rejection_reasons, ['volume_mismatch'])
    for (const id of ['wrong-subject', 'wrong-grade', 'wrong-volume']) {
      assert.equal(byId[id].eligible, false)
      assert.equal(byId[id].confidence, 'rejected')
      assert.equal(byId[id].score, 0)
    }
    assert.equal(byId['unknown-metadata'].eligible, true, 'unknown is not a known mismatch')
  })

  test('score at or above 75 is capped at medium when any core metadata is unknown', () => {
    const missingSubject = exactCandidate('missing-subject')
    missingSubject.source.subject = null
    const result = matchLegacyCandidates({ query, candidates: [missingSubject] })
    const candidate = result.candidates[0]
    assert.equal(candidate.score, 95)
    assert.equal(candidate.confidence, 'medium')
    assert.equal(candidate.core_metadata_complete, false)
    assert.deepEqual(candidate.missing_core_metadata, ['candidate.subject'])
    assert.deepEqual(candidate.confidence_reasons, [
      'score_at_least_75',
      'high_capped_missing_core_metadata:candidate.subject'
    ])
  })

  test('matcher structured evidence feeds legacy create without rewriting the array', () => {
    const match = matchLegacyCandidates({ query, candidates: [exactCandidate()] }).candidates[0]
    assert.equal(match.confidence, 'high')
    const created = createProvenance({
      block_id: 'legacy-from-matcher',
      mode: 'legacy_inferred',
      run_id: 'legacy-match-run',
      source: {
        book_id: 'book-1',
        catalog_id: 'catalog-1',
        catalog_name: query.catalog_name,
        catalog_sort: query.catalog_sort,
        book_name: query.book_name,
        subject: query.subject,
        grade: query.grade,
        volume: query.volume,
        catalog_path: '第一单元/第3周 能力达标'
      },
      template: {
        requested_template_id: null,
        resolved_template_id: query.template_id,
        sample_block_id: query.sample_block_id,
        template_locked: false,
        catalog_route: null
      },
      artifacts: {
        source_hash: null,
        rule_hash: null,
        template_hash: sha('b'),
        map_hash: null
      },
      baseline: {
        text: { 'slot-a': { plain_text: '历史当前值' } },
        layout: { 'slot-a': { left: 10, top: 20, width: 100, height: 40 } }
      },
      inference: {
        confidence: match.confidence,
        confidence_reasons: match.confidence_reasons,
        evidence: match.evidence
      }
    }).provenance

    assert.deepEqual(created.inference.evidence, match.evidence)
    assert.deepEqual(created.inference.confidence_reasons, match.confidence_reasons)
    assert.equal(validateProvenance(created).valid, true)
  })

  test('tied top score is explicitly non-unique and never becomes an automatic write', () => {
    const result = matchLegacyCandidates({
      query,
      candidates: [exactCandidate('candidate-a'), exactCandidate('candidate-b')]
    })
    assert.equal(result.unique, false)
    assert.equal(result.top_candidate_id, null)
    assert.deepEqual(result.candidates.map((item) => item.is_top), [true, true])
    assert.deepEqual(result.candidates.map((item) => item.is_unique_top), [false, false])
    assert.equal(result.automatic_write, false)
  })
})

describe('CLI', () => {
  test('top-level help exits successfully and lists every command', () => {
    const result = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /create --input/)
    assert.match(result.stdout, /validate --input/)
    assert.match(result.stdout, /plan-update --input/)
    assert.match(result.stdout, /match-legacy --input/)
  })

  test('match-legacy CLI emits scores without any write instruction', () => {
    const input = {
      query: {
        book_name: '数学五年级下册',
        subject: '数学',
        grade: '五年级',
        volume: '下册',
        catalog_name: '期中测试',
        catalog_sort: 8,
        template_id: 36957,
        sample_block_id: 40001,
        source_ids: ['a', 'b'],
        structure_fingerprint: 'sha256:structure'
      },
      candidates: [{
        candidate_id: 'source-1',
        book_name: '数学五年级下册',
        subject: '数学',
        grade: '五年级',
        volume: '下',
        catalog_name: '期中测试',
        catalog_sort: 8,
        template_id: 36957,
        sample_block_id: 40001,
        source_ids: ['a', 'b'],
        structure_fingerprint: 'sha256:structure'
      }]
    }
    const run = spawnSync(process.execPath, [cliPath, 'match-legacy', '--input', '-'], {
      input: JSON.stringify(input),
      encoding: 'utf8'
    })
    assert.equal(run.status, 0, run.stderr)
    const output = JSON.parse(run.stdout)
    assert.equal(output.top_candidate_id, 'source-1')
    assert.equal(output.unique, true)
    assert.equal(output.requires_human_confirmation, true)
    assert.equal(output.automatic_write, false)
    assert.equal('editor_update_block' in output, false)

    const rejectedOption = spawnSync(
      process.execPath,
      [cliPath, 'match-legacy', '--input', '-', '--block-id', 'not-applicable'],
      { input: JSON.stringify(input), encoding: 'utf8' }
    )
    assert.equal(rejectedOption.status, 2)
    assert.match(rejectedOption.stderr, /does not accept --block-id/)
  })

  test('create, validate, and plan-update commands round trip through files', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-tools-'))
    temporaryDirectories.push(temp)
    const createInput = path.join(temp, 'create.json')
    const createdOutput = path.join(temp, 'created.json')
    fs.writeFileSync(createInput, JSON.stringify(generatedSpec()), 'utf8')

    const createRun = spawnSync(process.execPath, [cliPath, 'create', '--input', createInput, '--out', createdOutput], {
      encoding: 'utf8'
    })
    assert.equal(createRun.status, 0, createRun.stderr)
    const created = JSON.parse(fs.readFileSync(createdOutput, 'utf8'))
    assert.equal(created.editor_update_block.arguments.patch.ai_provenance.mode, 'generated')

    const exportInput = path.join(temp, 'export.json')
    fs.writeFileSync(exportInput, JSON.stringify({ blocks: [makeBlock(created.provenance)] }), 'utf8')
    const validateRun = spawnSync(process.execPath, [cliPath, 'validate', '--input', exportInput, '--block-id', 'block-101'], {
      encoding: 'utf8'
    })
    assert.equal(validateRun.status, 0, validateRun.stderr)
    assert.equal(JSON.parse(validateRun.stdout).valid, true)

    const updateInput = path.join(temp, 'update.json')
    fs.writeFileSync(updateInput, JSON.stringify({
      ...makeBlock(created.provenance),
      current: {
        text: { 'source-text-1': { plain_text: '分数的初步认识', marks: [] } },
        layout: { 'source-text-1': { left: 48, top: 92, width: 310, height: 56, rotate: 0 } }
      },
      desired: {
        text: { 'source-text-1': { plain_text: '认识分数', marks: [] } },
        layout: { 'source-text-1': { left: 48, top: 92, width: 310, height: 56, rotate: 0 } }
      }
    }), 'utf8')
    const planRun = spawnSync(process.execPath, [cliPath, 'plan-update', '--input', updateInput], {
      encoding: 'utf8'
    })
    assert.equal(planRun.status, 0, planRun.stderr)
    assert.deepEqual(JSON.parse(planRun.stdout).summary, { safe: 1, noop: 1, conflict: 0 })
  })

  test('validate exits 1 for invalid provenance and 2 for malformed input', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-tools-exit-'))
    temporaryDirectories.push(temp)
    const invalidInput = path.join(temp, 'invalid.json')
    fs.writeFileSync(invalidInput, JSON.stringify({ blocks: [] }), 'utf8')
    const invalid = spawnSync(process.execPath, [cliPath, 'validate', '--input', invalidInput], { encoding: 'utf8' })
    assert.equal(invalid.status, 1)
    assert.equal(JSON.parse(invalid.stdout).valid, false)

    const malformedInput = path.join(temp, 'malformed.json')
    fs.writeFileSync(malformedInput, '{', 'utf8')
    const malformed = spawnSync(process.execPath, [cliPath, 'validate', '--input', malformedInput], { encoding: 'utf8' })
    assert.equal(malformed.status, 2)
    assert.match(malformed.stderr, /cannot parse input JSON/)
  })
})
