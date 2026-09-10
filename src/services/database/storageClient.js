/**
 * Object storage client.
 *
 * Provides configured object-storage operations for scraped-order JSON archival
 * and user avatars. Uses the service key and talks to the tenant's self-hosted
 * storage gateway via a thin fetch client (no hosted SDK). The public function
 * contracts (uploadToStorage / uploadAvatarToStorage / deleteAvatarFromStorage
 * returning { path, publicUrl } and the bucket-name exports) are unchanged.
 *
 * When DATA_GATEWAY_URL is NOT set, falls back to local file storage under
 * public/uploads/ (development). Files are served via Express static middleware.
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

let makeStorage;
try { makeStorage = require('../../db/restFetch').makeStorage; } catch { makeStorage = null; }

const STORAGE_URL = process.env.DATA_GATEWAY_URL;
const STORAGE_SERVICE_KEY = process.env.DATA_GATEWAY_SERVICE_KEY || process.env.DATA_GATEWAY_ANON_KEY;

// Storage timeout configuration (default: 30 seconds)
const STORAGE_TIMEOUT_MS = parseInt(process.env.STORAGE_TIMEOUT_MS) || 30000;

// Only build the storage client if credentials are provided.
let storage = null;
if (STORAGE_URL && STORAGE_SERVICE_KEY && makeStorage) {
  storage = makeStorage({ url: STORAGE_URL, serviceKey: STORAGE_SERVICE_KEY });
}

/** Storage bucket name for scraped orders */
const SCRAPED_ORDERS_BUCKET = 'scraped-orders';

/** Storage bucket name for user avatars */
const AVATARS_BUCKET = 'avatars';

// Local file storage fallback
const USE_LOCAL_STORAGE = !storage;
const LOCAL_UPLOADS_DIR = path.join(__dirname, '..', '..', '..', 'public', 'uploads');

if (USE_LOCAL_STORAGE) {
  fs.mkdirSync(path.join(LOCAL_UPLOADS_DIR, AVATARS_BUCKET), { recursive: true });
  fs.mkdirSync(path.join(LOCAL_UPLOADS_DIR, SCRAPED_ORDERS_BUCKET), { recursive: true });
  console.warn('⚠️  Storage credentials not configured - using local file storage (public/uploads/)');
}

function localUrlFor(key) {
  const port = process.env.PORT || 5000;
  return `http://localhost:${port}/uploads/${key}`;
}

/**
 * Upload JSON data to object storage with timeout protection
 *
 * @param {string} fileName - Name of the file to create
 * @param {object|array} data - Data to store as JSON
 * @param {number} timeoutMs - Timeout in milliseconds (default: STORAGE_TIMEOUT_MS)
 * @returns {Promise<{path: string, publicUrl: string}>} Upload result
 */
async function uploadToStorage(fileName, data, timeoutMs = STORAGE_TIMEOUT_MS) {
  const key = `${SCRAPED_ORDERS_BUCKET}/${fileName}`;

  if (USE_LOCAL_STORAGE) {
    const filePath = path.join(LOCAL_UPLOADS_DIR, key);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return { path: key, publicUrl: localUrlFor(key) };
  }

  const jsonContent = JSON.stringify(data, null, 2);
  const buffer = Buffer.from(jsonContent, 'utf-8');

  const uploadPromise = storage
    .from(SCRAPED_ORDERS_BUCKET)
    .upload(fileName, buffer, {
      contentType: 'application/json',
      upsert: false,
    });

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`Storage upload timeout after ${timeoutMs}ms`)),
      timeoutMs
    )
  );

  try {
    const { data: uploadData, error: uploadError } = await Promise.race([
      uploadPromise,
      timeoutPromise,
    ]);

    if (uploadError) {
      throw new Error(`Storage upload failed: ${uploadError.message}`);
    }

    const { data: urlData } = storage
      .from(SCRAPED_ORDERS_BUCKET)
      .getPublicUrl(fileName);

    return {
      path: uploadData.path,
      publicUrl: urlData.publicUrl,
    };
  } catch (error) {
    if (error.message.includes('timeout')) {
      console.error(`Storage upload timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

/**
 * Upload an avatar image to object storage
 *
 * @param {string} userId - User ID used to namespace the file
 * @param {Buffer} fileBuffer - Raw file buffer
 * @param {string} mimeType - MIME type (e.g. 'image/png')
 * @param {string} originalName - Original file name for extension extraction
 * @returns {Promise<{path: string, publicUrl: string}>} Upload result
 */
async function uploadAvatarToStorage(userId, fileBuffer, mimeType, originalName) {
  const ext = originalName.split('.').pop().toLowerCase();
  const fileName = `${userId}/avatar_${Date.now()}.${ext}`;
  const key = `${AVATARS_BUCKET}/${fileName}`;

  if (USE_LOCAL_STORAGE) {
    const filePath = path.join(LOCAL_UPLOADS_DIR, key);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, fileBuffer);
    return { path: key, publicUrl: localUrlFor(key) };
  }

  const uploadPromise = storage
    .from(AVATARS_BUCKET)
    .upload(fileName, fileBuffer, {
      contentType: mimeType,
      upsert: true,
    });

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`Avatar upload timeout after ${STORAGE_TIMEOUT_MS}ms`)),
      STORAGE_TIMEOUT_MS
    )
  );

  const { data: uploadData, error: uploadError } = await Promise.race([
    uploadPromise,
    timeoutPromise,
  ]);

  if (uploadError) {
    throw new Error(`Avatar upload failed: ${uploadError.message}`);
  }

  const { data: urlData } = storage
    .from(AVATARS_BUCKET)
    .getPublicUrl(fileName);

  return {
    path: uploadData.path,
    publicUrl: urlData.publicUrl,
  };
}

/**
 * Delete an avatar file from object storage
 *
 * @param {string} filePath - The storage path of the file to delete
 * @returns {Promise<void>}
 */
async function deleteAvatarFromStorage(filePath) {
  const key = filePath.startsWith(`${AVATARS_BUCKET}/`) ? filePath : `${AVATARS_BUCKET}/${filePath}`;

  if (USE_LOCAL_STORAGE) {
    try {
      const localPath = path.join(LOCAL_UPLOADS_DIR, key);
      await fsp.access(localPath).then(() => fsp.unlink(localPath)).catch(() => {});
    } catch (error) {
      console.warn('Failed to delete local avatar:', error.message);
    }
    return;
  }

  const { error } = await storage
    .from(AVATARS_BUCKET)
    .remove([filePath]);

  if (error) {
    console.warn('Failed to delete old avatar from storage:', error.message);
  }
}

module.exports = {
  // kept for backward-compat with any importer expecting a storage handle
  dbClient: storage,
  storage,
  SCRAPED_ORDERS_BUCKET,
  AVATARS_BUCKET,
  uploadToStorage,
  uploadAvatarToStorage,
  deleteAvatarFromStorage,
  STORAGE_TIMEOUT_MS,
};
