#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const MAX_UPLOAD_BYTES = 70 * 1024 * 1024

function usage() {
  return [
    'Usage:',
    '  node analyze-annotations.mjs --json <annotations.json> [--audio-dir <dir>]',
    '       [--canvas-width 794] [--out <import-plan.json>]'
  ].join('\n')
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--help' || key === '-h') args.help = true
    else if (key.startsWith('--')) {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`)
      args[key.slice(2)] = value
      index += 1
    } else throw new Error(`Unknown argument: ${key}`)
  }
  return args
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`)
    process.exitCode = 2
    return
  }

  if (args.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  if (!args.json) {
    process.stderr.write(`--json is required\n${usage()}\n`)
    process.exitCode = 2
    return
  }

  const jsonPath = path.resolve(args.json)
  const audioDir = args['audio-dir'] ? path.resolve(args['audio-dir']) : null
  const canvasWidth = finiteNumber(args['canvas-width'] ?? 794)
  const errors = []
  const warnings = []

  if (!canvasWidth || canvasWidth <= 0) errors.push('canvas-width must be a positive number')
  if (!fs.existsSync(jsonPath)) errors.push(`annotation JSON does not exist: ${jsonPath}`)

  let source = null
  if (!errors.length) {
    try {
      source = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
    } catch (error) {
      errors.push(`cannot parse annotation JSON: ${error.message}`)
    }
  }

  const pdfPages = source?.pdf?.pages
  const annotations = source?.annotations
  if (source && !Array.isArray(pdfPages)) errors.push('pdf.pages must be an array')
  if (source && !Array.isArray(annotations)) errors.push('annotations must be an array')

  const pageMap = new Map()
  if (Array.isArray(pdfPages)) {
    for (const item of pdfPages) {
      const page = positiveInteger(item?.page)
      const width = finiteNumber(item?.width)
      const height = finiteNumber(item?.height)
      if (!page || !width || width <= 0 || !height || height <= 0) {
        errors.push(`invalid pdf page descriptor: ${JSON.stringify(item)}`)
        continue
      }
      if (pageMap.has(page)) errors.push(`duplicate pdf page descriptor: ${page}`)
      pageMap.set(page, { page, width, height })
    }
  }

  const ids = new Set()
  const audioPaths = new Set()
  const normalized = []
  if (Array.isArray(annotations)) {
    annotations.forEach((annotation, index) => {
      const label = annotation?.id || `annotations[${index}]`
      if (!annotation?.id || typeof annotation.id !== 'string') errors.push(`${label}: id must be a non-empty string`)
      else if (ids.has(annotation.id)) errors.push(`${label}: duplicate annotation id`)
      else ids.add(annotation.id)

      if (annotation?.type !== 'audio' && annotation?.type !== 'transcript') {
        errors.push(`${label}: type must be audio or transcript`)
      }
      const page = positiveInteger(annotation?.page)
      const pageInfo = page ? pageMap.get(page) : null
      if (!pageInfo) errors.push(`${label}: referenced PDF page is missing: ${annotation?.page}`)

      const x = finiteNumber(annotation?.x)
      const y = finiteNumber(annotation?.y)
      const width = finiteNumber(annotation?.width)
      const height = finiteNumber(annotation?.height)
      if (x === null || y === null || x < 0 || y < 0 || width === null || height === null || width <= 0 || height <= 0) {
        errors.push(`${label}: x/y must be non-negative and width/height must be positive numbers`)
      }
      if (
        pageInfo &&
        x !== null &&
        y !== null &&
        width !== null &&
        height !== null &&
        (x + width > pageInfo.width || y + height > pageInfo.height)
      ) {
        warnings.push(`${label}: annotation box extends beyond source page bounds`)
      }

      let resolvedAudioPath = null
      let audioSize = null
      if (annotation?.type === 'audio') {
        if (!annotation.audio_path || typeof annotation.audio_path !== 'string') {
          errors.push(`${label}: audio_path is required`)
        } else {
          resolvedAudioPath = audioDir
            ? path.resolve(audioDir, path.basename(annotation.audio_path))
            : path.resolve(path.dirname(jsonPath), annotation.audio_path)
          audioPaths.add(resolvedAudioPath.toLowerCase())
          if (!fs.existsSync(resolvedAudioPath)) errors.push(`${label}: audio file does not exist: ${resolvedAudioPath}`)
          else {
            audioSize = fs.statSync(resolvedAudioPath).size
            if (audioSize > MAX_UPLOAD_BYTES) errors.push(`${label}: audio file exceeds 70MB: ${resolvedAudioPath}`)
          }
        }
      }
      if (annotation?.type === 'transcript') {
        if (!String(annotation.question || '').trim()) errors.push(`${label}: question is required`)
        if (!String(annotation.text || '').trim()) errors.push(`${label}: text is required`)
      }

      if (pageInfo && x !== null && y !== null && width !== null && height !== null && canvasWidth) {
        const scale = canvasWidth / pageInfo.width
        normalized.push({
          ...annotation,
          resolved_audio_path: resolvedAudioPath,
          audio_size: audioSize,
          scaled: {
            left: x * scale,
            top: y * scale,
            width: width * scale,
            height: height * scale
          }
        })
      }
    })
  }

  const affectedPages = [...new Set(normalized.map(item => item.page))].sort((a, b) => a - b)
  const pages = affectedPages.map(page => {
    const sourcePage = pageMap.get(page)
    const scale = canvasWidth / sourcePage.width
    return {
      pdf_page: page,
      source_width: sourcePage.width,
      source_height: sourcePage.height,
      canvas_width: canvasWidth,
      canvas_height: sourcePage.height * scale,
      scale,
      annotations: normalized.filter(item => item.page === page)
    }
  })

  const result = {
    valid: errors.length === 0,
    source: {
      annotation_json: jsonPath,
      pdf_filename: source?.pdf?.filename || null,
      pdf_page_count: source?.pdf?.page_count || pageMap.size,
      audio_dir: audioDir
    },
    summary: {
      annotation_count: normalized.length,
      affected_page_count: affectedPages.length,
      affected_pages: affectedPages,
      audio_count: normalized.filter(item => item.type === 'audio').length,
      transcript_count: normalized.filter(item => item.type === 'transcript').length,
      unique_audio_file_count: audioPaths.size,
      canvas_width: canvasWidth
    },
    errors,
    warnings,
    pages
  }

  const output = `${JSON.stringify(result, null, 2)}\n`
  if (args.out) fs.writeFileSync(path.resolve(args.out), output, 'utf8')
  process.stdout.write(output)
  if (errors.length) process.exitCode = 1
}

main()
