const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.env.AI_PERSONA = 'marin';
process.env.AI_STICKER_AUTO_ANALYZE = 'false';
process.env.AI_STICKERS_ENABLED = 'true';
process.env.AI_STICKER_MAX_BYTES = '2097152';
process.env.AI_STICKER_DOWNLOAD_TIMEOUT_MS = '30000';
process.env.OWNER_NUMBER = 'owner@c.us';
process.env.CLOUDINARY_URL = 'cloudinary://test:test@test-cloud';
delete process.env.AI_CALL_NAMES;
delete process.env.FISH_VOICE_ID;
delete process.env.FISH_API_KEY;

const { loadPersona } = require('../utils/persona');
const aiStickers = require('../utils/aiStickers');
const { _parseAiControls, _stripSpeechFormatting, _buildPersonaSystemPrompt } = require('../commands/ai');
const AiSticker = require('../models/AiSticker');
const axios = require('axios');
const gemini = require('../utils/gemini');
const { MessageMedia } = require('whatsapp-web.js');
const fishAudio = require('../utils/fishAudio');
const cloudinarySdk = require('cloudinary').v2;
const cloudinaryHelper = require('../utils/cloudinary');

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function fakeQuery(resolve) {
  return {
    lean() { return this; },
    exec() { return Promise.resolve(resolve()); },
    then(onFulfilled, onRejected) { return this.exec().then(onFulfilled, onRejected); },
  };
}

function makeMemoryModel() {
  const records = new Map();
  const keyOf = ({ personaId, hash }) => `${personaId}:${hash}`;
  const matches = (doc, filter = {}) => !!doc && Object.entries(filter || {}).every(([key, value]) => doc[key] === value);
  return {
    records,
    async init() {},
    find(filter = {}) {
      return fakeQuery(() => [...records.values()].filter(doc => matches(doc, filter)).map(clone));
    },
    findOne(filter) {
      return fakeQuery(() => clone([...records.values()].find(doc => matches(doc, filter)) || null));
    },
    findOneAndUpdate(filter, update, options = {}) {
      return fakeQuery(() => {
        const key = keyOf(filter);
        let doc = records.get(key);
        if (!doc && !options.upsert) return null;
        if (!doc) {
          doc = {
            ...filter,
            ...(update.$setOnInsert || {}),
            createdAt: new Date(),
            importedAt: new Date(),
          };
        }
        Object.assign(doc, update.$set || {});
        doc.updatedAt = new Date();
        records.set(key, doc);
        return clone(doc);
      });
    },
    set(doc) { records.set(keyOf(doc), clone(doc)); },
    get(personaId, hash) { return records.get(`${personaId}:${hash}`); },
    hasOnlyPersonaHashIndex() { return matches; },
  };
}

const memoryModel = makeMemoryModel();
const uploadCalls = [];
const cloudinaryMock = {
  isCloudConfigured: () => true,
  async uploadBufferToCloud(bytes, options) {
    uploadCalls.push({ bytes: Buffer.from(bytes), options: { ...options } });
    return {
      url: `https://res.cloudinary.com/test/image/upload/v77/${options.folder}/${options.publicId}.webp`,
      publicId: `${options.folder}/${options.publicId}`,
      version: 77,
    };
  },
};
aiStickers._setAdaptersForTests({ Model: memoryModel, storage: cloudinaryMock, mongoConnected: () => true });

function makeMessage({ senderId = 'owner@c.us', isGroup = false, type = 'chat', bytes = Buffer.from('sticker-fixture') } = {}) {
  const replies = [];
  let downloads = 0;
  return {
    message: {
      fromMe: false,
      type,
      hasMedia: type === 'sticker',
      from: 'owner@c.us',
      async getChat() { return { isGroup, id: { _serialized: isGroup ? 'group@g.us' : 'owner@c.us' } }; },
      async getContact() { return { id: { _serialized: senderId } }; },
      async downloadMedia() {
        downloads += 1;
        return { mimetype: 'image/webp', data: bytes.toString('base64') };
      },
      async reply(text) { replies.push(text); },
    },
    replies,
    get downloads() { return downloads; },
  };
}

const persona = loadPersona();
const importedBytes = Buffer.from('newly imported WebP fixture');
const importedHash = crypto.createHash('sha256').update(importedBytes).digest('hex');
const secondBytes = Buffer.from('second newly imported WebP fixture');
const secondHash = crypto.createHash('sha256').update(secondBytes).digest('hex');
const originalAxiosGet = axios.get;
const originalGenerateVision = gemini.generateVision;
const originalMessageMediaFromUrl = MessageMedia.fromUrl;

test.after(() => {
  for (const session of aiStickers._getImportSessions().values()) {
    if (session.timer) clearTimeout(session.timer);
  }
  axios.get = originalAxiosGet;
  gemini.generateVision = originalGenerateVision;
  MessageMedia.fromUrl = originalMessageMediaFromUrl;
});

test('persona prompts/call names are loaded per character and Mongo enforces persona+hash uniqueness', () => {
  assert.equal(persona.id, 'marin');
  assert.equal(persona.displayName, 'Marin Kitagawa');
  assert.deepEqual(persona.callNames, ['Marin', 'Kitagawa', 'Marin Kitagawa']);
  assert.match(persona.personality, /Cheerful, energetic/);
  assert.match(persona.text, /\[\[reaction:/);
  assert.match(persona.text, /Do not use emojis/i);
  assert.doesNotMatch(persona.voicePrompt, /\[\[reaction:/);
  assert.equal(persona.voice.referenceId, '6f28ed94f4014cc5a9896365e6c4fc21');
  const prompt = _buildPersonaSystemPrompt('Brandon', 'text');
  assert.match(prompt, /Address them by that name as written/);
  assert.doesNotMatch(prompt, /Brandon-kun/);

  const compound = AiSticker.schema.indexes().find(([, options]) => options.unique);
  assert.deepEqual(compound[0], { personaId: 1, hash: 1 });
  assert.equal(compound[1].unique, true);
});

test('Karane and Rias load independently with their supplied Fish Audio IDs and persona-specific prompts', () => {
  const karane = loadPersona('karane');
  const rias = loadPersona('rias');
  assert.equal(karane.voice.referenceId, '86b4af7035ad46b3b86170a0857dddff');
  assert.equal(rias.voice.referenceId, '5d1ec8a03c444ee39074f209622a91aa');
  assert.deepEqual(karane.callNames, ['Karane', 'Inda', 'Karane Inda']);
  assert.deepEqual(rias.callNames, ['Rias', 'Gremory', 'Rias Gremory']);
  assert.match(karane.personality, /tsundere/i);
  assert.match(karane.personality, /loyal/i);
  assert.match(rias.personality, /compassionate/i);
  assert.match(rias.personality, /peerage/i);
  for (const entry of [karane, rias]) {
    assert.match(entry.text, /Do not use emojis/i);
    assert.match(entry.text, /\[\[reaction:<label>\]\]/);
    assert.match(entry.text, /\[\[bot_action:command_menu\]\]/);
    assert.doesNotMatch(entry.voicePrompt, /\[\[reaction:/);
  }
});

test('Cloudinary buffer upload preserves WebP format and version metadata without network access', async () => {
  const originalUploadStream = cloudinarySdk.uploader.upload_stream;
  let uploadOptions;
  cloudinarySdk.uploader.upload_stream = (options, callback) => {
    uploadOptions = options;
    return {
      end(buffer) {
        assert.equal(Buffer.from(buffer).toString(), 'webp-buffer');
        callback(null, {
          secure_url: 'https://res.cloudinary.com/test/image/upload/v9/webp.webp',
          public_id: 'ai-stickers/marin/hash',
          version: 9,
        });
      },
    };
  };
  try {
    const result = await cloudinaryHelper.uploadBufferToCloud(Buffer.from('webp-buffer'), {
      folder: 'ai-stickers/marin', publicId: 'hash', format: 'webp', resourceType: 'image',
    });
    assert.equal(result.url, 'https://res.cloudinary.com/test/image/upload/v9/webp.webp');
    assert.equal(result.publicId, 'ai-stickers/marin/hash');
    assert.equal(result.version, 9);
    assert.equal(uploadOptions.format, 'webp');
    assert.equal(uploadOptions.resource_type, 'image');
  } finally {
    cloudinarySdk.uploader.upload_stream = originalUploadStream;
  }
});

test('AI control tags are removed, malformed controls are stripped, and menu actions remain DM-gated', () => {
  const controls = _parseAiControls('[[reaction:unknown]]Hello! [[reaction:happy]] [[bot_action:command_menu]] [[bot_action:danger]]', { allowBotActions: false });
  assert.equal(controls.text, 'Hello!');
  assert.equal(controls.reaction, 'happy');
  assert.equal(controls.action, null);

  const dmAction = _parseAiControls('[[bot_action:command_menu]]', { allowBotActions: true });
  assert.equal(dmAction.action, 'command_menu');
  assert.equal(dmAction.text, '');

  const malformed = _parseAiControls('Useful answer\n[[reaction:happy]', { allowBotActions: true });
  assert.equal(malformed.text, 'Useful answer');
  const emojiReply = _parseAiControls('Hey Brandon! ✨💖 [[reaction:happy]]');
  assert.equal(emojiReply.text, 'Hey Brandon!');
});

test('TTS strips emoji from direct or quoted text and does not send speech progress text', () => {
  assert.equal(_stripSpeechFormatting('Hey Brandon-kun! What\'s up? ✨💖😂 1️⃣ 🇬🇧'), 'Hey Brandon-kun! What\'s up?');
  const aiSource = fs.readFileSync(path.join(__dirname, '..', 'commands', 'ai.js'), 'utf8');
  const ttsStart = aiSource.indexOf('async tts(client, msg, args)');
  assert.notEqual(ttsStart, -1);
  assert.doesNotMatch(aiSource.slice(ttsStart), /Generating speech/);
  assert.doesNotMatch(aiSource, /['"]-af['"]|filter:a/);
});

test('sticker classifier parser normalizes tags and bounds notes', () => {
  const result = aiStickers._parseClassification('```json\n{"emotions":["Happy!", "HAPPY"],"moods":["playful mood"],"uses":["reaction"],"reactions":["amused","made-up"],"intensity":"high","notes":"Smiling face.\\n with hearts"}\n```');
  assert.deepEqual(result.emotions, ['happy']);
  assert.deepEqual(result.moods, ['playful-mood']);
  assert.deepEqual(result.uses, ['reaction']);
  assert.deepEqual(result.reactions, ['amused']);
  assert.equal(result.intensity, 'high');
  assert.equal(result.notes, 'Smiling face. with hearts');
  assert.equal(aiStickers._parseClassification(JSON.stringify({ notes: 'x'.repeat(250) })).notes.length, 160);
});

test('owner private-DM imports save to one shared library and deduplicate across personas', async () => {
  const client = { async sendMessage() {} };
  const unauthorized = makeMessage({ senderId: 'other@c.us', type: 'sticker', bytes: importedBytes });
  assert.equal(await aiStickers.handleIncomingSticker(client, unauthorized.message), false);
  assert.equal(unauthorized.downloads, 0);

  const ownerInGroup = makeMessage({ isGroup: true, type: 'sticker', bytes: importedBytes });
  assert.equal(await aiStickers.handleIncomingSticker(client, ownerInGroup.message), false);
  assert.equal(ownerInGroup.downloads, 0);

  const start = makeMessage();
  assert.equal(await aiStickers.startImportMode(client, start.message), true);
  assert.equal(aiStickers._getImportSessions().size, 1);

  const first = makeMessage({ type: 'sticker', bytes: importedBytes });
  assert.equal(await aiStickers.handleIncomingSticker(client, first.message), true);
  assert.match(first.replies[0], /saved to the shared AI sticker library/);
  const stored = memoryModel.get('marin', importedHash);
  assert.ok(stored);
  assert.equal(stored.hash, importedHash);
  assert.equal(stored.personaId, 'marin');
  assert.equal(stored.cloudinaryPublicId, `ai-stickers/shared/${importedHash}`);
  assert.match(stored.cloudinaryUrl, /^https:\/\//);
  assert.equal(stored.cloudinaryVersion, 77);
  assert.equal(stored.format, 'webp');
  assert.equal(stored.bytes, importedBytes.length);
  assert.equal(stored.analysisStatus, 'unclassified');
  assert.deepEqual(uploadCalls[0].options, {
    folder: 'ai-stickers/shared', publicId: importedHash, resourceType: 'image', format: 'webp',
  });

  const duplicate = makeMessage({ type: 'sticker', bytes: importedBytes });
  assert.equal(await aiStickers.handleIncomingSticker(client, duplicate.message), true);
  assert.match(duplicate.replies[0], /already in the shared AI sticker library/);
  assert.equal(uploadCalls.length, 1, 'a duplicate must not upload again');

  // A different persona reuses the original record and Cloudinary object.
  const gojoCopy = await aiStickers._persistStickerRecord({ id: 'gojo' }, importedHash, importedBytes);
  assert.equal(gojoCopy.duplicate, true);
  assert.equal(gojoCopy.record.personaId, 'marin');
  assert.equal(uploadCalls.length, 1, 'another persona must not create a second Cloudinary copy');

  const second = makeMessage({ type: 'sticker', bytes: secondBytes });
  assert.equal(await aiStickers.handleIncomingSticker(client, second.message), true);
  assert.ok(memoryModel.get('marin', secondHash));

  const stop = makeMessage();
  assert.equal(await aiStickers.stopImportMode(stop.message), true);
  assert.equal(aiStickers._getImportSessions().size, 0);
});

test('legacy persona-tagged Cloudinary stickers are shared and reused without migration or re-upload', async () => {
  const legacyBytes = Buffer.from('sticker saved before shared-library rollout');
  const legacyHash = crypto.createHash('sha256').update(legacyBytes).digest('hex');
  const legacyUrl = `https://res.cloudinary.com/test/image/upload/v12/ai-stickers/marin/${legacyHash}.webp`;
  memoryModel.set({
    personaId: 'marin',
    hash: legacyHash,
    cloudinaryPublicId: `ai-stickers/marin/${legacyHash}`,
    cloudinaryUrl: legacyUrl,
    cloudinaryVersion: 12,
    format: 'webp',
    bytes: legacyBytes.length,
    analysisStatus: 'classified',
    emotions: ['love'],
    moods: ['warm'],
    uses: ['reaction'],
    reactions: ['love'],
    intensity: 'medium',
    notes: 'already saved',
    importedAt: new Date(),
    analyzedAt: new Date(),
  });
  aiStickers._setAdaptersForTests({ Model: memoryModel, storage: cloudinaryMock, mongoConnected: () => true });
  const records = await aiStickers.initialize();
  const rias = loadPersona('rias');
  const selected = await aiStickers._selectSticker('love', 'legacy-shared-chat', rias);
  assert.ok(records.some(entry => entry.hash === legacyHash));
  assert.equal(selected.entry.hash, legacyHash);
  assert.equal(selected.entry.cloudinaryUrl, legacyUrl);
  assert.equal(selected.persona.id, 'rias');

  const before = uploadCalls.length;
  const reused = await aiStickers._persistStickerRecord(rias, legacyHash, legacyBytes);
  assert.equal(reused.duplicate, true);
  assert.equal(reused.record.cloudinaryPublicId, `ai-stickers/marin/${legacyHash}`);
  assert.equal(uploadCalls.length, before, 'legacy Cloudinary sticker must not be uploaded again');
});

test('selector rebuilds metadata from Mongo and uses Cloudinary URLs, with exact and unclassified fallback tiers', async () => {
  const first = memoryModel.get('marin', importedHash);
  memoryModel.set({
    ...first,
    analysisStatus: 'classified',
    emotions: ['amused'],
    moods: ['playful'],
    uses: ['reaction'],
    reactions: ['amused'],
  });
  aiStickers._setAdaptersForTests({ Model: memoryModel, storage: cloudinaryMock, mongoConnected: () => true });
  await aiStickers.initialize(persona);

  const exact = await aiStickers._selectSticker('amused', 'chat-one', persona);
  assert.equal(exact.entry.hash, importedHash);
  assert.match(exact.entry.cloudinaryUrl, /^https:\/\//);
  assert.equal(exact.persona.id, 'marin');

  const genericClassified = await aiStickers._selectSticker('neutral', 'chat-two', persona);
  assert.equal(genericClassified.entry.analysisStatus, 'classified', 'any classified shared sticker is preferred before the unclassified tier');
  assert.notEqual(genericClassified.entry.hash, secondHash);

  for (const record of [...memoryModel.records.values()]) {
    memoryModel.set({ ...record, analysisStatus: 'unclassified', reactions: [] });
  }
  aiStickers._setAdaptersForTests({ Model: memoryModel, storage: cloudinaryMock, mongoConnected: () => true });
  await aiStickers.initialize(persona);
  const unclassified = await aiStickers._selectSticker('neutral', 'chat-three', persona);
  assert.equal(unclassified.entry.analysisStatus, 'unclassified');
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'data', 'ai-stickers')), false, 'selection must not depend on a local library');
});

test('analysis failure leaves the Cloudinary asset and Mongo record intact as unclassified', async () => {
  const pending = { ...memoryModel.get('marin', secondHash), analysisStatus: 'pending' };
  memoryModel.set(pending);
  aiStickers._setAdaptersForTests({ Model: memoryModel, storage: cloudinaryMock, mongoConnected: () => true });
  axios.get = async () => ({ data: Buffer.from('remote Cloudinary WebP bytes') });
  gemini.generateVision = async () => { throw new Error('simulated Gemini failure'); };

  await aiStickers._analyzeSticker(persona, secondHash);
  const after = memoryModel.get('marin', secondHash);
  assert.equal(after.analysisStatus, 'unclassified');
  assert.match(after.analysisError, /simulated Gemini failure/);
  assert.equal(after.cloudinaryUrl, pending.cloudinaryUrl);
  assert.equal(after.cloudinaryPublicId, pending.cloudinaryPublicId);
});

test('reaction sends use Cloudinary bytes as a standalone sticker with bot/persona attribution', async () => {
  aiStickers._setAdaptersForTests({ Model: memoryModel, storage: cloudinaryMock, mongoConnected: () => true });
  await aiStickers.initialize(persona);
  axios.get = async url => {
    assert.match(url, /^https:\/\/res\.cloudinary\.com\//);
    return { data: Buffer.from('remote WebP image bytes') };
  };
  let sent;
  const client = { async sendMessage(chatId, media, options) { sent = { chatId, media, options }; } };

  const result = await aiStickers.sendReactionSticker(client, { from: 'chat-three@c.us' }, 'amused');
  assert.equal(result, true);
  assert.equal(sent.chatId, 'chat-three@c.us');
  assert.equal(sent.media.mimetype, 'image/webp');
  assert.equal(sent.options.sendMediaAsSticker, true);
  assert.equal(sent.options.stickerName, 'Ani-Chan Bot');
  assert.equal(sent.options.stickerAuthor, 'Marin Kitagawa');
});

test('AI_STICKERS_ENABLED=false disables sending without affecting text AI modules', () => {
  const script = "const s=require('./utils/aiStickers'); s.sendReactionSticker({sendMessage(){}},{from:'chat'},'happy').then(v=>{if(v!==false)process.exit(2); console.log('disabled')})";
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, AI_STICKERS_ENABLED: 'false' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /disabled/);
});

test('broken persona config is a safe null at runtime and does not crash a fresh module load', () => {
  const script = "const p=require('./utils/persona'); if(p.getActivePersonaSafe()!==null)process.exit(2); console.log('safe')";
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, AI_PERSONA: 'persona-does-not-exist' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /safe/);
  assert.match(result.stderr, /AI persona .* is unavailable/);
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.doesNotMatch(source, /const activePersona\s*=\s*getActivePersona\(/);
});

test('Fish Audio prioritizes explicit IDs, then persona IDs, then the global emergency override', async () => {
  assert.equal(fishAudio._resolveVoiceId('per-call-id', { voice: { referenceId: 'persona-id' } }), 'per-call-id');
  assert.equal(fishAudio._resolveVoiceId(undefined, { voice: { referenceId: 'persona-id' } }), 'persona-id');
  assert.throws(() => fishAudio._resolveVoiceId(undefined, { voice: { referenceId: null } }), { code: 'NO_FISH_VOICE' });
  await assert.rejects(fishAudio.synthesizeSpeech('hello'), { code: 'NO_FISH_KEY' });

  const script = "const f=require('./utils/fishAudio'); if(f._resolveVoiceId(undefined,{voice:{referenceId:null}})!=='global-emergency')process.exit(2); console.log('override')";
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, FISH_VOICE_ID: 'global-emergency', AI_PERSONA: 'marin' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /override/);
});

test('Fish Audio sends the persona reference directly without post-effect settings', () => {
  const script = `
    const axios = require('axios');
    axios.post = async (_url, body, options) => {
      console.log(JSON.stringify({ body, model: options.headers.model }));
      return { data: Buffer.from('audio-fixture') };
    };
    require('./utils/fishAudio').synthesizeSpeech('hello').then(buffer => {
      if (buffer.toString() !== 'audio-fixture') process.exit(2);
    }).catch(error => { console.error(error); process.exit(3); });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, FISH_API_KEY: 'test-key', FISH_VOICE_ID: 'global-emergency', AI_PERSONA: 'karane' },
  });
  assert.equal(result.status, 0, result.stderr);
  const request = JSON.parse(result.stdout.trim());
  assert.equal(request.body.reference_id, '86b4af7035ad46b3b86170a0857dddff');
  assert.equal(request.body.prosody.normalize_loudness, false);
  assert.equal(request.body.normalize, true, 'Fish Audio text normalization is retained for natural number reading');
  assert.equal('effects' in request.body, false);
  assert.equal('pitch' in request.body, false);
});

test('AI_CALL_NAMES replaces only the active persona names when explicitly set', () => {
  const script = "const p=require('./utils/persona').getActivePersona(); console.log(JSON.stringify(p.callNames))";
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, AI_PERSONA: 'marin', AI_CALL_NAMES: 'TestName,Test Alias' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), ['TestName', 'Test Alias']);
});
