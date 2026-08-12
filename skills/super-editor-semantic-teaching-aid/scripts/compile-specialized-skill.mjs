#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { assertValidRulePack, atomicWriteText, hashJson, readJson } from './semantic-rule-tools.mjs'

const COMPILER_MARKER = '<!-- managed-by: super-editor-semantic-teaching-aid -->'

function yamlString(value) {
  return JSON.stringify(String(value))
}

function markdownText(value) {
  return String(value).replace(/[\r\n]+/g, ' ').trim()
}

function ensureSafeTarget(outputDirectory, skillName) {
  const root = path.resolve(outputDirectory)
  const target = path.resolve(root, skillName)
  if (path.dirname(target) !== root) throw new Error('compiled skill target must be a direct child of --output-dir')
  return target
}

export function renderSpecializedSkill(pack) {
  const name = pack.identity.skill_name
  const family = markdownText(pack.identity.book_family)
  const templateId = String(pack.templates.default.template_id)
  const variantCount = pack.templates.variants.length
  const ruleCount = pack.rules.length
  const description = `使用 super-editor-control 按已确认的语义规则制作“${family}”界面型教辅。用户要求从完整原课件生成或微调这类书、使用默认样章 ${templateId} 或其特殊目录变体、复制文本/图片/数字模块、复用或删除区块、调整布局与大纲，或按已验证规则批量处理书单时使用；以语义理解和原子编辑能力执行。`
  return `---
name: ${name}
description: ${yamlString(description)}
---

${COMPILER_MARKER}

# ${markdownText(pack.identity.display_name)}

按版本 ${pack.identity.version} 的已确认语义规则执行。完整读取
[rule-pack.json](references/rule-pack.json)，不得把其中的自然语言意图改写为固定插槽。

## 执行

1. 加载 \`super-editor-control\` 总控技能及当前任务需要的最小子技能。
2. 核对来源是否符合 \`applicability\`，并在切书前冻结完整源目录快照。
3. 默认选样章 \`${templateId}\`；仅当一个最高优先级 \`templates.variants.when\` 语义命中时使用该变体。
4. 按 \`order\` 执行 ${ruleCount} 条规则。用语义角色、基数、结构与锚点共同匹配；sourceId/template
   指纹只能辅助，不得用任意 ID 单独决定目标。
5. 写前报告匹配证据和歧义，获用户授权后建立 checkpoint，并只调用插件原子能力写入。
6. 遵守每条规则的 \`on_missing\`、\`on_ambiguous\` 和验收。未知动作按其 \`intent\`、
   \`required_capabilities\` 与 \`validate\` 组合执行，不把动作类型当封闭枚举。
7. 保存回读、审计和截图后，在稳定区块 JSON 的 \`ai_semantic_provenance\` 写入 Skill/版本、规则 ID、
   运行时绑定与证据、源/样章/结果哈希；保留未知区块字段。

使用本 Skill 自带的脚本生成来源和账本：

\`\`\`powershell
node scripts/provenance-tools.mjs create --rule-pack references/rule-pack.json --input <run.json> --out <provenance.json>
node scripts/batch-ledger.mjs init --rule-pack references/rule-pack.json --books <books.json> --out <ledger.json>
\`\`\`

## 变更与批量

- 本 Skill 含 ${variantCount} 个特殊样章变体。未命中、并列命中或出现新目录模式时停止并回到母 Skill
  \`super-editor-semantic-teaching-aid\` 教授新版本。
- 用户对单个结果的纠正默认视为本书特例；只有明确确认后才可修改规则包并重新编译。
- 只有规则包状态为 \`validated\` 才批量运行；逐本使用账本、目标书锁和幂等检查。
- \`OUTCOME_UNKNOWN\`、数字模块深克隆能力不足或多关系无法表达时停止，依靠真实回读恢复。

交付时分别报告已验证内容、来源追溯、账本状态和未实测学生端交互。不得自动发布书本。
`
}

export function renderOpenAiYaml(pack) {
  const name = pack.identity.skill_name
  const family = markdownText(pack.identity.book_family)
  const short = `按已确认的语义规则安全试制、制作、微调和批量验证${family}界面教辅`
  return `interface:
  display_name: ${yamlString(pack.identity.display_name)}
  short_description: ${yamlString(short.slice(0, 64))}
  default_prompt: ${yamlString(`使用 $${name}，根据当前原课件和已确认样章规则试制或批量生成这类界面教辅。`)}
`
}

export function compileSpecializedSkill(pack, outputDirectory, { force = false } = {}) {
  const validation = assertValidRulePack(pack)
  if (!['trial_approved', 'validated'].includes(pack.identity.status)) {
    throw new Error('only trial_approved or validated rule packs can be compiled')
  }
  const target = ensureSafeTarget(outputDirectory, pack.identity.skill_name)
  let preservedFiles = []
  if (fs.existsSync(target)) {
    if (!force) throw new Error(`target already exists: ${target}; pass --force to refresh a managed skill`)
    const existingSkill = path.join(target, 'SKILL.md')
    const existingRulePack = path.join(target, 'references', 'rule-pack.json')
    let existingPack
    try {
      if (!fs.readFileSync(existingSkill, 'utf8').includes(COMPILER_MARKER)) throw new Error('missing compiler marker')
      existingPack = JSON.parse(fs.readFileSync(existingRulePack, 'utf8'))
    } catch (error) {
      throw new Error(`refusing --force for an unmanaged skill directory: ${error.message}`)
    }
    if (existingPack?.identity?.skill_name !== pack.identity.skill_name) {
      throw new Error('refusing --force because the managed skill identity does not match')
    }
    const generated = new Set([
      'SKILL.md', 'agents/openai.yaml', 'references/rule-pack.json',
      'scripts/semantic-rule-tools.mjs', 'scripts/provenance-tools.mjs', 'scripts/batch-ledger.mjs'
    ])
    preservedFiles = fs.readdirSync(target, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(target, path.join(entry.parentPath ?? entry.path, entry.name)).replaceAll('\\', '/'))
      .filter((filename) => !generated.has(filename))
      .sort()
  }
  fs.mkdirSync(target, { recursive: true })
  atomicWriteText(path.join(target, 'SKILL.md'), renderSpecializedSkill(pack))
  atomicWriteText(path.join(target, 'agents', 'openai.yaml'), renderOpenAiYaml(pack))
  atomicWriteText(path.join(target, 'references', 'rule-pack.json'), `${JSON.stringify(pack, null, 2)}\n`)
  const runtimeScripts = ['semantic-rule-tools.mjs', 'provenance-tools.mjs', 'batch-ledger.mjs']
  const sourceScriptDirectory = path.dirname(fileURLToPath(import.meta.url))
  for (const filename of runtimeScripts) {
    atomicWriteText(path.join(target, 'scripts', filename), fs.readFileSync(path.join(sourceScriptDirectory, filename), 'utf8'))
  }
  return {
    skill_name: pack.identity.skill_name,
    version: pack.identity.version,
    status: pack.identity.status,
    output: target,
    rule_pack_hash: hashJson(pack),
    warnings: [
      ...validation.warnings,
      ...preservedFiles.map((filename) => `preserved unmanaged file: ${filename}`)
    ],
    files: [
      'SKILL.md',
      'agents/openai.yaml',
      'references/rule-pack.json',
      ...runtimeScripts.map((filename) => `scripts/${filename}`)
    ]
  }
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--force') {
      options.force = true
      continue
    }
    if (!value.startsWith('--')) throw new Error(`unexpected argument: ${value}`)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) throw new Error(`${value} requires a value`)
    options[value.slice(2)] = next
    index += 1
  }
  return options
}

export function runCli(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.length === 0) {
    process.stdout.write('Usage: compile-specialized-skill.mjs --input <rule-pack.json> --output-dir <skills-dir> [--force]\n')
    return 0
  }
  const options = parseArgs(argv)
  if (!options.input || !options['output-dir']) throw new Error('--input and --output-dir are required')
  const result = compileSpecializedSkill(readJson(options.input), options['output-dir'], { force: options.force })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return 0
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  try {
    process.exitCode = runCli()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 2
  }
}
