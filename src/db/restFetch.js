/**
 * Thin REST clients that reproduce the exact wire behaviour of the pieces of the
 * old data-API client that are NOT plain table CRUD — database functions
 * (`.rpc`), the GoTrue auth admin surface (`.auth.*`) and object storage
 * (`.storage.*`).
 *
 * These talk to the SAME self-hosted gateway the app already points at
 * (the tenant REST/auth gateway URL), using Node's global `fetch` — so there is
 * no `@supabase/*` package involved and behaviour is byte-for-byte what it was,
 * while all ordinary table reads/writes run on direct Postgres (see client.js).
 *
 * Every method returns `{ data, error }` (never throws for a request error), so
 * existing call sites that check `error` keep working unchanged.
 */

async function doFetch(url, opts) {
  try {
    const res = await fetch(url, opts);
    const ct = res.headers.get('content-type') || '';
    let body = null;
    if (ct.includes('application/json')) {
      body = await res.json().catch(() => null);
    } else {
      const text = await res.text().catch(() => '');
      body = text || null;
    }
    if (!res.ok) {
      const message =
        (body && (body.message || body.error_description || body.error || body.msg)) ||
        (typeof body === 'string' ? body : `Request failed with status ${res.status}`);
      return { ok: false, status: res.status, body, error: { message, status: res.status } };
    }
    return { ok: true, status: res.status, body, error: null };
  } catch (e) {
    return { ok: false, status: 0, body: null, error: { message: e.message } };
  }
}

/**
 * @param {object} cfg { url, serviceKey, anonKey, schema }
 */
function makeRpc(cfg) {
  return async function rpc(fn, params = {}) {
    if (!cfg.url) return { data: null, error: { message: 'REST url not configured' } };
    const headers = {
      'Content-Type': 'application/json',
      apikey: cfg.serviceKey || cfg.anonKey || '',
      Authorization: `Bearer ${cfg.serviceKey || cfg.anonKey || ''}`,
    };
    if (cfg.schema && cfg.schema !== 'public') {
      headers['Content-Profile'] = cfg.schema;
      headers['Accept-Profile'] = cfg.schema;
    }
    const r = await doFetch(`${cfg.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(params || {}),
    });
    return { data: r.ok ? r.body : null, error: r.error };
  };
}

function adminHeaders(cfg) {
  return {
    'Content-Type': 'application/json',
    apikey: cfg.serviceKey || '',
    Authorization: `Bearer ${cfg.serviceKey || ''}`,
  };
}

/**
 * GoTrue auth surface. `.auth.signInWithPassword/getUser/signOut` and
 * `.auth.admin.{listUsers,createUser,updateUserById,getUserById,generateLink}`.
 */
function makeAuth(cfg) {
  const base = cfg.url ? `${cfg.url}/auth/v1` : null;

  const admin = {
    async listUsers({ page = 1, perPage = 1000 } = {}) {
      if (!base) return { data: { users: [] }, error: { message: 'auth url not configured' } };
      const r = await doFetch(`${base}/admin/users?page=${page}&per_page=${perPage}`, {
        method: 'GET',
        headers: adminHeaders(cfg),
      });
      if (!r.ok) return { data: { users: [] }, error: r.error };
      const users = Array.isArray(r.body) ? r.body : r.body && r.body.users ? r.body.users : [];
      return { data: { users, aud: r.body && r.body.aud }, error: null };
    },
    async createUser(attrs) {
      if (!base) return { data: { user: null }, error: { message: 'auth url not configured' } };
      const r = await doFetch(`${base}/admin/users`, {
        method: 'POST',
        headers: adminHeaders(cfg),
        body: JSON.stringify(attrs || {}),
      });
      return { data: { user: r.ok ? r.body : null }, error: r.error };
    },
    async updateUserById(id, attrs) {
      if (!base) return { data: { user: null }, error: { message: 'auth url not configured' } };
      const r = await doFetch(`${base}/admin/users/${id}`, {
        method: 'PUT',
        headers: adminHeaders(cfg),
        body: JSON.stringify(attrs || {}),
      });
      return { data: { user: r.ok ? r.body : null }, error: r.error };
    },
    async getUserById(id) {
      if (!base) return { data: { user: null }, error: { message: 'auth url not configured' } };
      const r = await doFetch(`${base}/admin/users/${id}`, {
        method: 'GET',
        headers: adminHeaders(cfg),
      });
      return { data: { user: r.ok ? r.body : null }, error: r.error };
    },
    async generateLink(attrs) {
      if (!base) return { data: null, error: { message: 'auth url not configured' } };
      const r = await doFetch(`${base}/admin/generate_link`, {
        method: 'POST',
        headers: adminHeaders(cfg),
        body: JSON.stringify(attrs || {}),
      });
      return { data: r.ok ? r.body : null, error: r.error };
    },
  };

  return {
    admin,
    async signInWithPassword(credentials) {
      if (!base) return { data: { user: null, session: null }, error: { message: 'auth url not configured' } };
      const key = cfg.anonKey || cfg.serviceKey || '';
      const r = await doFetch(`${base}/token?grant_type=password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
        body: JSON.stringify(credentials || {}),
      });
      if (!r.ok) return { data: { user: null, session: null }, error: r.error };
      const b = r.body || {};
      return { data: { user: b.user || null, session: b }, error: null };
    },
    async getUser(jwt) {
      if (!base) return { data: { user: null }, error: { message: 'auth url not configured' } };
      const key = cfg.anonKey || cfg.serviceKey || '';
      const token = jwt || key;
      const r = await doFetch(`${base}/user`, {
        method: 'GET',
        headers: { apikey: key, Authorization: `Bearer ${token}` },
      });
      return { data: { user: r.ok ? r.body : null }, error: r.error };
    },
    async signOut() {
      // Sessions are stateless JWTs issued by this API; there is nothing to
      // revoke server-side. Match the old client's success shape.
      return { error: null };
    },
  };
}

/**
 * Object storage surface: `.storage.from(bucket).{upload,getPublicUrl,remove}`.
 */
function makeStorage(cfg) {
  const base = cfg.url ? `${cfg.url}/storage/v1` : null;
  return {
    from(bucket) {
      return {
        async upload(path, body, options = {}) {
          if (!base) return { data: null, error: { message: 'storage url not configured' } };
          const headers = {
            apikey: cfg.serviceKey || '',
            Authorization: `Bearer ${cfg.serviceKey || ''}`,
            'x-upsert': options.upsert ? 'true' : 'false',
          };
          if (options.contentType) headers['Content-Type'] = options.contentType;
          const r = await doFetch(`${base}/object/${bucket}/${path}`, {
            method: 'POST',
            headers,
            body,
          });
          if (!r.ok) return { data: null, error: r.error };
          return { data: { path, fullPath: `${bucket}/${path}`, ...(r.body || {}) }, error: null };
        },
        getPublicUrl(path) {
          const publicUrl = base
            ? `${base}/object/public/${bucket}/${path}`
            : '';
          return { data: { publicUrl } };
        },
        async remove(paths) {
          if (!base) return { data: null, error: { message: 'storage url not configured' } };
          const r = await doFetch(`${base}/object/${bucket}`, {
            method: 'DELETE',
            headers: adminHeaders(cfg),
            body: JSON.stringify({ prefixes: Array.isArray(paths) ? paths : [paths] }),
          });
          return { data: r.ok ? r.body : null, error: r.error };
        },
      };
    },
  };
}

module.exports = { makeRpc, makeAuth, makeStorage };
