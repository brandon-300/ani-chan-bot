const crypto = require('node:crypto');
const User = require('../models/User');
const AssetCleanup = require('../models/AssetCleanup');
const { transaction, BusinessError } = require('./transaction');
const { uploadToCloud } = require('./cloudinary');
const scheduler = require('./scheduler');

async function enqueue(publicId, userId, session, notBefore = new Date()) {
  if (!publicId) return null;
  const [asset] = await AssetCleanup.create([{ publicId, userId, notBefore }], { session });
  return asset;
}
async function replace(user, filePath) {
  // Register the prospective upload before contacting the provider. Even a
  // crash after upload but before profile commit leaves a cleanup record.
  const token = crypto.randomUUID();
  const fullId = `anichan/profile_pics/${token}`;
  await enqueue(fullId, user.id, undefined, new Date(Date.now() + 10 * 60000));
  const uploaded = await uploadToCloud(filePath, {
    folder: 'anichan/profile_pics',
    publicId: token,
    resourceType: 'image',
  });
  const updated = await transaction(async (session) => {
    const fresh = await User.findById(user._id).session(session);
    if (!fresh) throw new BusinessError('Your account changed before the upload finished.');
    await enqueue(fresh.profile.picPublicId, fresh.id, session);
    fresh.profile.picUrl = uploaded.url;
    fresh.profile.picPublicId = uploaded.publicId;
    fresh.registration.picSet = true;
    await fresh.save({ session });
    await AssetCleanup.deleteMany({ publicId: fullId }, { session });
    return fresh;
  });
  await scheduler._armNext();
  return updated;
}
async function remove(userId) {
  await transaction(async (session) => {
    const user = await User.findOne({ id: userId }).session(session);
    if (!user?.profile.picUrl) throw new BusinessError('No profile picture is set.');
    await enqueue(user.profile.picPublicId, user.id, session);
    user.profile.picUrl = '';
    user.profile.picPublicId = '';
    await user.save({ session });
  });
}
module.exports = { replace, remove };
