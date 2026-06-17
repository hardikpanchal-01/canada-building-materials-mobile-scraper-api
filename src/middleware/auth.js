const { verifyAccessToken } = require('../utils/jwtUtils');
const { executeDirectSQL } = require('../utils/postgresExecutor');
const { getAuthSupabaseAdmin } = require('../config/authDatabase');

// Admin role code - same as web app (/src/lib/admin-check.ts)
const ADMIN_ROLE_CODE = 'tk-admin';

// Debug logging gate
const DEBUG = process.env.LOG_LEVEL === 'debug';

// In-memory cache for user access data (5-minute TTL)
const _accessCache = new Map();
const ACCESS_CACHE_TTL_MS = 5 * 60 * 1000;

// Short-lived cache for user timezone preferences (30-second TTL for quick updates)
const _tzPrefCache = new Map();
const TZ_PREF_CACHE_TTL_MS = 30 * 1000;

// Clean up expired cache entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _accessCache) {
    if (now - entry.timestamp > ACCESS_CACHE_TTL_MS) {
      _accessCache.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

/**
 * Check if user is admin by querying user_roles -> roles
 * Same logic as web: /src/lib/admin-check.ts
 */
async function isUserAdmin(userId) {
  try {
    const sql = `
      SELECT 1
      FROM user_roles ur
      INNER JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1
        AND r.code = $2
      LIMIT 1
    `;
    const result = await executeDirectSQL(sql, [userId, ADMIN_ROLE_CODE]);
    const isAdmin = result.data && result.data.length > 0;
    if (DEBUG) console.log(`[AccessControl] isUserAdmin(${userId}): ${isAdmin}`);
    return isAdmin;
  } catch (error) {
    console.error('[AccessControl] Error checking admin status:', error.message);
    return false;
  }
}

/**
 * Get zone_names assigned to user's roles
 * Same logic as web: getZoneNamesForRole() in /src/lib/access-control.ts
 * Uses: user_roles -> roles -> role_regions
 */
async function getZoneNamesForUser(userId) {
  try {
    const sql = `
      SELECT DISTINCT rr.zone_name
      FROM user_roles ur
      INNER JOIN roles r ON r.id = ur.role_id
      INNER JOIN role_regions rr ON rr.role_id = r.id
      WHERE ur.user_id = $1
        AND r.is_active = true
        AND r.role_type IN ('region_role', 'plant_role', 'mixed_role')
        AND rr.zone_name IS NOT NULL
        AND TRIM(rr.zone_name) != ''
    `;
    const result = await executeDirectSQL(sql, [userId]);
    const zoneNames = (result.data || []).map(r => r.zone_name).filter(Boolean);
    if (DEBUG) console.log(`[AccessControl] Zone names for user ${userId}:`, zoneNames);
    return zoneNames;
  } catch (error) {
    console.error('[AccessControl] Error getting zone names:', error.message);
    return [];
  }
}

/**
 * Get plant codes for given zone names (region descriptions)
 * Same logic as web: getPlantCodesForZoneNames() in /src/lib/access-control.ts
 * Uses: regions.description -> regions.id -> plants.region_id -> plants.code
 */
async function getPlantCodesForZoneNames(zoneNames) {
  if (!zoneNames || zoneNames.length === 0) return [];

  try {
    const placeholders = zoneNames.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `
      SELECT DISTINCT p.code as plant_code
      FROM regions r
      INNER JOIN plants p ON p.region_id = r.id
      WHERE r.description IN (${placeholders})
        AND p.code IS NOT NULL
        AND TRIM(p.code) != ''
    `;
    const result = await executeDirectSQL(sql, zoneNames);
    const plantCodes = (result.data || []).map(r => r.plant_code).filter(Boolean);
    if (DEBUG) console.log(`[AccessControl] Plant codes from zones:`, plantCodes);
    return plantCodes;
  } catch (error) {
    console.error('[AccessControl] Error getting plants for zones:', error.message);
    return [];
  }
}

/**
 * Get directly assigned plant codes for user's roles
 * Same logic as web: getAllowedPlantsForRole() - direct plants part
 * Uses: user_roles -> roles -> role_plants -> plants
 */
async function getDirectPlantCodesForUser(userId) {
  try {
    const sql = `
      SELECT DISTINCT p.code as plant_code
      FROM user_roles ur
      INNER JOIN roles r ON r.id = ur.role_id
      INNER JOIN role_plants rp ON rp.role_id = r.id
      INNER JOIN plants p ON p.id = rp.plant_id
      WHERE ur.user_id = $1
        AND r.is_active = true
        AND r.role_type IN ('region_role', 'plant_role', 'mixed_role')
        AND p.code IS NOT NULL
        AND TRIM(p.code) != ''
    `;
    const result = await executeDirectSQL(sql, [userId]);
    const plantCodes = (result.data || []).map(r => r.plant_code).filter(Boolean);
    if (DEBUG) console.log(`[AccessControl] Direct plant codes for user ${userId}:`, plantCodes);
    return plantCodes;
  } catch (error) {
    console.error('[AccessControl] Error getting direct plants:', error.message);
    return [];
  }
}

/**
 * Get all allowed plant codes for user (direct + via regions)
 * Same logic as web: getAllowedPlantsForUser() in /src/lib/access-control.ts
 */
async function getAllowedPlantCodesForUser(userId) {
  // Get direct plants and zone-based plants in parallel
  const [directPlants, zoneNames] = await Promise.all([
    getDirectPlantCodesForUser(userId),
    getZoneNamesForUser(userId)
  ]);

  // Get plants from zones
  const zonePlants = await getPlantCodesForZoneNames(zoneNames);

  // Combine and deduplicate
  const allPlants = [...new Set([...directPlants, ...zonePlants])];
  if (DEBUG) console.log(`[AccessControl] All allowed plants for user ${userId}:`, allPlants);
  return { plants: allPlants, zoneNames };
}

/**
 * Get allowed customer IDs for user (contractor users)
 * Same logic as web: getAllowedCustomerIdsForUser() in /src/lib/access-control.ts
 */
async function getAllowedCustomerIdsForUser(userId) {
  try {
    const sql = `
      SELECT customer_id
      FROM user_customers
      WHERE user_id = $1
        AND customer_id IS NOT NULL
    `;
    const result = await executeDirectSQL(sql, [userId]);
    const customerIds = (result.data || []).map(row => row.customer_id);
    if (DEBUG) console.log(`[AccessControl] Customer IDs for user ${userId}:`, customerIds);
    return customerIds;
  } catch (error) {
    console.error('[AccessControl] Error loading customer IDs:', error.message);
    return [];
  }
}

/**
 * Resolve a UUID user ID to the integer ID used in tenant_users.
 * If the userId is already numeric, returns it as-is.
 */
async function resolveUserId(supabase, userId) {
  // If already a number, return directly
  if (typeof userId === 'number' || /^\d+$/.test(userId)) {
    return Number(userId);
  }

  // UUID — look up integer id from auth_tenant.users
  const { data, error } = await supabase
    .schema('auth_tenant')
    .from('users')
    .select('id')
    .eq('uuid', userId)
    .is('deleted_at', null)
    .limit(1);

  if (error || !data || data.length === 0) {
    console.log('[AccessControl] resolveUserId: could not find integer id for UUID:', userId, 'error:', error?.message);
    return null;
  }

  return data[0].id;
}

/**
 * Get tenant timezone for a user via tenant_users → tenants
 * @param {string} userId - User ID (UUID)
 * @returns {Promise<Object|null>} { iana, abbreviation } or null
 */
// Default timezone when tenant has no timezone set
const DEFAULT_TIMEZONE = { iana: 'America/Chicago' };

async function getTenantTimezoneForUser(userId) {
  try {
    const supabase = getAuthSupabaseAdmin();

    // Resolve UUID to integer user ID if needed
    const numericUserId = await resolveUserId(supabase, userId);
    if (!numericUserId) return DEFAULT_TIMEZONE;

    // Step 1: Get tenant_id from tenant_users
    const { data: tuData, error: tuError } = await supabase
      .schema('auth_tenant')
      .from('tenant_users')
      .select('tenant_id')
      .eq('user_id', numericUserId)
      .eq('status', 'active')
      .limit(1);

    if (tuError || !tuData || tuData.length === 0) {
      return DEFAULT_TIMEZONE;
    }

    // Step 2: Get timezone from tenants
    const { data: tData, error: tError } = await supabase
      .schema('auth_tenant')
      .from('tenants')
      .select('timezone')
      .eq('id', tuData[0].tenant_id)
      .is('deleted_at', null)
      .limit(1);

    if (tError || !tData || tData.length === 0) {
      return DEFAULT_TIMEZONE;
    }

    if (tData[0].timezone) {
      const tz = tData[0].timezone;
      // Support both { iana: "America/Chicago" } and plain string "America/Chicago"
      const iana = typeof tz === 'string' ? tz : (tz.iana || null);
      return iana ? { iana } : DEFAULT_TIMEZONE;
    }
    // Tenant found but no timezone set — use default
    return DEFAULT_TIMEZONE;
  } catch (error) {
    if (DEBUG) console.log(`[AccessControl] Error getting tenant timezone:`, error.message);
    return DEFAULT_TIMEZONE;
  }
}

/**
 * Check tenant setting show_region for a user
 * @param {string} userId - User ID (UUID)
 * @returns {Promise<boolean>} true if regions should be shown, false otherwise
 */
async function getTenantShowRegionForUser(userId) {
  try {
    const supabase = getAuthSupabaseAdmin();

    // Resolve UUID to integer user ID if needed
    const numericUserId = await resolveUserId(supabase, userId);
    if (!numericUserId) return false;

    // Step 1: Get tenant_id from tenant_users
    const { data: tuData, error: tuError } = await supabase
      .schema('auth_tenant')
      .from('tenant_users')
      .select('tenant_id')
      .eq('user_id', numericUserId)
      .eq('status', 'active')
      .limit(1);

    if (tuError || !tuData || tuData.length === 0) {
      console.log('[AccessControl] show_regions: no tenant_user found for userId:', userId, 'error:', tuError?.message);
      return false;
    }

    console.log('[AccessControl] show_regions: found tenant_id:', tuData[0].tenant_id, 'for userId:', userId);

    // Step 2: Get show_regions from tenants
    const { data: tData, error: tError } = await supabase
      .schema('auth_tenant')
      .from('tenants')
      .select('show_regions')
      .eq('id', tuData[0].tenant_id)
      .is('deleted_at', null)
      .limit(1);

    if (tError || !tData || tData.length === 0) {
      console.log('[AccessControl] show_regions: no tenant found for tenant_id:', tuData[0].tenant_id, 'error:', tError?.message);
      return false;
    }

    console.log('[AccessControl] show_regions raw value:', tData[0].show_regions, 'type:', typeof tData[0].show_regions);
    return tData[0].show_regions === true;
  } catch (error) {
    console.error('[AccessControl] Error checking show_regions:', error.message);
    return false;
  }
}

/**
 * Get user's assigned role name from user_roles -> roles (single optimized query)
 * @param {string} userId - User UUID
 * @returns {string|null} Role name or null if no role assigned
 */
async function getUserRole(userId) {
  try {
    const sql = `
      SELECT r.name, r.role_type
      FROM user_roles ur
      INNER JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1
        AND r.is_active = true
      LIMIT 1
    `;
    const result = await executeDirectSQL(sql, [userId]);
    if (result.data && result.data.length > 0) {
      return { name: result.data[0].name, roleType: result.data[0].role_type };
    }
    return { name: null, roleType: null };
  } catch (error) {
    console.error('[AccessControl] Error getting user role:', error.message);
    return { name: null, roleType: null };
  }
}

/**
 * Get allowed project codes for user (from user_projects → projects)
 * Same logic as web: getAllowedProjectCodesForUser() in /src/lib/access-control.ts
 */
async function getAllowedProjectCodesForUser(userId) {
  try {
    const sql = `
      SELECT DISTINCT p.code as project_code
      FROM user_projects up
      INNER JOIN projects p ON p.id = up.project_id
      WHERE up.user_id = $1
        AND p.code IS NOT NULL
        AND TRIM(p.code) != ''
    `;
    const result = await executeDirectSQL(sql, [userId]);
    const projectCodes = (result.data || []).map(r => r.project_code).filter(Boolean);
    if (DEBUG) console.log(`[AccessControl] Project codes for user ${userId}:`, projectCodes);
    return projectCodes;
  } catch (error) {
    console.error('[AccessControl] Error loading project codes:', error.message);
    return [];
  }
}

// Cache for central auth UUID → public.users UUID mapping (avoids repeated lookups)
const _userIdMappingCache = new Map();

/**
 * Resolve the effective user ID for role/access queries.
 * Central auth (mobile login) may assign a different UUID than what's stored in public.users.
 * user_roles and user_customers reference public.users.id, so we need the old UUID for those queries.
 */
async function resolveEffectiveUserId(userId, userEmail) {
  // Check mapping cache first (no TTL — mapping never changes)
  const cached = _userIdMappingCache.get(userId);
  if (cached) return cached;

  // Single query: check if userId exists in user_roles OR user_customers, and also look up by email
  try {
    const sql = `
      SELECT
        (EXISTS(SELECT 1 FROM user_roles WHERE user_id = $1 LIMIT 1)
         OR EXISTS(SELECT 1 FROM user_customers WHERE user_id = $1 LIMIT 1)) as id_exists,
        (SELECT id FROM users WHERE LOWER(email) = LOWER($2) LIMIT 1) as email_user_id
    `;
    const result = await executeDirectSQL(sql, [userId, userEmail || '']);

    if (result.data && result.data.length > 0) {
      const row = result.data[0];

      // If userId exists in roles/customers, use it directly
      if (row.id_exists) {
        _userIdMappingCache.set(userId, userId);
        return userId;
      }

      // Otherwise use the email-mapped UUID
      if (row.email_user_id && row.email_user_id !== userId) {
        console.log(`[AccessControl] Resolved user ID: ${userId} → ${row.email_user_id} (via email ${userEmail})`);
        _userIdMappingCache.set(userId, row.email_user_id);
        return row.email_user_id;
      }
    }
  } catch (e) {
    console.warn('[AccessControl] Error resolving effective user ID:', e.message);
  }

  // No mapping found — use the original userId
  _userIdMappingCache.set(userId, userId);
  return userId;
}

/**
 * Load complete user access control data
 * Same logic as web: getUserAccessContext() in /src/lib/access-control.ts
 */
async function loadUserAccessData(userId, userEmail = null) {
  // Check cache first
  const now = Date.now();
  const cached = _accessCache.get(userId);
  if (cached && (now - cached.timestamp) < ACCESS_CACHE_TTL_MS) {
    return cached.data;
  }

  console.log(`[AccessControl] Loading access data for user: ${userId}, email: ${userEmail}`);

  // Determine the effective user ID for role queries.
  // Central auth may assign a new UUID, but user_roles/user_customers still reference the old public.users UUID.
  const effectiveUserId = await resolveEffectiveUserId(userId, userEmail);
  if (effectiveUserId !== userId) {
    console.log(`[AccessControl] UUID mapped: ${userId} → ${effectiveUserId} (via email: ${userEmail})`);
  }

  // Check if admin, fetch timezone, and get user role info in parallel
  const [isAdmin, timezone, roleInfo] = await Promise.all([
    isUserAdmin(effectiveUserId),
    getTenantTimezoneForUser(userId),  // timezone uses central auth UUID → auth_tenant tables
    getUserRole(effectiveUserId)
  ]);
  const userRole = roleInfo.name;
  const roleType = roleInfo.roleType;

  if (isAdmin) {
    const accessData = {
      isAdmin: true,
      userType: 'admin',
      userRole,
      plants: [],
      zoneNames: [],
      customerIds: [],
      projectCodes: [],
      timezone
    };
    if (DEBUG) console.log(`[AccessControl] User ${userId} is ADMIN - full access`);
    _accessCache.set(userId, { data: accessData, timestamp: now });
    return accessData;
  }

  // Load plant codes, customer IDs, and project codes in parallel
  const [plantResult, customerIds, projectCodes] = await Promise.all([
    getAllowedPlantCodesForUser(effectiveUserId),
    getAllowedCustomerIdsForUser(effectiveUserId),
    getAllowedProjectCodesForUser(effectiveUserId)
  ]);

  const plantCodes = plantResult.plants;
  const zoneNames = plantResult.zoneNames;

  console.log(`[AccessControl] User ${userId} (effective: ${effectiveUserId}) → plants: [${plantCodes.join(', ')}], zones: [${zoneNames.join(', ')}], customers: ${customerIds.length}, projects: ${projectCodes.length}`);

  // Determine user type based on what permissions they have
  // Also check role_type to match web logic: role_type in (region_role, plant_role, mixed_role)
  // or role name containing "producer" → treated as producer even without plant assignments
  const isProducerByRoleType = roleType === 'region_role' || roleType === 'plant_role' || roleType === 'mixed_role';
  const isProducerByName = userRole && (userRole.toLowerCase().includes('producer') || userRole.toLowerCase().includes('concrete producer'));

  let accessData;

  // If user has plant assignments OR role_type/name indicates producer -> Producer
  if (plantCodes.length > 0 || isProducerByRoleType || isProducerByName) {
    accessData = {
      isAdmin: false,
      userType: 'producer',
      userRole,
      plants: plantCodes,
      zoneNames: zoneNames,
      customerIds: [],
      projectCodes,
      timezone
    };
    if (DEBUG) console.log(`[AccessControl] User ${userId} is PRODUCER (plants: ${plantCodes.length}, roleType: ${roleType}, roleName: ${userRole})`);
  }
  // If user has customer assignments -> Contractor
  else if (customerIds.length > 0) {
    accessData = {
      isAdmin: false,
      userType: 'contractor',
      userRole,
      plants: [],
      zoneNames: [],
      customerIds: customerIds,
      projectCodes,
      timezone
    };
    if (DEBUG) console.log(`[AccessControl] User ${userId} is CONTRACTOR with ${customerIds.length} customers`);
  }
  // No specific assignments -> no access
  else {
    accessData = {
      isAdmin: false,
      userType: 'none',
      userRole,
      plants: [],
      zoneNames: [],
      customerIds: [],
      projectCodes,
      timezone
    };
    if (DEBUG) console.log(`[AccessControl] User ${userId} has NO ACCESS`);
  }

  _accessCache.set(userId, { data: accessData, timestamp: now });
  return accessData;
}

/**
 * Invalidate access cache for a user
 */
function invalidateAccessCache(userId) {
  _accessCache.delete(userId);
}

/**
 * Clear entire access cache
 */
function clearAccessCache() {
  _accessCache.clear();
}

/**
 * Authentication middleware to protect routes
 * Verifies JWT token and attaches user with access control data to request
 */
async function authenticate(req, res, next) {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: 'No authorization header provided'
      });
    }

    // Extract token from "Bearer <token>" (scheme is case-insensitive per RFC 7235)
    const bearerMatch = authHeader.match(/^\s*Bearer\s+(.+?)\s*$/i);
    const token = bearerMatch ? bearerMatch[1] : authHeader.trim();

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No token provided'
      });
    }

    // Verify token
    let decoded;
    try {
      decoded = verifyAccessToken(token);
    } catch (error) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired token',
        error: error.message
      });
    }

    // Check if token is access token (not refresh token)
    if (decoded.type !== 'access') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token type. Please use access token.'
      });
    }

    // Load user access control data (pass email for ID resolution if user migrated from old auth)
    const accessData = await loadUserAccessData(decoded.id, decoded.email);

    // Attach user data with access control info - matching web app structure
    req.user = {
      id: decoded.id,
      email: decoded.email || '',
      phone: decoded.phone || '',
      role: decoded.role || 'authenticated',
      metadata: decoded.metadata || {},
      // Access control data
      isAdmin: accessData.isAdmin,
      userType: accessData.userType,
      userRole: accessData.userRole || null,
      allowedPlants: accessData.plants,         // Plant codes (strings)
      allowedZoneNames: accessData.zoneNames,   // Zone names for region filtering
      allowedCustomerIds: accessData.customerIds,
      allowedProjectCodes: accessData.projectCodes || [],  // Project codes (strings)
      timezone: accessData.timezone || null,      // { iana: "America/Chicago" } from tenant
      tenantTimezone: accessData.timezone || null  // Always the tenant's timezone (storage tz, not overridden)
    };

    // Allow mobile app to override timezone via X-Timezone header
    const headerTz = req.headers['x-timezone'];
    if (headerTz && typeof headerTz === 'string' && headerTz.includes('/')) {
      req.user.timezone = { iana: headerTz };
    } else {
      // Fall back to user's saved timezone preference (from PUT /api/user-preferences/timezone)
      // Mobile app saves numeric timezone ID (e.g. 2), web may save { iana: "..." }
      // Uses a 30-second cache so timezone changes take effect almost immediately
      try {
        const cachedTz = _tzPrefCache.get(decoded.id);
        if (cachedTz && (Date.now() - cachedTz.ts) < TZ_PREF_CACHE_TTL_MS) {
          if (cachedTz.iana) req.user.timezone = { iana: cachedTz.iana };
        } else {
          const { getSupabaseAdmin } = require('../config/database');
          const supabase = getSupabaseAdmin();
          const { data: prefRow } = await supabase
            .from('user_preferences')
            .select('preference_value')
            .eq('user_id', decoded.id)
            .eq('preference_key', 'timezone')
            .maybeSingle();

          let iana = null;
          const pv = prefRow?.preference_value;
          if (pv != null) {
            if (typeof pv === 'object' && (pv.iana || pv.iana_code)) {
              iana = pv.iana || pv.iana_code;
            } else if (typeof pv === 'string' && pv.includes('/')) {
              // Plain IANA string like "America/New_York"
              iana = pv;
            } else {
              // Numeric ID — look up iana_code from timezones table
              const tzId = typeof pv === 'number' ? pv : Number(pv);
              if (!isNaN(tzId)) {
                const { data: tzRow } = await supabase
                  .from('timezones')
                  .select('iana_code')
                  .eq('id', tzId)
                  .maybeSingle();
                if (tzRow?.iana_code) iana = tzRow.iana_code;
              }
            }
          }
          _tzPrefCache.set(decoded.id, { iana, ts: Date.now() });
          if (iana) req.user.timezone = { iana };
        }
      } catch (_) {
        // Ignore — keep tenant timezone
      }
    }

    // Attach token to request for potential use
    req.token = token;

    next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Authentication error',
      error: error.message
    });
  }
}

/**
 * Optional middleware to check user roles
 * @param {Array} allowedRoles - Array of allowed roles
 */
function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions'
      });
    }

    next();
  };
}

/**
 * Authorization middleware to restrict actions to admin and producer users only.
 * Used for order request management (accept/reject/update).
 */
function authorizeOrderManagement(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: 'User not authenticated'
    });
  }

  if (req.user.userType === 'contractor') {
    return res.status(403).json({
      success: false,
      message: 'Insufficient permissions. Contractors cannot manage order requests.'
    });
  }

  return next();
}

/**
 * Invalidate timezone preference cache for a user (called when timezone is saved)
 */
function invalidateTzPrefCache(userId) {
  _tzPrefCache.delete(userId);
}

module.exports = {
  authenticate,
  authorize,
  authorizeOrderManagement,
  loadUserAccessData,
  invalidateAccessCache,
  clearAccessCache,
  invalidateTzPrefCache,
  // Export for testing/debugging
  isUserAdmin,
  getAllowedPlantCodesForUser,
  getAllowedCustomerIdsForUser,
  getTenantShowRegionForUser,
  resolveEffectiveUserId
};
