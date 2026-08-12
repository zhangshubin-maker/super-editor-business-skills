import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  acquireLock,
  inspectLock,
  promoteLedgerTarget,
  promoteProspectiveIdentity,
  recoverLock,
  registerProspectiveIdentity,
  releaseLock,
} from '../batch-ledger.mjs'
import { hashJson } from '../semantic-rule-tools.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ledgerCli = path.resolve(__dirname, '..', 'batch-ledger.mjs')
const temporaryDirectories = []

function tempDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true })
})

function sealLedger(value) {
  const copy = structuredClone(value)
  copy.integrity_hash = hashJson(copy)
  return copy
}

describe('fixed lock namespace and live owner recovery gate', () => {
  test('removes the environment variable custom-directory bypass and rejects --lock-dir in CLI', () => {
    const directory = tempDirectory('semantic-lock-bypass-')
    const cliEnvironment = { ...process.env, NODE_TEST_CONTEXT: '', SEMANTIC_TEACHING_AID_TEST_LOCKS: '1' }
    const libraryProbe = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `import { resolveLockDirectory } from ${JSON.stringify(pathToFileURL(path.resolve(__dirname, '..', 'batch-ledger.mjs')).href)}; resolveLockDirectory(process.argv[1])`,
      directory
    ], { encoding: 'utf8', env: cliEnvironment })
    assert.notEqual(libraryProbe.status, 0)
    assert.match(libraryProbe.stderr, /custom lock directory is test-only/)

    const cli = spawnSync(process.execPath, [
      ledgerCli, 'lock-status', '--lock-key', 'no-write-needed', '--lock-dir', directory
    ], { encoding: 'utf8', env: cliEnvironment })
    assert.equal(cli.status, 2)
    assert.match(cli.stderr, /--lock-dir is not supported/)
  })

  test('always refuses recovery while the same-host owner PID is running', () => {
    const directory = tempDirectory('semantic-lock-live-owner-')
    const lock = acquireLock(directory, 'live-target', 'live-owner', { now: '2026-08-12T00:00:00.000Z' })
    const inspection = inspectLock(directory, 'live-target', {
      now: '2026-08-13T00:00:00.000Z',
      staleAfterMs: 1
    })
    assert.equal(inspection.process_liveness, 'running')
    assert.throws(() => recoverLock(directory, 'live-target', 'takeover', {
      observed_nonce: lock.nonce,
      confirm_owner_inactive: true,
      reason: 'even explicit evidence cannot contradict a running local PID',
      authorized_by: 'operator'
    }, { now: '2026-08-13T00:00:00.000Z', staleAfterMs: 1 }), /still running.*recovery is forbidden/)
    releaseLock(directory, 'live-target', 'live-owner')
  })
})

describe('prospective target identity registry', () => {
  test('enforces prospective and lock-key uniqueness in both directions', () => {
    const directory = tempDirectory('semantic-target-identity-')
    const first = registerProspectiveIdentity(directory, 'prospective:a', 'new-book-lock:a')
    assert.equal(first.target_book_id, null)
    assert.deepEqual(registerProspectiveIdentity(directory, 'prospective:a', 'new-book-lock:a'), first)
    assert.throws(
      () => registerProspectiveIdentity(directory, 'prospective:a', 'new-book-lock:b'),
      /already bound to a different prospective identity or lock key/
    )
    assert.throws(
      () => registerProspectiveIdentity(directory, 'prospective:b', 'new-book-lock:a'),
      /already bound to a different prospective identity or lock key/
    )
  })

  test('promotes under the original lock and prevents one real book from binding multiple prospective identities', () => {
    const directory = tempDirectory('semantic-target-promotion-')
    registerProspectiveIdentity(directory, 'prospective:a', 'new-book-lock:a')
    registerProspectiveIdentity(directory, 'prospective:b', 'new-book-lock:b')
    const lockA = acquireLock(directory, 'new-book-lock:a', 'creator-a')
    const evidenceA = {
      expected_prospective_identity: 'prospective:a',
      expected_lock_key: 'new-book-lock:a',
      target_book_id: 'real-book-100',
      reason: 'book creation returned a stable ID',
      authorized_by: 'creator-a'
    }
    const promoted = promoteProspectiveIdentity(
      directory, 'prospective:a', 'new-book-lock:a', 'real-book-100', evidenceA, { lock: lockA }
    )
    assert.equal(promoted.target_book_id, 'real-book-100')
    assert.equal(promoted.prospective_identity, 'prospective:a')
    assert.deepEqual(promoteProspectiveIdentity(
      directory, 'prospective:a', 'new-book-lock:a', 'real-book-100', evidenceA, { lock: lockA }
    ), promoted)
    releaseLock(directory, 'new-book-lock:a', 'creator-a')

    const lockB = acquireLock(directory, 'new-book-lock:b', 'creator-b')
    assert.throws(() => promoteProspectiveIdentity(
      directory,
      'prospective:b',
      'new-book-lock:b',
      'real-book-100',
      {
        expected_prospective_identity: 'prospective:b',
        expected_lock_key: 'new-book-lock:b',
        target_book_id: 'real-book-100',
        reason: 'attempt duplicate real book binding',
        authorized_by: 'creator-b'
      },
      { lock: lockB }
    ), /already bound to a different prospective identity or lock key/)
    releaseLock(directory, 'new-book-lock:b', 'creator-b')
  })

  test('ledger promotion preserves the prospective logical identity', () => {
    const directory = tempDirectory('semantic-ledger-promotion-')
    registerProspectiveIdentity(directory, 'prospective:ledger', 'new-book-lock:ledger')
    const ledger = sealLedger({
      schema_version: 2,
      ledger_id: 'ledger-promotion',
      skill: { name: 'fixture', version: '1.0.0', rule_pack_hash: `sha256:${'1'.repeat(64)}` },
      created_at: '2026-08-12T00:00:00.000Z',
      updated_at: '2026-08-12T00:00:00.000Z',
      items: [{
        item_id: 'item-a',
        lock_key: 'new-book-lock:ledger',
        target: {
          book_stable_identity: 'prospective:ledger',
          prospective_identity: 'prospective:ledger',
          promoted_book_id: null,
          catalog_scope: { kind: 'book_scope', value: 'whole_book' }
        },
        book: {
          item_id: 'item-a',
          lock_key: 'new-book-lock:ledger',
          target_book_prospective_identity: 'prospective:ledger'
        },
        state: 'pending',
        attempt: 0,
        fingerprint: null,
        idempotency_key: null,
        apply_authorization: null,
        write_blocked: null,
        evidence: {},
        last_error: null,
        history: [{ from: null, to: 'pending', at: '2026-08-12T00:00:00.000Z', note: 'fixture', evidence: {} }]
      }]
    })
    const lock = acquireLock(directory, 'new-book-lock:ledger', 'creator')
    const updated = promoteLedgerTarget(ledger, 'item-a', 'real-book-200', {
      expected_prospective_identity: 'prospective:ledger',
      expected_lock_key: 'new-book-lock:ledger',
      target_book_id: 'real-book-200',
      reason: 'created target book',
      authorized_by: 'creator'
    }, { lock })
    assert.equal(updated.items[0].target.book_stable_identity, 'prospective:ledger')
    assert.equal(updated.items[0].target.promoted_book_id, 'real-book-200')
    assert.equal(updated.items[0].book.target_book_id, 'real-book-200')
    releaseLock(directory, 'new-book-lock:ledger', 'creator')
  })
})
