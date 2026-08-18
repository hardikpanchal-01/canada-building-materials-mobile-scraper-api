/**
 * Data client for the AI Assistant engine (ported from the web app).
 *
 * Talks to this tenant's own Postgres through the shared query builder, so the
 * RPCs the AI engine relies on (ai_aggregate, ai_select_rows, ai_count,
 * _ai_validate_columns) and its tables (ai_chat_threads, ai_audit_log) resolve
 * against the same database the rest of the service uses.
 *
 * Server-side only.
 */

import { createRequire } from 'module';

// The builder is CommonJS and shared with the rest of the service; pull it in
// rather than maintaining a second copy.
const require = createRequire(import.meta.url);
const { getDb } = require('../config/database.js');

export const serverDb = getDb();

export default serverDb;
