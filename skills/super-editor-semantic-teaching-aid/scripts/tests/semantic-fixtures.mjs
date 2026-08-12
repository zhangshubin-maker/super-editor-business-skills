import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { hashCapabilitySnapshot, hashJson, writeJson } from '../semantic-rule-tools.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const skillRoot = path.resolve(__dirname, '..', '..')
const sourceCatalogPath = path.join(skillRoot, 'references', 'super-editor-capability-catalog.json')

export const sha = (character) => `sha256:${character.repeat(64)}`

export function fileSha256(filename) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')}`
}

function relative(from, to) {
  return path.relative(from, to).replaceAll('\\', '/')
}

export function installCapabilityCatalog(pack, artifactRoot) {
  fs.mkdirSync(artifactRoot, { recursive: true })
  const catalogPath = path.join(artifactRoot, 'super-editor-capability-catalog.json')
  fs.copyFileSync(sourceCatalogPath, catalogPath)
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
  pack.execution.capability_snapshot.catalog_path = 'super-editor-capability-catalog.json'
  pack.execution.capability_snapshot.catalog_hash = catalog.catalog_hash
  pack.execution.capability_snapshot.snapshot_hash = hashCapabilitySnapshot(
    pack.execution.capability_snapshot.capabilities,
    catalog.catalog_hash
  )
  return catalog
}

export function createForwardEvidenceArtifact(artifactRoot, caseId, {
  sourceId,
  targetId,
  sourceHash,
  templateId = 'template-a',
  acceptanceIds = ['page-save-readback']
}) {
  const directory = path.join(artifactRoot, 'forward', caseId)
  fs.mkdirSync(directory, { recursive: true })
  const write = (name, value) => {
    const filename = path.join(directory, name)
    writeJson(filename, value)
    return { filename, value, file_hash: fileSha256(filename), hash: hashJson(value) }
  }
  const source = write('source-semantic-snapshot.json', {
    source_id: sourceId,
    snapshotStableHash: sourceHash,
    snapshotStableHashVerified: true,
    semantic: { title: `source-${caseId}` }
  })
  const template = write('template.json', { template_id: templateId, title_role: 'primary lesson heading' })
  const before = write('target-before.json', { target_id: targetId, title: `before-${caseId}` })
  const after = write('target-after.json', { target_id: targetId, title: `after-${caseId}` })
  const receipt = write('save-receipt.json', { target_id: targetId, saved: true, readback_verified: true })
  const provenance = write('provenance-readback.json', { target_id: targetId, case_id: caseId, integrity_verified: true })
  const evidence = write('acceptance-evidence.json', { case_id: caseId, audit: 'passed', screenshot_review: 'passed' })
  const reportValue = {
    schema_version: 1,
    case_id: caseId,
    status: 'passed',
    checks: acceptanceIds.map((checkId) => ({
      check_id: checkId,
      status: 'passed',
      evidence_artifacts: [{ artifact: relative(directory, evidence.filename), artifact_sha256: evidence.file_hash }]
    }))
  }
  const report = write('acceptance-report.json', reportValue)
  const forwardValue = {
    schema_version: 1,
    case_id: caseId,
    source: {
      artifact: relative(directory, source.filename),
      artifact_sha256: source.file_hash,
      source_id: sourceId,
      semantic_snapshot_hash: sourceHash
    },
    template: {
      artifact: relative(directory, template.filename),
      artifact_sha256: template.file_hash,
      template_hash: template.hash
    },
    target_before: {
      artifact: relative(directory, before.filename),
      artifact_sha256: before.file_hash,
      target_id: targetId,
      snapshot_hash: before.hash
    },
    target_after: {
      artifact: relative(directory, after.filename),
      artifact_sha256: after.file_hash,
      target_id: targetId,
      snapshot_hash: after.hash
    },
    save_receipt: {
      artifact: relative(directory, receipt.filename),
      artifact_sha256: receipt.file_hash,
      receipt_hash: receipt.hash
    },
    provenance_readback: {
      artifact: relative(directory, provenance.filename),
      artifact_sha256: provenance.file_hash,
      readback_hash: provenance.hash
    },
    acceptance_report: {
      artifact: relative(directory, report.filename),
      artifact_sha256: report.file_hash,
      report_hash: report.hash
    }
  }
  const forward = write('evidence.json', forwardValue)
  return {
    case: {
      id: caseId,
      evidence_artifact: relative(artifactRoot, forward.filename),
      artifact_sha256: forward.file_hash
    },
    test: {
      id: caseId,
      source_label: sourceId,
      status: 'passed',
      evidence_artifact: relative(artifactRoot, forward.filename)
    },
    files: fs.readdirSync(directory).map((name) => relative(artifactRoot, path.join(directory, name))).sort()
  }
}

export function materializeExecutablePack(pack, artifactRoot, { validated = false } = {}) {
  pack.identity.status = validated ? 'validated' : 'trial_approved'
  pack.templates.default.snapshot_hash ||= sha('a')
  pack.templates.variants.forEach((variant) => { variant.snapshot_hash ||= sha('b') })
  pack.execution.trial_approval = { approved: true, evidence: ['explicit test-fixture approval'] }
  pack.execution.forward_cases = []
  pack.forward_tests = []
  installCapabilityCatalog(pack, artifactRoot)
  if (validated) {
    const acceptanceIds = pack.acceptance.map((check) => check.id)
    for (const spec of [
      { caseId: 'forward-a', sourceId: 'source-book-a', targetId: 'target-book-a', sourceHash: sha('1') },
      { caseId: 'forward-b', sourceId: 'source-book-b', targetId: 'target-book-b', sourceHash: sha('2') }
    ]) {
      const bundle = createForwardEvidenceArtifact(artifactRoot, spec.caseId, { ...spec, acceptanceIds })
      pack.execution.forward_cases.push(bundle.case)
      pack.forward_tests.push(bundle.test)
    }
  }
  return pack
}
