/**
 * Lite Comparison Service
 *
 * Used by the Connex browser-extension flow (POST /api/scraped-orders/ingest-lite).
 *
 * The extension can only reliably scrape order_code, order_date, quantities and
 * status. So instead of re-implementing matching, this service REUSES the full
 * `compareOrdersWithSystem()` (order_code + order_date match key, DB fetch,
 * status-category logic, quantity tolerance) and then POST-FILTERS each found
 * order's differences down to ONLY the fields the extension can validate:
 *   - ordered_qty
 *   - delivered_qty
 *   - status
 *
 * Differences on product_code / customer_name / delivery_address / start_time /
 * plant_code (which the extension does not send) are dropped, and the order is
 * re-classified accordingly. The shared comparison + email code is untouched.
 */

const { compareOrdersWithSystem } = require('./orderComparisonService');
const { CommandCloudAPI } = require('./commandCloudService');

// The only fields the lite flow compares. (delivered_qty intentionally excluded:
// the Connex board's "delivered" chip number is delivered + in-transit + pre-transit,
// which never equals the DB's actually-delivered delv_qty — so it would always mismatch.)
const LITE_FIELDS = new Set(['ordered_qty', 'status']);

/**
 * Re-classify the full comparison result using only the lite fields.
 *
 * @param {object} comparisonResult - Result from compareOrdersWithSystem()
 * @returns {object} { summary, fullResult } re-classified for the lite flow
 */
function applyLiteFilter(comparisonResult) {
  const full = comparisonResult.fullResult;

  const matched = [...(full.matched_orders || [])];
  const mismatched = [];

  // A matched order has no differences, so it stays matched. Only mismatched
  // orders can flip to matched once non-lite differences are removed.
  for (const order of (full.mismatched_orders || [])) {
    const liteDiffs = (order.differences || []).filter((d) => {
      if (!LITE_FIELDS.has(d.field)) return false;

      // If the scraped order had no quantity, don't flag a qty difference.
      if (d.field === 'ordered_qty' && (d.external_value === null || d.external_value === undefined)) {
        return false;
      }

      // Status differences ARE flagged (e.g. Hold vs In-Process/Completed,
      // Normal vs Completed). The email shows both Connex and Truckast values.
      return true;
    });

    if (liteDiffs.length === 0) {
      matched.push({ ...order, matchStatus: 'matched', match_status: 'matched', differences: [] });
    } else {
      mismatched.push({ ...order, differences: liteDiffs });
    }
  }

  const missing = full.missing_in_system_orders || [];
  const excluded = full.excluded_no_cy_mix_orders || [];
  const newInSystem = full.new_in_system_orders || [];

  const totalExternal = comparisonResult.summary.total_external_orders || 0;
  const matchedCount = matched.length;
  const mismatchedCount = mismatched.length;
  const matchedPct = totalExternal > 0 ? ((matchedCount / totalExternal) * 100).toFixed(2) : '0.00';
  const mismatchedPct = totalExternal > 0 ? ((mismatchedCount / totalExternal) * 100).toFixed(2) : '0.00';

  const summary = {
    ...comparisonResult.summary,
    matched_count: matchedCount,
    matchedCount: matchedCount,
    matched_percentage: parseFloat(matchedPct),
    matchedPercentage: parseFloat(matchedPct),
    mismatched_count: mismatchedCount,
    mismatchedCount: mismatchedCount,
    mismatched_percentage: parseFloat(mismatchedPct),
    mismatchedPercentage: parseFloat(mismatchedPct),
    // Email reads `excluded_count`; surface the no-CY-mix exclusions under it.
    excluded_count: comparisonResult.summary.no_cy_mix_excluded_count || 0,
    excludedCount: comparisonResult.summary.no_cy_mix_excluded_count || 0,
    compare_mode: 'lite'
  };

  const fullResult = {
    summary,
    matched_orders: matched,
    mismatched_orders: mismatched,
    missing_in_system_orders: missing,
    excluded_no_cy_mix_orders: excluded,
    new_in_system_orders: newInSystem
  };

  return { summary, fullResult };
}

/**
 * Run the lite comparison for a set of sanitized (lite) orders.
 *
 * @param {object} params
 * @param {array}  params.sanitizedOrders - Lite sanitized orders
 * @param {string} params.batchId - Batch id for tracking/logging
 * @returns {Promise<object>} { summary, fullResult }
 */
function foundCount(result) {
  const f = result.fullResult || {};
  return (
    (f.matched_orders || []).length +
    (f.mismatched_orders || []).length +
    (f.excluded_no_cy_mix_orders || []).length
  );
}

async function compareLiteOrders({ sanitizedOrders, batchId }) {
  let comparisonResult = await compareOrdersWithSystem({
    sanitizedOrders,
    batchId,
    fileUrl: null,
    processingStartTime: Date.now()
  });

  // Guard against a misleading "everything is missing" result. If we sent a
  // non-trivial batch but NOTHING was found in the system DB, it is almost
  // always a transient DB fetch failure (e.g. the Supabase pooler dropped the
  // connection) — not a real all-missing. Retry once; if still empty, throw so
  // the controller returns a retryable error instead of emailing a wrong report.
  if (sanitizedOrders.length >= 5 && foundCount(comparisonResult) === 0) {
    await new Promise((r) => setTimeout(r, 1500));
    comparisonResult = await compareOrdersWithSystem({
      sanitizedOrders,
      batchId: `${batchId}_retry`,
      fileUrl: null,
      processingStartTime: Date.now()
    });

    if (foundCount(comparisonResult) === 0) {
      const err = new Error(
        `System lookup returned no matching orders for ${sanitizedOrders.length} scraped order(s) — ` +
          `likely a transient database connection error. No email was sent; please retry.`
      );
      err.code = 'SYSTEM_LOOKUP_EMPTY';
      throw err;
    }
  }

  return applyLiteFilter(comparisonResult);
}

// Normalize Connex/extension and Command Cloud status strings to a common form
// so "Confirmed" (CC) === "Normal" (extension), etc.
function canonStatus(s) {
  const t = String(s == null ? '' : s).toLowerCase().trim();
  if (['confirmed', 'normal', 'unconfirmed', 'scheduled', 'requested'].includes(t)) return 'normal';
  if (t === 'hold') return 'hold';
  if (['will call', 'willcall', 'will_call'].includes(t)) return 'willcall';
  if (['completed', 'complete'].includes(t)) return 'completed';
  if (['cancelled', 'canceled'].includes(t)) return 'cancelled';
  return t;
}

// Command Cloud listOrders date window (ISO). Widen ±1 day for UTC/timezone safety.
function ccDateBounds(dateRange) {
  const from = (dateRange && dateRange.from) || (dateRange && dateRange.to) || null;
  const to = (dateRange && dateRange.to) || from;
  const shift = (d, days) => {
    const dt = new Date(d + 'T00:00:00Z');
    if (isNaN(dt.getTime())) return new Date(Date.now() + days * 86400000).toISOString();
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString();
  };
  if (!from) {
    const now = Date.now();
    return { startDate: new Date(now - 86400000).toISOString(), endDate: new Date(now + 2 * 86400000).toISOString() };
  }
  return { startDate: shift(from, -1), endDate: shift(to, 2) };
}

/**
 * Re-validate STATUS mismatches against the live Command Cloud API.
 * For each status-mismatched order, fetch the order's current Command Cloud
 * status (supplierStatus.name) and re-compare against the scraped (extraction)
 * status. If they now agree → the status diff is dropped (resolved). If they
 * still differ → the diff is shown as Connex (extraction) vs Command Cloud.
 *
 * One listOrders() call covers the whole date. Graceful: on any Command Cloud
 * error the original result is returned unchanged.
 *
 * @param {object} result - { summary, fullResult } from applyLiteFilter
 * @param {object} dateRange - { from, to } YYYY-MM-DD
 * @returns {Promise<object>} updated { summary, fullResult }
 */
async function revalidateLiteStatuses(result, dateRange) {
  const full = result.fullResult;
  const mism = full.mismatched_orders || [];
  const hasStatusMismatch = mism.some((o) => (o.differences || []).some((d) => d.field === 'status'));
  if (!hasStatusMismatch) return result; // nothing to re-validate → no API call

  // Pull the day's orders from Command Cloud once → map order_code → status.
  let ccByCode;
  try {
    const api = new CommandCloudAPI();
    const { startDate, endDate } = ccDateBounds(dateRange);
    const ccOrders = await api.listOrders({ startDate, endDate, dateField: 'startDateTime', limit: 1000 });
    ccByCode = new Map();
    for (const o of ccOrders) {
      const code = String(o.id == null ? '' : o.id).trim().toUpperCase();
      const name = o.supplierStatus && o.supplierStatus.name;
      if (code) ccByCode.set(code, name);
    }
  } catch (e) {
    console.error('Command Cloud status re-validation skipped:', e.response ? e.response.status : e.message);
    return result; // keep original (extraction vs Truckast) status diffs
  }

  const matched = [...(full.matched_orders || [])];
  const mismatched = [];

  for (const order of mism) {
    const ext = order.external_order || order.externalOrder || {};
    const code = String(ext.order_code == null ? '' : ext.order_code).trim().toUpperCase();
    const cc = ccByCode.has(code) ? ccByCode.get(code) : undefined;

    const newDiffs = [];
    for (const d of (order.differences || [])) {
      if (d.field !== 'status') {
        newDiffs.push(d);
        continue;
      }
      if (cc === undefined || cc === null) {
        newDiffs.push(d); // CC didn't return this order → keep original diff
        continue;
      }
      if (canonStatus(d.external_value) === canonStatus(cc)) {
        continue; // extraction now agrees with Command Cloud → resolved, drop it
      }
      // Still differs → show extraction vs Command Cloud
      newDiffs.push({
        ...d,
        system_value: cc,
        systemValue: cc,
        compare_source: 'Command Cloud'
      });
    }

    if (newDiffs.length === 0) {
      matched.push({ ...order, matchStatus: 'matched', match_status: 'matched', differences: [] });
    } else {
      mismatched.push({ ...order, differences: newDiffs });
    }
  }

  const totalExternal = result.summary.total_external_orders || 0;
  const matchedCount = matched.length;
  const mismatchedCount = mismatched.length;
  const summary = {
    ...result.summary,
    matched_count: matchedCount,
    matchedCount: matchedCount,
    mismatched_count: mismatchedCount,
    mismatchedCount: mismatchedCount,
    matched_percentage: totalExternal > 0 ? parseFloat(((matchedCount / totalExternal) * 100).toFixed(2)) : 0,
    mismatched_percentage: totalExternal > 0 ? parseFloat(((mismatchedCount / totalExternal) * 100).toFixed(2)) : 0,
    status_revalidated: true
  };

  return {
    summary,
    fullResult: { ...full, summary, matched_orders: matched, mismatched_orders: mismatched }
  };
}

module.exports = {
  compareLiteOrders,
  applyLiteFilter,
  revalidateLiteStatuses,
  LITE_FIELDS
};
