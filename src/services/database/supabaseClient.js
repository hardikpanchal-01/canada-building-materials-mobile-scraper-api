/**
 * Supabase Client
 *
 * Provides a configured Supabase client for storage operations.
 * Uses the service key for server-side operations.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

// Storage timeout configuration (default: 30 seconds)
const STORAGE_TIMEOUT_MS = parseInt(process.env.STORAGE_TIMEOUT_MS) || 30000;

// Only create client if credentials are provided
let supabase = null;

if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  /**
   * Supabase client instance with service key for full access
   */
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
} else {
  console.warn('⚠️  Supabase storage credentials not configured - storage features will be unavailable');
}

/**
 * Storage bucket name for scraped orders
 */
const SCRAPED_ORDERS_BUCKET = 'scraped-orders';

/**
 * Storage bucket name for user avatars
 */
const AVATARS_BUCKET = 'avatars';

/**
 * Upload JSON data to Supabase Storage with timeout protection
 *
 * @param {string} fileName - Name of the file to create
 * @param {object|array} data - Data to store as JSON
 * @param {number} timeoutMs - Timeout in milliseconds (default: STORAGE_TIMEOUT_MS)
 * @returns {Promise<{path: string, publicUrl: string}>} Upload result
 */
async function uploadToStorage(fileName, data, timeoutMs = STORAGE_TIMEOUT_MS) {
  if (!supabase) {
    throw new Error('Supabase client not configured. Please set SUPABASE_URL and SUPABASE_SERVICE_KEY.');
  }

  const jsonContent = JSON.stringify(data, null, 2);
  const buffer = Buffer.from(jsonContent, 'utf-8');

  // Create upload promise
  const uploadPromise = supabase.storage
    .from(SCRAPED_ORDERS_BUCKET)
    .upload(fileName, buffer, {
      contentType: 'application/json',
      upsert: false
    });

  // Create timeout promise
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`Storage upload timeout after ${timeoutMs}ms`)),
      timeoutMs
    )
  );

  try {
    // Race between upload and timeout
    const { data: uploadData, error: uploadError } = await Promise.race([
      uploadPromise,
      timeoutPromise
    ]);

    if (uploadError) {
      throw new Error(`Storage upload failed: ${uploadError.message}`);
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from(SCRAPED_ORDERS_BUCKET)
      .getPublicUrl(fileName);

    return {
      path: uploadData.path,
      publicUrl: urlData.publicUrl
    };
  } catch (error) {
    if (error.message.includes('timeout')) {
      console.error(`Supabase storage upload timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

/**
 * Upload an avatar image to Supabase Storage
 *
 * @param {string} userId - User ID used to namespace the file
 * @param {Buffer} fileBuffer - Raw file buffer
 * @param {string} mimeType - MIME type (e.g. 'image/png')
 * @param {string} originalName - Original file name for extension extraction
 * @returns {Promise<{path: string, publicUrl: string}>} Upload result
 */
async function uploadAvatarToStorage(userId, fileBuffer, mimeType, originalName) {
  if (!supabase) {
    throw new Error('Supabase client not configured. Please set SUPABASE_URL and SUPABASE_SERVICE_KEY.');
  }

  // Extract extension from original filename
  const ext = originalName.split('.').pop().toLowerCase();
  const fileName = `${userId}/avatar_${Date.now()}.${ext}`;

  const uploadPromise = supabase.storage
    .from(AVATARS_BUCKET)
    .upload(fileName, fileBuffer, {
      contentType: mimeType,
      upsert: true
    });

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`Avatar upload timeout after ${STORAGE_TIMEOUT_MS}ms`)),
      STORAGE_TIMEOUT_MS
    )
  );

  const { data: uploadData, error: uploadError } = await Promise.race([
    uploadPromise,
    timeoutPromise
  ]);

  if (uploadError) {
    throw new Error(`Avatar upload failed: ${uploadError.message}`);
  }

  const { data: urlData } = supabase.storage
    .from(AVATARS_BUCKET)
    .getPublicUrl(fileName);

  return {
    path: uploadData.path,
    publicUrl: urlData.publicUrl
  };
}

/**
 * Delete an avatar file from Supabase Storage
 *
 * @param {string} filePath - The storage path of the file to delete
 * @returns {Promise<void>}
 */
async function deleteAvatarFromStorage(filePath) {
  if (!supabase) {
    throw new Error('Supabase client not configured.');
  }

  const { error } = await supabase.storage
    .from(AVATARS_BUCKET)
    .remove([filePath]);

  if (error) {
    console.warn('Failed to delete old avatar from storage:', error.message);
  }
}

module.exports = {
  supabase,
  SCRAPED_ORDERS_BUCKET,
  AVATARS_BUCKET,
  uploadToStorage,
  uploadAvatarToStorage,
  deleteAvatarFromStorage,
  STORAGE_TIMEOUT_MS
};
