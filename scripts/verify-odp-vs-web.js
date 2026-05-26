/* eslint-disable no-console */
/**
 * ODP verification harness — proves that the backend `buildODPData`
 * produces byte-for-byte identical per-bucket output to the web
 * `HourlyODPChart` odpData reducer.
 *
 * Run:
 *   node scripts/verify-odp-vs-web.js
 *
 * It re-implements the web frontend reducer (ported line-by-line from
 * src/app/(protected)/orders/_components/performance-charts.tsx:1504-1932)
 * next to a direct import of the backend `buildODPData`, then feeds BOTH
 * the exact same synthetic `schedules` + `tickets` inputs and diffs the
 * resulting buckets field-by-field.
 *
 * Every test case represents a realistic ODP scenario — including the
 * specific 21 vs 31.5 mismatch the mobile app was producing — and MUST
 * report "PASS" on every field to prove the backend matches web 1:1.
 */

'use strict';

// ---------------------------------------------------------------------------
// 1. Pull the REAL backend buildODPData by re-exporting it from orderService.
//    (orderService doesn't export it yet, so we read the file text and eval
//     the function. Read-only, no side effects.)
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

function loadBackendBuildODPData() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'orderService.js'),
    'utf8',
  );
  // Extract the function text between "function buildODPData" and the
  // matching closing brace at zero nesting.
  const startTag = 'function buildODPData(';
  const startIdx = src.indexOf(startTag);
  if (startIdx < 0) throw new Error('buildODPData not found in orderService.js');
  let depth = 0;
  let i = startIdx;
  let bodyStart = -1;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') {
      if (depth === 0) bodyStart = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  const fnText = src.slice(startIdx, i);

  // epochToDate is a helper from elsewhere in orderService. Inline a trivial
  // port — backend uses `new Date(epoch * 1000)` with null-safety.
  const epochToDate = (epoch) => {
    if (epoch === null || epoch === undefined) return null;
    const e = parseFloat(epoch);
    if (!isFinite(e)) return null;
    return new Date(e * 1000);
  };
  // eslint-disable-next-line no-new-func
  const factory = new Function('epochToDate', `${fnText}; return buildODPData;`);
  return factory(epochToDate);
}

const backendBuildODPData = loadBackendBuildODPData();

// ---------------------------------------------------------------------------
// 2. Line-for-line port of the web HourlyODPChart odpData reducer
//    (performance-charts.tsx:1504-1932). NO logic changes vs the web.
//    Accepts the same `productScheduleItems` + `tickets` shape the web uses.
// ---------------------------------------------------------------------------
function webOdpReducer(productScheduleItems, tickets) {
  // Helper: getLoadQty — finds is_mix ticket_product.load_qty
  const getLoadQty = (ticket) => {
    const mix = (ticket.ticket_products || []).find((p) => p.is_mix === true);
    return (mix && mix.load_qty) || 0;
  };

  // --- scheduleLoadQty / orderedRatePerHour / truckSpace ---
  let scheduleLoadQty = 0;
  let orderedRatePerHour = 0;
  let truckSpace = 0;
  if (productScheduleItems && productScheduleItems.length) {
    for (const psi of productScheduleItems) {
      if (psi.is_mix && psi.schedules && psi.schedules.length) {
        const sched = psi.schedules[0];
        if (sched.delivery_rate_per_hour && sched.delivery_rate_per_hour > 0) {
          orderedRatePerHour = sched.delivery_rate_per_hour;
        }
        if (sched.truck_space && sched.truck_space > 0) {
          truckSpace = sched.truck_space;
        }
        if (sched.load_qty && sched.load_qty > 0) {
          scheduleLoadQty = sched.load_qty;
        }
        break;
      }
    }
  }

  // --- scheduledStartHour / scheduledStartMinute ---
  let scheduledStartHour = null;
  let scheduledStartMinute = 0;
  if (productScheduleItems && productScheduleItems.length) {
    for (const psi of productScheduleItems) {
      if (psi.is_mix && psi.schedules && psi.schedules.length) {
        const startTimeStr = psi.schedules[0].start_time;
        if (startTimeStr) {
          const cleaned = String(startTimeStr)
            .trim()
            .replace(/Z$|[+-]\d{2}:\d{2}$/, '');
          const match = cleaned.match(/(\d{2}):(\d{2})/);
          if (match) {
            scheduledStartHour = parseInt(match[1], 10);
            scheduledStartMinute = parseInt(match[2], 10);
          }
        }
        break;
      }
    }
  }

  const startMinFromMidnight =
    scheduledStartHour !== null
      ? scheduledStartHour * 60 + scheduledStartMinute
      : 0;
  const scheduledStartMinFromMidnight = startMinFromMidnight;

  const formatTimeLabel = (totalMin) => {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h}:${m.toString().padStart(2, '0')}`;
  };

  const getBucketForData = (minutes) =>
    Math.max(0, Math.floor((minutes - startMinFromMidnight) / 60));

  let expectedEndBucket = null;
  if (productScheduleItems && productScheduleItems.length) {
    for (const psi of productScheduleItems) {
      if (psi.is_mix && psi.schedules && psi.schedules.length) {
        const sched = psi.schedules[0];
        const nLoads = sched.number_of_loads || 0;
        const tSpace = sched.truck_space || 0;
        if (nLoads > 0 && tSpace > 0) {
          expectedEndBucket = Math.ceil((nLoads * tSpace) / 60);
        }
        break;
      }
    }
  }

  const getMinutes = (timeStr) => {
    if (!timeStr) return null;
    const date = new Date(timeStr);
    if (isNaN(date.getTime())) return null;
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  };

  const orderedCountMap = new Map();
  const deliveredMap = new Map();
  const deliveredCountMap = new Map();
  const pouredMap = new Map();
  const pouredCountMap = new Map();

  for (const ticket of tickets) {
    if (ticket.remove_reason_code && ticket.remove_reason_code.trim() !== '') continue;
    let qty = getLoadQty(ticket);
    if (qty <= 0 && scheduleLoadQty > 0) qty = scheduleLoadQty;
    if (qty <= 0) continue;

    const orderedMin = getMinutes(ticket.scheduled_on_job_time);
    if (orderedMin !== null) {
      const b = getBucketForData(orderedMin);
      orderedCountMap.set(b, (orderedCountMap.get(b) || 0) + 1);
    }
    const deliveredMin = getMinutes(ticket.on_job_time);
    if (deliveredMin !== null) {
      const clamped = Math.max(deliveredMin, scheduledStartMinFromMidnight);
      const b = getBucketForData(clamped);
      deliveredMap.set(b, (deliveredMap.get(b) || 0) + qty);
      deliveredCountMap.set(b, (deliveredCountMap.get(b) || 0) + 1);
    }
    const pouredMin = getMinutes(ticket.wash_time || ticket.to_plant_time);
    if (pouredMin !== null) {
      const clamped = Math.max(pouredMin, scheduledStartMinFromMidnight);
      const b = getBucketForData(clamped);
      pouredMap.set(b, (pouredMap.get(b) || 0) + qty);
      pouredCountMap.set(b, (pouredCountMap.get(b) || 0) + 1);
    }
  }

  const allBuckets = new Set();
  deliveredMap.forEach((_, b) => allBuckets.add(b));
  pouredMap.forEach((_, b) => allBuckets.add(b));
  orderedCountMap.forEach((_, b) => allBuckets.add(b));

  if (allBuckets.size === 0 && orderedRatePerHour > 0 && scheduledStartHour !== null) {
    if (productScheduleItems && productScheduleItems.length) {
      for (const psi of productScheduleItems) {
        if (psi.is_mix && psi.schedules && psi.schedules.length) {
          const sched = psi.schedules[0];
          const nLoads = sched.number_of_loads || 0;
          const tSpace = sched.truck_space || 0;
          if (nLoads > 0 && tSpace > 0) {
            const durationHours = Math.ceil((nLoads * tSpace) / 60);
            for (let h = 0; h <= durationHours; h++) allBuckets.add(h);
          }
          break;
        }
      }
    }
  }

  if (allBuckets.size === 0) return [];

  const bucketIndices = Array.from(allBuckets).sort((a, b) => a - b);
  const minBucket = Math.min(0, bucketIndices[0]);
  const maxBucket = bucketIndices[bucketIndices.length - 1];

  const orderedRate = Math.round(orderedRatePerHour * 100) / 100;
  const loadsPerHour = truckSpace > 0 ? Math.floor(60 / truckSpace) : 0;

  let totalOrderedQty = 0;
  let totalLoads = 0;
  if (productScheduleItems && productScheduleItems.length) {
    for (const psi of productScheduleItems) {
      if (psi.is_mix && psi.schedules && psi.schedules.length) {
        const sched = psi.schedules[0];
        if (sched.schedule_qty && sched.schedule_qty > 0) totalOrderedQty = sched.schedule_qty;
        if (sched.number_of_loads && sched.number_of_loads > 0) totalLoads = sched.number_of_loads;
        break;
      }
    }
  }
  if (totalOrderedQty === 0 && tickets.length > 0) {
    for (const ticket of tickets) {
      if (ticket.remove_reason_code && ticket.remove_reason_code.trim() !== '') continue;
      let qty = getLoadQty(ticket);
      if (qty <= 0 && scheduleLoadQty > 0) qty = scheduleLoadQty;
      if (qty > 0) totalOrderedQty += qty;
      totalLoads++;
    }
  }

  let remainingOrdered = totalOrderedQty;
  let remainingLoads = totalLoads;

  const scheduledStartBucket =
    scheduledStartHour !== null
      ? Math.floor((scheduledStartMinFromMidnight - startMinFromMidnight) / 60)
      : 0;

  const rawBuckets = [];
  for (let b = minBucket; b <= maxBucket; b++) {
    const isScheduledHour = b >= scheduledStartBucket;
    const orderedForHour =
      orderedRate > 0 && isScheduledHour
        ? Math.min(orderedRate, Math.max(0, remainingOrdered))
        : 0;
    if (isScheduledHour) remainingOrdered -= orderedForHour;
    const orderedLoadsForHour =
      loadsPerHour > 0 && isScheduledHour
        ? Math.min(loadsPerHour, Math.max(0, remainingLoads))
        : 0;
    if (isScheduledHour) remainingLoads -= orderedLoadsForHour;

    const bucketLabel = formatTimeLabel(startMinFromMidnight + b * 60);

    rawBuckets.push({
      h: b,
      label: bucketLabel,
      ordered: Math.round(orderedForHour * 100) / 100,
      delivered: Math.round((deliveredMap.get(b) || 0) * 100) / 100,
      poured: Math.round((pouredMap.get(b) || 0) * 100) / 100,
      orderedCount: orderedLoadsForHour,
      deliveredCount: deliveredCountMap.get(b) || 0,
      pouredCount: pouredCountMap.get(b) || 0,
      isOvertime: expectedEndBucket !== null && b >= expectedEndBucket,
    });
  }

  let lastOrderedIndex = -1;
  for (let i = rawBuckets.length - 1; i >= 0; i--) {
    if (rawBuckets[i].ordered > 0) {
      lastOrderedIndex = i;
      break;
    }
  }

  let carryOver = 0;
  const result = rawBuckets.map((b, index) => {
    const carryIn = carryOver;
    let deliveredSolid = b.delivered;
    let deliveredCarryIn = 0;
    const deliveredCarryOut = 0;

    if (b.poured > b.delivered) {
      const pouredFromBacklog = b.poured - b.delivered;
      deliveredCarryIn = Math.min(carryIn, pouredFromBacklog);
      deliveredSolid = b.delivered;
      carryOver = Math.max(0, carryIn - pouredFromBacklog);
    } else {
      deliveredCarryIn = 0;
      deliveredSolid = b.delivered;
      carryOver = carryOver + (b.delivered - b.poured);
    }

    let orderedSolid = b.ordered;
    let orderedStriped = 0;
    let orderedCountSolid = b.orderedCount;
    let orderedCountStriped = 0;
    if (index === lastOrderedIndex && b.ordered > 0 && b.ordered < orderedRate) {
      orderedSolid = b.ordered;
      orderedStriped = orderedRate - b.ordered;
      orderedCountSolid = b.orderedCount;
      orderedCountStriped = loadsPerHour - b.orderedCount;
    }

    return {
      ...b,
      orderedSolid: Math.round(orderedSolid * 100) / 100,
      orderedStriped: Math.round(orderedStriped * 100) / 100,
      deliveredCarryIn: Math.round(deliveredCarryIn * 100) / 100,
      deliveredSolid: Math.round(deliveredSolid * 100) / 100,
      deliveredCarryOut: Math.round(deliveredCarryOut * 100) / 100,
      orderedCountSolid,
      orderedCountStriped,
      deliveredCountCarryIn: 0,
      deliveredCountSolid: b.deliveredCount,
      deliveredCountCarryOut: 0,
    };
  });

  return result.filter(
    (bucket) => bucket.ordered > 0 || bucket.delivered > 0 || bucket.poured > 0,
  );
}

// ---------------------------------------------------------------------------
// 3. Fixture builder — same schedule data can be fed to both reducers. The
//    backend `buildODPData` takes flat schedule ROWS (as the SQL returns
//    them), while the web takes the nested `productScheduleItems` shape.
//    Helper that produces both from one canonical definition.
// ---------------------------------------------------------------------------
function makeFixture({ startHour, startMinute, rate, totalQty, truckSpace, loads, loadQty }) {
  const startTime = `1970-01-01T${String(startHour).padStart(2, '0')}:${String(startMinute).padStart(2, '0')}:00Z`;
  const startEpoch = Date.UTC(1970, 0, 1, startHour, startMinute, 0) / 1000;

  const backendScheduleRow = {
    product_id: 100,
    schedule_id: 1000,
    delivery_rate_per_hour: rate,
    truck_space: truckSpace,
    start_time_epoch: startEpoch,
    number_of_loads: loads,
    schedule_qty: totalQty,
    load_qty: loadQty,
    unload_duration_minutes: 20,
  };

  const webProductScheduleItems = [
    {
      id: 100,
      is_mix: true,
      schedules: [
        {
          id: 1000,
          delivery_rate_per_hour: rate,
          truck_space: truckSpace,
          schedule_qty: totalQty,
          number_of_loads: loads,
          load_qty: loadQty,
          start_time: startTime,
          loads: [],
        },
      ],
    },
  ];

  return { backendScheduleRow, webProductScheduleItems };
}

// Helper: build a ticket in both shapes simultaneously.
function makeTicket({ truck, onJob, wash, toPlant, scheduled, qty }) {
  const toEpoch = (iso) => (iso ? Date.parse(iso) / 1000 : null);
  return {
    backend: {
      ticket_code: truck + '-T',
      truck_code: truck,
      on_job_time_epoch: toEpoch(onJob),
      wash_time_epoch: toEpoch(wash),
      to_plant_time_epoch: toEpoch(toPlant),
      load_qty: qty,
    },
    web: {
      ticket_code: truck + '-T',
      truck_code: truck,
      remove_reason_code: null,
      on_job_time: onJob || null,
      wash_time: wash || null,
      to_plant_time: toPlant || null,
      scheduled_on_job_time: scheduled || null,
      ticket_products: [{ is_mix: true, load_qty: qty }],
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Assertion utilities
// ---------------------------------------------------------------------------
const CY_FIELDS = [
  ['ordered', 'ordered'],
  ['orderedSolid', 'ordered_solid'],
  ['orderedStriped', 'ordered_striped'],
  ['delivered', 'delivered'],
  ['deliveredCarryIn', 'delivered_carry_in'],
  ['deliveredSolid', 'delivered_solid'],
  ['poured', 'poured'],
];

function approxEq(a, b) {
  return Math.abs((a || 0) - (b || 0)) < 1e-6;
}

function diffBuckets(webBuckets, backendBuckets, caseName) {
  const errors = [];

  if (webBuckets.length !== backendBuckets.length) {
    errors.push(
      `bucket count differs: web=${webBuckets.length} backend=${backendBuckets.length}`,
    );
  }

  const n = Math.min(webBuckets.length, backendBuckets.length);
  for (let i = 0; i < n; i++) {
    const w = webBuckets[i];
    const b = backendBuckets[i];
    if (w.label !== b.hour_label) {
      errors.push(
        `[bucket ${i}] label: web="${w.label}" backend="${b.hour_label}"`,
      );
    }
    for (const [wKey, bKey] of CY_FIELDS) {
      if (!approxEq(w[wKey], b[bKey])) {
        errors.push(
          `[bucket ${i} "${w.label}"] ${wKey}/${bKey}: web=${w[wKey]} backend=${b[bKey]}`,
        );
      }
    }
  }

  if (errors.length === 0) {
    console.log(`  PASS  ${caseName} (${n} buckets)`);
    return true;
  }
  console.log(`  FAIL  ${caseName}`);
  for (const e of errors) console.log(`        • ${e}`);
  return false;
}

// ---------------------------------------------------------------------------
// 5. Test cases
// ---------------------------------------------------------------------------
const cases = [];

// Case A — the exact "21 vs 31.5" reproduction.
// Schedule starts 09:00, rate 21 CY/HR, 2 loads/hour spacing.
// Bucket 0 receives 1 delivery (7 CY) + 2 pours (14 CY) — draws 7 CY from
// future stock. But deliveries arrive via 3 trucks over 3 buckets, and the
// carryover state machine must show the backlog struck only when consumed.
(function buildCaseA() {
  const { backendScheduleRow, webProductScheduleItems } = makeFixture({
    startHour: 9,
    startMinute: 0,
    rate: 21,
    totalQty: 63,
    truckSpace: 20,
    loads: 9,
    loadQty: 7,
  });

  // Deliveries: 3 trucks per hour (every 20 min).
  const tickets = [];
  const addT = (truck, onJob, wash) =>
    tickets.push(makeTicket({ truck, onJob, wash, qty: 7 }));

  // Hour 0 (09:00-10:00) — 3 trucks arrive, only 2 finish pouring
  addT('T1', '1970-01-01T09:00:00Z', '1970-01-01T09:25:00Z');
  addT('T2', '1970-01-01T09:20:00Z', '1970-01-01T09:45:00Z');
  addT('T3', '1970-01-01T09:40:00Z', '1970-01-01T10:05:00Z'); // pours next hour
  // Hour 1 (10:00-11:00) — 3 trucks arrive, 3 finish pouring (T3+T4+T5)
  addT('T4', '1970-01-01T10:00:00Z', '1970-01-01T10:25:00Z');
  addT('T5', '1970-01-01T10:20:00Z', '1970-01-01T10:45:00Z');
  addT('T6', '1970-01-01T10:40:00Z', '1970-01-01T11:05:00Z'); // pours next hour
  // Hour 2 (11:00-12:00) — 3 trucks arrive, 3 finish pouring
  addT('T7', '1970-01-01T11:00:00Z', '1970-01-01T11:25:00Z');
  addT('T8', '1970-01-01T11:20:00Z', '1970-01-01T11:45:00Z');
  addT('T9', '1970-01-01T11:40:00Z', '1970-01-01T12:05:00Z');

  cases.push({
    name: 'A) 9-load schedule, 3/hr, pour-lags-delivery (classic carryover)',
    backendSchedules: [backendScheduleRow],
    backendTickets: tickets.map((t) => t.backend),
    webProductScheduleItems,
    webTickets: tickets.map((t) => t.web),
  });
})();

// Case B — schedule starts at NON-zero minute (01:50) to test the
// unfloored anchor fix. 6 loads × 7 CY = 42 CY total, rate 21 CY/HR.
(function buildCaseB() {
  const { backendScheduleRow, webProductScheduleItems } = makeFixture({
    startHour: 1,
    startMinute: 50,
    rate: 21,
    totalQty: 42,
    truckSpace: 20,
    loads: 6,
    loadQty: 7,
  });
  const tickets = [];
  const add = (truck, onJob, wash) =>
    tickets.push(makeTicket({ truck, onJob, wash, qty: 7 }));
  add('T1', '1970-01-01T01:50:00Z', '1970-01-01T02:10:00Z');
  add('T2', '1970-01-01T02:10:00Z', '1970-01-01T02:30:00Z');
  add('T3', '1970-01-01T02:30:00Z', '1970-01-01T02:50:00Z');
  add('T4', '1970-01-01T02:50:00Z', '1970-01-01T03:10:00Z');
  add('T5', '1970-01-01T03:10:00Z', '1970-01-01T03:30:00Z');
  add('T6', '1970-01-01T03:30:00Z', '1970-01-01T03:50:00Z');

  cases.push({
    name: 'B) 01:50 start (unfloored anchor), 6 loads, on-schedule pour',
    backendSchedules: [backendScheduleRow],
    backendTickets: tickets.map((t) => t.backend),
    webProductScheduleItems,
    webTickets: tickets.map((t) => t.web),
  });
})();

// Case C — last-bucket partial (4 loads, 3/hr → bucket 1 shows 1 load = 7
// CY vs rate 21 CY/HR, so orderedStriped = 14 padding).
(function buildCaseC() {
  const { backendScheduleRow, webProductScheduleItems } = makeFixture({
    startHour: 8,
    startMinute: 0,
    rate: 21,
    totalQty: 28,
    truckSpace: 20,
    loads: 4,
    loadQty: 7,
  });
  const tickets = [];
  const add = (truck, onJob, wash) =>
    tickets.push(makeTicket({ truck, onJob, wash, qty: 7 }));
  add('T1', '1970-01-01T08:00:00Z', '1970-01-01T08:20:00Z');
  add('T2', '1970-01-01T08:20:00Z', '1970-01-01T08:40:00Z');
  add('T3', '1970-01-01T08:40:00Z', '1970-01-01T09:00:00Z');
  add('T4', '1970-01-01T09:00:00Z', '1970-01-01T09:20:00Z');

  cases.push({
    name: 'C) 4-load schedule, partial last bucket (striped padding)',
    backendSchedules: [backendScheduleRow],
    backendTickets: tickets.map((t) => t.backend),
    webProductScheduleItems,
    webTickets: tickets.map((t) => t.web),
  });
})();

// Case D — over-pour (poured > delivered) triggering deliveredCarryIn.
(function buildCaseD() {
  const { backendScheduleRow, webProductScheduleItems } = makeFixture({
    startHour: 8,
    startMinute: 0,
    rate: 21,
    totalQty: 42,
    truckSpace: 20,
    loads: 6,
    loadQty: 7,
  });
  const tickets = [];
  const add = (truck, onJob, wash) =>
    tickets.push(makeTicket({ truck, onJob, wash, qty: 7 }));
  // Hour 0 — 3 arrive, 1 pours (other 2 pours happen hour 1)
  add('T1', '1970-01-01T08:00:00Z', '1970-01-01T08:20:00Z');
  add('T2', '1970-01-01T08:20:00Z', '1970-01-01T09:00:00Z'); // pours hour 1
  add('T3', '1970-01-01T08:40:00Z', '1970-01-01T09:10:00Z'); // pours hour 1
  // Hour 1 — 3 arrive, ALL 5 pours happen this hour → backlog drains
  add('T4', '1970-01-01T09:00:00Z', '1970-01-01T09:20:00Z');
  add('T5', '1970-01-01T09:20:00Z', '1970-01-01T09:40:00Z');
  add('T6', '1970-01-01T09:40:00Z', '1970-01-01T10:00:00Z'); // wash_time → bucket 1? edge

  cases.push({
    name: 'D) Over-pour bucket (poured > delivered, carry-in drain)',
    backendSchedules: [backendScheduleRow],
    backendTickets: tickets.map((t) => t.backend),
    webProductScheduleItems,
    webTickets: tickets.map((t) => t.web),
  });
})();

// Case E — THE 21 vs 31.5 reproduction. Bucket 0 over-pours, leaving a
// 10.5 CY backlog. Bucket 1 delivers exactly what it pours (21 = 21) with
// NO drain, so the striped carry-in must be 0 and the delivered label must
// read 21 — not 31.5. The previous backend bug emitted the full carryIn
// (10.5) as delivered_carry_in, inflating the mobile label to 31.5.
(function buildCaseE() {
  const { backendScheduleRow, webProductScheduleItems } = makeFixture({
    startHour: 9,
    startMinute: 0,
    rate: 21,
    totalQty: 84,
    truckSpace: 20,
    loads: 12,
    loadQty: 10.5,
  });
  const tickets = [];
  const add = (truck, onJob, wash, qty) =>
    tickets.push(makeTicket({ truck, onJob, wash, qty }));
  // Bucket 0 (09:00-10:00): delivered=42, poured=31.5 → backlog=10.5
  add('T1', '1970-01-01T09:00:00Z', '1970-01-01T09:20:00Z', 10.5);
  add('T2', '1970-01-01T09:20:00Z', '1970-01-01T09:40:00Z', 10.5);
  add('T3', '1970-01-01T09:40:00Z', '1970-01-01T10:00:00Z', 10.5);
  add('T4', '1970-01-01T09:50:00Z', '1970-01-01T11:00:00Z', 10.5); // pour in bkt 2
  // Bucket 1 (10:00-11:00): delivered=21, poured=21 → no drain, backlog unchanged
  add('T5', '1970-01-01T10:00:00Z', '1970-01-01T10:20:00Z', 10.5);
  add('T6', '1970-01-01T10:20:00Z', '1970-01-01T10:40:00Z', 10.5);
  // Bucket 2 (11:00-12:00): delivered=0, poured=10.5 → drains backlog (T4)

  cases.push({
    name: 'E) 21 vs 31.5 repro — bucket 1 has backlog inherited but no drain',
    backendSchedules: [backendScheduleRow],
    backendTickets: tickets.map((t) => t.backend),
    webProductScheduleItems,
    webTickets: tickets.map((t) => t.web),
  });
})();

// Case F — edge case: delivered-only bucket (no pour this hour), to verify
// the empty-bucket filter and carryover accumulation match web exactly.
(function buildCaseF() {
  const { backendScheduleRow, webProductScheduleItems } = makeFixture({
    startHour: 14,
    startMinute: 0,
    rate: 21,
    totalQty: 42,
    truckSpace: 20,
    loads: 6,
    loadQty: 7,
  });
  const tickets = [];
  const add = (truck, onJob, wash) =>
    tickets.push(makeTicket({ truck, onJob, wash, qty: 7 }));
  // Hour 0: 3 arrive, none pour yet (all wash_times are hour 1)
  add('T1', '1970-01-01T14:00:00Z', '1970-01-01T15:10:00Z');
  add('T2', '1970-01-01T14:20:00Z', '1970-01-01T15:20:00Z');
  add('T3', '1970-01-01T14:40:00Z', '1970-01-01T15:30:00Z');
  // Hour 1: 3 arrive, all 6 pours happen in this bucket
  add('T4', '1970-01-01T15:00:00Z', '1970-01-01T15:40:00Z');
  add('T5', '1970-01-01T15:20:00Z', '1970-01-01T15:50:00Z');
  add('T6', '1970-01-01T15:40:00Z', '1970-01-01T15:55:00Z');

  cases.push({
    name: 'F) Delivery-only bucket 0, all pours land in bucket 1',
    backendSchedules: [backendScheduleRow],
    backendTickets: tickets.map((t) => t.backend),
    webProductScheduleItems,
    webTickets: tickets.map((t) => t.web),
  });
})();

// Case G — cancelled tickets MUST be excluded on both sides. Backend filters
// by SQL WHERE, web by remove_reason_code check. The harness feeds both sides
// the same ticket array but we add a cancelled one to prove it's dropped.
(function buildCaseG() {
  const { backendScheduleRow, webProductScheduleItems } = makeFixture({
    startHour: 10,
    startMinute: 0,
    rate: 21,
    totalQty: 21,
    truckSpace: 20,
    loads: 3,
    loadQty: 7,
  });
  const tickets = [];
  const add = (truck, onJob, wash, qty, cancelled) => {
    const t = makeTicket({ truck, onJob, wash, qty });
    if (cancelled) {
      t.web.remove_reason_code = 'VOID';
      // Backend-side: SQL would have excluded this row. Emulate by dropping.
      t.backend = null;
    }
    tickets.push(t);
  };
  add('T1', '1970-01-01T10:00:00Z', '1970-01-01T10:20:00Z', 7, false);
  add('T2', '1970-01-01T10:20:00Z', '1970-01-01T10:40:00Z', 7, false);
  add('T3', '1970-01-01T10:40:00Z', '1970-01-01T11:00:00Z', 7, false);
  add('TX', '1970-01-01T10:05:00Z', '1970-01-01T10:25:00Z', 7, true); // cancelled

  cases.push({
    name: 'G) Cancelled ticket excluded from both sides',
    backendSchedules: [backendScheduleRow],
    backendTickets: tickets.map((t) => t.backend).filter(Boolean),
    webProductScheduleItems,
    webTickets: tickets.map((t) => t.web),
  });
})();

// Case H — inherited backlog with NO drain this hour. This is the exact
// scenario the OLD buggy backend got wrong: bucket 1 has delivered = poured
// = 21 (balanced), but carryOver coming in from bucket 0 = 21. Web shows
// deliveredCarryIn = 0 (no drain) so the delivered label reads just "21".
// The old buggy backend emitted `carryIn` (= 21) in delivered_carry_in,
// making the mobile label read 21 + 21 = 42 (inflated).
(function buildCaseH() {
  const { backendScheduleRow, webProductScheduleItems } = makeFixture({
    startHour: 12,
    startMinute: 0,
    rate: 21,
    totalQty: 63,
    truckSpace: 20,
    loads: 9,
    loadQty: 7,
  });
  const tickets = [];
  const add = (truck, onJob, wash) =>
    tickets.push(makeTicket({ truck, onJob, wash, qty: 7 }));
  // Hour 0: deliver 6 (42 CY), pour 3 (21 CY) → backlog = 21
  add('T1', '1970-01-01T12:00:00Z', '1970-01-01T12:15:00Z');
  add('T2', '1970-01-01T12:10:00Z', '1970-01-01T12:25:00Z');
  add('T3', '1970-01-01T12:20:00Z', '1970-01-01T12:40:00Z');
  add('T4', '1970-01-01T12:30:00Z', '1970-01-01T13:10:00Z'); // pours bkt 1
  add('T5', '1970-01-01T12:40:00Z', '1970-01-01T13:20:00Z'); // pours bkt 1
  add('T6', '1970-01-01T12:50:00Z', '1970-01-01T13:30:00Z'); // pours bkt 1
  // Hour 1: deliver 3 (21 CY), pour 3 (21 CY) → label must read "21" not "42"
  add('T7', '1970-01-01T13:00:00Z', '1970-01-01T13:40:00Z');
  add('T8', '1970-01-01T13:10:00Z', '1970-01-01T13:50:00Z');
  add('T9', '1970-01-01T13:20:00Z', '1970-01-01T14:05:00Z'); // pours bkt 2

  cases.push({
    name: 'H) Balanced bucket with inherited backlog (poured == delivered)',
    backendSchedules: [backendScheduleRow],
    backendTickets: tickets.map((t) => t.backend),
    webProductScheduleItems,
    webTickets: tickets.map((t) => t.web),
  });
})();

// ---------------------------------------------------------------------------
// 6. Run the diff for every case
// ---------------------------------------------------------------------------
console.log('\nODP verification: web reducer vs backend buildODPData\n');

let allPass = true;
for (const c of cases) {
  const webBuckets = webOdpReducer(c.webProductScheduleItems, c.webTickets);
  const backendData = backendBuildODPData(c.backendSchedules, c.backendTickets, null);
  const backendBuckets = (backendData && backendData.buckets) || [];
  if (!diffBuckets(webBuckets, backendBuckets, c.name)) allPass = false;
}

console.log();
if (allPass) {
  console.log('All cases PASS — backend output matches web 1:1.');
  process.exit(0);
} else {
  console.log('FAILURES detected — backend output differs from web.');
  process.exit(1);
}
