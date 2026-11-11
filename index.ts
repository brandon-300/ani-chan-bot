/**
 * Ani-Chan Bot - Main Entry Point (TypeScript)
 * Delegates to the Baileys-based implementation in src/index.js (being
 * converted to TypeScript module by module — see TYPESCRIPT_MIGRATION.md).
 *
 * For Termux on Android:
 * - Make sure you have Node.js 20+ installed
 * - Install dependencies: npm install
 * - Copy .env.example to .env and configure it
 * - Dev:  npm run dev        (tsx watch, hot reload)
 * - Run:  npm start          (tsx index.ts)
 * - Prod: npm run build && npm run start:prod   (compiled dist/)
 * - PM2:  npm run pm2
 */

// Start the REST API (website/Discord backend) once MongoDB is connected.
async function startApi(): Promise<void> {
  try {
    await import('./src/api/boot.js');
  } catch (err) {
    console.error('Failed to start REST API:', err);
  }
}

// Import the Baileys-based main module
async function startBot(): Promise<void> {
  try {
    await import('./src/index.js');
  } catch (err) {
    console.error('Failed to start bot:', err);
    process.exit(1);
  }
}

void startApi();
void startBot();
