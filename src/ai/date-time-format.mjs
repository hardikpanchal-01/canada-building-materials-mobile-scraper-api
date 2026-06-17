/**
 * Date/Time formatting utility (ported from the web app's @/lib/date-time-format).
 * Pure JS — uses Intl only. date-resolver.mjs imports formatDate from here.
 */

export const DEFAULT_DATE_TIME_FORMAT = {
  dateFormat: 'MM/dd/yyyy',
  timeFormat: '24h',
  showTimezone: true,
};

export const DEFAULT_TIMEZONE = 'America/Chicago';

export const DATE_FORMAT_OPTIONS = [
  { value: 'ddMMMyyyy', label: 'ddMMMyyyy', example: '26Mar2026' },
  { value: 'MM/dd/yyyy', label: 'MM/dd/yyyy', example: '03/26/2026' },
  { value: 'dd/MM/yyyy', label: 'dd/MM/yyyy', example: '26/03/2026' },
  { value: 'yyyy-MM-dd', label: 'yyyy-MM-dd', example: '2026-03-26' },
  { value: 'MMM dd, yyyy', label: 'MMM dd, yyyy', example: 'Mar 26, 2026' },
  { value: 'dd MMM yyyy', label: 'dd MMM yyyy', example: '26 Mar 2026' },
];

export const TIME_FORMAT_OPTIONS = [
  { value: '24h', label: '24-hour', example: '14:30' },
  { value: '12h', label: '12-hour', example: '02:30 PM' },
];

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function getDatePartsInTimezone(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = formatter.formatToParts(date);
  const getValue = (type) => parts.find((p) => p.type === type)?.value || '';
  return {
    year: parseInt(getValue('year'), 10),
    month: parseInt(getValue('month'), 10),
    day: parseInt(getValue('day'), 10),
    hours: parseInt(getValue('hour'), 10),
    minutes: parseInt(getValue('minute'), 10),
    weekday: getValue('weekday'),
  };
}

function getTimezoneAbbreviation(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'short',
  });
  const parts = formatter.formatToParts(date);
  return parts.find((p) => p.type === 'timeZoneName')?.value || '';
}

function pad(n) {
  return n.toString().padStart(2, '0');
}

export function formatDate(date, preference, options) {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';
  const pref = { ...DEFAULT_DATE_TIME_FORMAT, ...preference };
  const timezone = options?.timezone || DEFAULT_TIMEZONE;
  const { year, month, day } = getDatePartsInTimezone(d, timezone);
  const monthAbbr = MONTH_ABBR[month - 1];
  switch (pref.dateFormat) {
    case 'ddMMMyyyy':
      return `${pad(day)}${monthAbbr}${year}`;
    case 'MM/dd/yyyy':
      return `${pad(month)}/${pad(day)}/${year}`;
    case 'dd/MM/yyyy':
      return `${pad(day)}/${pad(month)}/${year}`;
    case 'yyyy-MM-dd':
      return `${year}-${pad(month)}-${pad(day)}`;
    case 'MMM dd, yyyy':
      return `${monthAbbr} ${pad(day)}, ${year}`;
    case 'dd MMM yyyy':
      return `${pad(day)} ${monthAbbr} ${year}`;
    default:
      return `${pad(day)}${monthAbbr}${year}`;
  }
}

export function formatOrderDate(date, preference) {
  return formatDate(date, preference, { timezone: 'UTC' });
}

export function formatTime(date, preference, options) {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';
  const pref = { ...DEFAULT_DATE_TIME_FORMAT, ...preference };
  const timezone = options?.timezone || DEFAULT_TIMEZONE;
  const { hours, minutes } = getDatePartsInTimezone(d, timezone);
  let timeStr;
  if (pref.timeFormat === '24h') {
    timeStr = `${pad(hours)}:${pad(minutes)}`;
  } else {
    const h = hours % 12 || 12;
    const ampm = hours >= 12 ? 'PM' : 'AM';
    timeStr = `${pad(h)}:${pad(minutes)} ${ampm}`;
  }
  if (pref.showTimezone) {
    const tzAbbr = getTimezoneAbbreviation(d, timezone);
    timeStr = `${timeStr} ${tzAbbr}`;
  }
  return timeStr;
}

export function formatDateTime(date, preference, options) {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';
  const datePart = formatDate(d, preference, options);
  const timePart = formatTime(d, { ...preference, showTimezone: false }, options);
  const pref = { ...DEFAULT_DATE_TIME_FORMAT, ...preference };
  let result = `${datePart} ${timePart}`;
  if (pref.showTimezone) {
    const timezone = options?.timezone || DEFAULT_TIMEZONE;
    const tzAbbr = getTimezoneAbbreviation(d, timezone);
    result = `${result} ${tzAbbr}`;
  }
  return result;
}

export function formatTimeOnly(timeString, preference) {
  if (!timeString) return '';
  let timePart = timeString;
  if (timeString.includes('T')) {
    timePart = timeString.split('T')[1]?.split('+')[0]?.split('Z')[0] || '';
  } else if (timeString.includes(' ') && timeString.includes(':')) {
    timePart = timeString.split(' ')[1]?.split('+')[0] || '';
  }
  if (!timePart || !timePart.includes(':')) return '';
  const [hoursStr, minutesStr] = timePart.split(':');
  if (!hoursStr || !minutesStr) return '';
  const hours = parseInt(hoursStr, 10);
  const minutes = parseInt(minutesStr, 10);
  if (isNaN(hours) || isNaN(minutes)) return '';
  const pref = { ...DEFAULT_DATE_TIME_FORMAT, ...preference };
  if (pref.timeFormat === '24h') {
    return `${pad(hours)}:${pad(minutes)}`;
  }
  const h = hours % 12 || 12;
  const ampm = hours >= 12 ? 'PM' : 'AM';
  return `${pad(h)}:${pad(minutes)} ${ampm}`;
}

export function getFormatPreview(preference, options) {
  return formatDateTime(new Date(), preference, options);
}

export function isValidPreference(preference) {
  if (!preference || typeof preference !== 'object') return false;
  const pref = preference;
  const validDateFormats = ['ddMMMyyyy', 'MM/dd/yyyy', 'dd/MM/yyyy', 'yyyy-MM-dd', 'MMM dd, yyyy', 'dd MMM yyyy'];
  const validTimeFormats = ['24h', '12h'];
  return (
    typeof pref.dateFormat === 'string' &&
    validDateFormats.includes(pref.dateFormat) &&
    typeof pref.timeFormat === 'string' &&
    validTimeFormats.includes(pref.timeFormat) &&
    typeof pref.showTimezone === 'boolean'
  );
}

export function parsePreference(value) {
  if (isValidPreference(value)) return value;
  return DEFAULT_DATE_TIME_FORMAT;
}
