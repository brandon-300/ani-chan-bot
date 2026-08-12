// Cross-game "one game per chat" lock.
//
// Each game module (chess.js, tictactoe.js, connect4.js, battle.js) still
// owns its own session Map (chessGames, tttGames, c4Games, battleGames) for
// its own turn-by-turn state — nothing about that changes. This module adds
// ONE extra thing on top: a single shared record of which game type (if
// any) currently occupies each chat, so every game's "start a new game"
// command can check across ALL game types, not just its own.
//
// BUGFIX (Aug 2026): before this existed, each game only checked its own
// Map (e.g. `.ttt` only checked tttGames.has(chatId)) — so starting a
// second, different game type in a chat that already had one active (e.g.
// .ttt while a .chess game was in progress) silently succeeded and ran
// both games at once, each thinking it owned the chat.
//
// Usage in each game module:
//   - On successfully starting a game: claim(chatId, 'ttt')
//   - Anywhere the game's own Map entry is deleted (win/draw/forfeit):
//     release(chatId, 'ttt')
//   - Before starting a new game: check isChatBusy(chatId) FIRST, before
//     that game's own Map.has(chatId) check — this catches every other
//     game type; the existing per-Map check still catches same-type
//     conflicts as a redundant safety net.

const activeGames = new Map(); // chatId -> { type, label }

const LABELS = {
  chess: 'Chess',
  ttt: 'Tic Tac Toe',
  c4: 'Connect 4',
  battle: 'Battle',
};

// Returns { type, label } if `chatId` currently has any game active
// (regardless of type), or null if the chat is free to start a new one.
function isChatBusy(chatId) {
  return activeGames.get(chatId) || null;
}

function claim(chatId, type) {
  activeGames.set(chatId, { type, label: LABELS[type] || type });
}

// Only releases the lock if it's still held by `type` — protects against a
// stray release() call clearing a *different* game's lock, which could
// otherwise happen if a bug caused two release() calls for the same chatId.
function release(chatId, type) {
  const current = activeGames.get(chatId);
  if (current && current.type === type) activeGames.delete(chatId);
}

module.exports = { isChatBusy, claim, release, LABELS };
