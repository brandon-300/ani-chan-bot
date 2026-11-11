// Minimal singleton-per-key store for small persistent bot state that
// doesn't warrant its own dedicated collection/model — e.g. "the date the
// daily stats digest was last sent", so a PM2 restart that happens to land
// in that exact minute doesn't cause a duplicate send. Not meant for
// anything bigger than a handful of small flags/dates.
import mongoose, { Schema, Model, Document } from 'mongoose';

export interface BotStateDoc extends Document {
  key: string;
  value: string | null;
}

const BotStateSchema = new Schema<BotStateDoc>({
  key: { type: String, required: true, unique: true },
  value: { type: String, default: null },
});

const BotState: Model<BotStateDoc> = mongoose.model<BotStateDoc>('BotState', BotStateSchema);

export default BotState;
