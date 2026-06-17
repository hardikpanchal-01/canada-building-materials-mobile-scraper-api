const { createClient } = require('@supabase/supabase-js');

// Separate Supabase instance for notifications
const notificationSupabaseUrl = process.env.NOTIFICATION_SUPABASE_URL;
const notificationSupabaseAnonKey = process.env.NOTIFICATION_SUPABASE_ANON_KEY;

let notificationSupabase = null;

if (notificationSupabaseUrl && notificationSupabaseAnonKey) {
  notificationSupabase = createClient(notificationSupabaseUrl, notificationSupabaseAnonKey);
} else {
  console.warn('Notification Supabase credentials not configured. Set NOTIFICATION_SUPABASE_URL and NOTIFICATION_SUPABASE_ANON_KEY in .env');
}

function getNotificationSupabase() {
  if (!notificationSupabase) {
    throw new Error('Notification Supabase is not configured. Please set NOTIFICATION_SUPABASE_URL and NOTIFICATION_SUPABASE_ANON_KEY in your .env file.');
  }
  return notificationSupabase;
}

module.exports = {
  getNotificationSupabase
};
