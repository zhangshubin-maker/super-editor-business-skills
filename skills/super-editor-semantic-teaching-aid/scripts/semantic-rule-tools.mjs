#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

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
const FORBIDDEN_ID_ANCHOR_KINDS = new Set(['element_id', 'runtime_element_id', 'block_id', 'runtime_block_id', 'slot_id'])

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

function nonEmptyString(value) {
  return typeof value === 'string' && Boolean(value.trim())
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
    if (!nonEmptyString(anchor.kind)) errors.push(`${anchorLabel}.kind is required`)
    if (!Object.hasOwn(anchor, 'value')) errors.push(`${anchorLabel}.value is required`)
    if (FORBIDDEN_ID_ANCHOR_KINDS.has(anchor.kind)) {
      errors.push(`${anchorLabel}.kind cannot use a runtime-only ID (${anchor.kind})`)
    }
    if (typeof anchor.kind === 'string' && /source.?id|template.?id/i.test(anchor.kind) && anchor.optional !== true) {
      warnings.push(`${anchorLabel} is an ID fingerprint; mark optional=true and keep semantic role/cardinality as primary evidence`)
    }
  }
}

function validateSelector(value, label, errors, warnings) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`)
    return
  }
  pushUnknownFields(value, new Set(['role', 'cardinality', 'anchors', 'include', 'exclude']), label, errors)
  if (!nonEmptyString(value.role)) errors.push(`${label}.role is required`)
  validateCardinality(value.cardinality, `${label}.cardinality`, errors)
  validateAnchors(value.anchors, `${label}.anchors`, errors, warnings)
}

function validateValidation(value, label, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`)
    return
  }
  pushUnknownFields(value, new Set(['id', 'intent', 'severity', 'required_capabilities']), label, errors)
  if (!nonEmptyString(value.id)) errors.push(`${label}.id is required`)
  if (!nonEmptyString(value.intent)) errors.push(`${label}.intent is required`)
  if (!['error', 'warning'].includes(value.severity)) errors.push(`${label}.severity must be error or warning`)
  if (!Array.isArray(value.required_capabilities)) errors.push(`${label}.required_capabilities must be an array`)
}

function validateAction(value, label, errors, depth = 0) {
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
  if (!Array.isArray(value.required_capabilities) || value.required_capabilities.length === 0 ||
      value.required_capabilities.some((item) => !nonEmptyString(item))) {
    errors.push(`${label}.required_capabilities must contain at least one capability`)
  }
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
      value.steps.forEach((step, index) => validateAction(step, `${label}.steps[${index}]`, errors, depth + 1))
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

export function validateRulePack(pack) {
  const errors = []
  const warnings = []
  if (!isPlainObject(pack)) return { valid: false, errors: ['rule pack must be an object'], warnings }
  pushUnknownFields(pack, new Set([
    'schema_version', 'identity', 'applicability', 'templates', 'defaults', 'rules', 'acceptance',
    'training', 'forward_tests'
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
      if (!nonEmptyString(rule.id)) errors.push(`${label}.id is required`)
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
      validateAction(rule.action, `${label}.action`, errors)
      if (!MISSING_POLICIES.has(rule.on_missing)) errors.push(`${label}.on_missing is invalid`)
      if (!AMBIGUITY_POLICIES.has(rule.on_ambiguous)) errors.push(`${label}.on_ambiguous is invalid`)
      if (!Array.isArray(rule.validate) || rule.validate.length === 0) {
        errors.push(`${label}.validate must contain at least one check`)
      } else {
        rule.validate.forEach((check, checkIndex) => validateValidation(check, `${label}.validate[${checkIndex}]`, errors))
      }
    }
  }

  if (!Array.isArray(pack.acceptance) || pack.acceptance.length === 0) {
    errors.push('acceptance must contain at least one check')
  } else {
    pack.acceptance.forEach((check, index) => validateValidation(check, `acceptance[${index}]`, errors))
  }

  if (!isPlainObject(pack.training)) {
    errors.push('training must be an object')
  } else {
    pushUnknownFields(pack.training, new Set(['feedback', 'examples']), 'training', errors)
    if (!Array.isArray(pack.training.feedback)) {
      errors.push('training.feedback must be an array')
    } else {
      for (const [index, feedback] of pack.training.feedback.entries()) {
        const label = `training.feedback[${index}]`
        if (!isPlainObject(feedback)) {
          errors.push(`${label} must be an object`)
          continue
        }
        pushUnknownFields(feedback, new Set(['id', 'classification', 'summary', 'confirmed', 'promoted_to_rule_ids']), label, errors)
        if (!nonEmptyString(feedback.id)) errors.push(`${label}.id is required`)
        if (!FEEDBACK_TYPES.has(feedback.classification)) errors.push(`${label}.classification is invalid`)
        if (!nonEmptyString(feedback.summary)) errors.push(`${label}.summary is required`)
        if (typeof feedback.confirmed !== 'boolean') errors.push(`${label}.confirmed must be boolean`)
        if (feedback.promoted_to_rule_ids !== undefined &&
            (!Array.isArray(feedback.promoted_to_rule_ids) || feedback.promoted_to_rule_ids.some((id) => !knownRuleIds.has(id)))) {
          errors.push(`${label}.promoted_to_rule_ids must reference rules in this pack`)
        }
      }
    }
    if (!Array.isArray(pack.training.examples)) errors.push('training.examples must be an array')
    else for (const [index, example] of pack.training.examples.entries()) {
      const label = `training.examples[${index}]`
      if (!isPlainObject(example)) {
        errors.push(`${label} must be an object`)
        continue
      }
      pushUnknownFields(example, new Set(['id', 'kind', 'description', 'rule_ids']), label, errors)
      if (!nonEmptyString(example.id)) errors.push(`${label}.id is required`)
      if (!['positive', 'negative'].includes(example.kind)) errors.push(`${label}.kind is invalid`)
      if (!nonEmptyString(example.description)) errors.push(`${label}.description is required`)
      if (example.rule_ids !== undefined && (!Array.isArray(example.rule_ids) || example.rule_ids.some((id) => !nonEmptyString(id)))) {
        errors.push(`${label}.rule_ids must be an array of non-empty strings`)
      } else if (Array.isArray(example.rule_ids) && example.rule_ids.some((id) => !knownRuleIds.has(id))) {
        errors.push(`${label}.rule_ids must reference rules in this pack`)
      }
    }
  }

  if (!Array.isArray(pack.forward_tests)) {
    errors.push('forward_tests must be an array')
  } else {
    const passed = pack.forward_tests.filter((test) => test?.status === 'passed').length
    for (const [index, test] of pack.forward_tests.entries()) {
      const label = `forward_tests[${index}]`
      if (!isPlainObject(test)) {
        errors.push(`${label} must be an object`)
        continue
      }
      pushUnknownFields(test, new Set(['id', 'source_label', 'status', 'evidence', 'result_hash']), label, errors)
      if (!nonEmptyString(test.id)) errors.push(`${label}.id is required`)
      if (!nonEmptyString(test.source_label)) errors.push(`${label}.source_label is required`)
      if (!['pending', 'passed', 'failed', 'needs_review'].includes(test.status)) errors.push(`${label}.status is invalid`)
      if (!Array.isArray(test.evidence) || test.evidence.some((item) => !nonEmptyString(item))) {
        errors.push(`${label}.evidence must be an array of non-empty strings`)
      }
      validateHash(test.result_hash, `${label}.result_hash`, errors)
      if (test.status === 'passed') {
        if (!Array.isArray(test.evidence) || test.evidence.length === 0) errors.push(`${label}.evidence must be non-empty when passed`)
        validateHash(test.result_hash, `${label}.result_hash`, errors, { nullable: false })
      }
    }
    if (identity?.status === 'validated' && passed < 2) {
      errors.push('validated rule packs require at least two passed forward_tests')
    }
  }

  if (['trial_approved', 'validated'].includes(identity?.status)) {
    validateHash(pack.templates?.default?.snapshot_hash, 'templates.default.snapshot_hash', errors, { nullable: false })
    if (Array.isArray(pack.templates?.variants)) pack.templates.variants.forEach((variant, index) =>
      validateHash(variant?.snapshot_hash, `templates.variants[${index}].snapshot_hash`, errors, { nullable: false })
    )
  }

  return { valid: errors.length === 0, errors, warnings }
}

export function assertValidRulePack(pack) {
  const result = validateRulePack(pack)
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
  process.stdout.write(`Usage:\n  semantic-rule-tools.mjs validate --input <json> [--out <json>]\n  semantic-rule-tools.mjs hash --input <json> [--out <json>]\n\nThe hash command accepts any JSON snapshot; use it for source and template detail responses.\n`)
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
    const result = validateRulePack(value)
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
