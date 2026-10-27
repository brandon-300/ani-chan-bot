const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const uri = process.env.ANICHAN_TEST_MONGO_URI;
// This destructive fixture runner ONLY accepts a local, explicitly named test database.
const safe = uri && /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/anichan_repair_test\?/.test(uri);
if (uri && !safe)
  throw new Error('Integration tests require the local anichan_repair_test database');

test(
  'real MongoDB rollback, concurrency and restart regressions',
  { skip: !safe, timeout: 120000 },
  async (t) => {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    const User = require('../models/User');
    const Guild = require('../models/Guild');
    const {
      OwnedCard,
      CardCatalogue,
      Auction,
      TradeRequest,
      SaleRequest,
    } = require('../models/Card');
    const ScheduledTask = require('../models/ScheduledTask');
    const GameSession = require('../models/GameSession');
    const AssetCleanup = require('../models/AssetCleanup');
    const GameResult = require('../models/GameResult');
    const Season = require('../models/Season');
    const Challenge = require('../models/GuildChallenge');
    const cards = require('../utils/cardTransactions');
    const auctions = require('../utils/auctions');
    const guilds = require('../utils/guildTransactions');
    const deletion = require('../utils/userDeletion');
    const scheduler = require('../utils/scheduler');
    const { cardValue } = require('../utils/helpers');
    const models = [
      User,
      Guild,
      OwnedCard,
      CardCatalogue,
      Auction,
      TradeRequest,
      SaleRequest,
      ScheduledTask,
      GameSession,
      AssetCleanup,
      GameResult,
      Season,
      Challenge,
    ];
    await Promise.all(models.map((m) => m.init()));
    t.after(async () => {
      scheduler._stop();
      await mongoose.disconnect();
    });
    const reset = async () => {
      for (const collection of Object.values(mongoose.connection.collections))
        await collection.deleteMany({});
    };
    const user = (id, values = {}) =>
      User.create({ id, lastInterestAt: Date.now(), lastActiveAt: Date.now(), ...values });
    const card = (ownerId, code, tier = 'C') =>
      OwnedCard.create({ ownerId, catalogueId: code, code, tier, name: code, series: 'Test' });
    const guild = (leaderId, name, other = []) =>
      Guild.create({
        name,
        leaderId,
        members: [
          { userId: leaderId, role: 'leader' },
          ...other.map((userId) => ({ userId, role: 'member' })),
        ],
      });

    await t.test(
      'atomic balance changes reject stale saves and overflow; legacy revisions remain safe',
      async () => {
        await reset();
        const original = await user('a');
        const stale = await User.findById(original._id);
        await User.updateOne({ id: 'a' }, { $inc: { coins: 20 } });
        stale.coins -= 100;
        await assert.rejects(stale.save(), { name: 'VersionError' });
        assert.equal((await User.findById(original._id)).coins, 1020);
        assert.equal(
          (await User.updateOne({ id: 'a' }, { $inc: { coins: Number.MAX_SAFE_INTEGER } }))
            .matchedCount,
          0
        );
        await User.collection.updateOne({ id: 'a' }, { $unset: { __v: '' } });
        const old = await User.findOne({ id: 'a' });
        await User.updateOne({ id: 'a' }, { $inc: { coins: 1 } });
        old.coins = 2;
        await assert.rejects(old.save(), { name: 'VersionError' });
        const updated = await User.findOrCreate('a');
        assert.equal(updated.coins, 1021);
      }
    );
    await t.test('simultaneous interest reads credit once without overwriting money', async () => {
      await reset();
      await user('interest', { bank: 10000, lastInterestAt: Date.now() - 2 * 86400000 });
      const readings = await Promise.all(
        Array.from({ length: 4 }, () => User.findOrCreate('interest'))
      );
      const balance = (await User.findOne({ id: 'interest' })).bank;
      assert.ok(balance > 10000);
      assert.equal(new Set(readings.map((u) => u.bank)).size, 1);
      assert.equal((await User.findOrCreate('interest')).bank, balance);
    });
    await t.test(
      'resell rolls back a deleted card when payment fails and cannot pay twice',
      async () => {
        await reset();
        await user('seller', { bank: Number.MAX_SAFE_INTEGER });
        const owned = await card('seller', 'RES');
        const price = Math.floor(cardValue('C') * 0.5);
        await assert.rejects(cards.resellCard('seller', owned._id, price));
        assert.ok(await OwnedCard.findById(owned._id));
        await User.updateOne({ id: 'seller' }, { $set: { bank: 0 } });
        const results = await Promise.allSettled([
          cards.resellCard('seller', owned._id, price),
          cards.resellCard('seller', owned._id, price),
        ]);
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal((await User.findOne({ id: 'seller' })).bank, price);
      }
    );
    await t.test(
      'fusion consumes all inputs with its reward or rolls everything back',
      async (t) => {
        await reset();
        await user('fuser');
        const inputs = await Promise.all(['F1', 'F2', 'F3'].map((code) => card('fuser', code)));
        await CardCatalogue.create({ cardId: 'REWARD', name: 'Reward', series: 'Test', tier: 'B' });
        const original = OwnedCard.create;
        const mock = t.mock.method(OwnedCard, 'create', async () => {
          throw new Error('injected reward failure');
        });
        await assert.rejects(
          cards.fuseCards(
            'fuser',
            inputs.map((c) => c._id),
            'B',
            'A',
            true,
            false
          ),
          /injected/
        );
        mock.mock.restore();
        assert.equal(await OwnedCard.countDocuments({ ownerId: 'fuser' }), 3);
        await cards.fuseCards(
          'fuser',
          inputs.map((c) => c._id),
          'B',
          'A',
          true,
          false
        );
        assert.equal(await OwnedCard.countDocuments({ ownerId: 'fuser' }), 1);
        assert.ok(await OwnedCard.findOne({ catalogueId: 'REWARD', code: { $type: 'string' } }));
        assert.equal(original, OwnedCard.create);
      }
    );
    await t.test(
      'auction escrow refunds outbid players, locks cards, and settles once',
      async () => {
        await reset();
        await user('seller', { bank: 0 });
        await user('b1', { bank: 1000 });
        await user('b2', { bank: 1000 });
        const owned = await card('seller', 'AUC');
        const auction = await auctions.createAuction('seller', owned._id, 100, '5m', 'g@g.us');
        assert.equal(
          (await OwnedCard.updateOne({ _id: owned._id }, { $set: { isLent: true } })).matchedCount,
          0
        );
        assert.equal((await OwnedCard.deleteOne({ _id: owned._id })).deletedCount, 0);
        await auctions.bid(auction.code, 'b1', 100);
        await auctions.bid(auction.code, 'b1', 120);
        assert.equal((await User.findOne({ id: 'b1' })).bank, 880);
        await auctions.bid(auction.code, 'b2', 121);
        assert.equal((await User.findOne({ id: 'b1' })).bank, 1000);
        await assert.rejects(auctions.cancel(auction.code, 'seller'), /cannot be cancelled/);
        await Auction.updateOne({ _id: auction._id }, { $set: { endsAt: new Date(0) } });
        const resolved = await Promise.all([
          auctions.settle(auction._id),
          auctions.settle(auction._id),
        ]);
        assert.equal(resolved.filter(Boolean).length, 1);
        assert.equal((await User.findOne({ id: 'seller' })).bank, 121);
        assert.equal((await User.findOne({ id: 'b2' })).bank, 879);
        assert.equal((await OwnedCard.findById(owned._id)).ownerId, 'b2');
        assert.equal((await OwnedCard.findById(owned._id)).isAuctioned, false);
      }
    );
    await t.test(
      'competing bids preserve total funds and cancel/no-sale unlock cards',
      async () => {
        await reset();
        await user('seller', { bank: 0 });
        await user('b1', { bank: 1000 });
        await user('b2', { bank: 1000 });
        const owned = await card('seller', 'RACE');
        const a = await auctions.createAuction('seller', owned._id, 100, '5m');
        await Promise.allSettled([
          auctions.bid(a.code, 'b1', 100),
          auctions.bid(a.code, 'b2', 101),
        ]);
        const current = await Auction.findById(a._id);
        const balances = await User.find({});
        assert.equal(balances.reduce((sum, u) => sum + u.bank, 0) + current.currentBid, 2000);
        const next = await card('seller', 'CANCEL');
        const empty = await auctions.createAuction('seller', next._id, 10, '5m');
        await auctions.cancel(empty.code, 'seller');
        assert.equal((await OwnedCard.findById(next._id)).isAuctioned, false);
      }
    );
    await t.test(
      'guild treasury rollback, leadership transfer and challenge/season payouts are atomic',
      async (t) => {
        await reset();
        const a = await user('leader');
        const b = await user('member');
        const g = await guild('leader', 'One', ['member']);
        await User.updateMany(
          { id: { $in: ['leader', 'member'] } },
          { $set: { guildId: String(g._id) } }
        );
        const mock = t.mock.method(Guild.prototype, 'save', async () => {
          throw new Error('injected guild failure');
        });
        await assert.rejects(guilds.treasury('leader', String(g._id), 100), /injected/);
        mock.mock.restore();
        assert.equal((await User.findById(a._id)).coins, 1000);
        assert.equal((await Guild.findById(g._id)).bank, 0);
        await guilds.treasury('leader', String(g._id), 100);
        assert.equal((await User.findById(a._id)).coins, 900);
        const transferred = await guilds.transferLeadership('leader', 'member');
        assert.equal(transferred.leaderId, 'member');
        assert.equal(transferred.members.find((m) => m.userId === 'leader').role, 'officer');
        const other = await guild('else', 'Two');
        await Guild.updateOne({ _id: g._id }, { $set: { reputation: 100, seasonReputation: 100 } });
        const challenge = await Challenge.create({
          challengerGuildId: String(g._id),
          challengedGuildId: String(other._id),
          status: 'active',
          endsAt: Date.now() - 1,
        });
        const rewards = await Promise.all([
          guilds.resolveChallenge(challenge._id, 10),
          guilds.resolveChallenge(challenge._id, 10),
        ]);
        assert.equal(rewards.filter(Boolean).length, 1);
        await Season.create({ seasonNumber: 1, startedAt: 1, endsAt: 2 });
        const seasons = await Promise.all([
          guilds.resolveSeason({ rewardReputation: 10, rewardCoins: 50, duration: 100000 }),
          guilds.resolveSeason({ rewardReputation: 10, rewardCoins: 50, duration: 100000 }),
        ]);
        assert.equal(seasons.filter(Boolean).length, 1);
        assert.equal((await Guild.findById(g._id)).bank, 150);
        assert.equal(await Season.countDocuments({ status: 'active' }), 1);
      }
    );
    await t.test(
      'permanent deletion releases cards, deletes linked rows, queues assets and protects obligations/activity',
      async () => {
        await reset();
        await user('delete', {
          lastActiveAt: 1,
          profile: { picUrl: 'https://example.test/old.jpg', picPublicId: 'test/old' },
        });
        await card('delete', 'DEL');
        await require('../models/GroupActivity').create({ groupId: 'g', userId: 'delete' });
        await GameSession.create({ chatId: 'g', type: 'test', players: ['delete'] });
        await deletion.deleteUser('delete', { cutoff: 100 });
        assert.equal(await User.countDocuments({ id: 'delete' }), 0);
        assert.equal(await OwnedCard.countDocuments({ ownerId: 'delete' }), 0);
        assert.equal(
          await require('../models/GroupActivity').countDocuments({ userId: 'delete' }),
          0
        );
        assert.equal(await GameSession.countDocuments({ players: 'delete' }), 0);
        assert.equal(await AssetCleanup.countDocuments({ publicId: 'test/old' }), 1);
        assert.equal(await ScheduledTask.countDocuments({ type: 'asset_cleanup' }), 1);
        await user('active');
        assert.equal(await deletion.deleteUser('active', { cutoff: 100 }), null);
        await user('debtor', { loan: { active: true } });
        await assert.rejects(deletion.deleteUser('debtor'), /Active bank loan/);
        await user('chief');
        await guild('chief', 'Protected');
        await assert.rejects(deletion.deleteUser('chief'), /Guild leader/);
        process.env.OWNER_NUMBER = 'owner';
        await assert.rejects(deletion.deleteUser('owner'), /owner cannot be deleted/);
        delete process.env.OWNER_NUMBER;
      }
    );
    await t.test('Lucky Charm and VIP consume exactly one item and cannot stack', async () => {
      await reset();
      await user('lucky', { inventory: ['Lucky Charm', 'Lucky Charm', 'VIP Badge', 'VIP Badge'] });
      const Group = require('../models/Group');
      await Group.create({ id: 'lucky@g.us', cardsEnabled: true });
      const effects = require('../utils/itemEffects');
      await effects.useSpecialItem('lucky', 'Lucky Charm', 'lucky@g.us');
      const task = await ScheduledTask.findOne({ key: 'card_drop:lucky@g.us' });
      assert.ok(task.runAt - Date.now() <= 150000);
      await assert.rejects(
        effects.useSpecialItem('lucky', 'Lucky Charm', 'lucky@g.us'),
        /already has/
      );
      await effects.useSpecialItem('lucky', 'VIP Badge');
      await assert.rejects(effects.useSpecialItem('lucky', 'VIP Badge'), /already active/);
      const final = await User.findOne({ id: 'lucky' });
      assert.equal(final.inventory.length, 2);
      assert.equal(final.profile.badge, '👑 VIP');
    });
    await t.test(
      'scheduler fences self-rescheduled work and recovers expired running attempts',
      async () => {
        await reset();
        let runs = 0;
        scheduler.registerHandler('test', async () => {
          runs++;
          await scheduler.scheduleTask({
            type: 'test',
            key: 'again',
            runAt: new Date(Date.now() + 60000),
          });
        });
        await scheduler.scheduleTask({ type: 'test', key: 'again', runAt: new Date(0) });
        await scheduler._runDueTask('again');
        assert.equal(runs, 1);
        assert.equal((await ScheduledTask.findOne({ key: 'again' })).status, 'pending');
        await ScheduledTask.create({
          type: 'test',
          key: 'expired',
          runAt: new Date(0),
          status: 'running',
          lockedUntil: new Date(0),
          runToken: 'dead',
          attempts: 1,
        });
        await scheduler._recoverRunning();
        assert.equal((await ScheduledTask.findOne({ key: 'expired' })).status, 'pending');
      }
    );
    await t.test(
      'WCG persists one changeable vote per user and UNO hands survive service restoration',
      async () => {
        await reset();
        const multi = require('../utils/multiplayerGames');
        const messages = [];
        const client = {
          sendMessage: async (to, text) => {
            messages.push({ to, text });
            return {};
          },
        };
        const msg = (id) => ({
          from: 'multi@g.us',
          author: id,
          reply: async (text) => messages.push({ to: 'reply', text }),
          getContact: async () => ({ pushname: id }),
          getMentions: async () => [],
        });
        await multi.wcg(client, msg('host'), [], { q: 'Choose?', opts: ['Left', 'Right'] });
        await multi.wcg(client, msg('voter'), ['A']);
        await multi.wcg(client, msg('voter'), ['B']);
        const poll = await GameSession.findOne({ type: 'wcg' });
        assert.deepEqual(Object.values(poll.state.votes), ['B']);
        await multi.quit(client, msg('host'));
        await multi.uno(client, msg('host@c.us'), ['start']);
        await multi.uno(client, msg('joiner@c.us'), ['join']);
        await multi.uno(client, msg('host@c.us'), ['begin']);
        const match = await GameSession.findOne({ type: 'uno' });
        assert.equal(match.state.game.hands['host@c.us'].length, 7);
        assert.equal(match.state.game.hands['joiner@c.us'].length, 7);
        assert.ok(messages.some((m) => m.to === 'host@c.us' && m.text.includes('Your UNO hand')));
        assert.ok(!messages.some((m) => m.to === 'reply' && m.text.includes('1. red')));
        const saved = JSON.stringify(match.state.game.hands);
        await multi.reconcile();
        assert.equal(
          JSON.stringify((await GameSession.findById(match._id)).state.game.hands),
          saved
        );
        await multi.quit(client, msg('host@c.us'));
      }
    );
    await t.test('guild invite races cannot create membership in two guilds', async () => {
      await reset();
      await user('joiner');
      const a = await guild('a', 'Invite A');
      const b = await guild('b', 'Invite B');
      await Guild.updateMany(
        { _id: { $in: [a._id, b._id] } },
        { $set: { pendingInvites: ['joiner'] } }
      );
      const command = require('../commands/guilds');
      const msg = {
        getContact: async () => ({ id: { _serialized: 'joiner' } }),
        reply: async () => {},
      };
      // Both start with the same account and invite; a replay cannot add twice.
      await Promise.allSettled([
        command.guild_accept({}, msg, []),
        command.guild_accept({}, msg, []),
      ]);
      const joined = await User.findOne({ id: 'joiner' });
      assert.ok(joined.guildId);
      assert.equal(await Guild.countDocuments({ 'members.userId': 'joiner' }), 1);
      assert.equal(
        (await Guild.findById(joined.guildId)).members.filter((m) => m.userId === 'joiner').length,
        1
      );
    });
    await t.test(
      'guild creation rollback does not orphan a guild or charge its creator',
      async (t) => {
        await reset();
        await user('creator', { coins: 2000 });
        const command = require('../commands/guilds');
        const mock = t.mock.method(User.prototype, 'save', async () => {
          throw Error('injected creator save failure');
        });
        await assert.rejects(
          command.guild_create(
            {},
            { getContact: async () => ({ id: { _serialized: 'creator' } }), reply: async () => {} },
            ['Rollback Guild']
          ),
          /injected/
        );
        mock.mock.restore();
        assert.equal(await Guild.countDocuments({ name: 'Rollback Guild' }), 0);
        assert.equal((await User.findOne({ id: 'creator' })).coins, 2000);
      }
    );
    await t.test(
      'guild maintenance refreshes a stale read instead of overwriting a treasury update',
      async () => {
        await reset();
        const g = await guild('a', 'Maintenance');
        const stale = await Guild.findById(g._id);
        await Guild.updateOne({ _id: g._id }, { $inc: { bank: 250 } });
        await Guild.ensureGuildState(stale);
        assert.equal((await Guild.findById(g._id)).bank, 250);
        assert.equal(stale.bank, 250);
      }
    );
    await t.test(
      'failed failure-recording leaves a recoverable lease rather than a lost task',
      async (t) => {
        await reset();
        scheduler.registerHandler('broken', async () => {
          throw Error('injected handler failure');
        });
        await scheduler.scheduleTask({ type: 'broken', key: 'broken', runAt: new Date(0) });
        const mock = t.mock.method(ScheduledTask, 'updateOne', async () => {
          throw Error('injected record outage');
        });
        await scheduler._runDueTask('broken');
        mock.mock.restore();
        assert.equal((await ScheduledTask.findOne({ key: 'broken' })).status, 'running');
        await ScheduledTask.updateOne({ key: 'broken' }, { $set: { lockedUntil: new Date(0) } });
        await scheduler._recoverRunning();
        assert.equal((await ScheduledTask.findOne({ key: 'broken' })).status, 'pending');
      }
    );
    await t.test(
      'hourly delivery claims serialize concurrent senders and release failed claims',
      async () => {
        await reset();
        const { deliverOnce } = require('../utils/newsDelivery');
        await require('../models/NewsDelivery').init();
        let sends = 0;
        await Promise.all([
          deliverOnce('same-hour', async () => {
            sends++;
          }),
          deliverOnce('same-hour', async () => {
            sends++;
          }),
        ]);
        assert.equal(sends, 1);
        await assert.rejects(
          deliverOnce('retry', async () => {
            throw Error('injected send failure');
          }),
          /injected/
        );
        assert.equal(
          await deliverOnce('retry', async () => {
            sends++;
          }),
          true
        );
        assert.equal(sends, 2);
      }
    );
    await t.test(
      'profile replacement queues old and failed uploads without losing the existing picture',
      async (t) => {
        await reset();
        let account = await user('photo', {
          profile: { picUrl: 'https://example.test/old', picPublicId: 'old' },
        });
        const cloud = require('../utils/cloudinary');
        let fail = false;
        t.mock.method(cloud, 'uploadToCloud', async (file, { publicId, folder }) => {
          if (fail) throw Error('injected upload error');
          return { url: 'https://example.test/new', publicId: `${folder}/${publicId}` };
        });
        const images = require('../utils/profileImages');
        account = await images.replace(account, 'unused-fixture-path');
        assert.equal(account.profile.picUrl, 'https://example.test/new');
        assert.equal(await AssetCleanup.countDocuments({ publicId: 'old' }), 1);
        fail = true;
        await assert.rejects(images.replace(account, 'unused-fixture-path'), /injected/);
        assert.equal(
          (await User.findOne({ id: 'photo' })).profile.picPublicId,
          account.profile.picPublicId
        );
        assert.equal(await AssetCleanup.countDocuments({}), 2);
        await images.remove('photo');
        assert.equal((await User.findOne({ id: 'photo' })).profile.picUrl, '');
        assert.equal(await AssetCleanup.countDocuments({}), 3);
      }
    );
    await t.test(
      'saved game restoration isolates a malformed record and preserves an existing deadline',
      async () => {
        await reset();
        const game = require('../commands/games/tictactoe');
        const runtime = require('../utils/gameRuntime');
        const deadline = Date.now() + 15000;
        await GameSession.create([
          { chatId: 'bad@g.us', type: 'ttt', players: ['bad'], state: { board: 'invalid' } },
          {
            chatId: 'valid@g.us',
            type: 'ttt',
            players: ['p1', 'p2'],
            state: {
              board: [
                ['·', '·', '·'],
                ['·', '·', '·'],
                ['·', '·', '·'],
              ],
              players: ['p1', 'p2'],
              names: ['P1', 'P2'],
              symbols: ['❌', '⭕'],
              mode: 'pvp',
              turn: 0,
              deadlineTurn: 0,
              turnExpiresAt: deadline,
            },
          },
        ]);
        await game._initTTT({ sendMessage: async () => ({}) });
        assert.equal(game.tttGames.has('bad@g.us'), false);
        assert.equal(game.tttGames.get('valid@g.us').turnExpiresAt, deadline);
        runtime.forgetUser('p1');
      }
    );

    await t.test('payout completion failures roll back rewards and the next season', async (t) => {
      await reset();
      const a = await guild('a', 'Payout A');
      const b = await guild('b', 'Payout B');
      await Guild.updateOne({ _id: a._id }, { $set: { reputation: 100, seasonReputation: 100 } });
      const race = await Challenge.create({
        challengerGuildId: String(a._id),
        challengedGuildId: String(b._id),
        status: 'active',
        endsAt: 1,
      });
      let mock = t.mock.method(Challenge.prototype, 'save', async () => {
        throw Error('injected completion failure');
      });
      await assert.rejects(guilds.resolveChallenge(race._id, 10), /injected/);
      mock.mock.restore();
      assert.equal((await Guild.findById(a._id)).reputation, 100);
      assert.equal((await Challenge.findById(race._id)).status, 'active');
      await guilds.resolveChallenge(race._id, 10);
      await Season.create({ seasonNumber: 1, startedAt: 1, endsAt: 2 });
      mock = t.mock.method(Season.prototype, 'save', async () => {
        throw Error('injected season completion failure');
      });
      await assert.rejects(
        guilds.resolveSeason({ rewardReputation: 10, rewardCoins: 50, duration: 100000 }),
        /injected/
      );
      mock.mock.restore();
      assert.equal((await Guild.findById(a._id)).bank, 0);
      assert.equal((await Guild.findById(a._id)).seasonWins, 0);
      assert.equal(await Season.countDocuments({}), 1);
      assert.equal((await Season.findOne({ seasonNumber: 1 })).status, 'active');
    });
    await t.test('concurrent challenge proposals reserve each guild only once', async () => {
      await reset();
      const ids = ['x', 'y', 'z'];
      const results = await Promise.allSettled([
        Challenge.create({ challengerGuildId: ids[0], challengedGuildId: ids[1] }),
        Challenge.create({ challengerGuildId: ids[0], challengedGuildId: ids[2] }),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(await Challenge.countDocuments({ status: 'pending' }), 1);
    });
    await t.test(
      'a stale lending task cannot return a card lent again for a later expiry',
      async () => {
        await reset();
        require('../commands/cards');
        const owned = await card('lender', 'LENT');
        await OwnedCard.updateOne(
          { _id: owned._id },
          {
            $set: {
              isLent: true,
              lentTo: 'group@g.us',
              lendExpiresAt: new Date(Date.now() + 60000),
            },
          }
        );
        await scheduler.scheduleTask({
          type: 'card_lend_return',
          key: `lend:${owned._id}`,
          runAt: new Date(0),
          payload: { cardId: String(owned._id) },
        });
        await scheduler._runDueTask(`lend:${owned._id}`);
        assert.equal((await OwnedCard.findById(owned._id)).isLent, true);
        await require('../commands/cards')._initCardLending();
        assert.ok((await ScheduledTask.findOne({ key: `lend:${owned._id}` })).runAt > Date.now());
      }
    );
    await t.test(
      'persisted next-drop timing repairs a missing schedule without sending twice',
      async () => {
        await reset();
        require('../commands/cards');
        const Group = require('../models/Group');
        const due = new Date(Date.now() + 60000);
        await Group.create({ id: 'next@g.us', cardsEnabled: true, nextDropAt: due });
        await scheduler.scheduleTask({
          type: 'card_drop',
          key: 'card_drop:next@g.us',
          runAt: new Date(0),
          payload: { chatId: 'next@g.us' },
        });
        await scheduler._runDueTask('card_drop:next@g.us');
        const task = await ScheduledTask.findOne({ key: 'card_drop:next@g.us' });
        assert.equal(task.status, 'pending');
        assert.equal(task.runAt.getTime(), due.getTime());
      }
    );
    await t.test(
      'Health Potion commits its inventory consumption and saved battle HP together',
      async () => {
        await reset();
        await user('healer', { inventory: ['Health Potion'] });
        await GameSession.create({
          chatId: 'heal@g.us',
          type: 'battle',
          players: ['healer'],
          state: {
            p1: { id: 'healer', hp: 50 },
            p2: { id: 'BOT', hp: 100 },
            mode: 'bot',
            turn: 'p1',
          },
        });
        const healed = await require('../utils/itemEffects').healBattle('healer', 'heal@g.us');
        assert.equal(healed.hp, 80);
        assert.equal((await User.findOne({ id: 'healer' })).inventory.length, 0);
        assert.equal((await GameSession.findOne({ chatId: 'heal@g.us' })).state.p1.hp, 80);
        require('../utils/gameRuntime').forgetUser('healer');
      }
    );
    await t.test(
      'automatic cleanup retains day 119 and unknown activity and deletes day 121',
      async (t) => {
        await reset();
        const now = Date.parse('2026-10-27T03:00:00.000Z');
        await user('recent', { lastActiveAt: now - 119 * 86400000 });
        await user('stale', { lastActiveAt: now - 121 * 86400000 });
        await user('unknown', { lastActiveAt: null });
        t.mock.timers.enable({ apis: ['Date'], now });
        try {
          await require('../commands/admin')._sweepInactiveUsers({ sendMessage: async () => {} });
        } finally {
          t.mock.timers.reset();
        }
        assert.ok(await User.exists({ id: 'recent' }));
        assert.ok(await User.exists({ id: 'unknown' }));
        assert.equal(await User.exists({ id: 'stale' }), null);
      }
    );

    await t.test(
      'legacy payouts close once without another award and start a fresh season',
      async () => {
        await reset();
        const a = await guild('a', 'Old A');
        const b = await guild('b', 'Old B');
        await Guild.updateOne(
          { _id: a._id },
          { $set: { bank: 321, reputation: 200, seasonReputation: 70, seasonWins: 2 } }
        );
        const race = await Challenge.create({
          challengerGuildId: String(a._id),
          challengedGuildId: String(b._id),
          status: 'resolving',
          endsAt: 1,
          winnerGuildId: String(a._id),
        });
        const old = await Season.create({
          seasonNumber: 1,
          startedAt: 1,
          endsAt: 2,
          status: 'resolving',
          winnerGuildId: String(a._id),
          payoutComplete: true,
        });
        const results = await Promise.all([
          guilds.closeLegacyPayouts({ duration: 100000 }),
          guilds.closeLegacyPayouts({ duration: 100000 }),
        ]);
        assert.equal(
          results.reduce((n, result) => n + result.challenges, 0),
          1
        );
        assert.equal(
          results.reduce((n, result) => n + result.seasons, 0),
          1
        );
        const current = await Guild.findById(a._id);
        assert.equal(current.bank, 321);
        assert.equal(current.reputation, 200);
        assert.equal(current.seasonWins, 2);
        assert.equal(current.seasonReputation, 0);
        for (const record of [await Challenge.findById(race._id), await Season.findById(old._id)]) {
          assert.equal(record.status, 'completed');
          assert.equal(record.closedWithoutPayment, true);
          assert.ok(record.closedAt instanceof Date);
          assert.equal(record.winnerGuildId, String(a._id));
        }
        assert.equal((await Season.findById(old._id)).payoutComplete, true);
        assert.equal(await Season.countDocuments({ seasonNumber: 2, status: 'active' }), 1);
        assert.equal(await guilds.resolveChallenge(race._id, 100), null);
        assert.equal(
          await guilds.resolveSeason({ rewardReputation: 10, rewardCoins: 50, duration: 100000 }),
          null
        );
      }
    );
    await t.test('legacy closure preserves a newer active season and its standings', async () => {
      await reset();
      const a = await guild('a', 'Newer standings');
      await Guild.updateOne(
        { _id: a._id },
        { $set: { bank: 450, reputation: 150, seasonReputation: 90 } }
      );
      await Season.create({
        seasonNumber: 1,
        startedAt: 1,
        endsAt: 2,
        status: 'resolving',
        payoutComplete: false,
      });
      const active = await Season.create({
        seasonNumber: 2,
        startedAt: Date.now(),
        endsAt: Date.now() + 100000,
        status: 'active',
      });
      await guilds.closeLegacyPayouts({ duration: 100000 });
      const current = await Guild.findById(a._id);
      assert.equal(current.bank, 450);
      assert.equal(current.reputation, 150);
      assert.equal(current.seasonReputation, 90);
      assert.equal(await Season.countDocuments({}), 2);
      assert.equal((await Season.findById(active._id)).endsAt, active.endsAt);
      const old = await Season.findOne({ seasonNumber: 1 });
      assert.equal(old.status, 'completed');
      assert.equal(old.payoutComplete, false);
      assert.equal(old.closedWithoutPayment, true);
    });
    await t.test('legacy closure rolls back if the next season cannot be created', async (t) => {
      await reset();
      const a = await guild('a', 'Rollback legacy');
      await Guild.updateOne({ _id: a._id }, { $set: { bank: 250, seasonReputation: 60 } });
      const race = await Challenge.create({
        challengerGuildId: String(a._id),
        challengedGuildId: 'other',
        status: 'resolving',
      });
      await Season.create({ seasonNumber: 1, startedAt: 1, endsAt: 2, status: 'resolving' });
      const mock = t.mock.method(Season, 'findOneAndUpdate', async () => {
        throw Error('injected successor failure');
      });
      await assert.rejects(guilds.closeLegacyPayouts({ duration: 100000 }), /injected successor/);
      mock.mock.restore();
      assert.equal((await Challenge.findById(race._id)).status, 'resolving');
      assert.equal((await Season.findOne({ seasonNumber: 1 })).status, 'resolving');
      assert.equal((await Guild.findById(a._id)).bank, 250);
      assert.equal((await Guild.findById(a._id)).seasonReputation, 60);
      await guilds.closeLegacyPayouts({ duration: 100000 });
      assert.equal(await Season.countDocuments({ status: 'active' }), 1);
    });
    await t.test('direct resolution of an interrupted challenge cannot award twice', async () => {
      await reset();
      const a = await guild('a', 'Direct legacy');
      const race = await Challenge.create({
        challengerGuildId: String(a._id),
        challengedGuildId: 'other',
        status: 'resolving',
      });
      await Promise.all([
        guilds.resolveChallenge(race._id, 100),
        guilds.resolveChallenge(race._id, 100),
      ]);
      assert.equal((await Challenge.findById(race._id)).status, 'completed');
      assert.equal((await Guild.findById(a._id)).reputation, 0);
    });
    await t.test(
      'a saved unsent quiz question is republished with its original deadline',
      async (t) => {
        await reset();
        const { MessageMedia } = require('whatsapp-web.js');
        t.mock.method(MessageMedia, 'fromUrl', async () => {
          throw Error('fixture image unavailable');
        });
        const start = Date.now() - 2000,
          answers = ['One', 'Two', 'Three', 'Four'].map((name) => ({
            name,
            series: 'Test',
            imageUrl: 'https://example.test/image',
          }));
        await GameSession.create({
          chatId: 'quiz-recover@g.us',
          type: 'quiz',
          players: ['qp'],
          state: {
            chatId: 'quiz-recover@g.us',
            starterId: 'qp',
            players: [{ id: 'qp', name: 'Q' }],
            difficulty: 'normal',
            timeSeconds: 30,
            fullPool: answers,
            questions: [answers[0]],
            questionIndex: 0,
            scores: [['qp', { name: 'Q', points: 0, wrong: 0 }]],
            eliminated: [],
            current: {
              correct: answers[0],
              options: answers,
              correctPos: 0,
              answered: [],
              resolved: false,
              startedAt: start,
              messageId: null,
            },
          },
        });
        const sent = [];
        await require('../commands/games/quiz')._initQuiz({
          sendMessage: async (to, text) => {
            sent.push({ to, text });
            return { id: { _serialized: 'quiz-message' } };
          },
        });
        const saved = await GameSession.findOne({ chatId: 'quiz-recover@g.us' });
        assert.equal(saved.state.current.startedAt, start);
        assert.equal(saved.state.current.messageId, 'quiz-message');
        assert.equal(sent.length, 1);
        require('../utils/gameRuntime').forgetUser('qp');
      }
    );
    await t.test('raw WCG votes respect the shared account-session gate', async (t) => {
      await reset();
      const multi = require('../utils/multiplayerGames');
      await user('blocked', { sessionLockedAt: new Date() });
      const client = { sendMessage: async () => ({}) };
      const msg = { from: 'locked-vote@g.us', author: 'host', body: '', reply: async () => {} };
      await multi.wcg(client, msg, [], { q: 'Choose?', opts: ['A', 'B'] });
      const gate = t.mock.method(require('../commands/account'), '_checkSession', async () => ({
        blocked: true,
      }));
      assert.equal(
        await multi.handleVote(client, {
          ...msg,
          author: 'privacy-alias@lid',
          body: 'A',
          getContact: async () => ({ id: { _serialized: 'blocked' } }),
        }),
        true
      );
      assert.equal(gate.mock.callCount(), 1);
      assert.equal(gate.mock.calls[0].arguments[4].senderId, 'blocked');
      assert.deepEqual((await GameSession.findOne({ chatId: msg.from })).state.votes, {});
      await multi.quit(client, msg);
    });
  }
);
