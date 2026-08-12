#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

export const DEFAULT_ROUTING_PATH = path.resolve(SCRIPT_DIR, '../references/template-routing.json')
export const DEFAULT_LESSON_ROOT =
  process.env.SUPER_EDITOR_LESSON_ENGINE_ROOT ||
  'D:/GIT-web/web-tool/ai简化界面型教辅'
export const DEFAULT_TEMPLATE_DIR = path.join(DEFAULT_LESSON_ROOT, '模版')

const SLOT_FIELDS = Object.freeze({
  text: ['text_slots', 'slots'],
  image: ['image_slots'],
  button: ['button_slots'],
  jump: ['jump_slots'],
  delete: ['delete_slots']
})

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function normalizeId(value, label) {
  const id = typeof value === 'number' ? value : Number(value)
  assert(Number.isSafeInteger(id) && id > 0, `${label} must be a positive integer; received ${JSON.stringify(value)}`)
  return id
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonicalize(value[key])])
    )
  }
  return value
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

export function sha256CanonicalJson(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

async function readJson(filePath) {
  const text = await readFile(filePath, 'utf8')
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`)
  }
}

export async function loadRoutingConfig(routingPath = DEFAULT_ROUTING_PATH) {
  return readJson(path.resolve(routingPath))
}

function getRawTemplateRoot(raw, id, rawPath) {
  const root = raw && raw.data && typeof raw.data === 'object' ? raw.data : raw
  assert(root && typeof root === 'object', `Raw template ${id} has no data object: ${rawPath}`)
  assert(normalizeId(root.id, `Raw template ${id} data.id`) === id, `Raw template filename ${id}.json does not match data.id ${root.id}`)
  assert(Array.isArray(root.child_list), `Raw template ${id} data.child_list must be an array`)
  return root
}

function getSlotArray(block, kind) {
  for (const field of SLOT_FIELDS[kind]) {
    if (Array.isArray(block && block[field])) return block[field]
  }
  return []
}

function collectElementIds(value, ids = new Set()) {
  if (!value || typeof value !== 'object') return ids
  if (value.id != null) ids.add(String(value.id))
  for (const key of ['elements', 'child_list', 'children']) {
    if (Array.isArray(value[key])) {
      for (const child of value[key]) collectElementIds(child, ids)
    }
  }
  return ids
}

function parseRawBlockContent(rawBlock, templateId) {
  if (rawBlock && typeof rawBlock.content === 'string') {
    try {
      return JSON.parse(rawBlock.content)
    } catch (error) {
      throw new Error(`Raw template ${templateId} block ${rawBlock.id} has invalid content JSON: ${error.message}`)
    }
  }
  return rawBlock && rawBlock.content && typeof rawBlock.content === 'object'
    ? rawBlock.content
    : rawBlock
}

function normalizeAnalysis(templateId, analysis, rawRoot, analysePath) {
  assert(analysis && typeof analysis === 'object', `Analysis ${templateId} must be an object: ${analysePath}`)
  assert(Array.isArray(analysis.blocks), `Analysis ${templateId} blocks must be an array`)

  if (analysis.templatePath) {
    const referencedName = path.posix.basename(String(analysis.templatePath).replaceAll('\\', '/'))
    assert(referencedName === `${templateId}.json`, `Analysis ${templateId} templatePath points to ${analysis.templatePath}`)
  }

  const rawBlocks = new Map(
    rawRoot.child_list.map(block => [normalizeId(block.id, `Raw template ${templateId} block id`), block])
  )
  const analysisBlockIds = new Set()
  const slotCounts = { text: 0, image: 0, button: 0, jump: 0, delete: 0 }
  let hasMatchRules = false
  let repeatableBlockCount = 0
  let usesLegacyTextSlots = false

  for (const [blockPosition, block] of analysis.blocks.entries()) {
    const blockId = normalizeId(block && block.blockId, `Analysis ${templateId} block[${blockPosition}].blockId`)
    assert(!analysisBlockIds.has(blockId), `Analysis ${templateId} repeats blockId ${blockId}`)
    analysisBlockIds.add(blockId)
    assert(rawBlocks.has(blockId), `Analysis ${templateId} blockId ${blockId} is absent from raw template`)

    const rawElementIds = collectElementIds(parseRawBlockContent(rawBlocks.get(blockId), templateId))
    for (const kind of Object.keys(SLOT_FIELDS)) {
      const slots = getSlotArray(block, kind)
      slotCounts[kind] += slots.length
      for (const [slotPosition, slot] of slots.entries()) {
        assert(slot && slot.id != null && String(slot.id) !== '', `Analysis ${templateId} block ${blockId} ${kind} slot[${slotPosition}] has no id`)
        assert(
          rawElementIds.has(String(slot.id)),
          `Analysis ${templateId} block ${blockId} ${kind} slot id ${slot.id} is absent from raw block content`
        )
      }
    }

    if (Array.isArray(block.slots) && !Array.isArray(block.text_slots)) usesLegacyTextSlots = true
    if (typeof block.match_rule === 'string' && block.match_rule.trim()) hasMatchRules = true
    if (block.repeatable === true || typeof block.repeat_rule === 'string') repeatableBlockCount += 1
  }

  const repeatGroups = Array.isArray(analysis.repeat_groups) ? analysis.repeat_groups : []
  const repeatModes = new Set()
  for (const [groupPosition, group] of repeatGroups.entries()) {
    assert(group && typeof group === 'object', `Analysis ${templateId} repeat_groups[${groupPosition}] must be an object`)
    if (typeof group.mode === 'string' && group.mode) repeatModes.add(group.mode)
    assert(Array.isArray(group.template_block_ids), `Analysis ${templateId} repeat_groups[${groupPosition}].template_block_ids must be an array`)
    for (const rawBlockId of group.template_block_ids) {
      const blockId = normalizeId(rawBlockId, `Analysis ${templateId} repeat group block id`)
      assert(analysisBlockIds.has(blockId), `Analysis ${templateId} repeat group references unknown analysis blockId ${blockId}`)
    }
  }

  return {
    catalog_name: typeof analysis.catalog_name === 'string' ? analysis.catalog_name : '',
    capabilities: {
      raw_block_count: rawBlocks.size,
      analysis_block_count: analysis.blocks.length,
      repeat_group_count: repeatGroups.length,
      repeatable_block_count: repeatableBlockCount,
      repeat_modes: [...repeatModes].sort(),
      slot_counts: slotCounts,
      slot_kinds: Object.keys(slotCounts).filter(kind => slotCounts[kind] > 0),
      has_match_rules: hasMatchRules,
      uses_legacy_text_slots: usesLegacyTextSlots
    }
  }
}

function collectRoutingIds(routing) {
  const usages = []
  for (const [index, item] of (routing.book_template_match_order || []).entries()) {
    usages.push({ id: item.id, usage: `book_template_match_order[${index}]` })
  }
  for (const [index, rule] of (routing.catalog_route_priority || []).entries()) {
    for (const sourceId of rule.source_template_ids || []) {
      usages.push({ id: sourceId, usage: `catalog_route_priority[${index}].source_template_ids` })
    }
    if (rule.target_template_id != null) {
      usages.push({ id: rule.target_template_id, usage: `catalog_route_priority[${index}].target_template_id` })
    }
    for (const byPeriod of Object.values(rule.target_by_subject || {})) {
      for (const [period, targetId] of Object.entries(byPeriod || {})) {
        usages.push({ id: targetId, usage: `catalog_route_priority[${index}].target_by_subject.${period}` })
      }
    }
  }
  for (const [index, id] of (routing.registry && routing.registry.registered_unrouted_template_ids || []).entries()) {
    usages.push({ id, usage: `registry.registered_unrouted_template_ids[${index}]` })
  }
  return usages
}

export function validateRoutingTargets(routing, registeredIds) {
  const idSet = new Set([...registeredIds].map(value => normalizeId(value, 'Registered template id')))

  assert(Array.isArray(routing.book_template_match_order), 'Routing config book_template_match_order must be an array')
  assert(Array.isArray(routing.catalog_route_priority), 'Routing config catalog_route_priority must be an array')
  assert(routing.book_template_match_order.length === 32, `Expected exactly 32 ordered book templates; found ${routing.book_template_match_order.length}`)

  const priorities = routing.catalog_route_priority.map(rule => rule.priority)
  assert(
    priorities.every((priority, index) => priority === index + 1),
    `Catalog route priorities must be consecutive and match array order; received ${priorities.join(', ')}`
  )

  for (const { id: rawId, usage } of collectRoutingIds(routing)) {
    const id = normalizeId(rawId, usage)
    assert(idSet.has(id), `Routing target/source template ${id} (${usage}) is absent from the rule registry`)
  }
  return true
}

function buildPairHash(rawSha256, analyseSha256) {
  return createHash('sha256')
    .update(`raw:${rawSha256}\nanalyse:${analyseSha256}\n`, 'utf8')
    .digest('hex')
}

export async function buildRuleRegistry(options = {}) {
  const templateDir = path.resolve(options.templateDir || DEFAULT_TEMPLATE_DIR)
  const routingPath = path.resolve(options.routingPath || DEFAULT_ROUTING_PATH)
  const routing = options.routing || await loadRoutingConfig(routingPath)
  const names = await readdir(templateDir)
  const rawIds = new Set(
    names.filter(name => /^\d+\.json$/.test(name)).map(name => Number(name.slice(0, -5)))
  )
  const analyseIds = new Set(
    names.filter(name => /^\d+_analyse\.json$/.test(name)).map(name => Number(name.replace('_analyse.json', '')))
  )

  const missingAnalyses = [...rawIds].filter(id => !analyseIds.has(id)).sort((a, b) => a - b)
  const missingRaw = [...analyseIds].filter(id => !rawIds.has(id)).sort((a, b) => a - b)
  assert(missingAnalyses.length === 0, `Raw templates without analysis: ${missingAnalyses.join(', ')}`)
  assert(missingRaw.length === 0, `Analyses without raw template: ${missingRaw.join(', ')}`)

  const ids = [...rawIds].sort((a, b) => a - b)
  const expectedPairCount = Number(routing.registry && routing.registry.expected_pair_count)
  assert(Number.isSafeInteger(expectedPairCount), 'Routing config registry.expected_pair_count must be an integer')
  assert(ids.length === expectedPairCount, `Expected ${expectedPairCount} raw/analyse pairs; found ${ids.length}`)

  const templates = []
  for (const id of ids) {
    const rawName = `${id}.json`
    const analyseName = `${id}_analyse.json`
    const rawPath = path.join(templateDir, rawName)
    const analysePath = path.join(templateDir, analyseName)
    const [raw, analysis] = await Promise.all([readJson(rawPath), readJson(analysePath)])
    const rawRoot = getRawTemplateRoot(raw, id, rawPath)
    const normalized = normalizeAnalysis(id, analysis, rawRoot, analysePath)
    const rawSha256 = sha256CanonicalJson(raw)
    const analyseSha256 = sha256CanonicalJson(analysis)

    templates.push({
      template_id: id,
      raw_path: rawName,
      analyse_path: analyseName,
      catalog_name: normalized.catalog_name,
      raw_sha256: rawSha256,
      analyse_sha256: analyseSha256,
      pair_sha256: buildPairHash(rawSha256, analyseSha256),
      capabilities: normalized.capabilities
    })
  }

  validateRoutingTargets(routing, new Set(ids))

  const registryCore = {
    schema_version: 1,
    hash_algorithm: 'sha256-canonical-json',
    template_root_label: '模版',
    routing_sha256: sha256CanonicalJson({
      schema_version: routing.schema_version,
      explicit_template_policy: routing.explicit_template_policy,
      book_template_match_order: routing.book_template_match_order,
      catalog_route_priority: routing.catalog_route_priority
    }),
    pair_count: templates.length,
    templates
  }

  return {
    ...registryCore,
    registry_sha256: sha256CanonicalJson(registryCore)
  }
}

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--compact') {
      result.compact = true
      continue
    }
    const keyByArg = {
      '--template-dir': 'templateDir',
      '--routing': 'routingPath',
      '--output': 'outputPath'
    }
    const key = keyByArg[arg]
    if (!key) throw new Error(`Unknown argument: ${arg}`)
    assert(index + 1 < argv.length, `${arg} requires a value`)
    result[key] = argv[index + 1]
    index += 1
  }
  return result
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const registry = await buildRuleRegistry(args)
  const json = args.compact ? JSON.stringify(registry) : `${JSON.stringify(registry, null, 2)}\n`
  if (args.outputPath) {
    await writeFile(path.resolve(args.outputPath), json, 'utf8')
    return
  }
  process.stdout.write(json)
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
