/**
 * Truck Time Service
 *
 * Validates email sending windows based on truck schedules.
 * Integrates with the Supabase Edge Function to get first/last truck times.
 */

// Configuration
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;
const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || 'America/Chicago';
const EMAIL_TIME_WINDOW_ENABLED = process.env.EMAIL_TIME_WINDOW_ENABLED !== 'false';
const EMAIL_TIME_WINDOW_BUFFER_MINUTES = parseInt(process.env.EMAIL_TIME_WINDOW_BUFFER_MINUTES) || 0;

// Pre-cached Intl.DateTimeFormat instances (avoids re-creating per call)
const _dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});
const _timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: true
});

// Cache for getDailyTruckTimes (5-min TTL)
const _truckTimesCache = new Map();
const TRUCK_TIMES_CACHE_TTL = 5 * 60 * 1000;

/**
 * Get current date in the configured business timezone
 * @param {Date} date - Date to format
 * @returns {string} Date in YYYY-MM-DD format
 */
function getCurrentDateInTimezone(date = new Date()) {
  return _dateFormatter.format(date);
}

/**
 * Get current time formatted for logging in the business timezone
 * @param {Date} date - Date to format
 * @returns {string} Formatted time string
 */
function formatTimeInTimezone(date = new Date()) {
  return _timeFormatter.format(date);
}

/**
 * Fetch daily truck times from Supabase Edge Function
 * @param {string} date - Date in YYYY-MM-DD format
 * @returns {Promise<Object>} Truck times response
 */
async function getDailyTruckTimes(date) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('Supabase configuration missing for truck times API');
    return {
      date,
      first_truck_time: null,
      last_truck_time: null,
      error: 'Supabase configuration missing'
    };
  }

  // Check cache
  const cached = _truckTimesCache.get(date);
  if (cached && (Date.now() - cached.timestamp) < TRUCK_TIMES_CACHE_TTL) {
    return cached.data;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    const response = await fetch(
      `${SUPABASE_URL}/functions/v1/get-daily-truck-times?date=${date}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'apikey': SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
        signal: controller.signal
      }
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Edge function returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    console.log(`Truck times for ${date}:`, {
      first: data.first_truck_time,
      last: data.last_truck_time,
      source: `${data.first_truck_source}/${data.last_truck_source}`
    });

    // Cache the result
    _truckTimesCache.set(date, { data, timestamp: Date.now() });

    return data;
  } catch (error) {
    // Handle abort error specifically
    if (error.name === 'AbortError') {
      console.error(`Truck times API timeout for date ${date}`);
      return {
        date,
        first_truck_time: null,
        last_truck_time: null,
        error: 'Request timeout'
      };
    }

    console.error(`Failed to fetch truck times for ${date}:`, error.message);

    // Fail closed - don't send emails if we can't verify the window
    return {
      date,
      first_truck_time: null,
      last_truck_time: null,
      error: error.message
    };
  }
}

/**
 * Check if current time is within the email sending window
 * @param {Date} currentTime - The current timestamp
 * @param {string} firstTruckTime - ISO timestamp of first truck
 * @param {string} lastTruckTime - ISO timestamp of last truck
 * @returns {Object} { isWithinWindow: boolean, reason: string, details: Object }
 */
function isWithinTruckTimeWindow(currentTime, firstTruckTime, lastTruckTime) {
  if (!firstTruckTime || !lastTruckTime) {
    return {
      isWithinWindow: false,
      reason: 'No truck times available',
      details: { firstTruckTime, lastTruckTime }
    };
  }

  const now = currentTime instanceof Date ? currentTime : new Date(currentTime);
  const firstTruck = new Date(firstTruckTime);
  const lastTruck = new Date(lastTruckTime);

  // Validate parsed dates
  if (isNaN(firstTruck.getTime()) || isNaN(lastTruck.getTime())) {
    return {
      isWithinWindow: false,
      reason: 'Invalid truck time format',
      details: { firstTruckTime, lastTruckTime }
    };
  }

  // Check for invalid data (last before first)
  if (lastTruck < firstTruck) {
    return {
      isWithinWindow: false,
      reason: 'Invalid truck times: last truck is before first truck',
      details: { firstTruck: firstTruck.toISOString(), lastTruck: lastTruck.toISOString() }
    };
  }

  // Apply optional buffer
  const bufferMs = EMAIL_TIME_WINDOW_BUFFER_MINUTES * 60 * 1000;
  const windowStart = new Date(firstTruck.getTime() - bufferMs);
  const windowEnd = new Date(lastTruck.getTime() + bufferMs);

  if (now < windowStart) {
    return {
      isWithinWindow: false,
      reason: 'Before truck time window',
      details: {
        currentTime: now.toISOString(),
        currentTimeLocal: formatTimeInTimezone(now),
        windowStart: windowStart.toISOString(),
        firstTruck: firstTruck.toISOString(),
        bufferMinutes: EMAIL_TIME_WINDOW_BUFFER_MINUTES
      }
    };
  }

  if (now > windowEnd) {
    return {
      isWithinWindow: false,
      reason: 'After truck time window',
      details: {
        currentTime: now.toISOString(),
        currentTimeLocal: formatTimeInTimezone(now),
        windowEnd: windowEnd.toISOString(),
        lastTruck: lastTruck.toISOString(),
        bufferMinutes: EMAIL_TIME_WINDOW_BUFFER_MINUTES
      }
    };
  }

  return {
    isWithinWindow: true,
    reason: 'Within truck time window',
    details: {
      currentTime: now.toISOString(),
      currentTimeLocal: formatTimeInTimezone(now),
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString()
    }
  };
}

/**
 * Check if order data belongs to today's date
 * @param {string} orderDate - Date from order data (YYYY-MM-DD)
 * @param {string} todayDate - Today's date (YYYY-MM-DD)
 * @returns {Object} { isCurrentDay: boolean, reason: string }
 */
function isCurrentDayData(orderDate, todayDate) {
  if (!orderDate) {
    return {
      isCurrentDay: false,
      reason: 'Order date is missing'
    };
  }

  // Normalize both dates to YYYY-MM-DD format
  const normalizedOrderDate = orderDate.substring(0, 10);
  const normalizedTodayDate = todayDate.substring(0, 10);

  if (normalizedOrderDate === normalizedTodayDate) {
    return {
      isCurrentDay: true,
      reason: 'Order date matches today'
    };
  }

  return {
    isCurrentDay: false,
    reason: `Order date (${normalizedOrderDate}) does not match today (${normalizedTodayDate})`
  };
}

/**
 * Main validation function - determines if email should be sent
 * @param {Object} options
 * @param {string} options.orderDate - The date of the order data (YYYY-MM-DD)
 * @param {Date} options.currentTime - Current timestamp (optional, defaults to now)
 * @returns {Promise<Object>} { shouldSendEmail: boolean, reason: string, details: Object }
 */
async function validateEmailSendingWindow({ orderDate, currentTime }) {
  // Check if feature is enabled
  if (!EMAIL_TIME_WINDOW_ENABLED) {
    return {
      shouldSendEmail: true,
      reason: 'Email time window validation is disabled',
      details: { featureEnabled: false }
    };
  }

  const now = currentTime || new Date();
  const todayDate = getCurrentDateInTimezone(now);

  console.log(`Validating email window: orderDate=${orderDate}, today=${todayDate}, time=${formatTimeInTimezone(now)}`);

  // Step 1: Date validation - Is order data for today?
  const dateCheck = isCurrentDayData(orderDate, todayDate);

  if (!dateCheck.isCurrentDay) {
    return {
      shouldSendEmail: false,
      reason: dateCheck.reason,
      details: {
        check: 'date_mismatch',
        orderDate,
        todayDate,
        timezone: BUSINESS_TIMEZONE
      }
    };
  }

  // Step 2: Fetch truck times for today
  const truckTimes = await getDailyTruckTimes(todayDate);

  // Step 3: Handle edge function error
  if (truckTimes.error) {
    return {
      shouldSendEmail: false,
      reason: `Failed to fetch truck times: ${truckTimes.error}`,
      details: {
        check: 'edge_function_error',
        error: truckTimes.error,
        todayDate
      }
    };
  }

  // Step 4: Handle no schedules scenario
  if (!truckTimes.first_truck_time || !truckTimes.last_truck_time) {
    return {
      shouldSendEmail: false,
      reason: 'No truck schedules found for today',
      details: {
        check: 'no_schedules',
        truckTimes,
        todayDate
      }
    };
  }

  // Step 5: Time window validation
  const timeCheck = isWithinTruckTimeWindow(
    now,
    truckTimes.first_truck_time,
    truckTimes.last_truck_time
  );

  if (!timeCheck.isWithinWindow) {
    return {
      shouldSendEmail: false,
      reason: timeCheck.reason,
      details: {
        check: 'outside_time_window',
        ...timeCheck.details,
        firstTruckSource: truckTimes.first_truck_source,
        lastTruckSource: truckTimes.last_truck_source
      }
    };
  }

  // All validations passed
  return {
    shouldSendEmail: true,
    reason: 'Within valid email sending window',
    details: {
      check: 'passed',
      orderDate,
      todayDate,
      timezone: BUSINESS_TIMEZONE,
      currentTime: now.toISOString(),
      currentTimeLocal: formatTimeInTimezone(now),
      firstTruckTime: truckTimes.first_truck_time,
      lastTruckTime: truckTimes.last_truck_time,
      firstTruckSource: truckTimes.first_truck_source,
      lastTruckSource: truckTimes.last_truck_source
    }
  };
}

module.exports = {
  getDailyTruckTimes,
  isWithinTruckTimeWindow,
  isCurrentDayData,
  validateEmailSendingWindow,
  getCurrentDateInTimezone,
  formatTimeInTimezone
};
