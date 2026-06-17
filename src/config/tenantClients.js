/**
 * Tenant Client Secrets Configuration
 *
 * Maps tenant subdomain to its client_secret.
 * Used by mobile app to send the correct client_secret in /exchange-code.
 *
 * Flow:
 *   1. POST /api/auth/mobile/login → response includes tenant.subdomain
 *   2. Mobile app looks up client_secret using tenant.subdomain
 *   3. POST /api/auth/mobile/exchange-code with { code, client_secret, device_info }
 */

const TENANT_CLIENTS = {
  'canada-building-materials': {
    name: 'Canada Building Materials',
    client_secret: 'feb10dbdcb00bc512e0aa932c7e1cf2f4dca0b53d4861472c4ff6e6d48297a3e'
  },
  dolese: {
    name: 'Stevenson Weir',
    client_secret: 'e96d8912fb26c684d360ed8e610fd9e7c140877299147950512e132ccf67ddb4'
  },
  hercules: {
    name: 'Hercules',
    client_secret: '7ebcc17f86e9e8552fccafc304e255b5a3d40e2ffcdbf71a50cad3e7ca25fc1b'
  },
  delta: {
    name: 'Delta Industries',
    client_secret: 'd7f63b0e451a6162bb9dcaa5d792b0585c7b32a53c07fe7c6cc80d1e6a3b4021'
  },
  concretesupply: {
    name: 'Concrete Supply',
    client_secret: 'e6f8f26cd54bfd9235cb938dae8246ab90e4fc0bca179ef797034488bf40e93c'
  },
  sunrise: {
    name: 'Sunrise',
    client_secret: 'a451eadf725f6ae16d9d41bfefbb358cfadb4a531306f2e02f598ee973a0d860'
  },
  sws: {
    name: 'StevensonWeir',
    client_secret: 'eb97e945805803d9a1090e1a0839eacf896ddcf89deac4aa606f1c060cf23070'
  }
};

/**
 * Get client_secret by tenant subdomain
 * @param {string} subdomain - Tenant subdomain (e.g., 'dolese', 'hercules')
 * @returns {string|null} Client secret or null if not found
 */
function getClientSecretBySubdomain(subdomain) {
  if (!subdomain) return null;
  const tenant = TENANT_CLIENTS[subdomain.toLowerCase().trim()];
  return tenant ? tenant.client_secret : null;
}

/**
 * Get all tenant subdomains
 * @returns {string[]} Array of tenant subdomains
 */
function getAllTenantSubdomains() {
  return Object.keys(TENANT_CLIENTS);
}

module.exports = {
  TENANT_CLIENTS,
  getClientSecretBySubdomain,
  getAllTenantSubdomains
};
