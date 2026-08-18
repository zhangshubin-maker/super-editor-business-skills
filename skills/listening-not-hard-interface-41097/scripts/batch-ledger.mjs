#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  assertValidRulePack,
  atomicWriteText,
  hashJson,
  isPlainObject,
  readJson,
  writeJson
} from './semantic-rule-tools.mjs'

export const LEDGER_SCHEMA_VERSION = 2
export const NORMAL_STATES = ['pending', 'planned', 'preflighted', 'applied', 'saved', 'verified', 'verified_skip']
export const EXCEPTION_STATES = ['needs_review', 'conflict', 'failed', 'outcome_unknown']
export const ALL_STATES = new Set([...NORMAL_STATES, ...EXCEPTION_STATES])
export const DEFAULT_LOCK_DIRECTORY = path.resolve(
  process.env.LOCALAPPDATA || path.join(os.homedir(), '.codex'),
  'Codex',
  'super-editor-semantic-teaching-aid',
  'locks'
)

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/
const FNV_HASH_PATTERN = /^fnv1a32:[a-f0-9]{8}$/
const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000
const ALLOWED_TRANSITIONS = Object.freeze({
  pending: new Set(['planned', 'needs_review', 'failed']),
  planned: new Set(['preflighted', 'needs_review', 'conflict', 'failed', 'outcome_unknown']),
  preflighted: new Set(['applied', 'needs_review', 'conflict', 'failed', 'outcome_unknown']),
  applied: new Set(['saved', 'needs_review', 'conflict', 'failed', 'outcome_unknown']),
  saved: new Set(['verified', 'needs_review', 'conflict', 'failed', 'outcome_unknown']),
  verified: new Set(),
  verified_skip: new Set(),
  needs_review: new Set(['planned']),
  conflict: new Set(['planned']),
  failed: new Set(['planned']),
  outcome_unknown: new Set(['applied', 'saved', 'verified', 'needs_review', 'failed'])
})

function timestamp(now) {
  return now ? String(now) : new Date().toISOString()
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) throw new Error(`${label} must match sha256:<64 lowercase hex>`)
  return value
}

function requireObject(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`)
  return value
}

function nonEmpty(value, label) {
  const result = String(value ?? '').trim()
  if (!result) throw new Error(`${label} is required`)
  return result
}

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** Production uses one user-level namespace. Library injection is accepted only under node:test. */
export function resolveLockDirectory(lockDirectory) {
  if (lockDirectory === undefined || lockDirectory === null || lockDirectory === '') return DEFAULT_LOCK_DIRECTORY
  const resolved = path.resolve(lockDirectory)
  if (resolved === DEFAULT_LOCK_DIRECTORY) return resolved
  const testContext = Boolean(process.env.NODE_TEST_CONTEXT)
  if (!testContext || !isWithin(os.tmpdir(), resolved)) {
    throw new Error(`custom lock directory is test-only; omit it to use ${DEFAULT_LOCK_DIRECTORY}`)
  }
  return resolved
}

function ensureControlledDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`refusing unsafe lock directory: ${directory}`)
  return directory
}

function lockFilename(lockDirectory, lockKey) {
  const target = nonEmpty(lockKey, 'target book/lock key')
  const directory = resolveLockDirectory(lockDirectory)
  const digest = crypto.createHash('sha256').update(target).digest('hex').slice(0, 32)
  return path.resolve(directory, `target-${digest}.lock.json`)
}

function readRegularJson(filename, label) {
  const stat = fs.lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`refusing unsafe ${label} file: ${filename}`)
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read ${label} file ${filename}: ${error.message}`)
  }
}

function readTrustedArtifact(filename, label) {
  const resolved = path.resolve(filename)
  const parent = fs.lstatSync(path.dirname(resolved))
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error(`refusing unsafe ${label} parent directory: ${path.dirname(resolved)}`)
  const pathStat = fs.lstatSync(resolved)
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new Error(`refusing unsafe ${label} file: ${resolved}`)
  const descriptor = fs.openSync(resolved, 'r')
  try {
    const openedStat = fs.fstatSync(descriptor)
    if (!openedStat.isFile() || openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new Error(`${label} changed while it was being opened`)
    }
    const bytes = fs.readFileSync(descriptor)
    let value
    try {
      value = JSON.parse(bytes.toString('utf8'))
    } catch (error) {
      throw new Error(`cannot read ${label} file ${resolved}: ${error.message}`)
    }
    return {
      value,
      file_sha256: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
    }
  } finally {
    fs.closeSync(descriptor)
  }
}

function writeNewJson(filename, value) {
  let descriptor
  let created = false
  try {
    descriptor = fs.openSync(filename, 'wx', 0o600)
    created = true
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
      descriptor = undefined
    }
    if (created) {
      try { fs.unlinkSync(filename) } catch {}
    }
    throw error
  }
  fs.closeSync(descriptor)
}

function rewriteExistingLock(filename, expectedNonce, transform) {
  const descriptor = fs.openSync(filename, 'r+')
  try {
    const current = JSON.parse(fs.readFileSync(descriptor, 'utf8'))
    if (current.nonce !== expectedNonce) throw new Error('lock changed after inspection; inspect again')
    const updated = transform(current)
    const output = `${JSON.stringify(updated, null, 2)}\n`
    fs.ftruncateSync(descriptor, 0)
    fs.writeSync(descriptor, output, 0, 'utf8')
    fs.fsyncSync(descriptor)
    return updated
  } finally {
    fs.closeSync(descriptor)
  }
}

export function lockStatus(lockDirectory, lockKey) {
  const key = nonEmpty(lockKey, 'target book/lock key')
  const filename = lockFilename(lockDirectory, key)
  if (!fs.existsSync(filename)) return { held: false, lock_key: key, target_book_id: key, lock_path: filename }
  const lock = readRegularJson(filename, 'lock')
  return { held: true, ...lock, lock_key: lock.lock_key ?? lock.target_book_id ?? key, lock_path: filename }
}

function processLiveness(lock) {
  if (lock.hostname !== os.hostname()) return 'unknown_remote_host'
  if (!Number.isInteger(lock.process_id) || lock.process_id <= 0) return 'unknown'
  try {
    process.kill(lock.process_id, 0)
    return 'running'
  } catch (error) {
    if (error.code === 'ESRCH') return 'not_running'
    if (error.code === 'EPERM') return 'running_or_inaccessible'
    return 'unknown'
  }
}

export function inspectLock(lockDirectory, lockKey, { now, staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
  const current = lockStatus(lockDirectory, lockKey)
  if (!current.held) return { ...current, stale_candidate: false, recoverable: false }
  const observedAt = timestamp(now)
  const observedMs = Date.parse(observedAt)
  const heartbeatMs = Date.parse(current.heartbeat_at ?? current.acquired_at)
  const ageMs = Number.isFinite(observedMs) && Number.isFinite(heartbeatMs) ? Math.max(0, observedMs - heartbeatMs) : null
  const threshold = Number(staleAfterMs)
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error('staleAfterMs must be a non-negative number')
  const staleCandidate = ageMs !== null && ageMs >= threshold
  return {
    ...current,
    inspected_at: observedAt,
    heartbeat_age_ms: ageMs,
    stale_after_ms: threshold,
    stale_candidate: staleCandidate,
    process_liveness: processLiveness(current),
    recoverable: false,
    recovery_requirement: staleCandidate
      ? 'explicit evidence with observed_nonce, reason, authorized_by and confirm_owner_inactive=true'
      : 'lock is not stale by age; transfer it from the current owner instead'
  }
}

export function acquireLock(lockDirectory, lockKey, owner, { now } = {}) {
  const key = nonEmpty(lockKey, 'target book/lock key')
  const lockOwner = nonEmpty(owner, 'lock owner')
  const filename = lockFilename(lockDirectory, key)
  ensureControlledDirectory(path.dirname(filename))
  const acquiredAt = timestamp(now)
  const lock = {
    schema_version: 2,
    lock_key: key,
    target_book_id: key,
    owner: lockOwner,
    acquired_at: acquiredAt,
    heartbeat_at: acquiredAt,
    hostname: os.hostname(),
    process_id: process.pid,
    nonce: crypto.randomUUID(),
    transfer_history: []
  }
  try {
    writeNewJson(filename, lock)
  } catch (error) {
    if (error.code === 'EEXIST') {
      const current = inspectLock(lockDirectory, key)
      throw new Error(`target is already locked by ${current.owner ?? 'unknown'} at ${current.acquired_at ?? 'unknown'}; inspect before transfer or recovery`)
    }
    throw error
  }
  return { held: true, ...lock, lock_path: filename }
}

export function transferLock(lockDirectory, lockKey, owner, newOwner, evidence, { now } = {}) {
  const current = lockStatus(lockDirectory, lockKey)
  if (!current.held) throw new Error('target lock is not held')
  if (current.owner !== nonEmpty(owner, 'current lock owner')) throw new Error(`target lock belongs to ${current.owner}; refusing transfer`)
  const nextOwner = nonEmpty(newOwner, 'new lock owner')
  requireObject(evidence, 'transfer evidence')
  if (evidence.observed_nonce !== current.nonce) throw new Error('transfer evidence.observed_nonce must match the inspected lock')
  nonEmpty(evidence.reason, 'transfer evidence.reason')
  nonEmpty(evidence.authorized_by, 'transfer evidence.authorized_by')
  const at = timestamp(now)
  const updated = rewriteExistingLock(current.lock_path, current.nonce, (latest) => ({
    ...latest,
    owner: nextOwner,
    heartbeat_at: at,
    process_id: process.pid,
    hostname: os.hostname(),
    nonce: crypto.randomUUID(),
    transfer_history: [
      ...(Array.isArray(latest.transfer_history) ? latest.transfer_history : []),
      { from: owner, to: nextOwner, at, evidence: cloneJson(evidence) }
    ]
  }))
  return { held: true, ...updated, lock_path: current.lock_path }
}

export function recoverLock(lockDirectory, lockKey, newOwner, evidence, { now, staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
  const inspection = inspectLock(lockDirectory, lockKey, { now, staleAfterMs })
  if (!inspection.held) throw new Error('target lock is not held; acquire it normally')
  if (!inspection.stale_candidate) throw new Error('lock is not a stale candidate; request an owner transfer')
  if (inspection.hostname === os.hostname() && inspection.process_liveness === 'running') {
    throw new Error('lock owner process is still running on this host; recovery is forbidden regardless of age or supplied evidence')
  }
  requireObject(evidence, 'recovery evidence')
  if (evidence.observed_nonce !== inspection.nonce) throw new Error('recovery evidence.observed_nonce must match the inspected lock')
  if (evidence.confirm_owner_inactive !== true) throw new Error('recovery evidence.confirm_owner_inactive=true is required')
  nonEmpty(evidence.reason, 'recovery evidence.reason')
  nonEmpty(evidence.authorized_by, 'recovery evidence.authorized_by')
  const recoveryDirectory = ensureControlledDirectory(path.join(path.dirname(inspection.lock_path), 'recovered'))
  const archive = path.join(recoveryDirectory, `${path.basename(inspection.lock_path)}.${inspection.nonce}.recovered.json`)
  if (fs.existsSync(archive)) throw new Error('recovery archive already exists; inspect the current lock again')
  const latest = lockStatus(lockDirectory, lockKey)
  if (!latest.held || latest.nonce !== inspection.nonce) throw new Error('lock changed after inspection; refusing recovery')
  fs.renameSync(inspection.lock_path, archive)
  try {
    const recovered = acquireLock(lockDirectory, lockKey, newOwner, { now })
    const recovery = {
      recovered_at: timestamp(now),
      recovered_by: nonEmpty(newOwner, 'new lock owner'),
      archived_lock_path: archive,
      prior_owner: inspection.owner,
      prior_nonce: inspection.nonce,
      evidence: cloneJson(evidence)
    }
    const updated = rewriteExistingLock(recovered.lock_path, recovered.nonce, (lock) => ({ ...lock, recovery }))
    return { held: true, ...updated, lock_path: recovered.lock_path }
  } catch (error) {
    if (!fs.existsSync(inspection.lock_path) && fs.existsSync(archive)) fs.renameSync(archive, inspection.lock_path)
    throw error
  }
}

export function releaseLock(lockDirectory, lockKey, owner) {
  const current = lockStatus(lockDirectory, lockKey)
  if (!current.held) throw new Error('target lock is not held')
  if (current.owner !== String(owner)) throw new Error(`target lock belongs to ${current.owner}; refusing release`)
  const released = `${current.lock_path}.${process.pid}.${Date.now()}.released`
  fs.renameSync(current.lock_path, released)
  fs.unlinkSync(released)
  return { released: true, target_book_id: current.lock_key, owner: current.owner }
}

function stableLockKey(book, itemId) {
  const explicit = String(book.lock_key ?? '').trim()
  const targetBook = String(book.target_book_id ?? '').trim()
  if (!explicit && !targetBook) throw new Error(`book ${itemId} requires target_book_id or a persisted stable lock_key`)
  if (explicit && explicit === String(itemId)) throw new Error(`book ${itemId}.lock_key must not fall back to item_id`)
  return explicit || targetBook
}

function prospectiveIdentity(book, itemId) {
  const value = String(book.target_book_prospective_identity ?? '').trim()
  if (!value) return null
  if (value === String(itemId)) throw new Error(`book ${itemId}.target_book_prospective_identity must not fall back to item_id`)
  return value
}

function stableTargetIdentity(book, lockKey) {
  const explicit = String(book.target_book_stable_identity ?? '').trim()
  if (explicit) return explicit
  const prospective = String(book.target_book_prospective_identity ?? '').trim()
  if (prospective) return prospective
  return nonEmpty(book.target_book_id ?? lockKey, 'target book stable identity')
}

function targetCatalogScope(book) {
  if (book.target_catalog_scope !== undefined && book.target_catalog_scope !== null && book.target_catalog_scope !== '') {
    return cloneJson(book.target_catalog_scope)
  }
  if (String(book.target_catalog_id ?? '').trim()) return { kind: 'catalog_id', value: String(book.target_catalog_id).trim() }
  if (String(book.target_catalog_path ?? '').trim()) return { kind: 'catalog_path', value: String(book.target_catalog_path).trim() }
  return { kind: 'book_scope', value: 'whole_book' }
}

function requireHeldLock(lock, lockKey, now) {
  if (!isPlainObject(lock) || lock.held !== true) throw new Error('a held target lock is required for ledger transitions')
  if (String(lock.lock_key ?? lock.target_book_id) !== String(lockKey)) throw new Error('held lock target does not match ledger item')
  if (!String(lock.owner ?? '').trim()) throw new Error('held lock owner is required')
  const current = lockStatus(path.dirname(lock.lock_path), lockKey)
  if (!current.held || current.owner !== lock.owner || current.nonce !== lock.nonce) {
    throw new Error('held lock evidence is stale; inspect or reacquire the target lock')
  }
  const refreshed = rewriteExistingLock(current.lock_path, current.nonce, (latest) => ({
    ...latest,
    heartbeat_at: timestamp(now),
    hostname: os.hostname(),
    process_id: process.pid
  }))
  return { held: true, ...refreshed, lock_path: current.lock_path }
}

function sealLedger(ledger) {
  const copy = cloneJson(ledger)
  delete copy.integrity_hash
  ledger.integrity_hash = hashJson(copy)
  return ledger
}

function normalizeFingerprint(value, rulePackHash, label = 'fingerprint') {
  const fingerprint = cloneJson(requireObject(value, label))
  requireHash(fingerprint.source_snapshot_hash, `${label}.source_snapshot_hash`)
  requireHash(fingerprint.template_snapshot_hash, `${label}.template_snapshot_hash`)
  requireHash(fingerprint.target_before_hash, `${label}.target_before_hash`)
  if (fingerprint.resolved_template_id === undefined || fingerprint.resolved_template_id === null || fingerprint.resolved_template_id === '') {
    throw new Error(`${label}.resolved_template_id is required`)
  }
  const suppliedRuleHash = fingerprint.rule_pack_hash ?? rulePackHash
  requireHash(suppliedRuleHash, `${label}.rule_pack_hash`)
  if (suppliedRuleHash !== rulePackHash) throw new Error(`${label}.rule_pack_hash does not match the ledger rule pack`)
  fingerprint.rule_pack_hash = suppliedRuleHash
  return fingerprint
}

export function buildLogicalIdentity(ledger, item, fingerprintInput) {
  const fingerprint = normalizeFingerprint(fingerprintInput, ledger.skill.rule_pack_hash)
  const logicalIdentity = {
    schema_version: 1,
    source_snapshot_hash: fingerprint.source_snapshot_hash,
    template_snapshot_hash: fingerprint.template_snapshot_hash,
    rule_pack_hash: ledger.skill.rule_pack_hash,
    target: {
      book_stable_identity: item.target.book_stable_identity,
      catalog_scope: cloneJson(item.target.catalog_scope)
    }
  }
  return { logical_identity: logicalIdentity, idempotency_key: hashJson(logicalIdentity), fingerprint }
}

function identityDirectory(lockDirectory) {
  return path.join(resolveLockDirectory(lockDirectory), 'idempotency')
}

function targetIdentityDirectory(lockDirectory) {
  return path.join(resolveLockDirectory(lockDirectory), 'target-identities')
}

function targetIdentityFilename(lockDirectory, kind, value) {
  const normalized = nonEmpty(value, `${kind} identity`)
  const digest = crypto.createHash('sha256').update(normalized).digest('hex')
  return path.join(targetIdentityDirectory(lockDirectory), `${kind}-${digest}.json`)
}

function targetIdentityRecord(filename, expectedKind, expectedValue) {
  if (!fs.existsSync(filename)) return null
  const record = readRegularJson(filename, 'target identity')
  const integrity = record.integrity_hash
  const copy = cloneJson(record)
  delete copy.integrity_hash
  if (!HASH_PATTERN.test(String(integrity)) || hashJson(copy) !== integrity) throw new Error(`target identity registry integrity check failed: ${filename}`)
  if (record.index_kind !== expectedKind || record.index_value !== expectedValue) {
    throw new Error(`target identity registry index mismatch: ${filename}`)
  }
  return record
}

function sealTargetIdentityRecord(record) {
  const copy = cloneJson(record)
  delete copy.integrity_hash
  return { ...copy, integrity_hash: hashJson(copy) }
}

function writeTargetIdentityIndex(lockDirectory, kind, value, binding) {
  const directory = ensureControlledDirectory(targetIdentityDirectory(lockDirectory))
  const filename = targetIdentityFilename(lockDirectory, kind, value)
  const record = sealTargetIdentityRecord({
    schema_version: 1,
    index_kind: kind,
    index_value: value,
    binding: cloneJson(binding),
    created_at: binding.registered_at,
    updated_at: binding.updated_at ?? binding.registered_at
  })
  writeNewJson(filename, record)
  return filename
}

function targetIdentityGuardFilename(lockDirectory) {
  return path.join(targetIdentityDirectory(lockDirectory), '.registry.guard')
}

function withTargetIdentityGuard(lockDirectory, operation) {
  const directory = ensureControlledDirectory(targetIdentityDirectory(lockDirectory))
  const guard = targetIdentityGuardFilename(lockDirectory)
  let descriptor
  try {
    descriptor = fs.openSync(guard, 'wx', 0o600)
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('target identity registry is busy; retry after the concurrent registration or promotion completes')
    throw error
  }
  try {
    return operation()
  } finally {
    try { fs.closeSync(descriptor) } catch {}
    try { fs.unlinkSync(guard) } catch {}
  }
}

function inspectTargetIdentityBinding(lockDirectory, prospective, lockKey, targetBookId = null) {
  const indexes = [
    ['prospective', prospective],
    ['lock-key', lockKey]
  ]
  const records = indexes.map(([kind, value]) => targetIdentityRecord(
    targetIdentityFilename(lockDirectory, kind, value), kind, value
  )).filter(Boolean)
  for (const record of records) {
    const binding = record.binding
    if (binding.prospective_identity !== prospective || binding.lock_key !== lockKey) {
      throw new Error(`target identity conflict: ${record.index_kind} is already bound to a different prospective identity or lock key`)
    }
    if (targetBookId && binding.target_book_id && binding.target_book_id !== targetBookId) {
      throw new Error(`target identity conflict: prospective identity is already promoted to ${binding.target_book_id}`)
    }
  }
  if (targetBookId) {
    const targetRecord = targetIdentityRecord(
      targetIdentityFilename(lockDirectory, 'target-book-id', targetBookId),
      'target-book-id',
      targetBookId
    )
    if (targetRecord) {
      const binding = targetRecord.binding
      if (binding.prospective_identity !== prospective || binding.lock_key !== lockKey || binding.target_book_id !== targetBookId) {
        throw new Error('target identity conflict: target book id is already bound to a different prospective identity or lock key')
      }
      records.push(targetRecord)
    }
  }
  return records
}

/** Atomically reserve both directions of a prospective target identity. */
export function registerProspectiveIdentity(lockDirectory, prospectiveIdentityValue, lockKeyValue, { now } = {}) {
  const prospective = nonEmpty(prospectiveIdentityValue, 'target book prospective identity')
  const lockKey = nonEmpty(lockKeyValue, 'target book lock key')
  return withTargetIdentityGuard(lockDirectory, () => {
    const existing = inspectTargetIdentityBinding(lockDirectory, prospective, lockKey)
    if (existing.length === 2) {
      if (hashJson(existing[0].binding) !== hashJson(existing[1].binding)) throw new Error('target identity reverse indexes disagree')
      return cloneJson(existing[0].binding)
    }
    if (existing.length === 1) throw new Error('target identity registry is incomplete; refusing to guess the missing reverse index')
    const at = timestamp(now)
    const binding = {
      prospective_identity: prospective,
      lock_key: lockKey,
      target_book_id: null,
      registered_at: at,
      updated_at: at
    }
    const prospectiveFile = targetIdentityFilename(lockDirectory, 'prospective', prospective)
    let wroteProspective = false
    try {
      writeTargetIdentityIndex(lockDirectory, 'prospective', prospective, binding)
      wroteProspective = true
      writeTargetIdentityIndex(lockDirectory, 'lock-key', lockKey, binding)
    } catch (error) {
      if (wroteProspective && fs.existsSync(prospectiveFile)) {
        try { fs.unlinkSync(prospectiveFile) } catch {}
      }
      throw error
    }
    return cloneJson(binding)
  })
}

function rewriteTargetIdentityIndex(lockDirectory, kind, value, expectedBindingHash, nextBinding) {
  const filename = targetIdentityFilename(lockDirectory, kind, value)
  const current = targetIdentityRecord(filename, kind, value)
  if (!current || hashJson(current.binding) !== expectedBindingHash) throw new Error('target identity changed during promotion; inspect again')
  atomicWriteText(filename, `${JSON.stringify(sealTargetIdentityRecord({
    ...current,
    binding: cloneJson(nextBinding),
    updated_at: nextBinding.updated_at
  }), null, 2)}\n`)
  try { fs.chmodSync(filename, 0o600) } catch {}
}

function restoreTargetIdentityIndex(filename, record) {
  atomicWriteText(filename, `${JSON.stringify(record, null, 2)}\n`)
  try { fs.chmodSync(filename, 0o600) } catch {}
}

/** Bind a prospective target to the created book without changing logical identity. */
export function promoteProspectiveIdentity(lockDirectory, prospectiveIdentityValue, lockKeyValue, targetBookIdValue, evidence, { now, lock } = {}) {
  const prospective = nonEmpty(prospectiveIdentityValue, 'target book prospective identity')
  const lockKey = nonEmpty(lockKeyValue, 'target book lock key')
  const targetBookId = nonEmpty(targetBookIdValue, 'target book id')
  const held = requireHeldLock(lock, lockKey, now)
  requireObject(evidence, 'promotion evidence')
  if (evidence.expected_prospective_identity !== prospective) throw new Error('promotion evidence.expected_prospective_identity must match')
  if (evidence.expected_lock_key !== lockKey) throw new Error('promotion evidence.expected_lock_key must match')
  if (String(evidence.target_book_id ?? '') !== targetBookId) throw new Error('promotion evidence.target_book_id must match')
  nonEmpty(evidence.reason, 'promotion evidence.reason')
  nonEmpty(evidence.authorized_by, 'promotion evidence.authorized_by')
  return withTargetIdentityGuard(lockDirectory, () => {
    const records = inspectTargetIdentityBinding(lockDirectory, prospective, lockKey, targetBookId)
    if (records.length < 2) throw new Error('prospective identity must be registered in both directions before promotion')
    if (new Set(records.map((record) => hashJson(record.binding))).size !== 1) {
      throw new Error('target identity reverse indexes disagree')
    }
    if (records[0].binding.target_book_id === targetBookId) return cloneJson(records[0].binding)
    const targetIndex = targetIdentityFilename(lockDirectory, 'target-book-id', targetBookId)
    if (fs.existsSync(targetIndex)) {
      inspectTargetIdentityBinding(lockDirectory, prospective, lockKey, targetBookId)
      throw new Error('target book id is already bound; inspect the target identity registry')
    }
    const at = timestamp(now)
    const priorBinding = records[0].binding
    const expectedBindingHash = hashJson(priorBinding)
    const nextBinding = {
      ...priorBinding,
      target_book_id: targetBookId,
      promoted_at: at,
      updated_at: at,
      promotion: { ...cloneJson(evidence), lock_owner: held.owner, lock_nonce: held.nonce }
    }
    let wroteTarget = false
    const prospectiveFile = targetIdentityFilename(lockDirectory, 'prospective', prospective)
    const lockFile = targetIdentityFilename(lockDirectory, 'lock-key', lockKey)
    const priorProspectiveRecord = readRegularJson(prospectiveFile, 'target identity')
    const priorLockRecord = readRegularJson(lockFile, 'target identity')
    let rewroteProspective = false
    try {
      writeTargetIdentityIndex(lockDirectory, 'target-book-id', targetBookId, nextBinding)
      wroteTarget = true
      rewriteTargetIdentityIndex(lockDirectory, 'prospective', prospective, expectedBindingHash, nextBinding)
      rewroteProspective = true
      rewriteTargetIdentityIndex(lockDirectory, 'lock-key', lockKey, expectedBindingHash, nextBinding)
    } catch (error) {
      if (rewroteProspective) {
        try { restoreTargetIdentityIndex(prospectiveFile, priorProspectiveRecord) } catch {}
      }
      try { restoreTargetIdentityIndex(lockFile, priorLockRecord) } catch {}
      if (wroteTarget && fs.existsSync(targetIndex)) {
        try { fs.unlinkSync(targetIndex) } catch {}
      }
      throw error
    }
    return cloneJson(nextBinding)
  })
}

function identityFilename(lockDirectory, idempotencyKey) {
  requireHash(idempotencyKey, 'idempotency key')
  return path.join(identityDirectory(lockDirectory), `${idempotencyKey.slice('sha256:'.length)}.json`)
}

function sealIdentityRecord(record) {
  const copy = cloneJson(record)
  delete copy.integrity_hash
  record.integrity_hash = hashJson(copy)
  return record
}

function readIdentityRecord(lockDirectory, idempotencyKey) {
  const filename = identityFilename(lockDirectory, idempotencyKey)
  if (!fs.existsSync(filename)) return null
  const record = readRegularJson(filename, 'idempotency')
  const integrity = record.integrity_hash
  const copy = cloneJson(record)
  delete copy.integrity_hash
  if (!HASH_PATTERN.test(String(integrity)) || hashJson(copy) !== integrity) throw new Error(`idempotency registry integrity check failed: ${filename}`)
  return { ...record, registry_path: filename }
}

function writeNewIdentityRecord(lockDirectory, record) {
  const directory = ensureControlledDirectory(identityDirectory(lockDirectory))
  const filename = path.join(directory, `${record.idempotency_key.slice('sha256:'.length)}.json`)
  writeNewJson(filename, sealIdentityRecord(record))
  return filename
}

function replaceIdentityRecord(lockDirectory, record) {
  const filename = identityFilename(lockDirectory, record.idempotency_key)
  atomicWriteText(filename, `${JSON.stringify(sealIdentityRecord(record), null, 2)}\n`)
  try { fs.chmodSync(filename, 0o600) } catch {}
}

function inspectIdentity(lockDirectory, idempotencyKey, logicalIdentity) {
  const current = readIdentityRecord(lockDirectory, idempotencyKey)
  if (current && hashJson(current.logical_identity) !== hashJson(logicalIdentity)) {
    throw new Error('idempotency registry hash collision or corrupted logical identity')
  }
  return current
}

function verifiedTargetHash(record) {
  return record?.evidence?.verified?.result_hash ?? record?.evidence?.saved?.save_readback_hash ?? null
}

function verifiedRecordMatchesTarget(record, fingerprint) {
  const targetHash = verifiedTargetHash(record)
  return Boolean(targetHash && targetHash === fingerprint.target_before_hash)
}

function claimIdentity(lockDirectory, ledger, item, identity, lock, now) {
  const record = {
    schema_version: 1,
    idempotency_key: identity.idempotency_key,
    logical_identity: cloneJson(identity.logical_identity),
    status: 'preflighted',
    claim: { ledger_id: ledger.ledger_id, item_id: item.item_id, lock_owner: lock.owner, lock_nonce: lock.nonce },
    created_at: timestamp(now),
    updated_at: timestamp(now),
    evidence: {}
  }
  try {
    writeNewIdentityRecord(lockDirectory, record)
    return { disposition: 'claimed', record }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const current = inspectIdentity(lockDirectory, identity.idempotency_key, identity.logical_identity)
  if (current.status === 'verified') {
    return {
      disposition: verifiedRecordMatchesTarget(current, identity.fingerprint) ? 'verified_skip' : 'verified_target_drift',
      record: current
    }
  }
  const sameClaim = current.claim?.ledger_id === ledger.ledger_id && current.claim?.item_id === item.item_id
  if (sameClaim && ['planned', 'preflighted', 'apply_authorized'].includes(current.status)) {
    return { disposition: 'owned', record: current }
  }
  if (sameClaim) return { disposition: 'conflict', record: current }
  if (current.status === 'superseded') {
    replaceIdentityRecord(lockDirectory, record)
    return { disposition: 'claimed_superseded', record }
  }
  return { disposition: 'conflict', record: current }
}

function updateIdentityStatus(lockDirectory, ledger, item, status, evidence, now) {
  if (!item.idempotency_key) return
  const current = readIdentityRecord(lockDirectory, item.idempotency_key)
  if (!current) throw new Error('idempotency claim is missing; refusing an untracked transition')
  if (current.claim?.ledger_id !== ledger.ledger_id || current.claim?.item_id !== item.item_id) {
    throw new Error('idempotency claim belongs to another ledger item')
  }
  const updated = {
    ...current,
    status,
    updated_at: timestamp(now),
    evidence: { ...(isPlainObject(current.evidence) ? current.evidence : {}), [status]: cloneJson(evidence) }
  }
  delete updated.registry_path
  replaceIdentityRecord(lockDirectory, updated)
}

function itemFromBook(book, index, createdAt) {
  requireObject(book, `books[${index}]`)
  const itemId = nonEmpty(book.item_id, `books[${index}].item_id`)
  const lockKey = stableLockKey(book, itemId)
  const prospective = prospectiveIdentity(book, itemId)
  if (!String(book.target_book_id ?? '').trim() && !prospective) {
    throw new Error(`book ${itemId} requires target_book_prospective_identity before target book creation`)
  }
  return {
    item_id: itemId,
    lock_key: lockKey,
    target: {
      book_stable_identity: stableTargetIdentity(book, lockKey),
      prospective_identity: prospective,
      promoted_book_id: String(book.target_book_id ?? '').trim() || null,
      catalog_scope: targetCatalogScope(book)
    },
    book: cloneJson(book),
    state: 'pending',
    attempt: 0,
    fingerprint: null,
    idempotency_key: null,
    apply_authorization: null,
    write_blocked: null,
    evidence: {},
    last_error: null,
    history: [{ from: null, to: 'pending', at: createdAt, note: 'ledger_initialized', evidence: {} }]
  }
}

export function initLedger(pack, booksInput, { now, ledgerId, lockDirectory, rulePackArtifactRoot } = {}) {
  assertValidRulePack(pack, rulePackArtifactRoot ? { artifactRoot: rulePackArtifactRoot } : undefined)
  const stateDirectory = resolveLockDirectory(lockDirectory)
  if (pack.identity.status !== 'validated') throw new Error('batch ledger requires a validated rule pack')
  const books = Array.isArray(booksInput) ? booksInput : booksInput?.books
  if (!Array.isArray(books) || books.length === 0) throw new Error('books must be a non-empty array')
  const createdAt = timestamp(now)
  const prospectivePairs = new Map()
  const lockPairs = new Map()
  const bookPairs = new Map()
  for (const [index, book] of books.entries()) {
    requireObject(book, `books[${index}]`)
    const itemId = nonEmpty(book.item_id, `books[${index}].item_id`)
    const lockKey = stableLockKey(book, itemId)
    const prospective = prospectiveIdentity(book, itemId)
    if (!String(book.target_book_id ?? '').trim() && !prospective) {
      throw new Error(`book ${itemId} requires target_book_prospective_identity before target book creation`)
    }
    if (String(book.target_book_id ?? '').trim()) {
      const targetBookId = String(book.target_book_id).trim()
      const stable = prospective || targetBookId
      const priorStable = bookPairs.get(targetBookId)
      if (priorStable && priorStable !== stable) throw new Error(`target book ${targetBookId} is assigned to multiple stable identities in one book list`)
      bookPairs.set(targetBookId, stable)
      if (!prospective) {
        const existingBookIndex = targetIdentityRecord(
          targetIdentityFilename(stateDirectory, 'target-book-id', targetBookId),
          'target-book-id',
          targetBookId
        )
        if (existingBookIndex && existingBookIndex.binding.prospective_identity !== targetBookId) {
          throw new Error(`target book ${targetBookId} is already promoted from prospective identity ${existingBookIndex.binding.prospective_identity}; reuse it`)
        }
      }
    }
    if (!prospective) continue
    const priorLock = prospectivePairs.get(prospective)
    if (priorLock && priorLock !== lockKey) throw new Error(`prospective identity ${prospective} is assigned to multiple lock keys in one book list`)
    const priorProspective = lockPairs.get(lockKey)
    if (priorProspective && priorProspective !== prospective) throw new Error(`lock key ${lockKey} is assigned to multiple prospective identities in one book list`)
    prospectivePairs.set(prospective, lockKey)
    lockPairs.set(lockKey, prospective)
  }
  const ledger = {
    schema_version: LEDGER_SCHEMA_VERSION,
    ledger_id: String(ledgerId ?? crypto.randomUUID()),
    skill: { name: pack.identity.skill_name, version: pack.identity.version, rule_pack_hash: hashJson(pack) },
    created_at: createdAt,
    updated_at: createdAt,
    items: books.map((book, index) => itemFromBook(book, index, createdAt))
  }
  for (const [prospective, lockKey] of prospectivePairs) {
    registerProspectiveIdentity(stateDirectory, prospective, lockKey, { now: createdAt })
  }
  const seenItems = new Set()
  const seenLogical = new Map()
  for (const item of ledger.items) {
    if (seenItems.has(item.item_id)) throw new Error(`duplicate item_id: ${item.item_id}`)
    seenItems.add(item.item_id)
    if (item.target.prospective_identity) {
      const records = inspectTargetIdentityBinding(stateDirectory, item.target.prospective_identity, item.lock_key)
      const binding = records[0]?.binding
      if (!binding) throw new Error(`book ${item.item_id} prospective target registration is missing`)
      if (item.target.promoted_book_id && binding.target_book_id !== item.target.promoted_book_id) {
        throw new Error(`book ${item.item_id} target_book_id requires an explicit promote-target operation before ledger initialization`)
      }
    }
    const supplied = item.book.preflight_fingerprint ?? item.book.fingerprint
    if (!supplied) continue
    const identity = buildLogicalIdentity(ledger, item, supplied)
    item.fingerprint = identity.fingerprint
    item.idempotency_key = identity.idempotency_key
    const localDuplicate = seenLogical.get(identity.idempotency_key)
    const existing = inspectIdentity(stateDirectory, identity.idempotency_key, identity.logical_identity)
    if (existing?.status === 'verified' && verifiedRecordMatchesTarget(existing, identity.fingerprint)) {
      item.state = 'verified_skip'
      item.evidence.verified_skip = { reason: 'logical_work_already_verified', registry: { ledger_id: existing.claim?.ledger_id, item_id: existing.claim?.item_id }, verified: existing.evidence?.verified }
      item.history.push({ from: 'pending', to: 'verified_skip', at: createdAt, note: 'init_duplicate_check', evidence: cloneJson(item.evidence.verified_skip) })
    } else if (existing?.status === 'verified') {
      item.state = 'conflict'
      item.last_error = 'verified logical work no longer matches the current target hash'
      item.evidence.conflict = {
        reason: 'verified_identity_target_drift',
        expected_target_hash: verifiedTargetHash(existing),
        current_target_hash: identity.fingerprint.target_before_hash
      }
      item.history.push({ from: 'pending', to: 'conflict', at: createdAt, note: 'init_duplicate_check', evidence: cloneJson(item.evidence.conflict) })
    } else if (localDuplicate) {
      item.state = 'conflict'
      item.last_error = `duplicate logical work already listed as ${localDuplicate}`
      item.evidence.conflict = { reason: 'duplicate_logical_work_in_ledger', duplicate_item_id: localDuplicate }
      item.history.push({ from: 'pending', to: 'conflict', at: createdAt, note: 'init_duplicate_check', evidence: cloneJson(item.evidence.conflict) })
    } else if (existing && existing.status !== 'superseded') {
      item.state = 'conflict'
      item.last_error = `logical work is already claimed in state ${existing.status}`
      item.evidence.conflict = { reason: 'logical_work_claimed_elsewhere', registry_status: existing.status, registry_ledger_id: existing.claim?.ledger_id, registry_item_id: existing.claim?.item_id }
      item.history.push({ from: 'pending', to: 'conflict', at: createdAt, note: 'init_duplicate_check', evidence: cloneJson(item.evidence.conflict) })
    }
    seenLogical.set(identity.idempotency_key, localDuplicate ?? item.item_id)
  }
  return sealLedger(ledger)
}

export function promoteLedgerTarget(input, itemId, targetBookId, evidence, { now, lock } = {}) {
  const validation = validateLedger(input)
  if (!validation.valid) throw new Error(`invalid ledger:\n- ${validation.errors.join('\n- ')}`)
  const ledger = cloneJson(input)
  const item = ledger.items.find((candidate) => candidate.item_id === String(itemId))
  if (!item) throw new Error(`unknown item: ${itemId}`)
  if (!item.target.prospective_identity) throw new Error('promote-target requires target_book_prospective_identity')
  if (!['pending', 'planned'].includes(item.state)) throw new Error(`promote-target is allowed only before preflight, got ${item.state}`)
  const held = requireHeldLock(lock, item.lock_key, now)
  const lockDirectory = path.dirname(held.lock_path)
  const binding = promoteProspectiveIdentity(
    lockDirectory,
    item.target.prospective_identity,
    item.lock_key,
    targetBookId,
    evidence,
    { now, lock: held }
  )
  item.target.promoted_book_id = binding.target_book_id
  item.book.target_book_id = binding.target_book_id
  item.book.target_book_prospective_identity = item.target.prospective_identity
  item.evidence.target_promoted = cloneJson(binding)
  const at = timestamp(now)
  item.history.push({
    from: item.state,
    to: item.state,
    at,
    note: 'prospective_target_promoted',
    lock_owner: held.owner,
    evidence: cloneJson(binding)
  })
  ledger.updated_at = at
  return sealLedger(ledger)
}

function requireStringField(value, label) {
  return nonEmpty(value, label)
}

function requireExactKeys(value, expectedKeys, label) {
  const actual = Object.keys(requireObject(value, label)).sort()
  const expected = [...expectedKeys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly: ${expected.join(', ')}`)
  }
}

function requireBoundIdentity(evidenceValue, itemValue, label) {
  const evidenceIdentity = requireStringField(evidenceValue, `transition evidence.${label}`)
  if (itemValue !== undefined && itemValue !== null && String(itemValue).trim() &&
      evidenceIdentity !== String(itemValue)) {
    throw new Error(`transition evidence.${label} does not match the ledger item`)
  }
  return evidenceIdentity
}

function validateReceiptHash(value, field, label) {
  const receipt = cloneJson(requireObject(value, label))
  const actual = requireHash(receipt[field], `${label}.${field}`)
  delete receipt[field]
  if (hashJson(receipt) !== actual) throw new Error(`${label}.${field} does not match receipt content`)
}

function validateVerifiedReceiptArtifact(evidence, ledger, item) {
  const receiptPath = path.resolve(requireStringField(
    evidence.provenance_readback_receipt_path,
    'transition evidence.provenance_readback_receipt_path'
  ))
  const expectedFileHash = requireHash(
    evidence.provenance_readback_receipt_sha256,
    'transition evidence.provenance_readback_receipt_sha256'
  )
  if (!fs.existsSync(receiptPath)) throw new Error(`provenance readback receipt artifact does not exist: ${receiptPath}`)
  const trustedReceipt = readTrustedArtifact(receiptPath, 'provenance readback receipt artifact')
  const receipt = trustedReceipt.value
  if (trustedReceipt.file_sha256 !== expectedFileHash) throw new Error('provenance readback receipt artifact file SHA-256 does not match evidence')
  requireExactKeys(receipt, [
    'schema_version', 'kind', 'run_id', 'provenance_integrity_hash', 'carrier_block_id',
    'identity', 'save', 'export', 'verified_at', 'artifact_integrity'
  ], 'receipt')
  if (receipt.schema_version !== 1 || receipt.kind !== 'semantic_provenance_readback_receipt') {
    throw new Error('provenance readback receipt artifact kind/schema is invalid')
  }
  const artifactIntegrity = requireObject(receipt.artifact_integrity, 'receipt.artifact_integrity')
  requireExactKeys(artifactIntegrity, ['algorithm', 'canonical_hash'], 'receipt.artifact_integrity')
  if (artifactIntegrity.algorithm !== 'sha256-canonical-json') throw new Error('receipt.artifact_integrity.algorithm must be sha256-canonical-json')
  const canonicalHash = requireHash(artifactIntegrity.canonical_hash, 'receipt.artifact_integrity.canonical_hash')
  const canonicalContent = cloneJson(receipt)
  delete canonicalContent.artifact_integrity
  if (hashJson(canonicalContent) !== canonicalHash) throw new Error('receipt.artifact_integrity.canonical_hash does not match receipt content')

  const expectedRunId = requireStringField(evidence.run_id, 'transition evidence.run_id')
  const expectedProvenanceHash = requireHash(evidence.provenance_hash, 'transition evidence.provenance_hash')
  const expectedCarrierBlockId = requireStringField(evidence.carrier_block_id, 'transition evidence.carrier_block_id')
  if (receipt.run_id !== expectedRunId) throw new Error('receipt.run_id does not match transition evidence')
  if (receipt.provenance_integrity_hash !== expectedProvenanceHash) throw new Error('receipt.provenance_integrity_hash does not match transition evidence.provenance_hash')
  if (receipt.carrier_block_id !== expectedCarrierBlockId) throw new Error('receipt.carrier_block_id does not match transition evidence')

  const identity = requireObject(receipt.identity, 'receipt.identity')
  requireExactKeys(identity, [
    'slide_id', 'source_book_id', 'source_catalog_id', 'target_book_id', 'target_catalog_id'
  ], 'receipt.identity')
  const expectedSlideId = requireStringField(evidence.slide_id, 'transition evidence.slide_id')
  if (String(identity.slide_id) !== expectedSlideId) throw new Error('receipt.identity.slide_id does not match transition evidence.slide_id')
  const expectedIdentity = {
    source_book_id: requireBoundIdentity(evidence.source_book_id, item.book?.source_book_id, 'source_book_id'),
    source_catalog_id: requireBoundIdentity(evidence.source_catalog_id, item.book?.source_catalog_id, 'source_catalog_id'),
    target_book_id: requireBoundIdentity(
      evidence.target_book_id,
      item.target?.promoted_book_id ?? item.book?.target_book_id,
      'target_book_id'
    ),
    target_catalog_id: requireBoundIdentity(evidence.target_catalog_id, item.book?.target_catalog_id, 'target_catalog_id')
  }
  for (const [field, expected] of Object.entries(expectedIdentity)) {
    if (String(identity[field]) !== expected) throw new Error(`receipt.identity.${field} does not match ledger/transition evidence`)
  }
  if (expectedIdentity.target_catalog_id !== expectedSlideId) {
    throw new Error('receipt target_catalog_id must equal the verified slide_id')
  }
  if (item.target?.promoted_book_id && expectedIdentity.target_book_id !== String(item.target.promoted_book_id)) {
    throw new Error('transition target_book_id does not match promoted target identity')
  }

  const save = requireObject(receipt.save, 'receipt.save')
  requireExactKeys(save, [
    'tool', 'scope', 'slide_id', 'saved', 'saved_scope', 'saved_slides', 'verified',
    'verified_scope', 'verified_slides', 'content_hash', 'persisted_content_hash',
    'dirty', 'envelope_hash', 'receipt_hash'
  ], 'receipt.save')
  if (save.tool !== 'editor_save_verified' || save.scope !== 'current' || save.saved !== true ||
      save.saved_scope !== 'current' || save.verified !== true || save.verified_scope !== 'current' || save.dirty !== false) {
    throw new Error('receipt.save does not prove a clean current-slide editor_save_verified result')
  }
  if (String(save.slide_id) !== expectedSlideId || !Array.isArray(save.saved_slides) || save.saved_slides.length !== 1 ||
      String(save.saved_slides[0]) !== expectedSlideId || !Array.isArray(save.verified_slides) || save.verified_slides.length !== 1 ||
      String(save.verified_slides[0]) !== expectedSlideId) {
    throw new Error('receipt.save slide binding is invalid')
  }
  if (!FNV_HASH_PATTERN.test(String(save.content_hash)) || save.content_hash !== save.persisted_content_hash) {
    throw new Error('receipt.save content hashes must be matching fnv1a32 values')
  }
  requireHash(save.envelope_hash, 'receipt.save.envelope_hash')
  validateReceiptHash(save, 'receipt_hash', 'receipt.save')

  const exported = requireObject(receipt.export, 'receipt.export')
  requireExactKeys(exported, [
    'tool', 'slide_id', 'block_count', 'page_content_hash', 'blocks_hash',
    'carrier_block_hash', 'envelope_hash', 'receipt_hash'
  ], 'receipt.export')
  if (exported.tool !== 'editor_export_slide' || String(exported.slide_id) !== expectedSlideId) {
    throw new Error('receipt.export tool/slide binding is invalid')
  }
  if (!Number.isInteger(exported.block_count) || exported.block_count < 1) throw new Error('receipt.export.block_count must be a positive integer')
  if (!FNV_HASH_PATTERN.test(String(exported.page_content_hash)) || exported.page_content_hash !== save.content_hash) {
    throw new Error('receipt export page_content_hash must equal the verified save content hash')
  }
  for (const field of ['blocks_hash', 'carrier_block_hash', 'envelope_hash']) requireHash(exported[field], `receipt.export.${field}`)
  validateReceiptHash(exported, 'receipt_hash', 'receipt.export')
  const verifiedAt = requireStringField(receipt.verified_at, 'receipt.verified_at')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(verifiedAt) || Number.isNaN(Date.parse(verifiedAt))) {
    throw new Error('receipt.verified_at must be an ISO-8601 UTC timestamp')
  }

  const savedHash = item.evidence?.saved?.save_readback_hash
  const resultHash = requireHash(evidence.result_hash, 'transition evidence.result_hash')
  if (!savedHash || resultHash !== savedHash) {
    throw new Error('verified result_hash must equal the prior saved.save_readback_hash')
  }
  return {
    artifact_path: receiptPath,
    artifact_file_sha256: expectedFileHash,
    artifact_canonical_hash: canonicalHash,
    run_id: receipt.run_id,
    provenance_integrity_hash: receipt.provenance_integrity_hash,
    carrier_block_id: receipt.carrier_block_id,
    identity: cloneJson(identity),
    save_receipt_hash: save.receipt_hash,
    export_receipt_hash: exported.receipt_hash,
    verified_at: receipt.verified_at
  }
}

function requireTransitionEvidence(to, evidence, ledger, item) {
  requireObject(evidence, 'transition evidence')
  if (to === 'preflighted') requireObject(evidence.fingerprint, 'transition evidence.fingerprint')
  if (to === 'applied') requireHash(evidence.target_after_hash, 'transition evidence.target_after_hash')
  if (to === 'saved') requireHash(evidence.save_readback_hash, 'transition evidence.save_readback_hash')
  if (to === 'verified') {
    requireHash(evidence.result_hash, 'transition evidence.result_hash')
    requireHash(evidence.provenance_hash, 'transition evidence.provenance_hash')
    return validateVerifiedReceiptArtifact(evidence, ledger, item)
  }
  if (EXCEPTION_STATES.includes(to) && !String(evidence.reason ?? '').trim()) throw new Error(`transition to ${to} requires evidence.reason`)
  return null
}

function fingerprintDifferences(expected, current) {
  const keys = ['source_snapshot_hash', 'template_snapshot_hash', 'rule_pack_hash', 'target_before_hash', 'resolved_template_id']
  return keys.filter((key) => String(expected?.[key]) !== String(current?.[key])).map((key) => ({ field: key, expected: expected?.[key] ?? null, current: current?.[key] ?? null }))
}

function replanForDrift(ledger, item, currentFingerprint, differences, lockDirectory, lock, now) {
  const from = item.state
  const at = timestamp(now)
  const evidence = { reason: 'pre_apply_fingerprint_drift', differences, expected: cloneJson(item.fingerprint), current: cloneJson(currentFingerprint) }
  const identityFields = new Set(['source_snapshot_hash', 'template_snapshot_hash', 'rule_pack_hash', 'resolved_template_id'])
  const priorStatus = differences.some((entry) => identityFields.has(entry.field)) ? 'superseded' : 'planned'
  updateIdentityStatus(lockDirectory, ledger, item, priorStatus, evidence, now)
  item.state = 'planned'
  item.attempt += 1
  item.apply_authorization = null
  item.write_blocked = cloneJson(evidence)
  item.evidence.pre_apply_drift = cloneJson(evidence)
  item.last_error = evidence.reason
  item.history.push({ from, to: 'planned', at, note: 'write_blocked_before_apply', lock_owner: lock.owner, evidence: cloneJson(evidence) })
  ledger.updated_at = at
  return sealLedger(ledger)
}

/** Gate that must run immediately before editor writes. It never authorizes when any preflight input drifted. */
export function authorizeApply(input, itemId, currentFingerprintInput, { now, lock } = {}) {
  const validation = validateLedger(input)
  if (!validation.valid) throw new Error(`invalid ledger:\n- ${validation.errors.join('\n- ')}`)
  const ledger = cloneJson(input)
  const item = ledger.items.find((candidate) => candidate.item_id === String(itemId))
  if (!item) throw new Error(`unknown item: ${itemId}`)
  if (item.state !== 'preflighted') throw new Error(`apply authorization requires preflighted state, got ${item.state}`)
  const held = requireHeldLock(lock, item.lock_key, now)
  if (!isPlainObject(currentFingerprintInput) || !Object.hasOwn(currentFingerprintInput, 'rule_pack_hash')) {
    throw new Error('current fingerprint.rule_pack_hash is required for the pre-apply rule-pack recheck')
  }
  const currentFingerprint = normalizeFingerprint(currentFingerprintInput, ledger.skill.rule_pack_hash, 'current fingerprint')
  const differences = fingerprintDifferences(item.fingerprint, currentFingerprint)
  const lockDirectory = path.dirname(held.lock_path)
  if (differences.length) return replanForDrift(ledger, item, currentFingerprint, differences, lockDirectory, held, now)
  const identityRecord = readIdentityRecord(lockDirectory, item.idempotency_key)
  if (!identityRecord || identityRecord.claim?.ledger_id !== ledger.ledger_id || identityRecord.claim?.item_id !== item.item_id) {
    throw new Error('apply authorization requires this ledger item to own the idempotency claim')
  }
  if (!['planned', 'preflighted', 'apply_authorized'].includes(identityRecord.status)) {
    throw new Error(`idempotency registry is already in ${identityRecord.status}; read back before any write`)
  }
  const at = timestamp(now)
  item.apply_authorization = {
    token: crypto.randomUUID(),
    issued_at: at,
    fingerprint_hash: hashJson(currentFingerprint),
    idempotency_key: item.idempotency_key,
    lock_owner: held.owner,
    lock_nonce: held.nonce
  }
  item.write_blocked = null
  item.last_error = null
  item.evidence.apply_authorized = { fingerprint: cloneJson(currentFingerprint), authorization: cloneJson(item.apply_authorization) }
  item.history.push({ from: 'preflighted', to: 'preflighted', at, note: 'apply_authorized_after_fingerprint_recheck', lock_owner: held.owner, evidence: cloneJson(item.evidence.apply_authorized) })
  ledger.updated_at = at
  updateIdentityStatus(lockDirectory, ledger, item, 'apply_authorized', item.evidence.apply_authorized, now)
  return sealLedger(ledger)
}

export function transitionLedger(input, itemId, to, evidence = {}, { note = null, now, lock } = {}) {
  const validation = validateLedger(input)
  if (!validation.valid) throw new Error(`invalid ledger:\n- ${validation.errors.join('\n- ')}`)
  if (!ALL_STATES.has(to) || to === 'verified_skip') throw new Error(`unknown or internal-only state: ${to}`)
  const ledger = cloneJson(input)
  const item = ledger.items.find((candidate) => candidate.item_id === String(itemId))
  if (!item) throw new Error(`unknown item: ${itemId}`)
  const held = requireHeldLock(lock, item.lock_key, now)
  if (!ALLOWED_TRANSITIONS[item.state].has(to)) throw new Error(`invalid transition: ${item.state} -> ${to}`)
  const verifiedReceipt = requireTransitionEvidence(to, evidence, ledger, item)
  const from = item.state
  if (from === 'outcome_unknown' && evidence.readback_recovery !== true) throw new Error('resolving outcome_unknown requires evidence.readback_recovery=true')
  const at = timestamp(now)
  const lockDirectory = path.dirname(held.lock_path)

  if (to === 'preflighted') {
    const identity = buildLogicalIdentity(ledger, item, evidence.fingerprint)
    const claim = claimIdentity(lockDirectory, ledger, item, identity, held, now)
    item.fingerprint = identity.fingerprint
    item.idempotency_key = identity.idempotency_key
    item.apply_authorization = null
    item.write_blocked = null
    if (claim.disposition === 'verified_skip') {
      const skipEvidence = { reason: 'logical_work_already_verified', registry: { ledger_id: claim.record.claim?.ledger_id, item_id: claim.record.claim?.item_id }, verified: claim.record.evidence?.verified }
      item.state = 'verified_skip'
      item.evidence.verified_skip = cloneJson(skipEvidence)
      item.last_error = null
      item.history.push({ from, to: 'verified_skip', at, note: 'idempotency_verified_skip', lock_owner: held.owner, evidence: cloneJson(skipEvidence) })
      ledger.updated_at = at
      return sealLedger(ledger)
    }
    if (claim.disposition === 'verified_target_drift') {
      const conflictEvidence = {
        reason: 'verified_identity_target_drift',
        expected_target_hash: verifiedTargetHash(claim.record),
        current_target_hash: identity.fingerprint.target_before_hash
      }
      item.state = 'conflict'
      item.evidence.conflict = cloneJson(conflictEvidence)
      item.last_error = conflictEvidence.reason
      item.history.push({ from, to: 'conflict', at, note: 'idempotency_target_drift', lock_owner: held.owner, evidence: cloneJson(conflictEvidence) })
      ledger.updated_at = at
      return sealLedger(ledger)
    }
    if (claim.disposition === 'conflict') {
      const conflictEvidence = { reason: 'logical_work_claimed_elsewhere', registry_status: claim.record.status, registry_ledger_id: claim.record.claim?.ledger_id, registry_item_id: claim.record.claim?.item_id }
      item.state = 'conflict'
      item.evidence.conflict = cloneJson(conflictEvidence)
      item.last_error = conflictEvidence.reason
      item.history.push({ from, to: 'conflict', at, note: 'idempotency_conflict', lock_owner: held.owner, evidence: cloneJson(conflictEvidence) })
      ledger.updated_at = at
      return sealLedger(ledger)
    }
  }

  if (to === 'applied' && from !== 'outcome_unknown') {
    const authorization = item.apply_authorization
    if (!isPlainObject(authorization) || !String(evidence.apply_authorization_token ?? '').trim()) {
      throw new Error('applied requires a prior authorize-apply gate and evidence.apply_authorization_token')
    }
    if (evidence.apply_authorization_token !== authorization.token || authorization.idempotency_key !== item.idempotency_key) {
      throw new Error('apply authorization token does not match this logical operation')
    }
    if (authorization.lock_owner !== held.owner || authorization.lock_nonce !== held.nonce) {
      throw new Error('apply authorization was issued under a different target lock')
    }
  }

  item.state = to
  if (to === 'planned') item.attempt += 1
  if (to === 'preflighted') item.fingerprint = normalizeFingerprint(evidence.fingerprint, ledger.skill.rule_pack_hash)
  if (to === 'applied' || from === 'outcome_unknown') item.apply_authorization = null
  item.evidence[to] = cloneJson(evidence)
  if (verifiedReceipt) item.evidence[to].provenance_readback_receipt = verifiedReceipt
  item.last_error = EXCEPTION_STATES.includes(to) ? String(evidence.reason) : null
  item.history.push({ from, to, at, note, lock_owner: held.owner, evidence: cloneJson(evidence) })
  ledger.updated_at = at
  if (item.idempotency_key) {
    if (to !== 'planned') updateIdentityStatus(lockDirectory, ledger, item, to, evidence, now)
    else {
      const currentIdentity = readIdentityRecord(lockDirectory, item.idempotency_key)
      const ownsClaim = currentIdentity?.claim?.ledger_id === ledger.ledger_id && currentIdentity?.claim?.item_id === item.item_id
      if (ownsClaim) updateIdentityStatus(lockDirectory, ledger, item, 'planned', evidence, now)
    }
  }
  return sealLedger(ledger)
}

export function summarizeLedger(ledger) {
  const validation = validateLedger(ledger)
  const counts = Object.fromEntries([...ALL_STATES].map((state) => [state, 0]))
  if (Array.isArray(ledger?.items)) for (const item of ledger.items) {
    if (Object.hasOwn(counts, item.state)) counts[item.state] += 1
  }
  const total = Array.isArray(ledger?.items) ? ledger.items.length : 0
  return {
    valid: validation.valid,
    errors: validation.errors,
    total,
    counts,
    complete: validation.valid && counts.verified + counts.verified_skip === total,
    attention: EXCEPTION_STATES.flatMap((state) =>
      Array.isArray(ledger?.items) ? ledger.items.filter((item) => item.state === state).map((item) => ({ item_id: item.item_id, state, reason: item.last_error })) : []
    )
  }
}

export function validateLedger(ledger) {
  const errors = []
  if (!isPlainObject(ledger)) return { valid: false, errors: ['ledger must be an object'] }
  if (ledger.schema_version !== LEDGER_SCHEMA_VERSION) errors.push(`schema_version must be ${LEDGER_SCHEMA_VERSION}`)
  if (!String(ledger.ledger_id ?? '').trim()) errors.push('ledger_id is required')
  if (!isPlainObject(ledger.skill)) errors.push('skill must be an object')
  else {
    try { requireHash(ledger.skill.rule_pack_hash, 'skill.rule_pack_hash') } catch (error) { errors.push(error.message) }
  }
  if (!Array.isArray(ledger.items) || ledger.items.length === 0) errors.push('items must be a non-empty array')
  else {
    const seen = new Set()
    const seenProspective = new Map()
    const seenLocks = new Map()
    const seenPromotedBooks = new Map()
    for (const [index, item] of ledger.items.entries()) {
      if (!isPlainObject(item)) {
        errors.push(`items[${index}] must be an object`)
        continue
      }
      if (!item.item_id) errors.push(`items[${index}].item_id is required`)
      if (seen.has(item.item_id)) errors.push(`duplicate item_id: ${item.item_id}`)
      seen.add(item.item_id)
      if (!String(item.lock_key ?? '').trim()) errors.push(`items[${index}].lock_key is required`)
      if (item.lock_key === item.item_id && !String(item.book?.target_book_id ?? '').trim()) errors.push(`items[${index}].lock_key must not fall back to item_id`)
      if (!isPlainObject(item.target) || !String(item.target.book_stable_identity ?? '').trim() || item.target.catalog_scope === undefined) {
        errors.push(`items[${index}].target requires book_stable_identity and catalog_scope`)
      }
      const prospective = String(item.target?.prospective_identity ?? '').trim()
      if (prospective && item.target.book_stable_identity !== prospective) {
        errors.push(`items[${index}].target.book_stable_identity must remain the prospective identity after promotion`)
      }
      if (!String(item.book?.target_book_id ?? '').trim() && !prospective) {
        errors.push(`items[${index}] requires target_book_prospective_identity before target book creation`)
      }
      if (item.target?.promoted_book_id && String(item.book?.target_book_id ?? '') !== String(item.target.promoted_book_id)) {
        errors.push(`items[${index}].target.promoted_book_id must match book.target_book_id`)
      }
      if (prospective) {
        const priorLock = seenProspective.get(prospective)
        if (priorLock && priorLock !== item.lock_key) errors.push(`items[${index}] prospective identity is bound to multiple lock keys`)
        const priorProspective = seenLocks.get(item.lock_key)
        if (priorProspective && priorProspective !== prospective) errors.push(`items[${index}] lock key is bound to multiple prospective identities`)
        seenProspective.set(prospective, item.lock_key)
        seenLocks.set(item.lock_key, prospective)
      }
      if (item.target?.promoted_book_id) {
        const stableIdentity = prospective || item.target.book_stable_identity
        const priorStable = seenPromotedBooks.get(String(item.target.promoted_book_id))
        if (priorStable && priorStable !== stableIdentity) errors.push(`items[${index}] promoted book is bound to multiple stable identities`)
        seenPromotedBooks.set(String(item.target.promoted_book_id), stableIdentity)
      }
      if (!ALL_STATES.has(item.state)) errors.push(`items[${index}].state is invalid`)
      if (!Array.isArray(item.history) || item.history.length === 0) errors.push(`items[${index}].history must be non-empty`)
      if (item.idempotency_key !== null && item.idempotency_key !== undefined) {
        try { requireHash(item.idempotency_key, `items[${index}].idempotency_key`) } catch (error) { errors.push(error.message) }
      }
      const identityBoundState = ['preflighted', 'applied', 'saved', 'verified', 'verified_skip'].includes(item.state)
      if (identityBoundState && !item.idempotency_key) {
        errors.push(`items[${index}] requires idempotency_key in state ${item.state}`)
      }
      if (identityBoundState && !isPlainObject(item.fingerprint)) errors.push(`items[${index}].fingerprint is required in state ${item.state}`)
      if (identityBoundState && isPlainObject(item.target) && isPlainObject(item.fingerprint) && isPlainObject(ledger.skill)) {
        try {
          const expected = buildLogicalIdentity(ledger, item, item.fingerprint).idempotency_key
          if (item.idempotency_key !== expected) errors.push(`items[${index}].idempotency_key does not match its logical identity`)
        } catch (error) {
          errors.push(`items[${index}].fingerprint is invalid: ${error.message}`)
        }
      }
    }
  }
  if (typeof ledger.integrity_hash !== 'string' || !HASH_PATTERN.test(ledger.integrity_hash)) errors.push('integrity_hash must match sha256:<64 lowercase hex>')
  else {
    const copy = cloneJson(ledger)
    delete copy.integrity_hash
    if (hashJson(copy) !== ledger.integrity_hash) errors.push('integrity_hash does not match ledger content')
  }
  return { valid: errors.length === 0, errors }
}

function parseArgs(argv) {
  const options = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) {
      options._.push(value)
      continue
    }
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) throw new Error(`${value} requires a value`)
    options[value.slice(2)] = next
    index += 1
  }
  return options
}

export function runCli(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.length === 0) {
    process.stdout.write('Usage:\n  batch-ledger.mjs acquire-lock --lock-key <stable-key> --owner <run-id>\n  batch-ledger.mjs inspect-lock --lock-key <stable-key> [--stale-after-ms <ms>]\n  batch-ledger.mjs transfer-lock --lock-key <stable-key> --owner <current> --new-owner <next> --evidence <json>\n  batch-ledger.mjs recover-lock --lock-key <stable-key> --new-owner <next> --evidence <json> [--stale-after-ms <ms>]\n  batch-ledger.mjs release-lock --lock-key <stable-key> --owner <run-id>\n  batch-ledger.mjs init --rule-pack <json> --books <json> --out <ledger.json>\n  batch-ledger.mjs promote-target --ledger <json> --item <id> --owner <id> --target-book-id <id> --evidence <json>\n  batch-ledger.mjs transition --ledger <json> --item <id> --to <state> --owner <id> [--evidence <json>] [--note <text>]\n  batch-ledger.mjs authorize-apply --ledger <json> --item <id> --owner <id> --fingerprint <json>\n  batch-ledger.mjs validate --ledger <json>\n  batch-ledger.mjs summary --ledger <json>\n\nAll CLI lock and identity state uses the fixed user-level directory; --lock-dir is rejected.\n')
    return 0
  }
  const options = parseArgs(argv)
  const command = options._[0]
  if (Object.hasOwn(options, 'lock-dir')) throw new Error('--lock-dir is not supported; CLI state is fixed to the user-level directory')
  const lockDirectory = undefined
  if (['acquire-lock', 'lock-status', 'inspect-lock', 'release-lock', 'transfer-lock', 'recover-lock'].includes(command)) {
    const lockKey = options['lock-key'] ?? options['target-book']
    if (!lockKey) throw new Error(`${command} requires --lock-key`)
    let result
    if (command === 'lock-status') result = lockStatus(lockDirectory, lockKey)
    else if (command === 'inspect-lock') result = inspectLock(lockDirectory, lockKey, { staleAfterMs: options['stale-after-ms'] ?? DEFAULT_STALE_AFTER_MS })
    else if (command === 'acquire-lock') result = acquireLock(lockDirectory, lockKey, options.owner)
    else if (command === 'release-lock') result = releaseLock(lockDirectory, lockKey, options.owner)
    else {
      if (!options.evidence) throw new Error(`${command} requires --evidence`)
      const evidence = readJson(options.evidence)
      if (command === 'transfer-lock') result = transferLock(lockDirectory, lockKey, options.owner, options['new-owner'], evidence)
      else result = recoverLock(lockDirectory, lockKey, options['new-owner'], evidence, { staleAfterMs: options['stale-after-ms'] ?? DEFAULT_STALE_AFTER_MS })
    }
    writeJson(undefined, result)
    return 0
  }
  if (command === 'init') {
    if (!options['rule-pack'] || !options.books || !options.out) throw new Error('init requires --rule-pack, --books and --out')
    writeJson(options.out, initLedger(readJson(options['rule-pack']), readJson(options.books), {
      lockDirectory,
      rulePackArtifactRoot: path.dirname(path.resolve(options['rule-pack']))
    }))
    return 0
  }
  if (!options.ledger) throw new Error('--ledger is required')
  const ledger = readJson(options.ledger)
  if (command === 'transition' || command === 'authorize-apply' || command === 'promote-target') {
    if (!options.item || !options.owner) throw new Error(`${command} requires --item and --owner`)
    const selectedItem = ledger.items?.find((candidate) => candidate.item_id === String(options.item))
    if (!selectedItem) throw new Error(`unknown item: ${options.item}`)
    const lock = lockStatus(lockDirectory, selectedItem.lock_key)
    if (!lock.held || lock.owner !== options.owner) throw new Error('transition owner does not hold the target lock')
    let updated
    if (command === 'promote-target') {
      if (!options['target-book-id'] || !options.evidence) throw new Error('promote-target requires --target-book-id and --evidence')
      updated = promoteLedgerTarget(ledger, options.item, options['target-book-id'], readJson(options.evidence), { lock })
    } else if (command === 'authorize-apply') {
      if (!options.fingerprint) throw new Error('authorize-apply requires --fingerprint')
      updated = authorizeApply(ledger, options.item, readJson(options.fingerprint), { lock })
    } else {
      if (!options.to) throw new Error('transition requires --to')
      const evidence = options.evidence ? readJson(options.evidence) : {}
      updated = transitionLedger(ledger, options.item, options.to, evidence, { note: options.note, lock })
    }
    writeJson(options.ledger, updated)
    const resultItem = updated.items.find((candidate) => candidate.item_id === String(options.item))
    writeJson(undefined, {
      item_id: options.item,
      requested_state: command === 'transition' ? options.to : command === 'promote-target' ? 'target_promoted' : 'apply_authorization',
      state: resultItem.state,
      write_permitted: Boolean(resultItem.apply_authorization),
      apply_authorization_token: resultItem.apply_authorization?.token ?? null,
      ledger: options.ledger
    })
    return 0
  }
  if (command === 'validate') {
    const result = validateLedger(ledger)
    writeJson(undefined, result)
    return result.valid ? 0 : 1
  }
  if (command === 'summary') {
    writeJson(undefined, summarizeLedger(ledger))
    return 0
  }
  throw new Error(`unknown command: ${command}`)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  try {
    process.exitCode = runCli()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 2
  }
}
