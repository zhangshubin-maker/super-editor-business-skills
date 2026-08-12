#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { assertValidRulePack, hashJson, isPlainObject, readJson, writeJson } from './semantic-rule-tools.mjs'

export const PROVENANCE_SCHEMA_VERSION = 1
export const SOURCE_MATCH_WEIGHTS = Object.freeze({
  subject: 15,
  grade: 15,
  volume: 15,
  book_name_exact: 20,
  book_name_contains: 10,
  catalog_path_exact: 20,
  catalog_name_sort_exact: 15
})
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/
const BINDING_STATUSES = new Set(['applied', 'skipped', 'needs_review', 'conflict', 'failed'])
const VALIDATION_STATUSES = new Set(['passed', 'failed', 'warning', 'not_tested'])
const EXECUTION_MODES = new Set(['trial', 'batch', 'legacy_inferred'])
const APPROVAL_TYPES = new Set(['trial_authorization', 'batch_authorization', 'legacy_source_confirmation'])

function requireObject(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`)
  return value
}

function requireString(value, label) {
  if (value === undefined || value === null || !String(value).trim()) throw new Error(`${label} is required`)
  return String(value)
}

function requireHash(value, label, { nullable = false } = {}) {
  if ((value === null || value === undefined) && nullable) return null
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new Error(`${label} must match sha256:<64 lowercase hex>`)
  }
  return value
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function compactText(value) {
  if (value === null || value === undefined) return null
  const result = String(value).trim().toLowerCase().replace(/\s+/g, '')
  return result || null
}

function normalizeVolume(value) {
  const normalized = compactText(value)
  if (['上', '上册', '第一册', '1'].includes(normalized)) return '上册'
  if (['下', '下册', '第二册', '2'].includes(normalized)) return '下册'
  return normalized
}

function normalizePath(value) {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(/[/>\\]/)
  const normalized = parts.map(compactText).filter(Boolean)
  return normalized.length ? normalized.join('/') : null
}

function sourceView(value) {
  const source = isPlainObject(value?.source) ? value.source : value
  return { ...source, candidate_id: value.candidate_id ?? source.candidate_id ?? source.book_id }
}

function normalizeManualConfirmation(value, candidateIds) {
  if (value === undefined || value === null) return null
  requireObject(value, 'match-source manual_confirmation')
  const candidateId = requireString(
    value.candidate_id ?? value.selected_candidate_id,
    'match-source manual_confirmation.candidate_id'
  )
  if (!candidateIds.has(candidateId)) throw new Error('match-source manual_confirmation.candidate_id is not in the candidate set')
  if (value.confirmed === false) throw new Error('match-source manual_confirmation.confirmed must not be false')
  const evidence = Array.isArray(value.evidence) ? cloneJson(value.evidence) : []
  if (!evidence.length && !String(value.reason ?? '').trim()) {
    throw new Error('match-source manual_confirmation requires evidence or reason')
  }
  return {
    confirmed: true,
    candidate_id: candidateId,
    confirmed_by: requireString(value.confirmed_by, 'match-source manual_confirmation.confirmed_by'),
    confirmed_at: requireString(value.confirmed_at, 'match-source manual_confirmation.confirmed_at'),
    reason: value.reason === undefined ? null : requireString(value.reason, 'match-source manual_confirmation.reason'),
    evidence
  }
}

/** Deterministically recall source candidates for an untraced result; never authorizes a write. */
export function matchSourceCandidates(input) {
  requireObject(input, 'match-source input')
  const query = sourceView(requireObject(input.query, 'match-source query'))
  if (!Array.isArray(input.candidates) || input.candidates.length === 0) throw new Error('match-source candidates must be non-empty')
  const candidateSet = input.candidates.map((raw, index) => {
    const candidate = sourceView(requireObject(raw, `match-source candidates[${index}]`))
    requireString(candidate.candidate_id, `match-source candidates[${index}].candidate_id`)
    return cloneJson(candidate)
  })
  const candidates = candidateSet.map((candidate, index) => {
    const candidateId = requireString(candidate.candidate_id, `match-source candidates[${index}].candidate_id`)
    const evidence = []
    const rejection_reasons = []
    let score = 0
    for (const [field, normalizer] of [['subject', compactText], ['grade', compactText], ['volume', normalizeVolume]]) {
      const expected = normalizer(query[field])
      const actual = normalizer(candidate[field])
      if (expected && actual && expected !== actual) rejection_reasons.push(`${field}_mismatch`)
      else if (expected && actual) {
        const points = SOURCE_MATCH_WEIGHTS[field]
        score += points
        evidence.push({ rule: `${field}_exact`, points })
      }
    }
    const queryBook = compactText(query.book_name)
    const candidateBook = compactText(candidate.book_name)
    if (queryBook && candidateBook) {
      if (queryBook === candidateBook) {
        score += SOURCE_MATCH_WEIGHTS.book_name_exact
        evidence.push({ rule: 'book_name_exact', points: SOURCE_MATCH_WEIGHTS.book_name_exact })
      } else if (queryBook.includes(candidateBook) || candidateBook.includes(queryBook)) {
        score += SOURCE_MATCH_WEIGHTS.book_name_contains
        evidence.push({ rule: 'book_name_contains', points: SOURCE_MATCH_WEIGHTS.book_name_contains })
      }
    }
    const queryPath = normalizePath(query.catalog_path)
    const candidatePath = normalizePath(candidate.catalog_path)
    if (queryPath && candidatePath && queryPath === candidatePath) {
      score += SOURCE_MATCH_WEIGHTS.catalog_path_exact
      evidence.push({ rule: 'catalog_path_exact', points: SOURCE_MATCH_WEIGHTS.catalog_path_exact })
    } else if (compactText(query.catalog_name) && compactText(query.catalog_name) === compactText(candidate.catalog_name) &&
               String(query.catalog_sort ?? '') && String(query.catalog_sort) === String(candidate.catalog_sort ?? '')) {
      score += SOURCE_MATCH_WEIGHTS.catalog_name_sort_exact
      evidence.push({ rule: 'catalog_name_sort_exact', points: SOURCE_MATCH_WEIGHTS.catalog_name_sort_exact })
    }
    const coreMissing = ['subject', 'grade', 'volume'].filter((field) => !compactText(candidate[field]))
    const eligible = rejection_reasons.length === 0
    if (!eligible) score = 0
    let confidence = score >= 65 ? 'high' : score >= 40 ? 'medium' : 'low'
    if (confidence === 'high' && coreMissing.length) confidence = 'medium'
    if (!eligible) confidence = 'rejected'
    return { candidate_id: candidateId, eligible, score, confidence, core_missing: coreMissing, rejection_reasons, evidence }
  }).sort((left, right) => right.score - left.score || left.candidate_id.localeCompare(right.candidate_id))
  const eligible = candidates.filter((candidate) => candidate.eligible)
  const topScore = eligible[0]?.score ?? null
  const top = eligible.filter((candidate) => candidate.score === topScore)
  // A single candidate with no matching metadata is not evidence and must never
  // be presented as a unique recall result.
  const unique = Number.isFinite(topScore) && topScore > 0 && top.length === 1
  const candidateIds = new Set(candidateSet.map((candidate) => String(candidate.candidate_id)))
  const manualConfirmation = normalizeManualConfirmation(input.manual_confirmation, candidateIds)
  const selected = manualConfirmation
    ? candidates.find((candidate) => candidate.candidate_id === manualConfirmation.candidate_id)
    : null
  if (selected && !selected.eligible) throw new Error('match-source manual confirmation cannot select a rejected candidate')
  const inference = {
    kind: 'legacy_inferred_source',
    restriction: 'manual_confirmation_required_no_automatic_write',
    automatic_write: false,
    scoring_version: 1,
    weights: SOURCE_MATCH_WEIGHTS,
    query: cloneJson(query),
    candidate_set: cloneJson(candidateSet),
    candidate_set_hash: hashJson(candidateSet),
    scores: cloneJson(candidates),
    top_candidate_id: unique ? top[0].candidate_id : null,
    top_score: topScore,
    unique,
    manual_confirmation: manualConfirmation,
    selected_candidate_id: selected?.candidate_id ?? null,
    selected_score: selected?.score ?? null,
    selected_evidence: selected ? cloneJson(selected.evidence) : []
  }
  return {
    scoring_version: 1,
    weights: SOURCE_MATCH_WEIGHTS,
    top_candidate_id: unique ? top[0].candidate_id : null,
    top_score: topScore,
    unique,
    requires_human_confirmation: true,
    automatic_write: false,
    candidates,
    inference
  }
}

function normalizeBindings(bindings, ruleIds) {
  if (!Array.isArray(bindings)) throw new Error('run.rule_bindings must be an array')
  return bindings.map((binding, index) => {
    requireObject(binding, `run.rule_bindings[${index}]`)
    const ruleId = requireString(binding.rule_id, `run.rule_bindings[${index}].rule_id`)
    if (!ruleIds.has(ruleId)) throw new Error(`run.rule_bindings[${index}].rule_id is not in the rule pack: ${ruleId}`)
    if (!BINDING_STATUSES.has(binding.status)) throw new Error(`run.rule_bindings[${index}].status is invalid`)
    if (!Array.isArray(binding.evidence) || binding.evidence.length === 0) {
      throw new Error(`run.rule_bindings[${index}].evidence must be non-empty`)
    }
    if (!Array.isArray(binding.source_bindings) || !Array.isArray(binding.target_bindings)) {
      throw new Error(`run.rule_bindings[${index}] requires source_bindings and target_bindings arrays`)
    }
    return {
      rule_id: ruleId,
      status: binding.status,
      action_summary: requireString(binding.action_summary, `run.rule_bindings[${index}].action_summary`),
      source_bindings: cloneJson(binding.source_bindings),
      target_bindings: cloneJson(binding.target_bindings),
      evidence: cloneJson(binding.evidence),
      result_hash: binding.result_hash === undefined ? null : requireHash(binding.result_hash, `run.rule_bindings[${index}].result_hash`, { nullable: true })
    }
  })
}

function normalizeValidation(validation) {
  if (!Array.isArray(validation)) throw new Error('run.validation must be an array')
  return validation.map((check, index) => {
    requireObject(check, `run.validation[${index}]`)
    if (!VALIDATION_STATUSES.has(check.status)) throw new Error(`run.validation[${index}].status is invalid`)
    return {
      id: requireString(check.id, `run.validation[${index}].id`),
      status: check.status,
      evidence: Array.isArray(check.evidence) ? cloneJson(check.evidence) : []
    }
  })
}

export function createProvenance(pack, run) {
  assertValidRulePack(pack)
  requireObject(run, 'run')
  const source = requireObject(run.source, 'run.source')
  const template = requireObject(run.template, 'run.template')
  const target = requireObject(run.target, 'run.target')
  const baseline = requireObject(run.baseline, 'run.baseline')
  const ruleIds = new Set(pack.rules.map((rule) => rule.id))
  const provenance = {
    schema_version: PROVENANCE_SCHEMA_VERSION,
    skill: {
      name: pack.identity.skill_name,
      version: pack.identity.version,
      rule_pack_hash: hashJson(pack)
    },
    run_id: requireString(run.run_id, 'run.run_id'),
    source: {
      book_id: requireString(source.book_id, 'run.source.book_id'),
      catalog_id: requireString(source.catalog_id, 'run.source.catalog_id'),
      catalog_path: source.catalog_path === undefined ? null : cloneJson(source.catalog_path),
      snapshot_hash: requireHash(source.snapshot_hash, 'run.source.snapshot_hash')
    },
    template: {
      requested_template_id: requireString(template.requested_template_id, 'run.template.requested_template_id'),
      resolved_template_id: requireString(template.resolved_template_id, 'run.template.resolved_template_id'),
      variant_id: template.variant_id === undefined || template.variant_id === null ? null : String(template.variant_id),
      snapshot_hash: requireHash(template.snapshot_hash, 'run.template.snapshot_hash')
    },
    target: {
      book_id: requireString(target.book_id, 'run.target.book_id'),
      catalog_id: requireString(target.catalog_id, 'run.target.catalog_id'),
      before_hash: requireHash(target.before_hash, 'run.target.before_hash', { nullable: true }),
      result_hash: requireHash(target.result_hash, 'run.target.result_hash')
    },
    rule_bindings: normalizeBindings(run.rule_bindings, ruleIds),
    instance_fixes: Array.isArray(run.instance_fixes) ? cloneJson(run.instance_fixes) : [],
    user_approvals: Array.isArray(run.user_approvals) ? cloneJson(run.user_approvals) : [],
    validation: normalizeValidation(run.validation),
    baseline: cloneJson(baseline),
    baseline_hash: hashJson(baseline),
    created_at: run.created_at ? requireString(run.created_at, 'run.created_at') : new Date().toISOString()
  }
  provenance.integrity_hash = hashJson(provenance)
  const carrierBlockId = requireString(run.carrier_block_id, 'run.carrier_block_id')
  return {
    provenance,
    editor_update_block: {
      tool: 'editor_update_block',
      arguments: {
        blockId: carrierBlockId,
        patch: { ai_semantic_provenance: provenance }
      }
    }
  }
}

function unwrapProvenance(value) {
  if (isPlainObject(value?.provenance)) return value.provenance
  if (isPlainObject(value?.ai_semantic_provenance)) return value.ai_semantic_provenance
  return value
}

export function validateProvenance(input) {
  const errors = []
  const value = unwrapProvenance(input)
  if (!isPlainObject(value)) return { valid: false, errors: ['provenance must be an object'], warnings: [] }
  if (value.schema_version !== PROVENANCE_SCHEMA_VERSION) errors.push(`schema_version must be ${PROVENANCE_SCHEMA_VERSION}`)
  if (!isPlainObject(value.skill)) errors.push('skill must be an object')
  else {
    if (!value.skill.name) errors.push('skill.name is required')
    if (!value.skill.version) errors.push('skill.version is required')
    try { requireHash(value.skill.rule_pack_hash, 'skill.rule_pack_hash') } catch (error) { errors.push(error.message) }
  }
  for (const [label, object, hashFields] of [
    ['source', value.source, ['snapshot_hash']],
    ['template', value.template, ['snapshot_hash']],
    ['target', value.target, ['result_hash']]
  ]) {
    if (!isPlainObject(object)) errors.push(`${label} must be an object`)
    else for (const field of hashFields) {
      try { requireHash(object[field], `${label}.${field}`) } catch (error) { errors.push(error.message) }
    }
  }
  if (!Array.isArray(value.rule_bindings)) errors.push('rule_bindings must be an array')
  else for (const [index, binding] of value.rule_bindings.entries()) {
    if (!isPlainObject(binding)) errors.push(`rule_bindings[${index}] must be an object`)
    else {
      if (!binding.rule_id) errors.push(`rule_bindings[${index}].rule_id is required`)
      if (!BINDING_STATUSES.has(binding.status)) errors.push(`rule_bindings[${index}].status is invalid`)
      if (!Array.isArray(binding.evidence) || binding.evidence.length === 0) errors.push(`rule_bindings[${index}].evidence must be non-empty`)
    }
  }
  if (!Array.isArray(value.validation)) errors.push('validation must be an array')
  if (!isPlainObject(value.baseline)) errors.push('baseline must be an object')
  else {
    try {
      requireHash(value.baseline_hash, 'baseline_hash')
      if (hashJson(value.baseline) !== value.baseline_hash) errors.push('baseline_hash does not match baseline content')
    } catch (error) {
      errors.push(error.message)
    }
  }
  if (typeof value.integrity_hash !== 'string' || !HASH_PATTERN.test(value.integrity_hash)) {
    errors.push('integrity_hash must match sha256:<64 lowercase hex>')
  } else {
    const copy = cloneJson(value)
    delete copy.integrity_hash
    if (hashJson(copy) !== value.integrity_hash) errors.push('integrity_hash does not match provenance content')
  }
  return { valid: errors.length === 0, errors, warnings: [] }
}

function equalJson(left, right) {
  return hashJson(left) === hashJson(right)
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

/** Plan a generic three-way refinement without assuming slots or fixed content domains. */
export function planRefinement(input) {
  requireObject(input, 'refinement')
  const baseline = requireObject(input.baseline, 'refinement.baseline')
  const current = requireObject(input.current, 'refinement.current')
  const desired = requireObject(input.desired, 'refinement.desired')
  const targetKeys = [...new Set([...Object.keys(baseline), ...Object.keys(current), ...Object.keys(desired)])].sort()
  const operations = []
  for (const target of targetKeys) {
    const basePresent = hasOwn(baseline, target)
    const currentPresent = hasOwn(current, target)
    const desiredPresent = hasOwn(desired, target)
    const absent = { $absent: true }
    const base = basePresent ? baseline[target] : absent
    const now = currentPresent ? current[target] : absent
    const explicitDelete = desiredPresent && isPlainObject(desired[target]) && desired[target].$delete === true
    const goalPresent = desiredPresent && !explicitDelete
    const goal = explicitDelete ? absent : (desiredPresent ? desired[target] : base)
    let classification
    let reason
    if (equalJson(goal, base)) {
      classification = 'noop'
      reason = 'desired_did_not_change_from_baseline'
    } else if (equalJson(now, goal)) {
      classification = 'noop'
      reason = 'current_already_matches_desired'
    } else if (equalJson(now, base)) {
      classification = 'safe'
      reason = 'current_matches_baseline'
    } else {
      classification = 'conflict'
      reason = 'current_and_desired_diverged_from_baseline'
    }
    operations.push({
      target,
      classification,
      reason,
      operation: goalPresent ? 'set' : 'delete',
      baseline_present: basePresent,
      current_present: currentPresent,
      desired_present: goalPresent,
      baseline_value: basePresent ? cloneJson(baseline[target]) : null,
      current_value: currentPresent ? cloneJson(current[target]) : null,
      desired_value: goalPresent ? cloneJson(desired[target]) : null
    })
  }
  return {
    summary: Object.fromEntries(['safe', 'noop', 'conflict'].map((kind) => [kind, operations.filter((item) => item.classification === kind).length])),
    safe_changes: operations.filter((item) => item.classification === 'safe'),
    noops: operations.filter((item) => item.classification === 'noop'),
    conflicts: operations.filter((item) => item.classification === 'conflict'),
    current_state_hash: hashJson(current),
    desired_state_hash: hashJson(desired)
  }
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
    process.stdout.write('Usage:\n  provenance-tools.mjs create --rule-pack <json> --input <run.json> [--out <json>]\n  provenance-tools.mjs validate --input <provenance.json> [--out <json>]\n  provenance-tools.mjs plan-refinement --input <three-way.json> [--out <json>]\n  provenance-tools.mjs match-source --input <candidates.json> [--out <json>]\n')
    return 0
  }
  const options = parseArgs(argv)
  const command = options._[0]
  if (!options.input) throw new Error('--input is required')
  if (command === 'create') {
    if (!options['rule-pack']) throw new Error('--rule-pack is required for create')
    writeJson(options.out, createProvenance(readJson(options['rule-pack']), readJson(options.input)))
    return 0
  }
  if (command === 'validate') {
    const result = validateProvenance(readJson(options.input))
    writeJson(options.out, result)
    return result.valid ? 0 : 1
  }
  if (command === 'plan-refinement') {
    writeJson(options.out, planRefinement(readJson(options.input)))
    return 0
  }
  if (command === 'match-source') {
    writeJson(options.out, matchSourceCandidates(readJson(options.input)))
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
