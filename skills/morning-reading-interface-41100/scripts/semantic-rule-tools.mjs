#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const RULE_PACK_SCHEMA_VERSION = 1
export const RULE_PACK_STATUSES = new Set(['draft', 'trial_approved', 'validated', 'deprecated'])
export const FEEDBACK_TYPES = new Set([
  'instance_fix',
  'rule_refinement',
  'new_variant',
  'acceptance_refinement'
])
export const STYLE_POLICIES = new Set(['preserve_target', 'copy_source_rich_text', 'hybrid', 'none'])
export const MODULE_POLICIES = new Set(['reuse_model_relation', 'clone_if_supported', 'none'])
export const MISSING_POLICIES = new Set(['stop', 'needs_review', 'skip', 'keep_target'])
export const AMBIGUITY_POLICIES = new Set(['stop', 'needs_review', 'skip'])
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/
const CAPABILITY_PATTERN = /^[a-z][a-z0-9_.:-]*$/
const ANCHOR_KIND_PATTERN = /^[a-z][a-z0-9_-]*$/
const SELECTOR_EVIDENCE_CLASSES = new Set(['semantic', 'structure'])
const FORBIDDEN_ID_ANCHOR_KINDS = new Set(['element_id', 'runtime_element_id', 'block_id', 'runtime_block_id', 'slot_id'])
const DEFAULT_ARTIFACT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'references')
const FORWARD_EVIDENCE_SCHEMA_VERSION = 1

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function canonicalize(value) {
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

/** Hash any JSON-compatible snapshot, including editor_get_template output. */
export function hashJson(value) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`
}

export function hashCapabilitySnapshot(capabilities, catalogHash = readDefaultCatalogHash()) {
  return hashJson({ catalog_hash: catalogHash, capabilities: [...capabilities].sort() })
}

function readDefaultCatalogHash() {
  const catalog = JSON.parse(fs.readFileSync(path.join(DEFAULT_ARTIFACT_ROOT, 'super-editor-capability-catalog.json'), 'utf8'))
  return catalog.catalog_hash
}

function nonEmptyString(value) {
  return typeof value === 'string' && Boolean(value.trim())
}

function validatePackId(value, label, errors) {
  if (!nonEmptyString(value) || !PACK_ID_PATTERN.test(value)) {
    errors.push(`${label} must match ${PACK_ID_PATTERN}`)
    return false
  }
  return true
}

function validateCapabilityList(value, label, errors, { collect } = {}) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must contain at least one capability`)
    return
  }
  const seen = new Set()
  for (const [index, capability] of value.entries()) {
    if (!nonEmptyString(capability) || !CAPABILITY_PATTERN.test(capability)) {
      errors.push(`${label}[${index}] must be a capability name matching ${CAPABILITY_PATTERN}`)
      continue
    }
    if (seen.has(capability)) errors.push(`${label} contains duplicate capability: ${capability}`)
    seen.add(capability)
    collect?.add(capability)
  }
}

function isIdFingerprintKind(kind) {
  return typeof kind === 'string' && (
    /(^|_)(?:id|ids)(?:_|$)/.test(kind) ||
    /(?:source|template|element|block|slot|node)_?(?:id|key|name)$/.test(kind) ||
    /^(?:slot|slot_name|source_id|template_source_id)$/.test(kind)
  )
}

function containsIdOrSlotSpoof(value) {
  if (typeof value !== 'string') return false
  return (
    /(^|[^a-z0-9])(?:slot|slot_id|element_id|block_id|node_id|source_id|template_id|runtime_id|identifier)(?:[^a-z0-9]|$)/i.test(value) ||
    /(?:插槽|槽位|元素\s*ID|区块\s*ID|节点\s*ID|运行时\s*ID)/i.test(value)
  )
}

function isIdentifierOnlyEvidence(value) {
  if (typeof value === 'number') return true
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return true
    return (
      /^\d+$/.test(text) ||
      /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(text) ||
      /^[a-z][a-z0-9_.:-]*$/i.test(text) ||
      /(?:插槽|槽位)/.test(text) ||
      /^(?:slot|element|block|source|template|node|id)[\s:_#-]*[a-z0-9_.:-]+$/i.test(text) ||
      /^(?:插槽|槽位|元素|区块)[\s:_#-]*[a-z0-9_.:-]+$/i.test(text)
    )
  }
  if (Array.isArray(value)) return value.length === 0 || value.every(isIdentifierOnlyEvidence)
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
    return entries.length === 0 || entries.every(([key, item]) => isIdFingerprintKind(key) || isIdentifierOnlyEvidence(item))
  }
  return value === null || value === undefined
}

function pushUnknownFields(value, allowed, label, errors) {
  if (!isPlainObject(value)) return
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) errors.push(`${label} has unknown fields: ${unknown.join(', ')}`)
}

function validateHash(value, label, errors, { nullable = true } = {}) {
  if (value === null || value === undefined) {
    if (!nullable) errors.push(`${label} is required`)
    return
  }
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    errors.push(`${label} must match sha256:<64 lowercase hex>`)
  }
}

function validateCardinality(value, label, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`)
    return
  }
  pushUnknownFields(value, new Set(['min', 'max']), label, errors)
  if (!Number.isInteger(value.min) || value.min < 0) errors.push(`${label}.min must be a non-negative integer`)
  if (value.max !== null && (!Number.isInteger(value.max) || value.max < 0)) {
    errors.push(`${label}.max must be null or a non-negative integer`)
  }
  if (Number.isInteger(value.min) && Number.isInteger(value.max) && value.max < value.min) {
    errors.push(`${label}.max cannot be smaller than min`)
  }
}

function validateAnchors(value, label, errors, warnings) {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`)
    return
  }
  for (const [index, anchor] of value.entries()) {
    const anchorLabel = `${label}[${index}]`
    if (!isPlainObject(anchor)) {
      errors.push(`${anchorLabel} must be an object`)
      continue
    }
    pushUnknownFields(anchor, new Set(['kind', 'value', 'optional', 'intent']), anchorLabel, errors)
    if (!nonEmptyString(anchor.kind) || !ANCHOR_KIND_PATTERN.test(anchor.kind)) {
      errors.push(`${anchorLabel}.kind must match ${ANCHOR_KIND_PATTERN}`)
    }
    if (!Object.hasOwn(anchor, 'value')) errors.push(`${anchorLabel}.value is required`)
    if (FORBIDDEN_ID_ANCHOR_KINDS.has(anchor.kind)) {
      errors.push(`${anchorLabel}.kind cannot use a runtime-only ID (${anchor.kind})`)
    }
    if (isIdFingerprintKind(anchor.kind)) {
      if (anchor.optional !== true) errors.push(`${anchorLabel} is an ID/slot fingerprint and must set optional=true`)
      if (!nonEmptyString(anchor.intent)) errors.push(`${anchorLabel}.intent is required for an auxiliary ID/slot fingerprint`)
    }
  }
}

function validateSelectorEvidence(value, label, errors) {
  if (!Array.isArray(value) || value.length < 2) {
    errors.push(`${label} must contain at least two auditable semantic/structure evidence items`)
    return
  }
  const classes = new Set()
  for (const [index, evidence] of value.entries()) {
    const evidenceLabel = `${label}[${index}]`
    if (!isPlainObject(evidence)) {
      errors.push(`${evidenceLabel} must be an object`)
      continue
    }
    pushUnknownFields(evidence, new Set(['class', 'kind', 'claim', 'observation']), evidenceLabel, errors)
    if (!SELECTOR_EVIDENCE_CLASSES.has(evidence.class)) {
      errors.push(`${evidenceLabel}.class must be semantic or structure`)
    } else {
      classes.add(evidence.class)
    }
    if (!nonEmptyString(evidence.kind) || !ANCHOR_KIND_PATTERN.test(evidence.kind)) {
      errors.push(`${evidenceLabel}.kind must match ${ANCHOR_KIND_PATTERN}`)
    } else if (isIdFingerprintKind(evidence.kind) || containsIdOrSlotSpoof(evidence.kind)) {
      errors.push(`${evidenceLabel}.kind cannot use an ID or fixed-slot fingerprint`)
    }
    for (const field of ['claim', 'observation']) {
      if (!nonEmptyString(evidence[field])) errors.push(`${evidenceLabel}.${field} is required`)
      else if (containsIdOrSlotSpoof(evidence[field]) || isIdentifierOnlyEvidence(evidence[field])) {
        errors.push(`${evidenceLabel}.${field} cannot be a fixed slot or identifier disguise`)
      }
    }
  }
  for (const evidenceClass of SELECTOR_EVIDENCE_CLASSES) {
    if (!classes.has(evidenceClass)) errors.push(`${label} must include ${evidenceClass} evidence`)
  }
}

function validateOptionalFingerprints(value, label, errors) {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`)
    return
  }
  for (const [index, fingerprint] of value.entries()) {
    const fingerprintLabel = `${label}[${index}]`
    if (!isPlainObject(fingerprint)) {
      errors.push(`${fingerprintLabel} must be an object`)
      continue
    }
    pushUnknownFields(fingerprint, new Set(['kind', 'value', 'intent']), fingerprintLabel, errors)
    if (!nonEmptyString(fingerprint.kind) || !ANCHOR_KIND_PATTERN.test(fingerprint.kind) || !isIdFingerprintKind(fingerprint.kind)) {
      errors.push(`${fingerprintLabel}.kind must explicitly name an ID/key fingerprint`)
    }
    if (!Object.hasOwn(fingerprint, 'value') || !['string', 'number'].includes(typeof fingerprint.value)) {
      errors.push(`${fingerprintLabel}.value must be a string or number`)
    }
    if (!nonEmptyString(fingerprint.intent)) errors.push(`${fingerprintLabel}.intent is required`)
  }
}

function validateSelector(value, label, errors, warnings) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`)
    return
  }
  pushUnknownFields(value, new Set(['role', 'cardinality', 'evidence', 'optional_fingerprints', 'include', 'exclude']), label, errors)
  if (!nonEmptyString(value.role)) errors.push(`${label}.role is required`)
  else if (isIdentifierOnlyEvidence(value.role) || containsIdOrSlotSpoof(value.role)) errors.push(`${label}.role cannot be a fixed slot or identifier disguise`)
  validateCardinality(value.cardinality, `${label}.cardinality`, errors)
  validateSelectorEvidence(value.evidence, `${label}.evidence`, errors)
  validateOptionalFingerprints(value.optional_fingerprints, `${label}.optional_fingerprints`, errors)
  for (const field of ['include', 'exclude']) {
    if (value[field] !== undefined && !nonEmptyString(value[field])) errors.push(`${label}.${field} must be a non-empty string`)
  }
}

function validateValidation(value, label, errors, requiredCapabilities) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`)
    return
  }
  pushUnknownFields(value, new Set(['id', 'intent', 'severity', 'required_capabilities']), label, errors)
  validatePackId(value.id, `${label}.id`, errors)
  if (!nonEmptyString(value.intent)) errors.push(`${label}.intent is required`)
  if (!['error', 'warning'].includes(value.severity)) errors.push(`${label}.severity must be error or warning`)
  validateCapabilityList(value.required_capabilities, `${label}.required_capabilities`, errors, { collect: requiredCapabilities })
}

function validateAction(value, label, errors, requiredCapabilities, depth = 0) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`)
    return
  }
  if (depth > 8) {
    errors.push(`${label} exceeds the maximum atomic sequence depth`)
    return
  }
  pushUnknownFields(value, new Set([
    'type', 'intent', 'required_capabilities', 'content_policy', 'style_policy', 'module_policy',
    'selection_policy', 'layout_policy', 'parameters', 'steps'
  ]), label, errors)
  if (!nonEmptyString(value.type)) errors.push(`${label}.type is required`)
  if (!nonEmptyString(value.intent)) errors.push(`${label}.intent is required`)
  validateCapabilityList(value.required_capabilities, `${label}.required_capabilities`, errors, { collect: requiredCapabilities })
  if (value.style_policy !== undefined && !STYLE_POLICIES.has(value.style_policy)) {
    errors.push(`${label}.style_policy is invalid`)
  }
  if (value.module_policy !== undefined && !MODULE_POLICIES.has(value.module_policy)) {
    errors.push(`${label}.module_policy is invalid`)
  }
  if (value.parameters !== undefined && !isPlainObject(value.parameters)) errors.push(`${label}.parameters must be an object`)
  for (const field of ['content_policy', 'selection_policy', 'layout_policy']) {
    if (value[field] !== undefined && !nonEmptyString(value[field])) errors.push(`${label}.${field} must be a non-empty string`)
  }
  if (value.type === 'atomic_sequence') {
    if (!Array.isArray(value.steps) || value.steps.length === 0) {
      errors.push(`${label}.steps must contain actions for atomic_sequence`)
    } else {
      value.steps.forEach((step, index) => validateAction(step, `${label}.steps[${index}]`, errors, requiredCapabilities, depth + 1))
    }
  } else if (value.steps !== undefined) {
    errors.push(`${label}.steps is only valid for atomic_sequence`)
  }
}

function validateApplicability(value, label, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`)
    return
  }
  pushUnknownFields(value, new Set(['intent', 'include', 'exclude']), label, errors)
  if (!nonEmptyString(value.intent)) errors.push(`${label}.intent is required`)
  if (value.include !== undefined && !isPlainObject(value.include)) errors.push(`${label}.include must be an object`)
  if (value.exclude !== undefined && !isPlainObject(value.exclude)) errors.push(`${label}.exclude must be an object`)
}

function validateTemplate(value, label, errors, warnings, { variant = false } = {}) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`)
    return
  }
  const allowed = ['template_id', 'intent', 'snapshot_hash', 'anchors']
  if (variant) allowed.push('id', 'priority', 'when')
  pushUnknownFields(value, new Set(allowed), label, errors)
  if (value.template_id === undefined || value.template_id === null || value.template_id === '') {
    errors.push(`${label}.template_id is required`)
  }
  if (!nonEmptyString(value.intent)) errors.push(`${label}.intent is required`)
  validateHash(value.snapshot_hash, `${label}.snapshot_hash`, errors)
  validateAnchors(value.anchors, `${label}.anchors`, errors, warnings)
  if (variant) {
    if (!nonEmptyString(value.id)) errors.push(`${label}.id is required`)
    if (!Number.isInteger(value.priority)) errors.push(`${label}.priority must be an integer`)
    if (!nonEmptyString(value.when)) errors.push(`${label}.when is required`)
  }
}

function validateAcceptanceResult(value, label, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`)
    return
  }
  pushUnknownFields(value, new Set(['check_id', 'status', 'evidence']), label, errors)
  validatePackId(value.check_id, `${label}.check_id`, errors)
  if (!['passed', 'failed', 'needs_review'].includes(value.status)) errors.push(`${label}.status is invalid`)
  if (!Array.isArray(value.evidence) || value.evidence.length === 0 || value.evidence.some((item) => !nonEmptyString(item))) {
    errors.push(`${label}.evidence must contain at least one non-empty item`)
  }
}

function hashFileBytes(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
}

function resolveConfinedJson(reference, baseDirectory, artifactRoot, label, errors) {
  if (!nonEmptyString(reference) || path.extname(reference).toLowerCase() !== '.json' || path.isAbsolute(reference)) {
    errors.push(`${label} must be a relative JSON artifact path`)
    return null
  }
  const root = path.resolve(artifactRoot)
  const filename = path.resolve(baseDirectory, reference)
  const relative = path.relative(root, filename)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    errors.push(`${label} must stay inside the rule-pack/skill artifact root`)
    return null
  }
  try {
    const stat = fs.lstatSync(filename)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular non-symlink file')
    const realRoot = fs.realpathSync(root)
    const realFilename = fs.realpathSync(filename)
    const realRelative = path.relative(realRoot, realFilename)
    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      throw new Error('resolved path escapes the artifact root')
    }
    const bytes = fs.readFileSync(realFilename)
    return {
      filename: realFilename,
      directory: path.dirname(realFilename),
      artifact_sha256: hashFileBytes(bytes),
      value: JSON.parse(bytes.toString('utf8'))
    }
  } catch (error) {
    errors.push(`${label} cannot be read as a safe JSON artifact: ${error.message}`)
    return null
  }
}

function collectNamedValues(value, keys, result = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectNamedValues(item, keys, result))
  } else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (keys.has(key)) result.push(item)
      collectNamedValues(item, keys, result)
    }
  }
  return result
}

function validateCatalogArtifact(snapshot, label, errors, artifactRoot) {
  const availableCapabilities = new Set()
  pushUnknownFields(snapshot, new Set([
    'catalog_path', 'catalog_hash', 'snapshot_hash', 'capabilities', 'evidence'
  ]), label, errors)
  if (!nonEmptyString(snapshot.catalog_path)) errors.push(`${label}.catalog_path is required`)
  validateHash(snapshot.catalog_hash, `${label}.catalog_hash`, errors, { nullable: false })
  validateHash(snapshot.snapshot_hash, `${label}.snapshot_hash`, errors, { nullable: false })
  validateCapabilityList(snapshot.capabilities, `${label}.capabilities`, errors, { collect: availableCapabilities })
  if (!Array.isArray(snapshot.evidence) || snapshot.evidence.length === 0 || snapshot.evidence.some((item) => !nonEmptyString(item))) {
    errors.push(`${label}.evidence must contain at least one non-empty item`)
  }
  const loaded = resolveConfinedJson(snapshot.catalog_path, artifactRoot, artifactRoot, `${label}.catalog_path`, errors)
  if (!loaded || !isPlainObject(loaded.value)) return { availableCapabilities, catalog: null }
  const catalog = loaded.value
  pushUnknownFields(catalog, new Set(['schema_version', 'plugin', 'source', 'tools', 'catalog_hash']), `${label} catalog`, errors)
  if (catalog.schema_version !== 1) errors.push(`${label} catalog.schema_version must be 1`)
  if (!isPlainObject(catalog.plugin)) errors.push(`${label} catalog.plugin must be an object`)
  else {
    pushUnknownFields(catalog.plugin, new Set(['name', 'version']), `${label} catalog.plugin`, errors)
    if (catalog.plugin.name !== 'super-editor-control') errors.push(`${label} catalog.plugin.name must be super-editor-control`)
    if (!nonEmptyString(catalog.plugin.version)) errors.push(`${label} catalog.plugin.version is required`)
  }
  if (!isPlainObject(catalog.source)) errors.push(`${label} catalog.source must be an object`)
  else {
    pushUnknownFields(catalog.source, new Set(['kind', 'method', 'entrypoint']), `${label} catalog.source`, errors)
    if (catalog.source.kind !== 'mcp_tools_list' || catalog.source.method !== 'tools/list') {
      errors.push(`${label} catalog must be generated from MCP tools/list`)
    }
    if (!nonEmptyString(catalog.source.entrypoint)) errors.push(`${label} catalog.source.entrypoint is required`)
  }
  const catalogCapabilities = new Set()
  validateCapabilityList(catalog.tools, `${label} catalog.tools`, errors, { collect: catalogCapabilities })
  if (Array.isArray(catalog.tools) && catalog.tools.join('\n') !== [...catalog.tools].sort().join('\n')) {
    errors.push(`${label} catalog.tools must be sorted canonically`)
  }
  validateHash(catalog.catalog_hash, `${label} catalog.catalog_hash`, errors, { nullable: false })
  const canonicalCatalog = { ...catalog }
  delete canonicalCatalog.catalog_hash
  const expectedCatalogHash = hashJson(canonicalCatalog)
  if (catalog.catalog_hash !== expectedCatalogHash) {
    errors.push(`${label} catalog.catalog_hash does not match the canonical catalog (${expectedCatalogHash})`)
  }
  if (snapshot.catalog_hash !== catalog.catalog_hash) {
    errors.push(`${label}.catalog_hash must equal the referenced catalog hash`)
  }
  for (const capability of availableCapabilities) {
    if (!catalogCapabilities.has(capability)) {
      errors.push(`${label}.capabilities contains a tool absent from the referenced catalog: ${capability}`)
    }
  }
  if (HASH_PATTERN.test(snapshot.catalog_hash || '') &&
      Array.isArray(snapshot.capabilities) && snapshot.capabilities.length === availableCapabilities.size) {
    const expectedSnapshotHash = hashCapabilitySnapshot(availableCapabilities, snapshot.catalog_hash)
    if (snapshot.snapshot_hash !== expectedSnapshotHash) {
      errors.push(`${label}.snapshot_hash must bind catalog_hash and the canonical capability subset (${expectedSnapshotHash})`)
    }
  }
  return { availableCapabilities, catalog }
}

function validateArtifactLink(value, label, errors, context, hashField, idField) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`)
    return null
  }
  const allowed = new Set(['artifact', 'artifact_sha256', hashField])
  if (idField) allowed.add(idField)
  pushUnknownFields(value, allowed, label, errors)
  if (!nonEmptyString(value.artifact)) errors.push(`${label}.artifact is required`)
  validateHash(value.artifact_sha256, `${label}.artifact_sha256`, errors, { nullable: false })
  validateHash(value[hashField], `${label}.${hashField}`, errors, { nullable: false })
  if (idField && !nonEmptyString(value[idField])) errors.push(`${label}.${idField} is required`)
  const loaded = resolveConfinedJson(value.artifact, context.baseDirectory, context.artifactRoot, `${label}.artifact`, errors)
  if (loaded && value.artifact_sha256 !== loaded.artifact_sha256) {
    errors.push(`${label}.artifact_sha256 does not match the referenced file (${loaded.artifact_sha256})`)
  }
  return loaded
}

function validateAcceptanceReport(report, label, errors, context, caseId) {
  if (!isPlainObject(report)) {
    errors.push(`${label} must be an object`)
    return []
  }
  pushUnknownFields(report, new Set(['schema_version', 'case_id', 'status', 'checks']), label, errors)
  if (report.schema_version !== 1) errors.push(`${label}.schema_version must be 1`)
  if (report.case_id !== caseId) errors.push(`${label}.case_id must bind the forward case id`)
  if (report.status !== 'passed') errors.push(`${label}.status must be passed`)
  if (!Array.isArray(report.checks) || report.checks.length === 0) {
    errors.push(`${label}.checks must contain at least one passed check`)
    return []
  }
  const results = []
  const ids = new Set()
  for (const [index, check] of report.checks.entries()) {
    const checkLabel = `${label}.checks[${index}]`
    if (!isPlainObject(check)) {
      errors.push(`${checkLabel} must be an object`)
      continue
    }
    pushUnknownFields(check, new Set(['check_id', 'status', 'evidence_artifacts']), checkLabel, errors)
    validatePackId(check.check_id, `${checkLabel}.check_id`, errors)
    if (ids.has(check.check_id)) errors.push(`${label}.checks has duplicate check_id: ${check.check_id}`)
    ids.add(check.check_id)
    if (check.status !== 'passed') errors.push(`${checkLabel}.status must be passed`)
    if (!Array.isArray(check.evidence_artifacts) || check.evidence_artifacts.length === 0) {
      errors.push(`${checkLabel}.evidence_artifacts must contain actual JSON artifacts`)
    } else {
      for (const [evidenceIndex, evidence] of check.evidence_artifacts.entries()) {
        const evidenceLabel = `${checkLabel}.evidence_artifacts[${evidenceIndex}]`
        if (!isPlainObject(evidence)) {
          errors.push(`${evidenceLabel} must be an object`)
          continue
        }
        pushUnknownFields(evidence, new Set(['artifact', 'artifact_sha256']), evidenceLabel, errors)
        validateHash(evidence.artifact_sha256, `${evidenceLabel}.artifact_sha256`, errors, { nullable: false })
        const loaded = resolveConfinedJson(evidence.artifact, context.baseDirectory, context.artifactRoot, `${evidenceLabel}.artifact`, errors)
        if (loaded && evidence.artifact_sha256 !== loaded.artifact_sha256) {
          errors.push(`${evidenceLabel}.artifact_sha256 does not match the referenced file (${loaded.artifact_sha256})`)
        }
      }
    }
    results.push({ check_id: check.check_id, status: check.status })
  }
  return results
}

function validateForwardEvidenceArtifact(forwardCase, caseLabel, errors, artifactRoot) {
  pushUnknownFields(forwardCase, new Set(['id', 'evidence_artifact', 'artifact_sha256']), caseLabel, errors)
  const idValid = validatePackId(forwardCase.id, `${caseLabel}.id`, errors)
  if (!nonEmptyString(forwardCase.evidence_artifact)) errors.push(`${caseLabel}.evidence_artifact is required`)
  validateHash(forwardCase.artifact_sha256, `${caseLabel}.artifact_sha256`, errors, { nullable: false })
  const loaded = resolveConfinedJson(forwardCase.evidence_artifact, artifactRoot, artifactRoot, `${caseLabel}.evidence_artifact`, errors)
  if (!loaded) return { idValid, evidence: null }
  if (forwardCase.artifact_sha256 !== loaded.artifact_sha256) {
    errors.push(`${caseLabel}.artifact_sha256 does not match the evidence artifact file (${loaded.artifact_sha256})`)
  }
  const evidence = loaded.value
  if (!isPlainObject(evidence)) {
    errors.push(`${caseLabel} evidence artifact must be an object`)
    return { idValid, evidence: null }
  }
  pushUnknownFields(evidence, new Set([
    'schema_version', 'case_id', 'source', 'template', 'target_before', 'target_after',
    'save_receipt', 'provenance_readback', 'acceptance_report'
  ]), `${caseLabel} evidence artifact`, errors)
  if (evidence.schema_version !== FORWARD_EVIDENCE_SCHEMA_VERSION) errors.push(`${caseLabel} evidence artifact.schema_version must be 1`)
  if (evidence.case_id !== forwardCase.id) errors.push(`${caseLabel} evidence artifact.case_id must equal ${forwardCase.id}`)
  const context = { baseDirectory: loaded.directory, artifactRoot }
  const source = validateArtifactLink(evidence.source, `${caseLabel} evidence.source`, errors, context, 'semantic_snapshot_hash', 'source_id')
  const template = validateArtifactLink(evidence.template, `${caseLabel} evidence.template`, errors, context, 'template_hash')
  const targetBefore = validateArtifactLink(evidence.target_before, `${caseLabel} evidence.target_before`, errors, context, 'snapshot_hash', 'target_id')
  const targetAfter = validateArtifactLink(evidence.target_after, `${caseLabel} evidence.target_after`, errors, context, 'snapshot_hash', 'target_id')
  const saveReceipt = validateArtifactLink(evidence.save_receipt, `${caseLabel} evidence.save_receipt`, errors, context, 'receipt_hash')
  const provenanceReadback = validateArtifactLink(evidence.provenance_readback, `${caseLabel} evidence.provenance_readback`, errors, context, 'readback_hash')
  const acceptanceReport = validateArtifactLink(evidence.acceptance_report, `${caseLabel} evidence.acceptance_report`, errors, context, 'report_hash')
  if (source) {
    const semanticHashes = [...new Set(collectNamedValues(source.value, new Set([
      'snapshotStableHash', 'snapshot_stable_hash', 'semantic_snapshot_hash'
    ])).filter((item) => HASH_PATTERN.test(item)))]
    if (!semanticHashes.includes(evidence.source?.semantic_snapshot_hash)) {
      errors.push(`${caseLabel} evidence.source.semantic_snapshot_hash must occur in the referenced semantic snapshot artifact`)
    }
    const verifiedMarkers = collectNamedValues(source.value, new Set(['snapshotStableHashVerified', 'snapshot_stable_hash_verified']))
    if (!verifiedMarkers.includes(true)) {
      errors.push(`${caseLabel} evidence.source artifact must contain snapshotStableHashVerified=true`)
    }
    const sourceIds = collectNamedValues(source.value, new Set(['source_id', 'book_id', 'bookId'])).map(String)
    if (!sourceIds.includes(String(evidence.source?.source_id))) {
      errors.push(`${caseLabel} evidence.source.source_id must occur in the referenced source artifact`)
    }
  }
  const canonicalBindings = [
    [template, evidence.template?.template_hash, `${caseLabel} evidence.template.template_hash`],
    [targetBefore, evidence.target_before?.snapshot_hash, `${caseLabel} evidence.target_before.snapshot_hash`],
    [targetAfter, evidence.target_after?.snapshot_hash, `${caseLabel} evidence.target_after.snapshot_hash`],
    [saveReceipt, evidence.save_receipt?.receipt_hash, `${caseLabel} evidence.save_receipt.receipt_hash`],
    [provenanceReadback, evidence.provenance_readback?.readback_hash, `${caseLabel} evidence.provenance_readback.readback_hash`],
    [acceptanceReport, evidence.acceptance_report?.report_hash, `${caseLabel} evidence.acceptance_report.report_hash`]
  ]
  for (const [artifact, claimedHash, hashLabel] of canonicalBindings) {
    if (artifact && claimedHash !== hashJson(artifact.value)) {
      errors.push(`${hashLabel} must equal the canonical hash of its referenced JSON artifact (${hashJson(artifact.value)})`)
    }
  }
  if (targetBefore && targetAfter) {
    if (evidence.target_before?.target_id !== evidence.target_after?.target_id) {
      errors.push(`${caseLabel} target before/after must bind the same target_id`)
    }
    if (evidence.target_before?.snapshot_hash === evidence.target_after?.snapshot_hash) {
      errors.push(`${caseLabel} target before/after hashes must differ`)
    }
    for (const [artifact, targetId, targetLabel] of [
      [targetBefore, evidence.target_before?.target_id, 'target_before'],
      [targetAfter, evidence.target_after?.target_id, 'target_after']
    ]) {
      const targetIds = collectNamedValues(artifact.value, new Set(['target_id', 'book_id', 'bookId'])).map(String)
      if (!targetIds.includes(String(targetId))) {
        errors.push(`${caseLabel} evidence.${targetLabel}.target_id must occur in the referenced target artifact`)
      }
    }
  }
  const acceptanceResults = acceptanceReport
    ? validateAcceptanceReport(acceptanceReport.value, `${caseLabel} acceptance report`, errors, {
        baseDirectory: acceptanceReport.directory,
        artifactRoot
      }, forwardCase.id)
    : []
  return {
    idValid,
    evidence: {
      artifact: forwardCase.evidence_artifact,
      source_id: evidence.source?.source_id,
      source_snapshot_hash: evidence.source?.semantic_snapshot_hash,
      template_hash: evidence.template?.template_hash,
      target_id: evidence.target_after?.target_id,
      target_before_hash: evidence.target_before?.snapshot_hash,
      target_after_hash: evidence.target_after?.snapshot_hash,
      acceptance_results: acceptanceResults
    }
  }
}

function validateExecution(value, label, errors, { artifactRoot }) {
  if (value === undefined) return null
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`)
    return null
  }
  pushUnknownFields(value, new Set(['capability_snapshot', 'trial_approval', 'forward_cases']), label, errors)

  const snapshot = value.capability_snapshot
  const availableCapabilities = new Set()
  if (!isPlainObject(snapshot)) {
    errors.push(`${label}.capability_snapshot must be an object`)
  } else {
    const catalogResult = validateCatalogArtifact(snapshot, `${label}.capability_snapshot`, errors, artifactRoot)
    catalogResult.availableCapabilities.forEach((capability) => availableCapabilities.add(capability))
  }

  const approval = value.trial_approval
  if (!isPlainObject(approval)) {
    errors.push(`${label}.trial_approval must be an object`)
  } else {
    pushUnknownFields(approval, new Set(['approved', 'evidence']), `${label}.trial_approval`, errors)
    if (typeof approval.approved !== 'boolean') errors.push(`${label}.trial_approval.approved must be boolean`)
    if (!Array.isArray(approval.evidence) || approval.evidence.some((item) => !nonEmptyString(item))) {
      errors.push(`${label}.trial_approval.evidence must be an array of non-empty strings`)
    }
    if (approval.approved === true && Array.isArray(approval.evidence) && approval.evidence.length === 0) {
      errors.push(`${label}.trial_approval.evidence must be non-empty when approved`)
    }
  }

  const forwardCases = new Map()
  if (!Array.isArray(value.forward_cases)) {
    errors.push(`${label}.forward_cases must be an array`)
  } else {
    for (const [index, forwardCase] of value.forward_cases.entries()) {
      const caseLabel = `${label}.forward_cases[${index}]`
      if (!isPlainObject(forwardCase)) {
        errors.push(`${caseLabel} must be an object`)
        continue
      }
      const { idValid, evidence } = validateForwardEvidenceArtifact(forwardCase, caseLabel, errors, artifactRoot)
      if (idValid && forwardCases.has(forwardCase.id)) errors.push(`${label}.forward_cases has duplicate id: ${forwardCase.id}`)
      if (idValid) forwardCases.set(forwardCase.id, { ...forwardCase, ...evidence })
    }
  }

  return { availableCapabilities, approval, forwardCases }
}

export function validateRulePack(pack, { artifactRoot = DEFAULT_ARTIFACT_ROOT } = {}) {
  const errors = []
  const warnings = []
  if (!isPlainObject(pack)) return { valid: false, errors: ['rule pack must be an object'], warnings }
  pushUnknownFields(pack, new Set([
    'schema_version', 'identity', 'applicability', 'templates', 'defaults', 'rules', 'acceptance',
    'training', 'forward_tests', 'execution'
  ]), 'rule pack', errors)
  if (pack.schema_version !== RULE_PACK_SCHEMA_VERSION) errors.push(`schema_version must be ${RULE_PACK_SCHEMA_VERSION}`)

  const identity = pack.identity
  if (!isPlainObject(identity)) {
    errors.push('identity must be an object')
  } else {
    pushUnknownFields(identity, new Set(['skill_name', 'display_name', 'version', 'status', 'book_family']), 'identity', errors)
    if (!nonEmptyString(identity.skill_name) || !SKILL_NAME_PATTERN.test(identity.skill_name) || identity.skill_name.length > 63) {
      errors.push('identity.skill_name must be lowercase hyphen-case and at most 63 characters')
    }
    if (!nonEmptyString(identity.display_name)) errors.push('identity.display_name is required')
    if (!nonEmptyString(identity.version) || !VERSION_PATTERN.test(identity.version)) errors.push('identity.version must be semver x.y.z')
    if (!RULE_PACK_STATUSES.has(identity.status)) errors.push('identity.status is invalid')
    if (!nonEmptyString(identity.book_family)) errors.push('identity.book_family is required')
  }

  validateApplicability(pack.applicability, 'applicability', errors)
  const requiredCapabilities = new Set()
  const execution = validateExecution(pack.execution, 'execution', errors, { artifactRoot: path.resolve(artifactRoot) })

  if (!isPlainObject(pack.templates)) {
    errors.push('templates must be an object')
  } else {
    pushUnknownFields(pack.templates, new Set(['default', 'variants']), 'templates', errors)
    validateTemplate(pack.templates.default, 'templates.default', errors, warnings)
    if (!Array.isArray(pack.templates.variants)) {
      errors.push('templates.variants must be an array')
    } else {
      const variantIds = new Set()
      const priorities = new Set()
      for (const [index, variant] of pack.templates.variants.entries()) {
        validateTemplate(variant, `templates.variants[${index}]`, errors, warnings, { variant: true })
        validatePackId(variant?.id, `templates.variants[${index}].id`, errors)
        if (variantIds.has(variant?.id)) errors.push(`templates.variants has duplicate id: ${variant.id}`)
        if (priorities.has(variant?.priority)) errors.push(`templates.variants has duplicate priority: ${variant.priority}`)
        variantIds.add(variant?.id)
        priorities.add(variant?.priority)
      }
    }
  }

  if (!isPlainObject(pack.defaults)) {
    errors.push('defaults must be an object')
  } else {
    pushUnknownFields(pack.defaults, new Set(['style_policy', 'module_policy', 'on_missing', 'on_ambiguous']), 'defaults', errors)
    if (!STYLE_POLICIES.has(pack.defaults.style_policy)) errors.push('defaults.style_policy is invalid')
    if (pack.defaults.module_policy !== undefined && !MODULE_POLICIES.has(pack.defaults.module_policy)) {
      errors.push('defaults.module_policy is invalid')
    }
    if (!MISSING_POLICIES.has(pack.defaults.on_missing)) errors.push('defaults.on_missing is invalid')
    if (!AMBIGUITY_POLICIES.has(pack.defaults.on_ambiguous)) errors.push('defaults.on_ambiguous is invalid')
  }

  const knownRuleIds = new Set()
  if (!Array.isArray(pack.rules) || pack.rules.length === 0) {
    errors.push('rules must contain at least one rule')
  } else {
    const ids = new Set()
    const orders = new Set()
    for (const [index, rule] of pack.rules.entries()) {
      const label = `rules[${index}]`
      if (!isPlainObject(rule)) {
        errors.push(`${label} must be an object`)
        continue
      }
      pushUnknownFields(rule, new Set([
        'id', 'order', 'intent', 'when', 'scope', 'source', 'target', 'action', 'on_missing',
        'on_ambiguous', 'validate'
      ]), label, errors)
      validatePackId(rule.id, `${label}.id`, errors)
      if (ids.has(rule.id)) errors.push(`rules has duplicate id: ${rule.id}`)
      ids.add(rule.id)
      knownRuleIds.add(rule.id)
      if (!Number.isInteger(rule.order)) errors.push(`${label}.order must be an integer`)
      if (orders.has(rule.order)) errors.push(`rules has duplicate order: ${rule.order}`)
      orders.add(rule.order)
      if (!nonEmptyString(rule.intent)) errors.push(`${label}.intent is required`)
      if (!nonEmptyString(rule.when)) errors.push(`${label}.when is required`)
      validateApplicability(rule.scope, `${label}.scope`, errors)
      validateSelector(rule.source, `${label}.source`, errors, warnings)
      validateSelector(rule.target, `${label}.target`, errors, warnings)
      validateAction(rule.action, `${label}.action`, errors, requiredCapabilities)
      if (!MISSING_POLICIES.has(rule.on_missing)) errors.push(`${label}.on_missing is invalid`)
      if (!AMBIGUITY_POLICIES.has(rule.on_ambiguous)) errors.push(`${label}.on_ambiguous is invalid`)
      if (!Array.isArray(rule.validate) || rule.validate.length === 0) {
        errors.push(`${label}.validate must contain at least one check`)
      } else {
        const checkIds = new Set()
        rule.validate.forEach((check, checkIndex) => {
          validateValidation(check, `${label}.validate[${checkIndex}]`, errors, requiredCapabilities)
          if (checkIds.has(check?.id)) errors.push(`${label}.validate has duplicate id: ${check.id}`)
          checkIds.add(check?.id)
        })
      }
    }
  }

  const acceptanceIds = new Set()
  if (!Array.isArray(pack.acceptance) || pack.acceptance.length === 0) {
    errors.push('acceptance must contain at least one check')
  } else {
    pack.acceptance.forEach((check, index) => {
      validateValidation(check, `acceptance[${index}]`, errors, requiredCapabilities)
      if (acceptanceIds.has(check?.id)) errors.push(`acceptance has duplicate id: ${check.id}`)
      acceptanceIds.add(check?.id)
    })
  }

  if (!isPlainObject(pack.training)) {
    errors.push('training must be an object')
  } else {
    pushUnknownFields(pack.training, new Set(['feedback', 'examples']), 'training', errors)
    if (!Array.isArray(pack.training.feedback)) {
      errors.push('training.feedback must be an array')
    } else {
      const feedbackIds = new Set()
      for (const [index, feedback] of pack.training.feedback.entries()) {
        const label = `training.feedback[${index}]`
        if (!isPlainObject(feedback)) {
          errors.push(`${label} must be an object`)
          continue
        }
        pushUnknownFields(feedback, new Set(['id', 'classification', 'summary', 'confirmed', 'resolved', 'resolution', 'promoted_to_rule_ids']), label, errors)
        validatePackId(feedback.id, `${label}.id`, errors)
        if (feedbackIds.has(feedback.id)) errors.push(`training.feedback has duplicate id: ${feedback.id}`)
        feedbackIds.add(feedback.id)
        if (!FEEDBACK_TYPES.has(feedback.classification)) errors.push(`${label}.classification is invalid`)
        if (!nonEmptyString(feedback.summary)) errors.push(`${label}.summary is required`)
        if (typeof feedback.confirmed !== 'boolean') errors.push(`${label}.confirmed must be boolean`)
        if (feedback.resolved !== undefined && typeof feedback.resolved !== 'boolean') errors.push(`${label}.resolved must be boolean`)
        if (feedback.resolved === true && !nonEmptyString(feedback.resolution)) errors.push(`${label}.resolution is required when resolved`)
        if (feedback.resolution !== undefined && !nonEmptyString(feedback.resolution)) errors.push(`${label}.resolution must be a non-empty string`)
        if (feedback.promoted_to_rule_ids !== undefined &&
            (!Array.isArray(feedback.promoted_to_rule_ids) || feedback.promoted_to_rule_ids.some((id) => !knownRuleIds.has(id)))) {
          errors.push(`${label}.promoted_to_rule_ids must reference rules in this pack`)
        }
      }
    }
    if (!Array.isArray(pack.training.examples)) errors.push('training.examples must be an array')
    else {
      const exampleIds = new Set()
      for (const [index, example] of pack.training.examples.entries()) {
      const label = `training.examples[${index}]`
      if (!isPlainObject(example)) {
        errors.push(`${label} must be an object`)
        continue
      }
      pushUnknownFields(example, new Set(['id', 'kind', 'description', 'rule_ids']), label, errors)
      validatePackId(example.id, `${label}.id`, errors)
      if (exampleIds.has(example.id)) errors.push(`training.examples has duplicate id: ${example.id}`)
      exampleIds.add(example.id)
      if (!['positive', 'negative'].includes(example.kind)) errors.push(`${label}.kind is invalid`)
      if (!nonEmptyString(example.description)) errors.push(`${label}.description is required`)
      if (example.rule_ids !== undefined && (!Array.isArray(example.rule_ids) || example.rule_ids.some((id) => !nonEmptyString(id)))) {
        errors.push(`${label}.rule_ids must be an array of non-empty strings`)
      } else if (Array.isArray(example.rule_ids) && example.rule_ids.some((id) => !knownRuleIds.has(id))) {
        errors.push(`${label}.rule_ids must reference rules in this pack`)
      }
    }
    }
  }

  const passedForwardTests = []
  if (!Array.isArray(pack.forward_tests)) {
    errors.push('forward_tests must be an array')
  } else {
    const forwardTestIds = new Set()
    for (const [index, test] of pack.forward_tests.entries()) {
      const label = `forward_tests[${index}]`
      if (!isPlainObject(test)) {
        errors.push(`${label} must be an object`)
        continue
      }
      pushUnknownFields(test, new Set(['id', 'source_label', 'status', 'evidence_artifact']), label, errors)
      validatePackId(test.id, `${label}.id`, errors)
      if (forwardTestIds.has(test.id)) errors.push(`forward_tests has duplicate id: ${test.id}`)
      forwardTestIds.add(test.id)
      if (!nonEmptyString(test.source_label)) errors.push(`${label}.source_label is required`)
      if (!['pending', 'passed', 'failed', 'needs_review'].includes(test.status)) errors.push(`${label}.status is invalid`)
      if (test.evidence_artifact !== undefined && !nonEmptyString(test.evidence_artifact)) {
        errors.push(`${label}.evidence_artifact must be a non-empty relative artifact path`)
      }
      if (test.status === 'passed') {
        if (!nonEmptyString(test.evidence_artifact)) errors.push(`${label}.evidence_artifact is required when passed`)
        passedForwardTests.push({ test, label })
      }
    }
  }

  const executionStatus = ['trial_approved', 'validated'].includes(identity?.status)
  if (executionStatus) {
    validateHash(pack.templates?.default?.snapshot_hash, 'templates.default.snapshot_hash', errors, { nullable: false })
    if (Array.isArray(pack.templates?.variants)) pack.templates.variants.forEach((variant, index) =>
      validateHash(variant?.snapshot_hash, `templates.variants[${index}].snapshot_hash`, errors, { nullable: false })
    )
    if (!execution) {
      errors.push(`${identity.status} rule packs require execution evidence`)
    } else {
      if (execution.approval?.approved !== true) {
        errors.push(`${identity.status} rule packs require explicit trial approval`)
      }
      for (const capability of requiredCapabilities) {
        if (!execution.availableCapabilities.has(capability)) {
          errors.push(`${identity.status} rule packs cannot execute unavailable capability: ${capability}`)
        }
      }
    }
  }

  if (identity?.status === 'validated') {
    if (passedForwardTests.length < 2) errors.push('validated rule packs require at least two passed forward_tests')
    const seenSources = new Set()
    const seenTargets = new Set()
    const seenPairs = new Set()
    for (const { test, label } of passedForwardTests) {
      const forwardCase = execution?.forwardCases.get(test.id)
      if (!forwardCase) {
        errors.push(`${label} must reference execution.forward_cases by id`)
        continue
      }
      if (test.evidence_artifact !== forwardCase.evidence_artifact) {
        errors.push(`${label}.evidence_artifact must equal its registered execution.forward_cases artifact`)
      }
      const sourceHash = forwardCase.source_snapshot_hash
      const targetHash = forwardCase.target_after_hash
      const sourceIdentity = `${forwardCase.source_id}|${sourceHash}|${forwardCase.artifact}`
      const targetIdentity = `${forwardCase.target_id}|${targetHash}|${forwardCase.artifact}`
      const pair = `${forwardCase.source_id}|${forwardCase.target_id}`
      if ([...seenSources].some((item) => item.split('|')[0] === String(forwardCase.source_id) || item.split('|')[1] === sourceHash || item.split('|')[2] === forwardCase.artifact)) {
        errors.push('validated forward cases must use different evidence artifacts, source IDs and semantic snapshot hashes')
      }
      if ([...seenTargets].some((item) => item.split('|')[0] === String(forwardCase.target_id) || item.split('|')[1] === targetHash || item.split('|')[2] === forwardCase.artifact)) {
        errors.push('validated forward cases must use different evidence artifacts, target IDs and after hashes')
      }
      if (seenPairs.has(pair)) errors.push(`validated forward cases cannot repeat the same source/target snapshot pair`)
      seenSources.add(sourceIdentity)
      seenTargets.add(targetIdentity)
      seenPairs.add(pair)

      const results = new Map((forwardCase.acceptance_results || []).map((result) => [result.check_id, result]))
      for (const checkId of acceptanceIds) {
        const result = results.get(checkId)
        if (!result) errors.push(`${label} is missing required acceptance result: ${checkId}`)
        else if (result.status !== 'passed') errors.push(`${label} acceptance result ${checkId} must be passed`)
      }
      for (const checkId of results.keys()) {
        if (!acceptanceIds.has(checkId)) errors.push(`${label} references unknown acceptance check: ${checkId}`)
      }
    }
    if (Array.isArray(pack.training?.feedback)) {
      for (const feedback of pack.training.feedback) {
        if (feedback?.confirmed !== true || feedback?.resolved !== true) {
          errors.push(`validated rule packs cannot contain unresolved feedback: ${feedback?.id || '<invalid>'}`)
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

export function assertValidRulePack(pack, options) {
  const result = validateRulePack(pack, options)
  if (!result.valid) throw new Error(`invalid semantic rule pack:\n- ${result.errors.join('\n- ')}`)
  return result
}

export function readJson(filename) {
  const text = filename === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(filename, 'utf8')
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`cannot parse input JSON: ${error.message}`)
  }
}

export function writeJson(filename, value) {
  const output = `${JSON.stringify(value, null, 2)}\n`
  if (!filename || filename === '-') {
    process.stdout.write(output)
    return
  }
  atomicWriteText(filename, output)
}

/** Controlled replace that works when Windows refuses rename-over-existing. */
export function atomicWriteText(filename, content) {
  const absolute = path.resolve(filename)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`
  const backup = `${absolute}.${process.pid}.${Date.now()}.bak`
  fs.writeFileSync(temporary, content, 'utf8')
  let movedOriginal = false
  try {
    if (fs.existsSync(absolute)) {
      const stat = fs.statSync(absolute)
      if (!stat.isFile()) throw new Error(`refusing to replace non-file target: ${absolute}`)
      fs.renameSync(absolute, backup)
      movedOriginal = true
    }
    fs.renameSync(temporary, absolute)
    if (movedOriginal) fs.unlinkSync(backup)
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    if (movedOriginal && !fs.existsSync(absolute) && fs.existsSync(backup)) fs.renameSync(backup, absolute)
    throw error
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
    const key = value.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) options[key] = true
    else {
      options[key] = next
      index += 1
    }
  }
  return options
}

function printHelp() {
  process.stdout.write(`Usage:\n  semantic-rule-tools.mjs validate --input <json> [--out <json>]\n  semantic-rule-tools.mjs hash --input <json> [--out <json>]\n\nThe JSON Schema is a structural baseline. The validate command is authoritative for cross-field constraints, canonical hashes, capability-catalog subsets, file SHA-256 and external evidence-artifact bindings. The hash command accepts any JSON snapshot.\n`)
}

export function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const command = options._[0]
  if (!command || command === 'help' || options.help) {
    printHelp()
    return 0
  }
  if (!options.input) throw new Error('--input is required')
  const value = readJson(options.input)
  if (command === 'validate') {
    const artifactRoot = options.input === '-' ? process.cwd() : path.dirname(path.resolve(options.input))
    const result = validateRulePack(value, { artifactRoot })
    writeJson(options.out, { ...result, rule_pack_hash: result.valid ? hashJson(value) : null })
    return result.valid ? 0 : 1
  }
  if (command === 'hash') {
    writeJson(options.out, { hash: hashJson(value) })
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
