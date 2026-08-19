import fs from 'node:fs'

const index = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const practiceTopics = new Map()
const pages = []

for (const meta of index.pages) {
  const root = JSON.parse(fs.readFileSync(meta.snapshotPath, 'utf8')).snapshot
  const richByBlock = new Map()
  for (const item of root.richText.items || []) {
    const list = richByBlock.get(item.blockDatabaseId) || []
    list.push(String(item.plainText || '').trim())
    richByBlock.set(item.blockDatabaseId, list)
  }
  const blocks = (root.blocks || []).map((block) => ({ id: block.id, uuid: block.uuid, texts: richByBlock.get(block.id) || [] }))
  const modules = (root.digitalModules.items || []).map((item) => ({
    blockId: item.blockId,
    blockDatabaseId: item.blockDatabaseId,
    elementId: item.elementId,
    type: item.normalized?.type,
    modelId: item.normalized?.modelId,
    config: item.normalized?.config || {}
  }))
  const isAnalysis = /解析/.test(meta.name)
  const sequence = Number(meta.name.match(/学习之旅(\d+)/)?.[1] || 0)
  const topic = isAnalysis ? practiceTopics.get(sequence) : meta.name.replace(/^学习之旅\d+\s*/, '').trim()
  if (!isAnalysis) practiceTopics.set(sequence, topic)
  const locator = isAnalysis
    ? blocks.find((block) => block.texts.some((text) => text.includes('思路分析')))
    : blocks.find((block) => block.texts.some((text) => text === '练习1'))
  const interactiveModelIds = isAnalysis ? [] : modules.filter((item) => item.type === 61).slice(0, 2).map((item) => item.modelId)
  pages.push({ ...meta, blocks, modules, isAnalysis, sequence, topic, locatorBlockId: locator?.id || null, interactiveModelIds })
}

process.stdout.write(JSON.stringify({ bookId: index.bookId, bookName: '数学思维特训营-B版练习+解析', count: pages.length, pages }, null, 2))

