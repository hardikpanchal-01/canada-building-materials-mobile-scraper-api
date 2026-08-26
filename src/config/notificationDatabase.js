/**
 * Notification data client.
 *
 * The notification tables (notification_queue, device tokens, push logs, …) are
 * tenant data and live in the tenant's own database, so this client runs table
 * CRUD on DIRECT Postgres via the shared main pool. Only `.from()` is used on
 * this client (no rpc/auth/storage), so no gateway URL is required.
 *
 * getNotificationDb() keeps its name and `{ data, error }` contract; the 5
 * call sites are unchanged.
 */

const { makeClient } = require('../db/client');
const { getPool } = require('../services/database/postgresClient');

function getNotificationDb() {
  return makeClient({
    pool: getPool(),
    schema: 'public',
    // gateway URL kept only for completeness; notification code uses .from only
    restUrl: process.env.NOTIFICATION_SUPABASE_URL || process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
    anonKey: process.env.NOTIFICATION_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY,
  });
}

module.exports = {
  getNotificationDb,
};
