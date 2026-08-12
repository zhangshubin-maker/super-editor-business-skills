import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import {
  acquireLock,
  authorizeApply,
  buildLogicalIdentity,
  initLedger as initLedgerRuntime,
  inspectLock,
  recoverLock,
  releaseLock,
  transferLock,
  transitionLedger,
  validateLedger
} from '../batch-ledger.mjs'
import { materializeExecutablePack } from './semantic-fixtures.mjs'
import { hashJson } from '../semantic-rule-tools.mjs'

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

function validatedPack() {
  const capabilities = ['editor_text_set_content', 'editor_text_inspect_layout', 'editor_save_verified']
  const acceptance = [{
    id: 'saved-readback',
    intent: 'save and read the generated page back',
    severity: 'error',
    required_capabilities: ['editor_save_verified']
  }]
  const forwardCases = [
    { id: 'forward-a', source_snapshot_hash: sha('1'), target_snapshot_hash: sha('3') },
    { id: 'forward-b', source_snapshot_hash: sha('2'), target_snapshot_hash: sha('4') }
  ].map((entry) => ({
    ...entry,
    acceptance_results: [{ check_id: 'saved-readback', status: 'passed', evidence: ['readback hash and audit passed'] }]
  }))
  const pack = {
    schema_version: 1,
    identity: {
      skill_name: 'batch-hardening-fixture',
      display_name: 'Batch hardening fixture',
      version: '1.0.0',
      status: 'validated',
      book_family: 'fixture books'
    },
    applicability: { intent: 'fixture for deterministic batch tests' },
    templates: {
      default: { template_id: 'template-a', intent: 'fixture template', snapshot_hash: sha('a') },
      variants: []
    },
    defaults: {
      style_policy: 'preserve_target',
      module_policy: 'reuse_model_relation',
      on_missing: 'needs_review',
      on_ambiguous: 'stop'
    },
    rules: [{
      id: 'copy-title',
      order: 10,
      intent: 'copy the semantic lesson title',
      when: 'the source and target each expose one visible lesson title',
      scope: { intent: 'ordinary lesson catalogs' },
      source: {
        role: 'source lesson title',
        cardinality: { min: 1, max: 1 },
        evidence: [
          { class: 'semantic', kind: 'teaching_role', claim: 'this text names the lesson topic', observation: 'a visible primary lesson topic heading is present' },
          { class: 'structure', kind: 'reading_order', claim: 'reading order identifies the main heading', observation: 'the first prominent heading precedes section headings' }
        ]
      },
      target: {
        role: 'template lesson title',
        cardinality: { min: 1, max: 1 },
        evidence: [
          { class: 'semantic', kind: 'template_role', claim: 'this frame is the visible title destination', observation: 'its visible text is a primary title placeholder by meaning' },
          { class: 'structure', kind: 'visual_hierarchy', claim: 'visual hierarchy identifies the primary title frame', observation: 'the heading is highest in the page hierarchy' }
        ]
      },
      action: {
        type: 'set_rich_text',
        intent: 'replace content while preserving target layout',
        required_capabilities: ['editor_text_set_content']
      },
      on_missing: 'needs_review',
      on_ambiguous: 'stop',
      validate: [{
        id: 'title-fits',
        intent: 'title remains visible and uncut',
        severity: 'error',
        required_capabilities: ['editor_text_inspect_layout']
      }]
    }],
    acceptance,
    training: { feedback: [], examples: [] },
    forward_tests: forwardCases.map((entry) => ({
      id: entry.id,
      source_label: entry.id,
      status: 'passed',
      evidence: ['forward rendering and readback passed'],
      result_hash: entry.target_snapshot_hash
    })),
    execution: {
      capability_snapshot: {
        snapshot_hash: sha('0'),
        capabilities,
        evidence: ['capabilities were enumerated from the installed atomic plugin']
      },
      trial_approval: { approved: true, evidence: ['explicit fixture approval'] },
      forward_cases: forwardCases
    }
  }
  const artifactRoot = tempDirectory('semantic-rule-artifacts-')
  materializeExecutablePack(pack, artifactRoot, { validated: true })
  Object.defineProperty(pack, '__artifactRoot', { value: artifactRoot })
  return pack
}

function initLedger(pack, books, options = {}) {
  return initLedgerRuntime(pack, books, { ...options, rulePackArtifactRoot: pack.__artifactRoot })
}

function fingerprint(overrides = {}) {
  return {
    source_snapshot_hash: sha('5'),
    template_snapshot_hash: sha('6'),
    target_before_hash: sha('7'),
    resolved_template_id: 'template-a',
    ...overrides
  }
}

function book(itemId, overrides = {}) {
  return {
    item_id: itemId,
    target_book_id: 'target-book-a',
    target_catalog_scope: { kind: 'catalog_path', value: 'unit-1/lesson-1' },
    ...overrides
  }
}

function planAndPreflight(ledger, itemId, lock, currentFingerprint = fingerprint()) {
  ledger = transitionLedger(ledger, itemId, 'planned', {}, { lock })
  return transitionLedger(ledger, itemId, 'preflighted', { fingerprint: currentFingerprint }, { lock })
}

function finishVerified(ledger, itemId, lock, currentFingerprint = fingerprint()) {
  ledger = authorizeApply(ledger, itemId, {
    ...currentFingerprint,
    rule_pack_hash: ledger.skill.rule_pack_hash
  }, { lock })
  const token = ledger.items.find((item) => item.item_id === itemId).apply_authorization.token
  ledger = transitionLedger(ledger, itemId, 'applied', {
    target_after_hash: sha('8'),
    apply_authorization_token: token
  }, { lock })
  ledger = transitionLedger(ledger, itemId, 'saved', { save_readback_hash: sha('8') }, { lock })
  const item = ledger.items.find((candidate) => candidate.item_id === itemId)
  const save = {
    tool: 'editor_save_verified', scope: 'current', slide_id: 'slide-batch', saved: true,
    saved_scope: 'current', saved_slides: ['slide-batch'], verified: true, verified_scope: 'current',
    verified_slides: ['slide-batch'], content_hash: 'fnv1a32:1234abcd', persisted_content_hash: 'fnv1a32:1234abcd',
    dirty: false, envelope_hash: sha('a')
  }
  save.receipt_hash = hashJson(save)
  const exported = {
    tool: 'editor_export_slide', slide_id: 'slide-batch', block_count: 1,
    page_content_hash: 'fnv1a32:1234abcd', blocks_hash: sha('b'), carrier_block_hash: sha('c'), envelope_hash: sha('d')
  }
  exported.receipt_hash = hashJson(exported)
  const receipt = {
    schema_version: 1, kind: 'semantic_provenance_readback_receipt', run_id: 'run-batch',
    provenance_integrity_hash: sha('9'), carrier_block_id: 'carrier-batch',
    identity: {
      slide_id: 'slide-batch', source_book_id: item.book.source_book_id ?? 'source-book-a',
      source_catalog_id: item.book.source_catalog_id ?? 'source-catalog-a',
      target_book_id: item.book.target_book_id, target_catalog_id: item.book.target_catalog_id ?? 'slide-batch'
    },
    save, export: exported, verified_at: '2026-08-12T00:00:00.000Z'
  }
  receipt.artifact_integrity = { algorithm: 'sha256-canonical-json', canonical_hash: hashJson(receipt) }
  const receiptFile = path.join(path.dirname(lock.lock_path), `${itemId}-receipt.json`)
  fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  const receiptFileHash = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(receiptFile)).digest('hex')}`
  return transitionLedger(ledger, itemId, 'verified', {
    result_hash: sha('8'), provenance_hash: sha('9'), run_id: 'run-batch', carrier_block_id: 'carrier-batch',
    slide_id: 'slide-batch', source_book_id: receipt.identity.source_book_id,
    source_catalog_id: receipt.identity.source_catalog_id, target_book_id: receipt.identity.target_book_id,
    target_catalog_id: receipt.identity.target_catalog_id,
    provenance_readback_receipt_path: receiptFile, provenance_readback_receipt_sha256: receiptFileHash
  }, { lock })
}

describe('batch logical idempotency', () => {
  test('does not include item_id and blocks the same logical work across ledgers', () => {
    const lockDirectory = path.join(tempDirectory('semantic-batch-idempotency-'), 'locks')
    const pack = validatedPack()
    const first = initLedger(pack, [book('first-item')], { ledgerId: 'ledger-first', lockDirectory })
    const renamed = initLedger(pack, [book('renamed-item')], { ledgerId: 'ledger-renamed', lockDirectory })
    assert.equal(
      buildLogicalIdentity(first, first.items[0], fingerprint()).idempotency_key,
      buildLogicalIdentity(renamed, renamed.items[0], fingerprint()).idempotency_key
    )

    let firstRun = first
    const firstLock = acquireLock(lockDirectory, 'target-book-a', 'owner-first')
    firstRun = planAndPreflight(firstRun, 'first-item', firstLock)
    releaseLock(lockDirectory, 'target-book-a', 'owner-first')

    let competing = renamed
    const competingLock = acquireLock(lockDirectory, 'target-book-a', 'owner-competing')
    competing = planAndPreflight(competing, 'renamed-item', competingLock)
    assert.equal(competing.items[0].state, 'conflict')
    assert.equal(competing.items[0].last_error, 'logical_work_claimed_elsewhere')
    releaseLock(lockDirectory, 'target-book-a', 'owner-competing')

    const verificationLock = acquireLock(lockDirectory, 'target-book-a', 'owner-first')
    firstRun = finishVerified(firstRun, 'first-item', verificationLock)
    assert.equal(firstRun.items[0].state, 'verified')
    releaseLock(lockDirectory, 'target-book-a', 'owner-first')

    const driftedTarget = initLedger(pack, [book('drifted-target-item', {
      preflight_fingerprint: fingerprint()
    })], { ledgerId: 'ledger-drifted-target', lockDirectory })
    assert.equal(driftedTarget.items[0].state, 'conflict')
    assert.equal(driftedTarget.items[0].evidence.conflict.reason, 'verified_identity_target_drift')

    const eagerSkip = initLedger(pack, [book('eager-item', {
      preflight_fingerprint: fingerprint({ target_before_hash: sha('8') })
    })], {
      ledgerId: 'ledger-eager',
      lockDirectory
    })
    assert.equal(eagerSkip.items[0].state, 'verified_skip')

    let later = initLedger(pack, [book('third-item')], { ledgerId: 'ledger-third', lockDirectory })
    const laterLock = acquireLock(lockDirectory, 'target-book-a', 'owner-third')
    later = planAndPreflight(later, 'third-item', laterLock, fingerprint({ target_before_hash: sha('8') }))
    assert.equal(later.items[0].state, 'verified_skip')
    assert.equal(later.items[0].evidence.verified_skip.reason, 'logical_work_already_verified')
    releaseLock(lockDirectory, 'target-book-a', 'owner-third')
  })

  test('detects duplicate logical items during init when fingerprints are supplied', () => {
    const lockDirectory = path.join(tempDirectory('semantic-batch-init-'), 'locks')
    const preflightFingerprint = fingerprint()
    const ledger = initLedger(validatedPack(), [
      book('item-a', { preflight_fingerprint: preflightFingerprint }),
      book('item-b', { preflight_fingerprint: preflightFingerprint })
    ], { lockDirectory })
    assert.equal(ledger.items[0].state, 'pending')
    assert.equal(ledger.items[1].state, 'conflict')
    assert.equal(ledger.items[0].idempotency_key, ledger.items[1].idempotency_key)
  })

  test('requires a persisted stable lock key for a not-yet-created target book', () => {
    assert.throws(
      () => initLedger(validatedPack(), [{ item_id: 'new-book-item' }]),
      /persisted stable lock_key/
    )
    assert.throws(
      () => initLedger(validatedPack(), [{ item_id: 'new-book-item', lock_key: 'new-book-item' }]),
      /must not fall back to item_id/
    )
    const ledger = initLedger(validatedPack(), [{
      item_id: 'new-book-item',
      lock_key: 'new-book:5cc792a6-5d7a-4ccc-b146-7a69321859ca',
      target_book_prospective_identity: 'prospective:5cc792a6-5d7a-4ccc-b146-7a69321859ca',
      target_catalog_scope: 'planned:unit-1/lesson-1'
    }])
    assert.equal(ledger.items[0].lock_key, 'new-book:5cc792a6-5d7a-4ccc-b146-7a69321859ca')
  })
})

describe('pre-apply drift gate', () => {
  test('returns to planned and issues no write token when any frozen fingerprint drifts', () => {
    const lockDirectory = path.join(tempDirectory('semantic-batch-drift-'), 'locks')
    let ledger = initLedger(validatedPack(), [book('drift-item')], { lockDirectory })
    const lock = acquireLock(lockDirectory, 'target-book-a', 'owner-drift')
    ledger = planAndPreflight(ledger, 'drift-item', lock)
    ledger = authorizeApply(ledger, 'drift-item', fingerprint({
      target_before_hash: sha('0'),
      rule_pack_hash: ledger.skill.rule_pack_hash
    }), { lock })
    assert.equal(ledger.items[0].state, 'planned')
    assert.equal(ledger.items[0].apply_authorization, null)
    assert.equal(ledger.items[0].write_blocked.reason, 'pre_apply_fingerprint_drift')
    assert.deepEqual(ledger.items[0].write_blocked.differences.map((entry) => entry.field), ['target_before_hash'])
    assert.equal(validateLedger(ledger).valid, true)
    releaseLock(lockDirectory, 'target-book-a', 'owner-drift')
  })

  test('binds applied to the authorization token while preserving outcome_unknown recovery', () => {
    const lockDirectory = path.join(tempDirectory('semantic-batch-gate-'), 'locks')
    let ledger = initLedger(validatedPack(), [book('gate-item')], { lockDirectory })
    const lock = acquireLock(lockDirectory, 'target-book-a', 'owner-gate')
    ledger = planAndPreflight(ledger, 'gate-item', lock)
    assert.throws(
      () => authorizeApply(ledger, 'gate-item', fingerprint(), { lock }),
      /rule_pack_hash is required/
    )
    assert.throws(
      () => transitionLedger(ledger, 'gate-item', 'applied', { target_after_hash: sha('8') }, { lock }),
      /authorize-apply/
    )
    ledger = transitionLedger(ledger, 'gate-item', 'outcome_unknown', { reason: 'write result timed out' }, { lock })
    assert.throws(
      () => transitionLedger(ledger, 'gate-item', 'applied', { target_after_hash: sha('8') }, { lock }),
      /readback_recovery/
    )
    ledger = transitionLedger(ledger, 'gate-item', 'applied', {
      target_after_hash: sha('8'),
      readback_recovery: true
    }, { lock })
    assert.equal(ledger.items[0].state, 'applied')
    releaseLock(lockDirectory, 'target-book-a', 'owner-gate')
  })
})

describe('stale lock evidence and handoff', () => {
  test('refuses recovery while the inspected same-host owner process is alive', () => {
    const lockDirectory = path.join(tempDirectory('semantic-batch-recovery-'), 'locks')
    const original = acquireLock(lockDirectory, 'target-book-a', 'owner-stale', { now: '2026-08-12T00:00:00.000Z' })
    const inspection = inspectLock(lockDirectory, 'target-book-a', {
      now: '2026-08-12T01:00:00.000Z',
      staleAfterMs: 1_000
    })
    assert.equal(inspection.stale_candidate, true)
    assert.equal(inspection.recoverable, false)
    assert.throws(
      () => recoverLock(lockDirectory, 'target-book-a', 'owner-recovery', {
        observed_nonce: original.nonce,
        reason: 'the prior task was cancelled',
        authorized_by: 'batch-operator'
      }, { now: '2026-08-12T01:00:00.000Z', staleAfterMs: 1_000 }),
      /still running.*recovery is forbidden/
    )
    assert.throws(() => recoverLock(lockDirectory, 'target-book-a', 'owner-recovery', {
      observed_nonce: original.nonce,
      reason: 'the prior task was cancelled and its owner confirmed inactive',
      authorized_by: 'batch-operator',
      confirm_owner_inactive: true
    }, { now: '2026-08-12T01:00:00.000Z', staleAfterMs: 1_000 }), /still running.*recovery is forbidden/)
    releaseLock(lockDirectory, 'target-book-a', 'owner-stale')
  })

  test('transfers only from the current owner with a matching inspected nonce', () => {
    const lockDirectory = path.join(tempDirectory('semantic-batch-transfer-'), 'locks')
    const original = acquireLock(lockDirectory, 'target-book-a', 'owner-a')
    assert.throws(
      () => transferLock(lockDirectory, 'target-book-a', 'owner-a', 'owner-b', {
        observed_nonce: 'wrong',
        reason: 'planned handoff',
        authorized_by: 'owner-a'
      }),
      /observed_nonce/
    )
    const transferred = transferLock(lockDirectory, 'target-book-a', 'owner-a', 'owner-b', {
      observed_nonce: original.nonce,
      reason: 'planned handoff',
      authorized_by: 'owner-a'
    })
    assert.equal(transferred.owner, 'owner-b')
    assert.equal(transferred.transfer_history.length, 1)
    assert.throws(() => releaseLock(lockDirectory, 'target-book-a', 'owner-a'), /belongs to owner-b/)
    releaseLock(lockDirectory, 'target-book-a', 'owner-b')
  })
})
