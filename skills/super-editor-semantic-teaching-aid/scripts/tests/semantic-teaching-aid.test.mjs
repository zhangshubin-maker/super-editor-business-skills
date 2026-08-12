import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  atomicWriteText,
  hashJson,
  validateRulePack,
  writeJson
} from '../semantic-rule-tools.mjs'
import { compileSpecializedSkill } from '../compile-specialized-skill.mjs'
import { createProvenance, matchSourceCandidates, planRefinement, validateProvenance } from '../provenance-tools.mjs'
import {
  acquireLock,
  initLedger,
  lockStatus,
  releaseLock,
  transitionLedger,
  validateLedger
} from '../batch-ledger.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const skillRoot = path.resolve(__dirname, '..', '..')
const examplePath = path.join(skillRoot, 'references', 'rule-pack.example.json')
const ledgerCli = path.resolve(__dirname, '..', 'batch-ledger.mjs')
const temporaryDirectories = []

function tempDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true })
})

function readExample() {
  return JSON.parse(fs.readFileSync(examplePath, 'utf8'))
}

function sha(character) {
  return `sha256:${character.repeat(64)}`
}

function trialPack() {
  const pack = readExample()
  pack.identity.status = 'trial_approved'
  pack.templates.default.snapshot_hash = sha('a')
  pack.templates.variants.forEach((variant) => { variant.snapshot_hash = sha('b') })
  return pack
}

function validatedPack() {
  const pack = trialPack()
  pack.identity.status = 'validated'
  pack.forward_tests = [
    { id: 'forward-a', source_label: '不同结构课时 A', status: 'passed', evidence: ['保存回读与视觉验收通过'], result_hash: sha('c') },
    { id: 'forward-b', source_label: '单元复习 B', status: 'passed', evidence: ['特殊样章路由及交互验收通过'], result_hash: sha('d') }
  ]
  return pack
}

describe('semantic rule pack', () => {
  test('accepts the open semantic model and hashes arbitrary canonical JSON', () => {
    const pack = readExample()
    assert.deepEqual(validateRulePack(pack), { valid: true, errors: [], warnings: [] })
    assert.equal(hashJson({ b: 2, a: { d: 4, c: 3 } }), hashJson({ a: { c: 3, d: 4 }, b: 2 }))

    pack.rules[0].action = {
      type: 'atomic_sequence',
      intent: '执行一个当前常见动作表未覆盖的组合意图',
      required_capabilities: ['editor_get_canvas_tree'],
      steps: [{
        type: 'custom_atomic_action',
        intent: '调用未来新增但已验证的通用原子能力',
        required_capabilities: ['editor_future_atomic'],
        parameters: { semantic: true }
      }]
    }
    assert.equal(validateRulePack(pack).valid, true)
  })

  test('guards ID-only matching and maturity evidence', () => {
    const pack = readExample()
    pack.rules[0].target.anchors = [{ kind: 'element_id', value: 'runtime-1' }]
    const invalidId = validateRulePack(pack)
    assert.equal(invalidId.valid, false)
    assert.match(invalidId.errors.join('\n'), /runtime-only ID/)

    const trial = trialPack()
    trial.templates.default.snapshot_hash = null
    assert.match(validateRulePack(trial).errors.join('\n'), /templates\.default\.snapshot_hash is required/)

    const validated = validatedPack()
    assert.equal(validateRulePack(validated).valid, true)
    validated.forward_tests[0].evidence = []
    assert.match(validateRulePack(validated).errors.join('\n'), /evidence must be non-empty when passed/)
  })

  test('controlled replace overwrites an existing UTF-8 file repeatedly', () => {
    const directory = tempDirectory('semantic-atomic-')
    const filename = path.join(directory, '中文.json')
    atomicWriteText(filename, '第一版')
    atomicWriteText(filename, '第二版')
    writeJson(filename, { version: 3, title: '第三版' })
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), { version: 3, title: '第三版' })
    assert.deepEqual(fs.readdirSync(directory), ['中文.json'])
  })
})

describe('specialized skill compiler', () => {
  test('compiles a self-contained trial skill and safely refreshes generated files', () => {
    const output = tempDirectory('semantic-compiled-')
    const pack = trialPack()
    const first = compileSpecializedSkill(pack, output)
    assert.equal(first.rule_pack_hash, hashJson(pack))
    const target = first.output
    for (const filename of first.files) assert.equal(fs.existsSync(path.join(target, filename)), true, filename)
    fs.writeFileSync(path.join(target, 'user-note.txt'), 'preserve me', 'utf8')
    assert.throws(() => compileSpecializedSkill(pack, output), /target already exists/)
    const refreshed = compileSpecializedSkill(pack, output, { force: true })
    assert.equal(fs.readFileSync(path.join(target, 'user-note.txt'), 'utf8'), 'preserve me')
    assert.match(refreshed.warnings.join('\n'), /preserved unmanaged file: user-note\.txt/)
    assert.match(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), /语义角色、基数、结构与锚点共同匹配/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'references', 'rule-pack.json'), 'utf8')).identity.status, 'trial_approved')
    const quickValidate = path.join(process.env.USERPROFILE, '.codex', 'skills', '.system', 'skill-creator', 'scripts', 'quick_validate.py')
    const python = path.join(process.env.USERPROFILE, '.pyenv', 'pyenv-win', 'shims', 'python.bat')
    const validation = spawnSync(python, [quickValidate, target], {
      encoding: 'utf8',
      shell: true,
      env: { ...process.env, PYTHONUTF8: '1' }
    })
    assert.equal(validation.status, 0, validation.stderr || validation.stdout)
  })

  test('refuses draft packs', () => {
    assert.throws(() => compileSpecializedSkill(readExample(), tempDirectory('semantic-draft-')), /only trial_approved or validated/)
  })

  test('force refuses to overwrite a non-managed skill directory', () => {
    const output = tempDirectory('semantic-unmanaged-')
    const pack = trialPack()
    const target = path.join(output, pack.identity.skill_name)
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'SKILL.md'), 'user owned skill', 'utf8')
    assert.throws(() => compileSpecializedSkill(pack, output, { force: true }), /unmanaged skill directory/)
    assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), 'user owned skill')
  })
})

describe('semantic provenance and refinement', () => {
  function runSpec() {
    return {
      run_id: 'run-001',
      carrier_block_id: 'carrier-block',
      source: { book_id: 'source-book', catalog_id: 'source-catalog', catalog_path: ['第一单元', '第1课'], snapshot_hash: sha('1') },
      template: { requested_template_id: '41073', resolved_template_id: '41073', variant_id: null, snapshot_hash: sha('2') },
      target: { book_id: 'target-book', catalog_id: 'target-catalog', before_hash: sha('3'), result_hash: sha('4') },
      rule_bindings: [{
        rule_id: 'replace-lesson-title',
        status: 'applied',
        action_summary: '替换本课标题并保留样章样式',
        source_bindings: [{ element_id: 'source-runtime', role: '本课主标题' }],
        target_bindings: [{ element_id: 'target-runtime', role: '样章主标题' }],
        evidence: [{ kind: 'semantic+structure', summary: '标题角色唯一且基数为 1' }],
        result_hash: sha('5')
      }],
      baseline: { 'replace-lesson-title:target-runtime': { text: '分数的认识', left: 20 } },
      instance_fixes: [],
      user_approvals: ['用户批准本次试制'],
      validation: [{ id: 'page-save-readback', status: 'passed', evidence: ['保存回读通过'] }],
      created_at: '2026-08-12T00:00:00.000Z'
    }
  }

  test('records semantic rule bindings and detects tampering', () => {
    const created = createProvenance(trialPack(), runSpec())
    assert.equal(created.editor_update_block.arguments.patch.ai_semantic_provenance.skill.name, trialPack().identity.skill_name)
    assert.deepEqual(validateProvenance(created), { valid: true, errors: [], warnings: [] })
    created.provenance.rule_bindings[0].action_summary = 'tampered'
    assert.match(validateProvenance(created).errors.join('\n'), /integrity_hash/)
  })

  test('plans generic three-way refinements without fixed slots', () => {
    const plan = planRefinement({
      baseline: { title: { text: '旧标题' }, button: { module: 'old' }, layout: { left: 10 } },
      current: { title: { text: '旧标题' }, button: { module: 'manual' }, layout: { left: 20 } },
      desired: { title: { text: '新标题' }, button: { module: 'new' }, layout: { left: 10 } }
    })
    assert.deepEqual(plan.summary, { safe: 1, noop: 1, conflict: 1 })
    assert.equal(plan.safe_changes[0].target, 'title')
    assert.equal(plan.conflicts[0].target, 'button')

    const deleted = planRefinement({
      baseline: { remove: { text: '旧值' } },
      current: {},
      desired: { remove: { $delete: true } }
    })
    assert.equal(deleted.summary.noop, 1)
    assert.equal(deleted.noops[0].reason, 'current_already_matches_desired')
    assert.equal(deleted.noops[0].operation, 'delete')
    assert.equal(deleted.noops[0].current_present, false)
    assert.equal(deleted.noops[0].desired_present, false)
  })

  test('recalls untraced source metadata candidates without emitting a write', () => {
    const result = matchSourceCandidates({
      query: {
        book_name: '三年级数学上册同步练习',
        subject: '数学',
        grade: '三年级',
        volume: '上册',
        catalog_path: ['第一单元', '第1课'],
        catalog_name: '第1课',
        catalog_sort: 1
      },
      candidates: [
        {
          candidate_id: 'source-exact',
          book_name: '三年级数学上册同步练习',
          subject: '数学',
          grade: '三年级',
          volume: '上',
          catalog_path: '第一单元/第1课',
          catalog_name: '第1课',
          catalog_sort: 1
        },
        {
          candidate_id: 'wrong-subject',
          book_name: '三年级语文上册同步练习',
          subject: '语文',
          grade: '三年级',
          volume: '上册',
          catalog_path: '第一单元/第1课'
        }
      ]
    })
    assert.equal(result.top_candidate_id, 'source-exact')
    assert.equal(result.unique, true)
    assert.equal(result.requires_human_confirmation, true)
    assert.equal(result.automatic_write, false)
    assert.deepEqual(result.candidates.find((item) => item.candidate_id === 'wrong-subject').rejection_reasons, ['subject_mismatch'])
    assert.equal('editor_update_block' in result, false)
  })
})

describe('batch ledger and target lock', () => {
  test('removes a lock file when initial durable write fails', () => {
    const directory = tempDirectory('semantic-lock-failure-')
    const originalFsync = fs.fsyncSync
    fs.fsyncSync = () => { throw new Error('injected fsync failure') }
    try {
      assert.throws(() => acquireLock(directory, 'target-failure', 'owner'), /injected fsync failure/)
    } finally {
      fs.fsyncSync = originalFsync
    }
    assert.equal(lockStatus(directory, 'target-failure').held, false)
    const lock = acquireLock(directory, 'target-failure', 'owner')
    assert.equal(lock.held, true)
    releaseLock(directory, 'target-failure', 'owner')
  })

  test('enforces exclusive persistent locks and valid transition evidence', () => {
    const directory = tempDirectory('semantic-ledger-')
    const lockDirectory = path.join(directory, 'locks')
    const pack = validatedPack()
    let ledger = initLedger(pack, [{ item_id: 'book-a', target_book_id: 'target-100', source_book_id: 'source-100' }], { now: '2026-08-12T00:00:00.000Z' })
    const lock = acquireLock(lockDirectory, 'target-100', 'run-owner', { now: '2026-08-12T00:00:01.000Z' })
    assert.throws(() => acquireLock(lockDirectory, 'target-100', 'other-owner'), /already locked/)
    assert.throws(() => releaseLock(lockDirectory, 'target-100', 'other-owner'), /belongs to run-owner/)

    ledger = transitionLedger(ledger, 'book-a', 'planned', {}, { lock, now: '2026-08-12T00:00:02.000Z' })
    ledger = transitionLedger(ledger, 'book-a', 'preflighted', {
      fingerprint: {
        source_snapshot_hash: sha('1'),
        template_snapshot_hash: sha('2'),
        target_before_hash: sha('3'),
        resolved_template_id: '41073'
      }
    }, { lock, now: '2026-08-12T00:00:03.000Z' })
    ledger = transitionLedger(ledger, 'book-a', 'outcome_unknown', { reason: 'editor response timed out' }, { lock })
    assert.throws(() => transitionLedger(ledger, 'book-a', 'applied', { target_after_hash: sha('4') }, { lock }), /readback_recovery/)
    ledger = transitionLedger(ledger, 'book-a', 'applied', { target_after_hash: sha('4'), readback_recovery: true }, { lock })
    assert.equal(validateLedger(ledger).valid, true)

    const ledgerFile = path.join(directory, 'ledger.json')
    writeJson(ledgerFile, ledger)
    writeJson(ledgerFile, ledger)
    assert.equal(validateLedger(JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))).valid, true)
    assert.equal(lockStatus(lockDirectory, 'target-100').held, true)
    assert.deepEqual(releaseLock(lockDirectory, 'target-100', 'run-owner'), {
      released: true,
      target_book_id: 'target-100',
      owner: 'run-owner'
    })
    assert.equal(lockStatus(lockDirectory, 'target-100').held, false)
  })

  test('CLI lock acquire/status/release round-trips', () => {
    const directory = tempDirectory('semantic-lock-cli-')
    const common = ['--lock-dir', directory, '--target-book', 'target-cli']
    const acquire = spawnSync(process.execPath, [ledgerCli, 'acquire-lock', ...common, '--owner', 'owner-cli'], { encoding: 'utf8' })
    assert.equal(acquire.status, 0, acquire.stderr)
    assert.equal(JSON.parse(acquire.stdout).held, true)
    const status = spawnSync(process.execPath, [ledgerCli, 'lock-status', ...common], { encoding: 'utf8' })
    assert.equal(JSON.parse(status.stdout).owner, 'owner-cli')
    const release = spawnSync(process.execPath, [ledgerCli, 'release-lock', ...common, '--owner', 'owner-cli'], { encoding: 'utf8' })
    assert.equal(release.status, 0, release.stderr)
    assert.equal(JSON.parse(release.stdout).released, true)
  })

  test('CLI transitions replace the same ledger file repeatedly on Windows', () => {
    const directory = tempDirectory('semantic-ledger-cli-')
    const lockDirectory = path.join(directory, 'locks')
    const packFile = path.join(directory, 'pack.json')
    const booksFile = path.join(directory, 'books.json')
    const ledgerFile = path.join(directory, 'ledger.json')
    const preflightFile = path.join(directory, 'preflight.json')
    writeJson(packFile, validatedPack())
    writeJson(booksFile, [{ item_id: 'cli-item', target_book_id: 'cli-target' }])
    writeJson(preflightFile, {
      fingerprint: {
        source_snapshot_hash: sha('1'),
        template_snapshot_hash: sha('2'),
        target_before_hash: sha('3'),
        resolved_template_id: '41073'
      }
    })
    const init = spawnSync(process.execPath, [ledgerCli, 'init', '--rule-pack', packFile, '--books', booksFile, '--out', ledgerFile], { encoding: 'utf8' })
    assert.equal(init.status, 0, init.stderr)
    const lockArgs = ['--lock-dir', lockDirectory, '--target-book', 'cli-target', '--owner', 'cli-owner']
    assert.equal(spawnSync(process.execPath, [ledgerCli, 'acquire-lock', ...lockArgs], { encoding: 'utf8' }).status, 0)
    const common = ['--ledger', ledgerFile, '--item', 'cli-item', '--lock-dir', lockDirectory, '--owner', 'cli-owner']
    const planned = spawnSync(process.execPath, [ledgerCli, 'transition', ...common, '--to', 'planned'], { encoding: 'utf8' })
    assert.equal(planned.status, 0, planned.stderr)
    const preflighted = spawnSync(process.execPath, [ledgerCli, 'transition', ...common, '--to', 'preflighted', '--evidence', preflightFile], { encoding: 'utf8' })
    assert.equal(preflighted.status, 0, preflighted.stderr)
    assert.equal(JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).items[0].state, 'preflighted')
    assert.equal(spawnSync(process.execPath, [ledgerCli, 'release-lock', ...lockArgs], { encoding: 'utf8' }).status, 0)
  })
})
