const express = require('express');
const router = express.Router();
const { getSupabaseAdmin } = require('../config/database');

/**
 * Get the current timezone abbreviation (handles DST automatically).
 * E.g. returns "CDT" in summer, "CST" in winter for America/Chicago.
 */
function getCurrentAbbreviation(ianaCode) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: ianaCode,
      timeZoneName: 'short',
    }).formatToParts(new Date());
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    return tzPart?.value || null;
  } catch {
    return null;
  }
}

/**
 * Get the current UTC offset for a timezone (handles DST).
 * Returns e.g. "-05:00" for CDT, "-06:00" for CST.
 */
function getCurrentUtcOffset(ianaCode) {
  try {
    const now = new Date();
    const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC' });
    const tzStr = now.toLocaleString('en-US', { timeZone: ianaCode });
    const diffMs = new Date(tzStr) - new Date(utcStr);
    const totalMinutes = Math.round(diffMs / 60000);
    const sign = totalMinutes >= 0 ? '+' : '-';
    const absMinutes = Math.abs(totalMinutes);
    const hours = String(Math.floor(absMinutes / 60)).padStart(2, '0');
    const minutes = String(absMinutes % 60).padStart(2, '0');
    return `${sign}${hours}:${minutes}`;
  } catch {
    return null;
  }
}

/**
 * Get the current time in a timezone formatted as "10:15 AM EDT".
 */
function getCurrentTime(ianaCode, now) {
  try {
    const abbr = getCurrentAbbreviation(ianaCode) || '';
    const time = new Intl.DateTimeFormat('en-US', {
      timeZone: ianaCode,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(now);
    return abbr ? `${time} ${abbr}` : time;
  } catch {
    return null;
  }
}

/**
 * Get the current full datetime in a timezone formatted as "May 04, 2026 10:15 AM EDT".
 */
function getCurrentDateTime(ianaCode, now) {
  try {
    const abbr = getCurrentAbbreviation(ianaCode) || '';
    const datetime = new Intl.DateTimeFormat('en-US', {
      timeZone: ianaCode,
      month: 'short',
      day: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(now);
    return abbr ? `${datetime} ${abbr}` : datetime;
  } catch {
    return null;
  }
}

/**
 * @route   GET /api/timezones
 * @desc    Get list of available timezones from DB with current abbreviation and offset
 * @access  Public
 */
router.get('/', async (req, res) => {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('timezones')
      .select('id, iana_code, display_name, abbreviation, utc_offset, dst_offset')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (error) {
      console.error('[Timezones] DB error:', error.message);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch timezones',
      });
    }

    // Add current abbreviation, current UTC offset, and current time (DST-aware)
    const now = new Date();
    const enriched = (data || []).map(tz => ({
      ...tz,
      current_abbreviation: getCurrentAbbreviation(tz.iana_code) || tz.abbreviation,
      current_utc_offset: getCurrentUtcOffset(tz.iana_code) || tz.utc_offset,
      current_time: getCurrentTime(tz.iana_code, now),
      current_datetime: getCurrentDateTime(tz.iana_code, now),
    }));

    return res.status(200).json({
      success: true,
      data: enriched,
    });
  } catch (err) {
    console.error('[Timezones] Error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch timezones',
    });
  }
});

module.exports = router;
