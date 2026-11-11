import mongoose from 'mongoose';
import { MESSAGE_CLAIM_TTL_HOURS } from '../utils/config.js';

// One document per incoming WhatsApp message that a bot version has taken. The
// whatsapp-web.js and Baileys versions share this collection (same name, same
// schema): see utils/messageClaims.js. _id is the WhatsApp message id, which is the
// same value in both libraries. Documents delete themselves after the TTL.
const HandledMessageSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  engine: { type: String, default: 'unknown' },
  at: { type: Date, default: Date.now, expires: MESSAGE_CLAIM_TTL_HOURS * 60 * 60 },
}, { versionKey: false });

export default mongoose.models.HandledMessage || mongoose.model('HandledMessage', HandledMessageSchema);
