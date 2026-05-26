/**
 * Short URL Service
 *
 * Manages short URL resolution for mobile deep linking:
 * - Resolve short URL code to original URL
 * - Validate expiry
 * - Increment click count
 */

const { getAuthSupabaseAdmin } = require('../config/authDatabase');

/**
 * Resolve a short URL by its code
 * @param {string} code - The short URL code to resolve
 * @returns {Object} { success, data, error, error_code }
 */
async function resolveShortUrl(code) {
  const supabase = getAuthSupabaseAdmin();

  // Look up the short URL record
  const { data, error: fetchError } = await supabase
    .schema('auth_tenant')
    .from('short_urls')
    .select('id, code, tenant_slug, original_url, expires_at, click_count')
    .eq('code', code)
    .limit(1);

  if (fetchError) {
    console.error('[ShortUrl] Database error:', fetchError.message);
    return { success: false, data: null, error: 'Failed to resolve short URL', error_code: 'DB_ERROR' };
  }

  if (!data || data.length === 0) {
    console.warn('[ShortUrl] Code not found:', code);
    return { success: false, data: null, error: 'Short URL not found', error_code: 'NOT_FOUND' };
  }

  const record = data[0];

  // Check expiry if expires_at is set
  if (record.expires_at) {
    const expiresAt = new Date(record.expires_at);
    if (expiresAt < new Date()) {
      console.warn('[ShortUrl] Code expired:', code, 'expired at:', record.expires_at);
      return { success: false, data: null, error: 'This link has expired', error_code: 'EXPIRED' };
    }
  }

  // Increment click_count atomically and update last_accessed_at (fire-and-forget)
  supabase
    .rpc('increment_short_url_click', { short_url_id: record.id })
    .then(({ error: updateError }) => {
      if (updateError) {
        // Fallback to non-atomic update if RPC not available
        console.warn('[ShortUrl] RPC increment failed, using fallback:', updateError.message);
        supabase
          .schema('auth_tenant')
          .from('short_urls')
          .update({
            click_count: (record.click_count || 0) + 1,
            last_accessed_at: new Date().toISOString(),
          })
          .eq('id', record.id)
          .then(({ error: fallbackError }) => {
            if (fallbackError) {
              console.error('[ShortUrl] Fallback increment also failed:', fallbackError.message);
            }
          });
      }
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
