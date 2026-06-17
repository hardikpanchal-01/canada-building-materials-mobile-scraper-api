/** 2-sentence AI explanation of a hovered/tapped data cell (ported from /api/ai/explain-cell). */
import { generateText } from 'ai';
import { getModel } from './provider.mjs';
import { getProviderKeys } from './ai-settings.mjs';
import { executeTableQuery } from './query-executor.mjs';

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function cacheKey(b) {
  return JSON.stringify({
    w: b.widgetId,
    k: b.columnKey,
    v: b.columnValue,
    t: b.query.table,
    f: b.query.filters ?? [],
    a: b.aggregate ?? null,
  });
}

export async function explainCell(body = {}, userId) {
  if (!body.widgetId || !body.query?.table) {
    throw Object.assign(new Error('widgetId and query.table required'), { status: 400 });
  }
  const key = cacheKey(body);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { explanation: cached.value, cached: true };
  }

  const segmentFilter = body.aggregate?.groupBy
    ? { column: body.aggregate.groupBy, operator: 'eq', value: String(body.columnValue) }
    : null;
  const filters = [...(body.query.filters ?? []), ...(segmentFilter ? [segmentFilter] : [])];

  let sample = [];
  try {
    const { rows } = await executeTableQuery({ table: body.query.table, filters, limit: 10 });
    sample = rows;
  } catch {
    /* explain from metadata if the sample query fails */
  }

  const keys = await getProviderKeys(userId);
  const model = getModel(undefined, keys);

  const { text } = await generateText({
    model,
    system:
      'You are an analytics commentator. Given a chart cell the user hovered, explain in EXACTLY 2 sentences what this number represents and one notable detail from the underlying rows. Reference at least one concrete column value. No fluff, no opening greetings, no markdown.',
    prompt: [
      `Widget: "${body.widgetTitle}" (${body.widgetType})`,
      `Cell key: ${body.columnKey} = ${body.columnValue}`,
      body.aggregate
        ? `Aggregate: ${body.aggregate.method}${body.aggregate.valueColumn ? `(${body.aggregate.valueColumn})` : ''}${body.aggregate.groupBy ? ` grouped by ${body.aggregate.groupBy}` : ''}`
        : null,
      sample.length > 0
        ? `Sample rows (${sample.length}):\n${JSON.stringify(sample, null, 2)}`
        : 'No sample rows available.',
    ]
      .filter(Boolean)
      .join('\n'),
    providerOptions: { google: { thinkingConfig: { thinkingBudget: 512 } } },
  });

  const explanation = text.trim();
  cache.set(key, { value: explanation, expiresAt: Date.now() + CACHE_TTL_MS });
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache.entries()) if (v.expiresAt < now) cache.delete(k);
  }
  return { explanation, cached: false };
}
