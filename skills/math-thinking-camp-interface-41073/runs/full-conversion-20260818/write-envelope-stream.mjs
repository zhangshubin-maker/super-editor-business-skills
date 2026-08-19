import fs from 'node:fs'
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let written = 0

for await (const line of rl) {
  if (line === '__END__') break
  if (!line) continue
  const separator = line.indexOf('\t')
  if (separator < 1) throw new Error('expected <base64-path>\\t<base64-json>')
  const outputPath = Buffer.from(line.slice(0, separator), 'base64').toString('utf8')
  const value = JSON.parse(Buffer.from(line.slice(separator + 1), 'base64').toString('utf8'))
  fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  written += 1
}

console.log(JSON.stringify({ written }))
