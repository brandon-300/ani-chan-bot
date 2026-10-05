// PM2 config for the Baileys version of AniChan.
//
// Start it:   npm run pm2        (from ~/ani-chan-bot-baileys)
//
// The name is different from the whatsapp-web.js bot ("ani-chan-bot") on purpose:
// both versions are the SAME bot on the SAME WhatsApp account, so only one of them
// may run at a time. A different PM2 name lets you stop/start each one separately
// without touching the other. Use ~/switch-bot.sh to change which one is running.
module.exports = {
  apps: [
    {
      name: 'ani-chan-bot-baileys',
      script: 'src/index.js',
      cwd: __dirname,
      autorestart: true,
      // Crash loops back off instead of hammering WhatsApp / MongoDB.
      exp_backoff_restart_delay: 2000,
      max_restarts: 20,
      min_uptime: '30s',
      // Exit code 64 = WhatsApp logged this device out (401). Retrying cannot fix
      // that, so PM2 must NOT restart it; re-pair by hand (see the message the bot prints).
      stop_exit_codes: [64],
      kill_timeout: 8000,
    },
  ],
};
