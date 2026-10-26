const mongoose = require('mongoose');

// Permanent message receipts prevent replaying a committed donation after a
// reconnect or PM2 restart. No message contents or contact names are stored.
const schema = new mongoose.Schema({
  _id: String,
  senderId: { type: String, required: true },
  receiverId: { type: String, required: true },
  amount: { type: Number, required: true },
}, { timestamps: true });

module.exports = mongoose.model('EconomyReceipt', schema);
