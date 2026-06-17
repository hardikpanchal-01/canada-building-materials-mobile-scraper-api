/**
 * Widget verification (ported from the web app's /api/ai/verify-widget route).
 *
 * Re-runs the widget's aggregation, compares the total against an independent
 * COUNT(*), and flags an anomaly when the value is >2σ from a cached 30-day
 * daily baseline (ai_metric_baselines).
 */

import { createHash } from 'node:crypto';
import { supabaseServer } from './_supabase.mjs';
import { executeAggregate, executeCount } from './query-executor.mjs';
import { resolveRelativeDateRange } from './date-resolver.mjs';

const BASELINE_MAX_AGE_HOURS = 24;

function isLikelyDateFilter(f) {
  const c = (f.column || '').toLowerCase();
  return (
    c.endsWith('_date') ||
    c.endsWith('_time') ||
    c === 'created_date' ||
    c === 'updated_at'
  );
}

function metricKey(b) {
  const stripped = {
    table: b.table,
    groupBy: b.groupBy ?? null,
    method: b.method,
    valueColumn: b.valueColumn ?? null,
    nonDateFilters: (b.filters ?? []).filter((f) => !isLikelyDateFilter(f)),
  };
  return createHash('sha256').update(JSON.stringify(stripped)).digest('hex');
}

async function loadOrComputeBaseline(body) {
  if (body.method === 'avg') return null;

  const key = metricKey(body);
  const { data: cached } = await supabaseServer
    .from('ai_metric_baselines')
    .select('baseline_mean, baseline_stddev, sample_size, computed_at')
    .eq('metric_key', key)
    .maybeSingle();

  if (cached) {
    const ageHours = (Date.now() - new Date(cached.computed_at).getTime()) / 3.6e6;
    if (ageHours < BASELINE_MAX_AGE_HOURS) {
      return {
        mean: Number(cached.baseline_mean),
        stddev: Number(cached.baseline_stddev),
        sampleSize: cached.sample_size,
      };
    }
  }

  const last30 = resolveRelativeDateRange('last 30 days');
  if (!last30) return null;

  const dateColumn =
    (body.filters ?? []).find(isLikelyDateFilter)?.column ??
    (body.dateFormat ? body.groupBy : null);
  if (!dateColumn) return null;

  const baselineFilters = [
    ...(body.filters ?? []).filter((f) => !isLikelyDateFilter(f)),
    { column: dateColumn, operator: 'gte', value: last30.startDate },
    { column: dateColumn, operator: 'lt', value: last30.endDate },
  ];

  let dailyRows;
  try {
    const result = await executeAggregate({
      table: body.table,
      filters: baselineFilters,
      groupBy: dateColumn,
      method: body.method,
      valueColumn: body.valueColumn,
      dateFormat: 'date',
      sort: 'key_asc',
      limit: 60,
    });
    dailyRows = result.rows;
  } catch {
    return null;
  }

  if (!dailyRows || dailyRows.length < 7) return null;

  const values = dailyRows.map((r) => r.value);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / values.length;
  const stddev = Math.sqrt(variance);

  await supabaseServer.from('ai_metric_baselines').upsert(
    {
      metric_key: key,
      table_name: body.table,
      group_by: body.groupBy ?? null,
      method: body.method,
      value_col: body.valueColumn ?? null,
      baseline_mean: mean,
      baseline_stddev: stddev,
      sample_size: values.length,
      computed_at: new Date().toISOString(),
    },
    { onConflict: 'metric_key' },
  );

  return { mean, stddev, sampleSize: values.length };
}

export async function verifyWidget(body) {
  if (!body || !body.table || !body.method) {
    throw new Error('table and method required');
  }

  // 1. Re-run the aggregation.
  const { rows } = await executeAggregate({
    table: body.table,
    filters: body.filters,
    groupBy: body.groupBy,
    method: body.method,
    valueColumn: body.valueColumn,
    dateFormat: body.dateFormat,
    sort: body.sort,
    limit: 500,
    topN: body.topN,
  });
  const aggregatedTotal = rows.reduce((s, r) => s + r.value, 0);
  const bucketCount = rows.length;

  // 2. Ground-truth count.
  const groundTruthCount = await executeCount({
    table: body.table,
    filters: body.filters,
  });

  // 3. Divergence (count method only).
  let divergenceRatio = 0;
  let diverges = false;
  if (body.method === 'count') {
    divergenceRatio =
      Math.abs(aggregatedTotal - groundTruthCount) / Math.max(groundTruthCount, 1);
    diverges = divergenceRatio > 0.01;
  }

  // 4. Anomaly — z-score vs 30-day baseline.
  let zScore = null;
  let baselineMean = null;
  let baselineStddev = null;
  let isAnomaly = false;
  const baseline = await loadOrComputeBaseline(body);
  if (baseline && baseline.stddev > 0) {
    baselineMean = baseline.mean;
    baselineStddev = baseline.stddev;
    zScore = (aggregatedTotal - baseline.mean) / baseline.stddev;
    isAnomaly = Math.abs(zScore) > 2;
  }

  return {
    aggregatedTotal,
    groundTruthCount,
    bucketCount,
    divergenceRatio,
    diverges,
    isAnomaly,
    zScore,
    baselineMean,
    baselineStddev,
  };
}

export default verifyWidget;
