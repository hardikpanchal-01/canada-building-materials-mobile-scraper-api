/**
 * Saved & shared dashboards (ported from the web app's /api/ai/dashboards
 * routes). Backed by the shared Supabase tables `ai_dashboards` and
 * `ai_dashboard_shares`. All ownership is keyed by the JWT user id.
 */

import { supabaseServer } from './_supabase.mjs';

export async function listDashboards(userId) {
  const ownedRes = await supabaseServer
    .from('ai_dashboards')
    .select('id, title, thread_id, is_public, share_token, updated_at, created_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(200);
  if (ownedRes.error) throw new Error(ownedRes.error.message);

  const sharesRes = await supabaseServer
    .from('ai_dashboard_shares')
    .select('dashboard_id, ai_dashboards!inner(id, title, user_id, thread_id, updated_at, created_at)')
    .eq('shared_with_user_id', userId);
  // Sharing is optional — degrade gracefully if the table is absent.
  const shared = sharesRes.error ? [] : (sharesRes.data ?? []);

  return { owned: ownedRes.data ?? [], shared };
}

export async function saveDashboard(userId, body) {
  if (!body || !body.title || !Array.isArray(body.widgets)) {
    throw new Error('title and widgets required');
  }
  const { data, error } = await supabaseServer
    .from('ai_dashboards')
    .insert({
      user_id: userId,
      title: body.title,
      layout: body.layout ?? {},
      widgets: body.widgets,
      thread_id: body.threadId ?? null,
    })
    .select('id, title, updated_at, created_at')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function dashboardReadable(userId, dashboardId) {
  const { data: dash } = await supabaseServer
    .from('ai_dashboards')
    .select('id, user_id, is_public')
    .eq('id', dashboardId)
    .single();
  if (!dash) return false;
  if (dash.user_id === userId) return true;
  if (dash.is_public) return true;
  const { data: share } = await supabaseServer
    .from('ai_dashboard_shares')
    .select('id')
    .eq('dashboard_id', dashboardId)
    .eq('shared_with_user_id', userId)
    .maybeSingle();
  return !!share;
}

export async function getDashboard(userId, id) {
  if (!(await dashboardReadable(userId, id))) return null;
  const { data, error } = await supabaseServer
    .from('ai_dashboards')
    .select('id, user_id, title, layout, widgets, thread_id, share_token, is_public, updated_at, created_at')
    .eq('id', id)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateDashboard(userId, id, body) {
  const update = {};
  if (typeof body.title === 'string') update.title = body.title;
  if (body.layout) update.layout = body.layout;
  if (Array.isArray(body.widgets)) update.widgets = body.widgets;
  if (Object.keys(update).length === 0) throw new Error('no fields to update');

  const { data, error } = await supabaseServer
    .from('ai_dashboards')
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .select('id, title, updated_at')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteDashboard(userId, id) {
  const { error } = await supabaseServer
    .from('ai_dashboards')
    .delete()
    .eq('id', id)
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
  return { ok: true };
}
