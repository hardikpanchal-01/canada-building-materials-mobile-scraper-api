/**
 * Object storage for scraped-order batches.
 *
 * This used to upload JSON to the hosted provider's object storage. That is
 * retired, so batches are written to the local uploads directory and served back
 * through the API, mirroring how the web app handles its uploads.
 *
 * UPLOAD_DIR controls the root (default: <cwd>/uploads). In a container that
 * should be a mounted volume — otherwise batches live only as long as the pod.
 */

const fs = require('fs/promises');
const path = require('path');

const BUCKET = process.env.SCRAPED_ORDERS_BUCKET || 'scraped-orders';
const ROOT = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');

// Reject anything that could escape the bucket directory.
const SAFE = /^[a-zA-Z0-9._/-]+$/;

function assertSafe(filePath) {
  if (!SAFE.test(filePath) || filePath.includes('..')) {
    throw new Error('Invalid storage path');
  }
}

/**
 * Write a JSON payload to storage.
 * @param {string} fileName - object key within the bucket
 * @param {object|string|Buffer} data - payload; objects are JSON-encoded
 * @returns {Promise<{path: string, publicUrl: string}>}
 */
async function uploadToStorage(fileName, data) {
  assertSafe(fileName);
  const dest = path.join(ROOT, BUCKET, fileName);
  await fs.mkdir(path.dirname(dest), { recursive: true });

  const body =
    Buffer.isBuffer(data) || typeof data === 'string'
      ? data
      : JSON.stringify(data);

  await fs.writeFile(dest, body);

  return {
    path: `${BUCKET}/${fileName}`,
    publicUrl: `/api/files/${BUCKET}/${fileName}`,
  };
}

/**
 * Read a previously stored object back.
 * @param {string} fileName - object key within the bucket
 * @returns {Promise<Buffer>}
 */
async function downloadFromStorage(fileName) {
  assertSafe(fileName);
  return fs.readFile(path.join(ROOT, BUCKET, fileName));
}

/**
 * Delete a stored object. Missing files are not an error.
 * @param {string} fileName - object key within the bucket
 */
async function removeFromStorage(fileName) {
  assertSafe(fileName);
  try {
    await fs.unlink(path.join(ROOT, BUCKET, fileName));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

const AVATARS_BUCKET = process.env.AVATARS_BUCKET || 'avatars';

function extensionFor(mimeType, originalName) {
  const fromName = originalName && originalName.includes('.')
    ? originalName.slice(originalName.lastIndexOf('.') + 1).toLowerCase()
    : '';
  if (/^[a-z0-9]{1,5}$/.test(fromName)) return fromName;
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  return map[mimeType] || 'bin';
}

/**
 * Store a user avatar.
 * @param {string} userId
 * @param {Buffer} fileBuffer
 * @param {string} mimeType
 * @param {string} originalName
 * @returns {Promise<{path: string, publicUrl: string}>}
 */
async function uploadAvatarToStorage(userId, fileBuffer, mimeType, originalName) {
  const ext = extensionFor(mimeType, originalName);
  // A per-user prefix keeps replacement simple and avoids collisions.
  const key = `${String(userId).replace(/[^a-zA-Z0-9_-]/g, '')}/avatar.${ext}`;
  const dest = path.join(ROOT, AVATARS_BUCKET, key);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, fileBuffer);
  return {
    path: `${AVATARS_BUCKET}/${key}`,
    publicUrl: `/api/files/${AVATARS_BUCKET}/${key}`,
  };
}

/**
 * Delete a stored avatar. Missing files are not an error.
 * @param {string} key - path within the avatars bucket
 */
async function deleteAvatarFromStorage(key) {
  assertSafe(key);
  try {
    await fs.unlink(path.join(ROOT, AVATARS_BUCKET, key));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

module.exports = {
  uploadToStorage,
  downloadFromStorage,
  removeFromStorage,
  uploadAvatarToStorage,
  deleteAvatarFromStorage,
  AVATARS_BUCKET,
  BUCKET,
  ROOT,
};
