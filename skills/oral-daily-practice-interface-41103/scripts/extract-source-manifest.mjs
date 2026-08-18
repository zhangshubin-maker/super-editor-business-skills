#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument near ${key ?? '<end>'}`)
    args[key.slice(2)] = value
  }
  return args
}

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
    .replace(/<\/li>\s*<li[^>]*>/gi, '\n')
    .replace(/<\/?(?:ol|ul)[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function flatten(elements, parentNames = [], output = []) {
  for (const element of elements ?? []) {
    output.push({ ...element, parentNames })
    flatten(element.child_list, [...parentNames, element.name ?? ''], output)
  }
  return output
}

function requireOne(items, predicate, label) {
  const matches = items.filter(predicate)
  if (matches.length !== 1) throw new Error(`${label}: expected 1 match, got ${matches.length}`)
  return matches[0]
}

function normalizeCatalogName(value) {
  return String(value).replace(/\s+/g, ' ').trim()
}

function loadOverrides(filename) {
  if (!filename) return { catalogs: {} }
  const value = JSON.parse(fs.readFileSync(path.resolve(filename), 'utf8'))
  if (value.schema_version !== 1 || typeof value.catalogs !== 'object' || value.catalogs === null) {
    throw new Error('source overrides must use schema_version 1 and a catalogs object')
  }
  return value
}

function applyCatalogOverride(catalog, override) {
  if (!override) return catalog
  const result = structuredClone(catalog)
  if (override.sentences) {
    if (!Array.isArray(override.sentences) || override.sentences.length < 2 || override.sentences.length > 5) {
      throw new Error(`${catalog.source_catalog_id}: sentences override must contain 2 to 5 items`)
    }
    result.learning_path.sentences = override.sentences.map((item) => String(item))
    result.learning_path.sentence_status = 'resolved_from_explicit_source_override'
    result.learning_path.sentence_evidence = String(override.sentence_evidence ?? '')
    if (!result.learning_path.sentence_evidence) {
      throw new Error(`${catalog.source_catalog_id}: sentence_evidence is required with sentences`)
    }
  }
  if (override.words_english) {
    if (!Array.isArray(override.words_english) || override.words_english.length !== 4) {
      throw new Error(`${catalog.source_catalog_id}: words_english override must contain exactly 4 items`)
    }
    result.learning_path.words = override.words_english.map((english, index) => ({
      english: String(english),
      chinese: result.learning_path.words[index]?.chinese ?? null
    }))
    result.learning_path.word_pairing_status = 'resolved_from_explicit_source_override'
  }
  if (override.words_chinese) {
    if (!Array.isArray(override.words_chinese) || override.words_chinese.length !== 4) {
      throw new Error(`${catalog.source_catalog_id}: words_chinese override must contain exactly 4 items`)
    }
    const english = override.words_english ?? result.learning_path.words.map((item) => item.english)
    if (english.length !== 4) {
      throw new Error(`${catalog.source_catalog_id}: words_chinese override also requires words_english when source English segmentation is not 4`)
    }
    result.learning_path.words = english.map((item, index) => ({
      english: String(item),
      chinese: String(override.words_chinese[index])
    }))
    result.learning_path.word_pairing_status = 'resolved_from_explicit_source_override'
  }
  if (override.words_english || override.words_chinese) {
    result.learning_path.word_pairing_evidence = String(override.word_pairing_evidence ?? '')
    if (!result.learning_path.word_pairing_evidence) throw new Error(`${catalog.source_catalog_id}: word_pairing_evidence is required with word overrides`)
  }
  for (const accepted of override.accept_relevant_warnings ?? []) {
    const index = result.source_snapshot.relevant_warnings.findIndex((warning) =>
      warning.code === accepted.code && warning.target?.elementId === accepted.target_element_id)
    if (index < 0) {
      throw new Error(`${catalog.source_catalog_id}: accepted warning was not found: ${accepted.code}/${accepted.target_element_id}`)
    }
    const [warning] = result.source_snapshot.relevant_warnings.splice(index, 1)
    result.source_snapshot.accepted_warnings ??= []
    result.source_snapshot.accepted_warnings.push({ ...warning, acceptance_reason: String(accepted.reason ?? '') })
  }
  result.source_snapshot.scoped_complete = result.source_snapshot.relevant_warnings.length === 0
  return result
}

function newestSnapshots(snapshotDirectory, bookId, catalogIds) {
  const wanted = new Set(catalogIds.map(String))
  const selected = new Map()
  for (const entry of fs.readdirSync(snapshotDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const match = entry.name.match(/^(\d+)-(\d+)-[a-f0-9]{64}\.json$/)
    if (!match || match[1] !== String(bookId) || !wanted.has(match[2])) continue
    const filename = path.join(snapshotDirectory, entry.name)
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'))
    const capturedAt = Date.parse(value.meta?.capturedAt ?? '') || fs.statSync(filename).mtimeMs
    const current = selected.get(match[2])
    if (!current || capturedAt > current.capturedAt) selected.set(match[2], { filename, value, capturedAt })
  }
  return selected
}

function extractCatalog(record) {
  const snapshot = record.value.snapshot
  const identity = snapshot.identity
  const blocks = snapshot.blocks.filter((block) => block.template_data_content?.elements)
  const dialogueBlock = requireOne(blocks, (block) => /2-对话/.test(block.template_data_content.name ?? ''), 'Dialogue block')
  const learningBlock = requireOne(blocks, (block) => /3-口语学习路径/.test(block.template_data_content.name ?? ''), 'learning-path block')
  const wordBlock = requireOne(blocks, (block) => /4-单词和句型/.test(block.template_data_content.name ?? ''), 'word/sentence block')
  const writeBlock = requireOne(blocks, (block) => /5-write/i.test(block.template_data_content.name ?? ''), 'write block')

  const dialogueElements = flatten(dialogueBlock.template_data_content.elements)
  const learningElements = flatten(learningBlock.template_data_content.elements)
  const wordElements = flatten(wordBlock.template_data_content.elements)
  const prompt = requireOne(dialogueElements, (element) => element.type === 'text' && element.name === '一级标题（中文）', 'Dialogue Chinese prompt')
  const dialogueTitle = requireOne(dialogueElements, (element) => element.type === 'text' && element.name === '一级标题（英文）', 'Dialogue English title')
  const learningTitleEn = requireOne(learningElements, (element) => element.type === 'text' && element.name === '一级标题（英文）', 'learning title English')
  const learningTitleZh = requireOne(learningElements, (element) => element.type === 'text' && element.name === '一级标题（中文）', 'learning title Chinese')
  const sentenceText = requireOne(wordElements, (element) => element.type === 'text' && element.name === '文本 框' && element.parentNames.includes('句型'), 'sentence patterns')
  const wordEnglish = requireOne(wordElements, (element) => element.type === 'text' && element.name === '文本框' && element.parentNames.includes('单词'), 'English words')
  const wordChinese = requireOne(wordElements, (element) => element.type === 'text' && element.name === '中文翻译' && element.parentNames.includes('单词'), 'Chinese words')

  const sentences = decodeHtml(sentenceText.content)
  const wordsEn = decodeHtml(wordEnglish.content)
  const wordsZh = decodeHtml(wordChinese.content)
  // Preserve raw segmentation so an evidence-backed catalog override can repair
  // narrow-textbox concatenation. Final validation still requires four pairs.

  const elementIndex = new Map(snapshot.elementIndex.map((entry) => [entry.elementId, entry]))
  const modules = snapshot.digitalModules.items.map((item) => ({
    element_id: item.elementId,
    element_name: elementIndex.get(item.elementId)?.name ?? null,
    block_database_id: item.blockDatabaseId,
    type: item.normalized.type,
    type_name: item.normalized.typeName,
    kind: item.normalized.kind,
    model_id: item.normalized.modelId
  }))
  const moduleByName = (name, type) => requireOne(modules, (item) => item.element_name === name && item.type === type, `${identity.catalogName} / ${name} module`)
  const selectedElementIds = new Set([
    prompt.id,
    dialogueTitle.id,
    learningTitleEn.id,
    learningTitleZh.id,
    sentenceText.id,
    wordEnglish.id,
    wordChinese.id,
    ...modules.map((item) => item.element_id)
  ])
  const warnings = snapshot.completeness.warnings ?? []
  const relevantWarnings = warnings.filter((warning) => selectedElementIds.has(warning.target?.elementId))

  return {
    source_book_id: identity.bookId,
    source_catalog_id: identity.catalogId,
    source_catalog_sort: identity.catalogSort,
    source_catalog_name_raw: identity.catalogName,
    target_catalog_name: normalizeCatalogName(identity.catalogName),
    source_snapshot: {
      path: record.filename,
      file_sha256: record.value.meta?.fileSha256 ?? `sha256:${path.basename(record.filename).split('-').at(-1).replace('.json', '')}`,
      stable_hash: record.value.stableHash,
      captured_at: record.value.meta?.capturedAt,
      full_fidelity: snapshot.completeness.complete === true,
      scoped_complete: relevantWarnings.length === 0,
      completeness_sections: snapshot.completeness.sections,
      excluded_warnings: warnings.filter((warning) => !selectedElementIds.has(warning.target?.elementId)),
      relevant_warnings: relevantWarnings
    },
    dialogue: {
      title_en: decodeHtml(dialogueTitle.content).join(' '),
      prompt_zh: decodeHtml(prompt.content).join(' '),
      source_block_database_id: dialogueBlock.id,
      audio: moduleByName('按钮-磨耳朵', 77)
    },
    learning_path: {
      title_en: decodeHtml(learningTitleEn.content).join(' '),
      title_zh: decodeHtml(learningTitleZh.content).join(' '),
      sentences,
      sentence_status: sentences.length >= 2 && sentences.length <= 5 ? 'resolved_from_source_structure' : 'needs_visual_or_semantic_resolution',
      words: wordsEn.map((english, index) => ({ english, chinese: wordsZh.length === 4 ? wordsZh[index] : null })),
      words_chinese_raw: wordsZh,
      word_pairing_status: wordsZh.length === 4 ? 'resolved_from_source_paragraphs' : 'needs_visual_or_semantic_resolution',
      entries: [
        moduleByName('按钮-看口语视频', 78),
        moduleByName('按钮-听句型讲解', 78),
        moduleByName('按钮-单词巧记', 79),
        moduleByName('按钮-句型巧练', 82),
        moduleByName('按钮-AI口语跟读测评', 79),
        moduleByName('按钮-口语PK', 87)
      ]
    },
    print: requireOne(modules, (item) => item.type === 84, `${identity.catalogName} / print module`),
    source_blocks: {
      dialogue: dialogueBlock.id,
      learning_path: learningBlock.id,
      words_and_sentences: wordBlock.id,
      write: writeBlock.id
    }
  }
}

const args = parseArgs(process.argv.slice(2))
for (const key of ['snapshot-dir', 'book-id', 'catalog-ids', 'out']) {
  if (!args[key]) throw new Error(`--${key} is required`)
}
const catalogIds = args['catalog-ids'].split(',').map((value) => value.trim()).filter(Boolean)
const selected = newestSnapshots(path.resolve(args['snapshot-dir']), args['book-id'], catalogIds)
const missing = catalogIds.filter((catalogId) => !selected.has(catalogId))
if (missing.length) throw new Error(`missing snapshots: ${missing.join(', ')}`)
const overrides = loadOverrides(args.overrides)
const catalogs = catalogIds.map((catalogId) => applyCatalogOverride(extractCatalog(selected.get(catalogId)), overrides.catalogs[catalogId]))
for (const catalog of catalogs) {
  if (catalog.learning_path.sentences.length < 2 || catalog.learning_path.sentences.length > 5) {
    throw new Error(`${catalog.source_catalog_id}: expected 2 to 5 source sentences`)
  }
  if (catalog.learning_path.words.some((item) => !item.english || !item.chinese)) {
    throw new Error(`${catalog.source_catalog_id}: unresolved bilingual word pairing`)
  }
}
const output = {
  schema_version: 1,
  source_book_id: String(args['book-id']),
  generated_at: new Date().toISOString(),
  scoped_completeness_policy: 'Only source fields selected by rule-pack 0.1.4 must have zero unresolved relevant warnings; the excluded Dialogue body and empty font map are preserved as explicit out-of-scope warnings. Explicit source overrides must carry evidence and may accept an exact warning target.',
  catalogs
}
fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true })
fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(output, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ out: path.resolve(args.out), catalog_count: catalogs.length, scoped_complete_count: catalogs.filter((item) => item.source_snapshot.scoped_complete).length }, null, 2)}\n`)
