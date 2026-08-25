/**
 * Tenant Service
 *
 * Handles tenant management operations for multi-tenant authentication:
 * - Get tenant by subdomain (for mobile app configuration)
 * - Get tenant by ID with decrypted credentials
 * - Validate client credentials for code exchange
 */

const { executeAuthSQL } = require('../config/authPostgres');
const { decrypt, secureCompare } = require('../utils/encryptionUtils');

/**
 * Query public.tenants directly in PostgreSQL.
 * @param {string} columns - Column list ('*' or comma-separated)
 * @param {string} whereColumn - Column for the equality filter
 * @param {*} value - Filter value
 * @returns {{row: Object|null, error: Error|null}} Distinguishes "not found" from query failure
 */
async function fetchTenantRowSQL(columns, whereColumn, value) {
  try {
    const result = await executeAuthSQL(
      `SELECT ${columns} FROM public.tenants
       WHERE ${whereColumn} = $1 AND deleted_at IS NULL LIMIT 1`,
      [value]
    );
    return { row: result.data.length > 0 ? result.data[0] : null, error: null };
  } catch (error) {
    return { row: null, error };
  }
}

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

  const { row, error } = await fetchTenantRowSQL(
    'id, uuid, name, subdomain, redirect_url, client_id, status, settings',
    'subdomain', normalizedSubdomain
  );

  if (error) {
    console.log('[TenantService] getTenantBySubdomain error:', error.message);
    return null;
  }

  if (!row) {
    // Cache null results too (prevents repeated DB hits for invalid subdomains)
    _tenantCache.set(normalizedSubdomain, { data: null, timestamp: Date.now() });
    return null;
  }

  const tenant = row;
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
  const { row, error } = await fetchTenantRowSQL('*', 'id', tenantId);
  if (error) {
    console.log('[TenantService] getTenantById error:', error.message);
    return null;
  }
  return row;
}

/**
 * Get tenant by client_id with decrypted credentials
 * @param {string} clientId - Tenant client_id (UUID)
 * @returns {Object|null} Tenant data with decrypted secrets
 */
async function getTenantByClientId(clientId) {
  const { row, error } = await fetchTenantRowSQL('*', 'client_id', clientId);
  if (error) {
    console.log('[TenantService] getTenantByClientId error:', error.message);
    return null;
  }
  if (!row) {
    return null;
  }

  const tenant = row;

  // Decrypt sensitive fields
  let decryptedData = { ...tenant };

  try {
    if (tenant.client_secret) {
      decryptedData.client_secret_decrypted = decrypt(tenant.client_secret);
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
 * Get tenant's credentials (decrypted)
 * Used to authenticate against tenant's instance
 * @param {number} tenantId - Tenant ID
 * @returns {Object|null} Decrypted credentials
 */
async function getTenantCredentials(tenantId) {
  const { row, error } = await fetchTenantRowSQL(
    'id',
    'id', tenantId
  );
  if (error) {
    console.log('[TenantService] getTenantCredentials error:', error.message);
    return null;
  }
  if (!row) {
    return null;
  }

  const tenant = row;

  return {};
}

module.exports = {
  getTenantBySubdomain,
  getTenantById,
  getTenantByClientId,
  validateClientCredentials,
  getTenantCredentials
};
