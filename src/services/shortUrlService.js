/**
 * Short URL Service
 *
 * Manages short URL resolution for mobile deep linking:
 * - Resolve short URL code to original URL
 * - Validate expiry
 * - Increment click count
 */

const { executeAuthSQL } = require('../config/authPostgres');

/**
 * Resolve a short URL by its code
 * @param {string} code - The short URL code to resolve
 * @returns {Object} { success, data, error, error_code }
 */
async function resolveShortUrl(code) {
  let record;
  try {
    const result = await executeAuthSQL(
      `SELECT id, code, tenant_slug, original_url, expires_at, click_count
         FROM public.short_urls WHERE code = $1 LIMIT 1`,
      [code]
    );
    if (result.data.length === 0) {
      console.warn('[ShortUrl] Code not found:', code);
      return { success: false, data: null, error: 'Short URL not found', error_code: 'NOT_FOUND' };
    }
    record = result.data[0];
  } catch (fetchError) {
    console.error('[ShortUrl] Database error:', fetchError.message);
    return { success: false, data: null, error: 'Failed to resolve short URL', error_code: 'DB_ERROR' };
  }

  // Check expiry if expires_at is set
  if (record.expires_at) {
    const expiresAt = new Date(record.expires_at);
    if (expiresAt < new Date()) {
      console.warn('[ShortUrl] Code expired:', code, 'expired at:', record.expires_at);
      return { success: false, data: null, error: 'This link has expired', error_code: 'EXPIRED' };
    }
  }

  // Increment click_count atomically and update last_accessed_at (fire-and-forget)
  executeAuthSQL(
    `UPDATE public.short_urls
       SET click_count = COALESCE(click_count, 0) + 1, last_accessed_at = NOW()
       WHERE id = $1`,
    [record.id]
  ).catch((updateError) => {
    console.error('[ShortUrl] Click increment failed:', updateError.message);
  });

  return {
    success: true,
    data: {
      tenant_slug: record.tenant_slug,
      original_url: record.original_url,
    },
    error: null,
    error_code: null,
  };
}

module.exports = {
  resolveShortUrl,
};
