// ─── Central Bot Identity Config ───────────────────────────────────────────
// Single source of truth for the bot's display name. Any file that needs to
// show the bot's name anywhere — startup banner, .help/.stats/.ping text,
// sticker pack names, the AI persona's system prompt, shop titles, etc. —
// should import BOT_NAME from here instead of typing "AniChan" / "Ani-Chan
// Bot" directly. To rename the bot everywhere at once, change BOT_NAME in
// .env — nothing in this file, or in any file that imports from it, needs
// to change.
//
// Falls back to 'Ani-Chan Bot' only if BOT_NAME is missing from .env.
const BOT_NAME = process.env.BOT_NAME || 'Ani-Chan Bot';

module.exports = {
  BOT_NAME,
};
