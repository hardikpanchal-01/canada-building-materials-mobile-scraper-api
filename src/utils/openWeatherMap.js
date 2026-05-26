/**
 * OpenWeatherMap API Utility
 * Handles weather data fetching, geocoding, and ACI 305R concrete evaporation calculation.
 * Ported from web: truckast-dolese-readymix-frontend/src/lib/weather-api.ts
 */

const OPENWEATHERMAP_BASE_URL = 'https://api.openweathermap.org/data/2.5';
const OPENWEATHERMAP_GEO_URL = 'https://api.openweathermap.org/geo/1.0';

// Cache duration: 5 minutes (ms)
const TICKET_WEATHER_CACHE_DURATION_MS = 5 * 60 * 1000;

function getApiKey() {
  const apiKey = process.env.OPENWEATHERMAP_API_KEY;
  if (!apiKey) {
    throw new Error('OPENWEATHERMAP_API_KEY environment variable is not set');
  }
  return apiKey;
}

/**
 * Fetch current weather by coordinates (imperial units → Fahrenheit)
 */
async function fetchWeatherByCoordinates(lat, lon) {
  try {
    const apiKey = getApiKey();
    const url = `${OPENWEATHERMAP_BASE_URL}/weather?lat=${lat}&lon=${lon}&units=imperial&appid=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[WEATHER API] Failed to fetch weather: ${response.status} ${response.statusText}`);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error('[WEATHER API] Error fetching weather:', error);
    return null;
  }
}

/**
 * Geocode an address to get coordinates
 */
async function geocodeAddress(address) {
  try {
    const apiKey = getApiKey();
    const encodedAddress = encodeURIComponent(address);
    const url = `${OPENWEATHERMAP_GEO_URL}/direct?q=${encodedAddress}&limit=1&appid=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[WEATHER API] Failed to geocode: ${response.status} ${response.statusText}`);
      return null;
    }
    const data = await response.json();
    if (!data || data.length === 0) {
      console.warn(`[WEATHER API] No geocoding results for: ${address}`);
      return null;
    }
    return data[0]; // { lat, lon, name, country, ... }
  } catch (error) {
    console.error('[WEATHER API] Error geocoding:', error);
    return null;
  }
}

/**
 * Build address string from address parts
 */
function buildAddressString(addr1, addr2, addr3) {
  return [addr1, addr2, addr3]
    .filter(part => part && part.trim() !== '')
    .map(part => part.trim())
    .join(', ');
}

/**
 * Parse coordinate from string/number to number or null
 */
function parseCoordinate(coord) {
  if (coord == null) return null;
  const parsed = parseFloat(coord);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Check if cached weather data is still valid
 */
function isCacheValid(fetchedAt, cacheDurationMs) {
  if (!fetchedAt) return false;
  const fetchedTime = new Date(fetchedAt).getTime();
  return (Date.now() - fetchedTime) < cacheDurationMs;
}

// ---- Derived calculations (matching web route.ts) ----

/**
 * Convert wind degrees to 16-point compass direction
 */
function getWindDirection(deg) {
  const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const index = Math.round(deg / 22.5) % 16;
  return directions[index];
}

/**
 * Calculate dew point in Fahrenheit
 */
function calculateDewPointF(tempF, humidity) {
  const tempC = (tempF - 32) * 5 / 9;
  const dewPointC = tempC - ((100 - humidity) / 5);
  return (dewPointC * 9 / 5) + 32;
}

/**
 * hPa → inHg
 */
function hpaToInhg(hpa) {
  return hpa * 0.02953;
}

/**
 * Air-based evaporation rate (lbs/ft²/hr)
 * Formula: E = (1 + 0.4 * W) * (T - D) / 100
 */
function calculateEvaporationRate(tempF, dewPointF, windSpeedMph) {
  const rate = (1 + 0.4 * windSpeedMph) * (tempF - dewPointF) / 100;
  return Math.max(0, rate);
}

/**
 * Air evaporation risk level
 */
function getEvaporationLevel(rate) {
  if (rate < 0.1) return 'Low';
  if (rate < 0.2) return 'Moderate';
  return 'High';
}

/**
 * Extract concrete temperature from verifi data.
 * Priority: temperatureAtDischarge → temperatureAtArrival → temperatureAtLeavePlant
 */
function getConcreteTemp(verifi) {
  if (!verifi || typeof verifi !== 'object') return null;

  const sources = [
    { field: 'temperatureAtDischarge', label: 'Discharge' },
    { field: 'temperatureAtArrival', label: 'Arrival' },
    { field: 'temperatureAtLeavePlant', label: 'Leave Plant' },
  ];

  for (const src of sources) {
    const tempData = verifi[src.field];
    if (tempData && typeof tempData === 'object' && tempData.temperatureUnitsValue != null && tempData.temperatureUnitsValue !== '') {
      const parsed = parseFloat(tempData.temperatureUnitsValue);
      if (!isNaN(parsed)) {
        return { fahrenheit: parsed, usedField: src.label };
      }
    }
  }
  return null;
}

/**
 * ACI 305R Concrete Evaporation Rate (kg/m²/hr)
 * E = 5 × [(Tc + 18)^2.5 − r × (Ta + 18)^2.5] × (V + 4) × 10⁻⁶
 *
 * Tc = concrete temp (°C), from verifi or estimated (air + 10°F)
 * Ta = air temp (°C)
 * r  = relative humidity (0-1)
 * V  = wind speed (km/h)
 */
function calculateConcreteEvaporation(verifi, airTempF, humidity, windSpeedMph) {
  try {
    const concreteTempData = verifi ? getConcreteTemp(verifi) : null;

    let Tc, tempSource, isEstimated, tempUsedF;

    if (concreteTempData) {
      tempUsedF = concreteTempData.fahrenheit;
      Tc = (tempUsedF - 32) * 5 / 9;
      tempSource = concreteTempData.usedField;
      isEstimated = false;
    } else {
      tempUsedF = airTempF + 10;
      Tc = (tempUsedF - 32) * 5 / 9;
      tempSource = 'Estimated from Air Temp';
      isEstimated = true;
    }

    const Ta = (airTempF - 32) * 5 / 9;
    const r = humidity / 100;
    const V = windSpeedMph * 1.60934; // mph → km/h

    const concreteFactor = Math.pow(Tc + 18, 2.5);
    const airFactor = r * Math.pow(Ta + 18, 2.5);
    const windFactor = V + 4;

    const E = 5 * (concreteFactor - airFactor) * windFactor * 1e-6;

    const rate_kg_m2_hr = Math.max(0, E);
    const rate_m3_m2_hr = rate_kg_m2_hr * 0.001;
    const rate_yd3_m2_hr = rate_m3_m2_hr * 1.30795;

    const level = E < 0.10 ? 'Low'
                : E < 0.20 ? 'Moderate'
                : E < 0.50 ? 'High'
                : 'Critical';

    return {
      rate_kg_m2_hr: Math.max(0, parseFloat(E.toFixed(4))),
      rate_yd3_hr: parseFloat(rate_yd3_m2_hr.toFixed(6)),
      level,
      temp_used_f: tempUsedF,
      temp_source: tempSource,
      is_estimated: isEstimated
    };
  } catch (error) {
    console.error('[WEATHER] Error calculating concrete evaporation:', error);
    return null;
  }
}

/**
 * Build the full TicketWeatherData object from OpenWeatherMap response + verifi.
 * Matches the shape stored in tickets.weather_data on the web side.
 */
function buildTicketWeatherData(weatherResponse, lat, lon, source, verifiJson) {
  const tempF = weatherResponse.main.temp;
  const tempC = (tempF - 32) * 5 / 9;
  const dewPoint = calculateDewPointF(tempF, weatherResponse.main.humidity);
  const evaporationRate = calculateEvaporationRate(tempF, dewPoint, weatherResponse.wind.speed);
  const evaporationLevel = getEvaporationLevel(evaporationRate);

  const concreteEvap = calculateConcreteEvaporation(
    verifiJson,
    tempF,
    weatherResponse.main.humidity,
    weatherResponse.wind.speed
  );

  return {
    temperature_fahrenheit: Math.round(tempF),
    temperature_celsius: Math.round(tempC),
    temperature_max_fahrenheit: Math.round(weatherResponse.main.temp_max),
    temperature_min_fahrenheit: Math.round(weatherResponse.main.temp_min),
    weather_condition: weatherResponse.weather?.[0]?.main || 'Unknown',
    weather_icon: weatherResponse.weather?.[0]?.icon || '01d',
    weather_description: weatherResponse.weather?.[0]?.description || 'unknown',
    humidity: weatherResponse.main.humidity,
    wind_speed: weatherResponse.wind.speed,
    wind_speed_mph: weatherResponse.wind.speed,
    wind_gust: weatherResponse.wind.gust ?? null,
    wind_direction: getWindDirection(weatherResponse.wind.deg),
    wind_direction_degrees: weatherResponse.wind.deg,
    pressure_hpa: weatherResponse.main.pressure,
    pressure_inhg: Math.round(hpaToInhg(weatherResponse.main.pressure) * 100) / 100,
    dew_point_fahrenheit: Math.round(dewPoint * 10) / 10,
    clouds_percentage: weatherResponse.clouds?.all ?? 0,
    visibility_meters: weatherResponse.visibility ?? null,
    evaporation_rate: evaporationRate,
    evaporation_level: evaporationLevel,
    concrete_evaporation_rate: concreteEvap?.rate_kg_m2_hr ?? null,
    concrete_evaporation_level: concreteEvap?.level ?? null,
    concrete_temperature_fahrenheit: concreteEvap?.temp_used_f ?? null,
    concrete_temperature_source: concreteEvap?.temp_source ?? null,
    concrete_temperature_is_estimated: concreteEvap?.is_estimated ?? null,
    latitude: lat,
    longitude: lon,
    fetched_at: new Date().toISOString(),
    source
  };
}

module.exports = {
  TICKET_WEATHER_CACHE_DURATION_MS,
  fetchWeatherByCoordinates,
  geocodeAddress,
  buildAddressString,
  parseCoordinate,
  isCacheValid,
  getWindDirection,
  calculateDewPointF,
  hpaToInhg,
  calculateEvaporationRate,
  getEvaporationLevel,
  getConcreteTemp,
  calculateConcreteEvaporation,
  buildTicketWeatherData
};
