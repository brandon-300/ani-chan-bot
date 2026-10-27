const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function exportSource(repo, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const fd = fs.openSync(destination, 'wx', 0o600);
  try {
    execFileSync('git', ['archive', '--format=zip', '--worktree-attributes', 'HEAD'], {
      cwd: repo,
      stdio: ['ignore', fd, 'pipe'],
    });
  } catch (err) {
    fs.closeSync(fd);
    fs.unlinkSync(destination);
    throw err;
  }
  fs.closeSync(fd);
  return destination;
}
if (require.main === module) {
  const repo = path.resolve(__dirname, '..');
  const destination = path.resolve(
    repo,
    process.argv[2] ||
      `backups/anichan-source-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`
  );
  console.log(exportSource(repo, destination));
}
module.exports = { exportSource };
