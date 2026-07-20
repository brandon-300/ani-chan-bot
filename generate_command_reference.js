const fs = require('fs');
const path = require('path');

const projectRoot = process.cwd();
const commandsDir = path.join(projectRoot, 'commands');
const downloadsDir = path.join(process.env.HOME || '', 'storage', 'downloads');
const outputPath = path.join(downloadsDir, 'anichan_bot_commands.txt');

function getCommandsFromFile(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const commands = [];
  let pendingComment = '';

  for (const line of lines) {
    const commentMatch = line.match(/^\s*\/\/\s*(.+)$/);
    if (commentMatch) {
      pendingComment = commentMatch[1].trim();
      continue;
    }

    const fnMatch = line.match(/^\s*(?:async\s+)?([A-Za-z0-9_]+)\s*:\s*async\s*\(/) ||
                    line.match(/^\s*async\s+([A-Za-z0-9_]+)\s*\(/);

    if (fnMatch) {
      const name = fnMatch[1];
      const desc = pendingComment.startsWith('.') ? pendingComment : '';
      commands.push({
        name,
        desc,
      });
      pendingComment = '';
    }
  }

  return commands;
}

function main() {
  if (!fs.existsSync(commandsDir)) {
    throw new Error(`Commands folder not found: ${commandsDir}`);
  }

  const files = fs.readdirSync(commandsDir)
    .filter(f => f.endsWith('.js'))
    .sort();

  const out = [];
  out.push('AniChan Bot Commands');
  out.push('====================');
  out.push('');
  out.push(`Project: ${projectRoot}`);
  out.push(`Generated: ${new Date().toLocaleString()}`);
  out.push('');

  for (const file of files) {
    const filePath = path.join(commandsDir, file);
    const commands = getCommandsFromFile(filePath);

    if (!commands.length) continue;

    out.push(`FILE: ${file}`);
    out.push('-'.repeat(40));

    for (const cmd of commands) {
      out.push(`.${cmd.name}${cmd.desc ? ' — ' + cmd.desc : ''}`);
    }

    out.push('');
  }

  fs.mkdirSync(downloadsDir, { recursive: true });
  fs.writeFileSync(outputPath, out.join('\n'), 'utf8');

  console.log(`✅ Wrote: ${outputPath}`);
}

main();
