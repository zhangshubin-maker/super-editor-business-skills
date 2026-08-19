import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const runDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1'))
const semanticRoot = path.resolve(runDir, '../../../super-editor-semantic-teaching-aid')
const tool = path.join(semanticRoot, 'scripts', 'provenance-tools.mjs')
const grade = process.argv[2] || 'grade1'
if (!['grade1', 'grade2', 'grade3'].includes(grade)) throw new Error(`unknown B-grade config: ${grade}`)
const index = JSON.parse(fs.readFileSync(path.join(runDir, `${grade}-b-provenance-index.json`), 'utf8'))
const receipts = []

for (const item of index) {
  const input = path.join(runDir, `${item.stem}.slide-export-envelope.json`)
  const save = path.join(runDir, `${item.stem}.save-envelope.json`)
  const expected = path.join(runDir, `${item.stem}.provenance.json`)
  const out = path.join(runDir, `${item.stem}.readback-receipt.json`)
  execFileSync(process.execPath, [tool, 'validate-readback', '--input', input, '--save-receipt', save, '--expected', expected, '--carrier-block-id', item.carrierBlockId, '--out', out], { stdio: 'ignore' })
  execFileSync(process.execPath, [tool, 'validate-receipt', '--input', out], { stdio: 'ignore' })
  const receipt = JSON.parse(fs.readFileSync(out, 'utf8'))
  receipts.push({ sourceId: item.sourceId, targetSlideId: item.targetSlideId, receiptPath: out, valid: receipt.valid, receipt })
}

fs.writeFileSync(path.join(runDir, `${grade}-b-readback-index.json`), `${JSON.stringify(receipts, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ validated: receipts.length, valid: receipts.filter((x) => x.valid !== false).length, lastReceipt: receipts.at(-1)?.receiptPath }, null, 2))
