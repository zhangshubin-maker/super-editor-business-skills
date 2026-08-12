#!/usr/bin/env node

import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { assertValidRulePack, hashJson, isPlainObject, readJson, stableStringify, writeJson } from './semantic-rule-tools.mjs'

export const PROVENANCE_SCHEMA_VERSION = 1
export const READBACK_RECEIPT_SCHEMA_VERSION = 1
export const READBACK_RECEIPT_KIND = 'semantic_provenance_readback_receipt'
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
const FNV_PAGE_HASH_PATTERN = /^fnv1a32:[a-f0-9]{8}$/
const IDENTITY_KEYS = Object.freeze([
  'side',
  'book_id',
  'catalog_id',
  'block_id',
  'entity_kind',
  'entity_id'
])
const STRICT_BINDING_KEYS = Object.freeze([
  'semantic_role',
  'identity',
  'snapshot_hash',
  'binding_hash'
])
const STRICT_EVIDENCE_KEYS = Object.freeze([
  'kind',
  'summary',
  'identity',
  'artifact_hash',
  'evidence_hash'
])

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

function requireExactKeys(value, expectedKeys, label) {
  const actual = Object.keys(requireObject(value, label)).sort()
  const expected = [...expectedKeys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly: ${expected.join(', ')}`)
  }
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
  const queryInput = cloneJson(requireObject(input.query, 'match-source query'))
  const query = sourceView(input.query)
  if (!Array.isArray(input.candidates) || input.candidates.length === 0) throw new Error('match-source candidates must be non-empty')
  const candidateSetInput = cloneJson(input.candidates)
  const seenCandidateIds = new Set()
  const candidateSet = input.candidates.map((raw, index) => {
    const candidate = sourceView(requireObject(raw, `match-source candidates[${index}]`))
    const candidateId = requireString(candidate.candidate_id, `match-source candidates[${index}].candidate_id`)
    if (seenCandidateIds.has(candidateId)) throw new Error(`match-source candidates contains duplicate candidate_id: ${candidateId}`)
    seenCandidateIds.add(candidateId)
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
    query_input: queryInput,
    query: cloneJson(query),
    candidate_set_input: candidateSetInput,
    candidate_set_input_hash: hashJson(candidateSetInput),
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

function normalizeBindingIdentity(value, label, expectedIdentities) {
  requireExactKeys(value, IDENTITY_KEYS, label)
  const side = requireString(value.side, `${label}.side`)
  if (!['source', 'target'].includes(side)) throw new Error(`${label}.side must be source or target`)
  const normalized = {
    side,
    book_id: requireString(value.book_id, `${label}.book_id`),
    catalog_id: requireString(value.catalog_id, `${label}.catalog_id`),
    block_id: requireString(value.block_id, `${label}.block_id`),
    entity_kind: requireString(value.entity_kind, `${label}.entity_kind`),
    entity_id: requireString(value.entity_id, `${label}.entity_id`)
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(normalized.entity_kind)) {
    throw new Error(`${label}.entity_kind must be a lowercase stable kind`)
  }
  const expected = expectedIdentities[side]
  if (normalized.book_id !== expected.book_id || normalized.catalog_id !== expected.catalog_id) {
    throw new Error(`${label} does not match the provenance ${side} book/catalog identity`)
  }
  if (normalized.entity_kind === 'block' && normalized.entity_id !== normalized.block_id) {
    throw new Error(`${label}.entity_id must equal block_id for a block identity`)
  }
  return normalized
}

function normalizeStrictBindingItem(value, label, side, expectedIdentities) {
  requireExactKeys(value, STRICT_BINDING_KEYS, label)
  const identity = normalizeBindingIdentity(value.identity, `${label}.identity`, expectedIdentities)
  if (identity.side !== side) throw new Error(`${label}.identity.side must be ${side}`)
  const normalized = {
    semantic_role: requireString(value.semantic_role, `${label}.semantic_role`),
    identity,
    snapshot_hash: requireHash(value.snapshot_hash, `${label}.snapshot_hash`)
  }
  const expectedHash = hashJson(normalized)
  const bindingHash = requireHash(value.binding_hash, `${label}.binding_hash`)
  if (bindingHash !== expectedHash) throw new Error(`${label}.binding_hash does not match its canonical binding content`)
  return { ...normalized, binding_hash: bindingHash }
}

function normalizeStrictEvidenceItem(value, label, expectedIdentities) {
  requireExactKeys(value, STRICT_EVIDENCE_KEYS, label)
  const normalized = {
    kind: requireString(value.kind, `${label}.kind`),
    summary: requireString(value.summary, `${label}.summary`),
    identity: normalizeBindingIdentity(value.identity, `${label}.identity`, expectedIdentities),
    artifact_hash: requireHash(value.artifact_hash, `${label}.artifact_hash`)
  }
  const expectedHash = hashJson(normalized)
  const evidenceHash = requireHash(value.evidence_hash, `${label}.evidence_hash`)
  if (evidenceHash !== expectedHash) throw new Error(`${label}.evidence_hash does not match its canonical evidence content`)
  return { ...normalized, evidence_hash: evidenceHash }
}

function normalizeBindings(bindings, ruleIds, { allowLegacyInference, expectedIdentities }) {
  if (!Array.isArray(bindings) || bindings.length === 0) throw new Error('run.rule_bindings must be a non-empty array')
  const seen = new Set()
  const normalized = bindings.map((binding, index) => {
    requireObject(binding, `run.rule_bindings[${index}]`)
    const ruleId = requireString(binding.rule_id, `run.rule_bindings[${index}].rule_id`)
    if (!ruleIds.has(ruleId)) throw new Error(`run.rule_bindings[${index}].rule_id is not in the rule pack: ${ruleId}`)
    if (seen.has(ruleId)) throw new Error(`run.rule_bindings contains duplicate rule_id: ${ruleId}`)
    seen.add(ruleId)
    if (!BINDING_STATUSES.has(binding.status)) throw new Error(`run.rule_bindings[${index}].status is invalid`)
    if (!Array.isArray(binding.evidence) || binding.evidence.length === 0) {
      throw new Error(`run.rule_bindings[${index}].evidence must be non-empty`)
    }
    if (!Array.isArray(binding.source_bindings) || !Array.isArray(binding.target_bindings)) {
      throw new Error(`run.rule_bindings[${index}] requires source_bindings and target_bindings arrays`)
    }
    if (!allowLegacyInference && (!binding.source_bindings.length || !binding.target_bindings.length)) {
      throw new Error(`run.rule_bindings[${index}] requires non-empty source_bindings and target_bindings`)
    }
    const sourceBindings = allowLegacyInference
      ? cloneJson(binding.source_bindings)
      : binding.source_bindings.map((item, itemIndex) => normalizeStrictBindingItem(
        item,
        `run.rule_bindings[${index}].source_bindings[${itemIndex}]`,
        'source',
        expectedIdentities
      ))
    const targetBindings = allowLegacyInference
      ? cloneJson(binding.target_bindings)
      : binding.target_bindings.map((item, itemIndex) => normalizeStrictBindingItem(
        item,
        `run.rule_bindings[${index}].target_bindings[${itemIndex}]`,
        'target',
        expectedIdentities
      ))
    const evidence = allowLegacyInference
      ? cloneJson(binding.evidence)
      : binding.evidence.map((item, itemIndex) => normalizeStrictEvidenceItem(
        item,
        `run.rule_bindings[${index}].evidence[${itemIndex}]`,
        expectedIdentities
      ))
    if (!allowLegacyInference) {
      const boundIdentities = new Set([...sourceBindings, ...targetBindings].map((item) => stableStringify(item.identity)))
      if (evidence.some((item) => !boundIdentities.has(stableStringify(item.identity)))) {
        throw new Error(`run.rule_bindings[${index}].evidence identity must match a declared source or target binding`)
      }
    }
    if (!allowLegacyInference && (new Set(sourceBindings.map((item) => item.binding_hash)).size !== sourceBindings.length ||
      new Set(targetBindings.map((item) => item.binding_hash)).size !== targetBindings.length)) {
      throw new Error(`run.rule_bindings[${index}] contains duplicate canonical bindings`)
    }
    if (!allowLegacyInference && new Set(evidence.map((item) => item.evidence_hash)).size !== evidence.length) {
      throw new Error(`run.rule_bindings[${index}] contains duplicate canonical evidence`)
    }
    return {
      rule_id: ruleId,
      status: binding.status,
      action_summary: requireString(binding.action_summary, `run.rule_bindings[${index}].action_summary`),
      source_bindings: sourceBindings,
      target_bindings: targetBindings,
      evidence,
      result_hash: allowLegacyInference
        ? (binding.result_hash === undefined ? null : requireHash(binding.result_hash, `run.rule_bindings[${index}].result_hash`, { nullable: true }))
        : requireHash(binding.result_hash, `run.rule_bindings[${index}].result_hash`)
    }
  })
  const missing = [...ruleIds].filter((ruleId) => !seen.has(ruleId))
  if (missing.length) throw new Error(`run.rule_bindings must cover every rule in the rule pack; missing: ${missing.join(', ')}`)
  return normalized
}

function requiredErrorChecks(pack) {
  const result = []
  for (const rule of pack.rules) {
    for (const check of Array.isArray(rule.validate) ? rule.validate : []) {
      if (check.severity === 'error') {
        result.push({
          required_key: `rule:${rule.id}:${check.id}`,
          id: String(check.id),
          rule_id: String(rule.id),
          scope: 'rule',
          severity: 'error',
          intent: String(check.intent ?? '')
        })
      }
    }
  }
  for (const check of Array.isArray(pack.acceptance) ? pack.acceptance : []) {
    if (check.severity === 'error') {
      result.push({
        required_key: `acceptance:${check.id}`,
        id: String(check.id),
        rule_id: null,
        scope: 'acceptance',
        severity: 'error',
        intent: String(check.intent ?? '')
      })
    }
  }
  return result
}

function normalizeValidation(validation, requiredChecks, { allowLegacyInference = false } = {}) {
  if (!Array.isArray(validation) || validation.length === 0) throw new Error('run.validation must be a non-empty array')
  const seenKeys = new Set()
  const normalized = validation.map((check, index) => {
    requireObject(check, `run.validation[${index}]`)
    if (!VALIDATION_STATUSES.has(check.status)) throw new Error(`run.validation[${index}].status is invalid`)
    const id = requireString(check.id, `run.validation[${index}].id`)
    const key = `${check.rule_id ? `rule:${check.rule_id}` : 'unscoped'}:${id}`
    if (seenKeys.has(key)) throw new Error(`run.validation contains duplicate check: ${key}`)
    seenKeys.add(key)
    const evidence = Array.isArray(check.evidence) ? cloneJson(check.evidence) : []
    if (check.status === 'passed' && evidence.length === 0) {
      throw new Error(`run.validation[${index}].evidence must be non-empty when passed`)
    }
    return {
      id,
      rule_id: check.rule_id === undefined || check.rule_id === null ? null : String(check.rule_id),
      status: check.status,
      evidence,
      required_key: check.required_key === undefined ? null : String(check.required_key),
      scope: check.scope === undefined ? null : String(check.scope),
      severity: check.severity === undefined ? null : String(check.severity),
      coverage_origin: check.coverage_origin === undefined ? 'reported' : String(check.coverage_origin)
    }
  })
  const synthesized = []
  for (const required of requiredChecks) {
    const candidates = normalized.filter((check) => check.id === required.id &&
      (required.rule_id === null ? check.rule_id === null : (check.rule_id === null || check.rule_id === required.rule_id)))
    if (candidates.length > 1) {
      throw new Error(`run.validation is ambiguous for required check: ${required.required_key}`)
    }
    if (candidates.length === 1) {
      Object.assign(candidates[0], {
        required_key: required.required_key,
        rule_id: required.rule_id,
        scope: required.scope,
        severity: required.severity
      })
      continue
    }
    if (!allowLegacyInference) {
      throw new Error(`run.validation must cover required error check: ${required.required_key}`)
    }
    const inferred = {
      id: required.id,
      rule_id: required.rule_id,
      status: 'not_tested',
      evidence: [{
        kind: 'legacy_inferred_gap',
        summary: 'Required error-level check was not present in the supplied run evidence; batch use remains blocked.'
      }],
      required_key: required.required_key,
      scope: required.scope,
      severity: required.severity,
      coverage_origin: 'legacy_inferred'
    }
    normalized.push(inferred)
    synthesized.push(required.required_key)
  }
  return { validation: normalized, synthesized }
}

function executionMode(run, sourceInference) {
  // Inputs created before execution_mode existed are retained as restricted
  // legacy records instead of being silently upgraded to trial/batch evidence.
  const inferred = run.execution_mode ?? (run.batch_item_id || run.batch === true ? 'batch' : 'legacy_inferred')
  if (!EXECUTION_MODES.has(inferred)) throw new Error(`run.execution_mode is invalid: ${inferred}`)
  if (sourceInference && inferred !== 'legacy_inferred') {
    throw new Error('run.execution_mode must be legacy_inferred when source inference is attached')
  }
  return inferred
}

function requiredApprovalType(mode) {
  if (mode === 'batch') return 'batch_authorization'
  if (mode === 'legacy_inferred') return 'legacy_source_confirmation'
  return 'trial_authorization'
}

function normalizeApprovals(approvals, mode, createdAt) {
  if (!Array.isArray(approvals) || approvals.length === 0) throw new Error('run.user_approvals must be a non-empty array')
  const expectedType = requiredApprovalType(mode)
  const normalized = approvals.map((approval, index) => {
    if (typeof approval === 'string') {
      const evidence = requireString(approval, `run.user_approvals[${index}]`)
      return {
        id: `approval-${index + 1}`,
        type: expectedType,
        status: 'confirmed',
        scope: mode,
        confirmed_by: 'user',
        confirmed_at: createdAt,
        evidence: [evidence],
        normalization: 'legacy_string'
      }
    }
    requireObject(approval, `run.user_approvals[${index}]`)
    const type = requireString(approval.type, `run.user_approvals[${index}].type`)
    if (!APPROVAL_TYPES.has(type)) throw new Error(`run.user_approvals[${index}].type is invalid`)
    const status = requireString(approval.status ?? 'confirmed', `run.user_approvals[${index}].status`)
    if (status !== 'confirmed') throw new Error(`run.user_approvals[${index}].status must be confirmed`)
    const evidence = Array.isArray(approval.evidence) ? cloneJson(approval.evidence) : []
    if (evidence.length === 0) throw new Error(`run.user_approvals[${index}].evidence must be non-empty`)
    return {
      id: requireString(approval.id ?? `approval-${index + 1}`, `run.user_approvals[${index}].id`),
      type,
      status,
      scope: requireString(approval.scope ?? mode, `run.user_approvals[${index}].scope`),
      confirmed_by: requireString(approval.confirmed_by, `run.user_approvals[${index}].confirmed_by`),
      confirmed_at: requireString(approval.confirmed_at, `run.user_approvals[${index}].confirmed_at`),
      evidence
    }
  })
  if (!normalized.some((approval) => approval.type === expectedType && approval.status === 'confirmed')) {
    throw new Error(`run.user_approvals must include a confirmed ${expectedType}`)
  }
  return { approvals: normalized, requiredType: expectedType }
}

function normalizeSourceInference(value, sourceBookId) {
  if (value === undefined || value === null) return null
  requireObject(value, 'run.source.inference')
  if (value.kind !== 'legacy_inferred_source') throw new Error('run.source.inference.kind must be legacy_inferred_source')
  if (value.automatic_write !== false) throw new Error('run.source.inference.automatic_write must be false')
  requireObject(value.query_input, 'run.source.inference.query_input')
  requireObject(value.query, 'run.source.inference.query')
  if (!Array.isArray(value.candidate_set_input) || value.candidate_set_input.length === 0) {
    throw new Error('run.source.inference.candidate_set_input must be non-empty')
  }
  requireHash(value.candidate_set_input_hash, 'run.source.inference.candidate_set_input_hash')
  if (hashJson(value.candidate_set_input) !== value.candidate_set_input_hash) {
    throw new Error('run.source.inference.candidate_set_input_hash does not match candidate_set_input')
  }
  if (!Array.isArray(value.candidate_set) || value.candidate_set.length === 0) {
    throw new Error('run.source.inference.candidate_set must be non-empty')
  }
  if (!Array.isArray(value.scores) || value.scores.length === 0) throw new Error('run.source.inference.scores must be non-empty')
  requireHash(value.candidate_set_hash, 'run.source.inference.candidate_set_hash')
  if (hashJson(value.candidate_set) !== value.candidate_set_hash) {
    throw new Error('run.source.inference.candidate_set_hash does not match candidate_set')
  }
  const confirmation = requireObject(value.manual_confirmation, 'run.source.inference.manual_confirmation')
  if (confirmation.confirmed !== true) throw new Error('run.source.inference.manual_confirmation.confirmed must be true')
  requireString(confirmation.confirmed_by, 'run.source.inference.manual_confirmation.confirmed_by')
  requireString(confirmation.confirmed_at, 'run.source.inference.manual_confirmation.confirmed_at')
  if ((!Array.isArray(confirmation.evidence) || confirmation.evidence.length === 0) && !String(confirmation.reason ?? '').trim()) {
    throw new Error('run.source.inference.manual_confirmation requires evidence or reason')
  }
  const selected = requireString(
    value.selected_candidate_id ?? confirmation.candidate_id,
    'run.source.inference.selected_candidate_id'
  )
  if (selected !== String(confirmation.candidate_id)) {
    throw new Error('run.source.inference selected candidate does not match manual confirmation')
  }
  if (selected !== String(sourceBookId)) {
    throw new Error('run.source.inference selected candidate must match run.source.book_id')
  }
  const scored = value.scores.find((candidate) => String(candidate?.candidate_id) === selected)
  if (!isPlainObject(scored)) throw new Error('run.source.inference selected candidate is missing from scores')
  if (scored.eligible !== true) throw new Error('run.source.inference selected candidate must be eligible')
  if (value.selected_score !== scored.score) throw new Error('run.source.inference.selected_score does not match scores')
  if (hashJson(value.selected_evidence ?? []) !== hashJson(scored.evidence ?? [])) {
    throw new Error('run.source.inference.selected_evidence does not match scores')
  }
  if (!value.candidate_set.some((candidate) => String(candidate?.candidate_id ?? candidate?.book_id) === selected)) {
    throw new Error('run.source.inference selected candidate is missing from candidate_set')
  }
  const candidateIds = value.candidate_set.map((candidate) => String(candidate?.candidate_id ?? candidate?.book_id ?? ''))
  if (candidateIds.some((candidateId) => !candidateId)) throw new Error('run.source.inference.candidate_set entries require candidate_id')
  if (new Set(candidateIds).size !== candidateIds.length) throw new Error('run.source.inference.candidate_set candidate_id values must be unique')
  const scoreIds = value.scores.map((candidate) => String(candidate?.candidate_id ?? ''))
  if (scoreIds.some((candidateId) => !candidateId)) throw new Error('run.source.inference.scores entries require candidate_id')
  if (new Set(scoreIds).size !== scoreIds.length) throw new Error('run.source.inference.scores candidate_id values must be unique')
  if (hashJson([...candidateIds].sort()) !== hashJson([...scoreIds].sort())) {
    throw new Error('run.source.inference scores must cover the complete candidate_set')
  }
  return cloneJson(value)
}

export function createProvenance(pack, run, { rulePackArtifactRoot } = {}) {
  assertValidRulePack(pack, rulePackArtifactRoot ? { artifactRoot: rulePackArtifactRoot } : undefined)
  requireObject(run, 'run')
  const source = requireObject(run.source, 'run.source')
  const template = requireObject(run.template, 'run.template')
  const target = requireObject(run.target, 'run.target')
  const baseline = requireObject(run.baseline, 'run.baseline')
  const ruleIds = new Set(pack.rules.map((rule) => rule.id))
  const createdAt = run.created_at ? requireString(run.created_at, 'run.created_at') : new Date().toISOString()
  const sourceBookId = requireString(source.book_id, 'run.source.book_id')
  const sourceCatalogId = requireString(source.catalog_id, 'run.source.catalog_id')
  const targetBookId = requireString(target.book_id, 'run.target.book_id')
  const targetCatalogId = requireString(target.catalog_id, 'run.target.catalog_id')
  const sourceInference = normalizeSourceInference(source.inference ?? run.source_inference, sourceBookId)
  const mode = executionMode(run, sourceInference)
  if (mode === 'batch' && pack.identity.status !== 'validated') {
    throw new Error('batch provenance requires a validated rule pack')
  }
  const requiredChecks = requiredErrorChecks(pack)
  const normalizedValidation = normalizeValidation(run.validation, requiredChecks, {
    allowLegacyInference: mode === 'legacy_inferred'
  })
  const normalizedApprovals = normalizeApprovals(run.user_approvals, mode, createdAt)
  const validationComplete = requiredChecks.every((required) =>
    normalizedValidation.validation.some((check) => check.required_key === required.required_key && check.status === 'passed'))
  const restrictions = []
  if (!validationComplete) restrictions.push('required_error_validation_incomplete')
  if (mode === 'legacy_inferred') restrictions.push('legacy_inferred_record_manual_only')
  const provenance = {
    schema_version: PROVENANCE_SCHEMA_VERSION,
    skill: {
      name: pack.identity.skill_name,
      version: pack.identity.version,
      rule_pack_hash: hashJson(pack)
    },
    run_id: requireString(run.run_id, 'run.run_id'),
    source: {
      book_id: sourceBookId,
      catalog_id: sourceCatalogId,
      catalog_path: source.catalog_path === undefined ? null : cloneJson(source.catalog_path),
      snapshot_hash: requireHash(source.snapshot_hash, 'run.source.snapshot_hash'),
      inference: sourceInference
    },
    template: {
      requested_template_id: requireString(template.requested_template_id, 'run.template.requested_template_id'),
      resolved_template_id: requireString(template.resolved_template_id, 'run.template.resolved_template_id'),
      variant_id: template.variant_id === undefined || template.variant_id === null ? null : String(template.variant_id),
      snapshot_hash: requireHash(template.snapshot_hash, 'run.template.snapshot_hash')
    },
    target: {
      book_id: targetBookId,
      catalog_id: targetCatalogId,
      before_hash: requireHash(target.before_hash, 'run.target.before_hash', { nullable: true }),
      result_hash: requireHash(target.result_hash, 'run.target.result_hash')
    },
    execution: {
      mode,
      required_authorization_type: normalizedApprovals.requiredType,
      restricted: restrictions.length > 0,
      restriction_reasons: restrictions,
      automatic_write: false,
      authorization_confirmed: true,
      batch_authorized: mode === 'batch',
      required_error_validation_passed: validationComplete,
      post_write_verification_pending: true
    },
    coverage: {
      required_rule_ids: [...ruleIds],
      required_error_checks: cloneJson(requiredChecks),
      synthesized_validation_keys: normalizedValidation.synthesized
    },
    rule_bindings: normalizeBindings(run.rule_bindings, ruleIds, {
      allowLegacyInference: mode === 'legacy_inferred',
      expectedIdentities: {
        source: { book_id: sourceBookId, catalog_id: sourceCatalogId },
        target: { book_id: targetBookId, catalog_id: targetCatalogId }
      }
    }),
    instance_fixes: Array.isArray(run.instance_fixes) ? cloneJson(run.instance_fixes) : [],
    user_approvals: normalizedApprovals.approvals,
    validation: normalizedValidation.validation,
    baseline: cloneJson(baseline),
    baseline_hash: hashJson(baseline),
    created_at: createdAt
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
    },
    post_write_verification: {
      required: true,
      expected_run_id: provenance.run_id,
      expected_integrity_hash: provenance.integrity_hash,
      carrier_block_id: carrierBlockId,
      sequence: [
        { order: 1, tool: 'editor_update_block', purpose: 'merge template_data_content.ai_semantic_provenance without dropping unknown block fields' },
        { order: 2, tool: 'editor_save_verified', purpose: 'persist and read back the page after provenance changes the block JSON' },
        { order: 3, tool: 'editor_export_slide', purpose: 'export the saved page, including the carrier block JSON' },
        { order: 4, command: `node scripts/provenance-tools.mjs validate-readback --input <editor-export-slide-envelope.json> --save-receipt <editor-save-verified-envelope.json> --expected <provenance.json> --carrier-block-id ${carrierBlockId} --out <readback-receipt.json>`, purpose: 'validate the real tool envelopes and emit the canonical readback receipt artifact' }
      ],
      completion_condition: 'the real save/export envelopes produce a canonical readback receipt for this run, page hash and carrier identity'
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
  for (const [label, object, fields] of [
    ['source', value.source, ['book_id', 'catalog_id']],
    ['template', value.template, ['requested_template_id', 'resolved_template_id']],
    ['target', value.target, ['book_id', 'catalog_id']]
  ]) {
    if (!isPlainObject(object)) continue
    for (const field of fields) {
      try { requireString(object[field], `${label}.${field}`) } catch (error) { errors.push(error.message) }
    }
  }
  try { requireString(value.run_id, 'run_id') } catch (error) { errors.push(error.message) }
  if (isPlainObject(value.target)) {
    try { requireHash(value.target.before_hash, 'target.before_hash', { nullable: true }) } catch (error) { errors.push(error.message) }
  }
  if (isPlainObject(value.source) && value.source.inference !== null && value.source.inference !== undefined) {
    try { normalizeSourceInference(value.source.inference, value.source.book_id) } catch (error) { errors.push(error.message) }
  }
  if (!isPlainObject(value.execution)) errors.push('execution must be an object')
  else {
    if (!EXECUTION_MODES.has(value.execution.mode)) errors.push('execution.mode is invalid')
    if (!APPROVAL_TYPES.has(value.execution.required_authorization_type)) errors.push('execution.required_authorization_type is invalid')
    else if (EXECUTION_MODES.has(value.execution.mode) &&
             value.execution.required_authorization_type !== requiredApprovalType(value.execution.mode)) {
      errors.push('execution.required_authorization_type does not match execution.mode')
    }
    if (value.execution.automatic_write !== false) errors.push('execution.automatic_write must be false')
    if (value.execution.authorization_confirmed !== true) errors.push('execution.authorization_confirmed must be true')
    if (typeof value.execution.restricted !== 'boolean') errors.push('execution.restricted must be a boolean')
    if (!Array.isArray(value.execution.restriction_reasons)) errors.push('execution.restriction_reasons must be an array')
    if (value.execution.batch_authorized !== (value.execution.mode === 'batch')) errors.push('execution.batch_authorized does not match execution.mode')
    if (typeof value.execution.required_error_validation_passed !== 'boolean') errors.push('execution.required_error_validation_passed must be a boolean')
    if (value.execution.post_write_verification_pending !== true) errors.push('execution.post_write_verification_pending must be true')
  }
  if (!isPlainObject(value.coverage)) errors.push('coverage must be an object')
  else {
    if (!Array.isArray(value.coverage.required_rule_ids) || value.coverage.required_rule_ids.length === 0) {
      errors.push('coverage.required_rule_ids must be a non-empty array')
    }
    if (!Array.isArray(value.coverage.required_error_checks)) errors.push('coverage.required_error_checks must be an array')
    if (!Array.isArray(value.coverage.synthesized_validation_keys)) errors.push('coverage.synthesized_validation_keys must be an array')
  }
  if (!Array.isArray(value.rule_bindings) || value.rule_bindings.length === 0) errors.push('rule_bindings must be a non-empty array')
  else {
    const seenBindingIds = new Set()
    const allowLegacyInference = value.execution?.mode === 'legacy_inferred'
    const expectedIdentities = {
      source: { book_id: String(value.source?.book_id ?? ''), catalog_id: String(value.source?.catalog_id ?? '') },
      target: { book_id: String(value.target?.book_id ?? ''), catalog_id: String(value.target?.catalog_id ?? '') }
    }
    for (const [index, binding] of value.rule_bindings.entries()) {
      if (!isPlainObject(binding)) errors.push(`rule_bindings[${index}] must be an object`)
      else {
        if (!binding.rule_id) errors.push(`rule_bindings[${index}].rule_id is required`)
        else if (seenBindingIds.has(binding.rule_id)) errors.push(`rule_bindings contains duplicate rule_id: ${binding.rule_id}`)
        else seenBindingIds.add(binding.rule_id)
        if (!BINDING_STATUSES.has(binding.status)) errors.push(`rule_bindings[${index}].status is invalid`)
        try { requireString(binding.action_summary, `rule_bindings[${index}].action_summary`) } catch (error) { errors.push(error.message) }
        if (!Array.isArray(binding.source_bindings)) errors.push(`rule_bindings[${index}].source_bindings must be an array`)
        if (!Array.isArray(binding.target_bindings)) errors.push(`rule_bindings[${index}].target_bindings must be an array`)
        if (!Array.isArray(binding.evidence) || binding.evidence.length === 0) errors.push(`rule_bindings[${index}].evidence must be non-empty`)
        try {
          if (allowLegacyInference) {
            requireHash(binding.result_hash, `rule_bindings[${index}].result_hash`, { nullable: true })
          } else {
            requireExactKeys(binding, [
              'rule_id', 'status', 'action_summary', 'source_bindings',
              'target_bindings', 'evidence', 'result_hash'
            ], `rule_bindings[${index}]`)
            if (!Array.isArray(binding.source_bindings) || binding.source_bindings.length === 0 ||
              !Array.isArray(binding.target_bindings) || binding.target_bindings.length === 0) {
              throw new Error(`rule_bindings[${index}] requires non-empty source_bindings and target_bindings`)
            }
            const sourceBindings = binding.source_bindings.map((item, itemIndex) => normalizeStrictBindingItem(
              item, `rule_bindings[${index}].source_bindings[${itemIndex}]`, 'source', expectedIdentities
            ))
            const targetBindings = binding.target_bindings.map((item, itemIndex) => normalizeStrictBindingItem(
              item, `rule_bindings[${index}].target_bindings[${itemIndex}]`, 'target', expectedIdentities
            ))
            const evidence = binding.evidence.map((item, itemIndex) => normalizeStrictEvidenceItem(
              item, `rule_bindings[${index}].evidence[${itemIndex}]`, expectedIdentities
            ))
            requireHash(binding.result_hash, `rule_bindings[${index}].result_hash`)
            const boundIdentities = new Set([...sourceBindings, ...targetBindings].map((item) => stableStringify(item.identity)))
            if (evidence.some((item) => !boundIdentities.has(stableStringify(item.identity)))) {
              throw new Error(`rule_bindings[${index}].evidence identity must match a declared source or target binding`)
            }
          }
        } catch (error) {
          errors.push(error.message)
        }
      }
    }
  }
  if (Array.isArray(value.coverage?.required_rule_ids) && Array.isArray(value.rule_bindings)) {
    const bindingIds = new Set(value.rule_bindings.map((binding) => binding?.rule_id))
    if (new Set(value.coverage.required_rule_ids).size !== value.coverage.required_rule_ids.length) {
      errors.push('coverage.required_rule_ids must not contain duplicates')
    }
    const missing = value.coverage.required_rule_ids.filter((ruleId) => !bindingIds.has(ruleId))
    if (missing.length) errors.push(`rule_bindings do not cover required rules: ${missing.join(', ')}`)
    const unexpected = [...bindingIds].filter((ruleId) => !value.coverage.required_rule_ids.includes(ruleId))
    if (unexpected.length) errors.push(`rule_bindings contain rules outside coverage: ${unexpected.join(', ')}`)
  }
  if (!Array.isArray(value.validation) || value.validation.length === 0) errors.push('validation must be a non-empty array')
  else {
    for (const [index, check] of value.validation.entries()) {
      if (!isPlainObject(check)) {
        errors.push(`validation[${index}] must be an object`)
        continue
      }
      if (!check.id) errors.push(`validation[${index}].id is required`)
      if (!VALIDATION_STATUSES.has(check.status)) errors.push(`validation[${index}].status is invalid`)
      if (check.status === 'passed' && (!Array.isArray(check.evidence) || check.evidence.length === 0)) {
        errors.push(`validation[${index}].evidence must be non-empty when passed`)
      }
    }
  }
  if (Array.isArray(value.coverage?.required_error_checks) && Array.isArray(value.validation)) {
    let allRequiredPassed = true
    for (const required of value.coverage.required_error_checks) {
      if (!isPlainObject(required) || !required.required_key) {
        errors.push('coverage.required_error_checks entries require required_key')
        allRequiredPassed = false
        continue
      }
      const matching = value.validation.filter((check) => check?.required_key === required.required_key)
      if (matching.length === 0) {
        errors.push(`validation does not cover required error check: ${required.required_key}`)
        allRequiredPassed = false
      } else {
        if (matching.length > 1) errors.push(`validation contains duplicate required error check: ${required.required_key}`)
        if (!matching.some((check) => check.status === 'passed')) allRequiredPassed = false
      }
    }
    if (isPlainObject(value.execution)) {
      const shouldRestrict = !allRequiredPassed || value.execution.mode === 'legacy_inferred'
      if (value.execution.restricted !== shouldRestrict) errors.push('execution.restricted does not match validation/mode restrictions')
      if (value.execution.required_error_validation_passed !== allRequiredPassed) {
        errors.push('execution.required_error_validation_passed does not match required error validation')
      }
    }
  }
  if (!Array.isArray(value.user_approvals) || value.user_approvals.length === 0) {
    errors.push('user_approvals must be a non-empty array')
  } else {
    for (const [index, approval] of value.user_approvals.entries()) {
      if (!isPlainObject(approval)) {
        errors.push(`user_approvals[${index}] must be an object`)
        continue
      }
      if (!APPROVAL_TYPES.has(approval.type)) errors.push(`user_approvals[${index}].type is invalid`)
      if (approval.status !== 'confirmed') errors.push(`user_approvals[${index}].status must be confirmed`)
      for (const field of ['id', 'scope', 'confirmed_by', 'confirmed_at']) {
        try { requireString(approval[field], `user_approvals[${index}].${field}`) } catch (error) { errors.push(error.message) }
      }
      if (!Array.isArray(approval.evidence) || approval.evidence.length === 0) errors.push(`user_approvals[${index}].evidence must be non-empty`)
    }
    if (value.execution?.required_authorization_type &&
        !value.user_approvals.some((approval) => approval?.type === value.execution.required_authorization_type && approval?.status === 'confirmed')) {
      errors.push(`user_approvals does not include ${value.execution.required_authorization_type}`)
    }
  }
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

function unwrapMcpTextEnvelope(value, label) {
  requireExactKeys(value, ['content'], label)
  if (!Array.isArray(value.content) || value.content.length !== 1) {
    throw new Error(`${label}.content must contain exactly one MCP text content block`)
  }
  const content = value.content[0]
  requireExactKeys(content, ['type', 'text'], `${label}.content[0]`)
  if (content.type !== 'text') throw new Error(`${label}.content[0].type must be text`)
  if (typeof content.text !== 'string') throw new Error(`${label}.content[0].text must be a JSON string`)
  let data
  try {
    data = JSON.parse(content.text)
  } catch (error) {
    throw new Error(`${label}.content[0].text must contain valid JSON: ${error.message}`)
  }
  if (!isPlainObject(data)) throw new Error(`${label} decoded tool result must be an object`)
  return data
}

function fnv1a32(value) {
  const input = String(value || '')
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/** Mirror the editor's hashCatalogContent(stringifyData(blocks)) contract. */
export function hashEditorExportBlocks(blocks) {
  if (!Array.isArray(blocks)) throw new Error('editor_export_slide blocks must be an array')
  const persistedShape = blocks.map((block, index) => {
    requireObject(block, `editor_export_slide blocks[${index}]`)
    const { template_info: templateInfo, template_data_content: templateDataContent, ...rest } = block
    if (!isPlainObject(templateDataContent)) {
      throw new Error(`editor_export_slide blocks[${index}].template_data_content must be an object`)
    }
    if (templateInfo !== null && templateInfo !== undefined && !isPlainObject(templateInfo)) {
      throw new Error(`editor_export_slide blocks[${index}].template_info must be an object or null`)
    }
    const { content, ...templateInfoRest } = templateInfo || {}
    return {
      ...rest,
      sort: index + 1,
      template_data_content: JSON.stringify(templateDataContent),
      template_info: templateInfo ? { ...templateInfoRest, content: JSON.stringify(content) } : null
    }
  })
  return fnv1a32(stableStringify(persistedShape))
}

function validateSaveReceiptData(data, slideId) {
  requireExactKeys(data, [
    'scope', 'slideId', 'saved', 'savedScope', 'savedSlides', 'verified',
    'verifiedScope', 'verifiedSlides', 'contentHash', 'persistedContentHash',
    'dirty', 'warnings'
  ], 'editor_save_verified decoded result')
  if (data.scope !== 'current') throw new Error('editor_save_verified scope must be current')
  if (String(data.slideId) !== slideId) throw new Error('editor_save_verified slideId does not match the expected target slide')
  if (data.saved !== true || data.savedScope !== 'current') throw new Error('editor_save_verified must report saved=true and savedScope=current')
  if (data.verified !== true || data.verifiedScope !== 'current') throw new Error('editor_save_verified must report verified=true and verifiedScope=current')
  for (const [field, value] of [['savedSlides', data.savedSlides], ['verifiedSlides', data.verifiedSlides]]) {
    if (!Array.isArray(value) || value.length !== 1 || String(value[0]) !== slideId) {
      throw new Error(`editor_save_verified ${field} must contain exactly the target slideId`)
    }
  }
  if (!FNV_PAGE_HASH_PATTERN.test(data.contentHash) || !FNV_PAGE_HASH_PATTERN.test(data.persistedContentHash)) {
    throw new Error('editor_save_verified contentHash and persistedContentHash must match fnv1a32:<8 lowercase hex>')
  }
  if (data.contentHash !== data.persistedContentHash) {
    throw new Error('editor_save_verified contentHash must equal persistedContentHash')
  }
  if (data.dirty !== false) throw new Error('editor_save_verified dirty must be false')
  if (!Array.isArray(data.warnings) || data.warnings.length !== 0) {
    throw new Error('editor_save_verified warnings must be an empty array for a verified receipt')
  }
}

function provenanceKeyPaths(value, currentPath = '$', found = [], seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return found
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, index) => provenanceKeyPaths(item, `${currentPath}[${index}]`, found, seen))
    return found
  }
  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${currentPath}.${key}`
    if (key === 'ai_semantic_provenance') found.push(itemPath)
    provenanceKeyPaths(item, itemPath, found, seen)
  }
  return found
}

function withReceiptHash(value) {
  return { ...value, receipt_hash: hashJson(value) }
}

function requireIsoTimestamp(value, label) {
  const timestamp = requireString(value, label)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`)
  }
  return timestamp
}

function createReadbackReceipt({ expected, carrierBlockId, saveEnvelope, saveData, exportEnvelope, exportData, carrier, pageContentHash, verifiedAt }) {
  const save = withReceiptHash({
    tool: 'editor_save_verified',
    scope: 'current',
    slide_id: String(saveData.slideId),
    saved: true,
    saved_scope: 'current',
    saved_slides: saveData.savedSlides.map(String),
    verified: true,
    verified_scope: 'current',
    verified_slides: saveData.verifiedSlides.map(String),
    content_hash: saveData.contentHash,
    persisted_content_hash: saveData.persistedContentHash,
    dirty: false,
    envelope_hash: hashJson(saveEnvelope)
  })
  const exported = withReceiptHash({
    tool: 'editor_export_slide',
    slide_id: String(exportData.slideId),
    block_count: exportData.blocks.length,
    page_content_hash: pageContentHash,
    blocks_hash: hashJson(exportData.blocks),
    carrier_block_hash: hashJson(carrier),
    envelope_hash: hashJson(exportEnvelope)
  })
  const receipt = {
    schema_version: READBACK_RECEIPT_SCHEMA_VERSION,
    kind: READBACK_RECEIPT_KIND,
    run_id: expected.run_id,
    provenance_integrity_hash: expected.integrity_hash,
    carrier_block_id: carrierBlockId,
    identity: {
      slide_id: String(exportData.slideId),
      source_book_id: String(expected.source.book_id),
      source_catalog_id: String(expected.source.catalog_id),
      target_book_id: String(expected.target.book_id),
      target_catalog_id: String(expected.target.catalog_id)
    },
    save,
    export: exported,
    verified_at: requireIsoTimestamp(verifiedAt, 'verified_at')
  }
  receipt.artifact_integrity = {
    algorithm: 'sha256-canonical-json',
    canonical_hash: hashJson(receipt)
  }
  return receipt
}

export function validateReadbackReceiptArtifact(receipt) {
  const errors = []
  try {
    requireExactKeys(receipt, [
      'schema_version', 'kind', 'run_id', 'provenance_integrity_hash', 'carrier_block_id',
      'identity', 'save', 'export', 'verified_at', 'artifact_integrity'
    ], 'readback receipt')
    if (receipt.schema_version !== READBACK_RECEIPT_SCHEMA_VERSION) throw new Error(`readback receipt schema_version must be ${READBACK_RECEIPT_SCHEMA_VERSION}`)
    if (receipt.kind !== READBACK_RECEIPT_KIND) throw new Error(`readback receipt kind must be ${READBACK_RECEIPT_KIND}`)
    requireString(receipt.run_id, 'readback receipt.run_id')
    requireHash(receipt.provenance_integrity_hash, 'readback receipt.provenance_integrity_hash')
    requireString(receipt.carrier_block_id, 'readback receipt.carrier_block_id')
    requireIsoTimestamp(receipt.verified_at, 'readback receipt.verified_at')
    requireExactKeys(receipt.identity, [
      'slide_id', 'source_book_id', 'source_catalog_id', 'target_book_id', 'target_catalog_id'
    ], 'readback receipt.identity')
    for (const field of ['slide_id', 'source_book_id', 'source_catalog_id', 'target_book_id', 'target_catalog_id']) {
      requireString(receipt.identity[field], `readback receipt.identity.${field}`)
    }
    requireExactKeys(receipt.save, [
      'tool', 'scope', 'slide_id', 'saved', 'saved_scope', 'saved_slides', 'verified',
      'verified_scope', 'verified_slides', 'content_hash', 'persisted_content_hash',
      'dirty', 'envelope_hash', 'receipt_hash'
    ], 'readback receipt.save')
    if (receipt.save.tool !== 'editor_save_verified' || receipt.save.scope !== 'current') throw new Error('readback receipt.save tool/scope is invalid')
    if (receipt.save.saved !== true || receipt.save.saved_scope !== 'current' || receipt.save.verified !== true || receipt.save.verified_scope !== 'current' || receipt.save.dirty !== false) {
      throw new Error('readback receipt.save must record a saved and verified clean current slide')
    }
    if (!FNV_PAGE_HASH_PATTERN.test(receipt.save.content_hash) || receipt.save.content_hash !== receipt.save.persisted_content_hash) {
      throw new Error('readback receipt.save page hashes are invalid or unequal')
    }
    requireHash(receipt.save.envelope_hash, 'readback receipt.save.envelope_hash')
    const saveCopy = cloneJson(receipt.save)
    const saveHash = saveCopy.receipt_hash
    delete saveCopy.receipt_hash
    requireHash(saveHash, 'readback receipt.save.receipt_hash')
    if (hashJson(saveCopy) !== saveHash) throw new Error('readback receipt.save.receipt_hash does not match')
    requireExactKeys(receipt.export, [
      'tool', 'slide_id', 'block_count', 'page_content_hash', 'blocks_hash',
      'carrier_block_hash', 'envelope_hash', 'receipt_hash'
    ], 'readback receipt.export')
    if (receipt.export.tool !== 'editor_export_slide') throw new Error('readback receipt.export.tool is invalid')
    if (!Number.isInteger(receipt.export.block_count) || receipt.export.block_count < 1) throw new Error('readback receipt.export.block_count must be a positive integer')
    if (!FNV_PAGE_HASH_PATTERN.test(receipt.export.page_content_hash)) throw new Error('readback receipt.export.page_content_hash is invalid')
    for (const field of ['blocks_hash', 'carrier_block_hash', 'envelope_hash']) requireHash(receipt.export[field], `readback receipt.export.${field}`)
    const exportCopy = cloneJson(receipt.export)
    const exportHash = exportCopy.receipt_hash
    delete exportCopy.receipt_hash
    requireHash(exportHash, 'readback receipt.export.receipt_hash')
    if (hashJson(exportCopy) !== exportHash) throw new Error('readback receipt.export.receipt_hash does not match')
    const slideId = receipt.identity.slide_id
    if (receipt.identity.target_catalog_id !== slideId || receipt.save.slide_id !== slideId || receipt.export.slide_id !== slideId) {
      throw new Error('readback receipt slide/target catalog identities do not match')
    }
    for (const field of ['saved_slides', 'verified_slides']) {
      if (!Array.isArray(receipt.save[field]) || receipt.save[field].length !== 1 || receipt.save[field][0] !== slideId) {
        throw new Error(`readback receipt.save.${field} must contain exactly identity.slide_id`)
      }
    }
    if (receipt.save.content_hash !== receipt.export.page_content_hash) {
      throw new Error('readback receipt save/export page hashes do not match')
    }
    requireExactKeys(receipt.artifact_integrity, ['algorithm', 'canonical_hash'], 'readback receipt.artifact_integrity')
    if (receipt.artifact_integrity.algorithm !== 'sha256-canonical-json') throw new Error('readback receipt.artifact_integrity.algorithm is invalid')
    requireHash(receipt.artifact_integrity.canonical_hash, 'readback receipt.artifact_integrity.canonical_hash')
    const receiptCopy = cloneJson(receipt)
    delete receiptCopy.artifact_integrity
    if (hashJson(receiptCopy) !== receipt.artifact_integrity.canonical_hash) {
      throw new Error('readback receipt artifact_integrity.canonical_hash does not match')
    }
  } catch (error) {
    errors.push(error.message)
  }
  return { valid: errors.length === 0, errors, warnings: [] }
}

/** Validate real editor_save_verified/editor_export_slide MCP envelopes and create the terminal artifact. */
export function validateProvenanceReadback(exportEnvelope, expectedInput, {
  saveReceipt,
  carrierBlockId,
  verifiedAt = new Date().toISOString()
} = {}) {
  try {
    if (expectedInput === null || expectedInput === undefined) throw new Error('expected provenance is required')
    if (!saveReceipt) throw new Error('the real editor_save_verified MCP receipt envelope is required')
    const expected = unwrapProvenance(expectedInput)
    if (!isPlainObject(expected)) throw new Error('expected provenance must be an object')
    const expectedValidation = validateProvenance(expected)
    if (!expectedValidation.valid) throw new Error(`expected provenance is invalid: ${expectedValidation.errors.join('; ')}`)
    const explicitCarrierId = requireString(carrierBlockId, 'carrierBlockId')
    const plannedCarrierId = expectedInput?.post_write_verification?.carrier_block_id
    if (plannedCarrierId !== undefined && String(plannedCarrierId) !== explicitCarrierId) {
      throw new Error('carrierBlockId does not match expected post_write_verification.carrier_block_id')
    }
    const exportData = unwrapMcpTextEnvelope(exportEnvelope, 'editor_export_slide envelope')
    requireExactKeys(exportData, ['slideId', 'blocks'], 'editor_export_slide decoded result')
    const slideId = requireString(exportData.slideId, 'editor_export_slide slideId')
    if (!Array.isArray(exportData.blocks)) throw new Error('editor_export_slide blocks must be an array')
    if (String(expected.target.catalog_id) !== slideId) throw new Error('editor_export_slide slideId does not match provenance target.catalog_id')
    const saveData = unwrapMcpTextEnvelope(saveReceipt, 'editor_save_verified envelope')
    validateSaveReceiptData(saveData, slideId)
    const pageContentHash = hashEditorExportBlocks(exportData.blocks)
    if (pageContentHash !== saveData.contentHash || pageContentHash !== saveData.persistedContentHash) {
      throw new Error('editor_export_slide blocks do not reproduce the editor_save_verified page content hash')
    }
    const carrierMatches = exportData.blocks.filter((block) => String(block?.uuid ?? '') === explicitCarrierId)
    if (carrierMatches.length !== 1) {
      throw new Error(`editor_export_slide must contain exactly one block with uuid=${explicitCarrierId}`)
    }
    const carrier = carrierMatches[0]
    if (!isPlainObject(carrier.template_data_content)) {
      throw new Error('carrier template_data_content must be the real exported object, not a string or nested surrogate')
    }
    const carrierProvenance = carrier.template_data_content.ai_semantic_provenance
    if (!isPlainObject(carrierProvenance)) {
      throw new Error('carrier provenance must exist directly at blocks[i].template_data_content.ai_semantic_provenance')
    }
    const allowedPath = `$.blocks[${exportData.blocks.indexOf(carrier)}].template_data_content.ai_semantic_provenance`
    const provenancePaths = provenanceKeyPaths(exportData)
    if (provenancePaths.length !== 1 || provenancePaths[0] !== allowedPath) {
      throw new Error(`editor_export_slide must contain exactly one direct provenance carrier at ${allowedPath}; found: ${provenancePaths.join(', ') || 'none'}`)
    }
    const carrierValidation = validateProvenance(carrierProvenance)
    if (!carrierValidation.valid) throw new Error(`carrier provenance is invalid: ${carrierValidation.errors.join('; ')}`)
    if (carrierProvenance.run_id !== expected.run_id || carrierProvenance.integrity_hash !== expected.integrity_hash ||
      hashJson(carrierProvenance) !== hashJson(expected)) {
      throw new Error('carrier provenance does not exactly match the expected run_id, integrity_hash and canonical content')
    }
    const receipt = createReadbackReceipt({
      expected,
      carrierBlockId: explicitCarrierId,
      saveEnvelope: saveReceipt,
      saveData,
      exportEnvelope,
      exportData,
      carrier,
      pageContentHash,
      verifiedAt
    })
    const receiptValidation = validateReadbackReceiptArtifact(receipt)
    if (!receiptValidation.valid) throw new Error(`generated readback receipt is invalid: ${receiptValidation.errors.join('; ')}`)
    return {
      valid: true,
      errors: [],
      warnings: [],
      matched_path: allowedPath,
      receipt
    }
  } catch (error) {
    return { valid: false, errors: [error.message], warnings: [], matched_path: null, receipt: null }
  }
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
    process.stdout.write('Usage:\n  provenance-tools.mjs create --rule-pack <json> --input <run.json> [--out <json>]\n  provenance-tools.mjs validate --input <provenance.json> [--out <json>]\n  provenance-tools.mjs validate-readback --input <editor-export-slide-envelope.json> --save-receipt <editor-save-verified-envelope.json> --expected <provenance.json> --carrier-block-id <uuid> [--verified-at <ISO-UTC>] [--out <receipt.json>]\n  provenance-tools.mjs validate-receipt --input <receipt.json> [--out <json>]\n  provenance-tools.mjs plan-refinement --input <three-way.json> [--out <json>]\n  provenance-tools.mjs match-source --input <candidates.json> [--out <json>]\n')
    return 0
  }
  const options = parseArgs(argv)
  const command = options._[0]
  if (!options.input) throw new Error('--input is required')
  if (command === 'create') {
    if (!options['rule-pack']) throw new Error('--rule-pack is required for create')
    writeJson(options.out, createProvenance(readJson(options['rule-pack']), readJson(options.input), {
      rulePackArtifactRoot: path.dirname(path.resolve(options['rule-pack']))
    }))
    return 0
  }
  if (command === 'validate') {
    const result = validateProvenance(readJson(options.input))
    writeJson(options.out, result)
    return result.valid ? 0 : 1
  }
  if (command === 'validate-readback') {
    if (!options.expected || !options['save-receipt'] || !options['carrier-block-id']) {
      throw new Error('--expected, --save-receipt and --carrier-block-id are required for validate-readback')
    }
    const result = validateProvenanceReadback(
      readJson(options.input),
      readJson(options.expected),
      {
        saveReceipt: readJson(options['save-receipt']),
        carrierBlockId: options['carrier-block-id'],
        verifiedAt: options['verified-at'] ?? new Date().toISOString()
      }
    )
    writeJson(options.out, result.valid ? result.receipt : result)
    return result.valid ? 0 : 1
  }
  if (command === 'validate-receipt') {
    const result = validateReadbackReceiptArtifact(readJson(options.input))
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
