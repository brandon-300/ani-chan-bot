const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  status: { type: String, enum: ['running', 'sent'], default: 'running' },
  token: String,
  leaseUntil: Date,
  expiresAt: { type: Date, required: true, expires: 0 },
});
module.exports = mongoose.model('NewsDelivery', schema);
