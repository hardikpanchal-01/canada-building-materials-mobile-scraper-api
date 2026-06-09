/**
 * Resolves relative date phrases to absolute ISO timestamps in
 * America/Chicago. The model MUST call this before constructing any filter
 * that references a relative date — it is the single source of truth for
 * "what does 'last week' mean right now".
 *
 * All boundaries are returned with explicit UTC offsets so they compare
 * correctly against `timestamptz` columns regardless of the Postgres
 * session timezone.
 */

import { formatDate } from "./date-time-format.mjs";

const CHICAGO_TZ = "America/Chicago";

function chicagoDateParts(date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: CHICAGO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = fmt.formatToParts(date);
  const weekdayMap = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    year: parseInt(parts.find((p) => p.type === "year").value, 10),
    month: parseInt(parts.find((p) => p.type === "month").value, 10),
    day: parseInt(parts.find((p) => p.type === "day").value, 10),
    weekday: weekdayMap[parts.find((p) => p.type === "weekday").value] ?? 0,
  };
}

function chicagoOffsetMinutes(date) {
  // Returns Chicago's UTC offset at the given moment in minutes (negative = west).
  // CDT = -300, CST = -360.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: CHICAGO_TZ,
    timeZoneName: "shortOffset",
  });
  const parts = fmt.formatToParts(date);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const match = tzName.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return -360;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (parseInt(match[2], 10) * 60 + parseInt(match[3] || "0", 10));
}

function offsetSuffix(offsetMin) {
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/**
 * Returns an ISO 8601 string for midnight at the given Chicago wall-time
 * date, with the correct offset for that day (handles DST).
 */
function chicagoMidnightIso(year, month, day) {
  // Probe Chicago's offset at noon local time to avoid the 02:00 DST edge.
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const offsetMin = chicagoOffsetMinutes(probe);
  return `${year}-${pad(month)}-${pad(day)}T00:00:00${offsetSuffix(offsetMin)}`;
}

/** Add `days` days to a Chicago calendar date and return the new {y,m,d}. */
function addDays(year, month, day, days) {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/** Format a Chicago calendar date as MM/DD/YYYY using the shared formatter. */
function toUsDisplay(year, month, day) {
  // Anchor at noon UTC and format in UTC so DST and host-timezone shifts
  // can't bump the day. The result is purely a function of (y, m, d).
  const anchor = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return formatDate(anchor, { dateFormat: "MM/dd/yyyy" }, { timezone: "UTC" });
}

function makeRange(
  startY, startM, startD,
  endY, endM, endD,
  label,
) {
  // The ISO `end` is half-open (the day AFTER the last actual day in range).
  // For human display we want the inclusive last day, so step back one day.
  const inclusiveEnd = addDays(endY, endM, endD, -1);
  const displayStart = toUsDisplay(startY, startM, startD);
  const displayEnd = toUsDisplay(inclusiveEnd.year, inclusiveEnd.month, inclusiveEnd.day);
  const sameDay = displayStart === displayEnd;
  const displayLabel = sameDay
    ? `${displayStart} (${label})`
    : `${displayStart} – ${displayEnd} (${label})`;

  return {
    start: chicagoMidnightIso(startY, startM, startD),
    end: chicagoMidnightIso(endY, endM, endD),
    startDate: `${startY}-${pad(startM)}-${pad(startD)}`,
    endDate: `${endY}-${pad(endM)}-${pad(endD)}`,
    displayStart,
    displayEnd,
    displayLabel,
    label,
  };
}

/**
 * Resolves a relative date phrase to a {start, end} pair.
 * `end` is the exclusive upper bound (i.e. midnight of the day AFTER the
 * range), so filters should use `gte: start, lt: end`.
 *
 * Returns `null` if the phrase isn't recognized.
 */
export function resolveRelativeDateRange(phrase) {
  const p = phrase.trim().toLowerCase();
  const today = chicagoDateParts(new Date());
  const tomorrow = addDays(today.year, today.month, today.day, 1);

  // "today"
  if (p === "today") {
    return makeRange(
      today.year, today.month, today.day,
      tomorrow.year, tomorrow.month, tomorrow.day,
      "Today (Chicago)",
    );
  }

  // "yesterday"
  if (p === "yesterday") {
    const y = addDays(today.year, today.month, today.day, -1);
    return makeRange(
      y.year, y.month, y.day,
      today.year, today.month, today.day,
      "Yesterday (Chicago)",
    );
  }

  // "last week" / "last 7 days" / "past week"
  if (p === "last week" || p === "last 7 days" || p === "past week" || p === "past 7 days") {
    const start = addDays(today.year, today.month, today.day, -7);
    return makeRange(
      start.year, start.month, start.day,
      today.year, today.month, today.day,
      "Last 7 days (Chicago)",
    );
  }

  // "this week" — Monday-of-this-week through tomorrow midnight
  if (p === "this week" || p === "current week") {
    // Convert weekday (Sun=0..Sat=6) to days back to Monday.
    const daysBack = today.weekday === 0 ? 6 : today.weekday - 1;
    const start = addDays(today.year, today.month, today.day, -daysBack);
    return makeRange(
      start.year, start.month, start.day,
      tomorrow.year, tomorrow.month, tomorrow.day,
      "This week (Mon–today, Chicago)",
    );
  }

  // "last 30 days"
  if (p === "last 30 days" || p === "past 30 days") {
    const start = addDays(today.year, today.month, today.day, -30);
    return makeRange(
      start.year, start.month, start.day,
      today.year, today.month, today.day,
      "Last 30 days (Chicago)",
    );
  }

  // "last 90 days"
  if (p === "last 90 days" || p === "past 90 days") {
    const start = addDays(today.year, today.month, today.day, -90);
    return makeRange(
      start.year, start.month, start.day,
      today.year, today.month, today.day,
      "Last 90 days (Chicago)",
    );
  }

  // "this month"
  if (p === "this month" || p === "current month") {
    return makeRange(
      today.year, today.month, 1,
      today.month === 12 ? today.year + 1 : today.year,
      today.month === 12 ? 1 : today.month + 1,
      1,
      "This month (Chicago)",
    );
  }

  // "last month"
  if (p === "last month" || p === "previous month") {
    const lastMonthYear = today.month === 1 ? today.year - 1 : today.year;
    const lastMonth = today.month === 1 ? 12 : today.month - 1;
    return makeRange(
      lastMonthYear, lastMonth, 1,
      today.year, today.month, 1,
      "Last month (Chicago)",
    );
  }

  // "this year"
  if (p === "this year" || p === "current year" || p === "year to date" || p === "ytd") {
    return makeRange(
      today.year, 1, 1,
      today.year + 1, 1, 1,
      `${today.year} (Chicago)`,
    );
  }

  // "last year"
  if (p === "last year" || p === "previous year") {
    return makeRange(
      today.year - 1, 1, 1,
      today.year, 1, 1,
      `${today.year - 1} (Chicago)`,
    );
  }

  return null;
}
