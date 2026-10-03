/**
 * .stickeranalyze — owner-only private-DM sticker library analysis.
 * Loaded as its own command module so the handler is registered without
 * rewriting the large commands/ai.js file during migration.
 */
import aiStickers from '../utils/aiStickers.js';

export default {
  async stickeranalyze(client, msg, args) {
    return aiStickers.analyzeCommand(client, msg, args);
  },
};
