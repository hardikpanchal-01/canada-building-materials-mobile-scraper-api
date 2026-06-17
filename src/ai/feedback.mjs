/** Thumbs-up/down feedback on an AI answer (ported from /api/ai/feedback). */
import { supabaseServer } from './_supabase.mjs';

export async function recordFeedback({ auditLogId, rating, comment } = {}) {
  const id = typeof auditLogId === 'number' ? auditLogId : null;
  const r = rating === 'up' || rating === 'down' ? rating : null;
  const c = typeof comment === 'string' ? comment.slice(0, 2000) : null;
  if (id === null || r === null) {
    throw Object.assign(new Error("auditLogId (number) and rating ('up'|'down') are required"), { status: 400 });
  }
  const { error } = await supabaseServer.rpc('ai_record_feedback', {
    p_id: id,
    p_rating: r,
    p_comment: c,
  });
  if (error) {
    throw Object.assign(new Error(error.message), { status: error.code === 'P0002' ? 404 : 500 });
  }
  return { success: true };
}
