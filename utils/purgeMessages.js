async function purgeMessages(client, chat, command, count) {
  const fetched = await chat.fetchMessages({ limit: count + 1 });
  const candidates = fetched
    .filter(
      (message) =>
        message.id?._serialized !== command.id?._serialized &&
        !message.isStatus &&
        !message.isNotification &&
        message.type !== 'revoked'
    )
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, count);
  const result = { requested: count, sent: 0, skipped: 0, failed: 0 };
  for (const message of candidates) {
    try {
      // delete(true) falls back to a local-only delete when revocation is not
      // allowed. Check the same capability used by whatsapp-web.js first.
      const eligible = await client.pupPage.evaluate((id) => {
        const msg = window.require('WAWebCollections').Msg.get(id);
        if (!msg) return false;
        const capability = window.require('WAWebMsgActionCapability');
        return capability.canSenderRevokeMsg(msg) || capability.canAdminRevokeMsg(msg);
      }, message.id._serialized);
      if (!eligible) {
        result.skipped++;
        continue;
      }
      await message.delete(true);
      result.sent++;
    } catch {
      result.failed++;
    }
  }
  result.skipped += Math.max(0, count - candidates.length);
  return result;
}
module.exports = { purgeMessages };
