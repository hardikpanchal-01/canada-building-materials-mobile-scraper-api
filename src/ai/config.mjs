/**
 * Truckast AI runtime configuration helpers.
 *
 * Reads the `ai_config` singleton (which models are selectable, the default
 * model, and an optional monthly token budget) via the service-role client.
 *
 * Everything here FAILS OPEN: if the table is missing, unreadable, or empty we
 * return sensible defaults derived from the static MODELS list so the existing
 * AI Assistant keeps working exactly as before.
 */

import { supabaseServer } from "./_supabase.mjs";
import { decrypt } from "./encryption.mjs";
import { MODELS, DEFAULT_MODEL_ID } from "./models.mjs";

const ALL_MODEL_IDS = MODELS.map((m) => m.id);

export function defaultAiConfig() {
  return {
    enabledModelIds: ALL_MODEL_IDS,
    defaultModelId: DEFAULT_MODEL_ID,
    monthlyTokenBudget: null,
    budgetEnforced: false,
  };
}

/** Load the singleton config row. Never throws — returns defaults on any error. */
export async function getAiConfig() {
  try {
    const { data, error } = await supabaseServer
      .from("ai_config")
      .select(
        "enabled_model_ids, default_model_id, monthly_token_budget, budget_enforced",
      )
      .eq("id", 1)
      .maybeSingle();

    if (error || !data) return defaultAiConfig();

    const enabled =
      Array.isArray(data.enabled_model_ids) && data.enabled_model_ids.length > 0
        ? data.enabled_model_ids
        : ALL_MODEL_IDS;

    return {
      enabledModelIds: enabled,
      defaultModelId: data.default_model_id || DEFAULT_MODEL_ID,
      monthlyTokenBudget:
        typeof data.monthly_token_budget === "number"
          ? data.monthly_token_budget
          : data.monthly_token_budget != null
            ? Number(data.monthly_token_budget)
            : null,
      budgetEnforced: !!data.budget_enforced,
    };
  } catch {
    return defaultAiConfig();
  }
}

/**
 * Resolve the model a request should actually use. If the requested model is
 * not enabled (or not provided), fall back to the configured default, and if
 * that is somehow disabled, the first enabled model, and finally the static
 * default. Guarantees a usable, enabled model id.
 */
export function resolveModelId(
  requestedId,
  config,
) {
  const enabled = config.enabledModelIds;
  if (requestedId && enabled.includes(requestedId)) return requestedId;
  if (enabled.includes(config.defaultModelId)) return config.defaultModelId;
  return enabled[0] ?? DEFAULT_MODEL_ID;
}

// ---------------------------------------------------------------------------
// Provider API keys — resolved from the ai_provider_keys table (encrypted),
// falling back to environment variables. Fail-open to env on any error.
// ---------------------------------------------------------------------------

function envProviderKeys() {
  return {
    googleApiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || undefined,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
    azureResourceName: process.env.AZURE_OPENAI_RESOURCE_NAME || undefined,
    azureApiKey: process.env.AZURE_OPENAI_API_KEY || undefined,
    azureDeployment: process.env.AZURE_OPENAI_DEPLOYMENT || undefined,
  };
}

async function readProviderKeyRow() {
  try {
    const { data, error } = await supabaseServer
      .from("ai_provider_keys")
      .select(
        "google_api_key, anthropic_api_key, azure_api_key, azure_resource_name, azure_deployment",
      )
      .eq("id", 1)
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
 * Resolve the effective provider credentials. App-configured values (DB,
 * decrypted) take precedence; env vars are the fallback. Never throws.
 */
export async function getProviderKeys() {
  const env = envProviderKeys();
  const row = await readProviderKeyRow();
  if (!row) return env;
  return {
    googleApiKey: safeDecrypt(row.google_api_key) ?? env.googleApiKey,
    anthropicApiKey: safeDecrypt(row.anthropic_api_key) ?? env.anthropicApiKey,
    azureApiKey: safeDecrypt(row.azure_api_key) ?? env.azureApiKey,
    azureResourceName: row.azure_resource_name || env.azureResourceName,
    azureDeployment: row.azure_deployment || env.azureDeployment,
  };
}

/**
 * Per-field credential status for the admin UI — whether each is configured
 * and whether it comes from the app (DB) or the environment. Never returns the
 * raw key values.
 */
export async function getProviderKeyStatus() {
  const env = envProviderKeys();
  const row = await readProviderKeyRow();
  const entry = (dbHas, envHas) => ({
    configured: dbHas || envHas,
    source: dbHas ? "app" : envHas ? "env" : null,
  });
  return {
    google: entry(!!row?.google_api_key, !!env.googleApiKey),
    anthropic: entry(!!row?.anthropic_api_key, !!env.anthropicApiKey),
    azureApiKey: entry(!!row?.azure_api_key, !!env.azureApiKey),
    azureResourceName: entry(!!row?.azure_resource_name, !!env.azureResourceName),
    azureDeployment: entry(!!row?.azure_deployment, !!env.azureDeployment),
  };
}

/** Total tokens used since the start of the current UTC month. 0 on error. */
export async function getMonthToDateTokens() {
  try {
    const now = new Date();
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ).toISOString();

    const { data, error } = await supabaseServer
      .from("ai_token_usage")
      .select("total_tokens")
      .gte("created_at", monthStart);

    if (error || !data) return 0;
    return data.reduce(
      (sum, row) => sum + (Number(row.total_tokens) || 0),
      0,
    );
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Token bank — recurring monthly allotment + admin top-ups, surfaced as a
// Claude-style "started with X / Y remaining" balance. Scope-aware, but only
// the 'tenant' scope is active today (see the ai_token_bank migration). To add
// per-user / per-role banks later, pass scope/scopeId through here and filter
// usage accordingly — the schema + these helpers already support it.
// ---------------------------------------------------------------------------

function currentPeriodStart() {
  const now = new Date();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${now.getUTCFullYear()}-${mm}-01`;
}

/**
 * Read the token bank for a scope (default tenant). Normalizes the monthly
 * rollover: if the stored period is older than the current month, the bonus
 * top-ups have expired — reset them to 0 and roll the period forward. Never
 * throws; returns null when there is no bank row (treated as "no limit").
 */
export async function getTokenBank(
  scope = "tenant",
  scopeId = "",
) {
  try {
    const { data, error } = await supabaseServer
      .from("ai_token_bank")
      .select(
        "scope, scope_id, monthly_allotment, bonus_tokens, enforced, period_start",
      )
      .eq("scope", scope)
      .eq("scope_id", scopeId)
      .maybeSingle();
    if (error || !data) return null;

    let bonus = Number(data.bonus_tokens) || 0;
    const periodStart = currentPeriodStart();
    const storedPeriod = data.period_start?.slice(0, 10);

    // New month → expire any bonus top-ups and roll the period forward.
    if (storedPeriod && storedPeriod < periodStart) {
      const resetBonus = bonus !== 0;
      bonus = 0;
      void supabaseServer
        .from("ai_token_bank")
        .update({
          ...(resetBonus ? { bonus_tokens: 0 } : {}),
          period_start: periodStart,
        })
        .eq("scope", scope)
        .eq("scope_id", scopeId)
        .then(({ error: e }) => {
          if (e) console.warn("[ai_token_bank] period reset failed:", e.message);
        });
    }

    return {
      scope: data.scope ?? "tenant",
      scopeId: data.scope_id ?? "",
      monthlyAllotment:
        data.monthly_allotment == null ? null : Number(data.monthly_allotment),
      bonusTokens: bonus,
      enforced: !!data.enforced,
    };
  } catch {
    return null;
  }
}

/** Computed balance for display + enforcement. Never throws. */
export async function getTokenBankStatus(
  scope = "tenant",
  scopeId = "",
) {
  const bank = await getTokenBank(scope, scopeId);
  const used = await getMonthToDateTokens();

  if (!bank || bank.monthlyAllotment == null) {
    return {
      unlimited: true,
      enforced: bank?.enforced ?? false,
      monthlyAllotment: null,
      bonusTokens: bank?.bonusTokens ?? 0,
      startedWith: 0,
      used,
      remaining: 0,
    };
  }

  const startedWith = bank.monthlyAllotment + bank.bonusTokens;
  return {
    unlimited: false,
    enforced: bank.enforced,
    monthlyAllotment: bank.monthlyAllotment,
    bonusTokens: bank.bonusTokens,
    startedWith,
    used,
    remaining: Math.max(0, startedWith - used),
  };
}
