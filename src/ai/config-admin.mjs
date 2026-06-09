/**
 * AI configuration admin layer. Backed by the consolidated `ai_settings` table
 * (via ai-settings.mjs) — the SAME store the web Profile → Truckast AI panel
 * uses, so mobile and web stay in sync. Plus token-usage analytics.
 *
 * Admin gating is enforced at the route layer via req.user.isAdmin.
 */

import { supabaseServer } from './_supabase.mjs';
import {
  getAiSettings,
  getMonthToDateTokens,
  getProviderKeyStatus,
  getTokenBankStatus,
  updateAiSettings,
} from './ai-settings.mjs';
import { MODELS, getModelDef } from './models.mjs';

/** GET payload — config + models, plus admin-only usage/keys/token-bank. Per-user. */
export async function getConfigPayload(userId, isAdmin) {
  const settings = await getAiSettings(userId);
  const payload = {
    config: {
      enabledModelIds: settings.enabledModelIds,
      defaultModelId: settings.defaultModelId,
      monthlyTokenBudget: settings.monthlyAllotment,
      budgetEnforced: settings.enforceTokenLimit,
    },
    models: MODELS,
    isAdmin: !!isAdmin,
    // Provider keys are PER-USER — every user manages (and must set) their own,
    // so the key status is returned to all users, not just admins.
    keyStatus: await getProviderKeyStatus(userId),
  };
  if (isAdmin) {
    payload.monthToDateTokens = await getMonthToDateTokens();
    payload.tokenBank = await getTokenBankStatus(userId);
  }
  return payload;
}

/** PUT — apply a config update for this user. Maps the mobile payload to ai_settings. */
export async function updateConfig(userId, body = {}) {
  const pk = body.providerKeys || {};
  const result = await updateAiSettings(userId, {
    enabledModelIds: body.enabledModelIds,
    defaultModelId: body.defaultModelId,
    monthlyAllotment: body.tokenBank ? body.tokenBank.monthlyAllotment : undefined,
    enforceTokenLimit: body.tokenBank ? body.tokenBank.enforced : undefined,
    addBonusTokens: body.addTokens,
    googleApiKey: pk.googleApiKey,
    anthropicApiKey: pk.anthropicApiKey,
    // Accept either `copilotApiKey` (current) or legacy `azureApiKey`.
    copilotApiKey: pk.copilotApiKey ?? pk.azureApiKey,
    azureResourceName: pk.azureResourceName,
    azureDeployment: pk.azureDeployment,
  });
  if (!result.success) {
    throw Object.assign(new Error(result.error || 'update failed'), { status: 400 });
  }
  const settings = await getAiSettings(userId);
  return {
    ok: true,
    config: {
      enabledModelIds: settings.enabledModelIds,
      defaultModelId: settings.defaultModelId,
      monthlyTokenBudget: settings.monthlyAllotment,
      budgetEnforced: settings.enforceTokenLimit,
    },
  };
}

/** Resolve a set of user ids to { email, name } via the auth admin API. */
async function resolveUsers(ids) {
  const map = {};
  if (ids.size === 0) return map;
  try {
    const { data } = await supabaseServer.auth.admin.listUsers({ page: 1, perPage: 1000 });
    for (const u of data?.users ?? []) {
      if (!ids.has(u.id)) continue;
      const meta = u.user_metadata ?? {};
      const name = meta.full_name || meta.name || u.email || u.id;
      map[u.id] = { email: u.email ?? '', name };
    }
  } catch {
    /* labels fall back to the id */
  }
  return map;
}

/** GET usage — token-usage analytics over a date range (full web parity). */
export async function getUsage(fromISO, toISO) {
  const to = toISO ? new Date(toISO) : new Date();
  const from = fromISO ? new Date(fromISO) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

  const { data, error } = await supabaseServer
    .from('ai_token_usage')
    .select('user_id, model_id, question, input_tokens, output_tokens, total_tokens, estimated_cost, created_at')
    .gte('created_at', from.toISOString())
    .lte('created_at', to.toISOString())
    .order('created_at', { ascending: false })
    .limit(10000);

  const rows = error ? [] : data ?? [];
  const byUserMap = new Map();
  const byModelMap = new Map();
  let totalTokens = 0;
  let totalCost = 0;
  for (const r of rows) {
    totalTokens += r.total_tokens || 0;
    totalCost += Number(r.estimated_cost) || 0;
    const uKey = r.user_id ?? 'unknown';
    const u = byUserMap.get(uKey) ?? { tokens: 0, cost: 0, queries: 0 };
    u.tokens += r.total_tokens || 0;
    u.cost += Number(r.estimated_cost) || 0;
    u.queries += 1;
    byUserMap.set(uKey, u);
    const m = byModelMap.get(r.model_id) ?? { tokens: 0, cost: 0, queries: 0 };
    m.tokens += r.total_tokens || 0;
    m.cost += Number(r.estimated_cost) || 0;
    m.queries += 1;
    byModelMap.set(r.model_id, m);
  }

  const topRaw = [...rows]
    .filter((r) => r.question)
    .sort((a, b) => (b.total_tokens || 0) - (a.total_tokens || 0))
    .slice(0, 25);

  let accessIds = [];
  try {
    const accessRes = await supabaseServer
      .from('user_app_permissions')
      .select('user_id')
      .eq('permission_code', 'ai_assistant');
    accessIds = (accessRes.data ?? []).map((r) => r.user_id);
  } catch {
    /* access list optional */
  }

  const idSet = new Set(accessIds);
  for (const k of byUserMap.keys()) if (k !== 'unknown') idSet.add(k);
  for (const q of topRaw) if (q.user_id) idSet.add(q.user_id);
  const userMap = await resolveUsers(idSet);
  const label = (id) => (id && userMap[id] ? userMap[id].name : id ? 'Unknown user' : 'Anonymous');

  const byUser = [...byUserMap.entries()]
    .map(([userId, v]) => ({
      userId: userId === 'unknown' ? null : userId,
      name: label(userId === 'unknown' ? null : userId),
      email: userMap[userId]?.email ?? '',
      ...v,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  const byModel = [...byModelMap.entries()]
    .map(([modelId, v]) => ({ modelId, label: getModelDef(modelId).label, ...v }))
    .sort((a, b) => b.tokens - a.tokens);

  const topQueries = topRaw.map((r) => ({
    question: r.question,
    modelLabel: getModelDef(r.model_id).label,
    userName: label(r.user_id),
    totalTokens: r.total_tokens || 0,
    estimatedCost: Number(r.estimated_cost) || 0,
    createdAt: r.created_at,
  }));

  const access = accessIds.map((id) => ({ userId: id, name: label(id), email: userMap[id]?.email ?? '' }));

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    totals: { tokens: totalTokens, cost: totalCost, queries: rows.length },
    byUser,
    byModel,
    topQueries,
    access,
  };
}
