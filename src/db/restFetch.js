/**
 * Thin REST clients that reproduce the exact wire behaviour of the pieces of the
 * old data-API client that are NOT plain table CRUD — database functions
 * (`.rpc`), the GoTrue auth admin surface (`.auth.*`) and object storage
 * (`.storage.*`).
 *
 * These talk to the SAME self-hosted gateway the app already points at
 * (the tenant REST/auth gateway URL), using Node's global `fetch` — so there is
 * no `@gateway/*` package involved and behaviour is byte-for-byte what it was,
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

// ---------------------------------------------------------------------------
// PostgREST executor — runs a query descriptor (the same shape queryBuilder.js
// produces) against a PostgREST gateway over HTTP, returning { data, error,
// count }. Used for the central-auth (auth_tenant) client, which reaches its
// schema through the auth gateway's JWT-scoped role rather than a direct pool.
// ---------------------------------------------------------------------------

function enc(v) {
  return encodeURIComponent(String(v));
}

// A single filter -> PostgREST query param `key=op.value` (or `or=(...)`).
function filterParam(f) {
  const neg = f.negate ? 'not.' : '';
  switch (f.op) {
    case 'eq': case 'neq': case 'gt': case 'gte': case 'lt': case 'lte':
    case 'like': case 'ilike':
      return `${enc(f.column)}=${neg}${f.op}.${enc(f.value)}`;
    case 'in': {
      const arr = Array.isArray(f.value) ? f.value : [f.value];
      const list = arr.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(',');
      return `${enc(f.column)}=${neg}in.(${enc(list)})`;
    }
    case 'is':
      return `${enc(f.column)}=${neg}is.${f.value === null ? 'null' : f.value}`;
    case 'contains':
      return `${enc(f.column)}=${neg}cs.${enc(JSON.stringify(f.value))}`;
    case 'overlaps': {
      const arr = Array.isArray(f.value) ? f.value : [f.value];
      return `${enc(f.column)}=${neg}ov.{${arr.map(enc).join(',')}}`;
    }
    case 'or':
      return `or=(${enc(String(f.value))})`;
    default:
      return '';
  }
}

function buildQueryString(d) {
  const parts = [];
  if (d.op === 'select') {
    const cols = (d.columns || '*').replace(/\s+/g, '');
    parts.push(`select=${enc(cols)}`);
  } else if (d.returning) {
    parts.push('select=*');
  }
  for (const f of d.filters) {
    const p = filterParam(f);
    if (p) parts.push(p);
  }
  for (const o of d.orders) {
    parts.push(`order=${enc(o.column)}.${o.ascending ? 'asc' : 'desc'}${o.nullsFirst ? '.nullsfirst' : '.nullslast'}`);
  }
  if (d.rangeFrom != null && d.rangeTo != null) {
    parts.push(`offset=${Math.max(0, d.rangeFrom)}`);
    parts.push(`limit=${Math.max(0, d.rangeTo - d.rangeFrom + 1)}`);
  } else if (d.limit != null) {
    parts.push(`limit=${Math.max(0, d.limit)}`);
  }
  if (d.op === 'upsert' && d.onConflict) {
    parts.push(`on_conflict=${enc(d.onConflict)}`);
  }
  return parts.join('&');
}

async function executeRest(d, cfg) {
  if (!cfg || !cfg.url) return { data: null, error: { message: 'REST url not configured' } };
  const key = cfg.serviceKey || cfg.anonKey || '';
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
  };
  if (d.schema && d.schema !== 'public') {
    headers['Accept-Profile'] = d.schema;
    headers['Content-Profile'] = d.schema;
  }

  const wantsRows = d.op === 'select' || d.returning;
  const preferBits = [];
  if (d.op === 'upsert') preferBits.push('resolution=merge-duplicates');
  if (d.op === 'upsert' && d.ignoreDuplicates) preferBits[preferBits.length - 1] = 'resolution=ignore-duplicates';
  if (wantsRows && d.op !== 'select') preferBits.push('return=representation');
  if (d.count === 'exact' || d.head) preferBits.push('count=exact');
  if (preferBits.length) headers.Prefer = preferBits.join(',');

  if (d.single === 'single' || d.single === 'maybe') {
    headers.Accept = 'application/vnd.pgrst.object+json';
  }

  let method = 'GET';
  let body;
  if (d.op === 'insert' || d.op === 'upsert') { method = 'POST'; body = JSON.stringify(d.values ?? {}); headers['Content-Type'] = 'application/json'; }
  else if (d.op === 'update') { method = 'PATCH'; body = JSON.stringify(d.values ?? {}); headers['Content-Type'] = 'application/json'; }
  else if (d.op === 'delete') { method = 'DELETE'; }

  const qs = buildQueryString(d);
  const url = `${cfg.url}/rest/v1/${d.table}${qs ? `?${qs}` : ''}`;

  try {
    const res = await fetch(url, { method, headers, body });
    // count from Content-Range: "0-9/42"
    let count = null;
    const cr = res.headers.get('content-range');
    if (cr && cr.includes('/')) {
      const total = cr.split('/')[1];
      if (total && total !== '*') count = parseInt(total, 10);
    }
    const ct = res.headers.get('content-type') || '';
    let payload = null;
    if (ct.includes('application/json')) payload = await res.json().catch(() => null);
    else { const t = await res.text().catch(() => ''); payload = t || null; }

    if (!res.ok) {
      // maybeSingle: PostgREST returns 406 when 0 rows for object accept
      if (d.single === 'maybe' && (res.status === 406 || res.status === 404)) {
        return { data: null, error: null, count };
      }
      const message = (payload && (payload.message || payload.error || payload.msg)) ||
        (typeof payload === 'string' ? payload : `Request failed with status ${res.status}`);
      return { data: null, error: { message, code: payload && payload.code, status: res.status }, count };
    }

    if (d.head) return { data: null, error: null, count };
    if (d.single === 'single') {
      return { data: payload ?? null, error: payload ? null : { message: 'No rows', code: 'PGRST116' }, count };
    }
    if (d.single === 'maybe') {
      return { data: payload ?? null, error: null, count };
    }
    return { data: payload ?? [], error: null, count };
  } catch (e) {
    return { data: null, error: { message: e.message } };
  }
}

module.exports = { makeRpc, makeAuth, makeStorage, executeRest };
