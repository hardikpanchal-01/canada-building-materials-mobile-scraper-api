/** Dashboard sharing: per-user grants + public links (ported from /api/ai/dashboards/[id]/share + public/[token]). */
import { randomBytes } from 'node:crypto';
import { db, findUserByEmail } from './_db.mjs';

async function ownsDashboard(userId, id) {
  const { data } = await db
    .from('ai_dashboards')
    .select('id')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  return !!data;
}

export async function getShareInfo(userId, id) {
  if (!(await ownsDashboard(userId, id))) {
    throw Object.assign(new Error('Not found'), { status: 404 });
  }
  const [shares, dash] = await Promise.all([
    db
      .from('ai_dashboard_shares')
      .select('id, shared_with_user_id, permission, created_at')
      .eq('dashboard_id', id),
    db.from('ai_dashboards').select('share_token, is_public').eq('id', id).single(),
  ]);
  return {
    shares: shares.data ?? [],
    publicToken: dash.data?.share_token ?? null,
    isPublic: dash.data?.is_public ?? false,
  };
}

export async function applyShare(userId, id, body = {}) {
  if (!(await ownsDashboard(userId, id))) {
    throw Object.assign(new Error('Not found'), { status: 404 });
  }
  if (body.action === 'invite') {
    if (!body.email || !body.email.includes('@')) {
      throw Object.assign(new Error('valid email required'), { status: 400 });
    }
    const found = await findUserByEmail(body.email);
    if (!found) throw Object.assign(new Error('user not found'), { status: 404 });
    const { error } = await db
      .from('ai_dashboard_shares')
      .insert({ dashboard_id: id, shared_with_user_id: found.id, created_by: userId });
    if (error && !/duplicate/i.test(error.message)) {
      throw Object.assign(new Error(error.message), { status: 500 });
    }
    return { ok: true, sharedWithUserId: found.id };
  }
  if (body.action === 'generateLink') {
    const token = randomBytes(24).toString('base64url');
    const { error } = await db
      .from('ai_dashboards')
      .update({ share_token: token, is_public: true })
      .eq('id', id);
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return { token, isPublic: true };
  }
  if (body.action === 'revokeLink') {
    const { error } = await db
      .from('ai_dashboards')
      .update({ share_token: null, is_public: false })
      .eq('id', id);
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return { ok: true };
  }
  throw Object.assign(new Error('unknown action'), { status: 400 });
}

export async function revokeUserShare(userId, id, sharedWithUserId) {
  if (!(await ownsDashboard(userId, id))) {
    throw Object.assign(new Error('Not found'), { status: 404 });
  }
  if (!sharedWithUserId) {
    throw Object.assign(new Error('sharedWithUserId required'), { status: 400 });
  }
  const { error } = await db
    .from('ai_dashboard_shares')
    .delete()
    .eq('dashboard_id', id)
    .eq('shared_with_user_id', sharedWithUserId);
  if (error) throw Object.assign(new Error(error.message), { status: 500 });
  return { ok: true };
}

export async function getPublicDashboard(token) {
  if (!token) throw Object.assign(new Error('Not found'), { status: 404 });
  const { data, error } = await db
    .from('ai_dashboards')
    .select('id, title, layout, widgets, updated_at')
    .eq('share_token', token)
    .eq('is_public', true)
    .single();
  if (error || !data) throw Object.assign(new Error('Not found'), { status: 404 });
  return { dashboard: data };
}
