import fs from 'node:fs'
import path from 'node:path'

const runDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1'))
const sourcePlans = JSON.parse(fs.readFileSync(path.join(runDir, 'source-plan.json'), 'utf8'))
const snapshotDir = path.join(
  process.env.LOCALAPPDATA,
  'Temp',
  'super-editor-control',
  'semantic-snapshots'
)

const targetIds = [45743, 45744, ...Array.from({ length: 78 }, (_, index) => 45746 + index)]
const firstTemplate = {
  title: 'rePyRNzCeI',
  article: 'P--9ghpy8Y',
  modules: ['9A8JHJj9DA', 'ljE3I_F9La', 'yLD34kteMs', 'gEQIGs1i04', 'v9U-VZWuou', 'spxVzhYRKm', 'SqYq_1M7p6', 'c0aKWQhxS3'],
  forbiddenOuterVocabulary: 'eePnCIj3r-'
}
const batchTemplate = {
  title: 'pKElvgx-m4',
  article: 'Q8pMBa8OKZ',
  modules: ['KJfVWb4hsj', '0iE4ahjRyd', 'L5A1W61wwD', 'QRUBDCJPhe', '5XU1yl9cpC', 'ykkg1SDkSn', 'Vi59VR_tNn', 'riw_moW0w9'],
  forbiddenOuterVocabulary: 'je4Yse1Jth'
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .trim()
}

function walkElements(elements, out = new Map()) {
  for (const element of elements || []) {
    out.set(String(element.id), element)
    walkElements(element.child_list, out)
  }
  return out
}

function latestSnapshot(slideId) {
  const prefix = `1820811-${slideId}-`
  const files = fs.readdirSync(snapshotDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => ({ name, mtime: fs.statSync(path.join(snapshotDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  if (!files.length) throw new Error(`missing snapshot for ${slideId}`)
  return path.join(snapshotDir, files[0].name)
}

function property(config, name) {
  return String((config?.properties || []).find((item) => item.paramName === name)?.paramValue ?? '')
}

const failures = []
const rows = []
for (let index = 0; index < sourcePlans.length; index += 1) {
  const plan = sourcePlans[index]
  const targetSlideId = targetIds[index]
  const file = latestSnapshot(targetSlideId)
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  const snapshot = doc.snapshot
  const template = index < 2 ? firstTemplate : batchTemplate
  const contentBlocks = snapshot.blocks.filter((block) => block.template_type === 2)
  const allElements = walkElements(contentBlocks.flatMap((block) => block.template_data_content?.elements || []))
  const modules = snapshot.digitalModules.items
  const byName = new Map(modules.map((item) => [item.normalized.name, item.normalized]))
  const bottom = contentBlocks.find((block) => block.template_data_content?.name === '底部空区块')
  const title = allElements.get(template.title)
  const article = allElements.get(template.article)
  const errors = []

  if (String(snapshot.identity.bookId) !== '1820811') errors.push('wrong target book')
  if (String(snapshot.identity.catalogId) !== String(targetSlideId)) errors.push('wrong target slide')
  if (snapshot.identity.catalogName !== plan.name) errors.push('catalog name mismatch')
  if (Number(snapshot.identity.catalogSort) !== index + 1) errors.push('catalog sort mismatch')
  if (snapshot.state.dirty) errors.push('dirty snapshot')
  if (modules.length !== 8) errors.push(`module count ${modules.length}`)
  if (new Set(modules.map((item) => item.elementId)).size !== 8) errors.push('duplicate module target')
  if (template.modules.some((id) => !modules.some((item) => item.elementId === id))) errors.push('module target set mismatch')
  if (modules.some((item) => item.elementId === template.forbiddenOuterVocabulary)) errors.push('outer vocabulary card bound')

  const expectedPositions = [
    ['查看英文原文', plan.resources.englishBlockDatabaseId],
    ['查看中文翻译', plan.resources.translationBlockDatabaseId],
    ['查看重点词汇', plan.resources.vocabularyBlockDatabaseId],
    ['查看拼读内容', plan.resources.phonicsBlockDatabaseId]
  ]
  for (const [name, resourceId] of expectedPositions) {
    const module = byName.get(name)
    if (!module || module.type !== 80) errors.push(`${name} missing`)
    else if (String(module.config.resourceId) !== String(resourceId)) errors.push(`${name} resource mismatch`)
    else if (String(module.config.catalogId) !== String(targetSlideId)) errors.push(`${name} target catalog mismatch`)
  }

  const audio = byName.get('美文随身听')
  if (!audio || audio.type !== 77) errors.push('audio missing')
  else if (String(audio.config.audio?.fileId) !== String(plan.modules.audio.audio.fileId)) errors.push('audio file mismatch')
  else if (audio.config.audio?.url !== plan.modules.audio.audio.url) errors.push('audio url mismatch')

  const oralPk = byName.get('口语PK')
  if (!oralPk || oralPk.config.agentId !== 27) errors.push('oral PK missing')
  else if (property(oralPk.config, 'text_id') !== property(plan.modules.oralPk, 'text_id')) errors.push('oral PK text mismatch')
  const oralAssessment = byName.get('口语AI测评')
  if (!oralAssessment || oralAssessment.config.agentId !== 34) errors.push('oral assessment missing')
  else if (property(oralAssessment.config, 'text_id') !== property(plan.modules.oralAssessment, 'text_id')) errors.push('oral assessment text mismatch')

  const mnemonic = byName.get('巧记单词')
  if (!mnemonic || mnemonic.type !== 79) errors.push('mnemonic missing')
  else if (mnemonic.config.guid !== plan.modules.mnemonic.guid) errors.push('mnemonic guid mismatch')

  if (!bottom) errors.push('bottom spacer missing')
  else {
    const size = bottom.template_data_content.size
    const background = bottom.template_data_content.background
    if (size.width !== 375 || size.height !== 20 || size.type !== 'phone') errors.push('bottom spacer size mismatch')
    if (String(background?.color).toUpperCase() !== '#CECECE') errors.push('bottom spacer color mismatch')
    if ((bottom.template_data_content.elements || []).length !== 0) errors.push('bottom spacer not empty')
  }
  if (contentBlocks.some((block) => block.template_data_content?.size?.width !== 375)) errors.push('non-phone block width')
  if (contentBlocks.some((block) => block.template_data_content?.size?.type !== 'phone')) errors.push('non-phone block type')
  if (normalizeText(title?.content) !== normalizeText(plan.name)) errors.push('title mismatch')
  if (normalizeText(article?.content) !== normalizeText(plan.article.plainText)) errors.push('article mismatch')
  if (snapshot.completeness.warnings.some((warning) => warning.code !== 'FONT_MAPPING_EMPTY')) errors.push('unexpected completeness warning')

  if (errors.length) failures.push({ index: index + 1, sourceSlideId: plan.slideId, targetSlideId, errors })
  rows.push({ index: index + 1, sourceSlideId: plan.slideId, targetSlideId, moduleCount: modules.length, contentBlockCount: contentBlocks.length, errors })
}

const report = {
  sourceBookId: 1814549,
  targetBookId: 1820811,
  verifiedAt: new Date().toISOString(),
  pageCount: rows.length,
  moduleCount: rows.reduce((sum, row) => sum + row.moduleCount, 0),
  phonePageCount: rows.filter((row) => row.errors.every((error) => !error.includes('phone'))).length,
  failureCount: failures.length,
  failures,
  first: rows[0],
  last: rows.at(-1)
}

console.log(JSON.stringify(report, null, 2))
if (failures.length) process.exitCode = 1
