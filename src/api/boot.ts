// Starts the REST API once MongoDB is connected. Imported by the root
// index.ts entry point alongside src/index.js (which owns mongoose.connect),
// so the API only comes up when the bot's database is actually reachable —
// and automatically follows mongoose's reconnects via the 'connected' event.
import mongoose from 'mongoose';
import { startApiServer } from './server.js';

if (mongoose.connection.readyState === 1) {
  startApiServer().catch((err) => console.error('Failed to start REST API:', err));
} else {
  mongoose.connection.once('connected', () => {
    startApiServer().catch((err) => console.error('Failed to start REST API:', err));
  });
}
