#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).reduce((rows, value, index, values) => {
  if (index % 2 === 0) rows.push([value.replace(/^--/, ''), values[index + 1]])
  return rows
}, []))

for (const key of ['snapshot-dir', 'book-id', 'catalog-ids']) {
  if (!args[key]) throw new Error(`--${key} is required`)
}

function flatten(elements, output = []) {
  for (const element of elements ?? []) {
    output.push(element)
    flatten(element.child_list, output)
  }
  return output
}

function textLines(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
    .replace(/<\/li>\s*<li[^>]*>/gi, '\n')
    .replace(/<\/?(?:ol|ul)[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

const directory = path.resolve(args['snapshot-dir'])
const bookId = String(args['book-id'])
const ids = args['catalog-ids'].split(',').map((value) => value.trim()).filter(Boolean)
const files = fs.readdirSync(directory).filter((name) => name.startsWith(`${bookId}-`) && name.endsWith('.json'))
const newest = new Map()
for (const name of files) {
  const match = name.match(/^(\d+)-(\d+)-[a-f0-9]{64}\.json$/)
  if (!match || !ids.includes(match[2])) continue
  const filename = path.join(directory, name)
  const value = JSON.parse(fs.readFileSync(filename, 'utf8'))
  const time = Date.parse(value.meta?.capturedAt ?? '') || fs.statSync(filename).mtimeMs
  if (!newest.has(match[2]) || newest.get(match[2]).time < time) newest.set(match[2], { value, time })
}

const rows = ids.map((id) => {
  const record = newest.get(id)
  if (!record) throw new Error(`missing snapshot ${id}`)
  const snapshot = record.value.snapshot
  const wordBlock = snapshot.blocks.find((block) => /4-单词和句型/.test(block.template_data_content?.name ?? ''))
  if (!wordBlock) throw new Error(`missing word block ${id}`)
  const elements = flatten(wordBlock.template_data_content.elements)
  const sentence = elements.find((element) => element.type === 'text' && element.name === '文本 框')
  const english = elements.find((element) => element.type === 'text' && element.name === '文本框')
  const chinese = elements.find((element) => element.type === 'text' && element.name === '中文翻译')
  const sentences = textLines(sentence?.content)
  const wordsEn = textLines(english?.content)
  const wordsZh = textLines(chinese?.content)
  return {
    catalog_id: id,
    sort: Number(snapshot.identity.catalogSort),
    name: snapshot.identity.catalogName,
    title_length: String(snapshot.identity.catalogName).length,
    sentence_count: sentences.length,
    max_sentence_length: Math.max(0, ...sentences.map((value) => value.length)),
    english_word_count: wordsEn.length,
    chinese_word_count: wordsZh.length,
    sentences,
    words_en: wordsEn,
    words_zh: wordsZh
  }
})

const summary = {
  book_id: bookId,
  catalog_count: rows.length,
  sentence_count_distribution: Object.fromEntries([...new Set(rows.map((row) => row.sentence_count))].sort((a, b) => a - b).map((count) => [count, rows.filter((row) => row.sentence_count === count).length])),
  word_count_mismatches: rows.filter((row) => row.english_word_count !== 4 || row.chinese_word_count !== 4).map((row) => ({
    catalog_id: row.catalog_id,
    name: row.name,
    english_word_count: row.english_word_count,
    chinese_word_count: row.chinese_word_count,
    words_en: row.words_en,
    words_zh: row.words_zh
  })),
  longest_title: rows.toSorted((a, b) => b.title_length - a.title_length)[0],
  longest_sentence: rows.toSorted((a, b) => b.max_sentence_length - a.max_sentence_length)[0],
  rows
}

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
