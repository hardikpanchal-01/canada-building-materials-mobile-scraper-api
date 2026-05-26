/**
 * Auth Supabase Database Configuration
 *
 * Separate Supabase instance for authentication operations.
 * Uses auth_tenant schema for tenants, users, auth_codes, etc.
 */

const { createClient } = require('@supabase/supabase-js');

// Auth Supabase configuration (separate from main app database)
const authSupabaseUrl = process.env.AUTH_SUPABASE_URL;
const authSupabaseAnonKey = process.env.AUTH_SUPABASE_ANON_KEY;
const authSupabaseServiceKey = process.env.AUTH_SUPABASE_SERVICE_KEY;

let authSupabase = null; // Regular client (uses anon key, respects RLS)
let authSupabaseAdmin = null; // Admin client (uses service key, bypasses RLS)

// Initialize regular Auth Supabase client
if (authSupabaseUrl && authSupabaseAnonKey &&
    authSupabaseUrl !== 'your_auth_supabase_url' &&
    authSupabaseAnonKey !== 'your_auth_supabase_anon_key') {
  authSupabase = createClient(authSupabaseUrl, authSupabaseAnonKey, {
    db: {
      schema: 'auth_tenant'
    }
  });
} else {
  console.warn('⚠️  Auth Supabase credentials not configured. Please update your .env file with AUTH_SUPABASE_URL and AUTH_SUPABASE_ANON_KEY.');
}

// Initialize admin Auth Supabase client (with service key for admin operations)
if (authSupabaseUrl && authSupabaseServiceKey &&
    authSupabaseUrl !== 'your_auth_supabase_url' &&
    authSupabaseServiceKey !== 'your_auth_supabase_service_key') {
  authSupabaseAdmin = createClient(authSupabaseUrl, authSupabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    },
    db: {
      schema: 'auth_tenant'
    }
  });
} else if (authSupabase) {
  // Fallback to anon key if service key not available (for development)
  console.warn('⚠️  AUTH_SUPABASE_SERVICE_KEY not configured. Using anon key for admin operations (may fail with RLS).');
  authSupabaseAdmin = authSupabase;
}

/**
 * Get Auth Supabase client (regular, respects RLS)
 * @returns {Object} Supabase client for auth_tenant schema
 * @throws {Error} If not configured
 */
/**
 * Get Auth Supabase admin client (bypasses RLS)
 * @returns {Object} Supabase admin client for auth_tenant schema
 * @throws {Error} If not configured
 */
function getAuthSupabaseAdmin() {
  if (!authSupabaseAdmin) {
    console.error('[AuthDB] Auth Supabase admin client is not configured!');
    console.error('[AuthDB] AUTH_SUPABASE_URL:', process.env.AUTH_SUPABASE_URL ? 'SET' : 'NOT SET');
    console.error('[AuthDB] AUTH_SUPABASE_SERVICE_KEY:', process.env.AUTH_SUPABASE_SERVICE_KEY ? 'SET' : 'NOT SET');
    throw new Error('Auth Supabase admin client is not configured. Please set AUTH_SUPABASE_SERVICE_KEY in your .env file.');
  }
  return authSupabaseAdmin;
}

module.exports = {
  getAuthSupabaseAdmin
};
