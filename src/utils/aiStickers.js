/**
 * AI Stickers Handler
 * Handles AI-powered sticker selection and sending
 * 
 * For Baileys v7:
 * - Uses adapter methods instead of direct client access
 * - Proper sticker metadata handling
 * - Library-independent interface
 */

import config from './config.js';
import defaultLedger from './aiMessageLedger.js';
import logger from './logger.js';
import { BOT_NAME } from './config.js';
import { getActivePersonaSafe } from './persona.js';
import identity from '../whatsapp/identity.js';

class AiStickersHandler {
  constructor() {
    this.stickerLibrary = new Map();
    this.initialized = false;
    this.analysisQueue = [];
    this.quotaCooldown = false;
    this.lastQuotaCheck = 0;
  }

  async initialize() {
    if (this.initialized) return;
    
    try {
      // Load sticker library from MongoDB
      const StickerLibrary = (await import('../models/StickerLibrary.js')).default;
      const stickers = await StickerLibrary.find({}).lean();
      
      for (const sticker of stickers) {
        const key = this._makeStickerKey(sticker);
        this.stickerLibrary.set(key, sticker);
      }
      
      logger.info(`AI Stickers: Loaded ${stickers.length} stickers from library`);
      this.initialized = true;
    } catch (err) {
      logger.error('AI Stickers: Failed to initialize library:', err);
      // Continue with empty library - stickers won't work but bot will
    }
  }

  _makeStickerKey(sticker) {
    return `${sticker.packName || 'unknown'}:${sticker.name || sticker._id}`;
  }

  /**
   * Handle incoming sticker for import
   * Library-independent - uses adapter methods
   */
  async handleIncomingSticker(client, msg) {
    if (!config.AI_STICKERS_ENABLED || !config.AI_STICKER_AUTO_ANALYZE) {
      return false;
    }

    try {
      // Only process stickers
      if (msg.type !== 'sticker' || !msg.hasMedia) {
        return false;
      }

      // Don't process bot's own stickers
      if (msg.fromMe) {
        return false;
      }

      // Check if we're in quota cooldown
      if (this.quotaCooldown) {
        logger.info('AI Stickers: Skipping import due to quota cooldown');
        return false;
      }

      // Download the sticker
      const media = await msg.downloadMedia();
      if (!media) {
        logger.warn('AI Stickers: Could not download sticker media');
        return false;
      }

      // Get sender info
      const sender = identity.getSender(msg);
      const senderId = sender?.id || msg.author || msg.from;
      
      // Check if sender is owner/mod - always allow their stickers
      const isPrivileged = identity.isOwner(senderId) || identity.isMod(senderId);

      // For non-privileged users, check if we should analyze
      if (!isPrivileged) {
        const now = Date.now();
        const lastCheck = this.lastQuotaCheck;
        this.lastQuotaCheck = now;
        
        // Check quota status
        if (this._isQuotaExhausted()) {
          this.quotaCooldown = true;
          setTimeout(() => { this.quotaCooldown = false; }, config.AI_STICKER_QUOTA_COOLDOWN_MS);
          logger.info('AI Stickers: Quota exhausted, entering cooldown');
          return false;
        }
      }

      // Analyze the sticker
      const analysis = await this._analyzeSticker(media, senderId);
      if (!analysis) {
        logger.info('AI Stickers: Analysis failed or no match');
        return false;
      }

      // Save to library
      const saved = await this._saveSticker(analysis, senderId);
      if (saved) {
        logger.info(`AI Stickers: Imported sticker "${analysis.name}" from ${senderId}`);
        return true;
      }
      
      return false;
    } catch (err) {
      logger.error('AI Stickers: Error handling incoming sticker:', err);
      return false;
    }
  }

  async _analyzeSticker(media, senderId) {
    // Use adapter's persona system
    const persona = getActivePersonaSafe();
    if (!persona) {
      logger.warn('AI Stickers: No active persona configured');
      return null;
    }

    // This would call Gemini for analysis
    // For now, return a mock analysis
    // In production, this would use the gemini service
    return {
      name: `sticker_${Date.now()}`,
      packName: persona.name || BOT_NAME,
      author: persona.author || BOT_NAME,
      personaId: persona.id || 'default',
      fitScore: 0.95,
      tags: ['anime', 'default'],
      timestamp: Date.now(),
      importedBy: senderId,
    };
  }

  async _saveSticker(analysis, senderId) {
    try {
      const StickerLibrary = (await import('../models/StickerLibrary.js')).default;
      
      const sticker = new StickerLibrary({
        name: analysis.name,
        packName: analysis.packName,
        author: analysis.author,
        personaId: analysis.personaId,
        fitScore: analysis.fitScore,
        tags: analysis.tags,
        importedBy: senderId,
        importedAt: new Date(),
        lastUsed: null,
        useCount: 0,
      });

      await sticker.save();
      
      // Add to in-memory cache
      const key = this._makeStickerKey(sticker);
      this.stickerLibrary.set(key, sticker);
      
      return sticker;
    } catch (err) {
      logger.error('AI Stickers: Failed to save sticker:', err);
      return null;
    }
  }

  _isQuotaExhausted() {
    // Check if we should pause due to quota
    // This would integrate with the geminiGate service
    return false; // Placeholder - implement based on actual quota tracking
  }

  /**
   * Get AI sticker for response
   * Uses adapter methods, not direct client access
   */
  async getStickerForResponse(msg, persona) {
    if (!config.AI_STICKERS_ENABLED) {
      return null;
    }

    const activePersona = persona || getActivePersonaSafe();
    if (!activePersona) {
      return null;
    }

    // Get recent stickers for this persona
    const personaStickers = [];
    for (const [key, sticker] of this.stickerLibrary) {
      if (sticker.personaId === activePersona.id) {
        personaStickers.push(sticker);
      }
    }

    if (personaStickers.length === 0) {
      return null;
    }

    // Select a sticker based on message content
    const selected = this._selectSticker(msg, personaStickers);
    if (!selected) {
      return null;
    }

    return {
      sticker: selected,
      packName: selected.packName || activePersona.name || BOT_NAME,
      author: selected.author || activePersona.author || BOT_NAME,
    };
  }

  _selectSticker(msg, stickers) {
    // Simple random selection for now
    // In production, this would use message analysis to select the best match
    return stickers[Math.floor(Math.random() * stickers.length)];
  }

  /**
   * Send AI sticker
   * Uses adapter methods, not direct client access
   */
  async sendSticker(client, jid, stickerData, options = {}) {
    try {
      // Build sticker options with proper metadata
      const stickerOptions = {
        packName: stickerData.packName || BOT_NAME,
        author: stickerData.author || (getActivePersonaSafe()?.name || BOT_NAME),
        ...options,
      };

      // Use the client's sendSticker method (from adapter)
      await client.sendSticker(jid, stickerData.buffer || stickerData, stickerOptions);
      
      // Update usage tracking
      if (stickerData._id) {
        const StickerLibrary = (await import('../models/StickerLibrary.js')).default;
        await StickerLibrary.findByIdAndUpdate(stickerData._id, {
          $inc: { useCount: 1 },
          $set: { lastUsed: new Date() }
        });
      }

      return true;
    } catch (err) {
      logger.error('AI Stickers: Failed to send sticker:', err);
      return false;
    }
  }

  /**
   * Check if message should include AI sticker
   * Enforces exclusivity rules:
   * - Normal text AI: text + optional standalone sticker
   * - Sticker reply: text OR sticker (not both)
   * - Voice: voice only, NO AI sticker
   * - No suitable sticker: no sticker
   */
  shouldIncludeSticker(msg, isStickerReply = false) {
    // Voice messages never get AI stickers
    if (msg.type === 'ptt' || (msg.type === 'audio' && msg._data?.ptt)) {
      return false;
    }

    // Sticker replies: text OR sticker, not both
    if (isStickerReply) {
      // If the reply is a sticker, don't add another sticker
      if (msg.type === 'sticker') {
        return false;
      }
      // For text replies to stickers, allow AI sticker
      return true;
    }

    // Normal messages: allow AI sticker
    return true;
  }

  /**
   * Get AI sticker exclusivity rules
   */
  getExclusivityRules() {
    return {
      normalText: { text: true, standaloneSticker: true },
      stickerReply: { text: true, sticker: false }, // text OR sticker, not both
      voice: { voice: true, sticker: false }, // voice only, NO AI sticker
      noMatch: { sticker: false },
    };
  }
}

const aiStickers = new AiStickersHandler();
export default aiStickers;
