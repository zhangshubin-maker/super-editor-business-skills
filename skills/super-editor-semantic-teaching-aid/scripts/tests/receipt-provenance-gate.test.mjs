import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { compileSpecializedSkill } from '../compile-specialized-skill.mjs'
import { hashJson } from '../semantic-rule-tools.mjs'
import {
  createProvenance,
  hashEditorExportBlocks,
  validateProvenance,
  validateProvenanceReadback,
  validateReadbackReceiptArtifact
} from '../provenance-tools.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const skillRoot = path.resolve(__dirname, '..', '..')
const temporaryDirectories = []

afterEach(() => {
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true })
})

function sha(character) {
  return `sha256:${character.repeat(64)}`
}

function rulePack() {
  const pack = JSON.parse(fs.readFileSync(path.join(skillRoot, 'references', 'rule-pack.example.json'), 'utf8'))
  pack.identity.status = 'trial_approved'
  pack.templates.default.snapshot_hash = sha('a')
  pack.templates.variants.forEach((variant) => { variant.snapshot_hash = sha('b') })
  pack.execution.trial_approval = {
    approved: true,
    evidence: ['Fixture simulates an explicitly approved trial rule pack.']
  }
  return pack
}

function identity(side, overrides = {}) {
  return {
    side,
    book_id: `${side}-book`,
    catalog_id: `${side}-catalog`,
    block_id: `${side}-block`,
    entity_kind: 'element',
    entity_id: `${side}-element`,
    ...overrides
  }
}

function binding(side) {
  const value = {
    semantic_role: side === 'source' ? 'source lesson title' : 'target lesson title',
    identity: identity(side),
    snapshot_hash: side === 'source' ? sha('1') : sha('4')
  }
  return { ...value, binding_hash: hashJson(value) }
}

function evidence(boundIdentity = identity('target')) {
  const value = {
    kind: 'semantic-structure-readback',
    summary: 'The declared title identity is unique and visible after the write.',
    identity: boundIdentity,
    artifact_hash: sha('6')
  }
  return { ...value, evidence_hash: hashJson(value) }
}

function trialRun(overrides = {}) {
  return {
    run_id: 'run-receipt-1',
    carrier_block_id: 'carrier-root',
    execution_mode: 'trial',
    source: {
      book_id: 'source-book',
      catalog_id: 'source-catalog',
      catalog_path: ['Unit 1', 'Lesson 1'],
      snapshot_hash: sha('1')
    },
    template: {
      requested_template_id: '41073',
      resolved_template_id: '41073',
      variant_id: null,
      snapshot_hash: sha('2')
    },
    target: {
      book_id: 'target-book',
      catalog_id: 'target-catalog',
      before_hash: sha('3'),
      result_hash: sha('4')
    },
    rule_bindings: [{
      rule_id: 'replace-lesson-title',
      status: 'applied',
      action_summary: 'Replace the lesson title while preserving target styling.',
      source_bindings: [binding('source')],
      target_bindings: [binding('target')],
      evidence: [evidence()],
      result_hash: sha('5')
    }],
    baseline: { title: { text: 'Before' } },
    instance_fixes: [],
    user_approvals: [{
      id: 'trial-approval',
      type: 'trial_authorization',
      status: 'confirmed',
      scope: 'trial',
      confirmed_by: 'user',
      confirmed_at: '2026-08-12T01:00:00.000Z',
      evidence: ['The user authorized this one trial target.']
    }],
    validation: [{
      id: 'title-visible-once',
      rule_id: 'replace-lesson-title',
      status: 'passed',
      evidence: ['One visible title was read back.']
    }, {
      id: 'page-save-readback',
      status: 'passed',
      evidence: ['The trial page passed its pre-provenance checks.']
    }],
    created_at: '2026-08-12T01:00:00.000Z',
    ...overrides
  }
}

function mcpEnvelope(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

function realContractFixture(created) {
  const blocks = [{
    uuid: 'carrier-root',
    template_type: 2,
    template_data_content: {
      name: 'Stable carrier',
      size: { width: 794, height: 240 },
      elements: [],
      ai_semantic_provenance: created.provenance
    },
    template_info: null
  }]
  const pageHash = hashEditorExportBlocks(blocks)
  return {
    exportEnvelope: mcpEnvelope({ slideId: 'target-catalog', blocks }),
    saveEnvelope: mcpEnvelope({
      scope: 'current',
      slideId: 'target-catalog',
      saved: true,
      savedScope: 'current',
      savedSlides: ['target-catalog'],
      verified: true,
      verifiedScope: 'current',
      verifiedSlides: ['target-catalog'],
      contentHash: pageHash,
      persistedContentHash: pageHash,
      dirty: false,
      warnings: []
    })
  }
}

function readback(created, fixture = realContractFixture(created)) {
  return validateProvenanceReadback(fixture.exportEnvelope, created, {
    saveReceipt: fixture.saveEnvelope,
    carrierBlockId: 'carrier-root',
    verifiedAt: '2026-08-12T03:00:00.000Z'
  })
}

function resign(provenance) {
  delete provenance.integrity_hash
  provenance.integrity_hash = hashJson(provenance)
  return provenance
}

describe('strict generated provenance bindings', () => {
  test('requires exact stable binding/evidence fields, hashes, and source/target identities', () => {
    const created = createProvenance(rulePack(), trialRun())
    assert.equal(validateProvenance(created).valid, true)

    const empty = trialRun()
    empty.rule_bindings[0].source_bindings = []
    assert.throws(() => createProvenance(rulePack(), empty), /non-empty source_bindings and target_bindings/)

    const loose = trialRun()
    loose.rule_bindings[0].source_bindings[0].runtime_hint = 'not part of the contract'
    assert.throws(() => createProvenance(rulePack(), loose), /must contain exactly/)

    const wrongIdentity = trialRun()
    wrongIdentity.rule_bindings[0].target_bindings[0] = binding('target')
    wrongIdentity.rule_bindings[0].target_bindings[0].identity.catalog_id = 'other-catalog'
    assert.throws(() => createProvenance(rulePack(), wrongIdentity), /does not match.*target.*identity/)

    const wrongHash = trialRun()
    wrongHash.rule_bindings[0].evidence[0].evidence_hash = sha('9')
    assert.throws(() => createProvenance(rulePack(), wrongHash), /evidence_hash does not match/)

    const mutated = structuredClone(created.provenance)
    mutated.rule_bindings[0].target_bindings[0].binding_hash = sha('8')
    resign(mutated)
    assert.match(validateProvenance(mutated).errors.join('\n'), /binding_hash does not match/)
  })
})

describe('real tool receipt and direct carrier gate', () => {
  test('accepts a strict simulation of the current plugin return contracts and emits a canonical artifact', () => {
    // This is a deterministic contract simulation. It does not claim a browser/editor invocation.
    const created = createProvenance(rulePack(), trialRun())
    const result = readback(created)
    assert.equal(result.valid, true, result.errors.join('\n'))
    assert.equal(result.receipt.kind, 'semantic_provenance_readback_receipt')
    assert.equal(result.receipt.schema_version, 1)
    assert.equal(result.receipt.run_id, created.provenance.run_id)
    assert.equal(result.receipt.identity.target_catalog_id, 'target-catalog')
    assert.equal(result.receipt.save.content_hash, result.receipt.export.page_content_hash)
    assert.equal(result.receipt.provenance_integrity_hash, created.provenance.integrity_hash)
    assert.equal(validateReadbackReceiptArtifact(result.receipt).valid, true)

    const tamperedReceipt = structuredClone(result.receipt)
    tamperedReceipt.identity.target_book_id = 'other-book'
    assert.equal(validateReadbackReceiptArtifact(tamperedReceipt).valid, false)
  })

  test('rejects raw/data envelopes, fake block identities, nested/string carriers, duplicates, and page hash drift', () => {
    const created = createProvenance(rulePack(), trialRun())
    const fixture = realContractFixture(created)
    const exportData = JSON.parse(fixture.exportEnvelope.content[0].text)
    const saveData = JSON.parse(fixture.saveEnvelope.content[0].text)

    assert.match(readback(created, { ...fixture, exportEnvelope: exportData }).errors.join('\n'), /envelope.*exactly: content/)
    assert.match(readback(created, { ...fixture, exportEnvelope: { data: exportData } }).errors.join('\n'), /envelope.*exactly: content/)
    assert.match(readback(created, { ...fixture, saveEnvelope: saveData }).errors.join('\n'), /envelope.*exactly: content/)

    const fakeIdData = structuredClone(exportData)
    fakeIdData.blocks[0].blockId = fakeIdData.blocks[0].uuid
    delete fakeIdData.blocks[0].uuid
    const fakeIdHash = hashEditorExportBlocks(fakeIdData.blocks)
    assert.match(readback(created, {
      exportEnvelope: mcpEnvelope(fakeIdData),
      saveEnvelope: mcpEnvelope({ ...saveData, contentHash: fakeIdHash, persistedContentHash: fakeIdHash })
    }).errors.join('\n'), /exactly one block with uuid/)

    const stringCarrier = structuredClone(exportData)
    stringCarrier.blocks[0].template_data_content = JSON.stringify(stringCarrier.blocks[0].template_data_content)
    assert.match(readback(created, { ...fixture, exportEnvelope: mcpEnvelope(stringCarrier) }).errors.join('\n'), /template_data_content must be an object/)

    const nested = structuredClone(exportData)
    delete nested.blocks[0].template_data_content.ai_semantic_provenance
    nested.blocks[0].template_data_content.payload = { ai_semantic_provenance: created.provenance }
    const nestedBlocksHash = hashEditorExportBlocks(nested.blocks)
    const nestedSave = { ...saveData, contentHash: nestedBlocksHash, persistedContentHash: nestedBlocksHash }
    assert.match(readback(created, {
      exportEnvelope: mcpEnvelope(nested),
      saveEnvelope: mcpEnvelope(nestedSave)
    }).errors.join('\n'), /must exist directly/)

    const duplicate = structuredClone(exportData)
    duplicate.blocks.push(structuredClone(duplicate.blocks[0]))
    const duplicateHash = hashEditorExportBlocks(duplicate.blocks)
    assert.match(readback(created, {
      exportEnvelope: mcpEnvelope(duplicate),
      saveEnvelope: mcpEnvelope({ ...saveData, contentHash: duplicateHash, persistedContentHash: duplicateHash })
    }).errors.join('\n'), /exactly one block with uuid/)

    const extraCarrier = structuredClone(exportData)
    extraCarrier.blocks.push({
      ...structuredClone(extraCarrier.blocks[0]),
      uuid: 'other-root'
    })
    const extraCarrierHash = hashEditorExportBlocks(extraCarrier.blocks)
    assert.match(readback(created, {
      exportEnvelope: mcpEnvelope(extraCarrier),
      saveEnvelope: mcpEnvelope({ ...saveData, contentHash: extraCarrierHash, persistedContentHash: extraCarrierHash })
    }).errors.join('\n'), /exactly one direct provenance carrier/)

    const driftedSave = { ...saveData, contentHash: 'fnv1a32:00000000', persistedContentHash: 'fnv1a32:00000000' }
    assert.match(readback(created, { ...fixture, saveEnvelope: mcpEnvelope(driftedSave) }).errors.join('\n'), /do not reproduce/)

    const unsaved = { ...saveData, saved: false }
    assert.match(readback(created, { ...fixture, saveEnvelope: mcpEnvelope(unsaved) }).errors.join('\n'), /saved=true/)

    const unverified = { ...saveData, verified: false }
    assert.match(readback(created, { ...fixture, saveEnvelope: mcpEnvelope(unverified) }).errors.join('\n'), /verified=true/)

    const wrongSlide = {
      ...saveData,
      slideId: 'other-slide',
      savedSlides: ['other-slide'],
      verifiedSlides: ['other-slide']
    }
    assert.match(readback(created, { ...fixture, saveEnvelope: mcpEnvelope(wrongSlide) }).errors.join('\n'), /slideId does not match/)
  })

  test('CLI writes the receipt artifact itself and requires both real envelopes plus explicit carrier identity', () => {
    const created = createProvenance(rulePack(), trialRun())
    const fixture = realContractFixture(created)
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-receipt-contract-'))
    temporaryDirectories.push(directory)
    const exportFile = path.join(directory, 'editor-export-slide-envelope.json')
    const saveFile = path.join(directory, 'editor-save-verified-envelope.json')
    const expectedFile = path.join(directory, 'provenance.json')
    const receiptFile = path.join(directory, 'readback-receipt.json')
    fs.writeFileSync(exportFile, JSON.stringify(fixture.exportEnvelope), 'utf8')
    fs.writeFileSync(saveFile, JSON.stringify(fixture.saveEnvelope), 'utf8')
    fs.writeFileSync(expectedFile, JSON.stringify(created), 'utf8')

    const cli = spawnSync(process.execPath, [
      path.resolve(__dirname, '..', 'provenance-tools.mjs'),
      'validate-readback',
      '--input', exportFile,
      '--save-receipt', saveFile,
      '--expected', expectedFile,
      '--carrier-block-id', 'carrier-root',
      '--verified-at', '2026-08-12T03:00:00.000Z',
      '--out', receiptFile
    ], { encoding: 'utf8' })
    assert.equal(cli.status, 0, cli.stderr)
    const artifact = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
    assert.equal(artifact.kind, 'semantic_provenance_readback_receipt')
    assert.equal(validateReadbackReceiptArtifact(artifact).valid, true)

    const missingSave = spawnSync(process.execPath, [
      path.resolve(__dirname, '..', 'provenance-tools.mjs'),
      'validate-readback', '--input', exportFile, '--expected', expectedFile,
      '--carrier-block-id', 'carrier-root'
    ], { encoding: 'utf8' })
    assert.equal(missingSave.status, 2)
    assert.match(missingSave.stderr, /--save-receipt/)
  })

  test('compiled skill carries the same self-contained receipt gate', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-compiled-receipt-'))
    temporaryDirectories.push(directory)
    const compiled = compileSpecializedSkill(rulePack(), directory)
    const compiledScript = path.join(compiled.output, 'scripts', 'provenance-tools.mjs')
    assert.equal(fs.existsSync(compiledScript), true)
    assert.match(fs.readFileSync(path.join(compiled.output, 'SKILL.md'), 'utf8'), /--save-receipt/)
    assert.match(fs.readFileSync(path.join(compiled.output, 'references', 'workflow.md'), 'utf8'), /真实运行仍必须实际调用两个编辑器工具/)

    const created = createProvenance(rulePack(), trialRun())
    const fixture = realContractFixture(created)
    const exportFile = path.join(compiled.output, 'export-envelope.json')
    const saveFile = path.join(compiled.output, 'save-envelope.json')
    const expectedFile = path.join(compiled.output, 'expected.json')
    fs.writeFileSync(exportFile, JSON.stringify(fixture.exportEnvelope), 'utf8')
    fs.writeFileSync(saveFile, JSON.stringify(fixture.saveEnvelope), 'utf8')
    fs.writeFileSync(expectedFile, JSON.stringify(created), 'utf8')
    const cli = spawnSync(process.execPath, [
      compiledScript,
      'validate-readback',
      '--input', exportFile,
      '--save-receipt', saveFile,
      '--expected', expectedFile,
      '--carrier-block-id', 'carrier-root',
      '--verified-at', '2026-08-12T03:00:00.000Z'
    ], { encoding: 'utf8' })
    assert.equal(cli.status, 0, cli.stderr)
    assert.equal(JSON.parse(cli.stdout).kind, 'semantic_provenance_readback_receipt')
  })
})
