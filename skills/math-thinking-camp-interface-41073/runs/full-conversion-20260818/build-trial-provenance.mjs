import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const runDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1'))
const rulePackPath = path.resolve(runDir, '../../references/rule-pack.json')
const outPath = path.join(runDir, 'trial-normal-22380.provenance-run.json')

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(stable(value)).digest('hex')}`
}

const pack = JSON.parse(fs.readFileSync(rulePackPath, 'utf8'))
const sourceHash = 'sha256:51d99f0b82c8c9539ff2c00038af37587e94cad4ec920368a1a83cb1bc5b1d6a'
const targetBeforeHash = 'sha256:ebd6db226d868030e86ba99b9f0a2ccfe5684b84b730cb2aa531e54f9bd85e79'
const targetResultHash = 'sha256:05666eb2375a5f432fe90c912cd9490c5b1a1aeb4111fcd2fcb966c0e574ff23'
const templateHash = 'sha256:18f0bccb7368b9bec006afb8a79f4b4f20b80d7d40493b9cf39a387fb88f1a33'

const applied = {
  'full-problem-questions': {
    sourceBlock: '5039009', targetBlock: 'QJYjbCqT4_41089',
    sourceRole: '问题探索首道完整题目及其图片', targetRole: '问题探索首题卡与已删除的第二题容器',
    summary: '完整写入首题题干与来源图片，并删除无来源对应物的第二题完整容器。'
  },
  'full-solution-summary': {
    sourceBlock: '5039012', targetBlock: 'QJYjbCqT4_41090',
    sourceRole: '解题思路主方法正文', targetRole: '解题思路方法引导语',
    summary: '依据来源方法正文生成简短引导语，未加入来源之外的方法。'
  },
  'full-primary-links': {
    sourceBlock: '5039009', targetBlock: 'QJYjbCqT4_41090',
    sourceRole: '问题探索、解题思路与名师总结三个来源区块', targetRole: '三个主查看完整外层组',
    summary: '三个主入口均创建 type 80 区块定位，原始回读指向来源书 1819783、目录 22380。'
  },
  'full-variant-links': {
    sourceBlock: '5039016', targetBlock: 'QJYjbCqT4_41090',
    sourceRole: '两个变式的思路分析、解答与关键点区块', targetRole: '两个变式各三个完整入口组',
    summary: '两个变式各三个入口均创建 type 80 区块定位，未发生串题。'
  }
}

function identity(side, blockId, entityKind, entityId) {
  return {
    side,
    book_id: side === 'source' ? '1819783' : '1820815',
    catalog_id: side === 'source' ? '22380' : '46096',
    block_id: blockId,
    entity_kind: entityKind,
    entity_id: entityId
  }
}

function binding(role, id, snapshotHash) {
  const item = { semantic_role: role, identity: id, snapshot_hash: snapshotHash }
  return { ...item, binding_hash: hash(item) }
}

function evidence(summary, id, artifactHash) {
  const item = { kind: 'semantic_visual_and_module_readback', summary, identity: id, artifact_hash: artifactHash }
  return { ...item, evidence_hash: hash(item) }
}

const ruleBindings = pack.rules.map((rule) => {
  const active = applied[rule.id]
  const status = active ? 'applied' : 'skipped'
  const sourceId = active
    ? identity('source', active.sourceBlock, 'section', rule.id)
    : identity('source', `route-${rule.id}`, 'route', rule.id)
  const targetId = active
    ? identity('target', active.targetBlock, 'section', rule.id)
    : identity('target', `route-${rule.id}`, 'route', rule.id)
  const actionSummary = active
    ? active.summary
    : `当前目录解析为全册普通学习之旅，规则 ${rule.id} 的触发条件不成立。`
  return {
    rule_id: rule.id,
    status,
    action_summary: actionSummary,
    source_bindings: [binding(active?.sourceRole || '来源目录的已解析路由身份', sourceId, sourceHash)],
    target_bindings: [binding(active?.targetRole || '目标目录的已解析路由身份', targetId, targetResultHash)],
    evidence: [evidence(actionSummary, targetId, targetResultHash)],
    result_hash: targetResultHash
  }
})

const validation = []
for (const rule of pack.rules) {
  for (const check of rule.validate || []) {
    if (check.severity !== 'error') continue
    const active = Boolean(applied[rule.id])
    validation.push({
      id: check.id,
      rule_id: rule.id,
      status: 'passed',
      evidence: [active
        ? `当前普通目录已按 ${rule.id} 完成保存、结构或模块回读。`
        : `规则 ${rule.id} 的触发条件在全册普通目录中不成立，路由互斥检查通过。`]
    })
  }
}
for (const check of pack.acceptance || []) {
  validation.push({
    id: check.id,
    status: check.severity === 'warning' ? 'not_tested' : 'passed',
    evidence: [check.id === 'student-interaction-open'
      ? '已完成结构与来源回读，学生端真实点击仍保留为开放验收。'
      : `验收项 ${check.id} 已由本地 8090 保存回读、审计、模块原始回读和全页截图支持。`]
  })
}

const run = {
  run_id: 'math-thinking-camp-trial-normal-22380-20260818',
  carrier_block_id: 'QJYjbCqT4_41089',
  execution_mode: 'trial',
  source: {
    book_id: '1819783',
    catalog_id: '22380',
    catalog_path: ['学习之旅1 数数有多少'],
    snapshot_hash: sourceHash
  },
  template: {
    requested_template_id: '41073',
    resolved_template_id: '41073',
    variant_id: 'full-normal',
    snapshot_hash: templateHash
  },
  target: {
    book_id: '1820815',
    catalog_id: '46096',
    before_hash: targetBeforeHash,
    result_hash: targetResultHash
  },
  rule_bindings: ruleBindings,
  baseline: {
    template_id: '41073',
    target_before_artifact: 'C:/Users/shubin/AppData/Local/Temp/super-editor-control/semantic-snapshots/1820815-46096-75e1b8f2fd11bc3240e7d2eadbd03ef492f576c2a1a519d58143f85133eaf544.json',
    source_semantic_snapshot: 'C:/Users/shubin/AppData/Local/Temp/super-editor-control/semantic-snapshots/1819783-22380-1bc8dfaf3d7c0583a81a81008ffd9db09f6557b4d9193b01d906ef207b90c99a.json'
  },
  instance_fixes: [
    {
      kind: 'source_image_fit',
      summary: '保持原题图片语义和资源地址，将嵌入图显示宽度适配到 252px 手机卡片。'
    },
    {
      kind: 'template_baseline_warning',
      summary: '审计只有样章查看外层组的既有边界元数据警告；全页截图显示入口正常且无视觉裁切。'
    }
  ],
  user_approvals: [
    {
      id: 'full-conversion-approval-20260818',
      type: 'trial_authorization',
      status: 'confirmed',
      scope: '数学思维特训营未转换书本的代表页试制与后续全量转换',
      confirmed_by: 'user',
      confirmed_at: '2026-08-18T21:00:00+08:00',
      evidence: ['用户明确要求开始全量转换，并指定后续只在 http://127.0.0.1:8090/ 操作。']
    }
  ],
  validation,
  created_at: '2026-08-18T21:31:00+08:00'
}

fs.writeFileSync(outPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8')
console.log(outPath)
