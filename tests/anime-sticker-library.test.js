const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.AI_PERSONA = 'marin';
process.env.AI_STICKER_AUTO_ANALYZE = 'false';
process.env.AI_STICKERS_ENABLED = 'true';
process.env.CLOUDINARY_URL = 'cloudinary://test:test@test-cloud';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost/none';

const aiStickers = require('../utils/aiStickers');
const { loadPersona } = require('../utils/persona');
const importer = require('../scripts/import-anime-sticker-packs');
const reset = require('../scripts/reset-ai-sticker-library');

const persona = loadPersona('marin');

function query(resolve) {
  return {
    lean() { return this; },
    exec() { return Promise.resolve(resolve()); },
    then(onFulfilled, onRejected) { return this.exec().then(onFulfilled, onRejected); },
  };
}

function makeLibrary(rows) {
  return {
    async init() {},
    find() { return query(() => rows.map(row => JSON.parse(JSON.stringify(row)))); },
    findOne() { return query(() => null); },
    findOneAndUpdate() { return query(() => null); },
  };
}

function sticker(hash, animeId, { reaction = 'amused', personaFit = 1 } = {}) {
  return {
    personaId: 'shared',
    hash: hash.repeat(64).slice(0, 64),
    cloudinaryPublicId: `ai-stickers/shared/${hash}`,
    cloudinaryUrl: `https://res.cloudinary.com/test/image/upload/v1/ai-stickers/shared/${hash}.webp`,
    bytes: 1000,
    animeId,
    animeName: animeId,
    analysisStatus: 'unclassified',
    personaAnalyses: [{
      personaId: 'marin', analysisVersion: 1, personaVersion: '', analysisStatus: 'classified',
      emotions: [], moods: [], uses: [], reactions: [reaction], intensity: 'medium', personaFit,
    }],
  };
}

async function useLibrary(rows) {
  aiStickers._setAdaptersForTests({
    Model: makeLibrary(rows),
    storage: { isCloudConfigured: () => true },
    mongoConnected: () => true,
  });
  await aiStickers.initialize(persona);
}

test('anime diversity: an equally good sticker from a different anime is preferred after a repeat', async () => {
  await useLibrary([
    sticker('a', 'naruto'), sticker('b', 'naruto'), sticker('c', 'bleach'),
  ]);
  for (let round = 0; round < 12; round += 1) {
    const chat = `chat-diversity-${round}`;
    const first = await aiStickers._selectSticker('amused', chat, persona);
    const second = await aiStickers._selectSticker('amused', chat, persona);
    assert.ok(first && second);
    assert.notEqual(second.entry.animeId, first.entry.animeId, 'second pick must switch anime when an equal alternative exists');
  }
});

test('anime diversity never makes a weak sticker eligible', async () => {
  await useLibrary([
    sticker('a', 'naruto'),
    sticker('b', 'bleach', { personaFit: 0.1 }),
    sticker('c', 'one-piece', { reaction: 'angry' }),
  ]);
  const chat = 'chat-no-weak';
  for (let i = 0; i < 6; i += 1) {
    const picked = await aiStickers._selectSticker('amused', chat, persona);
    assert.ok(picked, 'the one strong match is still used even when its anime was just used');
    assert.equal(picked.entry.animeId, 'naruto', 'poor persona fit and wrong reaction must never win on diversity');
  }
});

test('unknown-anime stickers are not penalised as if they were one franchise', async () => {
  await useLibrary([sticker('a', 'unknown-anime'), sticker('b', 'unknown-anime')]);
  const chat = 'chat-unknown-anime';
  const seen = new Set();
  for (let i = 0; i < 20; i += 1) {
    const picked = await aiStickers._selectSticker('amused', chat, persona);
    assert.ok(picked);
    seen.add(picked.entry.hash);
  }
  assert.equal(seen.size, 2, 'both unknown-anime stickers stay usable (only the recent-hash rule applies)');
});

test('no suitable match still means no sticker', async () => {
  await useLibrary([sticker('a', 'naruto', { reaction: 'sad' }), sticker('b', 'bleach', { reaction: 'sleepy' })]);
  assert.equal(await aiStickers._selectSticker('angry', 'chat-none', persona), null);
});

test('importer: generic reaction labels are a subset of the bot reaction vocabulary', () => {
  for (const label of [...importer.GENERIC_REACTIONS, ...importer.TARGET_REACTIONS]) {
    assert.ok(aiStickers.ALLOWED_REACTIONS.has(label), `${label} must exist in ALLOWED_REACTIONS`);
  }
});

test('importer: pack metadata comes from the manifest, else from a humanised filename', () => {
  const manifest = [{ file: 'naruto.WASTICKERS', animeId: 'naruto', animeName: 'Naruto', sourcePackName: 'Naruto Reactions', characters: ['Naruto Uzumaki'] }];
  const fromManifest = importer.parsePackMetadata('Naruto.wastickers', manifest);
  assert.equal(fromManifest.animeId, 'naruto');
  assert.equal(fromManifest.sourcePackName, 'Naruto Reactions');
  assert.deepEqual(fromManifest.castHints, ['Naruto Uzumaki']);
  const fromName = importer.parsePackMetadata('OnePiece.wastickers', []);
  assert.equal(fromName.animeName, 'One Piece');
  assert.equal(fromName.animeId, 'one-piece');
  assert.equal(fromName.sourcePackName, 'One Piece Reactions');
});

test('importer: only real WebP files are accepted', () => {
  const good = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(8)]);
  assert.equal(importer.isValidWebp(good), true);
  assert.equal(importer.isValidWebp(Buffer.from('this is not an image at all')), false);
  assert.equal(importer.isValidWebp(Buffer.alloc(4)), false);
});

test('importer: generic screening output is sanitised and cannot invent characters or reactions', () => {
  const raw = '```json\n' + JSON.stringify({
    expression: '  wide   eyed shock ', emotions: ['Shock!'], moods: [], uses: ['reply'],
    reactions: ['surprised', 'not-a-reaction'], characters: ['Naruto Uzumaki', 'Totally Invented'], diversityScore: 7,
  }) + '\n```';
  const parsed = importer.parseGenericAnalysis(raw, ['Naruto Uzumaki', 'Sasuke Uchiha']);
  assert.deepEqual(parsed.reactions, ['surprised']);
  assert.deepEqual(parsed.characters, ['Naruto Uzumaki']);
  assert.equal(parsed.expression, 'wide eyed shock');
  assert.equal(parsed.diversityScore, 1);
  assert.throws(() => importer.parseGenericAnalysis('{"reactions":["nope"]}'), /no usable reaction/);
  assert.throws(() => importer.parseGenericAnalysis('no json here'), /no JSON/);
});

test('importer: selection covers different reactions instead of taking the first ten', () => {
  const labels = ['laughing', 'happy', 'sad', 'angry', 'surprised', 'confused', 'embarrassed', 'teasing', 'supportive', 'neutral'];
  const candidates = [];
  for (let i = 0; i < 30; i += 1) {
    candidates.push({ hash: String(i).padStart(64, '0'), genericAnalysis: { reactions: [labels[i % 3 === 0 ? 0 : i % 10]], uses: [], diversityScore: 0.5 } });
  }
  const chosen = importer.chooseDiverse(candidates, 10);
  assert.equal(chosen.length, 10);
  assert.equal(new Set(chosen.map(c => c.hash)).size, 10);
  const covered = new Set(chosen.flatMap(c => c.genericAnalysis.reactions));
  for (const label of labels) assert.ok(covered.has(label), `${label} should be covered`);
  assert.equal(importer.chooseDiverse(candidates.slice(0, 4), 10).length, 4, 'fewer candidates than the target is fine');
});

test('importer: sampleEvenly spreads across a pack and never exceeds the cap', () => {
  const list = Array.from({ length: 100 }, (_, i) => i);
  const sample = importer.sampleEvenly(list, 10);
  assert.equal(sample.length, 10);
  assert.equal(sample[0], 0);
  assert.ok(sample[9] >= 90);
  assert.equal(importer.sampleEvenly([1, 2, 3], 10).length, 3);
});

test('reset: only ai-stickers/ public IDs are ever scheduled for deletion', () => {
  const ids = reset.collectPublicIds(
    [{ public_id: 'ai-stickers/shared/a' }],
    [
      { cloudinaryPublicId: 'ai-stickers/shared/a' },
      { cloudinaryPublicId: 'ai-stickers/dyn/b' },
      { cloudinaryPublicId: 'anichan/cards/never-delete-me' },
      { cloudinaryPublicId: '' },
    ],
  );
  assert.deepEqual(ids.sort(), ['ai-stickers/dyn/b', 'ai-stickers/shared/a']);
});

test('reset: Cloudinary Admin API is called with a single options object (v2 SDK signature)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'reset-ai-sticker-library.js'), 'utf8');
  assert.doesNotMatch(source, /api\.resources\(\s*['"]/, "cloudinary.v2.api.resources() takes one options object, not ('upload', options)");
  assert.match(source, /cloudinaryUtil\.isCloudConfigured\(\)/, 'must use the bot Cloudinary config so separate CLOUDINARY_* vars work');
});

test('importer and reset use the bot Cloudinary helper instead of a bare cloudinary.config()', () => {
  for (const file of ['import-anime-sticker-packs.js', 'reset-ai-sticker-library.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', file), 'utf8');
    assert.doesNotMatch(source, /^[^/\n]*\bcloudinary\.config\(\)/m, `${file} must not rely on a bare cloudinary.config() call`);
    assert.match(source, /require\('\.\.\/utils\/cloudinary'\)/);
  }
});
