/**
 * Admin operations against this tenant's own `auth.users`.
 *
 * These used to go to a hosted auth service through the client library's
 * `auth.admin.*` surface. They are now plain SQL on the tenant database, with
 * the same method names and return shape (`{ data, error }`) so call sites did
 * not have to change.
 *
 * Passwords are hashed with bcrypt, matching how the rest of the estate stores
 * `encrypted_password`.
 */

const bcrypt = require('bcryptjs');
const { getPool } = require('../services/database/postgresClient.js');

const SELECT_COLS = `
  id, email, phone, aud, role, email_confirmed_at, last_sign_in_at,
  raw_user_meta_data, raw_app_meta_data, created_at, updated_at
`;

const ok = (data) => ({ data, error: null });
const fail = (e, status = 500) => ({
  data: null,
  error: {
    message: e instanceof Error ? e.message : String(e),
    status,
  },
});

/** Shape a row the way the previous client returned a user. */
function toUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    phone: row.phone || null,
    aud: row.aud || 'authenticated',
    role: row.role || 'authenticated',
    email_confirmed_at: row.email_confirmed_at,
    last_sign_in_at: row.last_sign_in_at,
    user_metadata: row.raw_user_meta_data || {},
    app_metadata: row.raw_app_meta_data || {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const authAdmin = {
  async listUsers({ page = 1, perPage = 1000 } = {}) {
    try {
      const { rows } = await getPool().query(
        `SELECT ${SELECT_COLS} FROM auth.users
          WHERE deleted_at IS NULL
          ORDER BY created_at DESC
          LIMIT $1 OFFSET $2`,
        [perPage, (Math.max(1, page) - 1) * perPage]
      );
      return ok({ users: rows.map(toUser), aud: 'authenticated' });
    } catch (e) {
      return fail(e);
    }
  },

  async getUserById(id) {
    try {
      const { rows } = await getPool().query(
        `SELECT ${SELECT_COLS} FROM auth.users WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [id]
      );
      if (!rows.length) return fail(new Error('User not found'), 404);
      return ok({ user: toUser(rows[0]) });
    } catch (e) {
      return fail(e);
    }
  },

  async createUser({ email, password, phone, email_confirm, user_metadata, app_metadata } = {}) {
    try {
      const hashed = password ? await bcrypt.hash(password, 10) : null;
      const { rows } = await getPool().query(
        `INSERT INTO auth.users
           (id, email, phone, encrypted_password, email_confirmed_at,
            raw_user_meta_data, raw_app_meta_data, aud, role, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, CASE WHEN $4 THEN now() ELSE NULL END,
                 $5, $6, 'authenticated', 'authenticated', now(), now())
         RETURNING ${SELECT_COLS}`,
        [
          email,
          phone || null,
          hashed,
          Boolean(email_confirm),
          JSON.stringify(user_metadata || {}),
          JSON.stringify(app_metadata || {}),
        ]
      );
      return ok({ user: toUser(rows[0]) });
    } catch (e) {
      // Surface a duplicate the way the previous client did, so the existing
      // "already registered" branches still fire.
      if (e && e.code === '23505') {
        return fail(new Error('A user with this email address has already been registered'), 422);
      }
      return fail(e);
    }
  },

  async updateUserById(id, attrs = {}) {
    try {
      const sets = [];
      const params = [];
      const push = (frag, val) => {
        params.push(val);
        sets.push(`${frag} $${params.length}`);
      };

      if (attrs.email !== undefined) push('email =', attrs.email);
      if (attrs.phone !== undefined) push('phone =', attrs.phone);
      if (attrs.password !== undefined) {
        push('encrypted_password =', await bcrypt.hash(attrs.password, 10));
      }
      if (attrs.user_metadata !== undefined) {
        push('raw_user_meta_data =', JSON.stringify(attrs.user_metadata));
      }
      if (attrs.app_metadata !== undefined) {
        push('raw_app_meta_data =', JSON.stringify(attrs.app_metadata));
      }
      if (attrs.email_confirm === true) sets.push('email_confirmed_at = now()');

      if (!sets.length) return this.getUserById(id);

      sets.push('updated_at = now()');
      params.push(id);
      const { rows } = await getPool().query(
        `UPDATE auth.users SET ${sets.join(', ')}
          WHERE id = $${params.length} AND deleted_at IS NULL
          RETURNING ${SELECT_COLS}`,
        params
      );
      if (!rows.length) return fail(new Error('User not found'), 404);
      return ok({ user: toUser(rows[0]) });
    } catch (e) {
      if (e && e.code === '23505') {
        return fail(new Error('A user with this email address has already been registered'), 422);
      }
      return fail(e);
    }
  },

  async deleteUser(id) {
    try {
      await getPool().query(
        'UPDATE auth.users SET deleted_at = now(), updated_at = now() WHERE id = $1',
        [id]
      );
      return ok({});
    } catch (e) {
      return fail(e);
    }
  },
};

module.exports = { authAdmin };
