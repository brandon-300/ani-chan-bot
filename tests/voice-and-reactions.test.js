const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Config is read once at require time, so set everything first.
process.env.AI_PERSONA = 'marin';
process.env.AI_STICKERS_ENABLED = 'false';
process.env.AI_STICKER_AUTO_ANALYZE = 'false';
process.env.AI_MESSAGE_MEMORY_MAX = '3';
process.env.AI_MESSAGE_MEMORY_MS = '60000';
for (const name of ['FISH_LATENCY', 'FISH_CHUNK_LENGTH', 'FISH_TEMPERATURE', 'FISH_TOP_P', 'FISH_SPEED', 'FISH_VOLUME_DB', 'FISH_EXPRESSION_TAGS', 'FISH_VOICE_ID']) {
  delete process.env[name];
}
process.env.FISH_API_KEY = 'test-key';

const speechText = require('../utils/speechText');
const fishAudio = require('../utils/fishAudio');
const { loadPersona } = require('../utils/persona');
const ledger = require('../utils/aiMessageLedger');
const { createReactionHandler, pickReactionEmoji, FAMILIES } = require('../utils/aiReactions');
const ai = require('../commands/ai');

const ROOT = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

// ─── Speech text ────────────────────────────────────────────────────────────
test('speech: emojis, emoticons and control tokens never reach the voice engine', () => {
  const out = speechText.toSpeechText('Ahaha, no way 😂😂 that is so funny!!!! :) XD ^_^ 1️⃣ 🇬🇧 [[reaction:laughing]] [[bot_action:command_menu]] [[reaction:hap');
  assert.equal(out, 'Ahaha, no way that is so funny!!');
});

test('speech: [bracket] cues, (S1 cues) and stage directions are removed, emphasised words are kept', () => {
  assert.equal(speechText.toSpeechText('[laughs] Ehh?! (happy) wait, you did *that*? *giggles* okay okay~'), 'Ehh?! wait, you did that? okay okay');
  assert.equal(speechText.toSpeechText('(sighs) fine. [whispers sweetly] come closer <|speaker:1|>hi ~blushes~ ok'), 'fine. come closer hi ok');
  assert.equal(speechText.toSpeechText('{sound effect} hello [pause] there'), 'hello there');
  assert.equal(speechText.toSpeechText('I can (kinda) see it'), 'I can kinda see it');
});

test('speech: ordinary emphasised words are kept, only real stage directions are dropped', () => {
  assert.equal(speechText.toSpeechText('*look* at this'), 'look at this');
  assert.equal(speechText.toSpeechText('I am *angry* right now'), 'I am angry right now');
  assert.equal(speechText.toSpeechText('You are *so happy*?'), 'You are so happy?');
  assert.equal(speechText.toSpeechText('**sad** day'), 'sad day');
  assert.equal(speechText.toSpeechText('*giggles* okay'), 'okay');
  assert.equal(speechText.toSpeechText('*laughs softly* fine'), 'fine');
  assert.equal(speechText.toSpeechText('(laughing) ha ha'), 'ha ha');
  assert.equal(speechText.toSpeechText('I am (really) tired'), 'I am really tired');
});

test('speech: chat shorthand becomes spoken words and links are dropped', () => {
  assert.equal(speechText.toSpeechText('omg lol idk btw u are right, see https://example.com/page now'), 'oh my god haha I don\'t know by the way you are right, see now');
  assert.equal(speechText.toSpeechText('tbh ngl pls thx'), 'to be honest not gonna lie please thanks');
});

test('speech: markdown goes, line breaks become sentence breaks, tildes inside words do not split them', () => {
  assert.equal(speechText.toSpeechText('**Bold** and _italic_ and `code`\n# Heading'), 'Bold and italic and code. Heading');
  assert.equal(speechText.toSpeechText('Line one\nLine two.\n\n- bullet a\n- bullet b'), 'Line one. Line two. bullet a. bullet b');
  assert.equal(speechText.toSpeechText('Hehe~ you are sil~ly'), 'Hehe you are silly');
});

test('speech: expressive punctuation survives but runaway punctuation is tamed', () => {
  assert.equal(speechText.toSpeechText('Wait... really?! No way!!!!!!'), 'Wait... really?! No way!!');
  assert.equal(speechText.toSpeechText('hmm........ maybe???'), 'hmm... maybe??');
});

test('speech: no non-spoken symbol survives, whatever the input looks like', () => {
  const nasty = [
    '*waves* hi [[x]] [a] (b) {c} <d> `e` ~f~ #g _h_ 😀', '[[[[', ']]]]', '**', '(((', 'a_b_c', '😀😀😀', '[excited] [excited] hello',
    '(laughing) Ha ha (crying loudly) ok', '~~strike~~ **bold** __under__ ```code```', 'x *y* z *giggles softly* w',
  ];
  for (const input of nasty) {
    const out = speechText.toSpeechText(input);
    assert.doesNotMatch(out, /[\[\]{}<>*_`~#]/, `symbols left in ${JSON.stringify(out)} from ${JSON.stringify(input)}`);
    assert.doesNotMatch(out, speechText.EMOJI_SEQUENCE, `emoji left in ${JSON.stringify(out)}`);
    assert.doesNotMatch(out, /\(\s*(?:happy|laughing|sighs?|giggles?)\s*\)/i);
  }
  assert.equal(speechText.toSpeechText(''), '');
  assert.equal(speechText.toSpeechText(null), '');
});

test('speech: the optional expression cue only ever uses the short documented list', () => {
  assert.deepEqual([...speechText.SAFE_CUES].sort(), ['angry', 'excited', 'gasp', 'laugh', 'sad', 'sigh', 'surprised', 'whisper']);
  assert.equal(speechText.applyExpressionCue('Ehh?! Wait, really?'), '[surprised] Ehh?! Wait, really?');
  assert.equal(speechText.applyExpressionCue('Ahaha okay!'), 'Ahaha okay!', 'laughter words already make the sound, so no tag');
  assert.equal(speechText.applyExpressionCue('Just a normal sentence.'), 'Just a normal sentence.');
  assert.equal(speechText.applyExpressionCue('Hello there', 'giggling-sweetly-and-twirling'), 'Hello there', 'unknown cues are refused');
  assert.equal(speechText.applyExpressionCue('Hello there', 'sad'), '[sad] Hello there');
});

test('speech: cues are off by default and added only to the text sent to Fish, never to history', () => {
  const source = read('commands/ai.js');
  assert.equal(require('../utils/config').FISH_EXPRESSION_TAGS, false);
  assert.match(source, /FISH_EXPRESSION_TAGS \? speechText\.applyExpressionCue\(reply\) : reply/);
  assert.match(source, /FISH_EXPRESSION_TAGS \? speechText\.applyExpressionCue\(text\) : text/);
  const voiceBody = source.slice(source.indexOf('async voice(client, msg, args)'), source.indexOf('async imagine(client, msg, args)'));
  assert.ok(voiceBody.indexOf('addTurnToHistory(chat.id._serialized, senderId, resolved.prompt, reply)') < voiceBody.indexOf('applyExpressionCue'), 'history is saved from the plain spoken text');
});

test('.tts hands Fish Audio only cleaned text (emojis, cues and stage directions removed)', async () => {
  const captured = [];
  const original = fishAudio.synthesizeSpeech;
  fishAudio.synthesizeSpeech = async text => { captured.push(text); throw new Error('stop before ffmpeg'); };
  const replies = [];
  const msg = { hasQuotedMsg: false, reply: async content => { replies.push(content); return { id: { _serialized: 'x' } }; } };
  try {
    await ai.tts({}, msg, ['Hey', 'there', '😂', '[laughs]', '(happy)', '*giggles*', 'omg', 'lol', '[[reaction:happy]]']);
  } finally {
    fishAudio.synthesizeSpeech = original;
  }
  assert.deepEqual(captured, ['Hey there oh my god haha']);
  assert.match(replies.at(-1), /TTS failed/);
});

// ─── Emojis in text, none in speech ─────────────────────────────────────────
test('prompts: text replies may use emojis, voice replies may not', () => {
  const textPrompt = ai._buildPersonaSystemPrompt('Sam', 'text', false);
  const voicePrompt = ai._buildPersonaSystemPrompt('Sam', 'voice', false);
  assert.match(textPrompt, /You may use emojis the way a real person texting does/);
  assert.doesNotMatch(textPrompt, /Never use emojis or emoticons in any reply/);
  assert.match(voicePrompt, /never use emojis, emoticons, symbols, brackets or stage directions/i);
  assert.doesNotMatch(voicePrompt, /You may use emojis/);
});

test('visible AI text keeps its emojis while the control token is still removed', () => {
  const parsed = ai._parseAiControls('Okay okay 😂✨ that is hilarious [[reaction:laughing]]');
  assert.equal(parsed.text, 'Okay okay 😂✨ that is hilarious');
  assert.equal(parsed.reaction, 'laughing');
  assert.equal(speechText.toSpeechText(parsed.text), 'Okay okay that is hilarious');
});

test('every persona voice prompt forbids brackets, parentheses, tildes and stage directions, and asks for spoken rhythm', () => {
  for (const id of ['marin', 'karane', 'rias']) {
    const voice = loadPersona(id).voicePrompt;
    assert.match(voice, /No brackets or parentheses of any kind/, id);
    assert.match(voice, /tildes/, id);
    assert.match(voice, /stage directions/, id);
    assert.match(voice, /voice message, not chat message/i, id);
    assert.doesNotMatch(voice, /hehe~|mou~/, `${id} must not teach the model to write tildes`);
    assert.match(loadPersona(id).text, /Emojis are welcome in text replies/, id);
  }
});

// ─── Fish Audio request ─────────────────────────────────────────────────────
test('fish: the request carries expressive sampling defaults and keeps the existing guarantees', () => {
  const body = fishAudio._buildTtsPayload('hello', 'ref-id', null);
  assert.equal(body.reference_id, 'ref-id');
  assert.equal(body.format, 'mp3');
  assert.equal(body.normalize, true);
  assert.equal(body.prosody.normalize_loudness, false);
  assert.equal(body.temperature, 0.8);
  assert.equal(body.top_p, 0.8);
  assert.equal('speed' in body.prosody, false, 'speed 1 is the default, so it is not sent');
  assert.equal('volume' in body.prosody, false);
  assert.equal('latency' in body, false);
  assert.equal('chunk_length' in body, false);
  assert.equal('effects' in body, false);
  assert.equal('pitch' in body, false);
});

test('fish: persona tuning overrides the defaults, explicit overrides beat the persona', () => {
  const marin = loadPersona('marin');
  const rias = loadPersona('rias');
  const fast = fishAudio._buildTtsPayload('hi', 'r', marin);
  assert.equal(fast.prosody.speed, 1.05);
  assert.equal(fast.temperature, 0.85);
  const calm = fishAudio._buildTtsPayload('hi', 'r', rias);
  assert.equal(calm.prosody.speed, 0.97);
  assert.equal(calm.temperature, 0.75);
  const overridden = fishAudio._buildTtsPayload('hi', 'r', marin, { speed: 1, temperature: 0.5, topP: 0.6, volume: 3 });
  assert.equal('speed' in overridden.prosody, false);
  assert.equal(overridden.temperature, 0.5);
  assert.equal(overridden.top_p, 0.6);
  assert.equal(overridden.prosody.volume, 3);
});

test('persona voice tuning is validated when the persona loads', () => {
  const dir = path.join(ROOT, 'config', 'personas', 'zz-test-tuning');
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (const name of ['personality.txt', 'text.txt', 'voice.txt']) fs.writeFileSync(path.join(dir, name), 'x');
    const write = voice => fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id: 'zz-test-tuning', displayName: 'T', callNames: ['T'], stickerAuthor: 'T', voice }));
    write({ referenceId: 'abc', speed: 1.2, temperature: 0.9 });
    assert.equal(loadPersona('zz-test-tuning').voice.speed, 1.2);
    for (const bad of [{ speed: 5 }, { speed: '1.2' }, { temperature: 2 }, { topP: -1 }, { volume: 99 }]) {
      write({ referenceId: 'abc', ...bad });
      assert.throws(() => loadPersona('zz-test-tuning'), /must be a number between/, JSON.stringify(bad));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Ledger ─────────────────────────────────────────────────────────────────
test('ledger: remembers AI messages by ID, expires them, and stays bounded', () => {
  ledger._reset();
  let now = 1_000_000;
  ledger._setClock(() => now);
  assert.equal(ledger.remember({ id: { _serialized: 'm1' } }, 'text'), true);
  assert.equal(ledger.remember('m2', 'voice'), true);
  assert.equal(ledger.remember({}, 'text'), false, 'a send result without an ID is ignored');
  assert.equal(ledger.get('m1').kind, 'text');
  assert.equal(ledger.get('m2').kind, 'voice');
  assert.equal(ledger.get('nope'), null);
  assert.equal(ledger.markReacted('m1'), true);
  assert.ok(ledger.get('m1').reactedAt > 0);

  ledger.remember('m3', 'sticker');
  ledger.remember('m4', 'image'); // limit is 3, so the oldest (m1) is evicted
  assert.equal(ledger._size(), 3);
  assert.equal(ledger.get('m1'), null);
  assert.equal(ledger.get('m4').kind, 'image');

  now += 61_000; // past the 60 s memory
  assert.equal(ledger.get('m4'), null);
  ledger._reset();
});

test('ledger: every AI text reply, voice note, image and sticker is recorded', async () => {
  ledger._reset();
  const sent = [];
  const msg = {
    reply: async content => {
      const message = { id: { _serialized: `sent-${sent.length + 1}` }, content };
      sent.push(message);
      return message;
    },
  };
  await ai._deliverTextResponse({}, msg, 'Hello there 😊 [[reaction:none]]');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, 'Hello there 😊');
  assert.equal(ledger.get('sent-1').kind, 'text');
  ledger._reset();

  const source = read('commands/ai.js');
  assert.match(source, /replyTracked\(msg, voiceMedia, 'voice'/);
  assert.match(source, /replyTracked\(msg, media, 'image'/);
  assert.match(read('utils/aiStickers.js'), /aiMessageLedger\.remember\(sent, 'sticker'\)/);
});

// ─── Reacting to reactions ──────────────────────────────────────────────────
function makeHarness(settings = {}, rngValues = null) {
  ledger._reset();
  const calls = [];
  const client = {
    info: { wid: { _serialized: 'bot@c.us' } },
    sendReaction: async (id, emoji) => { calls.push(['sendReaction', id, emoji]); },
    // Anything else the handler might try to do is recorded as a violation.
    sendMessage: async () => { calls.push(['sendMessage']); },
    reply: async () => { calls.push(['reply']); },
  };
  let i = 0;
  const rng = rngValues ? () => rngValues[i++ % rngValues.length] : () => 0;
  const handler = createReactionHandler({
    client,
    ledger,
    settings: { enabled: true, chance: 1, cooldownMs: 0, delayMinMs: 0, delayMaxMs: 0, ...settings },
    rng,
    now: () => 1_000_000,
    schedule: async fn => { await fn(); },
  });
  return { handler, calls, client };
}

function reactionEvent(overrides = {}) {
  return {
    id: { fromMe: false, _serialized: 'reaction-1' },
    reaction: '😂',
    senderId: 'friend@c.us',
    msgId: { fromMe: true, remote: 'chat@g.us', _serialized: 'true_chat@g.us_MSG1' },
    ...overrides,
  };
}

test('reactions: reacts to the SAME AI message and sends nothing else', async () => {
  const { handler, calls } = makeHarness();
  ledger.remember('true_chat@g.us_MSG1', 'text');
  const decision = handler.handle(reactionEvent());
  assert.equal(decision.action, 'react');
  await decision.done;
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'sendReaction');
  assert.equal(calls[0][1], 'true_chat@g.us_MSG1');
  assert.ok(FAMILIES.find(f => f.name === 'laugh').replies.includes(calls[0][2]), `unexpected reply emoji ${calls[0][2]}`);
  assert.ok(!calls.some(call => call[0] === 'sendMessage' || call[0] === 'reply'), 'a reaction must never produce a message');
});

test('reactions: works for voice notes, images and stickers as well as text', async () => {
  for (const kind of ['voice', 'image', 'sticker']) {
    const { handler, calls } = makeHarness();
    ledger.remember('true_chat@g.us_MSG1', kind);
    const decision = handler.handle(reactionEvent());
    assert.equal(decision.kind, kind);
    await decision.done;
    assert.equal(calls.length, 1);
  }
});

test('reactions: ignores removals, its own reactions, other messages, repeats and disabled mode', async () => {
  const cases = [
    ['removed reaction', { reaction: '' }, 'reaction_removed'],
    ['own reaction by sender id', { senderId: 'bot@c.us' }, 'own_reaction'],
    ['own reaction by id.fromMe', { id: { fromMe: true, _serialized: 'r' } }, 'own_reaction'],
    ['message the AI did not send', { msgId: { fromMe: true, remote: 'chat@g.us', _serialized: 'true_chat@g.us_OTHER' } }, 'not_ai_message'],
    ['no message id', { msgId: {} }, 'no_message_id'],
  ];
  for (const [label, overrides, reason] of cases) {
    const { handler, calls } = makeHarness();
    ledger.remember('true_chat@g.us_MSG1', 'text');
    const decision = handler.handle(reactionEvent(overrides));
    assert.deepEqual([decision.action, decision.reason], ['skip', reason], label);
    assert.equal(calls.length, 0, label);
  }

  const repeat = makeHarness();
  ledger.remember('true_chat@g.us_MSG1', 'text');
  await repeat.handler.handle(reactionEvent()).done;
  assert.equal(repeat.handler.handle(reactionEvent({ reaction: '🔥' })).reason, 'already_reacted');
  assert.equal(repeat.calls.length, 1, 'only one reaction per message');

  const disabled = makeHarness({ enabled: false });
  ledger.remember('true_chat@g.us_MSG1', 'text');
  assert.equal(disabled.handler.handle(reactionEvent()).reason, 'disabled');
  assert.equal(disabled.calls.length, 0);
});

test('reactions: per-chat cooldown and the reaction chance both hold it back', async () => {
  const cooled = makeHarness({ cooldownMs: 60_000 });
  ledger.remember('true_chat@g.us_MSG1', 'text');
  ledger.remember('true_chat@g.us_MSG2', 'text');
  await cooled.handler.handle(reactionEvent()).done;
  const second = cooled.handler.handle(reactionEvent({ msgId: { fromMe: true, remote: 'chat@g.us', _serialized: 'true_chat@g.us_MSG2' } }));
  assert.equal(second.reason, 'cooldown');
  const elsewhere = cooled.handler.handle(reactionEvent({ msgId: { fromMe: true, remote: 'other@g.us', _serialized: 'true_other@g.us_MSG9' } }));
  assert.equal(elsewhere.reason, 'not_ai_message', 'a different chat has its own cooldown (and this message is unknown)');

  const unlucky = makeHarness({ chance: 0.6 }, [0.99]);
  ledger.remember('true_chat@g.us_MSG1', 'text');
  assert.equal(unlucky.handler.handle(reactionEvent()).reason, 'chance');
  assert.equal(unlucky.calls.length, 0);
  const again = unlucky.handler; // a skipped roll must not consume the message
  assert.equal(ledger.get('true_chat@g.us_MSG1').reactedAt, 0);
  assert.ok(again);
});

test('reactions: emoji choice follows the family of the emoji used, and unknown emojis are mirrored', () => {
  const pick = emoji => pickReactionEmoji(emoji, () => 0);
  assert.equal(pick('😂'), '😂');
  assert.equal(pick('❤️'), '❤️');
  assert.equal(pick('❤'), '❤️', 'with or without the variation selector');
  assert.equal(pick('😢'), '🥺');
  assert.equal(pick('👍'), '👍');
  assert.equal(pick('🦄'), '🦄');
  assert.equal(pick(''), '');
  for (const family of FAMILIES) {
    for (const emoji of family.replies) assert.doesNotMatch(emoji, /^\s*$/);
  }
});

test('reactions: a failed send never throws and the delay is honoured', async () => {
  const { handler, client } = makeHarness({ delayMinMs: 1500, delayMaxMs: 6000 }, [0.5]);
  client.sendReaction = async () => { throw new Error('whatsapp hiccup'); };
  ledger.remember('true_chat@g.us_MSG1', 'text');
  const decision = handler.handle(reactionEvent());
  assert.equal(decision.delayMs, 3750, 'delay is min + rng * (max - min)');
  await assert.doesNotReject(decision.done);
});

test('reactions: the wiring in index.js and the handler module can only ever send a reaction', () => {
  const index = read('index.js');
  const start = index.indexOf("client.on('message_reaction'");
  assert.notEqual(start, -1, 'index.js registers a message_reaction listener');
  const block = index.slice(start, index.indexOf("client.on('group_join'", start));
  assert.match(block, /aiReactionHandler\.handle\(reaction\)/);
  assert.doesNotMatch(block, /\.reply\(|sendMessage\(|sendQuickMenu/);

  const handlerSource = read('utils/aiReactions.js').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(handlerSource, /\.reply\(|sendMessage\(|generateText|generateVision|gemini/i);
  assert.equal((handlerSource.match(/client\.sendReaction\(/g) || []).length, 1, 'exactly one outgoing call');
});
