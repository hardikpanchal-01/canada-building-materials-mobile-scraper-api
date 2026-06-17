/** Per-widget comments on saved dashboards (ported from /api/ai/dashboards/[id]/comments). */
import { supabaseServer } from './_supabase.mjs';

async function canReadDashboard(userId, id) {
  const { data: dash } = await supabaseServer
    .from('ai_dashboards')
    .select('user_id, is_public')
    .eq('id', id)
    .single();
  if (!dash) return false;
  if (dash.user_id === userId || dash.is_public) return true;
  const { data: share } = await supabaseServer
    .from('ai_dashboard_shares')
    .select('id')
    .eq('dashboard_id', id)
    .eq('shared_with_user_id', userId)
    .maybeSingle();
  return !!share;
}

export async function listComments(userId, id, widgetId) {
  if (!(await canReadDashboard(userId, id))) {
    throw Object.assign(new Error('Not found'), { status: 404 });
  }
  let q = supabaseServer
    .from('ai_widget_comments')
    .select('id, widget_id, user_id, body, parent_id, created_at')
    .eq('dashboard_id', id)
    .order('created_at', { ascending: true });
  if (widgetId) q = q.eq('widget_id', widgetId);
  const { data, error } = await q;
  if (error) throw Object.assign(new Error(error.message), { status: 500 });
  return { comments: data ?? [] };
}

export async function addComment(userId, id, { widgetId, body, parentId } = {}) {
  if (!(await canReadDashboard(userId, id))) {
    throw Object.assign(new Error('Not found'), { status: 404 });
  }
  if (!widgetId || !body || !body.trim()) {
    throw Object.assign(new Error('widgetId and body required'), { status: 400 });
  }
  if (body.length > 4000) throw Object.assign(new Error('body too long'), { status: 400 });
  const { data, error } = await supabaseServer
    .from('ai_widget_comments')
    .insert({
      dashboard_id: id,
      widget_id: widgetId,
      user_id: userId,
      body,
      parent_id: parentId ?? null,
    })
    .select('id, widget_id, user_id, body, parent_id, created_at')
    .single();
  if (error) throw Object.assign(new Error(error.message), { status: 500 });
  return { comment: data };
}

export async function editComment(userId, commentId, body) {
  if (!body || body.length > 4000) {
    throw Object.assign(new Error('body required (≤4000 chars)'), { status: 400 });
  }
  const { data, error } = await supabaseServer
    .from('ai_widget_comments')
    .update({ body })
    .eq('id', commentId)
    .eq('user_id', userId)
    .select('id, body, updated_at')
    .single();
  if (error) throw Object.assign(new Error(error.message), { status: 500 });
  return { comment: data };
}

export async function deleteComment(userId, commentId) {
  const { error } = await supabaseServer
    .from('ai_widget_comments')
    .delete()
    .eq('id', commentId)
    .eq('user_id', userId);
  if (error) throw Object.assign(new Error(error.message), { status: 500 });
  return { ok: true };
}
