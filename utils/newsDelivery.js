const crypto = require('node:crypto');
const NewsDelivery = require('../models/NewsDelivery');
const { withGuildLock } = require('./guildLock');
async function deliverOnce(key, send) {
  await NewsDelivery.init();
  const token = crypto.randomUUID();
  const now = Date.now();
  let claimed;
  try {
    claimed = await NewsDelivery.findOneAndUpdate(
      { key, status: { $ne: 'sent' }, leaseUntil: { $lte: new Date(now) } },
      {
        $set: {
          token,
          status: 'running',
          leaseUntil: new Date(now + 5 * 60000),
          expiresAt: new Date(now + 2 * 86400000),
        },
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    if (err.code === 11000) return false;
    throw err;
  }
  if (!claimed) return false;
  try {
    await send();
    await NewsDelivery.updateOne({ key, token }, { $set: { status: 'sent' } });
    return true;
  } catch (err) {
    await NewsDelivery.deleteOne({ key, token });
    throw err;
  }
}
const lockChat = (chatId, fn) => withGuildLock(`news:${chatId}`, fn);
module.exports = { deliverOnce, lockChat };
