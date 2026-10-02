
import mongoose from 'mongoose';
const AiStickerMessageSchema = new mongoose.Schema({
  messageId: { type: String, required: true, unique: true, trim: true },
  chatId: { type: String, required: true, trim: true },
  hash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  personaId: { type: String, required: true, trim: true },
  reaction: { type: String, required: true, trim: true },
  expiresAt: { type: Date, required: true, expires: 0 },
}, { timestamps: true });

export default mongoose.models.AiStickerMessage || mongoose.model('AiStickerMessage', AiStickerMessageSchema);
