const mongoose = require('mongoose');

// Persists in-progress game state (Tic Tac Toe first; Connect 4, Chess,
// Battle, and Quiz to follow the same pattern one at a time) so a PM2
// restart doesn't wipe out a game partway through. One flexible collection
// for every game type — same approach already used for ScheduledTask
// (utils/scheduler.js) and AiConversation (commands/ai.js): `state` is
// Mixed because each game's shape is completely different (a board,
// scores, HP, whatever that module's own in-memory game object looks
// like) — no reason to give each game type its own rigid schema for
// what's really just "serialize this module's game object".
//
// chatId is unique: today, activeGame.js still only allows ONE game total
// per chat (any type, any player), so there's at most one session document
// per chat. `type` and `players` are broken out as real fields rather than
// left buried inside `state`, on purpose: when multi-session-per-chat
// support gets built later (several concurrent games of the same type in
// one group), the query shape it'll actually need — "sessions in this
// chat, of this type, where this player is a participant" — already
// exists here. Only the chatId-unique constraint itself will need to
// change to a real per-session id at that point; the document shape
// itself doesn't need to be redesigned from scratch.
const GameSessionSchema = new mongoose.Schema({
  chatId: { type: String, required: true, unique: true },
  type: { type: String, required: true }, // 'ttt' today; 'c4' | 'chess' | 'battle' | 'quiz' as each migrates
  players: { type: [String], default: [] }, // real WhatsApp ids only — never the literal 'BOT' placeholder some game modes use
  state: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

module.exports = mongoose.model('GameSession', GameSessionSchema);
