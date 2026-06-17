/** Raw (unaggregated) rows for a widget's query (ported from /api/ai/raw-rows). */
import { executeTableQuery } from './query-executor.mjs';

export async function getRawRows({ table, filters, order, limit } = {}) {
  if (!table) throw Object.assign(new Error('table required'), { status: 400 });
  const { columns, rows } = await executeTableQuery({
    table,
    filters,
    order,
    limit: Math.min(limit ?? 100, 500),
  });
  return { columns, rows };
}
