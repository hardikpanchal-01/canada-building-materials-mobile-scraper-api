/**
 * Authorization Code Service
 *
 * Manages OAuth 2.0 authorization codes for federated authentication:
 * - Generate codes with 60-second expiry
 * - Validate and consume codes (single-use)
 * - Cleanup expired codes
 */

const { executeAuthSQL } = require('../config/authPostgres');
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
  const code = generateAuthCode(); // 64-char hex string
  const expiresAt = new Date(Date.now() + CODE_EXPIRY_SECONDS * 1000);

  console.log('[AuthCode] Creating auth code for user:', userId, 'tenant:', tenantId);

  const result = await executeAuthSQL(
    'INSERT INTO auth_codes (code, user_id, email, tenant_id, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING code, expires_at, created_at',
    [code, userId, email.toLowerCase().trim(), tenantId, expiresAt.toISOString()]
  );

  if (!result.success) {
    console.error('[AuthCode] Failed to create auth code:', result.error);
    throw new Error('Failed to generate authorization code');
  }

  if (!result.data || result.data.length === 0) {
    console.error('[AuthCode] No data returned from insert');
    throw new Error('Failed to generate authorization code');
  }

  console.log('[AuthCode] Auth code created successfully');

  return {
    code: result.data[0].code,
    expires_at: result.data[0].expires_at,
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
  // Get the code record
  const fetchResult = await executeAuthSQL(
    'SELECT * FROM auth_codes WHERE code = $1 LIMIT 1',
    [code]
  );

  if (!fetchResult.success) {
    console.log('[AuthCode] Fetch error:', fetchResult.error);
    return { valid: false, user_id: null, email: null, error: 'INVALID_CODE' };
  }

  if (!fetchResult.data || fetchResult.data.length === 0) {
    return { valid: false, user_id: null, email: null, error: 'INVALID_CODE' };
  }

  const codeRecord = fetchResult.data[0];

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
  const updateResult = await executeAuthSQL(
    'UPDATE auth_codes SET consumed_at = $1 WHERE code = $2 AND consumed_at IS NULL RETURNING id',
    [new Date().toISOString(), code]
  );

  if (!updateResult.success || !updateResult.data || updateResult.data.length === 0) {
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
  const result = await executeAuthSQL(
    'SELECT * FROM auth_codes WHERE code = $1 LIMIT 1',
    [code]
  );

  if (!result.success || !result.data || result.data.length === 0) {
    return null;
  }

  return result.data[0];
}

/**
 * Cleanup expired and consumed authorization codes
 * Deletes codes that are:
 * - Expired for more than 1 hour
 * - Consumed more than 1 hour ago
 * @returns {number} Number of deleted codes
 */
async function cleanupExpiredCodes() {
  const cutoffTime = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago

  // Delete expired or consumed codes older than 1 hour
  const result = await executeAuthSQL(
    'DELETE FROM auth_codes WHERE expires_at < $1 OR (consumed_at IS NOT NULL AND consumed_at < $1) RETURNING id',
    [cutoffTime.toISOString()]
  );

  if (!result.success) {
    console.error('Failed to cleanup auth codes:', result.error);
    return 0;
  }

  return result.data ? result.data.length : 0;
}

/**
 * Delete all codes for a user (e.g., on logout or password change)
 * @param {number} userId - User ID
 * @returns {number} Number of deleted codes
 */
async function deleteUserCodes(userId) {
  const result = await executeAuthSQL(
    'DELETE FROM auth_codes WHERE user_id = $1 RETURNING id',
    [userId]
  );

  if (!result.success) {
    console.error('Failed to delete user codes:', result.error);
    return 0;
  }

  return result.data ? result.data.length : 0;
}

module.exports = {
  createAuthCode,
  consumeAuthCode,
  getAuthCode,
  cleanupExpiredCodes,
  deleteUserCodes,
  CODE_EXPIRY_SECONDS
};
