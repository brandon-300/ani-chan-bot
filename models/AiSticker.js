const mongoose = require('mongoose');

const AiStickerSchema = new mongoose.Schema({
  personaId: { type: String, required: true, trim: true },
  hash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  cloudinaryPublicId: { type: String, required: true, trim: true },
  cloudinaryUrl: { type: String, required: true, trim: true },
  cloudinaryVersion: { type: Number, default: null },
  format: { type: String, enum: ['webp'], default: 'webp', required: true },
  bytes: { type: Number, min: 1, required: true },
  analysisStatus: {
    type: String,
    enum: ['pending', 'classified', 'unclassified'],
    default: 'pending',
    required: true,
  },
  emotions: { type: [String], default: [] },
  moods: { type: [String], default: [] },
  uses: { type: [String], default: [] },
  reactions: { type: [String], default: [] },
  intensity: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  notes: { type: String, default: '', maxlength: 160 },
  analysisError: { type: String, default: null, maxlength: 300 },
  importedAt: { type: Date, default: Date.now },
  analyzedAt: { type: Date, default: null },
}, { timestamps: true });

// personaId records which persona imported a legacy row; it is not an access
// boundary. The runtime loads all rows into one shared sticker library and
// deduplicates by hash. Keep this compound index for existing Mongo records.
AiStickerSchema.index({ personaId: 1, hash: 1 }, { unique: true, name: 'uniq_ai_sticker_persona_hash' });
AiStickerSchema.index({ personaId: 1, analysisStatus: 1, createdAt: -1 }, { name: 'ai_sticker_persona_status_created' });

module.exports = mongoose.models.AiSticker || mongoose.model('AiSticker', AiStickerSchema);
