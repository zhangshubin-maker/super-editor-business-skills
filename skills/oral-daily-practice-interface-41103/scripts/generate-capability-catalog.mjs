#!/usr/bin/env node

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { atomicWriteText, hashJson } from './semantic-rule-tools.mjs'

const CATALOG_SCHEMA_VERSION = 1

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} requires a value`)
    options[key.slice(2)] = value
    index += 1
  }
  return options
}

function requestMcp(child, method, params, id) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => reject(new Error(`MCP ${method} timed out: ${stderr}`)), 10_000)
    const onStdout = (chunk) => {
      stdout += chunk
      let newline = stdout.indexOf('\n')
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim()
        stdout = stdout.slice(newline + 1)
        if (line) {
          const message = JSON.parse(line)
          if (message.id === id) {
            clearTimeout(timeout)
            child.stdout.off('data', onStdout)
            if (message.error) reject(new Error(`MCP ${method} failed: ${JSON.stringify(message.error)}`))
            else resolve(message.result)
            return
          }
        }
        newline = stdout.indexOf('\n')
      }
    }
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.stdout.on('data', onStdout)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

export async function generateCapabilityCatalog(pluginDirectory) {
  const pluginRoot = path.resolve(pluginDirectory)
  const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json')
  const entrypointPath = path.join(pluginRoot, 'scripts', 'mcp-server', 'index.js')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const environment = { ...process.env }
  delete environment.SUPER_EDITOR_MOCK
  const child = spawn(process.execPath, [entrypointPath], {
    cwd: pluginRoot,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  try {
    await requestMcp(child, 'initialize', { protocolVersion: '2025-06-18' }, 1)
    const listed = await requestMcp(child, 'tools/list', {}, 2)
    if (!Array.isArray(listed?.tools) || listed.tools.length === 0) {
      throw new Error('MCP tools/list returned no tools')
    }
    const names = listed.tools.map((tool) => tool?.name)
    if (names.some((name) => typeof name !== 'string' || !name.trim())) {
      throw new Error('MCP tools/list returned an invalid tool name')
    }
    const uniqueNames = [...new Set(names)].sort()
    if (uniqueNames.length !== names.length) throw new Error('MCP tools/list returned duplicate tool names')
    const canonical = {
      schema_version: CATALOG_SCHEMA_VERSION,
      plugin: { name: manifest.name, version: manifest.version },
      source: {
        kind: 'mcp_tools_list',
        method: 'tools/list',
        entrypoint: 'scripts/mcp-server/index.js'
      },
      tools: uniqueNames
    }
    return { ...canonical, catalog_hash: hashJson(canonical) }
  } finally {
    child.kill()
  }
}

export async function runCli(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.length === 0) {
    process.stdout.write('Usage: generate-capability-catalog.mjs --plugin-dir <super-editor-control> --out <catalog.json>\n')
    return 0
  }
  const options = parseArgs(argv)
  if (!options['plugin-dir'] || !options.out) throw new Error('--plugin-dir and --out are required')
  const catalog = await generateCapabilityCatalog(options['plugin-dir'])
  atomicWriteText(options.out, `${JSON.stringify(catalog, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ output: path.resolve(options.out), catalog_hash: catalog.catalog_hash, tools: catalog.tools.length })}\n`)
  return 0
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  try {
    process.exitCode = await runCli()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 2
  }
}
