#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const PROVENANCE_SCHEMA_VERSION = 1
export const PROVENANCE_MODES = new Set(['generated', 'legacy_inferred'])
export const LEGACY_MATCH_WEIGHTS = Object.freeze({
  subject: 5,
  grade: 5,
  volume: 5,
  book_name_exact: 15,
  book_name_contains: 8,
  catalog_path_exact: 20,
  catalog_name_sort_exact: 15,
  template_exact: 15,
  sample_block_exact: 10,
  source_id_fingerprint: 15,
  structure_fingerprint_exact: 10
})
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isPlainObject(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  )
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value))
}

export function hashJson(value) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`
}

function normalizeHash(value, label, { nullable = false } = {}) {
  if ((value === null || value === undefined || value === '') && nullable) return null
  if (typeof value !== 'string') throw new Error(`${label} must be a SHA-256 string`)
  const normalized = value.startsWith('sha256:') ? value.toLowerCase() : `sha256:${value.toLowerCase()}`
  if (!HASH_PATTERN.test(normalized)) throw new Error(`${label} must match sha256:<64 lowercase hex>`)
  return normalized
}

function normalizeIdentifier(value, label, { nullable = false } = {}) {
  if ((value === null || value === undefined || value === '') && nullable) return null
  if (value === null || value === undefined || String(value).trim() === '') {
    throw new Error(`${label} is required`)
  }
  return String(value)
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}

function requireObject(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`)
  return value
}

function normalizeHashMap(value, label) {
  requireObject(value, label)
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, hash]) => [key, normalizeHash(hash, `${label}.${key}`)])
  )
}

function hashSnapshotMap(value, label) {
  requireObject(value, label)
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, snapshot]) => [key, hashJson(snapshot)])
  )
}

function normalizeSnapshotMap(value, label) {
  requireObject(value, label)
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, snapshot]) => {
        if (!key) throw new Error(`${label} contains an empty target`)
        if (snapshot === undefined) throw new Error(`${label}.${key} cannot be undefined`)
        return [key, canonicalize(snapshot)]
      })
  )
}

function sameRecord(left, right) {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key])
}

function buildBaseline(input) {
  const baseline = requireObject(input, 'baseline')
  const result = {}
  for (const kind of ['text', 'layout']) {
    const snapshotKey = `${kind}_snapshots`
    const hashKey = `${kind}_hashes`
    const raw = baseline[snapshotKey] ?? baseline[kind]
    const suppliedHashes = baseline[hashKey]
    if (raw === undefined && suppliedHashes === undefined) {
      result[snapshotKey] = {}
      result[hashKey] = {}
      continue
    }
    if (raw === undefined) {
      throw new Error(`baseline.${snapshotKey} is required when baseline.${hashKey} is provided`)
    }
    const snapshots = normalizeSnapshotMap(raw, `baseline.${snapshotKey}`)
    const computed = hashSnapshotMap(snapshots, `baseline.${snapshotKey}`)
    const normalized = suppliedHashes === undefined
      ? null
      : normalizeHashMap(suppliedHashes, `baseline.${hashKey}`)
    if (computed && normalized && !sameRecord(computed, normalized)) {
      throw new Error(`baseline.${snapshotKey} does not match baseline.${hashKey}`)
    }
    result[snapshotKey] = snapshots
    result[hashKey] = computed
  }
  return result
}

function pickHash(explicit, fallback, label, options) {
  return normalizeHash(explicit ?? fallback, label, options)
}

function normalizeCatalogRoute(route) {
  if (route === null || route === undefined) return null
  requireObject(route, 'template.catalog_route')
  return {
    key: requireNonEmptyString(route.key, 'template.catalog_route.key'),
    priority: Number.isInteger(Number(route.priority)) ? Number(route.priority) : (() => {
      throw new Error('template.catalog_route.priority must be an integer')
    })()
  }
}

function normalizeTargetLists(value, label) {
  requireObject(value, label)
  const result = {}
  for (const kind of ['text', 'layout']) {
    if (!Array.isArray(value[kind])) throw new Error(`${label}.${kind} must be an array`)
    const list = value[kind].map((target, index) =>
      requireNonEmptyString(target, `${label}.${kind}[${index}]`)
    )
    if (new Set(list).size !== list.length) throw new Error(`${label}.${kind} must not contain duplicates`)
    result[kind] = [...list].sort()
  }
  return result
}

function normalizeArtifactSnapshot(value, label) {
  requireObject(value, label)
  return Object.fromEntries(
    ['source_hash', 'rule_hash', 'template_hash', 'map_hash'].map((key) => [
      key,
      normalizeHash(value[key], `${label}.${key}`)
    ])
  )
}

function normalizeRefinement(value) {
  if (value === undefined || value === null) return null
  requireObject(value, 'refinement')
  const refinement = {
    origin_artifacts: normalizeArtifactSnapshot(value.origin_artifacts, 'refinement.origin_artifacts'),
    desired_artifacts: normalizeArtifactSnapshot(value.desired_artifacts, 'refinement.desired_artifacts'),
    applied_targets: normalizeTargetLists(value.applied_targets, 'refinement.applied_targets'),
    conflict_targets: normalizeTargetLists(value.conflict_targets, 'refinement.conflict_targets'),
    current_state_hash: normalizeHash(value.current_state_hash, 'refinement.current_state_hash'),
    complete_application: value.complete_application,
    readback_verified: value.readback_verified,
    origin_artifacts_promoted: value.origin_artifacts_promoted
  }
  for (const key of ['complete_application', 'readback_verified', 'origin_artifacts_promoted']) {
    if (typeof refinement[key] !== 'boolean') throw new Error(`refinement.${key} must be boolean`)
  }
  return refinement
}

const EVIDENCE_FIELDS = new Set([
  'rule',
  'points',
  'hard_reject',
  'query',
  'candidate',
  'ratio',
  'match',
  'note'
])

function isEvidenceScalar(value) {
  return value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
}

function normalizeInferenceEvidenceItem(value, label) {
  if (typeof value === 'string') {
    return {
      rule: 'legacy_note',
      points: 0,
      note: requireNonEmptyString(value, label)
    }
  }
  requireObject(value, label)
  const unknownFields = Object.keys(value).filter((key) => !EVIDENCE_FIELDS.has(key))
  if (unknownFields.length) throw new Error(`${label} has unknown fields: ${unknownFields.join(', ')}`)
  const item = {
    rule: requireNonEmptyString(value.rule, `${label}.rule`),
    points: value.points
  }
  if (typeof item.points !== 'number' || !Number.isFinite(item.points) || item.points < 0) {
    throw new Error(`${label}.points must be a non-negative finite number`)
  }
  if (value.hard_reject !== undefined) {
    if (typeof value.hard_reject !== 'boolean') throw new Error(`${label}.hard_reject must be boolean`)
    item.hard_reject = value.hard_reject
  }
  for (const key of ['query', 'candidate']) {
    if (value[key] !== undefined) {
      if (!isEvidenceScalar(value[key])) throw new Error(`${label}.${key} must be a JSON scalar`)
      item[key] = value[key]
    }
  }
  if (value.ratio !== undefined) {
    const ratio = value.ratio
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      throw new Error(`${label}.ratio must be between 0 and 1`)
    }
    item.ratio = ratio
  }
  for (const key of ['match', 'note']) {
    if (value[key] !== undefined) item[key] = requireNonEmptyString(value[key], `${label}.${key}`)
  }
  return item
}

function validateInferenceEvidenceItem(value, label, fail) {
  if (typeof value === 'string') {
    if (!value.trim()) fail(`${label} must be a non-empty legacy string or structured evidence object`)
    return
  }
  try {
    normalizeInferenceEvidenceItem(value, label)
  } catch (error) {
    fail(error.message)
  }
}

/**
 * Build one block-level provenance record and the exact editor_update_block call
 * arguments used to persist it under template_data_content.ai_provenance.
 */
export function createProvenance(spec, options = {}) {
  requireObject(spec, 'create input')
  const mode = spec.mode || 'generated'
  if (!PROVENANCE_MODES.has(mode)) throw new Error('mode must be generated or legacy_inferred')

  const route = isPlainObject(spec.route) ? spec.route : {}
  const routeRegistry = isPlainObject(route.registry) ? route.registry : {}
  const templateInput = requireObject(spec.template || {}, 'template')
  const artifactsInput = requireObject(spec.artifacts || {}, 'artifacts')
  const sourceInput = requireObject(spec.source, 'source')
  const isLegacy = mode === 'legacy_inferred'

  const requestedTemplateId = normalizeIdentifier(
    templateInput.requested_template_id ?? route.requested_template_id,
    'template.requested_template_id',
    { nullable: isLegacy }
  )
  const resolvedTemplateId = normalizeIdentifier(
    templateInput.resolved_template_id ?? route.resolved_template_id,
    'template.resolved_template_id'
  )
  const sampleBlockId = normalizeIdentifier(
    templateInput.sample_block_id ?? spec.sample_block_id,
    'template.sample_block_id'
  )

  const catalogSort = Number(sourceInput.catalog_sort)
  if (!Number.isInteger(catalogSort) || catalogSort < 0) {
    throw new Error('source.catalog_sort must be a non-negative integer')
  }

  const source = {
    book_id: normalizeIdentifier(sourceInput.book_id, 'source.book_id'),
    catalog_id: normalizeIdentifier(sourceInput.catalog_id, 'source.catalog_id'),
    catalog_name: requireNonEmptyString(sourceInput.catalog_name, 'source.catalog_name'),
    catalog_sort: catalogSort
  }
  for (const key of ['book_name', 'subject', 'grade', 'volume', 'catalog_path']) {
    if (sourceInput[key] !== undefined && sourceInput[key] !== null && sourceInput[key] !== '') {
      source[key] = String(sourceInput[key])
    }
  }

  const template = {
    requested_template_id: requestedTemplateId,
    resolved_template_id: resolvedTemplateId,
    sample_block_id: sampleBlockId,
    template_locked: Boolean(templateInput.template_locked ?? route.template_locked),
    catalog_route: normalizeCatalogRoute(templateInput.catalog_route ?? route.catalog_route)
  }

  const artifacts = {
    source_hash: pickHash(
      artifactsInput.source_hash,
      undefined,
      'artifacts.source_hash',
      { nullable: isLegacy }
    ),
    rule_hash: pickHash(
      artifactsInput.rule_hash,
      routeRegistry.analyse_sha256,
      'artifacts.rule_hash',
      { nullable: isLegacy }
    ),
    template_hash: pickHash(
      artifactsInput.template_hash,
      routeRegistry.raw_sha256,
      'artifacts.template_hash',
      { nullable: isLegacy }
    ),
    map_hash: spec.map !== undefined
      ? hashJson(spec.map)
      : pickHash(artifactsInput.map_hash, undefined, 'artifacts.map_hash', { nullable: isLegacy })
  }

  const optionalHashes = {
    registry_hash: artifactsInput.registry_hash ?? routeRegistry.registry_sha256,
    routing_hash: artifactsInput.routing_hash ?? routeRegistry.routing_sha256,
    template_pair_hash: artifactsInput.template_pair_hash ?? routeRegistry.pair_sha256
  }
  for (const [key, value] of Object.entries(optionalHashes)) {
    if (value !== null && value !== undefined && value !== '') {
      artifacts[key] = normalizeHash(value, `artifacts.${key}`)
    }
  }

  const provenance = {
    schema_version: PROVENANCE_SCHEMA_VERSION,
    mode,
    run_id: normalizeIdentifier(spec.run_id || crypto.randomUUID(), 'run_id'),
    source,
    template,
    artifacts,
    baseline: buildBaseline(spec.baseline || {})
  }

  const refinement = normalizeRefinement(spec.refinement)
  if (refinement) provenance.refinement = refinement

  if (isLegacy) {
    const inferenceInput = requireObject(spec.inference, 'inference')
    const confidence = inferenceInput.confidence
    if (!['high', 'medium', 'low'].includes(confidence)) {
      throw new Error('inference.confidence must be high, medium, or low')
    }
    if (!Array.isArray(inferenceInput.evidence) || !inferenceInput.evidence.length) {
      throw new Error('inference.evidence must be a non-empty array')
    }
    provenance.inference = {
      confidence,
      evidence: inferenceInput.evidence.map((item, index) =>
        normalizeInferenceEvidenceItem(item, `inference.evidence[${index}]`)
      )
    }
    if (inferenceInput.confidence_reasons !== undefined) {
      if (!Array.isArray(inferenceInput.confidence_reasons) || !inferenceInput.confidence_reasons.length) {
        throw new Error('inference.confidence_reasons must be a non-empty array when provided')
      }
      provenance.inference.confidence_reasons = inferenceInput.confidence_reasons.map((item, index) =>
        requireNonEmptyString(item, `inference.confidence_reasons[${index}]`)
      )
    }
  }

  const validation = validateProvenance(provenance)
  if (!validation.valid) throw new Error(validation.errors.join('; '))

  const blockId = normalizeIdentifier(options.blockId ?? spec.block_id, 'block_id')
  return {
    provenance,
    editor_update_block: {
      tool: 'editor_update_block',
      arguments: {
        blockId,
        patch: { ai_provenance: provenance }
      }
    }
  }
}

export function validateProvenance(provenance) {
  const errors = []
  const warnings = []
  const fail = (message) => errors.push(message)

  if (!isPlainObject(provenance)) return { valid: false, errors: ['ai_provenance must be an object'], warnings }
  if (provenance.schema_version !== PROVENANCE_SCHEMA_VERSION) fail('schema_version must be 1')
  if (!PROVENANCE_MODES.has(provenance.mode)) fail('mode must be generated or legacy_inferred')
  if (typeof provenance.run_id !== 'string' || !provenance.run_id) fail('run_id is required')

  const source = provenance.source
  if (!isPlainObject(source)) fail('source must be an object')
  else {
    for (const key of ['book_id', 'catalog_id', 'catalog_name']) {
      if (typeof source[key] !== 'string' || !source[key]) fail(`source.${key} is required`)
    }
    if (!Number.isInteger(source.catalog_sort) || source.catalog_sort < 0) {
      fail('source.catalog_sort must be a non-negative integer')
    }
  }

  const template = provenance.template
  if (!isPlainObject(template)) fail('template must be an object')
  else {
    if (provenance.mode === 'generated' && (typeof template.requested_template_id !== 'string' || !template.requested_template_id)) {
      fail('template.requested_template_id is required for generated provenance')
    }
    if (provenance.mode === 'legacy_inferred' && template.requested_template_id !== null && typeof template.requested_template_id !== 'string') {
      fail('template.requested_template_id must be string or null for legacy_inferred provenance')
    }
    for (const key of ['resolved_template_id', 'sample_block_id']) {
      if (typeof template[key] !== 'string' || !template[key]) fail(`template.${key} is required`)
    }
    if (typeof template.template_locked !== 'boolean') fail('template.template_locked must be boolean')
    if (template.template_locked === true && template.catalog_route !== null) {
      fail('template.catalog_route must be null when template.template_locked is true')
    }
    if (
      template.template_locked === true &&
      template.requested_template_id !== null &&
      template.requested_template_id !== template.resolved_template_id
    ) {
      fail('locked template requested_template_id must equal resolved_template_id')
    }
    if (template.catalog_route !== null) {
      if (!isPlainObject(template.catalog_route)) fail('template.catalog_route must be object or null')
      else {
        if (typeof template.catalog_route.key !== 'string' || !template.catalog_route.key) fail('template.catalog_route.key is required')
        if (!Number.isInteger(template.catalog_route.priority)) fail('template.catalog_route.priority must be an integer')
      }
    }
  }

  const artifacts = provenance.artifacts
  if (!isPlainObject(artifacts)) fail('artifacts must be an object')
  else {
    for (const key of ['source_hash', 'rule_hash', 'template_hash', 'map_hash']) {
      const value = artifacts[key]
      if (provenance.mode === 'legacy_inferred' && value === null) {
        warnings.push(`artifacts.${key} is unknown for legacy provenance`)
      } else if (!HASH_PATTERN.test(value || '')) {
        fail(`artifacts.${key} must match sha256:<64 lowercase hex>`)
      }
    }
    for (const key of ['registry_hash', 'routing_hash', 'template_pair_hash']) {
      if (artifacts[key] !== undefined && !HASH_PATTERN.test(artifacts[key] || '')) {
        fail(`artifacts.${key} must match sha256:<64 lowercase hex>`)
      }
    }
  }

  const baseline = provenance.baseline
  if (!isPlainObject(baseline)) fail('baseline must be an object')
  else {
    for (const kind of ['text', 'layout']) {
      const hashKey = `${kind}_hashes`
      const snapshotKey = `${kind}_snapshots`
      if (!isPlainObject(baseline[hashKey])) fail(`baseline.${hashKey} must be an object`)
      else {
        for (const [target, hash] of Object.entries(baseline[hashKey])) {
          if (!target) fail(`baseline.${hashKey} contains an empty target`)
          if (!HASH_PATTERN.test(hash || '')) fail(`baseline.${hashKey}.${target} must match sha256:<64 lowercase hex>`)
        }
      }
      if (baseline[snapshotKey] === undefined) {
        warnings.push(`baseline.${snapshotKey} is missing; baseline values cannot be displayed`)
      } else if (!isPlainObject(baseline[snapshotKey])) {
        fail(`baseline.${snapshotKey} must be an object`)
      } else if (isPlainObject(baseline[hashKey])) {
        for (const [target, snapshot] of Object.entries(baseline[snapshotKey])) {
          if (!target) {
            fail(`baseline.${snapshotKey} contains an empty target`)
            continue
          }
          if (!Object.prototype.hasOwnProperty.call(baseline[hashKey], target)) {
            fail(`baseline.${snapshotKey}.${target} has no matching hash`)
          } else if (hashJson(snapshot) !== baseline[hashKey][target]) {
            fail(`baseline.${snapshotKey}.${target} does not match baseline.${hashKey}.${target}`)
          }
        }
        for (const target of Object.keys(baseline[hashKey])) {
          if (!Object.prototype.hasOwnProperty.call(baseline[snapshotKey], target)) {
            warnings.push(`baseline.${snapshotKey}.${target} is missing; baseline value cannot be displayed`)
          }
        }
      }
    }
  }

  const refinement = provenance.refinement
  if (refinement !== undefined) {
    if (!isPlainObject(refinement)) fail('refinement must be an object')
    else {
      const originArtifacts = refinement.origin_artifacts
      const desiredArtifacts = refinement.desired_artifacts
      for (const [label, artifactSnapshot] of [
        ['origin_artifacts', originArtifacts],
        ['desired_artifacts', desiredArtifacts]
      ]) {
        if (!isPlainObject(artifactSnapshot)) fail(`refinement.${label} must be an object`)
        else {
          for (const key of ['source_hash', 'rule_hash', 'template_hash', 'map_hash']) {
            if (!HASH_PATTERN.test(artifactSnapshot[key] || '')) {
              fail(`refinement.${label}.${key} must match sha256:<64 lowercase hex>`)
            }
          }
        }
      }

      const targetSets = {}
      for (const group of ['applied_targets', 'conflict_targets']) {
        if (!isPlainObject(refinement[group])) fail(`refinement.${group} must be an object`)
        else {
          targetSets[group] = {}
          for (const kind of ['text', 'layout']) {
            const list = refinement[group][kind]
            if (!Array.isArray(list)) fail(`refinement.${group}.${kind} must be an array`)
            else {
              if (list.some((target) => typeof target !== 'string' || !target)) {
                fail(`refinement.${group}.${kind} must contain non-empty strings`)
              }
              if (new Set(list).size !== list.length) fail(`refinement.${group}.${kind} must not contain duplicates`)
              targetSets[group][kind] = new Set(list)
            }
          }
        }
      }
      for (const kind of ['text', 'layout']) {
        const applied = targetSets.applied_targets?.[kind]
        const conflicts = targetSets.conflict_targets?.[kind]
        if (applied && conflicts && [...applied].some((target) => conflicts.has(target))) {
          fail(`refinement ${kind} target cannot be both applied and conflicted`)
        }
      }

      if (!HASH_PATTERN.test(refinement.current_state_hash || '')) {
        fail('refinement.current_state_hash must match sha256:<64 lowercase hex>')
      }
      for (const key of ['complete_application', 'readback_verified', 'origin_artifacts_promoted']) {
        if (typeof refinement[key] !== 'boolean') fail(`refinement.${key} must be boolean`)
      }
      const hasConflicts = ['text', 'layout'].some(
        (kind) => (refinement.conflict_targets?.[kind] || []).length > 0
      )
      if (refinement.readback_verified !== true) {
        fail('persisted refinement requires readback_verified=true')
      }
      if (refinement.complete_application === true) {
        if (hasConflicts) fail('complete refinement requires empty conflict_targets')
        if (refinement.origin_artifacts_promoted !== true) {
          fail('complete refinement requires origin_artifacts_promoted=true')
        }
        if (isPlainObject(artifacts) && isPlainObject(desiredArtifacts)) {
          for (const key of ['source_hash', 'rule_hash', 'template_hash', 'map_hash']) {
            if (artifacts[key] !== desiredArtifacts[key]) {
              fail(`complete refinement artifacts.${key} must equal refinement.desired_artifacts.${key}`)
            }
          }
        }
      } else if (refinement.complete_application === false) {
        if (refinement.origin_artifacts_promoted !== false) {
          fail('partial refinement requires origin_artifacts_promoted=false')
        }
        if (isPlainObject(artifacts) && isPlainObject(originArtifacts)) {
          for (const key of ['source_hash', 'rule_hash', 'template_hash', 'map_hash']) {
            if (artifacts[key] !== originArtifacts[key]) {
              fail(`partial refinement artifacts.${key} must equal refinement.origin_artifacts.${key}`)
            }
          }
        }
      }
    }
  }

  if (provenance.mode === 'legacy_inferred') {
    const inference = provenance.inference
    if (!isPlainObject(inference)) fail('inference is required for legacy_inferred provenance')
    else {
      if (!['high', 'medium', 'low'].includes(inference.confidence)) fail('inference.confidence is invalid')
      if (!Array.isArray(inference.evidence) || !inference.evidence.length) fail('inference.evidence must be non-empty')
      else inference.evidence.forEach((item, index) =>
        validateInferenceEvidenceItem(item, `inference.evidence[${index}]`, fail)
      )
      if (inference.confidence_reasons !== undefined) {
        if (!Array.isArray(inference.confidence_reasons) || !inference.confidence_reasons.length) {
          fail('inference.confidence_reasons must be a non-empty array when provided')
        } else if (inference.confidence_reasons.some((reason) => typeof reason !== 'string' || !reason.trim())) {
          fail('inference.confidence_reasons must contain non-empty strings')
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

function parseJsonString(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function blockIdentifier(block) {
  return block?.uuid !== undefined && block?.uuid !== null
    ? String(block.uuid)
    : block?.id !== undefined && block?.id !== null
      ? String(block.id)
      : null
}

function collectCandidates(value, candidates, context = {}) {
  const parsed = parseJsonString(value)
  if (!isPlainObject(parsed)) return

  if (parsed.schema_version !== undefined && parsed.mode !== undefined && parsed.source) {
    candidates.push({ block_id: context.blockId || null, provenance: parsed })
    return
  }
  if (isPlainObject(parsed.ai_provenance)) {
    candidates.push({ block_id: context.blockId || null, provenance: parsed.ai_provenance })
  }
  if (isPlainObject(parsed.provenance)) collectCandidates(parsed.provenance, candidates, context)

  if (parsed.template_data_content !== undefined) {
    const content = parseJsonString(parsed.template_data_content)
    if (isPlainObject(content?.ai_provenance)) {
      candidates.push({ block_id: blockIdentifier(parsed) || context.blockId || null, provenance: content.ai_provenance })
    }
  }

  if (Array.isArray(parsed.blocks)) {
    for (const block of parsed.blocks) collectCandidates(block, candidates, { blockId: blockIdentifier(block) })
  }
  if (parsed.exported_slide !== undefined) collectCandidates(parsed.exported_slide, candidates, context)
  if (parsed.data !== undefined) collectCandidates(parsed.data, candidates, context)
  if (isPlainObject(parsed.editor_update_block?.arguments?.patch?.ai_provenance)) {
    collectCandidates(parsed.editor_update_block.arguments.patch.ai_provenance, candidates, {
      blockId: parsed.editor_update_block.arguments.blockId || context.blockId
    })
  }
  if (Array.isArray(parsed.content)) {
    for (const item of parsed.content) {
      if (item?.type === 'text' && typeof item.text === 'string') collectCandidates(item.text, candidates, context)
    }
  }
}

/** Extract provenance from a direct object, a complete block, editor_export_slide, or MCP text wrapper. */
export function extractProvenance(input, options = {}) {
  const candidates = []
  collectCandidates(input, candidates)
  const deduped = candidates.filter((candidate, index) =>
    candidates.findIndex((other) => other.block_id === candidate.block_id && other.provenance === candidate.provenance) === index
  )
  if (options.blockId !== undefined && options.blockId !== null) {
    return deduped.filter((candidate) => String(candidate.block_id) === String(options.blockId))
  }
  return deduped
}

export function validateInput(input, options = {}) {
  const candidates = extractProvenance(input, options)
  if (!candidates.length) {
    return { valid: false, results: [], errors: ['no ai_provenance found in input'] }
  }
  const results = candidates.map(({ block_id, provenance }) => ({
    block_id,
    ...validateProvenance(provenance)
  }))
  return {
    valid: results.every((result) => result.valid),
    results,
    errors: results.flatMap((result) => result.errors.map((error) => `${result.block_id || 'direct'}: ${error}`))
  }
}

function snapshotState(record, key) {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    return { present: false, hash: null, value: null, value_available: true }
  }
  const value = record[key]
  if (isPlainObject(value) && Object.keys(value).length === 1 && value.$delete === true) {
    return { present: false, hash: null, value: null, value_available: true }
  }
  return { present: true, hash: hashJson(value), value, value_available: true }
}

function baselineState(hashes, snapshots, key) {
  if (!Object.prototype.hasOwnProperty.call(hashes, key)) {
    return { present: false, hash: null, value: null, value_available: true }
  }
  const valueAvailable = isPlainObject(snapshots) && Object.prototype.hasOwnProperty.call(snapshots, key)
  return {
    present: true,
    hash: hashes[key],
    value: valueAvailable ? snapshots[key] : null,
    value_available: valueAvailable
  }
}

function statesEqual(left, right) {
  return left.present === right.present && (!left.present || left.hash === right.hash)
}

function planKind(kind, baselineHashes, baselineSnapshots, current, desired, warnings) {
  requireObject(current, `current.${kind}`)
  requireObject(desired, `desired.${kind}`)
  const changes = []
  for (const target of Object.keys(desired).sort()) {
    const baseline = baselineState(baselineHashes, baselineSnapshots, target)
    const currentState = snapshotState(current, target)
    const desiredState = snapshotState(desired, target)
    let classification
    let reason
    if (statesEqual(currentState, desiredState)) {
      classification = 'noop'
      reason = 'current_already_matches_desired'
    } else if (statesEqual(desiredState, baseline)) {
      classification = 'noop'
      reason = 'desired_did_not_change_from_baseline'
    } else if (statesEqual(currentState, baseline)) {
      classification = 'safe'
      reason = 'current_matches_baseline'
    } else {
      classification = 'conflict'
      reason = 'current_and_desired_diverged_from_baseline'
    }
    const change = {
      target,
      classification,
      reason,
      baseline_hash: baseline.hash,
      current_hash: currentState.hash,
      desired_hash: desiredState.hash,
      baseline_present: baseline.present,
      current_present: currentState.present,
      desired_present: desiredState.present,
      baseline_value: baseline.value,
      current_value: currentState.value,
      desired_value: desiredState.value,
      baseline_value_available: baseline.value_available,
      operation: desiredState.present ? 'set' : 'delete'
    }
    if (classification === 'conflict' && !baseline.value_available) {
      change.value_displayable = false
      warnings.push(`${kind}.${target}: baseline snapshot is missing; conflict baseline value cannot be displayed`)
    } else if (classification === 'conflict') {
      change.value_displayable = true
    }
    if (classification === 'safe' && desiredState.present) change.value = desiredState.value
    changes.push(change)
  }
  return changes
}

/**
 * Plan a three-way update. Input carries one provenance-bearing block/export plus
 * current and desired {text, layout} maps. The function never mutates editor data.
 */
export function planUpdate(input, options = {}) {
  requireObject(input, 'plan-update input')
  const blockId = options.blockId ?? input.block_id
  const candidates = extractProvenance(input, { blockId })
  if (!candidates.length) throw new Error('no ai_provenance found for plan-update')
  if (candidates.length !== 1) throw new Error('plan-update requires exactly one provenance record; pass --block-id')
  const candidate = candidates[0]
  const validation = validateProvenance(candidate.provenance)
  if (!validation.valid) throw new Error(`invalid ai_provenance: ${validation.errors.join('; ')}`)

  const current = requireObject(input.current, 'current')
  const desired = requireObject(input.desired, 'desired')
  const warnings = []
  const text = planKind(
    'text',
    candidate.provenance.baseline.text_hashes,
    candidate.provenance.baseline.text_snapshots,
    current.text || {},
    desired.text || {},
    warnings
  )
  const layout = planKind(
    'layout',
    candidate.provenance.baseline.layout_hashes,
    candidate.provenance.baseline.layout_snapshots,
    current.layout || {},
    desired.layout || {},
    warnings
  )
  const changes = [...text, ...layout]
  const summary = { safe: 0, noop: 0, conflict: 0 }
  for (const change of changes) summary[change.classification] += 1

  return {
    block_id: candidate.block_id,
    summary,
    warnings,
    current_state_hash: hashJson({
      text: current.text || {},
      layout: current.layout || {}
    }),
    text,
    layout,
    safe_changes: {
      text: text.filter((change) => change.classification === 'safe').map(({ target, operation, value }) => ({ target, operation, ...(operation === 'set' ? { value } : {}) })),
      layout: layout.filter((change) => change.classification === 'safe').map(({ target, operation, value }) => ({ target, operation, ...(operation === 'set' ? { value } : {}) }))
    },
    conflicts: {
      text: text.filter((change) => change.classification === 'conflict'),
      layout: layout.filter((change) => change.classification === 'conflict')
    }
  }
}

function compactText(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim().toLowerCase().replace(/\s+/g, '')
  return text || null
}

function normalizeVolume(value) {
  const normalized = compactText(value)
  if (normalized === '上') return '上册'
  if (normalized === '下') return '下册'
  return normalized
}

function normalizeCatalogPath(value) {
  if (Array.isArray(value)) value = value.join('/')
  const normalized = compactText(value)
  return normalized ? normalized.replace(/[>＞\\]+/g, '/') : null
}

function normalizedIdentifier(value) {
  if (value === undefined || value === null || value === '') return null
  return String(value)
}

function viewLegacyRecord(record) {
  requireObject(record, 'legacy match record')
  const source = isPlainObject(record.source) ? record.source : record
  const template = isPlainObject(record.template) ? record.template : record
  const fingerprints = isPlainObject(record.fingerprints) ? record.fingerprints : record
  return {
    book_name: source.book_name ?? record.book_name,
    subject: source.subject ?? record.subject,
    grade: source.grade ?? source.grade_id ?? record.grade ?? record.grade_id,
    volume: source.volume ?? record.volume,
    catalog_path: source.catalog_path ?? record.catalog_path,
    catalog_name: source.catalog_name ?? record.catalog_name,
    catalog_sort: source.catalog_sort ?? record.catalog_sort,
    template_id: template.resolved_template_id ?? template.template_id ?? record.resolved_template_id ?? record.template_id,
    sample_block_id: template.sample_block_id ?? record.sample_block_id,
    source_ids: fingerprints.source_ids ?? fingerprints.source_id_fingerprint ?? record.source_ids,
    structure_fingerprint: fingerprints.structure_fingerprint ?? record.structure_fingerprint
  }
}

function addEvidence(evidence, rule, points, details = {}) {
  evidence.push({ rule, points, ...details })
  return points
}

function compareKnownDimension(query, candidate, key, weight, normalize = compactText) {
  const queryValue = normalize(query[key])
  const candidateValue = normalize(candidate[key])
  if (queryValue && candidateValue && queryValue !== candidateValue) {
    return {
      rejected: true,
      reason: `${key}_mismatch`,
      evidence: { rule: `${key}_mismatch`, points: 0, hard_reject: true, query: query[key], candidate: candidate[key] }
    }
  }
  if (queryValue && candidateValue) {
    return {
      rejected: false,
      points: weight,
      evidence: { rule: `${key}_exact`, points: weight, query: query[key], candidate: candidate[key] }
    }
  }
  return { rejected: false, points: 0, evidence: null }
}

function normalizeSourceFingerprint(value) {
  if (Array.isArray(value)) {
    return {
      type: 'set',
      value: new Set(value.map(normalizedIdentifier).filter(Boolean))
    }
  }
  const text = compactText(value)
  return text ? { type: 'hash', value: text } : null
}

function scoreSourceFingerprint(queryValue, candidateValue) {
  const query = normalizeSourceFingerprint(queryValue)
  const candidate = normalizeSourceFingerprint(candidateValue)
  if (!query || !candidate || query.type !== candidate.type) return null
  if (query.type === 'hash') {
    return query.value === candidate.value
      ? { ratio: 1, points: LEGACY_MATCH_WEIGHTS.source_id_fingerprint, detail: 'exact_hash' }
      : { ratio: 0, points: 0, detail: 'different_hash' }
  }
  const union = new Set([...query.value, ...candidate.value])
  if (!union.size) return null
  const intersection = [...query.value].filter((item) => candidate.value.has(item)).length
  const ratio = intersection / union.size
  return {
    ratio: Math.round(ratio * 10000) / 10000,
    points: Math.round(ratio * LEGACY_MATCH_WEIGHTS.source_id_fingerprint * 100) / 100,
    detail: intersection === union.size ? 'exact_set' : 'jaccard'
  }
}

function fingerprintsEqual(left, right) {
  if (left === undefined || left === null || right === undefined || right === null) return false
  if (isPlainObject(left) || Array.isArray(left) || isPlainObject(right) || Array.isArray(right)) {
    return hashJson(left) === hashJson(right)
  }
  return compactText(left) === compactText(right)
}

function coreMetadataCoverage(query, candidate) {
  const missing = []
  for (const [key, normalize] of [
    ['subject', compactText],
    ['grade', compactText],
    ['volume', normalizeVolume]
  ]) {
    if (!normalize(query[key])) missing.push(`query.${key}`)
    if (!normalize(candidate[key])) missing.push(`candidate.${key}`)
  }
  return { complete: missing.length === 0, missing }
}

function confidenceForScore(score, coverage) {
  if (score >= 75 && coverage.complete) {
    return {
      confidence: 'high',
      reasons: ['score_at_least_75', 'subject_grade_volume_known_and_equal']
    }
  }
  if (score >= 50) {
    return {
      confidence: 'medium',
      reasons: score >= 75
        ? [
            'score_at_least_75',
            `high_capped_missing_core_metadata:${coverage.missing.join(',')}`
          ]
        : ['score_between_50_and_74']
    }
  }
  return { confidence: 'low', reasons: ['score_below_50'] }
}

/** Score legacy source candidates deterministically. This function never writes editor data. */
export function matchLegacyCandidates(input) {
  requireObject(input, 'match-legacy input')
  const query = viewLegacyRecord(requireObject(input.query, 'query'))
  if (!Array.isArray(input.candidates) || !input.candidates.length) {
    throw new Error('candidates must be a non-empty array')
  }

  const ids = new Set()
  const scored = input.candidates.map((rawCandidate, index) => {
    requireObject(rawCandidate, `candidates[${index}]`)
    const candidateId = normalizeIdentifier(
      rawCandidate.candidate_id ?? rawCandidate.id ?? `${rawCandidate.source?.book_id || ''}:${rawCandidate.source?.catalog_id || ''}:${index}`,
      `candidates[${index}].candidate_id`
    )
    if (ids.has(candidateId)) throw new Error(`duplicate candidate_id: ${candidateId}`)
    ids.add(candidateId)
    const candidate = viewLegacyRecord(rawCandidate)
    const coreCoverage = coreMetadataCoverage(query, candidate)
    const evidence = []
    const rejectionReasons = []
    let score = 0

    for (const [key, weight, normalize] of [
      ['subject', LEGACY_MATCH_WEIGHTS.subject, compactText],
      ['grade', LEGACY_MATCH_WEIGHTS.grade, compactText],
      ['volume', LEGACY_MATCH_WEIGHTS.volume, normalizeVolume]
    ]) {
      const result = compareKnownDimension(query, candidate, key, weight, normalize)
      if (result.evidence) evidence.push(result.evidence)
      if (result.rejected) rejectionReasons.push(result.reason)
      else score += result.points
    }

    if (rejectionReasons.length) {
      return {
        candidate_id: candidateId,
        eligible: false,
        score: 0,
        confidence: 'rejected',
        confidence_reasons: rejectionReasons.map((reason) => `hard_reject:${reason}`),
        core_metadata_complete: coreCoverage.complete,
        missing_core_metadata: coreCoverage.missing,
        evidence,
        rejection_reasons: rejectionReasons,
        is_top: false,
        is_unique_top: false
      }
    }

    const queryBook = compactText(query.book_name)
    const candidateBook = compactText(candidate.book_name)
    if (queryBook && candidateBook) {
      if (queryBook === candidateBook) {
        score += addEvidence(evidence, 'book_name_exact', LEGACY_MATCH_WEIGHTS.book_name_exact)
      } else if (queryBook.includes(candidateBook) || candidateBook.includes(queryBook)) {
        score += addEvidence(evidence, 'book_name_contains', LEGACY_MATCH_WEIGHTS.book_name_contains)
      }
    }

    const queryPath = normalizeCatalogPath(query.catalog_path)
    const candidatePath = normalizeCatalogPath(candidate.catalog_path)
    if (queryPath && candidatePath && queryPath === candidatePath) {
      score += addEvidence(evidence, 'catalog_path_exact', LEGACY_MATCH_WEIGHTS.catalog_path_exact)
    } else {
      const queryName = compactText(query.catalog_name)
      const candidateName = compactText(candidate.catalog_name)
      const querySort = normalizedIdentifier(query.catalog_sort)
      const candidateSort = normalizedIdentifier(candidate.catalog_sort)
      if (queryName && candidateName && queryName === candidateName && querySort && querySort === candidateSort) {
        score += addEvidence(evidence, 'catalog_name_sort_exact', LEGACY_MATCH_WEIGHTS.catalog_name_sort_exact)
      }
    }

    const queryTemplate = normalizedIdentifier(query.template_id)
    const candidateTemplate = normalizedIdentifier(candidate.template_id)
    if (queryTemplate && candidateTemplate && queryTemplate === candidateTemplate) {
      score += addEvidence(evidence, 'template_exact', LEGACY_MATCH_WEIGHTS.template_exact)
    }
    const querySample = normalizedIdentifier(query.sample_block_id)
    const candidateSample = normalizedIdentifier(candidate.sample_block_id)
    if (querySample && candidateSample && querySample === candidateSample) {
      score += addEvidence(evidence, 'sample_block_exact', LEGACY_MATCH_WEIGHTS.sample_block_exact)
    }

    const sourceFingerprint = scoreSourceFingerprint(query.source_ids, candidate.source_ids)
    if (sourceFingerprint && sourceFingerprint.points > 0) {
      score += addEvidence(
        evidence,
        'source_id_fingerprint',
        sourceFingerprint.points,
        { ratio: sourceFingerprint.ratio, match: sourceFingerprint.detail }
      )
    }
    if (fingerprintsEqual(query.structure_fingerprint, candidate.structure_fingerprint)) {
      score += addEvidence(evidence, 'structure_fingerprint_exact', LEGACY_MATCH_WEIGHTS.structure_fingerprint_exact)
    }

    score = Math.round(score * 100) / 100
    const confidence = confidenceForScore(score, coreCoverage)
    return {
      candidate_id: candidateId,
      eligible: true,
      score,
      confidence: confidence.confidence,
      confidence_reasons: confidence.reasons,
      core_metadata_complete: coreCoverage.complete,
      missing_core_metadata: coreCoverage.missing,
      evidence,
      rejection_reasons: [],
      is_top: false,
      is_unique_top: false
    }
  })

  scored.sort((left, right) => {
    if (left.eligible !== right.eligible) return left.eligible ? -1 : 1
    if (left.score !== right.score) return right.score - left.score
    return left.candidate_id.localeCompare(right.candidate_id)
  })
  const eligible = scored.filter((candidate) => candidate.eligible)
  const topScore = eligible.length ? eligible[0].score : null
  const topCandidates = eligible.filter((candidate) => candidate.score === topScore)
  const uniqueTop = topCandidates.length === 1
  for (const candidate of scored) {
    candidate.is_top = candidate.eligible && candidate.score === topScore
    candidate.is_unique_top = candidate.is_top && uniqueTop
  }

  return {
    scoring_version: 1,
    weights: { ...LEGACY_MATCH_WEIGHTS },
    confidence_thresholds: { high_min: 75, medium_min: 50 },
    top_candidate_id: uniqueTop ? topCandidates[0].candidate_id : null,
    top_score: topScore,
    unique: uniqueTop,
    requires_human_confirmation: true,
    automatic_write: false,
    candidates: scored
  }
}

function usage() {
  return [
    'Usage:',
    '  node provenance-tools.mjs create --input <spec.json|-> [--block-id <id>] [--out <result.json>]',
    '  node provenance-tools.mjs validate --input <block-or-export.json|-> [--block-id <id>] [--out <result.json>]',
    '  node provenance-tools.mjs plan-update --input <request.json|-> [--block-id <id>] [--out <plan.json>]',
    '  node provenance-tools.mjs match-legacy --input <query-and-candidates.json|-> [--out <scores.json>]',
    '',
    'Use - as --input to read JSON from stdin.'
  ].join('\n')
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const args = {
    command,
    help: command === '--help' || command === '-h'
  }
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index]
    if (key === '--help' || key === '-h') args.help = true
    else if (key.startsWith('--')) {
      const value = rest[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${key}`)
      args[key.slice(2)] = value
      index += 1
    } else throw new Error(`unknown argument: ${key}`)
  }
  return args
}

function readInput(filename) {
  const text = filename === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(filename), 'utf8')
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`cannot parse input JSON: ${error.message}`)
  }
}

function writeOutput(value, filename) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (filename) fs.writeFileSync(path.resolve(filename), text, 'utf8')
  else process.stdout.write(text)
}

export function runCli(argv) {
  const args = parseArgs(argv)
  if (args.help) return { help: true, text: usage() }
  if (!['create', 'validate', 'plan-update', 'match-legacy'].includes(args.command)) throw new Error(usage())
  if (!args.input) throw new Error(`--input is required\n${usage()}`)
  if (args.command === 'match-legacy' && args['block-id'] !== undefined) {
    throw new Error('match-legacy does not accept --block-id')
  }
  const input = readInput(args.input)
  const options = { blockId: args['block-id'] }
  if (args.command === 'create') return { value: createProvenance(input, options), out: args.out }
  if (args.command === 'validate') return { value: validateInput(input, options), out: args.out }
  if (args.command === 'plan-update') return { value: planUpdate(input, options), out: args.out }
  return { value: matchLegacyCandidates(input), out: args.out }
}

function main() {
  try {
    const result = runCli(process.argv.slice(2))
    if (result.help) process.stdout.write(`${result.text}\n`)
    else {
      writeOutput(result.value, result.out)
      if (process.argv[2] === 'validate' && !result.value.valid) process.exitCode = 1
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
