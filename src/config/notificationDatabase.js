/**
 * Notification client.
 *
 * Notifications used to live in a SEPARATE, SHARED hosted project: one database
 * serving every tenant, with rows separated only by `tenant_id`. That project is
 * retired — `notification_queue` is now an ordinary table in this tenant's own
 * Postgres database, so this is simply the main client.
 *
 * Kept as its own module so existing imports keep working.
 */

const { getDb } = require('./database.js');

function getNotificationDb() {
  return getDb();
}

module.exports = {
  getNotificationDb,
};
