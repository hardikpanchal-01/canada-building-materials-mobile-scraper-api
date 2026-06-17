/**
 * Weather Service
 * 
 * Provides business logic for weather data retrieval, calculations,
 * and product recommendations based on weather conditions.
 */

const { executeDirectSQL } = require('../utils/postgresExecutor');

// Weather data cache by plant_id (3-minute TTL)
const _weatherCache = new Map();
const WEATHER_CACHE_TTL = 3 * 60 * 1000;

/**
 * Calculate dew point from temperature and humidity
 * @param {number} tempF - Temperature in Fahrenheit
 * @param {number} humidity - Relative humidity percentage
 * @returns {number} Dew point in Fahrenheit
 */
function calculateDewPoint(tempF, humidity) {
  if (!tempF || !humidity) return null;
  
  // Convert to Celsius for calculation
  const tempC = (tempF - 32) * 5 / 9;
  
  // Magnus formula for dew point
  const a = 17.27;
  const b = 237.7;
  const alpha = ((a * tempC) / (b + tempC)) + Math.log(humidity / 100.0);
  const dewPointC = (b * alpha) / (a - alpha);
  
  // Convert back to Fahrenheit
  return (dewPointC * 9 / 5) + 32;
}

/**
 * Calculate atmospheric pressure (approximate based on elevation)
 * Standard sea level pressure is 29.92 inHg
 * @param {number} elevation - Elevation in meters (optional)
 * @returns {number} Pressure in inches of mercury
 */
function calculatePressure(elevation = 0) {
  // Barometric formula approximation
  // Pressure decreases by about 1 inHg per 1000 feet of elevation
  const elevationFeet = elevation * 3.28084;
  const pressureDrop = elevationFeet / 1000;
  return Math.max(25, 30.15 - pressureDrop); // Clamp minimum at 25
}

/**
 * Calculate concrete temperature
 * Checks for concrete_temperature field in weather data, otherwise calculates
 * @param {object} weatherData - Weather data object
 * @param {number} airTempF - Air temperature in Fahrenheit
 * @returns {number} Concrete temperature
 */
function calculateConcreteTemperature(weatherData, airTempF) {
  // Check if concrete_temperature field exists in plant_weather
  if (weatherData && weatherData.concrete_temperature != null) {
    return parseFloat(weatherData.concrete_temperature);
  }
  
  // Fallback calculation
  if (!airTempF) return null;
  
  // For low temps, concrete might be slightly warmer due to hydration
  if (airTempF < 40) {
    return airTempF + 5; // Slight increase for low temps
  }
  return airTempF + 2; // Small increase for normal temps
}

/**
 * Calculate evaporation rate
 * @param {number} tempF - Temperature in Fahrenheit
 * @param {number} humidity - Relative humidity percentage
 * @param {number} windSpeed - Wind speed in m/s
 * @returns {object} Evaporation rate data
 */
function calculateEvaporationRate(tempF, humidity, windSpeed) {
  if (!tempF || !humidity) {
    return {
      rate: 0,
      status: 'Low',
      description: 'Low for the rest of the day.'
    };
  }

  // Simplified evaporation calculation
  // Higher temp, lower humidity, higher wind = higher evaporation
  const tempFactor = (tempF - 32) / 100; // Normalized temp factor
  const humidityFactor = (100 - humidity) / 100; // Inverse humidity
  const windFactor = (windSpeed || 0) / 10; // Normalized wind
  
  const evaporationIndex = (tempFactor * 0.4) + (humidityFactor * 0.4) + (windFactor * 0.2);
  
  let status, description;
  if (evaporationIndex < 0.2) {
    status = 'Low';
    description = 'Low for the rest of the day.';
  } else if (evaporationIndex < 0.5) {
    status = 'Moderate';
    description = 'Moderate evaporation expected.';
  } else {
    status = 'High';
    description = 'High evaporation rate. Monitor concrete closely.';
  }

  return {
    rate: Math.round(evaporationIndex * 100) / 100,
    status,
    description
  };
}

/**
 * Determine product recommendations based on weather conditions
 * @param {number} tempF - Temperature in Fahrenheit
 * @param {number} humidity - Relative humidity percentage
 * @param {number} windSpeed - Wind speed in m/s
 * @returns {array} Array of recommendation objects
 */
function getProductRecommendations(tempF, humidity, windSpeed) {
  const recommendations = [];
  
  // Thermal cracking risk
  if (tempF < 40) {
    recommendations.push({
      type: 'thermal_cracking',
      label: 'Termal Cracking',
      severity: 'high',
      color: 'red',
      description: 'Low temperature increases thermal cracking risk.'
    });
  } else if (tempF < 50) {
    recommendations.push({
      type: 'thermal_cracking',
      label: 'Termal Cracking',
      severity: 'moderate',
      color: 'orange',
      description: 'Moderate temperature - monitor for thermal cracking.'
    });
  }
  
  // Plastic cracking risk
  const evaporation = calculateEvaporationRate(tempF, humidity, windSpeed);
  if (evaporation.status === 'High' || (tempF > 75 && humidity < 50)) {
    recommendations.push({
      type: 'plastic_cracking',
      label: 'Plastic Cracking',
      severity: 'high',
      color: 'yellow',
      description: 'High evaporation rate increases plastic cracking risk.'
    });
  } else if (evaporation.status === 'Moderate') {
    recommendations.push({
      type: 'plastic_cracking',
      label: 'Plastic Cracking',
      severity: 'moderate',
      color: 'yellow',
      description: 'Moderate evaporation - monitor for plastic cracking.'
    });
  }
  
  return recommendations;
}

/**
 * Determine weather status/cracking risk
 * @param {number} tempF - Temperature in Fahrenheit
 * @param {number} humidity - Relative humidity percentage
 * @param {number} windSpeed - Wind speed in m/s
 * @returns {string} Status description
 */
function getWeatherStatus(tempF, humidity, windSpeed) {
  if (!tempF) return 'Unknown';
  
  const evaporation = calculateEvaporationRate(tempF, humidity, windSpeed);
  
  if (tempF < 40) {
    return 'Shrinking Cracking';
  } else if (evaporation.status === 'High') {
    return 'Plastic Shrinkage Cracking';
  } else if (tempF > 85) {
    return 'Thermal Cracking';
  } else {
    return 'Normal Conditions';
  }
}

/**
 * Format date as MM-DD-YYYY for mobile screen
 * @param {string|Date} dateString - Date string or Date object
 * @returns {string} Formatted date string (MM-DD-YYYY)
 */
function formatDateForMobile(dateString) {
  if (!dateString) return null;
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return null;
    // Use UTC methods to avoid server timezone shifting dates
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const year = date.getUTCFullYear();
    return `${month}-${day}-${year}`;
  } catch (e) {
    return null;
  }
}

/**
 * Extract city name from delivery address
 * @param {string} address - Full delivery address
 * @returns {string} City name or address
 */
function extractLocationName(address) {
  if (!address) return null;
  
  // Try to extract city name from address
  // Common patterns: "City, State" or "City State ZIP"
  const cityMatch = address.match(/([^,]+),?\s*[A-Z]{2}\s*\d{5}/i);
  if (cityMatch) {
    return cityMatch[1].trim();
  }
  
  // If no pattern matches, return first part of address
  const parts = address.split(',');
  if (parts.length > 0) {
    return parts[0].trim();
  }
  
  return address;
}

/**
 * Get weather data by plant ID
 * @param {number} plantId - Plant ID
 * @returns {Promise<object|null>} Weather data
 */
async function getWeatherByPlantId(plantId) {
  if (!plantId) {
    throw new Error('Plant ID is required');
  }

  // Check cache
  const cached = _weatherCache.get(plantId);
  if (cached && (Date.now() - cached.timestamp) < WEATHER_CACHE_TTL) {
    return cached.data;
  }

  // Fetch weather data (no unnecessary plants JOIN — joined columns were never used)
  const sql = `
    SELECT pw.*
    FROM plant_weather pw
    WHERE pw.plant_id = $1
    ORDER BY pw.fetched_at DESC
    LIMIT 1
  `;

  try {
    const result = await executeDirectSQL(sql, [plantId]);
    const data = result.data?.[0] || null;
    if (data) _weatherCache.set(plantId, { data, timestamp: Date.now() });
    return data;
  } catch (error) {
    console.error('Error fetching weather by plant ID:', error);
    throw error;
  }
}

/**
 * Get weather update data for a specific order
 * Includes order information and comprehensive weather metrics
 * @param {string} orderId - Order ID (optional if orderCode provided)
 * @param {string} orderCode - Order Code (optional if orderId provided)
 * @param {number} plantId - Optional plant ID (if not provided, will try to get from order)
 * @returns {Promise<object>} Weather update data
 */
async function getWeatherUpdate(orderId = null, orderCode = null, plantId = null) {
  if (!orderId && !orderCode && !plantId) {
    throw new Error('Either Order ID, Order Code, or Plant ID is required');
  }

  let weatherData = null;
  let orderData = null;
  let resolvedOrderId = orderId;

  // Get order data (with plant_id in a single query when possible)
  if (orderCode || orderId) {
    let orderSql;
    let orderParams;

    // Combined query: get order + plant_id from tickets in one shot
    const addressExpr = `TRIM(BOTH ', ' FROM
            COALESCE(NULLIF(o.delivery_addr1, ''), '') ||
            CASE WHEN o.delivery_addr2 IS NOT NULL AND o.delivery_addr2 != '' THEN ', ' || o.delivery_addr2 ELSE '' END ||
            CASE WHEN o.delivery_addr3 IS NOT NULL AND o.delivery_addr3 != '' THEN ', ' || o.delivery_addr3 ELSE '' END
          )`;

    if (orderCode) {
      orderSql = `
        SELECT
          o.order_id, o.order_code, o.order_date, o.customer_name,
          ${addressExpr} as delivery_address, o.delivery_addr1,
          (SELECT t.plant_id FROM tickets t WHERE t.order_id = o.order_id LIMIT 1) as ticket_plant_id
        FROM orders o
        WHERE TRIM(o.order_code) = $1
        LIMIT 1
      `;
      const normalizedOrderCode = String(orderCode).trim().toUpperCase();
      orderParams = [normalizedOrderCode];
    } else {
      orderSql = `
        SELECT
          o.order_id, o.order_code, o.order_date, o.customer_name,
          ${addressExpr} as delivery_address, o.delivery_addr1,
          (SELECT t.plant_id FROM tickets t WHERE t.order_id = o.order_id LIMIT 1) as ticket_plant_id
        FROM orders o
        WHERE o.order_id = $1
        LIMIT 1
      `;
      orderParams = [orderId];
    }

    try {
      const orderResult = await executeDirectSQL(orderSql, orderParams);
      orderData = orderResult.data?.[0];

      if (orderData) {
        resolvedOrderId = orderData.order_id;
        if (!plantId && orderData.ticket_plant_id) {
          plantId = orderData.ticket_plant_id;
        }
      }
    } catch (error) {
      console.error('[getWeatherUpdate] Error fetching order data:', error.message);
    }
  }

  // Get weather data
  if (plantId) {
    weatherData = await getWeatherByPlantId(plantId);
    if (!weatherData) {
      console.warn(`[getWeatherUpdate] No weather data found for plant_id: ${plantId}`);
    }
  } else {
    console.warn('[getWeatherUpdate] No plant_id available to fetch weather data');
  }

  // If no weather data found, return structure with order data but null weather
  if (!weatherData) {
    return {
      order: orderData ? {
        order_code: orderData.order_code || null,
        date: formatDateForMobile(orderData.order_date) || null
      } : null,
      location: {
        name: orderData?.delivery_addr1 ? extractLocationName(orderData.delivery_addr1) : null,
        latitude: null,
        longitude: null
      },
      weather: null,
      metrics: null,
      recommendations: []
    };
  }

  const tempF = parseFloat(weatherData.temperature_fahrenheit) || 0;
  const humidity = parseInt(weatherData.humidity) || 0;
  const windSpeed = parseFloat(weatherData.wind_speed) || 0;
  const dewPoint = calculateDewPoint(tempF, humidity);
  const pressure = calculatePressure();
  const concreteTemp = calculateConcreteTemperature(weatherData, tempF);
  const evaporation = calculateEvaporationRate(tempF, humidity, windSpeed);
  const recommendations = getProductRecommendations(tempF, humidity, windSpeed);

  // Calculate precipitation min/max (simplified - in real app, this would come from forecast)
  const precipMax = tempF + 3;
  const precipMin = tempF - 3;

  // Get location name
  let locationName = null;
  if (orderData?.delivery_addr1) {
    locationName = extractLocationName(orderData.delivery_addr1);
  }

  // Get latitude/longitude from weather data or plants table
  let latitude = parseFloat(weatherData.latitude) || null;
  let longitude = parseFloat(weatherData.longitude) || null;

  return {
    order: orderData ? {
      order_code: orderData.order_code,
      date: formatDateForMobile(orderData.order_date)
    } : null,
    location: {
      name: locationName || 'Unknown',
      latitude: latitude,
      longitude: longitude
    },
    weather: {
      temperature: tempF,
      condition: weatherData.weather_condition || 'Unknown',
      icon: weatherData.weather_icon || 'partly-cloudy',
      description: weatherData.weather_description || '',
      precipitation: {
        max: precipMax,
        min: precipMin
      }
    },
    metrics: {
      evaporation: {
        value: evaporation.rate,
        status: evaporation.status,
        description: evaporation.description,
        progress: Math.min(100, Math.max(0, evaporation.rate * 100))
      },
      concrete: {
        temperature: concreteTemp,
        description: 'Similar to the actual temperature'
      },
      wind: {
        speed: windSpeed,
        unit: 'm/s',
        direction: 'N' // Default, would come from weather API in production
      },
      pressure: {
        value: pressure,
        unit: 'in',
        description: 'Atmospheric pressure'
      },
      dewPoint: {
        value: dewPoint,
        description: dewPoint ? 'Similar to the actual temperature' : null
      },
      humidity: {
        value: humidity,
        unit: '%',
        description: dewPoint ? `The dew point is ${Math.round(dewPoint)}° right now.` : null
      }
    },
    recommendations
  };
}

/**
 * Get evaporation details for a specific order or plant
 * @param {string} orderId - Order ID (optional)
 * @param {string} orderCode - Order Code (optional)
 * @param {string} ticketNumber - Ticket number (optional, maps to pocket_number)
 * @param {number} plantId - Plant ID (optional)
 * @returns {Promise<object>} Evaporation details
 */
async function getEvaporationDetails(orderId = null, orderCode = null, ticketNumber = null, plantId = null) {
  if (!orderId && !orderCode && !plantId) {
    throw new Error('Either Order ID, Order Code, or Plant ID is required');
  }

  let weatherData = null;
  let orderData = null;
  let ticketData = null;
  let resolvedOrderId = orderId;

  // Build parallel queries for order data and ticket data
  const orderPromise = (orderCode || orderId) ? (async () => {
    let orderSql;
    let orderParams;

    if (orderCode) {
      orderSql = `
        SELECT o.order_id, o.order_code, o.order_date,
          (SELECT t.plant_id FROM tickets t WHERE t.order_id = o.order_id LIMIT 1) as ticket_plant_id
        FROM orders o
        WHERE TRIM(o.order_code) = $1
        LIMIT 1
      `;
      const normalizedOrderCode = String(orderCode).trim().toUpperCase();
      orderParams = [normalizedOrderCode];
    } else {
      orderSql = `
        SELECT o.order_id, o.order_code, o.order_date,
          (SELECT t.plant_id FROM tickets t WHERE t.order_id = o.order_id LIMIT 1) as ticket_plant_id
        FROM orders o
        WHERE o.order_id = $1
        LIMIT 1
      `;
      orderParams = [orderId];
    }

    try {
      const orderResult = await executeDirectSQL(orderSql, orderParams);
      return orderResult.data?.[0] || null;
    } catch (error) {
      console.warn('Error fetching order data:', error.message);
      return null;
    }
  })() : Promise.resolve(null);

  const ticketPromise = ticketNumber ? (async () => {
    try {
      const ticketSql = `SELECT t.* FROM tickets t WHERE t.pocket_number = $1 LIMIT 1`;
      const ticketResult = await executeDirectSQL(ticketSql, [ticketNumber]);
      return ticketResult.data?.[0] || null;
    } catch (error) {
      console.warn('Error fetching ticket data:', error.message);
      return null;
    }
  })() : Promise.resolve(null);

  // Run order + ticket lookups in parallel
  [orderData, ticketData] = await Promise.all([orderPromise, ticketPromise]);

  if (orderData) {
    resolvedOrderId = orderData.order_id;
    // Extract plant_id from the inlined subquery (avoids a separate round-trip)
    if (!plantId && orderData.ticket_plant_id) {
      plantId = orderData.ticket_plant_id;
    }
  }

  // If orderId not resolved but ticket found, use ticket's order_id
  if (!resolvedOrderId && ticketData?.order_id) {
    resolvedOrderId = ticketData.order_id;
    if (!orderData) {
      try {
        const orderSql = `SELECT o.order_id, o.order_code, o.order_date FROM orders o WHERE o.order_id = $1 LIMIT 1`;
        const orderResult = await executeDirectSQL(orderSql, [resolvedOrderId]);
        orderData = orderResult.data?.[0];
      } catch (e) { /* ignore */ }
    }
  }

  // Fallback: get plant_id from tickets table if not resolved above
  if (!plantId && resolvedOrderId) {
    try {
      const ticketPlantSql = `SELECT plant_id FROM tickets WHERE order_id = $1 LIMIT 1`;
      const ticketPlantResult = await executeDirectSQL(ticketPlantSql, [resolvedOrderId]);
      if (ticketPlantResult.data?.[0]?.plant_id) {
        plantId = ticketPlantResult.data[0].plant_id;
      }
    } catch (e) {
      console.warn('Error finding plant from order:', e.message);
    }
  }

  // Get weather data
  if (plantId) {
    weatherData = await getWeatherByPlantId(plantId);
  }
  
  if (!weatherData) {
    const response = {
      status: {
        weather_status: 'Unknown',
        evaporation_rate: null,
        concrete_temp: null,
        order_no: orderData?.order_code || null,
        current_ticket_no: ticketData?.pocket_number || null
      },
      order: orderData ? {
        order_id: orderData.order_id,
        order_code: orderData.order_code,
        order_date: orderData.order_date
      } : null,
      ticket: ticketData ? {
        ticket_id: ticketData.ticket_id || ticketData.id || null,
        ticket_number: ticketData.pocket_number || null
      } : null,
      details: {
        description: 'You can check your all the product details with weather updates.'
      },
      references: {
        description: 'ACI 305, "Hot Weather Concreting." ACI Manual of Concrete Practice, Part 2. American Concrete Institute, P.O. Box 19150, Detroit, Michigan 48219.'
      }
    };
    return response;
  }

  const tempF = parseFloat(weatherData.temperature_fahrenheit) || 0;
  const humidity = parseInt(weatherData.humidity) || 0;
  const windSpeed = parseFloat(weatherData.wind_speed) || 0;
  const evaporation = calculateEvaporationRate(tempF, humidity, windSpeed);
  const concreteTemp = calculateConcreteTemperature(weatherData, tempF);
  const status = getWeatherStatus(tempF, humidity, windSpeed);

  const response = {
    status: {
      weather_status: status,
      evaporation_rate: evaporation.rate,
      concrete_temp: concreteTemp,
      order_no: orderData?.order_code || null,
      current_ticket_no: ticketData?.pocket_number || null
    },
    order: orderData ? {
      order_id: orderData.order_id,
      order_code: orderData.order_code,
      order_date: orderData.order_date
    } : null,
    ticket: ticketData ? {
      ticket_id: ticketData.ticket_id || ticketData.id || null,
      ticket_number: ticketData.pocket_number || null
    } : null,
    details: {
      description: 'You can check your all the product details with weather updates.'
    },
    references: {
      description: 'ACI 305, "Hot Weather Concreting." ACI Manual of Concrete Practice, Part 2. American Concrete Institute, P.O. Box 19150, Detroit, Michigan 48219.'
    }
  };
  
  return response;
}

/**
 * Get all weather data for a plant (history)
 * @param {number} plantId - Plant ID
 * @param {number} limit - Number of records to return
 * @returns {Promise<array>} Array of weather records
 */
async function getWeatherHistory(plantId, limit = 10) {
  if (!plantId) {
    throw new Error('Plant ID is required');
  }

  const sql = `
    SELECT pw.*
    FROM plant_weather pw
    WHERE pw.plant_id = $1
    ORDER BY pw.fetched_at DESC
    LIMIT $2
  `;

  try {
    const result = await executeDirectSQL(sql, [plantId, limit]);
    return result.data || [];
  } catch (error) {
    console.error('Error fetching weather history:', error);
    throw error;
  }
}

/**
 * Get weather data directly from orders table weather_data column
 * @param {string} orderCode - Order Code
 * @param {string} orderDate - Order Date (YYYY-MM-DD)
 * @returns {Promise<object>} Weather data from orders table
 */
async function getAllWeatherData(orderCode, orderDate) {
  if (!orderCode) {
    throw new Error('Order Code is required');
  }

  if (!orderDate) {
    throw new Error('Order Date is required');
  }

  const sql = `
    SELECT
      o.order_id,
      o.order_code,
      o.weather_data
    FROM orders o
    WHERE TRIM(o.order_code) = $1
      AND o.order_date >= $2::date
      AND o.order_date < ($2::date + INTERVAL '1 day')
    LIMIT 1
  `;
  const normalizedOrderCode = String(orderCode).trim().toUpperCase();
  const params = [normalizedOrderCode, orderDate];

  try {
    const result = await executeDirectSQL(sql, params);
    const order = result.data?.[0];

    if (!order) {
      return {
        order_id: null,
        order_code: orderCode,
        order_date: orderDate,
        weather_data: null
      };
    }

    return {
      order_id: order.order_id,
      order_code: order.order_code,
      order_date: orderDate,
      weather_data: order.weather_data || null
    };
  } catch (error) {
    console.error('Error fetching weather data from orders table:', error);
    throw error;
  }
}

module.exports = {
  getWeatherByPlantId,
  getWeatherUpdate,
  getEvaporationDetails,
  getWeatherHistory,
  getAllWeatherData,
  calculateDewPoint,
  calculatePressure,
  calculateConcreteTemperature,
  calculateEvaporationRate,
  getProductRecommendations,
  getWeatherStatus,
  formatDateForMobile,
  extractLocationName
};
