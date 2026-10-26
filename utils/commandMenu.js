const { COMMAND_REFERENCE, OWNER_COMMAND_REFERENCE } = require('./commandReference');
const { isOwner } = require('./helpers');

// Trust the transport's DM peer ID, not display names, group-admin/mod roles,
// message text, or getContact() (which can misresolve LIDs to the bot itself).
function commandReferenceForMessage(msg) {
  const peerId = typeof msg?.from === 'string' ? msg.from : '';
  const privateOwner = /(?:@c\.us|@lid)$/.test(peerId)
    && !msg.author && !msg.fromMe && isOwner(peerId);
  return privateOwner ? [...COMMAND_REFERENCE, ...OWNER_COMMAND_REFERENCE] : COMMAND_REFERENCE;
}

// Reduce usage forms to bare command names and preserve real subcommands.
function extractMenuCommands(cmdField) {
  return cmdField.split(' / ').map(variant => {
    const tokens = variant.trim().split(/\s+/);
    const kept = [tokens[0]];
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.startsWith('[') || t.startsWith('@') || t.startsWith('(') || t.startsWith('<') || t.includes('/') || /^[A-Z0-9_-]+$/.test(t)) break;
      kept.push(t);
    }
    return kept.join(' ');
  });
}

function buildCommandMenu(msg, { botName: BOT_NAME, prefix: PREFIX, aliases = {} }) {
  const reference = commandReferenceForMessage(msg);
  const visibleCommandCount = new Set(reference.flatMap(section => section.items
    .flatMap(item => extractMenuCommands(item.cmd).map(command => command.split(/\s+/)[0])))).size;
  const header =
`╭━━★彡 *${BOT_NAME}* 彡★━━╮
┃  𖤓 Prefix: ${PREFIX}
┃  𖤓 Commands: ${visibleCommandCount}
╰━━━━━━━━━━━━━╯`;

  const body = reference.map(section => {
    // Several items document more than one usage of the same command
    // (".chess @user" / ".chess [easy|medium|hard]" / ...) — once reduced
    // to bare commands those collapse to the same line, so dedupe per
    // section rather than showing ".chess" three times in a row.
    const seen = new Set();
    const cmds = [];
    for (const item of section.items) {
      const variants = extractMenuCommands(item.cmd);

      // Group variants that are TRUE aliases of each other (registered in
      // the dispatcher's `aliases` map — e.g. inv -> inventory) onto one line, so
      // ".inventory" and ".inv" show as a single "┣ ✦ .inventory / .inv"
      // instead of two separate bullets that look like different things to
      // try when they're the exact same command under the hood. Variants
      // that AREN'T aliases of one another (".mute"/".unmute",
      // ".hug"/".kiss"/...) are genuinely different commands and still get
      // their own line each — unchanged from before.
      const bareNameOf = v => v.split(/\s+/)[0].slice(1).toLowerCase();
      const areAliasPair = (a, b) => aliases[bareNameOf(a)] === bareNameOf(b) || aliases[bareNameOf(b)] === bareNameOf(a);

      const groups = [];
      for (const variant of variants) {
        const existingGroup = groups.find(g => g.some(v => areAliasPair(v, variant)));
        if (existingGroup) existingGroup.push(variant);
        else groups.push([variant]);
      }

      for (const group of groups) {
        const cmd = group.join(' / ');
        if (!seen.has(cmd)) {
          seen.add(cmd);
          cmds.push(cmd);
        }
      }
    }
    const lines = cmds.map(cmd => `┣ ✦ ${cmd}`).join('\n');
    return `*${section.emoji} ${section.title} ${section.emoji}*\n${lines}\n┗━━━━━━━━━━━`;
  }).join('\n\n');

  return `${header}\n\n${body}\n\nType *${PREFIX}<command>* to use one.`;
}

module.exports = { buildCommandMenu, commandReferenceForMessage };
