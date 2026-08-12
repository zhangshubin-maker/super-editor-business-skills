#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  assertValidRulePack,
  hashJson,
  isPlainObject,
  readJson,
  writeJson
} from './semantic-rule-tools.mjs'

export const LEDGER_SCHEMA_VERSION = 1
export const NORMAL_STATES = ['pending', 'planned', 'preflighted', 'applied', 'saved', 'verified']
export const EXCEPTION_STATES = ['needs_review', 'conflict', 'failed', 'outcome_unknown']
export const ALL_STATES = new Set([...NORMAL_STATES, ...EXCEPTION_STATES])
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/
const ALLOWED_TRANSITIONS = Object.freeze({
  pending: new Set(['planned', 'needs_review', 'failed']),
  planned: new Set(['preflighted', 'needs_review', 'conflict', 'failed', 'outcome_unknown']),
  preflighted: new Set(['applied', 'needs_review', 'conflict', 'failed', 'outcome_unknown']),
  applied: new Set(['saved', 'needs_review', 'conflict', 'failed', 'outcome_unknown']),
  saved: new Set(['verified', 'needs_review', 'conflict', 'failed', 'outcome_unknown']),
  verified: new Set(),
  needs_review: new Set(['planned']),
  conflict: new Set(['planned']),
  failed: new Set(['planned']),
  outcome_unknown: new Set(['applied', 'saved', 'verified', 'needs_review', 'failed'])
})

function lockFilename(lockDirectory, targetBookId) {
  const target = String(targetBookId ?? '').trim()
  if (!target) throw new Error('target book/lock key is required')
  const digest = crypto.createHash('sha256').update(target).digest('hex').slice(0, 32)
  return path.resolve(lockDirectory, `target-${digest}.lock.json`)
}

export function lockStatus(lockDirectory, targetBookId) {
  const filename = lockFilename(lockDirectory, targetBookId)
  if (!fs.existsSync(filename)) return { held: false, target_book_id: String(targetBookId), lock_path: filename }
  let lock
  try {
    lock = JSON.parse(fs.readFileSync(filename, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read lock file ${filename}: ${error.message}`)
  }
  return { held: true, ...lock, lock_path: filename }
}

export function acquireLock(lockDirectory, targetBookId, owner, { now } = {}) {
  const target = String(targetBookId ?? '').trim()
  const lockOwner = String(owner ?? '').trim()
  if (!lockOwner) throw new Error('lock owner is required')
  const filename = lockFilename(lockDirectory, target)
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  const lock = {
    schema_version: 1,
    target_book_id: target,
    owner: lockOwner,
    acquired_at: timestamp(now),
    nonce: crypto.randomUUID()
  }
  let descriptor
  try {
    descriptor = fs.openSync(filename, 'wx')
    fs.writeFileSync(descriptor, `${JSON.stringify(lock, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
      descriptor = undefined
      // The wx create belongs to this call; remove a partial lock so it cannot permanently block the target.
      try { if (fs.existsSync(filename)) fs.unlinkSync(filename) } catch {}
    }
    if (error.code === 'EEXIST') {
      const current = lockStatus(lockDirectory, target)
      throw new Error(`target is already locked by ${current.owner ?? 'unknown'} at ${current.acquired_at ?? 'unknown'}`)
    }
    throw error
  }
  fs.closeSync(descriptor)
  return { held: true, ...lock, lock_path: filename }
}

export function releaseLock(lockDirectory, targetBookId, owner) {
  const current = lockStatus(lockDirectory, targetBookId)
  if (!current.held) throw new Error('target lock is not held')
  if (current.owner !== String(owner)) throw new Error(`target lock belongs to ${current.owner}; refusing release`)
  const released = `${current.lock_path}.${process.pid}.${Date.now()}.released`
  fs.renameSync(current.lock_path, released)
  fs.unlinkSync(released)
  return { released: true, target_book_id: current.target_book_id, owner: current.owner }
}

function requireHeldLock(lock, targetBookId) {
  if (!isPlainObject(lock) || lock.held !== true) throw new Error('a held target lock is required for ledger transitions')
  if (String(lock.target_book_id) !== String(targetBookId)) throw new Error('held lock target does not match ledger item')
  if (!String(lock.owner ?? '').trim()) throw new Error('held lock owner is required')
}

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

function sealLedger(ledger) {
  const copy = cloneJson(ledger)
  delete copy.integrity_hash
  ledger.integrity_hash = hashJson(copy)
  return ledger
}

export function initLedger(pack, booksInput, { now } = {}) {
  assertValidRulePack(pack)
  if (pack.identity.status !== 'validated') throw new Error('batch ledger requires a validated rule pack')
  const books = Array.isArray(booksInput) ? booksInput : booksInput?.books
  if (!Array.isArray(books) || books.length === 0) throw new Error('books must be a non-empty array')
  const seen = new Set()
  const createdAt = timestamp(now)
  const items = books.map((book, index) => {
    requireObject(book, `books[${index}]`)
    const itemId = String(book.item_id ?? '').trim()
    if (!itemId) throw new Error(`books[${index}].item_id is required`)
    if (seen.has(itemId)) throw new Error(`duplicate item_id: ${itemId}`)
    seen.add(itemId)
    return {
      item_id: itemId,
      book: cloneJson(book),
      state: 'pending',
      attempt: 0,
      fingerprint: null,
      idempotency_key: null,
      evidence: {},
      last_error: null,
      history: [{ from: null, to: 'pending', at: createdAt, note: 'ledger_initialized', evidence: {} }]
    }
  })
  return sealLedger({
    schema_version: LEDGER_SCHEMA_VERSION,
    skill: {
      name: pack.identity.skill_name,
      version: pack.identity.version,
      rule_pack_hash: hashJson(pack)
    },
    created_at: createdAt,
    updated_at: createdAt,
    items
  })
}

function requireTransitionEvidence(to, evidence) {
  requireObject(evidence, 'transition evidence')
  if (to === 'preflighted') {
    const fingerprint = requireObject(evidence.fingerprint, 'transition evidence.fingerprint')
    requireHash(fingerprint.source_snapshot_hash, 'fingerprint.source_snapshot_hash')
    requireHash(fingerprint.template_snapshot_hash, 'fingerprint.template_snapshot_hash')
    requireHash(fingerprint.target_before_hash, 'fingerprint.target_before_hash')
    if (fingerprint.resolved_template_id === undefined || fingerprint.resolved_template_id === null || fingerprint.resolved_template_id === '') {
      throw new Error('fingerprint.resolved_template_id is required')
    }
  }
  if (to === 'applied') requireHash(evidence.target_after_hash, 'transition evidence.target_after_hash')
  if (to === 'saved') requireHash(evidence.save_readback_hash, 'transition evidence.save_readback_hash')
  if (to === 'verified') {
    requireHash(evidence.result_hash, 'transition evidence.result_hash')
    requireHash(evidence.provenance_hash, 'transition evidence.provenance_hash')
  }
  if (EXCEPTION_STATES.includes(to) && !String(evidence.reason ?? '').trim()) {
    throw new Error(`transition to ${to} requires evidence.reason`)
  }
}

export function transitionLedger(input, itemId, to, evidence = {}, { note = null, now, lock } = {}) {
  const validation = validateLedger(input)
  if (!validation.valid) throw new Error(`invalid ledger:\n- ${validation.errors.join('\n- ')}`)
  if (!ALL_STATES.has(to)) throw new Error(`unknown state: ${to}`)
  const ledger = cloneJson(input)
  const item = ledger.items.find((candidate) => candidate.item_id === String(itemId))
  if (!item) throw new Error(`unknown item: ${itemId}`)
  const lockKey = item.book.lock_key ?? item.book.target_book_id ?? item.item_id
  requireHeldLock(lock, lockKey)
  if (!ALLOWED_TRANSITIONS[item.state].has(to)) throw new Error(`invalid transition: ${item.state} -> ${to}`)
  requireTransitionEvidence(to, evidence)
  const from = item.state
  if (from === 'outcome_unknown' && evidence.readback_recovery !== true) {
    throw new Error('resolving outcome_unknown requires evidence.readback_recovery=true')
  }
  const at = timestamp(now)
  item.state = to
  if (to === 'planned') item.attempt += 1
  if (to === 'preflighted') {
    item.fingerprint = cloneJson(evidence.fingerprint)
    item.idempotency_key = hashJson({
      skill: ledger.skill,
      item_id: item.item_id,
      source_book: item.book.source_book_id ?? null,
      source_catalog: item.book.source_catalog_id ?? null,
      target_book: item.book.target_book_id ?? null,
      target_catalog: item.book.target_catalog_id ?? null,
      fingerprint: item.fingerprint
    })
  }
  item.evidence[to] = cloneJson(evidence)
  item.last_error = EXCEPTION_STATES.includes(to) ? String(evidence.reason) : null
  item.history.push({ from, to, at, note, lock_owner: lock.owner, evidence: cloneJson(evidence) })
  ledger.updated_at = at
  return sealLedger(ledger)
}

export function summarizeLedger(ledger) {
  const validation = validateLedger(ledger)
  const counts = Object.fromEntries([...ALL_STATES].map((state) => [state, 0]))
  if (Array.isArray(ledger?.items)) for (const item of ledger.items) {
    if (Object.hasOwn(counts, item.state)) counts[item.state] += 1
  }
  return {
    valid: validation.valid,
    errors: validation.errors,
    total: Array.isArray(ledger?.items) ? ledger.items.length : 0,
    counts,
    complete: validation.valid && counts.verified === ledger.items.length,
    attention: EXCEPTION_STATES.flatMap((state) =>
      Array.isArray(ledger?.items) ? ledger.items.filter((item) => item.state === state).map((item) => ({ item_id: item.item_id, state, reason: item.last_error })) : []
    )
  }
}

export function validateLedger(ledger) {
  const errors = []
  if (!isPlainObject(ledger)) return { valid: false, errors: ['ledger must be an object'] }
  if (ledger.schema_version !== LEDGER_SCHEMA_VERSION) errors.push(`schema_version must be ${LEDGER_SCHEMA_VERSION}`)
  if (!isPlainObject(ledger.skill)) errors.push('skill must be an object')
  else {
    try { requireHash(ledger.skill.rule_pack_hash, 'skill.rule_pack_hash') } catch (error) { errors.push(error.message) }
  }
  if (!Array.isArray(ledger.items) || ledger.items.length === 0) errors.push('items must be a non-empty array')
  else {
    const seen = new Set()
    for (const [index, item] of ledger.items.entries()) {
      if (!isPlainObject(item)) {
        errors.push(`items[${index}] must be an object`)
        continue
      }
      if (!item.item_id) errors.push(`items[${index}].item_id is required`)
      if (seen.has(item.item_id)) errors.push(`duplicate item_id: ${item.item_id}`)
      seen.add(item.item_id)
      if (!ALL_STATES.has(item.state)) errors.push(`items[${index}].state is invalid`)
      if (!Array.isArray(item.history) || item.history.length === 0) errors.push(`items[${index}].history must be non-empty`)
      if (['preflighted', 'applied', 'saved', 'verified'].includes(item.state) && !item.idempotency_key) {
        errors.push(`items[${index}] requires idempotency_key in state ${item.state}`)
      }
    }
  }
  if (typeof ledger.integrity_hash !== 'string' || !HASH_PATTERN.test(ledger.integrity_hash)) {
    errors.push('integrity_hash must match sha256:<64 lowercase hex>')
  } else {
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
    process.stdout.write('Usage:\n  batch-ledger.mjs acquire-lock --lock-dir <dir> --target-book <id> --owner <id>\n  batch-ledger.mjs lock-status --lock-dir <dir> --target-book <id>\n  batch-ledger.mjs release-lock --lock-dir <dir> --target-book <id> --owner <id>\n  batch-ledger.mjs init --rule-pack <json> --books <json> --out <ledger.json>\n  batch-ledger.mjs transition --ledger <json> --item <id> --to <state> --lock-dir <dir> --owner <id> [--evidence <json>] [--note <text>]\n  batch-ledger.mjs validate --ledger <json>\n  batch-ledger.mjs summary --ledger <json>\n')
    return 0
  }
  const options = parseArgs(argv)
  const command = options._[0]
  if (['acquire-lock', 'lock-status', 'release-lock'].includes(command)) {
    if (!options['lock-dir'] || !options['target-book']) throw new Error(`${command} requires --lock-dir and --target-book`)
    let result
    if (command === 'lock-status') result = lockStatus(options['lock-dir'], options['target-book'])
    else {
      if (!options.owner) throw new Error(`${command} requires --owner`)
      result = command === 'acquire-lock'
        ? acquireLock(options['lock-dir'], options['target-book'], options.owner)
        : releaseLock(options['lock-dir'], options['target-book'], options.owner)
    }
    writeJson(undefined, result)
    return 0
  }
  if (command === 'init') {
    if (!options['rule-pack'] || !options.books || !options.out) throw new Error('init requires --rule-pack, --books and --out')
    writeJson(options.out, initLedger(readJson(options['rule-pack']), readJson(options.books)))
    return 0
  }
  if (!options.ledger) throw new Error('--ledger is required')
  const ledger = readJson(options.ledger)
  if (command === 'transition') {
    if (!options.item || !options.to) throw new Error('transition requires --item and --to')
    if (!options['lock-dir'] || !options.owner) throw new Error('transition requires --lock-dir and --owner')
    const selectedItem = ledger.items?.find((candidate) => candidate.item_id === String(options.item))
    if (!selectedItem) throw new Error(`unknown item: ${options.item}`)
    const lockKey = selectedItem.book.lock_key ?? selectedItem.book.target_book_id ?? selectedItem.item_id
    const lock = lockStatus(options['lock-dir'], lockKey)
    if (!lock.held || lock.owner !== options.owner) throw new Error('transition owner does not hold the target lock')
    const evidence = options.evidence ? readJson(options.evidence) : {}
    const updated = transitionLedger(ledger, options.item, options.to, evidence, { note: options.note, lock })
    writeJson(options.ledger, updated)
    writeJson(undefined, { item_id: options.item, state: options.to, ledger: options.ledger })
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
