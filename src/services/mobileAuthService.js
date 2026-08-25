/**
 * Mobile Federated Authentication Service
 *
 * Implements OAuth 2.0 Authorization Code Flow for multi-tenant authentication:
 * 1. Authenticate user with bcrypt password verification
 * 2. Verify user-tenant relationship
 * 3. Generate authorization code
 * 4. Exchange code for user information
 */

const { executeAuthSQL } = require('../config/authPostgres');
const { executeDirectSQL } = require('../utils/postgresExecutor');
const { createAuthCode, consumeAuthCode, CODE_EXPIRY_SECONDS } = require('./authCodeService');
const { verifyPassword, secureCompare } = require('../utils/encryptionUtils');
const { generateAccessToken, generateRefreshToken } = require('../utils/jwtUtils');
const deviceService = require('./deviceService');
const { loadUserAccessData } = require('../middleware/auth');
const { getClientSecretBySubdomain } = require('../config/tenantClients');
const axios = require('axios');

const AUTH_EXCHANGE_FALLBACK_URL = process.env.AUTH_EXCHANGE_FALLBACK_URL || '';

/**
 * Fallback: exchange auth code via the central auth API when the local
 * auth database (port-forwarded) is unavailable.
 * Returns { user, tenant } on success, null on failure.
 */
async function exchangeCodeViaFallback(code, client_secret) {
  if (!AUTH_EXCHANGE_FALLBACK_URL) return null;
  try {
    console.log('[ExchangeCode] Local auth DB unavailable — trying central auth API fallback');
    const resp = await axios.post(AUTH_EXCHANGE_FALLBACK_URL, { code, client_secret }, { timeout: 10000 });
    if (resp.data && resp.data.success) {
      console.log('[ExchangeCode] Central auth API fallback succeeded');
      return resp.data;
    }
    console.error('[ExchangeCode] Fallback returned:', resp.data);
    return null;
  } catch (err) {
    const msg = err.response?.data?.error || err.response?.data?.message || err.message;
    console.error('[ExchangeCode] Fallback error:', msg);
    // Forward specific error codes from the central auth API
    if (err.response?.data?.code) {
      return { success: false, error_code: err.response.data.code, message: msg };
    }
    return null;
  }
}

/**
 * Error codes for mobile auth operations
 */
const ERROR_CODES = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_INACTIVE: 'USER_INACTIVE',
  NO_TENANT: 'NO_TENANT',
  TENANT_SUSPENDED: 'TENANT_SUSPENDED',
  NO_TENANT_USER: 'NO_TENANT_USER',
  TENANT_USER_INACTIVE: 'TENANT_USER_INACTIVE',
  NO_REDIRECT_URL: 'NO_REDIRECT_URL',
  INVALID_CODE: 'INVALID_CODE',
  CODE_EXPIRED: 'CODE_EXPIRED',
  CODE_CONSUMED: 'CODE_CONSUMED',
  INVALID_CLIENT: 'INVALID_CLIENT',
  TENANT_MISMATCH: 'TENANT_MISMATCH',
  SERVER_ERROR: 'SERVER_ERROR'
};

/**
 * Error messages for each error code
 */
const ERROR_MESSAGES = {
  INVALID_REQUEST: 'Invalid request parameters',
  INVALID_CREDENTIALS: 'Invalid email or password',
  USER_NOT_FOUND: 'User not found',
  USER_INACTIVE: 'User account is inactive',
  NO_TENANT: 'Tenant not found',
  TENANT_SUSPENDED: 'Tenant account is suspended',
  NO_TENANT_USER: 'User is not associated with this tenant',
  TENANT_USER_INACTIVE: 'User membership is inactive for this tenant',
  NO_REDIRECT_URL: 'Tenant redirect URL not configured',
  INVALID_CODE: 'Invalid authorization code',
  CODE_EXPIRED: 'Authorization code has expired',
  CODE_CONSUMED: 'Authorization code has already been used',
  INVALID_CLIENT: 'Invalid client credentials',
  TENANT_MISMATCH: 'Authorization code does not match tenant',
  SERVER_ERROR: 'An unexpected error occurred'
};

/**
 * Get user by email from public.users
 * @param {string} email - User email
 * @returns {Object|null} User record
 */
async function getUserByEmail(email) {
  const normalizedEmail = email.toLowerCase().trim();

  try {
    const result = await executeAuthSQL(
      'SELECT * FROM public.users WHERE email = $1 AND deleted_at IS NULL LIMIT 1',
      [normalizedEmail]
    );
    return result.data.length > 0 ? result.data[0] : null;
  } catch (error) {
    console.error('[MobileAuth] getUserByEmail SQL error:', error.message);
    return null;
  }
}

/**
 * Get user by ID from public.users
 * @param {number} userId - User ID
 * @returns {Object|null} User record
 */
async function getUserById(userId) {
  try {
    const result = await executeAuthSQL(
      'SELECT * FROM public.users WHERE id = $1 AND deleted_at IS NULL LIMIT 1',
      [userId]
    );
    return result.data.length > 0 ? result.data[0] : null;
  } catch (error) {
    console.error('[MobileAuth] getUserById SQL error:', error.message);
    return null;
  }
}

/**
 * Get tenant_user record for user-tenant association
 * @param {number} userId - User ID
 * @param {number} tenantId - Tenant ID (optional - if not provided, gets user's tenant)
 * @returns {Object|null} Tenant user record with tenant details
 */
async function getTenantUser(userId, tenantId = null) {
  try {
    let sql = "SELECT * FROM public.tenant_users WHERE user_id = $1 AND status = 'active'";
    const params = [userId];
    if (tenantId) {
      sql += ' AND tenant_id = $2';
      params.push(tenantId);
    }
    sql += ' LIMIT 1';
    const result = await executeAuthSQL(sql, params);
    return result.data.length > 0 ? result.data[0] : null;
  } catch (error) {
    console.error('[MobileAuth] getTenantUser SQL error:', error.message);
    return null;
  }
}

/**
 * Get user's tenant from tenant_users table with full tenant details
 * @param {number} userId - User ID
 * @returns {Object|null} Tenant user record with tenant info
 */
async function getUserTenantWithDetails(userId) {
  try {
    const tuResult = await executeAuthSQL(
      "SELECT * FROM public.tenant_users WHERE user_id = $1 AND status = 'active' LIMIT 1",
      [userId]
    );
    if (tuResult.data.length === 0) {
      return null;
    }
    const tenantUser = tuResult.data[0];

    const tResult = await executeAuthSQL(
      `SELECT id, uuid, name, subdomain, redirect_url, client_id, status, settings, backend_url,
              qr_enabled, qr_mode, qr_user_active, timezone
       FROM public.tenants
       WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [tenantUser.tenant_id]
    );
    if (tResult.data.length === 0) {
      return null;
    }

    return { tenantUser, tenant: tResult.data[0] };
  } catch (error) {
    console.error('[MobileAuth] getUserTenantWithDetails SQL error:', error.message);
    return null;
  }
}

/**
 * Record login attempt for security auditing
 * @param {Object} params - Attempt parameters
 */
async function recordLoginAttempt({ email, userId, tenantId, success, failureReason, ipAddress, userAgent }) {
  try {
    await executeAuthSQL(
      `INSERT INTO public.login_attempts
         (email, user_id, tenant_id, success, failure_reason, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        email?.toLowerCase()?.trim(),
        userId || null,
        tenantId || null,
        success,
        failureReason || null,
        ipAddress || null,
        userAgent || null
      ]
    );
  } catch (error) {
    // Don't fail the login if logging fails
    console.error('Failed to record login attempt:', error);
  }
}

/**
 * Update user's last login timestamp
 * @param {number} userId - User ID
 */
async function updateLastLogin(userId) {
  try {
    await executeAuthSQL(
      'UPDATE public.users SET last_login_at = NOW() WHERE id = $1',
      [userId]
    );
  } catch (error) {
    console.error('Failed to update last login:', error);
  }
}

/**
 * Authenticate user and generate authorization code
 * Tenant is automatically determined from tenant_users table
 * @param {Object} params - Authentication parameters
 * @param {string} params.email - User email
 * @param {string} params.password - User password
 * @param {Object} params.metadata - Request metadata (ip, user_agent)
 * @returns {Object} { success, code, redirect_url, expires_in, error_code, message }
 */
async function authenticateAndGenerateCode({ email, password, metadata = {} }) {
  try {
    // Step 1: Get user by email
    const user = await getUserByEmail(email);

    if (!user) {
      await recordLoginAttempt({
        email,
        success: false,
        failureReason: ERROR_CODES.USER_NOT_FOUND,
        ipAddress: metadata.ip,
        userAgent: metadata.user_agent
      });

      return {
        success: false,
        error_code: ERROR_CODES.INVALID_CREDENTIALS,
        message: ERROR_MESSAGES.INVALID_CREDENTIALS
      };
    }

    // Step 2: Verify password with bcrypt
    const passwordValid = await verifyPassword(password, user.password_hash);

    if (!passwordValid) {
      await recordLoginAttempt({
        email,
        userId: user.id,
        success: false,
        failureReason: ERROR_CODES.INVALID_CREDENTIALS,
        ipAddress: metadata.ip,
        userAgent: metadata.user_agent
      });

      return {
        success: false,
        error_code: ERROR_CODES.INVALID_CREDENTIALS,
        message: ERROR_MESSAGES.INVALID_CREDENTIALS
      };
    }

    // Step 3: Check user is active
    if (!user.active) {
      await recordLoginAttempt({
        email,
        userId: user.id,
        success: false,
        failureReason: ERROR_CODES.USER_INACTIVE,
        ipAddress: metadata.ip,
        userAgent: metadata.user_agent
      });

      return {
        success: false,
        error_code: ERROR_CODES.USER_INACTIVE,
        message: ERROR_MESSAGES.USER_INACTIVE
      };
    }

    // Step 4: Get user's tenant from tenant_users table (automatic lookup)
    const tenantData = await getUserTenantWithDetails(user.id);

    if (!tenantData) {
      await recordLoginAttempt({
        email,
        userId: user.id,
        success: false,
        failureReason: ERROR_CODES.NO_TENANT_USER,
        ipAddress: metadata.ip,
        userAgent: metadata.user_agent
      });

      return {
        success: false,
        error_code: ERROR_CODES.NO_TENANT_USER,
        message: ERROR_MESSAGES.NO_TENANT_USER
      };
    }

    const { tenantUser, tenant } = tenantData;

    // Step 5: Verify tenant is active
    if (tenant.status !== 'active') {
      await recordLoginAttempt({
        email,
        userId: user.id,
        tenantId: tenant.id,
        success: false,
        failureReason: ERROR_CODES.TENANT_SUSPENDED,
        ipAddress: metadata.ip,
        userAgent: metadata.user_agent
      });

      return {
        success: false,
        error_code: ERROR_CODES.TENANT_SUSPENDED,
        message: ERROR_MESSAGES.TENANT_SUSPENDED
      };
    }

    // Step 6: Check redirect_url is configured
    if (!tenant.redirect_url) {
      return {
        success: false,
        error_code: ERROR_CODES.NO_REDIRECT_URL,
        message: ERROR_MESSAGES.NO_REDIRECT_URL
      };
    }

    // Step 7: Generate authorization code
    const { code, expires_in } = await createAuthCode({
      userId: user.id,
      email: user.email,
      tenantId: tenant.id
    });

    // Step 8: Record successful login and update last_login (non-blocking side effects)
    Promise.allSettled([
      recordLoginAttempt({
        email,
        userId: user.id,
        tenantId: tenant.id,
        success: true,
        ipAddress: metadata.ip,
        userAgent: metadata.user_agent
      }),
      updateLastLogin(user.id)
    ]).catch(() => {});

    // Step 9: Return success with code, redirect URL, and client_secret for exchange
    const clientSecret = getClientSecretBySubdomain(tenant.subdomain);

    return {
      success: true,
      code,
      redirect_url: tenant.redirect_url,
      expires_in,
      client_secret: clientSecret,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        subdomain: tenant.subdomain,
        backend_url: tenant.backend_url || null
      }
    };

  } catch (error) {
    console.error('Mobile auth error:', error);

    await recordLoginAttempt({
      email,
      success: false,
      failureReason: ERROR_CODES.SERVER_ERROR,
      ipAddress: metadata?.ip,
      userAgent: metadata?.user_agent
    });

    return {
      success: false,
      error_code: ERROR_CODES.SERVER_ERROR,
      message: ERROR_MESSAGES.SERVER_ERROR
    };
  }
}

/**
 * Exchange authorization code for user information
 * Server-to-server endpoint called by tenant applications
 *
 * This function mirrors the exact behavior of /api/auth/login:
 * - Same device registration logic
 * - Same token generation
 * - Same response structure
 *
 * @param {Object} params - Exchange parameters
 * @param {string} params.code - Authorization code
 * @param {string} params.client_secret - Client secret from request body (validated against tenant's own secret in DB)
 * @param {Object} params.device_info - Device information (same as /api/auth/login)
 * @param {string} params.device_info.device_token - FCM device token (required)
 * @param {string} params.device_info.device_id - Device ID (optional)
 * @param {string} params.device_info.device_type - Device type (optional: android, ios, web)
 * @param {string} params.device_info.device_name - Device name (optional)
 * @param {string} params.device_info.device_model - Device model (optional)
 * @param {string} params.device_info.os_version - OS version (optional)
 * @param {string} params.device_info.app_version - App version (optional)
 * @returns {Object} { success, user, accessToken, refreshToken, error_code, message }
 */
async function exchangeCodeForUserInfo({ code, client_secret, device_info }) {
  try {
    // Step 1: Get auth code record to find tenant_id
    const { getAuthCode } = require('./authCodeService');
    const authCode = await getAuthCode(code);

    let tenant, user, tenantUser;

    if (!authCode) {
      // Local auth DB may be unavailable — try central auth API fallback
      const fallback = await exchangeCodeViaFallback(code, client_secret);

      if (!fallback) {
        return {
          success: false,
          error_code: ERROR_CODES.INVALID_CODE,
          message: ERROR_MESSAGES.INVALID_CODE
        };
      }
      // Forward error codes from the central auth API (e.g. CODE_EXPIRED, INVALID_CLIENT)
      if (!fallback.success) {
        return {
          success: false,
          error_code: fallback.error_code || ERROR_CODES.INVALID_CODE,
          message: fallback.message || ERROR_MESSAGES.INVALID_CODE
        };
      }

      // Reconstruct tenant & user from fallback response (code already consumed by central auth)
      tenant = {
        id: fallback.tenant.tenant_id,
        uuid: fallback.tenant.uuid,
        name: fallback.tenant.name,
        subdomain: fallback.tenant.subdomain,
        status: 'active',
        redirect_url: fallback.tenant.redirect_url || null,
        client_id: fallback.tenant.client_id || null,
        backend_url: fallback.tenant.backend_url || null,
        qr_enabled: false,
        qr_mode: 'encrypted',
        qr_user_active: false,
      };
      user = {
        id: fallback.user.id,
        uuid: fallback.user.uuid,
        email: fallback.user.email,
        full_name: fallback.user.full_name || null,
        phone_number: null,
        phone_country_code: null,
        title: null,
        avatar_url: null,
        user_role: null,
        active: true,
      };
      tenantUser = { role: 'member', status: 'active' };

      // Enrich user data from tenant DB (has more profile fields than central auth API)
      try {
        const localUser = await executeDirectSQL(
          "SELECT id, email, full_name, phone, avatar_url, role FROM users WHERE email = $1 LIMIT 1",
          [user.email]
        );
        if (localUser.data.length > 0) {
          const lu = localUser.data[0];
          user.uuid = lu.id || user.uuid;
          user.full_name = lu.full_name || user.full_name;
          user.phone_number = lu.phone || user.phone_number;
          user.avatar_url = lu.avatar_url || user.avatar_url;
          user.user_role = lu.role || user.user_role;
          console.log(`[ExchangeCode] Enriched user data from tenant DB`);
        }
      } catch (_) {}

      console.log(`[ExchangeCode] Fallback resolved user=${user.email} tenant=${tenant.subdomain}`);
    } else {
      // Normal flow: local auth DB is available

      // Step 2: Get tenant from auth code's tenant_id
      const { getTenantById } = require('./tenantService');
      tenant = await getTenantById(authCode.tenant_id);

      if (!tenant) {
        return {
          success: false,
          error_code: ERROR_CODES.NO_TENANT,
          message: ERROR_MESSAGES.NO_TENANT
        };
      }

      if (tenant.status !== 'active') {
        return {
          success: false,
          error_code: ERROR_CODES.TENANT_SUSPENDED,
          message: ERROR_MESSAGES.TENANT_SUSPENDED
        };
      }

      // Step 3: Validate client_secret against tenant config
      const expectedSecret = getClientSecretBySubdomain(tenant.subdomain);

      if (!expectedSecret) {
        return {
          success: false,
          error_code: ERROR_CODES.INVALID_CLIENT,
          message: ERROR_MESSAGES.INVALID_CLIENT
        };
      }

      if (!secureCompare(client_secret, expectedSecret)) {
        return {
          success: false,
          error_code: ERROR_CODES.INVALID_CLIENT,
          message: ERROR_MESSAGES.INVALID_CLIENT
        };
      }

      // Step 4: Validate and consume authorization code
      const { valid: codeValid, user_id, email, error: codeError } = await consumeAuthCode(code, tenant.id);

      if (!codeValid) {
        return {
          success: false,
          error_code: codeError,
          message: ERROR_MESSAGES[codeError] || 'Invalid authorization code'
        };
      }

      // Step 5: Fetch user information
      user = await getUserById(user_id);

      if (!user) {
        return {
          success: false,
          error_code: ERROR_CODES.USER_NOT_FOUND,
          message: ERROR_MESSAGES.USER_NOT_FOUND
        };
      }

      // Step 6a: Get tenant_user role
      tenantUser = await getTenantUser(user_id, tenant.id);
    }

    // Step 6b: Load user access data from tenant DB
    const accessData = await loadUserAccessData(user.uuid, user.email);

    // Step 7: Build user object for JWT token generation
    const userForToken = {
      id: user.uuid,  // Use UUID as ID for consistency with existing login
      email: user.email,
      phone: user.phone_number || '',
      role: 'authenticated',
      userType: accessData.userType || 'none',
      userRole: accessData.userRole || null
    };

    // Step 8: Register/update device if device info is provided
    // Resolve the local user ID (tenant DB) since user_devices FK references the local users table.
    // The central auth UUID may differ from the local one.
    if (device_info) {
      try {
        let localUserId = user.uuid;
        try {
          const localUser = await executeDirectSQL(
            "SELECT id FROM users WHERE email = $1 LIMIT 1",
            [user.email]
          );
          if (localUser.data.length > 0) localUserId = localUser.data[0].id;
        } catch (_) {}
        await deviceService.registerOrUpdateDevice(localUserId, device_info);
      } catch (deviceError) {
        console.error('⚠️  Device registration failed during exchange-code:', deviceError.message);
      }
    }

    // Step 9: Generate JWT tokens (SAME AS /api/auth/login)
    const accessToken = generateAccessToken(userForToken);
    const refreshToken = generateRefreshToken(userForToken);

    // Step 10: Resolve user's timezone preference
    // Priority: user_preferences DB > tenant timezone > CDT default
    const CDT_DEFAULT = { id: 2, iana_code: 'America/Chicago', display_name: 'Central Time', abbreviation: 'CT', utc_offset: '-06:00', dst_offset: '-05:00' };
    let userTimezone = CDT_DEFAULT;
    let companyTimezone = null;
    try {
      const TZ_COLUMNS = 'id, iana_code, display_name, abbreviation, utc_offset, dst_offset';

      // Resolve company/tenant timezone first (always needed for company_timezone field)
      if (tenant.timezone) {
        const tenantTz = tenant.timezone;
        const ianaCode = typeof tenantTz === 'string' ? tenantTz : (tenantTz.iana || tenantTz.iana_code);
        if (ianaCode) {
          const companyTzResult = await executeDirectSQL(
            `SELECT ${TZ_COLUMNS} FROM timezones WHERE iana_code = $1 LIMIT 1`,
            [ianaCode]
          );
          if (companyTzResult.data.length > 0) {
            companyTimezone = companyTzResult.data[0];
          }
        }
      }

      // Check user's saved preference first
      const prefResult = await executeDirectSQL(
        `SELECT preference_value FROM user_preferences
         WHERE user_id = $1 AND preference_key = 'timezone' LIMIT 1`,
        [user.uuid]
      );
      const prefData = prefResult.data.length > 0 ? prefResult.data[0] : null;

      if (prefData?.preference_value != null) {
        const pv = prefData.preference_value;
        let tzData = null;

        // Handle object format: { iana: "America/Chicago" }
        if (typeof pv === 'object' && pv.iana) {
          const tzResult = await executeDirectSQL(
            `SELECT ${TZ_COLUMNS} FROM timezones WHERE iana_code = $1 LIMIT 1`,
            [pv.iana]
          );
          tzData = tzResult.data.length > 0 ? tzResult.data[0] : null;
        }
        // Handle numeric ID format: 2
        else {
          const tzId = typeof pv === 'number' ? pv : Number(pv);
          if (!isNaN(tzId)) {
            const tzResult = await executeDirectSQL(
              `SELECT ${TZ_COLUMNS} FROM timezones WHERE id = $1 LIMIT 1`,
              [tzId]
            );
            tzData = tzResult.data.length > 0 ? tzResult.data[0] : null;
          }
        }

        if (tzData) {
          userTimezone = tzData;
        }
      } else if (companyTimezone) {
        // Fall back to tenant timezone
        userTimezone = companyTimezone;
      }
    } catch (tzErr) {
      console.error('[ExchangeCode] Timezone resolution error:', tzErr.message);
      // Falls back to CDT_DEFAULT
    }

    // Step 11: Return user information in same format as existing login API
    return {
      success: true,
      user: {
        id: user.uuid,
        email: user.email,
        phone: user.phone_number || '',
        role: 'authenticated',
        userType: accessData.userType || 'none',
        userRole: accessData.userRole || null,
        metadata: {
          central_user_id: user.id,
          central_user_uuid: user.uuid,
          email_verified: true,
          full_name: user.full_name,
          phone_number: user.phone_number,
          phone_country_code: user.phone_country_code,
          title: user.title,
          avatar_url: user.avatar_url,
          user_role: user.user_role,
          active: user.active,
          tenant_role: tenantUser?.role || 'member',
          tenant_status: tenantUser?.status || 'active',
          tenant: {
            tenant_id: tenant.id,
            tenant_uuid: tenant.uuid,
            tenant_name: tenant.name,
            tenant_subdomain: tenant.subdomain,
            tenant_redirect_url: tenant.redirect_url,
            tenant_client_id: tenant.client_id,
            tenant_backend_url: tenant.backend_url || null,
            qr_enabled: tenant.qr_enabled ?? false,
            qr_mode: tenant.qr_mode || 'encrypted',
            qr_user_active: tenant.qr_user_active ?? false
          }
        }
      },
      timezone: userTimezone,
      company_timezone: companyTimezone,
      accessToken,
      refreshToken
    };

  } catch (error) {
    console.error('Code exchange error:', error);

    return {
      success: false,
      error_code: ERROR_CODES.SERVER_ERROR,
      message: ERROR_MESSAGES.SERVER_ERROR
    };
  }
}

/**
 * Get all tenants a user has access to (via tenant_users table)
 * @param {number} userId - User integer ID
 * @returns {Object} { success, data, error_code, message }
 */
async function getUserTenants(userId) {
  try {
    const result = await executeAuthSQL(
      `SELECT t.id, t.uuid, t.name, t.subdomain, t.backend_url, t.image_url
       FROM public.tenant_users tu
       JOIN public.tenants t ON t.id = tu.tenant_id
       WHERE tu.user_id = $1 AND tu.status = 'active'
         AND t.deleted_at IS NULL AND t.status = 'active'
       ORDER BY t.name ASC`,
      [userId]
    );
    return {
      success: true,
      data: result.data.map(t => ({
        id: t.id,
        uuid: t.uuid,
        name: t.name,
        subdomain: t.subdomain,
        backend_url: t.backend_url || null,
        image_url: t.image_url || null
      }))
    };
  } catch (error) {
    console.error('[MobileAuth] getUserTenants error:', error);
    return { success: false, error_code: ERROR_CODES.SERVER_ERROR, message: ERROR_MESSAGES.SERVER_ERROR };
  }
}

/**
 * Generate an auth code for switching to a different tenant.
 * The user must already be authenticated (via JWT) and have access to the target tenant.
 *
 * @param {Object} params
 * @param {number} params.userId - Central user integer ID
 * @param {string} params.email - User email
 * @param {string} params.targetSubdomain - Subdomain of the tenant to switch to
 * @returns {Object} { success, code, client_secret, tenant, error_code, message }
 */
async function generateSwitchCode({ userId, email, targetSubdomain }) {
  try {
    const tResult = await executeAuthSQL(
      `SELECT id, uuid, name, subdomain, redirect_url, client_id, status, backend_url,
              qr_enabled, qr_mode, qr_user_active
       FROM public.tenants
       WHERE subdomain = $1 AND deleted_at IS NULL LIMIT 1`,
      [targetSubdomain.toLowerCase().trim()]
    );
    if (tResult.data.length === 0) {
      return { success: false, error_code: ERROR_CODES.NO_TENANT, message: ERROR_MESSAGES.NO_TENANT };
    }
    const tenant = tResult.data[0];

    if (tenant.status !== 'active') {
      return { success: false, error_code: ERROR_CODES.TENANT_SUSPENDED, message: ERROR_MESSAGES.TENANT_SUSPENDED };
    }

    // Step 2: Verify user has access to this tenant
    const tenantUser = await getTenantUser(userId, tenant.id);

    if (!tenantUser) {
      return { success: false, error_code: ERROR_CODES.NO_TENANT_USER, message: ERROR_MESSAGES.NO_TENANT_USER };
    }

    // Step 3: Generate auth code for the target tenant
    const { code, expires_in } = await createAuthCode({
      userId,
      email: email.toLowerCase().trim(),
      tenantId: tenant.id
    });

    // Step 4: Get client secret for the target tenant
    const clientSecret = getClientSecretBySubdomain(tenant.subdomain);

    return {
      success: true,
      code,
      client_secret: clientSecret,
      expires_in,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        subdomain: tenant.subdomain,
        backend_url: tenant.backend_url || null
      }
    };
  } catch (error) {
    console.error('[MobileAuth] generateSwitchCode error:', error);
    return { success: false, error_code: ERROR_CODES.SERVER_ERROR, message: ERROR_MESSAGES.SERVER_ERROR };
  }
}

module.exports = {
  authenticateAndGenerateCode,
  exchangeCodeForUserInfo,
  getUserByEmail,
  getUserById,
  getTenantUser,
  getUserTenantWithDetails,
  getUserTenants,
  generateSwitchCode,
  recordLoginAttempt,
  ERROR_CODES,
  ERROR_MESSAGES
};
