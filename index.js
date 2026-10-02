/**
 * Ani-Chan Bot - Main Entry Point
 * This file now delegates to the Baileys-based implementation in src/index.js
 * 
 * For Termux on Android:
 * - Make sure you have Node.js 20+ installed
 * - Install dependencies: npm install
 * - Copy .env.example to .env and configure it
 * - Start with: node index.js
 * - Or use PM2: pm2 start index.js --name ani-chan-bot
 */

// Import the Baileys-based main module
import('./src/index.js').catch(err => {
  console.error('Failed to start bot:', err);
  process.exit(1);
});
