import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { acquireLock, releaseLock, transitionLedger } from '../batch-ledger.mjs'
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

function sealLedger(value) {
  const copy = structuredClone(value)
  copy.integrity_hash = hashJson(copy)
  return copy
}

function savedLedger() {
  return sealLedger({
    schema_version: 2,
    ledger_id: 'ledger-receipt',
    skill: { name: 'fixture', version: '1.0.0', rule_pack_hash: sha('1') },
    created_at: '2026-08-12T00:00:00.000Z',
    updated_at: '2026-08-12T00:00:00.000Z',
    items: [{
      item_id: 'item-receipt',
      lock_key: 'target-book-receipt',
      target: {
        book_stable_identity: 'target-book-receipt',
        prospective_identity: null,
        promoted_book_id: 'target-book-receipt',
        catalog_scope: { kind: 'catalog_id', value: 'slide-1' }
      },
      book: {
        item_id: 'item-receipt',
        source_book_id: 'source-book',
        source_catalog_id: 'source-catalog',
        target_book_id: 'target-book-receipt',
        target_catalog_id: 'slide-1'
      },
      state: 'saved',
      attempt: 1,
      fingerprint: {
        source_snapshot_hash: sha('2'),
        template_snapshot_hash: sha('3'),
        target_before_hash: sha('4'),
        resolved_template_id: 'template-a',
        rule_pack_hash: sha('1')
      },
      idempotency_key: hashJson({
        schema_version: 1,
        source_snapshot_hash: sha('2'),
        template_snapshot_hash: sha('3'),
        rule_pack_hash: sha('1'),
        target: {
          book_stable_identity: 'target-book-receipt',
          catalog_scope: { kind: 'catalog_id', value: 'slide-1' }
        }
      }),
      apply_authorization: null,
      write_blocked: null,
      evidence: {
        saved: { save_readback_hash: sha('8') }
      },
      last_error: null,
      history: [{ from: 'applied', to: 'saved', at: '2026-08-12T00:00:00.000Z', evidence: { save_readback_hash: sha('8') } }]
    }]
  })
}

function writeIdentityClaim(directory, ledger) {
  const item = ledger.items[0]
  const identityDirectory = path.join(directory, 'idempotency')
  fs.mkdirSync(identityDirectory, { recursive: true })
  const record = {
    schema_version: 1,
    idempotency_key: item.idempotency_key,
    logical_identity: {
      schema_version: 1,
      source_snapshot_hash: item.fingerprint.source_snapshot_hash,
      template_snapshot_hash: item.fingerprint.template_snapshot_hash,
      rule_pack_hash: ledger.skill.rule_pack_hash,
      target: {
        book_stable_identity: item.target.book_stable_identity,
        catalog_scope: item.target.catalog_scope
      }
    },
    status: 'saved',
    claim: {
      ledger_id: ledger.ledger_id,
      item_id: item.item_id,
      lock_owner: 'receipt-owner',
      lock_nonce: 'fixture-nonce'
    },
    created_at: ledger.created_at,
    updated_at: ledger.updated_at,
    evidence: { saved: item.evidence.saved }
  }
  record.integrity_hash = hashJson(record)
  fs.writeFileSync(
    path.join(identityDirectory, `${item.idempotency_key.slice('sha256:'.length)}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8'
  )
}

function receiptArtifact() {
  const saveWithoutHash = {
    tool: 'editor_save_verified',
    scope: 'current',
    slide_id: 'slide-1',
    saved: true,
    saved_scope: 'current',
    saved_slides: ['slide-1'],
    verified: true,
    verified_scope: 'current',
    verified_slides: ['slide-1'],
    content_hash: 'fnv1a32:12ab34cd',
    persisted_content_hash: 'fnv1a32:12ab34cd',
    dirty: false,
    envelope_hash: sha('a')
  }
  const exportWithoutHash = {
    tool: 'editor_export_slide',
    slide_id: 'slide-1',
    block_count: 3,
    page_content_hash: 'fnv1a32:12ab34cd',
    blocks_hash: sha('b'),
    carrier_block_hash: sha('c'),
    envelope_hash: sha('d')
  }
  const artifact = {
    schema_version: 1,
    kind: 'semantic_provenance_readback_receipt',
    run_id: 'run-receipt',
    provenance_integrity_hash: sha('9'),
    carrier_block_id: 'carrier-1',
    identity: {
      slide_id: 'slide-1',
      source_book_id: 'source-book',
      source_catalog_id: 'source-catalog',
      target_book_id: 'target-book-receipt',
      target_catalog_id: 'slide-1'
    },
    save: { ...saveWithoutHash, receipt_hash: hashJson(saveWithoutHash) },
    export: { ...exportWithoutHash, receipt_hash: hashJson(exportWithoutHash) },
    verified_at: '2026-08-12T03:00:00.000Z'
  }
  artifact.artifact_integrity = {
    algorithm: 'sha256-canonical-json',
    canonical_hash: hashJson(artifact)
  }
  return artifact
}

function writeReceipt(directory, receipt) {
  const filename = path.join(directory, 'provenance-readback-receipt.json')
  fs.writeFileSync(filename, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  return {
    filename,
    fileHash: `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')}`
  }
}

function verifiedEvidence(receiptPath, fileHash) {
  return {
    result_hash: sha('8'),
    provenance_hash: sha('9'),
    run_id: 'run-receipt',
    carrier_block_id: 'carrier-1',
    slide_id: 'slide-1',
    source_book_id: 'source-book',
    source_catalog_id: 'source-catalog',
    target_book_id: 'target-book-receipt',
    target_catalog_id: 'slide-1',
    provenance_readback_receipt_path: receiptPath,
    provenance_readback_receipt_sha256: fileHash
  }
}

describe('saved to verified strict receipt artifact gate', () => {
  test('accepts only the receipt-agent contract and records its hashes', () => {
    const directory = tempDirectory('semantic-verified-receipt-')
    const lock = acquireLock(directory, 'target-book-receipt', 'receipt-owner')
    const ledger = savedLedger()
    writeIdentityClaim(directory, ledger)
    const { filename, fileHash } = writeReceipt(directory, receiptArtifact())
    const updated = transitionLedger(ledger, 'item-receipt', 'verified', verifiedEvidence(filename, fileHash), { lock })
    assert.equal(updated.items[0].state, 'verified')
    const evidence = updated.items[0].evidence.verified.provenance_readback_receipt
    assert.equal(evidence.artifact_file_sha256, fileHash)
    assert.equal(evidence.artifact_canonical_hash, receiptArtifact().artifact_integrity.canonical_hash)
    assert.equal(evidence.save_receipt_hash, receiptArtifact().save.receipt_hash)
    releaseLock(directory, 'target-book-receipt', 'receipt-owner')
  })

  test('rejects missing files, file tampering, canonical tampering and logical mismatches', () => {
    const directory = tempDirectory('semantic-verified-receipt-negative-')
    const lock = acquireLock(directory, 'target-book-receipt', 'receipt-owner')
    assert.throws(() => transitionLedger(savedLedger(), 'item-receipt', 'verified', {
      result_hash: sha('8'),
      provenance_hash: sha('9')
    }, { lock }), /receipt_path/)

    const written = writeReceipt(directory, receiptArtifact())
    assert.throws(() => transitionLedger(savedLedger(), 'item-receipt', 'verified',
      verifiedEvidence(written.filename, sha('0')), { lock }), /file SHA-256/)

    const mismatched = verifiedEvidence(written.filename, written.fileHash)
    mismatched.target_catalog_id = 'different-catalog'
    assert.throws(() => transitionLedger(savedLedger(), 'item-receipt', 'verified', mismatched, { lock }),
      /target_catalog_id/)

    const tampered = receiptArtifact()
    tampered.export.block_count = 4
    const tamperedFile = writeReceipt(directory, tampered)
    assert.throws(() => transitionLedger(savedLedger(), 'item-receipt', 'verified',
      verifiedEvidence(tamperedFile.filename, tamperedFile.fileHash), { lock }), /canonical_hash/)
    releaseLock(directory, 'target-book-receipt', 'receipt-owner')
  })
})
