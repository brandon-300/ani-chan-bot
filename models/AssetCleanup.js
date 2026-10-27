const mongoose = require('mongoose');
const schema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    notBefore: { type: Date, default: Date.now },
    publicId: { type: String, required: true },
  },
  { timestamps: true }
);
module.exports = mongoose.model('AssetCleanup', schema);
