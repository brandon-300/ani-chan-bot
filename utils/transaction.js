const mongoose = require('mongoose');
class BusinessError extends Error {}
async function transaction(fn) {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => fn(session));
  } finally {
    await session.endSession();
  }
}
module.exports = { transaction, BusinessError };
