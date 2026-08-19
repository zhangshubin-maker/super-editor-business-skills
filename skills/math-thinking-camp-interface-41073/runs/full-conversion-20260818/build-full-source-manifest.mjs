import fs from 'node:fs'

const index = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const pages = []

for (const meta of index.pages) {
  const root = JSON.parse(fs.readFileSync(meta.snapshotPath, 'utf8')).snapshot
  const richByBlock = new Map()
  for (const item of root.richText.items || []) {
    const list = richByBlock.get(item.blockDatabaseId) || []
    list.push(item)
    richByBlock.set(item.blockDatabaseId, list)
  }
  const blocks = (root.blocks || []).map((block) => ({
    id: block.id,
    uuid: block.uuid,
    templateId: block.template_id,
    texts: (richByBlock.get(block.id) || []).map((item) => String(item.plainText || '').trim())
  }))
  const modules = (root.digitalModules.items || []).map((item) => ({
    blockId: item.blockId,
    blockDatabaseId: item.blockDatabaseId,
    elementId: item.elementId,
    type: item.normalized?.type,
    modelId: item.normalized?.modelId,
    config: item.normalized?.config || {}
  }))
  const isAbility = /能力达标/.test(meta.name)
  if (!isAbility) {
    const topic = meta.name.replace(/^学习之旅\d+\s*/, '').trim()
    const questionBlocks = blocks.filter((block) => block.templateId === 10042)
    const questions = questionBlocks.map((block) => {
      const item = (richByBlock.get(block.id) || [])[0]
      return { blockId: block.id, html: item?.content || item?.html || '', plainText: String(item?.plainText || '').trim(), roundTripSafe: item?.roundTripSafe !== false }
    })
    const keyBlock = blocks.find((block) => block.templateId === 10043)
    const keyItems = richByBlock.get(keyBlock?.id) || []
    const guideItem = keyItems.find((item) => {
      const text = String(item.plainText || '').trim()
      return text && text !== '关键点' && text.length <= 80
    }) || keyItems.find((item) => String(item.plainText || '').trim() !== '关键点')
    const variantPrompts = blocks.filter((block) => block.templateId === 10048)
    const variants = variantPrompts.map((prompt) => {
      const pos = blocks.findIndex((block) => block.id === prompt.id)
      return {
        promptBlockId: prompt.id,
        analysisBlockId: blocks.slice(pos + 1).find((block) => block.templateId === 10049)?.id || null,
        keyBlockId: blocks.slice(pos + 1).find((block) => block.templateId === 10050)?.id || null
      }
    })
    pages.push({ ...meta, route: 'normal', topic, blocks, modules, questions, methodGuide: String(guideItem?.plainText || '').trim(), problemBlockId: questionBlocks[0]?.id || null, methodBlockId: blocks.find((block) => block.templateId === 10045)?.id || null, summaryBlockId: blocks.find((block) => block.templateId === 10046)?.id || null, variants })
  } else {
    const variant = meta.name.endsWith('A') ? 'A' : 'B'
    const recentTopics = pages.filter((item) => item.route === 'normal').slice(-5).reverse().map((item) => item.topic)
    const contentBlock = blocks.find((block) => block.templateId === 11542) || blocks.find((block) => block.texts.length > 0 && !block.texts.some((text) => text.includes('能力达标')))
    pages.push({ ...meta, route: 'ability', variant, recentTopics, blocks, modules, contentBlockId: contentBlock?.id || null, agentModelId: modules.find((item) => item.type === 87)?.modelId || null, printModelId: modules.find((item) => item.type === 84)?.modelId || null })
  }
}

process.stdout.write(JSON.stringify({ bookId: index.bookId, bookName: '数学思维特训营', count: pages.length, pages }, null, 2))

