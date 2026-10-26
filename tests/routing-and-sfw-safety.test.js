const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const axios = require('axios');
const { fetchRandomImage } = require('../utils/danbooru');

test('SFW results enforce ratings and client-side age/style filters even if the API ignores tags', async t => {
  const sample = { id: 1, file_url: 'https://example.test/image.jpg', file_size: 100, tag_string: '1girl maid', rating: 'g' };
  const bad = [
    { ...sample, rating: 's' }, { ...sample, rating: '' },
    { ...sample, tag_string: 'maid loli' }, { ...sample, tag_string: 'maid shota' },
    { ...sample, tag_string: 'maid photorealistic' },
    { ...sample, tag_string: 'comic maid' }, { ...sample, tag_string: '' },
  ];
  let posts = bad;
  t.mock.method(axios, 'get', async () => ({ data: posts }));
  const options = { ratingLetters: ['g', 'general'], safeOnly: true };
  assert.equal(await fetchRandomImage(['rating:general maid'], options), null);
  posts = [...bad, sample];
  assert.deepEqual(await fetchRandomImage(['rating:general maid'], options), { url: sample.file_url, id: 1 });
});

test('the queued dispatcher leaves GPT reactions empty and retains other command reactions', async () => {
  const source = fs.readFileSync(require.resolve('../index'), 'utf8');
  const start = source.indexOf("      try {\n        if (command === 'play')");
  assert.ok(start > 0);
  const end = source.indexOf('\n\n      return;', start);
  const code = source.slice(start, end);
  for (const [command, expected] of [['gpt', []], ['copilot', []], ['voice', []], ['news', []], ['play', ['▶️']], ['yt', ['⏳']]]) {
    const reactions = [];
    await vm.runInNewContext(`(async () => { ${code} })()`, { command, msg: { react: async emoji => reactions.push(emoji) }, console });
    assert.deepEqual(reactions, expected, command);
  }
});

test('both account gates stop dispatch and send a clear response when verification fails', async () => {
  const source = fs.readFileSync(require.resolve('../index'), 'utf8');
  const start = source.indexOf('    const registrationCheck = await checkRegistrationGate(');
  const end = source.indexOf('    // ── Gemini reservation gate', start);
  const code = source.slice(start, end);
  for (const failing of ['registration', 'session']) {
    const replies = [];
    let continued = false;
    const context = {
      command: 'balance', client: {}, args: [], logger: { error() {}, write() {} },
      msg: { reply: async text => replies.push(text) },
      checkRegistrationGate: async () => {
        if (failing === 'registration') throw new Error('Mongo unavailable');
        return { blocked: false };
      },
      accountSecurity: { _checkSession: async () => { throw new Error('Mongo unavailable'); } },
      next: () => { continued = true; },
    };
    await vm.runInNewContext(`(async () => { ${code}\nnext(); })()`, context);
    assert.equal(continued, false);
    assert.equal(replies.length, 1);
    assert.match(replies[0], /verification is temporarily unavailable/);
  }
});
