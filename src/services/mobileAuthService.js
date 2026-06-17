/**
 * Mobile Federated Authentication Service
 *
 * Implements OAuth 2.0 Authorization Code Flow for multi-tenant authentication:
 * 1. Authenticate user with bcrypt password verification
 * 2. Verify user-tenant relationship
 * 3. Generate authorization code
 * 4. Exchange code for user information
 */

const { getAuthSupabaseAdmin } = require('../config/authDatabase');
const { getSupabaseAdmin } = require('../config/database');
const { createAuthCode, consumeAuthCode, CODE_EXPIRY_SECONDS } = require('./authCodeService');
const { verifyPassword, secureCompare, decryptTenantSecret } = require('../utils/encryptionUtils');
const { generateAccessToken, generateRefreshToken } = require('../utils/jwtUtils');
const deviceService = require('./deviceService');
const { loadUserAccessData } = require('../middleware/auth');

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
 * Resolve a tenant's client_secret from the database (single source of truth).
 *
 * `auth_tenant.tenants.client_secret` is stored AES-256-GCM encrypted. This is the
 * exact value the central federated login (`/api/federated-auth/login`) hands back
 * to the client (decrypted), so validating the incoming secret against it — rather
 * than against a hardcoded copy — keeps login and exchange-code in lockstep even
 * when a tenant's secret is rotated.
 *
 * @param {Object} tenant - Tenant row containing the encrypted `client_secret` column
 * @returns {string|null} Decrypted client secret, or null if missing/undecryptable
 */
function resolveTenantClientSecret(tenant) {
  if (!tenant || !tenant.client_secret) return null;
  try {
    return decryptTenantSecret(tenant.client_secret);
  } catch (err) {
    console.error('[MobileAuth] Failed to decrypt tenant client_secret:', err.message);
    return null;
  }
}

/**
 * Get user by email from auth_tenant.users
 * @param {string} email - User email
 * @returns {Object|null} User record
 */
async function getUserByEmail(email) {
  const supabase = getAuthSupabaseAdmin();
  const normalizedEmail = email.toLowerCase().trim();

  // Use .schema('auth_tenant') to explicitly specify the schema
  const { data, error } = await supabase
    .schema('auth_tenant')
    .from('users')
    .select('*')
    .eq('email', normalizedEmail)
    .is('deleted_at', null)
    .limit(1);

  if (error) {
    return null;
  }

  if (!data || data.length === 0) {
    return null;
  }

  const user = data[0];
  return user;
}

/**
 * Get user by ID from auth_tenant.users
 * @param {number} userId - User ID
 * @returns {Object|null} User record
 */
async function getUserById(userId) {
  const supabase = getAuthSupabaseAdmin();

  const { data, error } = await supabase
    .schema('auth_tenant')
    .from('users')
    .select('*')
    .eq('id', userId)
    .is('deleted_at', null)
    .limit(1);

  if (error) {
    return null;
  }

  return data && data.length > 0 ? data[0] : null;
}

/**
 * Get tenant_user record for user-tenant association
 * @param {number} userId - User ID
 * @param {number} tenantId - Tenant ID (optional - if not provided, gets user's tenant)
 * @returns {Object|null} Tenant user record with tenant details
 */
async function getTenantUser(userId, tenantId = null) {
  const supabase = getAuthSupabaseAdmin();

  let query = supabase
    .schema('auth_tenant')
    .from('tenant_users')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'active');

  if (tenantId) {
    query = query.eq('tenant_id', tenantId);
  }

  const { data, error } = await query.limit(1);

  if (error) {
    return null;
  }

  return data && data.length > 0 ? data[0] : null;
}

/**
 * Get user's tenant from tenant_users table with full tenant details
 * @param {number} userId - User ID
 * @returns {Object|null} Tenant user record with tenant info
 */
async function getUserTenantWithDetails(userId) {
  const supabase = getAuthSupabaseAdmin();

  // Get tenant_user record for this user (active status)
  const { data: tuData, error: tuError } = await supabase
    .schema('auth_tenant')
    .from('tenant_users')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'active')
    .limit(1);

  if (tuError) {
    return null;
  }

  if (!tuData || tuData.length === 0) {
    return null;
  }

  const tenantUser = tuData[0];

  // Get tenant details
  const { data: tData, error: tError } = await supabase
    .schema('auth_tenant')
    .from('tenants')
    .select('id, uuid, name, subdomain, redirect_url, client_id, client_secret, status, settings, backend_url, supabase_url, qr_enabled, qr_mode, qr_user_active, timezone')
    .eq('id', tenantUser.tenant_id)
    .is('deleted_at', null)
    .limit(1);

  if (tError) {
    return null;
  }

  if (!tData || tData.length === 0) {
    return null;
  }

  const tenant = tData[0];

  return {
    tenantUser,
    tenant
  };
}

/**
 * Record login attempt for security auditing
 * @param {Object} params - Attempt parameters
 */
async function recordLoginAttempt({ email, userId, tenantId, success, failureReason, ipAddress, userAgent }) {
  const supabase = getAuthSupabaseAdmin();

  try {
    await supabase
      .schema('auth_tenant')
      .from('login_attempts')
      .insert({
        email: email?.toLowerCase()?.trim(),
        user_id: userId || null,
        tenant_id: tenantId || null,
        success,
        failure_reason: failureReason || null,
        ip_address: ipAddress || null,
        user_agent: userAgent || null
      });
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
  const supabase = getAuthSupabaseAdmin();

  try {
    await supabase
      .schema('auth_tenant')
      .from('users')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', userId);
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
    const clientSecret = resolveTenantClientSecret(tenant);

    return {
      success: true,
      code,
      redirect_url: tenant.redirect_url,
      expires_in,
      client_secret: clientSecret,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        subdomain: tenant.subdomain
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

    if (!authCode) {
      return {
        success: false,
        error_code: ERROR_CODES.INVALID_CODE,
        message: ERROR_MESSAGES.INVALID_CODE
      };
    }

    // Step 2: Get tenant from auth code's tenant_id (with decrypted client_secret)
    const { getTenantById, getTenantByClientId } = require('./tenantService');
    const tenant = await getTenantById(authCode.tenant_id);

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

    // Step 3: Validate client_secret against the tenant's own secret stored in the DB.
    // This is the same (decrypted) value the federated login hands to the client, so
    // rotating a tenant's secret never desyncs login from exchange-code.
    const expectedSecret = resolveTenantClientSecret(tenant);

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
    const user = await getUserById(user_id);

    if (!user) {
      return {
        success: false,
        error_code: ERROR_CODES.USER_NOT_FOUND,
        message: ERROR_MESSAGES.USER_NOT_FOUND
      };
    }

    // Step 6: Get tenant_user role and load user access data (userType, userRole)
    const [tenantUser, accessData] = await Promise.all([
      getTenantUser(user_id, tenant.id),
      loadUserAccessData(user.uuid, user.email)
    ]);

    // Step 7: Build user object for JWT token generation
    const userForToken = {
      id: user.uuid,  // Use UUID as ID for consistency with existing login
      email: user.email,
      phone: user.phone_number || '',
      role: 'authenticated',
      userType: accessData.userType || 'none',
      userRole: accessData.userRole || null
    };

    // Step 8: Register/update device if device info is provided (SAME AS /api/auth/login)
    // user_devices.user_id FKs to the tenant's public.users(id), which mirrors
    // the tenant's auth.users.id — NOT the central auth_tenant.users.uuid we
    // hold in `user.uuid`. Resolve the tenant-side user id by email; skip
    // device registration if no tenant user row exists for this email.
    if (device_info) {
      try {
        const tenantSupabase = getSupabaseAdmin();
        const { data: tenantUserRows, error: tenantUserErr } = await tenantSupabase
          .from('users')
          .select('id')
          .eq('email', user.email.toLowerCase().trim())
          .limit(1);

        if (tenantUserErr) {
          console.error('⚠️  Tenant user lookup failed during exchange-code:', tenantUserErr.message);
        } else if (!tenantUserRows || tenantUserRows.length === 0) {
          console.warn(`⚠️  No tenant user row found for ${user.email}; skipping device registration`);
        } else {
          await deviceService.registerOrUpdateDevice(tenantUserRows[0].id, device_info);
        }
      } catch (deviceError) {
        // Log device registration error but don't fail login (same behavior as /api/auth/login)
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
      const tenantSupabase = getSupabaseAdmin();

      // Resolve company/tenant timezone first (always needed for company_timezone field)
      if (tenant.timezone) {
        const tenantTz = tenant.timezone;
        const ianaCode = typeof tenantTz === 'string' ? tenantTz : (tenantTz.iana || tenantTz.iana_code);
        if (ianaCode) {
          const { data: companyTzData } = await tenantSupabase
            .from('timezones')
            .select('id, iana_code, display_name, abbreviation, utc_offset, dst_offset')
            .eq('iana_code', ianaCode)
            .maybeSingle();

          if (companyTzData) {
            companyTimezone = companyTzData;
          }
        }
      }

      // Check user's saved preference first
      const { data: prefData } = await tenantSupabase
        .from('user_preferences')
        .select('preference_value')
        .eq('user_id', user.uuid)
        .eq('preference_key', 'timezone')
        .maybeSingle();

      if (prefData?.preference_value != null) {
        const pv = prefData.preference_value;
        let tzData = null;

        // Handle object format: { iana: "America/Chicago" }
        if (typeof pv === 'object' && pv.iana) {
          const { data } = await tenantSupabase
            .from('timezones')
            .select('id, iana_code, display_name, abbreviation, utc_offset, dst_offset')
            .eq('iana_code', pv.iana)
            .maybeSingle();
          tzData = data;
        }
        // Handle numeric ID format: 2
        else {
          const tzId = typeof pv === 'number' ? pv : Number(pv);
          if (!isNaN(tzId)) {
            const { data } = await tenantSupabase
              .from('timezones')
              .select('id, iana_code, display_name, abbreviation, utc_offset, dst_offset')
              .eq('id', tzId)
              .maybeSingle();
            tzData = data;
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
    // supabase_config values are returned as stored in DB (encrypted). The mobile
    // client decrypts them using the encryption key shared out-of-band.
    const supabaseConfig = {
      SUPABASE_URL: tenant.supabase_url || null,
      SUPABASE_ANON_KEY: tenant.supabase_anon_key || null,
      SUPABASE_SERVICE_ROLE_KEY: tenant.supabase_service_key || null
    };

    return {
      success: true,
      supabase_config: supabaseConfig,
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
            tenant_supabase_url: tenant.supabase_url || null,
            // Fall back to the per-tenant API host when backend_url is unset in the
            // DB — matches the admin federated-login behavior so the mobile app
            // never receives a null backend_url (which crashes normalizeBackendUrl).
            tenant_backend_url: tenant.backend_url || `https://${tenant.subdomain}-api.truckast.ai`,
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
    const supabase = getAuthSupabaseAdmin();

    // Get all active tenant_user records for this user
    const { data: tuData, error: tuError } = await supabase
      .schema('auth_tenant')
      .from('tenant_users')
      .select('tenant_id')
      .eq('user_id', userId)
      .eq('status', 'active');

    if (tuError) {
      console.error('[MobileAuth] Error fetching tenant_users:', tuError.message);
      return { success: false, error_code: ERROR_CODES.SERVER_ERROR, message: ERROR_MESSAGES.SERVER_ERROR };
    }

    if (!tuData || tuData.length === 0) {
      return { success: true, data: [] };
    }

    const tenantIds = tuData.map(tu => tu.tenant_id);

    // Get tenant details for all matching tenants
    // supabase_url / supabase_anon_key / supabase_service_key are returned as
    // stored in DB (encrypted). Mobile client decrypts with the shared key.
    const { data: tenants, error: tError } = await supabase
      .schema('auth_tenant')
      .from('tenants')
      .select('id, uuid, name, subdomain, backend_url, status, image_url, supabase_url, supabase_anon_key, supabase_service_key')
      .in('id', tenantIds)
      .is('deleted_at', null)
      .eq('status', 'active')
      .order('name', { ascending: true });

    if (tError) {
      console.error('[MobileAuth] Error fetching tenants:', tError.message);
      return { success: false, error_code: ERROR_CODES.SERVER_ERROR, message: ERROR_MESSAGES.SERVER_ERROR };
    }

    return {
      success: true,
      data: (tenants || []).map(t => ({
        id: t.id,
        uuid: t.uuid,
        name: t.name,
        subdomain: t.subdomain,
        backend_url: t.backend_url || `https://${t.subdomain}-api.truckast.ai`,
        image_url: t.image_url || null,
        supabase_config: {
          SUPABASE_URL: t.supabase_url || null,
          SUPABASE_ANON_KEY: t.supabase_anon_key || null,
          SUPABASE_SERVICE_ROLE_KEY: t.supabase_service_key || null
        }
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
    const supabase = getAuthSupabaseAdmin();

    // Step 1: Look up target tenant by subdomain
    const { data: tData, error: tError } = await supabase
      .schema('auth_tenant')
      .from('tenants')
      .select('id, uuid, name, subdomain, redirect_url, client_id, client_secret, status, backend_url, supabase_url, supabase_anon_key, supabase_service_key, qr_enabled, qr_mode, qr_user_active')
      .eq('subdomain', targetSubdomain.toLowerCase().trim())
      .is('deleted_at', null)
      .limit(1);

    if (tError || !tData || tData.length === 0) {
      return { success: false, error_code: ERROR_CODES.NO_TENANT, message: ERROR_MESSAGES.NO_TENANT };
    }

    const tenant = tData[0];

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
    const clientSecret = resolveTenantClientSecret(tenant);

    return {
      success: true,
      code,
      client_secret: clientSecret,
      expires_in,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        subdomain: tenant.subdomain,
        backend_url: tenant.backend_url || `https://${tenant.subdomain}-api.truckast.ai`
      },
      supabase_config: {
        SUPABASE_URL: tenant.supabase_url || null,
        SUPABASE_ANON_KEY: tenant.supabase_anon_key || null,
        SUPABASE_SERVICE_ROLE_KEY: tenant.supabase_service_key || null
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
