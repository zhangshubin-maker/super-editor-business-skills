import fs from 'node:fs';
import path from 'node:path';

const tempDir = process.argv[2];
const outDir = process.argv[3];

if (!tempDir || !outDir) {
  throw new Error('Usage: node build-source-plan.mjs <snapshot-temp-dir> <output-dir>');
}

fs.mkdirSync(path.join(outDir, 'source-snapshots'), { recursive: true });

const snapshotFiles = fs.readdirSync(tempDir)
  .filter((name) => /^1814457-\d+-[a-f0-9]{64}\.json$/i.test(name))
  .map((name) => {
    const filePath = path.join(tempDir, name);
    return { name, filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
  })
  .sort((a, b) => b.mtimeMs - a.mtimeMs);

const latestBySlide = new Map();
for (const file of snapshotFiles) {
  const slideId = Number(file.name.split('-')[1]);
  if (!latestBySlide.has(slideId)) latestBySlide.set(slideId, file);
}

function blockName(block) {
  return String(block?.template_data_content?.name || block?.template_info?.content?.name || '');
}

function normalizeArticleHtml(html) {
  return String(html || '')
    .replace(/<b\b[^>]*style="([^"]*)"[^>]*>/gi, (_tag, style) => {
      const kept = style.split(';')
        .map((part) => part.trim())
        .filter((part) => /^(background-color|color)\s*:/i.test(part))
        .join('; ');
      return kept ? `<span style="${kept};">` : '<span>';
    })
    .replace(/<b\b[^>]*>/gi, '<span>')
    .replace(/<\/b>/gi, '</span>')
    .replace(/<span\b([^>]*)style="([^"]*)"([^>]*)>/gi, (_tag, before, style, after) => {
      const kept = style.split(';')
        .map((part) => part.trim())
        .filter((part) => /^(background-color|color)\s*:/i.test(part))
        .join('; ');
      return kept ? `<span${before}style="${kept};"${after}>` : `<span${before}${after}>`;
    });
}

function ensureSubjectProperty(config) {
  const clone = structuredClone(config || {});
  clone.subjectId = Number(clone.subjectId || 2);
  clone.properties = Array.isArray(clone.properties) ? clone.properties : [];
  if (!clone.properties.some((item) => item?.paramName === 'subject_id')) {
    clone.properties.push({ paramName: 'subject_id', paramValue: '2' });
  }
  return clone;
}

const plans = [];
const manifest = [];

for (const [slideId, file] of [...latestBySlide.entries()].sort((a, b) => a[0] - b[0])) {
  const envelope = JSON.parse(fs.readFileSync(file.filePath, 'utf8'));
  const snapshot = envelope.snapshot;
  if (String(snapshot?.identity?.bookId) !== '1814457') continue;

  const blocks = snapshot.blocks || [];
  const english = blocks.find((block) => /^2-英文文本/.test(blockName(block)));
  const translation = blocks.find((block) => /^3-翻译文本/.test(blockName(block)));
  const button = blocks.find((block) => /^4-按钮/.test(blockName(block)));
  const vocabulary = blocks.find((block) => /^5-一级标题/.test(blockName(block)));
  const mnemonic = blocks.find((block) => /^7-按钮/.test(blockName(block)));
  const phonics = blocks.find((block) => /^8-一级/.test(blockName(block)));
  const richItems = snapshot?.richText?.items || [];
  const articleCandidates = richItems.filter((item) => item.blockDatabaseId === english?.id);
  const article = articleCandidates.sort((a, b) => String(b.displayText || '').length - String(a.displayText || '').length)[0];
  const modules = snapshot?.digitalModules?.items || [];
  const audio = modules.find((item) => item.normalized?.type === 77);
  const agent27 = modules.find((item) => item.normalized?.type === 87 && Number(item.normalized?.config?.agentId) === 27);
  const agent34 = modules.find((item) => item.normalized?.type === 87 && Number(item.normalized?.config?.agentId) === 34);
  const courseware = modules.find((item) => item.normalized?.type === 79);

  const required = { english, translation, button, vocabulary, mnemonic, phonics, article, audio, agent27, agent34, courseware };
  const missing = Object.entries(required).filter(([, value]) => !value).map(([key]) => key);
  const copiedName = `source-${slideId}.json`;
  fs.copyFileSync(file.filePath, path.join(outDir, 'source-snapshots', copiedName));

  manifest.push({
    slideId,
    name: snapshot.identity.catalogName,
    sourceFile: copiedName,
    snapshotFileSha256: envelope.snapshotFileSha256,
    snapshotStableHash: envelope.snapshotStableHash,
    fullFidelity: envelope.fullFidelity,
    completeness: envelope.completeness,
    missing,
  });

  plans.push({
    sourceBookId: 1814457,
    sourceBookName: snapshot.identity.bookInfo?.name,
    sourceCategory: snapshot.identity.bookInfo?.category_list?.[0]?.name,
    slideId,
    name: snapshot.identity.catalogName,
    sort: snapshot.identity.catalogSort,
    snapshotStableHash: envelope.snapshotStableHash,
    snapshotFileSha256: envelope.snapshotFileSha256,
    sourceFile: `source-snapshots/${copiedName}`,
    missing,
    article: {
      sourceElementId: article?.elementId,
      sourceBlockId: english?.uuid,
      sourceBlockDatabaseId: english?.id,
      html: normalizeArticleHtml(article?.canonicalHtml || article?.content),
      plainText: String(article?.displayText || '').trimEnd(),
    },
    resources: {
      englishBlockDatabaseId: english?.id,
      translationBlockDatabaseId: translation?.id,
      vocabularyBlockDatabaseId: vocabulary?.id,
      phonicsBlockDatabaseId: phonics?.id,
    },
    modules: {
      audio: audio?.normalized?.config,
      oralPk: ensureSubjectProperty(agent27?.normalized?.config),
      oralAssessment: ensureSubjectProperty(agent34?.normalized?.config),
      mnemonic: courseware?.normalized?.config,
    },
  });
}

fs.writeFileSync(path.join(outDir, 'source-snapshot-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'source-plan.json'), `${JSON.stringify(plans, null, 2)}\n`);

const invalid = plans.filter((plan) => plan.missing.length > 0);
console.log(JSON.stringify({ count: plans.length, invalid }, null, 2));
