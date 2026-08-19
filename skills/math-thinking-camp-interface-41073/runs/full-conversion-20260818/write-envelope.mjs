import fs from 'node:fs'

const [outputPath, encoded] = process.argv.slice(2)
if (!outputPath || !encoded) throw new Error('usage: node write-envelope.mjs <output> <base64-json>')
const value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
