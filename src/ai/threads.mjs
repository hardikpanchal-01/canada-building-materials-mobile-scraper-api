/**
 * AI Assistant chat-thread persistence (ported from the web app's
 * /api/ai/threads routes). All queries are scoped to the authenticated
 * user's id (the Supabase auth UUID carried in the backend JWT).
 */

import { supabaseServer } from './_supabase.mjs';

export async function listThreads(userId) {
  const { data, error } = await supabaseServer
    .from('ai_chat_threads')
    .select('id, title, updated_at, created_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function createThread(userId) {
  const { data, error } = await supabaseServer
    .from('ai_chat_threads')
    .insert({ user_id: userId, messages: [] })
    .select('id, title, updated_at, created_at')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function getThread(userId, id) {
  const { data, error } = await supabaseServer
    .from('ai_chat_threads')
    .select('id, title, messages, updated_at, created_at')
    .eq('id', id)
    .eq('user_id', userId)
    .single();
  if (error) {
    if (error.code === 'PGRST116') return null; // no row
    throw new Error(error.message);
  }
  return data;
}

export async function saveThread(userId, id, { messages, title }) {
  const patch = { updated_at: new Date().toISOString() };
  if (Array.isArray(messages)) patch.messages = messages;
  if (typeof title === 'string') patch.title = title;

  const { data, error } = await supabaseServer
    .from('ai_chat_threads')
    .update(patch)
    .eq('id', id)
    .eq('user_id', userId)
    .select('id, title, updated_at')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteThread(userId, id) {
  const { error } = await supabaseServer
    .from('ai_chat_threads')
    .delete()
    .eq('id', id)
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
  return { success: true };
}
