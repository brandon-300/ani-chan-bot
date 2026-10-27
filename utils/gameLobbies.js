const GameSession = require('../models/GameSession');
const runtime = require('./gameRuntime');
const { claim, release } = require('../commands/games/activeGame');
async function save(type, chatId, lobby) {
  const { timer, ...state } = lobby;
  await GameSession.findOneAndUpdate(
    { chatId },
    {
      $set: {
        type: `${type}_lobby`,
        players: state.players.map((p) => p.id),
        state,
      },
    },
    { upsert: true }
  );
}
async function remove(type, chatId) {
  await GameSession.deleteOne({ chatId, type: `${type}_lobby` });
}
async function arm(type, chatId, lobby, map, finish) {
  clearTimeout(lobby.timer);
  lobby.timer = runtime.timer(
    type,
    chatId,
    async () => {
      if (map.get(chatId) !== lobby) return;
      await finish();
    },
    lobby.expiresAt - Date.now()
  );
}
async function restore(type, map, finish) {
  for (const row of await GameSession.find({ type: `${type}_lobby` })) {
    if (map.has(row.chatId)) continue;
    if (!Array.isArray(row.state?.players) || !Number.isFinite(row.state.expiresAt)) {
      console.error(`Invalid ${type} lobby skipped:`, row.chatId);
      continue;
    }
    map.set(row.chatId, row.state);
    claim(row.chatId, type);
    await arm(type, row.chatId, row.state, map, () => finish(row.chatId, row.state));
  }
}
async function close(type, chatId, map, send) {
  await remove(type, chatId);
  map.delete(chatId);
  release(chatId, type);
  await send();
}
module.exports = { save, remove, arm, restore, close };
