/**
 * Authorization Code Service
 *
 * Manages OAuth 2.0 authorization codes for federated authentication:
 * - Generate codes with 60-second expiry
 * - Validate and consume codes (single-use)
 * - Cleanup expired codes
 */

const { getAuthSupabaseAdmin } = require('../config/authDatabase');
const { generateAuthCode } = require('../utils/encryptionUtils');

// Code expiry time in seconds
const CODE_EXPIRY_SECONDS = 60;

/**
 * Create a new authorization code
 * @param {Object} params - Code parameters
 * @param {number} params.userId - User ID
 * @param {string} params.email - User email (denormalized)
 * @param {number} params.tenantId - Tenant ID
 * @returns {Object} { code, expires_at }
 */
async function createAuthCode({ userId, email, tenantId }) {
  const supabase = getAuthSupabaseAdmin();

  const code = generateAuthCode(); // 64-char hex string
  const expiresAt = new Date(Date.now() + CODE_EXPIRY_SECONDS * 1000);

  console.log('[AuthCode] Creating auth code for user:', userId, 'tenant:', tenantId);

  const { data, error } = await supabase
    .schema('auth_tenant')
    .from('auth_codes')
    .insert({
      code,
      user_id: userId,
      email: email.toLowerCase().trim(),
      tenant_id: tenantId,
      expires_at: expiresAt.toISOString()
    })
    .select('code, expires_at, created_at');

  if (error) {
    console.error('[AuthCode] Failed to create auth code:', error.message);
    throw new Error('Failed to generate authorization code');
  }

  if (!data || data.length === 0) {
    console.error('[AuthCode] No data returned from insert');
    throw new Error('Failed to generate authorization code');
  }

  console.log('[AuthCode] Auth code created successfully');

  return {
    code: data[0].code,
    expires_at: data[0].expires_at,
    expires_in: CODE_EXPIRY_SECONDS
  };
}

/**
 * Validate and consume an authorization code
 * @param {string} code - Authorization code to validate
 * @param {number} tenantId - Expected tenant ID
 * @returns {Object} { valid, user_id, email, error }
 */
async function consumeAuthCode(code, tenantId) {
  const supabase = getAuthSupabaseAdmin();

  // Get the code record
  const { data: codeData, error: fetchError } = await supabase
    .schema('auth_tenant')
    .from('auth_codes')
    .select('*')
    .eq('code', code)
    .limit(1);

  if (fetchError) {
    console.log('[AuthCode] Fetch error:', fetchError.message);
    return { valid: false, user_id: null, email: null, error: 'INVALID_CODE' };
  }

  if (!codeData || codeData.length === 0) {
    return { valid: false, user_id: null, email: null, error: 'INVALID_CODE' };
  }

  const codeRecord = codeData[0];

  // Check if code is already consumed
  if (codeRecord.consumed_at) {
    return { valid: false, user_id: null, email: null, error: 'CODE_CONSUMED' };
  }

  // Check if code has expired
  if (new Date(codeRecord.expires_at) < new Date()) {
    return { valid: false, user_id: null, email: null, error: 'CODE_EXPIRED' };
  }

  // Check if code belongs to the correct tenant
  if (codeRecord.tenant_id !== tenantId) {
    return { valid: false, user_id: null, email: null, error: 'TENANT_MISMATCH' };
  }

  // Mark code as consumed (atomic operation with check)
  const { data: updatedCode, error: updateError } = await supabase
    .schema('auth_tenant')
    .from('auth_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('code', code)
    .is('consumed_at', null) // Only update if not already consumed
    .select('id');

  if (updateError || !updatedCode || updatedCode.length === 0) {
    // Race condition - code was consumed by another request
    return { valid: false, user_id: null, email: null, error: 'CODE_CONSUMED' };
  }

  return {
    valid: true,
    user_id: codeRecord.user_id,
    email: codeRecord.email,
    tenant_id: codeRecord.tenant_id,
    error: null
  };
}

/**
 * Get code record without consuming it (for validation)
 * @param {string} code - Authorization code
 * @returns {Object|null} Code record
 */
async function getAuthCode(code) {
  const supabase = getAuthSupabaseAdmin();

  const { data, error } = await supabase
    .schema('auth_tenant')
    .from('auth_codes')
    .select('*')
    .eq('code', code)
    .limit(1);

  if (error || !data || data.length === 0) {
    return null;
  }

  return data[0];
}

/**
 * Cleanup expired and consumed authorization codes
 * Deletes codes that are:
 * - Expired for more than 1 hour
 * - Consumed more than 1 hour ago
 * @returns {number} Number of deleted codes
 */
async function cleanupExpiredCodes() {
  const supabase = getAuthSupabaseAdmin();

  const cutoffTime = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago

  // Delete expired or consumed codes older than 1 hour
  const { data, error } = await supabase
    .schema('auth_tenant')
    .from('auth_codes')
    .delete()
    .or(`expires_at.lt.${cutoffTime.toISOString()},and(consumed_at.not.is.null,consumed_at.lt.${cutoffTime.toISOString()})`)
    .select('id');

  if (error) {
    console.error('Failed to cleanup auth codes:', error);
    return 0;
  }

  return data ? data.length : 0;
}

/**
 * Delete all codes for a user (e.g., on logout or password change)
 * @param {number} userId - User ID
 * @returns {number} Number of deleted codes
 */
async function deleteUserCodes(userId) {
  const supabase = getAuthSupabaseAdmin();

  const { data, error } = await supabase
    .schema('auth_tenant')
    .from('auth_codes')
    .delete()
    .eq('user_id', userId)
    .select('id');

  if (error) {
    console.error('Failed to delete user codes:', error);
    return 0;
  }

  return data ? data.length : 0;
}

module.exports = {
  createAuthCode,
  consumeAuthCode,
  getAuthCode,
  cleanupExpiredCodes,
  deleteUserCodes,
  CODE_EXPIRY_SECONDS
};
