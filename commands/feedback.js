const { isOwner, safeGetChat, resolveSenderName } = require('../utils/helpers');

module.exports = {
  // .feedback [message] — forwards the message privately to the bot owner.
  // Works the same whether sent in a group or a DM. The owner themself
  // can't use it (there's no one to forward it to).
  async feedback(client, msg, args) {
    const senderId = msg.author || msg.from;

    if (isOwner(senderId)) {
      return msg.reply("❌ You're the bot owner — there's no one to forward feedback to. This command is for other users to reach you.");
    }

    const feedbackText = args.join(' ').trim();
    if (!feedbackText) {
      return msg.reply('❌ Usage: .feedback [your message]\nExample: .feedback The .daily cooldown seems off.');
    }

    const ownerId = process.env.OWNER_NUMBER;
    if (!ownerId) {
      console.error('❌ Feedback: OWNER_NUMBER is not set in .env — cannot forward feedback.');
      return msg.reply("⚠️ Feedback couldn't be sent right now — please try again later.");
    }

    // Resolve context for both the owner's copy and the log lines. See
    // resolveSenderName in utils/helpers.js for why this isn't a plain
    // getContact() call — it works around a whatsapp-web.js bug with @lid
    // (WhatsApp's newer privacy id) senders resolving as the bot itself.
    const senderName = await resolveSenderName(msg, client);

    let chatLabel = 'Direct Message';
    if (msg.from.endsWith('@g.us')) {
      const chat = await safeGetChat(msg, 1).catch(() => null);
      chatLabel = chat?.name || msg.from;
    }

    const timestamp = new Date().toLocaleString();

    console.log(`📝 Feedback received from ${senderName} (${senderId}) via ${chatLabel} at ${timestamp}`);
    console.log(`📝 Feedback content: ${feedbackText}`);

    const forwardText =
`📩 *New Feedback*

👤 From: ${senderName} (${senderId.split('@')[0]})
💬 Via: ${chatLabel}
🕒 At: ${timestamp}

"${feedbackText}"`;

    try {
      await client.sendMessage(ownerId, forwardText);
      console.log(`✅ Feedback forwarded to owner successfully (from ${senderName} at ${timestamp})`);
    } catch (err) {
      console.error(`❌ Failed to forward feedback to owner: ${err.message}`);
      return msg.reply("⚠️ Something went wrong sending your feedback — please try again in a moment.");
    }

    await msg.reply('✅ Your feedback was received and submitted to my creator');
  },
};
