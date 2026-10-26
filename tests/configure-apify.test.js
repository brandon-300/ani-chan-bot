const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { saveToken } = require('../scripts/configure-apify');

function envFile(t, text) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'anichan-apify-test-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const filename = path.join(folder, '.env');
  fs.writeFileSync(filename, text);
  return { folder, filename };
}

test('token setup appends or replaces the token while preserving other settings and hiding file permissions', t => {
  const original = '# Existing config\r\nOWNER_NUMBER=owner@c.us\r\nMONGO_URI="test-value"\r\n';
  const { filename } = envFile(t, original);
  saveToken('apify_api_test_only', filename);
  assert.equal(fs.readFileSync(filename, 'utf8'), original + 'APIFY_TOKEN=apify_api_test_only\r\n');
  saveToken('apify_api_replacement', filename);
  assert.equal(fs.readFileSync(filename, 'utf8'), original + 'APIFY_TOKEN=apify_api_replacement\r\n');
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
});

test('duplicate token entries are replaced once, without changing unrelated values', t => {
  const { filename } = envFile(t, 'APIFY_TOKEN=old\nOTHER=value\nexport APIFY_TOKEN=older\n');
  saveToken('apify_api_new', filename);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'APIFY_TOKEN=apify_api_new\nOTHER=value\n');
});

test('invalid token input and interrupted writes keep the previous file intact', t => {
  const original = 'OWNER_NUMBER=owner@c.us\n';
  const { filename, folder } = envFile(t, original);
  for (const value of ['', 'token\nOTHER=injected', 'token with spaces', 'x'.repeat(4097)]) assert.throws(() => saveToken(value, filename));
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('simulated write failure'), { code: 'EACCES' }); });
  assert.throws(() => saveToken('apify_api_new', filename), { code: 'EACCES' });
  assert.equal(fs.readFileSync(filename, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(folder), ['.env']);
});

test('interactive setup does not echo a token typed into a terminal', t => {
  const python = ['python3', 'python'].find(binary => spawnSync(binary, ['--version']).status === 0);
  if (!python) return t.skip('Optional Python PTY harness unavailable; token-file logic is covered separately.');
  const { folder, filename } = envFile(t, 'OWNER_NUMBER=owner@c.us\n');
  fs.mkdirSync(path.join(folder, 'scripts'));
  fs.copyFileSync(require.resolve('../scripts/configure-apify'), path.join(folder, 'scripts/configure-apify.js'));
  const script = `
import os,pty,select,subprocess,sys,time
master,slave=pty.openpty()
p=subprocess.Popen(['node',sys.argv[1]],stdin=slave,stdout=slave,stderr=slave)
os.close(slave)
output=b''
deadline=time.monotonic()+5
sent=False
while time.monotonic()<deadline:
 ready,_,_=select.select([master],[],[],0.1)
 if ready:
  try:chunk=os.read(master,4096)
  except OSError:break
  if not chunk:break
  output+=chunk
  if b'(hidden): ' in output and not sent:
   os.write(master,b'apify_api_terminal_test\\n');sent=True
 if p.poll() is not None:break
if p.poll() is None:p.kill()
p.wait();os.close(master)
sys.stdout.buffer.write(output)
sys.exit(p.returncode)
`;
  const result = spawnSync(python, ['-c', script, path.join(folder, 'scripts/configure-apify.js')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /APIFY_TOKEN saved/);
  assert.ok(!result.stdout.includes('apify_api_terminal_test'));
  assert.match(fs.readFileSync(filename, 'utf8'), /APIFY_TOKEN=apify_api_terminal_test/);
});
