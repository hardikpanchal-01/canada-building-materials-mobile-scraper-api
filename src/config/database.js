const { createClient } = require('@supabase/supabase-js');

// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

let supabase = null; // Regular client (uses anon key, respects RLS)
let supabaseAdmin = null; // Admin client (uses service key, bypasses RLS)

// Initialize regular Supabase client (with anon key)
if (supabaseUrl && supabaseAnonKey && 
    supabaseUrl !== 'your_supabase_project_url' && 
    supabaseAnonKey !== 'your_supabase_anon_key') {
  supabase = createClient(supabaseUrl, supabaseAnonKey);
} else {
  console.warn('⚠️  Supabase credentials not configured. Please update your .env file with your Supabase URL and API key.');
}

// Initialize admin Supabase client (with service key for admin operations)
if (supabaseUrl && supabaseServiceKey && 
    supabaseUrl !== 'your_supabase_project_url' && 
    supabaseServiceKey !== 'your_supabase_service_key') {
  supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
} else if (supabaseUrl && supabaseAnonKey) {
  // Fallback to anon key if service key not available (for development)
  console.warn('⚠️  SUPABASE_SERVICE_KEY not configured. Using anon key for admin operations (may fail with RLS).');
  supabaseAdmin = supabase;
}

// Export a function that ensures Supabase is initialized
function getSupabase() {
  if (!supabase) {
    throw new Error('Supabase is not configured. Please set SUPABASE_URL and SUPABASE_ANON_KEY in your .env file.');
  }
  return supabase;
}

// Export admin client for operations that need to bypass RLS
function getSupabaseAdmin() {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin client is not configured. Please set SUPABASE_SERVICE_KEY in your .env file for admin operations.');
  }
  return supabaseAdmin;
}

module.exports = {
  getSupabase,
  getSupabaseAdmin
};


