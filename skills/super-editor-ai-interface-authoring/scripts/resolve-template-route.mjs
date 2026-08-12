#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  buildRuleRegistry,
  DEFAULT_ROUTING_PATH,
  DEFAULT_TEMPLATE_DIR,
  loadRoutingConfig,
  validateRoutingTargets
} from './build-rule-registry.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function normalizeTemplateId(value, label) {
  if (value == null || value === '') return null
  const id = typeof value === 'number' ? value : Number(value)
  assert(Number.isSafeInteger(id) && id > 0, `${label} must be a positive integer; received ${JSON.stringify(value)}`)
  return id
}

function chineseNumToNumber(value) {
  const digitMap = {
    '零': 0,
    '一': 1,
    '二': 2,
    '两': 2,
    '三': 3,
    '四': 4,
    '五': 5,
    '六': 6,
    '七': 7,
    '八': 8,
    '九': 9
  }
  if (!value) return 0
  const tenIndex = value.indexOf('十')
  if (tenIndex !== -1) {
    const tens = tenIndex === 0 ? 1 : digitMap[value[tenIndex - 1]] || 1
    const ones = tenIndex === value.length - 1 ? 0 : digitMap[value[tenIndex + 1]] || 0
    return tens * 10 + ones
  }
  return digitMap[value[0]] != null ? digitMap[value[0]] : 0
}

function parseWeekNumber(name, pattern) {
  if (!name) return 0
  const match = name.match(new RegExp(pattern))
  if (!match) return 0
  return /^\d+$/.test(match[1]) ? Number(match[1]) : chineseNumToNumber(match[1])
}

export function matchBookTemplate(bookName, gradeId, routing) {
  if (!bookName) return null
  for (const [index, item] of routing.book_template_match_order.entries()) {
    if (Array.isArray(item.matchs) && item.matchs.length > 0) {
      if (!item.matchs.every(keyword => bookName.includes(keyword))) continue
    }
    if (Array.isArray(item.grade_list) && item.grade_list.length > 0) {
      if (gradeId == null || !item.grade_list.includes(gradeId)) continue
    }
    return {
      index,
      id: normalizeTemplateId(item.id, `book_template_match_order[${index}].id`),
      name: item.name,
      matchs: [...(item.matchs || [])],
      ...(item.grade_list ? { grade_list: [...item.grade_list] } : {})
    }
  }
  return null
}

function matchCatalogRule(rule, context) {
  const { requestedTemplateId, catalogName, subject } = context
  const sourceIds = (rule.source_template_ids || []).map(Number)
  if (sourceIds.length > 0 && !sourceIds.includes(requestedTemplateId)) return null

  switch (rule.kind) {
    case 'template-subject-contains':
      if (subject === rule.subject && catalogName.includes(rule.contains)) return rule.target_template_id
      return null
    case 'template-contains':
      return catalogName.includes(rule.contains) ? rule.target_template_id : null
    case 'template-week-modulo': {
      const weekNumber = parseWeekNumber(catalogName, rule.week_pattern)
      if (weekNumber > 0 && weekNumber % rule.modulo !== rule.excluded_remainder) {
        return rule.target_template_id
      }
      return null
    }
    case 'subject-period': {
      const subjectTargets = rule.target_by_subject && rule.target_by_subject[subject]
      if (!subjectTargets) return null
      for (const period of rule.period_order || []) {
        if (catalogName.includes(period)) return subjectTargets[period]
      }
      return null
    }
    case 'subject-regex':
      if (subject !== rule.subject) return null
      return (rule.patterns || []).some(pattern => new RegExp(pattern).test(catalogName))
        ? rule.target_template_id
        : null
    case 'subject-contains':
      if (subject === rule.subject && catalogName.includes(rule.contains)) return rule.target_template_id
      return null
    default:
      throw new Error(`Unsupported catalog route kind: ${rule.kind}`)
  }
}

export function resolveCatalogTemplate(requestedTemplateId, catalogName, subject, routing) {
  const requestedId = normalizeTemplateId(requestedTemplateId, 'requested_template_id')
  if (requestedId == null) return { resolved_template_id: null, catalog_route: null }
  const context = {
    requestedTemplateId: requestedId,
    catalogName: catalogName || '',
    subject: subject || ''
  }

  for (const rule of routing.catalog_route_priority) {
    const target = matchCatalogRule(rule, context)
    if (target != null) {
      return {
        resolved_template_id: normalizeTemplateId(target, `${rule.key}.target_template_id`),
        catalog_route: {
          key: rule.key,
          priority: rule.priority
        }
      }
    }
  }

  return { resolved_template_id: requestedId, catalog_route: null }
}

function registryIndex(registry) {
  if (!registry) return null
  assert(Array.isArray(registry.templates), 'Registry templates must be an array')
  return new Map(registry.templates.map(entry => [normalizeTemplateId(entry.template_id, 'registry template_id'), entry]))
}

function projectRegistryEntry(entry, registry) {
  if (!entry) return null
  return {
    registry_sha256: registry.registry_sha256,
    routing_sha256: registry.routing_sha256,
    template_id: entry.template_id,
    raw_path: entry.raw_path,
    analyse_path: entry.analyse_path,
    raw_sha256: entry.raw_sha256,
    analyse_sha256: entry.analyse_sha256,
    pair_sha256: entry.pair_sha256,
    capabilities: entry.capabilities
  }
}

export function resolveTemplateRoute(input, options) {
  const routing = options && options.routing
  const registry = options && options.registry
  assert(routing && typeof routing === 'object', 'resolveTemplateRoute requires options.routing')

  const index = registryIndex(registry)
  if (index) validateRoutingTargets(routing, new Set(index.keys()))

  const lockedTemplateId = normalizeTemplateId(input.locked_template_id, 'locked_template_id')
  const explicitTemplateId = normalizeTemplateId(input.explicit_template_id, 'explicit_template_id')
  const explicitLocked = input.explicit_template_locked === true || lockedTemplateId != null
  if (input.explicit_template_locked === true) {
    assert(explicitTemplateId != null || lockedTemplateId != null, 'explicit_template_locked=true requires explicit_template_id or locked_template_id')
  }
  if (lockedTemplateId != null && explicitTemplateId != null) {
    assert(lockedTemplateId === explicitTemplateId, 'locked_template_id conflicts with explicit_template_id')
  }

  let requestedTemplateId = null
  let selectionSource = 'unresolved'
  let bookMatch = null

  if (explicitLocked) {
    requestedTemplateId = lockedTemplateId ?? explicitTemplateId
    selectionSource = 'explicit_locked'
  } else if (explicitTemplateId != null) {
    requestedTemplateId = explicitTemplateId
    selectionSource = 'explicit'
  } else {
    bookMatch = matchBookTemplate(input.book_name || '', input.grade_id, routing)
    if (bookMatch) {
      requestedTemplateId = bookMatch.id
      selectionSource = 'book_match'
    }
  }

  let resolvedTemplateId = requestedTemplateId
  let catalogRoute = null
  if (requestedTemplateId != null && !explicitLocked) {
    const catalogResult = resolveCatalogTemplate(
      requestedTemplateId,
      input.catalog_name || '',
      input.subject || '',
      routing
    )
    resolvedTemplateId = catalogResult.resolved_template_id
    catalogRoute = catalogResult.catalog_route
  }

  if (index && resolvedTemplateId != null) {
    assert(index.has(requestedTemplateId), `Requested template ${requestedTemplateId} is absent from the rule registry`)
    assert(index.has(resolvedTemplateId), `Resolved template ${resolvedTemplateId} is absent from the rule registry`)
  }

  return {
    schema_version: 1,
    selection_source: selectionSource,
    template_locked: explicitLocked,
    requested_template_id: requestedTemplateId,
    resolved_template_id: resolvedTemplateId,
    book_match: bookMatch,
    catalog_route: catalogRoute,
    registry: index && resolvedTemplateId != null
      ? projectRegistryEntry(index.get(resolvedTemplateId), registry)
      : null
  }
}

async function readJson(filePath) {
  const text = await readFile(path.resolve(filePath), 'utf8')
  return JSON.parse(text.replace(/^\uFEFF/, ''))
}

function parseArgs(argv) {
  const args = { input: {} }
  const valueArgs = {
    '--input': 'inputPath',
    '--routing': 'routingPath',
    '--registry': 'registryPath',
    '--template-dir': 'templateDir',
    '--book-name': 'book_name',
    '--grade-id': 'grade_id',
    '--subject': 'subject',
    '--catalog-name': 'catalog_name',
    '--explicit-template-id': 'explicit_template_id',
    '--locked-template-id': 'locked_template_id'
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--lock-template') {
      args.input.explicit_template_locked = true
      continue
    }
    const key = valueArgs[arg]
    if (!key) throw new Error(`Unknown argument: ${arg}`)
    assert(index + 1 < argv.length, `${arg} requires a value`)
    const value = argv[index + 1]
    if (['inputPath', 'routingPath', 'registryPath', 'templateDir'].includes(key)) args[key] = value
    else if (key === 'grade_id') args.input[key] = /^\d+$/.test(value) ? Number(value) : value
    else args.input[key] = value
    index += 1
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const fileInput = args.inputPath ? await readJson(args.inputPath) : {}
  const input = { ...fileInput, ...args.input }
  const routingPath = args.routingPath || DEFAULT_ROUTING_PATH
  const routing = await loadRoutingConfig(routingPath)
  const registry = args.registryPath
    ? await readJson(args.registryPath)
    : await buildRuleRegistry({
      templateDir: args.templateDir || DEFAULT_TEMPLATE_DIR,
      routingPath,
      routing
    })
  const result = resolveTemplateRoute(input, { routing, registry })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
