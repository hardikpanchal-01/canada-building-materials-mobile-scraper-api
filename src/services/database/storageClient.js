/**
 * Object storage client.
 *
 * Provides configured object-storage operations for scraped-order JSON archival
 * and user avatars. Uses the service key and talks to the tenant's self-hosted
 * storage gateway via a thin fetch client (no hosted SDK). The public function
 * contracts (uploadToStorage / uploadAvatarToStorage / deleteAvatarFromStorage
 * returning { path, publicUrl } and the bucket-name exports) are unchanged.
 */

const { makeStorage } = require('../../db/restFetch');

const STORAGE_URL = process.env.SUPABASE_URL;
const STORAGE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

// Storage timeout configuration (default: 30 seconds)
const STORAGE_TIMEOUT_MS = parseInt(process.env.STORAGE_TIMEOUT_MS) || 30000;

// Only build the storage client if credentials are provided.
let storage = null;
if (STORAGE_URL && STORAGE_SERVICE_KEY) {
  storage = makeStorage({ url: STORAGE_URL, serviceKey: STORAGE_SERVICE_KEY });
} else {
  console.warn('⚠️  Storage credentials not configured - storage features will be unavailable');
}

/** Storage bucket name for scraped orders */
const SCRAPED_ORDERS_BUCKET = 'scraped-orders';

/** Storage bucket name for user avatars */
const AVATARS_BUCKET = 'avatars';

/**
 * Upload JSON data to object storage with timeout protection
 *
 * @param {string} fileName - Name of the file to create
 * @param {object|array} data - Data to store as JSON
 * @param {number} timeoutMs - Timeout in milliseconds (default: STORAGE_TIMEOUT_MS)
 * @returns {Promise<{path: string, publicUrl: string}>} Upload result
 */
async function uploadToStorage(fileName, data, timeoutMs = STORAGE_TIMEOUT_MS) {
  if (!storage) {
    throw new Error('Storage client not configured. Please set SUPABASE_URL and SUPABASE_SERVICE_KEY.');
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
  if (!storage) {
    throw new Error('Storage client not configured. Please set SUPABASE_URL and SUPABASE_SERVICE_KEY.');
  }

  const ext = originalName.split('.').pop().toLowerCase();
  const fileName = `${userId}/avatar_${Date.now()}.${ext}`;

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
  if (!storage) {
    throw new Error('Storage client not configured.');
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
