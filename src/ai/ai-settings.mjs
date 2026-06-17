/**
 * Truckast AI Settings — PER-USER config, backed by the `ai_settings` table
 * (UNIQUE(user_id)). Each user has their own row holding model selection,
 * token bank, and encrypted provider keys. This matches the deployed web
 * (Profile → Truckast AI), so a key saved on web or mobile lands in the SAME
 * row for that user. Fails open to defaults; env vars are the key fallback.
 */

import { supabaseServer } from './_supabase.mjs';
import { encrypt, decrypt } from './encryption.mjs';
import { MODELS, DEFAULT_MODEL_ID } from './models.mjs';

const ALL_MODEL_IDS = MODELS.map((m) => m.id);

function currentPeriodStart() {
  const now = new Date();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${now.getUTCFullYear()}-${mm}-01`;
}

export function defaultAiSettings() {
  return {
    enabledModelIds: ALL_MODEL_IDS,
    defaultModelId: DEFAULT_MODEL_ID,
    monthlyAllotment: null,
    bonusTokens: 0,
    enforceTokenLimit: false,
    tokenPeriodStart: currentPeriodStart(),
    updatedAt: new Date().toISOString(),
  };
}

export async function getAiSettings(userId) {
  if (!userId) return defaultAiSettings();
  try {
    const { data, error } = await supabaseServer
      .from('ai_settings')
      .select(
        `enabled_model_ids, default_model_id, monthly_allotment, bonus_tokens,
         enforce_token_limit, token_period_start, updated_at`,
      )
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !data) return defaultAiSettings();
    const enabled =
      Array.isArray(data.enabled_model_ids) && data.enabled_model_ids.length > 0
        ? data.enabled_model_ids
        : ALL_MODEL_IDS;
    return {
      enabledModelIds: enabled,
      defaultModelId: data.default_model_id || DEFAULT_MODEL_ID,
      monthlyAllotment: data.monthly_allotment != null ? Number(data.monthly_allotment) : null,
      bonusTokens: Number(data.bonus_tokens) || 0,
      enforceTokenLimit: !!data.enforce_token_limit,
      tokenPeriodStart: data.token_period_start || currentPeriodStart(),
      updatedAt: data.updated_at,
    };
  } catch {
    return defaultAiSettings();
  }
}

async function readProviderKeysFromDb(userId) {
  if (!userId) return null;
  try {
    const { data, error } = await supabaseServer
      .from('ai_settings')
      .select(
        `google_api_key, anthropic_api_key, copilot_api_key,
         azure_resource_name, azure_deployment`,
      )
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !data) return null;
    return data;
  } catch {
    return null;
  }
}

function safeDecrypt(v) {
  if (!v) return undefined;
  try {
    return decrypt(v) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Effective provider credentials for a user — STRICTLY the user's own keys
 * (decrypted from their ai_settings row). No env / global fallback: each user
 * must configure their own API key for a model's provider, otherwise the chat
 * errors ("No API key configured for …"). An empty object means "no keys set".
 */
export async function getProviderKeys(userId) {
  const row = await readProviderKeysFromDb(userId);
  if (!row) return {};
  return {
    googleApiKey: safeDecrypt(row.google_api_key),
    anthropicApiKey: safeDecrypt(row.anthropic_api_key),
    copilotApiKey: safeDecrypt(row.copilot_api_key),
    azureResourceName: row.azure_resource_name || undefined,
    azureDeployment: row.azure_deployment || undefined,
  };
}

export async function getProviderKeyStatus(userId) {
  const row = await readProviderKeysFromDb(userId);
  const entry = (dbHas) => ({
    configured: dbHas,
    source: dbHas ? 'app' : null,
  });
  return {
    google: entry(!!row?.google_api_key),
    anthropic: entry(!!row?.anthropic_api_key),
    copilot: entry(!!row?.copilot_api_key),
    azureResourceName: entry(!!row?.azure_resource_name),
    azureDeployment: entry(!!row?.azure_deployment),
  };
}

/** Total tokens used since the start of the current UTC month (tenant-wide). */
export async function getMonthToDateTokens() {
  try {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const { data, error } = await supabaseServer
      .from('ai_token_usage')
      .select('total_tokens')
      .gte('created_at', monthStart);
    if (error || !data) return 0;
    return data.reduce((sum, row) => sum + (Number(row.total_tokens) || 0), 0);
  } catch {
    return 0;
  }
}

export async function getTokenBankStatus(userId) {
  const settings = await getAiSettings(userId);
  const used = await getMonthToDateTokens();
  const currentPeriod = currentPeriodStart();
  let bonusTokens = settings.bonusTokens;
  if (userId && settings.tokenPeriodStart < currentPeriod) {
    bonusTokens = 0;
    void supabaseServer
      .from('ai_settings')
      .update({ bonus_tokens: 0, token_period_start: currentPeriod })
      .eq('user_id', userId);
  }
  if (settings.monthlyAllotment == null) {
    return {
      unlimited: true,
      enforced: settings.enforceTokenLimit,
      monthlyAllotment: null,
      bonusTokens,
      startedWith: 0,
      used,
      remaining: 0,
    };
  }
  const startedWith = settings.monthlyAllotment + bonusTokens;
  return {
    unlimited: false,
    enforced: settings.enforceTokenLimit,
    monthlyAllotment: settings.monthlyAllotment,
    bonusTokens,
    startedWith,
    used,
    remaining: Math.max(0, startedWith - used),
  };
}

export async function updateAiSettings(userId, input = {}) {
  if (!userId) return { success: false, error: 'No user' };
  try {
    const updates = {};
    if (input.enabledModelIds !== undefined) {
      const validIds = new Set(MODELS.map((m) => m.id));
      const enabled = input.enabledModelIds.filter((id) => validIds.has(id));
      if (enabled.length === 0) return { success: false, error: 'At least one valid model must be enabled.' };
      updates.enabled_model_ids = enabled;
    }
    if (input.defaultModelId !== undefined) {
      const validIds = new Set(MODELS.map((m) => m.id));
      if (!validIds.has(input.defaultModelId)) return { success: false, error: 'Invalid default model.' };
      updates.default_model_id = input.defaultModelId;
    }
    if (input.monthlyAllotment !== undefined) {
      updates.monthly_allotment =
        input.monthlyAllotment === null || input.monthlyAllotment < 0 ? null : Math.floor(input.monthlyAllotment);
    }
    if (input.enforceTokenLimit !== undefined) {
      updates.enforce_token_limit = !!input.enforceTokenLimit;
    }
    if (input.addBonusTokens && input.addBonusTokens > 0) {
      const currentPeriod = currentPeriodStart();
      const { data } = await supabaseServer
        .from('ai_settings')
        .select('bonus_tokens, token_period_start')
        .eq('user_id', userId)
        .maybeSingle();
      const stale = !data?.token_period_start || String(data.token_period_start).slice(0, 10) < currentPeriod;
      const base = stale ? 0 : Number(data?.bonus_tokens) || 0;
      updates.bonus_tokens = base + Math.floor(input.addBonusTokens);
      updates.token_period_start = currentPeriod;
    }
    const setKey = (col, v, enc) => {
      if (v === undefined) return;
      updates[col] = v === null || v.trim() === '' ? null : enc ? encrypt(v.trim()) : v.trim();
    };
    setKey('google_api_key', input.googleApiKey, true);
    setKey('anthropic_api_key', input.anthropicApiKey, true);
    setKey('copilot_api_key', input.copilotApiKey, true);
    setKey('azure_resource_name', input.azureResourceName, false);
    setKey('azure_deployment', input.azureDeployment, false);

    if (Object.keys(updates).length === 0) return { success: true };

    if (updates.enabled_model_ids || updates.default_model_id) {
      const current = await getAiSettings(userId);
      const enabledForCheck = updates.enabled_model_ids ?? current.enabledModelIds;
      const defaultForCheck = updates.default_model_id ?? current.defaultModelId;
      if (!enabledForCheck.includes(defaultForCheck)) {
        return { success: false, error: 'The default model must be one of the enabled models.' };
      }
    }

    const { error } = await supabaseServer
      .from('ai_settings')
      .upsert({ user_id: userId, ...updates, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) {
      if (error.code === '23503' || /foreign key/i.test(error.message || '')) {
        return {
          success: false,
          error:
            'Your account is not fully provisioned for AI settings (auth user not found). Please contact an administrator.',
        };
      }
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export function resolveModelId(requestedId, settings) {
  const enabled = settings.enabledModelIds;
  if (requestedId && enabled.includes(requestedId)) return requestedId;
  if (enabled.includes(settings.defaultModelId)) return settings.defaultModelId;
  return enabled[0] ?? DEFAULT_MODEL_ID;
}
