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

const CODE_EXPIRY_SECONDS = 60;

async function createAuthCode({ userId, email, tenantId }) {
  const code = generateAuthCode();
  const expiresAt = new Date(Date.now() + CODE_EXPIRY_SECONDS * 1000);

  console.log('[AuthCode] Creating auth code for user:', userId, 'tenant:', tenantId);

  let result;
  try {
    result = await executeAuthSQL(
      `INSERT INTO public.auth_codes (code, user_id, email, tenant_id, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING code, expires_at, created_at`,
      [code, userId, email.toLowerCase().trim(), tenantId, expiresAt.toISOString()]
    );
  } catch (error) {
    console.error('[AuthCode] Failed to create auth code:', error.message);
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

async function consumeAuthCode(code, tenantId) {
  let codeRecord;
  try {
    const fetchResult = await executeAuthSQL(
      'SELECT * FROM public.auth_codes WHERE code = $1 LIMIT 1',
      [code]
    );
    if (fetchResult.data.length === 0) {
      return { valid: false, user_id: null, email: null, error: 'INVALID_CODE' };
    }
    codeRecord = fetchResult.data[0];
  } catch (error) {
    console.log('[AuthCode] Fetch error:', error.message);
    return { valid: false, user_id: null, email: null, error: 'INVALID_CODE' };
  }

  if (codeRecord.consumed_at) {
    return { valid: false, user_id: null, email: null, error: 'CODE_CONSUMED' };
  }

  if (new Date(codeRecord.expires_at) < new Date()) {
    return { valid: false, user_id: null, email: null, error: 'CODE_EXPIRED' };
  }

  if (codeRecord.tenant_id !== tenantId) {
    return { valid: false, user_id: null, email: null, error: 'TENANT_MISMATCH' };
  }

  try {
    const updateResult = await executeAuthSQL(
      `UPDATE public.auth_codes
       SET consumed_at = NOW()
       WHERE code = $1 AND consumed_at IS NULL
       RETURNING id`,
      [code]
    );
    if (updateResult.data.length === 0) {
      return { valid: false, user_id: null, email: null, error: 'CODE_CONSUMED' };
    }
  } catch (error) {
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

async function getAuthCode(code) {
  try {
    const result = await executeAuthSQL(
      'SELECT * FROM public.auth_codes WHERE code = $1 LIMIT 1',
      [code]
    );
    return result.data.length > 0 ? result.data[0] : null;
  } catch (error) {
    return null;
  }
}

async function cleanupExpiredCodes() {
  const cutoffTime = new Date(Date.now() - 60 * 60 * 1000);

  try {
    const result = await executeAuthSQL(
      `DELETE FROM public.auth_codes
       WHERE expires_at < $1 OR (consumed_at IS NOT NULL AND consumed_at < $1)
       RETURNING id`,
      [cutoffTime.toISOString()]
    );
    return result.data.length;
  } catch (error) {
    console.error('Failed to cleanup auth codes:', error);
    return 0;
  }
}

async function deleteUserCodes(userId) {
  try {
    const result = await executeAuthSQL(
      'DELETE FROM public.auth_codes WHERE user_id = $1 RETURNING id',
      [userId]
    );
    return result.data.length;
  } catch (error) {
    console.error('Failed to delete user codes:', error);
    return 0;
  }
}

module.exports = {
  createAuthCode,
  consumeAuthCode,
  getAuthCode,
  cleanupExpiredCodes,
  deleteUserCodes,
  CODE_EXPIRY_SECONDS
};
