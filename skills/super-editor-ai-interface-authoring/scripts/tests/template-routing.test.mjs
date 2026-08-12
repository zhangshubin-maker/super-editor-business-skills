import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test, { before } from 'node:test'

import {
  buildRuleRegistry,
  loadRoutingConfig,
  validateRoutingTargets
} from '../build-rule-registry.mjs'
import {
  matchBookTemplate,
  resolveCatalogTemplate,
  resolveTemplateRoute
} from '../resolve-template-route.mjs'

let routing
let registry

before(async () => {
  routing = await loadRoutingConfig()
  registry = await buildRuleRegistry({ routing })
})

const EXPECTED_BOOK_TEMPLATE_IDS = [
  36901, 36885, 36905, 41045, 41051, 40998, 41006, 41161,
  41144, 41174, 41185, 41039, 41392, 36910, 36914, 36921,
  41070, 41071, 41072, 41073, 41074, 41076, 36928, 36929,
  36930, 41097, 41098, 41099, 41100, 41101, 41102, 41103
]

test('keeps the exact 32-item legacy book matching order', () => {
  assert.deepEqual(
    routing.book_template_match_order.map(item => item.id),
    EXPECTED_BOOK_TEMPLATE_IDS
  )
  const firstMatchWins = matchBookTemplate('语文课前预习学霸笔记', 4, routing)
  assert.equal(firstMatchWins.id, 36901)
  assert.equal(firstMatchWins.index, 0)
})

test('book matching config is an exact extraction of the legacy drawer list', async () => {
  const source = await readFile(routing.sources.book_match, 'utf8')
  const listSource = source.slice(source.indexOf('this.templateList = ['), source.indexOf('this.autoMatchTemplate()', source.indexOf('this.templateList = [')))
  const extracted = []
  const itemPattern = /\{\s*id:\s*(\d+),\s*name:\s*'([^']*)',\s*matchs:\s*\[([^\]]*)\](?:,\s*grade_list:\s*\[([^\]]*)\])?\s*\}/g
  for (const match of listSource.matchAll(itemPattern)) {
    const entry = {
      id: Number(match[1]),
      name: match[2],
      matchs: [...match[3].matchAll(/'([^']*)'/g)].map(keyword => keyword[1])
    }
    if (match[4] != null) entry.grade_list = match[4].split(',').map(value => Number(value.trim()))
    extracted.push(entry)
  }
  assert.deepEqual(extracted, routing.book_template_match_order)
})

test('作文不难 uses the exact grade split and does not guess without a grade', () => {
  assert.equal(matchBookTemplate('小学作文不难', 3, routing).id, 41039)
  assert.equal(matchBookTemplate('小学作文不难', 6, routing).id, 41039)
  assert.equal(matchBookTemplate('小学作文不难', 1, routing).id, 41392)
  assert.equal(matchBookTemplate('小学作文不难', 2, routing).id, 41392)
  assert.equal(matchBookTemplate('小学作文不难', null, routing), null)
})

test('keeps analysed but unrouted special templates available for explicit selection', () => {
  assert.deepEqual(routing.registry.registered_unrouted_template_ids, [41058, 41063, 41196])
  const ids = new Set(registry.templates.map(item => item.template_id))
  for (const id of routing.registry.registered_unrouted_template_ids) assert.equal(ids.has(id), true)
})

test('preserves all catalog special routes and their priority', () => {
  const cases = [
    [36885, '古诗期中', '语文', 36893, 1],
    [41045, '第二周期中', '语文', 41008, 2],
    [41045, '第11周', '语文', 41008, 2],
    [41073, '能力达标期中', '数学', 41075, 3],
    [41099, '单元测试期末', '英语', 36959, 4],
    [41101, '单元测试期末', '英语', 36959, 4],
    [41058, '期中期末', '语文', 36955, 5],
    [41058, '期末', '语文', 36956, 5],
    [41058, '期中', '数学', 36957, 5],
    [41058, '期末', '数学', 36958, 5],
    [41058, '期中', '英语', 36959, 5],
    [41058, '期末', '英语', 36960, 5],
    [41058, '阶段一练习附录', '语文', 41007, 6],
    [41058, '综合专项练习', '语文', 41008, 7],
    [41058, '专题一练习', '语文', 41231, 8],
    [41058, '专项一训练', '语文', 41231, 8],
    [41058, '附录A', '语文', 41067, 9]
  ]

  for (const [requested, catalogName, subject, expectedId, expectedPriority] of cases) {
    const result = resolveCatalogTemplate(requested, catalogName, subject, routing)
    assert.equal(result.resolved_template_id, expectedId, `${requested} / ${catalogName} / ${subject}`)
    assert.equal(result.catalog_route.priority, expectedPriority, `${requested} / ${catalogName} / ${subject}`)
  }

  assert.equal(resolveCatalogTemplate(41045, '第一周', '语文', routing).resolved_template_id, 41045)
  assert.equal(resolveCatalogTemplate(41045, '第十周', '语文', routing).resolved_template_id, 41045)
  assert.equal(resolveCatalogTemplate(41058, '附录', '数学', routing).resolved_template_id, 41058)
})

test('explicit unlocked templates still route, while explicit locked templates never route', () => {
  const unlocked = resolveTemplateRoute({
    explicit_template_id: 36885,
    subject: '语文',
    catalog_name: '古诗'
  }, { routing, registry })
  assert.equal(unlocked.selection_source, 'explicit')
  assert.equal(unlocked.template_locked, false)
  assert.equal(unlocked.requested_template_id, 36885)
  assert.equal(unlocked.resolved_template_id, 36893)
  assert.equal(unlocked.catalog_route.key, 'chinese-poem-from-36885')

  const locked = resolveTemplateRoute({
    explicit_template_id: 36885,
    explicit_template_locked: true,
    book_name: '语文课前预习',
    subject: '语文',
    catalog_name: '古诗期中'
  }, { routing, registry })
  assert.equal(locked.selection_source, 'explicit_locked')
  assert.equal(locked.template_locked, true)
  assert.equal(locked.requested_template_id, 36885)
  assert.equal(locked.resolved_template_id, 36885)
  assert.equal(locked.catalog_route, null)
  assert.equal(locked.book_match, null)

  const lockedAlias = resolveTemplateRoute({
    locked_template_id: 41058,
    subject: '语文',
    catalog_name: '期中'
  }, { routing, registry })
  assert.equal(lockedAlias.resolved_template_id, 41058)
  assert.equal(lockedAlias.template_locked, true)
})

test('unresolved books stay unresolved instead of guessing a template', () => {
  const result = resolveTemplateRoute({
    book_name: '没有任何已知关键词',
    grade_id: 3,
    subject: '语文',
    catalog_name: '第一课'
  }, { routing, registry })
  assert.equal(result.selection_source, 'unresolved')
  assert.equal(result.requested_template_id, null)
  assert.equal(result.resolved_template_id, null)
  assert.equal(result.registry, null)
})

test('registry scans exactly 47 raw/analyse pairs and produces stable hashes and capabilities', async () => {
  const second = await buildRuleRegistry({ routing })
  assert.equal(registry.pair_count, 47)
  assert.deepEqual(registry.templates.map(item => item.template_id), [...registry.templates.map(item => item.template_id)].sort((a, b) => a - b))
  assert.equal(second.registry_sha256, registry.registry_sha256)
  assert.deepEqual(second, registry)
  assert.match(registry.registry_sha256, /^[a-f0-9]{64}$/)
  assert.match(registry.routing_sha256, /^[a-f0-9]{64}$/)

  const totals = registry.templates.reduce((result, item) => {
    result.blocks += item.capabilities.analysis_block_count
    for (const kind of Object.keys(result.slots)) result.slots[kind] += item.capabilities.slot_counts[kind]
    return result
  }, { blocks: 0, slots: { text: 0, image: 0, button: 0, jump: 0, delete: 0 } })
  assert.deepEqual(totals, {
    blocks: 166,
    slots: { text: 338, image: 6, button: 181, jump: 231, delete: 66 }
  })

  const grammarTemplate = registry.templates.find(item => item.template_id === 41098)
  assert.equal(grammarTemplate.capabilities.repeat_group_count, 1)
  assert.deepEqual(grammarTemplate.capabilities.repeat_modes, ['choice_per_instance'])
  assert.match(grammarTemplate.raw_sha256, /^[a-f0-9]{64}$/)
  assert.match(grammarTemplate.analyse_sha256, /^[a-f0-9]{64}$/)
  assert.match(grammarTemplate.pair_sha256, /^[a-f0-9]{64}$/)
})

test('registry validation rejects any unknown book, source, special target, or manual-only id', () => {
  assert.equal(validateRoutingTargets(routing, new Set(registry.templates.map(item => item.template_id))), true)
  const invalid = structuredClone(routing)
  invalid.catalog_route_priority[0].target_template_id = 999999
  assert.throws(
    () => validateRoutingTargets(invalid, new Set(registry.templates.map(item => item.template_id))),
    /999999.*absent from the rule registry/
  )
  assert.throws(
    () => resolveTemplateRoute({ explicit_template_id: 999999 }, { routing, registry }),
    /Requested template 999999 is absent/
  )
})

test('resolver CLI emits provenance-ready requested/resolved IDs and registry hashes', () => {
  const resolverPath = fileURLToPath(new URL('../resolve-template-route.mjs', import.meta.url))
  const run = spawnSync(process.execPath, [
    resolverPath,
    '--explicit-template-id', '41099',
    '--subject', '英语',
    '--catalog-name', '单元测试'
  ], { encoding: 'utf8', windowsHide: true })

  assert.equal(run.status, 0, run.stderr)
  const result = JSON.parse(run.stdout)
  assert.equal(result.requested_template_id, 41099)
  assert.equal(result.resolved_template_id, 36959)
  assert.equal(result.catalog_route.key, 'english-test-from-phonics-or-words')
  assert.match(result.registry.registry_sha256, /^[a-f0-9]{64}$/)
  assert.match(result.registry.routing_sha256, /^[a-f0-9]{64}$/)
  assert.match(result.registry.pair_sha256, /^[a-f0-9]{64}$/)
})
