const logger = require('./logger');
const { release } = require('../commands/games/activeGame');
const queues = new Map();
const runtimes = new Map();
const paused = new Map();

function lock(chatId, fn) {
  const previous = queues.get(chatId) || Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(chatId, tail);
  tail.finally(() => {
    if (queues.get(chatId) === tail) queues.delete(chatId);
  });
  return run;
}
function pause(type, chatId, err, force = false) {
  const runtime = runtimes.get(type);
  if (runtime && (runtime.games.has(chatId) || runtime.lobbies?.has(chatId) || force)) {
    const game = runtime.games.get(chatId);
    clearTimeout(game?.turnTimer);
    clearTimeout(game?.current?.timer);
    clearTimeout(runtime.lobbies?.get(chatId)?.timer);
    runtime.lobbies?.delete(chatId);
    runtime.games.delete(chatId);
    paused.set(chatId, type);
    // Keep the chat reserved until its saved state can be restored.
  }
  logger.error('game.operation.failed', err, { type, chatId });
}
function timer(type, chatId, fn, delay) {
  const handle = setTimeout(
    () => lock(chatId, fn).catch((err) => pause(type, chatId, err)),
    Math.max(0, delay)
  );
  handle.unref?.();
  return handle;
}
function deadline(game, turn) {
  if (game.mode !== 'pvp') return;
  if (game.deadlineTurn !== turn || !Number.isFinite(game.turnExpiresAt)) {
    game.deadlineTurn = turn;
    game.turnExpiresAt = Date.now() + 30000;
  }
}
function register(type, games, lobbies, restore, exported, commandNames, quitNames = []) {
  const runtime = { games, lobbies, restore, client: null };
  runtimes.set(type, runtime);
  for (const name of [...commandNames, ...quitNames]) {
    const original = exported[name];
    if (typeof original !== 'function') continue;
    exported[name] = function (...args) {
      const isQuit = quitNames.includes(name);
      const chatId = isQuit ? args[0] : args[1]?.from;
      if (!isQuit) runtime.client = args[0];
      return lock(chatId, async () => {
        if (paused.get(chatId) === type) {
          await restore(runtime.client);
          paused.delete(chatId);
          if (!games.has(chatId) && !lobbies?.has(chatId)) release(chatId, type);
        }
        if (
          !isQuit &&
          name !== 'tryHandleQuizAnswer' &&
          !games.has(chatId) &&
          !lobbies?.has(chatId)
        ) {
          // A failed startup restore must not let a new command overwrite a
          // saved match before it has been loaded.
          const saved = await require('../models/GameSession').findOne({ chatId }, 'type');
          const savedRuntime = saved && runtimes.get(saved.type.replace(/_lobby$/, ''));
          if (savedRuntime) await savedRuntime.restore(runtime.client);
        }
        const wasActive = games.has(chatId) || lobbies?.has(chatId);
        try {
          return await original(...args);
        } catch (err) {
          pause(type, chatId, err, wasActive);
          throw err;
        }
      });
    };
  }
}
function forgetChat(chatId) {
  for (const runtime of runtimes.values())
    for (const map of [runtime.games, runtime.lobbies].filter(Boolean)) {
      const game = map.get(chatId);
      clearTimeout(game?.turnTimer);
      clearTimeout(game?.timer);
      clearTimeout(game?.current?.timer);
      map.delete(chatId);
    }
  paused.delete(chatId);
  const active = require('../commands/games/activeGame').isChatBusy(chatId);
  if (active) release(chatId, active.type);
}
function forgetUser(userId) {
  for (const [type, runtime] of runtimes) {
    for (const map of [runtime.games, runtime.lobbies].filter(Boolean)) {
      for (const [chatId, game] of map) {
        const ids = [
          game.white,
          game.black,
          game.p1?.id,
          game.p2?.id,
          game.starterId,
          ...(game.players || []).map((p) => (typeof p === 'string' ? p : p.id)),
        ];
        if (!ids.includes(userId)) continue;
        clearTimeout(game.turnTimer);
        clearTimeout(game.timer);
        clearTimeout(game.current?.timer);
        map.delete(chatId);
        paused.delete(chatId);
        release(chatId, game.gameType || type);
      }
    }
  }
}
module.exports = { lock, timer, deadline, register, forgetUser, forgetChat, pause };
