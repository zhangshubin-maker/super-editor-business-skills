import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { hashCapabilitySnapshot, validateRulePack } from '../semantic-rule-tools.mjs'
import { compileSpecializedSkill } from '../compile-specialized-skill.mjs'
import { fileSha256, materializeExecutablePack } from './semantic-fixtures.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const skillRoot = path.resolve(__dirname, '..', '..')
const examplePath = path.join(skillRoot, 'references', 'rule-pack.example.json')
const schemaPath = path.join(skillRoot, 'references', 'semantic-rule-pack.schema.json')
const cliPath = path.resolve(__dirname, '..', 'semantic-rule-tools.mjs')
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
const temporaryDirectories = []

function tempDirectory(prefix = 'semantic-gates-') {
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

function executablePack({ validated = false } = {}) {
  const root = tempDirectory()
  return { root, pack: materializeExecutablePack(readExample(), root, { validated }) }
}

function errors(pack, root = path.dirname(examplePath)) {
  return validateRulePack(pack, { artifactRoot: root }).errors.join('\n')
}

function readForward(pack, root, index = 0) {
  const entry = pack.execution.forward_cases[index]
  const filename = path.join(root, entry.evidence_artifact)
  return { entry, filename, value: JSON.parse(fs.readFileSync(filename, 'utf8')) }
}

function validateWithSchema(value) {
  const python = [
    'import json, sys, jsonschema',
    'payload = json.load(sys.stdin)',
    'try:',
    "  jsonschema.Draft202012Validator(payload['schema']).validate(payload['value'])",
    'except jsonschema.ValidationError as error:',
    '  print(error.message)',
    '  raise SystemExit(1)'
  ].join('\n')
  let command = 'python'
  if (process.platform === 'win32') {
    const resolved = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "if (Get-Command pyenv -ErrorAction SilentlyContinue) { pyenv which python } else { (Get-Command python).Source }"
    ], { encoding: 'utf8' })
    if (resolved.status === 0 && resolved.stdout.trim()) command = resolved.stdout.trim()
  }
  return spawnSync(command, ['-c', python], { encoding: 'utf8', input: JSON.stringify({ schema, value }) })
}

describe('selector audit evidence gate', () => {
  test('requires the strict claim/observation shape and quarantines IDs in optional_fingerprints', () => {
    const missing = readExample()
    delete missing.rules[0].target.evidence
    assert.match(errors(missing), /at least two auditable/)

    const legacy = readExample()
    legacy.rules[0].target.evidence[0] = {
      class: 'semantic', kind: 'text_role', intent: 'old shape', value: 'old value'
    }
    assert.match(errors(legacy), /unknown fields: intent, value/)
    assert.match(errors(legacy), /claim is required/)

    const spoofedRole = readExample()
    spoofedRole.rules[0].target.role = 'main slot: title-source'
    assert.match(errors(spoofedRole), /role cannot be a fixed slot or identifier disguise/)

    const spoofedEvidence = readExample()
    spoofedEvidence.rules[0].target.evidence[0].claim = 'match element_id abc as the title'
    assert.match(errors(spoofedEvidence), /claim cannot be a fixed slot or identifier disguise/)

    const auxiliary = readExample()
    auxiliary.rules[0].source.optional_fingerprints = [{ kind: 'source_id', value: 'source-1', intent: 'auxiliary only' }]
    assert.equal(validateRulePack(auxiliary).valid, true)
  })
})

describe('real capability catalog gate', () => {
  test('binds executable snapshots to the referenced tools/list catalog and rejects invented tools', () => {
    const { pack, root } = executablePack()
    assert.equal(validateRulePack(pack, { artifactRoot: root }).valid, true)

    pack.rules[0].action.required_capabilities.push('editor_self_reported_missing_tool')
    pack.execution.capability_snapshot.capabilities.push('editor_self_reported_missing_tool')
    pack.execution.capability_snapshot.snapshot_hash = hashCapabilitySnapshot(
      pack.execution.capability_snapshot.capabilities,
      pack.execution.capability_snapshot.catalog_hash
    )
    assert.match(errors(pack, root), /absent from the referenced catalog: editor_self_reported_missing_tool/)
  })

  test('rejects catalog tampering and catalog-hash substitution', () => {
    const { pack, root } = executablePack()
    const catalogPath = path.join(root, pack.execution.capability_snapshot.catalog_path)
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
    catalog.tools.pop()
    fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`)
    assert.match(errors(pack, root), /catalog_hash does not match the canonical catalog/)

    pack.execution.capability_snapshot.catalog_hash = `sha256:${'f'.repeat(64)}`
    assert.match(errors(pack, root), /catalog_hash must equal the referenced catalog hash/)
  })
})

describe('forward evidence artifact gate', () => {
  test('accepts two independent real JSON artifact chains', () => {
    const { pack, root } = executablePack({ validated: true })
    assert.equal(validateRulePack(pack, { artifactRoot: root }).valid, true)
  })

  test('compiled specialized skills carry the bound catalog and complete forward artifact chain', () => {
    const { pack, root } = executablePack({ validated: true })
    const output = tempDirectory('semantic-compiled-artifacts-')
    const compiled = compileSpecializedSkill(pack, output, { artifactRoot: root })
    assert.ok(compiled.files.includes('references/super-editor-capability-catalog.json'))
    for (const forwardCase of pack.execution.forward_cases) {
      assert.equal(fs.existsSync(path.join(compiled.output, 'references', forwardCase.evidence_artifact)), true)
      const artifact = JSON.parse(fs.readFileSync(path.join(root, forwardCase.evidence_artifact), 'utf8'))
      for (const link of ['source', 'template', 'target_before', 'target_after', 'save_receipt', 'provenance_readback', 'acceptance_report']) {
        const nested = path.normalize(path.join(path.dirname(forwardCase.evidence_artifact), artifact[link].artifact))
        assert.equal(fs.existsSync(path.join(compiled.output, 'references', nested)), true, `${forwardCase.id}:${link}`)
      }
    }
  })

  test('rejects outer file tampering, case substitution and nested receipt-hash self reports', () => {
    const first = executablePack({ validated: true })
    const outer = readForward(first.pack, first.root)
    outer.value.case_id = 'forward-b'
    fs.writeFileSync(outer.filename, `${JSON.stringify(outer.value, null, 2)}\n`)
    assert.match(errors(first.pack, first.root), /artifact_sha256 does not match the evidence artifact file/)
    assert.match(errors(first.pack, first.root), /artifact\.case_id must equal forward-a/)

    const second = executablePack({ validated: true })
    const evidence = readForward(second.pack, second.root)
    evidence.value.save_receipt.receipt_hash = `sha256:${'9'.repeat(64)}`
    fs.writeFileSync(evidence.filename, `${JSON.stringify(evidence.value, null, 2)}\n`)
    evidence.entry.artifact_sha256 = fileSha256(evidence.filename)
    assert.match(errors(second.pack, second.root), /save_receipt\.receipt_hash must equal the canonical hash/)
  })

  test('rejects reused source/target artifacts and failed acceptance reports', () => {
    const reused = executablePack({ validated: true })
    reused.pack.execution.forward_cases[1] = structuredClone(reused.pack.execution.forward_cases[0])
    reused.pack.execution.forward_cases[1].id = 'forward-b'
    reused.pack.forward_tests[1].evidence_artifact = reused.pack.forward_tests[0].evidence_artifact
    assert.match(errors(reused.pack, reused.root), /evidence artifact\.case_id must equal forward-b/)
    assert.match(errors(reused.pack, reused.root), /different evidence artifacts, source IDs and semantic snapshot hashes/)

    const failed = executablePack({ validated: true })
    const outer = readForward(failed.pack, failed.root)
    const reportPath = path.resolve(path.dirname(outer.filename), outer.value.acceptance_report.artifact)
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    report.status = 'failed'
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    outer.value.acceptance_report.artifact_sha256 = fileSha256(reportPath)
    outer.value.acceptance_report.report_hash = `sha256:${'8'.repeat(64)}`
    fs.writeFileSync(outer.filename, `${JSON.stringify(outer.value, null, 2)}\n`)
    outer.entry.artifact_sha256 = fileSha256(outer.filename)
    assert.match(errors(failed.pack, failed.root), /acceptance report\.status must be passed/)
  })
})

describe('JSON Schema structural baseline', () => {
  test('covers expressible shape constraints while the CLI remains authoritative for hashes and cross-file bindings', () => {
    const cases = [
      { value: readExample(), valid: true },
      (() => { const value = readExample(); value.rules[0].id = 'Bad ID'; return { value, valid: false } })(),
      (() => { const value = readExample(); value.rules[0].action.required_capabilities = []; return { value, valid: false } })(),
      (() => { const value = readExample(); value.rules[0].action = { type: 'atomic_sequence', intent: 'missing recursive steps', required_capabilities: ['editor_text_document'] }; return { value, valid: false } })(),
      (() => { const value = readExample(); value.rules[0].source.evidence[0].unexpected = true; return { value, valid: false } })()
    ]
    for (const [index, entry] of cases.entries()) {
      assert.equal(validateRulePack(entry.value).valid, entry.valid, `CLI library case ${index}`)
      const schemaResult = validateWithSchema(entry.value)
      assert.equal(schemaResult.status === 0, entry.valid, `schema case ${index}: ${schemaResult.stdout}${schemaResult.stderr}`)
    }
  })
})
