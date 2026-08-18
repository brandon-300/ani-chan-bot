const cloudinary = require('cloudinary').v2;

// Cloudinary's SDK auto-reads a single CLOUDINARY_URL env var if it's set
// (the format Cloudinary's own dashboard gives you: cloudinary://key:secret@
// cloud_name). This explicit .config() is just a fallback for the three
// separate CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET
// vars, in case that's what got copied into .env instead — either form works.
if (!process.env.CLOUDINARY_URL) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

const configured = !!(
  process.env.CLOUDINARY_URL ||
  (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET)
);

function isCloudConfigured() {
  return configured;
}

// Uploads a local file to Cloudinary and returns { url, publicId }. Store
// both — url is what you send back to WhatsApp (MessageMedia.fromUrl),
// publicId is what you need later to overwrite or delete it.
//
// folder groups uploads by feature (e.g. 'anichan/profile_pics'). Passing
// the same publicId on a later call overwrites the previous file in place
// instead of piling up orphaned copies — e.g. a user changing their profile
// picture reuses their own id.
async function uploadToCloud(filePath, { folder, publicId, resourceType = 'image' } = {}) {
  if (!configured) {
    throw new Error('Cloudinary is not configured — set CLOUDINARY_URL (or CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET) in .env');
  }
  const result = await cloudinary.uploader.upload(filePath, {
    folder,
    public_id: publicId,
    overwrite: true,
    resource_type: resourceType,
  });
  return { url: result.secure_url, publicId: result.public_id };
}

// Deletes a previously-uploaded file by its full publicId (as returned from
// uploadToCloud — already includes the folder). Never throws; a failed
// cleanup shouldn't block whatever the caller is doing.
async function deleteFromCloud(publicId, resourceType = 'image') {
  if (!configured || !publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (err) {
    console.error('Cloudinary delete failed:', err.message);
  }
}

// Same job as uploadToCloud, but for callers that already have the file's
// bytes in memory (e.g. utils/cardRenderer.js's page.screenshot() output)
// and would otherwise have to write a throwaway temp file just to hand a
// path to the SDK. cloudinary.uploader.upload_stream() accepts a writable
// stream instead, so the buffer goes straight to Cloudinary — no temp file
// created, nothing to clean up on disk, one less filesystem write on a
// phone-class device.
async function uploadBufferToCloud(buffer, { folder, publicId, resourceType = 'image' } = {}) {
  if (!configured) {
    throw new Error('Cloudinary is not configured — set CLOUDINARY_URL (or CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET) in .env');
  }
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, public_id: publicId, overwrite: true, resource_type: resourceType },
      (err, result) => {
        if (err) return reject(err);
        resolve({ url: result.secure_url, publicId: result.public_id });
      }
    );
    stream.end(buffer);
  });
}

module.exports = { uploadToCloud, uploadBufferToCloud, deleteFromCloud, isCloudConfigured };
