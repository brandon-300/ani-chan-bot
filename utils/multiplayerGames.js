const GameSession = require('../models/GameSession');
const GameResult = require('../models/GameResult');
const User = require('../models/User');
const engine = require('../commands/games/unoEngine');
const { transaction, BusinessError } = require('./transaction');
const scheduler = require('./scheduler');
const runtime = require('./gameRuntime');
const { isChatBusy, claim, release } = require('../commands/games/activeGame');
const { isOwner, isMod } = require('./helpers');
const logger = require('./logger');

const games = new Map();
// Use whatsapp-web.js's contact identity consistently with User and the other
// game modules. Group message authors may use LID aliases for the same account.
async function identity(msg) {
  const contact = await msg.getContact?.();
  const id = contact?.id?._serialized || msg.author || msg.from;
  return { id, name: (contact?.pushname || id).slice(0, 50) };
}
const cardText = (card) => `${card.color} ${card.value}`;
const localDeadline = (value) =>
  `${new Date(value).toLocaleTimeString('en-GB', { timeZone: 'Africa/Lagos' })} WAT`;
function publicState(record) {
  const state = record.state;
  if (record.type === 'wcg')
    return `🎮 ${state.question.q}\n\nA) ${state.question.opts[0]}\nB) ${state.question.opts[1]}\n\nVote A/B before ${localDeadline(state.expiresAt)}.`;
  if (state.phase === 'lobby')
    return `🎴 UNO lobby: ${state.players.map((p) => p.name).join(', ')}\nJoin: .uno join\nHost: .uno begin (2–10 players)\nCloses: ${localDeadline(state.expiresAt)}`;
  const game = state.game;
  return `🎴 UNO — ${cardText(game.discard.at(-1))}\nActive color: ${game.color || 'choose with .uno color [color]'}\n${game.players.map((p) => `${p.name}: ${game.hands[p.id].length} card(s)`).join('\n')}\nTurn: ${game.players[game.turn].name}\nYour hand: .uno hand (sent privately)`;
}
function cache(record) {
  record.state.gameType = record.type;
  games.set(record.chatId, record.state);
  claim(record.chatId, record.type);
}
async function result(record, text, session) {
  await GameResult.create([{ chatId: record.chatId, players: record.players, text }], { session });
  await GameSession.deleteOne({ _id: record._id }, { session });
}
async function rearm(record, repair = false) {
  cache(record);
  if (record.state.expiresAt)
    await scheduler[repair ? 'scheduleIfMissing' : 'scheduleTask']({
      type: 'multiplayer_deadline',
      key: `multiplayer:${record._id}`,
      runAt: new Date(record.state.expiresAt),
      payload: { id: String(record._id), chatId: record.chatId },
    });
}
async function reconcile() {
  for (const record of await GameSession.find({ type: { $in: ['uno', 'wcg'] } }))
    await rearm(record, true);
  for (const pending of await GameResult.find({}))
    await scheduler.scheduleIfMissing({
      type: 'game_result',
      key: `game_result:${pending._id}`,
      runAt: new Date(),
      payload: { id: String(pending._id) },
    });
}
async function deliverHands(client, record, ids) {
  const hands = record.state.game?.hands;
  if (!hands) return;
  for (const id of ids) {
    if (!hands[id]) continue;
    const text = `🎴 Your UNO hand (${record.chatId})\n${hands[id].map((card, i) => `${i + 1}. ${cardText(card)}`).join('\n')}\nPlay in the group: .uno play [number] [wild color] [uno]\nOr .uno draw / .uno pass. Call .uno uno when you have one card.`;
    await client
      .sendMessage(id, text)
      .catch((err) => logger.error('uno.private_hand.failed', err, { userId: id }));
  }
}
async function expire(id) {
  const record = await transaction(async (session) => {
    const record = await GameSession.findById(id).session(session);
    if (!record?.state.expiresAt || record.state.expiresAt > Date.now()) return null;
    if (record.type === 'wcg') {
      const votes = Object.values(record.state.votes || {});
      const a = votes.filter((v) => v === 'A').length,
        b = votes.filter((v) => v === 'B').length;
      await result(
        record,
        `🎮 Vote ended: ${record.state.question.q}\nA) ${record.state.question.opts[0]} — ${a}\nB) ${record.state.question.opts[1]} — ${b}\n${a === b ? 'Tie!' : `${a > b ? 'A' : 'B'} received more votes.`}`,
        session
      );
      return { finished: true, chatId: record.chatId, type: record.type };
    }
    if (record.state.players.length < 2) {
      await result(record, '🎴 UNO lobby closed: at least two players are required.', session);
      return { finished: true, chatId: record.chatId, type: record.type };
    }
    record.state.game = engine.start(record.state.players);
    record.state.phase = 'playing';
    record.state.expiresAt = null;
    record.markModified('state');
    await record.save({ session });
    return record;
  });
  if (record?.finished) {
    games.delete(record.chatId);
    release(record.chatId, record.type);
    await reconcile();
  } else if (record) cache(record);
  return record;
}
async function create(type, chatId, ownerId, name, question) {
  if (isChatBusy(chatId)) throw new BusinessError('❌ Another game is active in this chat.');
  await GameResult.init();
  return transaction(async (session) => {
    if (await GameSession.exists({ chatId }).session(session))
      throw new BusinessError('❌ Another saved game is active in this chat.');
    const [record] = await GameSession.create(
      [
        {
          chatId,
          type,
          players: [ownerId],
          state: {
            ownerId,
            players: [{ id: ownerId, name }],
            phase: type === 'uno' ? 'lobby' : 'voting',
            expiresAt: Date.now() + (type === 'uno' ? 60000 : 30000),
            question,
            votes: {},
          },
        },
      ],
      { session }
    );
    return record;
  });
}
async function uno(client, msg, args = []) {
  return runtime.lock(msg.from, async () => {
    const { id, name } = await identity(msg);
    if (!msg.from.endsWith('@g.us'))
      return msg.reply('❌ Run UNO commands in the game’s group. Hands are delivered privately.');
    const action = String(args[0] || 'status').toLowerCase();
    try {
      if (action === 'start') {
        const record = await create('uno', msg.from, id, name);
        await rearm(record);
        return msg.reply(publicState(record));
      }
      let record = await GameSession.findOne({ chatId: msg.from, type: 'uno' });
      if (!record)
        return msg.reply(
          '🎴 UNO: .uno start / join / begin / hand / play [number] [color] [uno] / draw / pass / uno / catch @user / leave'
        );
      const expired = await expire(record._id);
      if (expired?.finished) return msg.reply('🎴 That UNO lobby has closed. Use .uno start.');
      if (expired) {
        record = expired;
        await deliverHands(client, record, record.players);
      }
      if (action === 'status') return msg.reply(publicState(record));
      if (action === 'hand') {
        if (!record.state.game?.hands[id])
          return msg.reply('❌ You are not playing this UNO match.');
        await deliverHands(client, record, [id]);
        return msg.reply(
          '🎴 Hand delivery attempted privately. Allow DMs from the bot if it does not arrive.'
        );
      }
      const mentioned = action === 'catch' ? await msg.getMentions() : [];
      let changedHands = [];
      const outcome = await transaction(async (session) => {
        const fresh = await GameSession.findOne({ _id: record._id, type: 'uno' }).session(session);
        if (!fresh) throw new BusinessError('❌ UNO game ended.');
        const state = fresh.state;
        if (state.phase === 'lobby') {
          if (state.expiresAt <= Date.now())
            throw new BusinessError('❌ Lobby deadline passed; try again after it resolves.');
          if (action === 'join') {
            if (state.players.some((p) => p.id === id))
              throw new BusinessError('❌ You already joined.');
            if (state.players.length >= 10) throw new BusinessError('❌ UNO lobby is full.');
            state.players.push({ id, name });
          } else if (action === 'begin') {
            if (state.ownerId !== id) throw new BusinessError('❌ Only the host can begin early.');
            state.game = engine.start(state.players);
            state.phase = 'playing';
            state.expiresAt = null;
            changedHands = state.players.map((p) => p.id);
          } else if (action === 'leave') {
            state.players = state.players.filter((p) => p.id !== id);
            if (!state.players.length) {
              await result(fresh, '🎴 UNO lobby cancelled.', session);
              return null;
            }
            if (state.ownerId === id) state.ownerId = state.players[0].id;
          } else throw new BusinessError('❌ Join the lobby or let the host begin the match.');
        } else {
          const game = state.game;
          if (!game.hands[id]) throw new BusinessError('❌ You are not in this UNO match.');
          const before = JSON.parse(JSON.stringify(game.hands));
          if (action === 'play')
            engine.play(
              game,
              id,
              /^\d+$/.test(args[1] || '') ? Number(args[1]) - 1 : NaN,
              args[2]?.toLowerCase(),
              args.slice(2).some((word) => word.toLowerCase() === 'uno')
            );
          else if (action === 'draw') engine.draw(game, id);
          else if (action === 'pass') engine.pass(game, id);
          else if (action === 'color') engine.chooseColor(game, id, args[1]?.toLowerCase());
          else if (action === 'uno') engine.callUno(game, id);
          else if (action === 'catch') engine.catchUno(game, id, mentioned[0]?.id._serialized);
          else if (action === 'leave') {
            const oldIndex = game.players.findIndex((p) => p.id === id);
            const currentId = game.players[game.turn].id;
            const nextId =
              game.players[(game.turn + game.direction + game.players.length) % game.players.length]
                .id;
            game.deck = engine.shuffled([...game.deck, ...game.hands[id]]);
            delete game.hands[id];
            game.players.splice(oldIndex, 1);
            state.players = game.players;
            game.turn = Math.max(
              0,
              game.players.findIndex((p) => p.id === (currentId === id ? nextId : currentId))
            );
            game.drawn = false;
            game.missedUno = null;
            if (game.players.length === 1) {
              game.winner = game.players[0].id;
              game.phase = 'finished';
            }
          } else throw new BusinessError('❌ Unknown UNO action. Use .uno for status.');
          if (game.winner) {
            const winner = game.players.find((p) => p.id === game.winner);
            await result(fresh, `🏆 ${winner.name} won UNO!`, session);
            return null;
          }
          changedHands = game.players
            .map((p) => p.id)
            .filter(
              (player) => JSON.stringify(before[player]) !== JSON.stringify(game.hands[player])
            );
        }
        fresh.players = state.players.map((p) => p.id);
        fresh.markModified('state');
        await fresh.save({ session });
        return fresh;
      });
      if (!outcome) {
        games.delete(msg.from);
        release(msg.from, 'uno');
        await reconcile();
        return msg.reply('🎴 UNO ended. The result is queued for delivery.');
      }
      await rearm(outcome);
      await deliverHands(client, outcome, changedHands);
      return msg.reply(publicState(outcome));
    } catch (err) {
      if (err instanceof BusinessError || (err.constructor === Error && !err.code))
        return msg.reply(`❌ ${err.message}`);
      throw err;
    }
  });
}
async function wcg(client, msg, args, question, resolvedId) {
  try {
    return await runtime.lock(msg.from, async () => {
      const id = resolvedId || (await identity(msg)).id;
      if (!msg.from.endsWith('@g.us')) return msg.reply('❌ WCG is a group game.');
      const vote = args[0]?.toUpperCase();
      let record = await GameSession.findOne({ chatId: msg.from, type: 'wcg' });
      if (record) {
        const expired = await expire(record._id);
        if (expired?.finished) return msg.reply('🎮 Voting has ended. Results are queued.');
      }
      if (!record && !['A', 'B'].includes(vote)) {
        record = await create('wcg', msg.from, id, '', question);
        await rearm(record);
        return msg.reply(publicState(record));
      }
      if (!record) return msg.reply('❌ No active WCG vote. Use .wcg to start one.');
      if (!['A', 'B'].includes(vote)) return msg.reply(publicState(record));
      await transaction(async (session) => {
        const fresh = await GameSession.findOne({
          _id: record._id,
          'state.expiresAt': { $gt: Date.now() },
        }).session(session);
        if (!fresh) throw new BusinessError('❌ Voting has ended.');
        fresh.state.votes ||= {};
        fresh.state.votes[Buffer.from(id).toString('base64url')] = vote;
        if (!fresh.players.includes(id)) fresh.players.push(id);
        fresh.markModified('state');
        await fresh.save({ session });
      });
      return msg.reply(`🎮 Vote ${vote} recorded. You may change it before the deadline.`);
    });
  } catch (err) {
    if (err instanceof BusinessError) return msg.reply(err.message);
    throw err;
  }
}
async function handleVote(client, msg) {
  if (
    !/^[ab]$/i.test((msg.body || '').trim()) ||
    !games.has(msg.from) ||
    games.get(msg.from).phase !== 'voting'
  )
    return false;
  const { id } = await identity(msg);
  const user = await User.findOne(
    { id },
    'registration email emailVerifiedAt sessionLockedAt lastActiveAt'
  );
  if (!isOwner(id) && !isMod(id) && (!user || user.registration?.status === 'pending')) {
    await msg.reply('❌ Complete registration before joining the vote.');
    return true;
  }
  const session = await require('../commands/account')._checkSession(
    client,
    msg,
    'wcg',
    [msg.body.trim()],
    { senderId: id, wasActive: true, user }
  );
  if (session.blocked) return true;
  try {
    await wcg(client, msg, [msg.body.trim()], undefined, id);
  } catch (err) {
    if (err instanceof BusinessError) await msg.reply(err.message);
    else throw err;
  }
  return true;
}
async function quit(client, msg) {
  const record = await GameSession.findOne({ chatId: msg.from, type: { $in: ['uno', 'wcg'] } });
  if (!record) return false;
  if (record.type === 'uno') {
    await uno(client, msg, ['leave']);
    return true;
  }
  if ((await identity(msg)).id !== record.state.ownerId) {
    await msg.reply('❌ Only the poll starter can end it early.');
    return true;
  }
  await runtime.lock(msg.from, () =>
    transaction(async (session) => {
      const fresh = await GameSession.findById(record._id).session(session);
      if (fresh) {
        await result(fresh, '🎮 WCG cancelled by its starter.', session);
      }
    })
  );
  games.delete(msg.from);
  release(msg.from, 'wcg');
  await reconcile();
  return true;
}
scheduler.registerHandler('multiplayer_deadline', async ({ id, chatId }, client) =>
  runtime.lock(chatId, async () => {
    const record = await expire(id);
    if (record && !record.finished) {
      await deliverHands(client, record, record.players);
      await client.sendMessage(chatId, publicState(record));
    }
  })
);
scheduler.registerHandler('game_result', async ({ id }, client) => {
  const pending = await GameResult.findById(id);
  if (!pending) return;
  await client.sendMessage(pending.chatId, pending.text);
  await GameResult.deleteOne({ _id: pending._id });
});
runtime.register('uno', games, null, reconcile, {}, []);
module.exports = { uno, wcg, quit, handleVote, reconcile };
