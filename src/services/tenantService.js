/**
 * Tenant Service
 *
 * Handles tenant management operations for multi-tenant authentication:
 * - Get tenant by subdomain (for mobile app configuration)
 * - Get tenant by ID with decrypted credentials
 * - Validate client credentials for code exchange
 */

const { getAuthSupabaseAdmin } = require('../config/authDatabase');
const { decrypt, secureCompare } = require('../utils/encryptionUtils');

// In-memory cache for tenant lookups by subdomain (10-minute TTL)
// Tenant config rarely changes; mobile apps call this on every login screen load.
const _tenantCache = new Map();
const TENANT_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Get tenant by subdomain (public info only)
 * Used by mobile apps to get tenant configuration before login
 * @param {string} subdomain - Tenant subdomain
 * @returns {Object|null} Tenant public configuration
 */
async function getTenantBySubdomain(subdomain) {
  const normalizedSubdomain = subdomain.toLowerCase().trim();

  // Check cache first
  const cached = _tenantCache.get(normalizedSubdomain);
  if (cached && (Date.now() - cached.timestamp) < TENANT_CACHE_TTL_MS) {
    return cached.data;
  }

  const supabase = getAuthSupabaseAdmin();

  const { data, error } = await supabase
    .schema('auth_tenant')
    .from('tenants')
    .select('id, uuid, name, subdomain, redirect_url, client_id, status, settings')
    .eq('subdomain', normalizedSubdomain)
    .is('deleted_at', null)
    .limit(1);

  if (error) {
    console.log('[TenantService] getTenantBySubdomain error:', error.message);
    return null;
  }

  if (!data || data.length === 0) {
    // Cache null results too (prevents repeated DB hits for invalid subdomains)
    _tenantCache.set(normalizedSubdomain, { data: null, timestamp: Date.now() });
    return null;
  }

  const tenant = data[0];
  const result = {
    id: tenant.id,
    uuid: tenant.uuid,
    name: tenant.name,
    subdomain: tenant.subdomain,
    redirect_url: tenant.redirect_url,
    client_id: tenant.client_id,
    status: tenant.status,
    settings: tenant.settings || {}
  };

  _tenantCache.set(normalizedSubdomain, { data: result, timestamp: Date.now() });
  return result;
}

/**
 * Get tenant by ID with full details
 * @param {number} tenantId - Tenant ID
 * @returns {Object|null} Full tenant data
 */
async function getTenantById(tenantId) {
  const supabase = getAuthSupabaseAdmin();

  const { data, error } = await supabase
    .schema('auth_tenant')
    .from('tenants')
    .select('*')
    .eq('id', tenantId)
    .is('deleted_at', null)
    .limit(1);

  if (error) {
    console.log('[TenantService] getTenantById error:', error.message);
    return null;
  }

  return data && data.length > 0 ? data[0] : null;
}

/**
 * Get tenant by client_id with decrypted credentials
 * @param {string} clientId - Tenant client_id (UUID)
 * @returns {Object|null} Tenant data with decrypted secrets
 */
async function getTenantByClientId(clientId) {
  const supabase = getAuthSupabaseAdmin();

  const { data, error } = await supabase
    .schema('auth_tenant')
    .from('tenants')
    .select('*')
    .eq('client_id', clientId)
    .is('deleted_at', null)
    .limit(1);

  if (error) {
    console.log('[TenantService] getTenantByClientId error:', error.message);
    return null;
  }

  if (!data || data.length === 0) {
    return null;
  }

  const tenant = data[0];

  // Decrypt sensitive fields
  let decryptedData = { ...tenant };

  try {
    if (tenant.client_secret) {
      decryptedData.client_secret_decrypted = decrypt(tenant.client_secret);
    }
    if (tenant.supabase_anon_key) {
      decryptedData.supabase_anon_key_decrypted = decrypt(tenant.supabase_anon_key);
    }
    if (tenant.supabase_service_key) {
      decryptedData.supabase_service_key_decrypted = decrypt(tenant.supabase_service_key);
    }
  } catch (decryptError) {
    console.error('Failed to decrypt tenant credentials:', decryptError.message);
    // Return without decrypted fields if decryption fails
  }

  return decryptedData;
}

/**
 * Validate client credentials for code exchange
 * @param {string} clientId - Tenant client_id
 * @param {string} clientSecret - Client secret to validate
 * @returns {Object} { valid: boolean, tenant: Object|null, error: string|null }
 */
async function validateClientCredentials(clientId, clientSecret) {
  console.log('[TenantService] validateClientCredentials called with clientId:', clientId);

  if (!clientId || !clientSecret) {
    console.log('[TenantService] FAIL: clientId or clientSecret is missing. clientId:', !!clientId, 'clientSecret:', !!clientSecret);
    return { valid: false, tenant: null, error: 'INVALID_CLIENT' };
  }

  const tenant = await getTenantByClientId(clientId);

  if (!tenant) {
    console.log('[TenantService] FAIL: No tenant found for client_id:', clientId);
    return { valid: false, tenant: null, error: 'INVALID_CLIENT' };
  }

  console.log('[TenantService] Tenant found:', tenant.name, '| status:', tenant.status);

  if (tenant.status !== 'active') {
    return { valid: false, tenant: null, error: 'TENANT_SUSPENDED' };
  }

  // Compare client secrets using constant-time comparison
  const storedSecret = tenant.client_secret_decrypted;

  if (!storedSecret) {
    console.error('[TenantService] FAIL: client_secret could not be decrypted for tenant:', tenant.name);
    return { valid: false, tenant: null, error: 'INVALID_CLIENT' };
  }

  console.log('[TenantService] Comparing secrets:');
  console.log('  Provided (first 10 chars):', clientSecret.substring(0, 10) + '...');
  console.log('  DB decrypted (first 10 chars):', storedSecret.substring(0, 10) + '...');
  console.log('  Provided length:', clientSecret.length, '| DB length:', storedSecret.length);

  const isValid = secureCompare(clientSecret, storedSecret);

  if (!isValid) {
    console.log('[TenantService] FAIL: Secret mismatch for tenant:', tenant.name);
    return { valid: false, tenant: null, error: 'INVALID_CLIENT' };
  }

  return {
    valid: true,
    tenant: {
      id: tenant.id,
      uuid: tenant.uuid,
      name: tenant.name,
      subdomain: tenant.subdomain,
      redirect_url: tenant.redirect_url,
      client_id: tenant.client_id,
      status: tenant.status
    },
    error: null
  };
}

/**
 * Get tenant's Supabase credentials (decrypted)
 * Used to authenticate against tenant's Supabase instance
 * @param {number} tenantId - Tenant ID
 * @returns {Object|null} Decrypted Supabase credentials
 */
async function getTenantSupabaseCredentials(tenantId) {
  const supabase = getAuthSupabaseAdmin();

  const { data, error } = await supabase
    .schema('auth_tenant')
    .from('tenants')
    .select('supabase_url, supabase_anon_key, supabase_service_key')
    .eq('id', tenantId)
    .is('deleted_at', null)
    .limit(1);

  if (error) {
    console.log('[TenantService] getTenantSupabaseCredentials error:', error.message);
    return null;
  }

  if (!data || data.length === 0) {
    return null;
  }

  const tenant = data[0];

  try {
    return {
      supabase_url: tenant.supabase_url,
      supabase_anon_key: tenant.supabase_anon_key ? decrypt(tenant.supabase_anon_key) : null,
      supabase_service_key: tenant.supabase_service_key ? decrypt(tenant.supabase_service_key) : null
    };
  } catch (decryptError) {
    console.error('Failed to decrypt tenant Supabase credentials:', decryptError.message);
    return null;
  }
}

module.exports = {
  getTenantBySubdomain,
  getTenantById,
  getTenantByClientId,
  validateClientCredentials,
  getTenantSupabaseCredentials
};
