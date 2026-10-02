
import mongoose from 'mongoose';
const PersonaAnalysisSchema = new mongoose.Schema({
  personaId: { type: String, required: true, trim: true },
  analysisVersion: { type: Number, default: 1, min: 1 },
  personaVersion: { type: String, default: '', trim: true },
  analysisStatus: {
    type: String,
    enum: ['pending', 'classified', 'unclassified', 'failed', 'stale'],
    default: 'pending',
    required: true,
  },
  emotions: { type: [String], default: [] },
  moods: { type: [String], default: [] },
  uses: { type: [String], default: [] },
  reactions: { type: [String], default: [] },
  intensity: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  personaFit: { type: Number, min: 0, max: 1, default: 0 },
  notes: { type: String, default: '', maxlength: 160 },
  analysisError: { type: String, default: null, maxlength: 300 },
  analyzedAt: { type: Date, default: null },
}, { _id: false });
const GenericAnalysisSchema = new mongoose.Schema({
  expression: { type: String, default: '', maxlength: 160 },
  emotions: { type: [String], default: [] },
  moods: { type: [String], default: [] },
  uses: { type: [String], default: [] },
  reactions: { type: [String], default: [] },
  diversityScore: { type: Number, default: 0 },
  analyzedAt: { type: Date, default: null },
}, { _id: false });
const AiStickerSchema = new mongoose.Schema({
  // New imports use the single shared row. Legacy rows retain their original
  // personaId and are normalized into shared rows lazily by aiStickers.js.
  personaId: { type: String, default: 'shared', trim: true },
  hash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  cloudinaryPublicId: { type: String, required: true, trim: true },
  cloudinaryUrl: { type: String, required: true, trim: true },
  cloudinaryVersion: { type: Number, default: null },
  format: { type: String, enum: ['webp'], default: 'webp', required: true },
  bytes: { type: Number, min: 1, required: true },
  animeId: { type: String, default: 'unknown-anime', trim: true, index: true },
  animeName: { type: String, default: 'Unknown anime', trim: true },
  characters: { type: [String], default: [] },
  sourcePackId: { type: String, default: 'unknown-pack', trim: true },
  sourcePackName: { type: String, default: 'Unknown pack', trim: true },
  sourceUrl: { type: String, default: '', trim: true },
  genericAnalysis: { type: GenericAnalysisSchema, default: null },
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
  personaAnalyses: { type: [PersonaAnalysisSchema], default: [] },
}, { timestamps: true });

// personaId records which persona imported a legacy row; it is not an access
// boundary. The runtime loads all rows into one shared sticker library and
// deduplicates by hash. Keep this compound index for existing Mongo records.
AiStickerSchema.index({ personaId: 1, hash: 1 }, { unique: true, name: 'uniq_ai_sticker_persona_hash' });
AiStickerSchema.index({ personaId: 1, analysisStatus: 1, createdAt: -1 }, { name: 'ai_sticker_persona_status_created' });
AiStickerSchema.index({ hash: 1 }, { name: 'ai_sticker_hash_lookup' });
AiStickerSchema.index({ animeId: 1, hash: 1 }, { name: 'ai_sticker_anime_hash_lookup' });

module.exports = mongoose.models.AiSticker || mongoose.model('AiSticker', AiStickerSchema);
