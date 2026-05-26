/**
 * Plant Weather Worker
 *
 * Fetches weather from OpenWeatherMap for all plants with coordinates
 * and stores/updates in the plant_weather table.
 *
 * Same behavior as the Truckast web app's weather fetch:
 * - Runs every 30 minutes (configurable via WEATHER_POLL_INTERVAL_MS)
 * - Fetches weather for each plant with lat/lon
 * - Upserts into plant_weather table
 *
 * Usage:
 *   node src/workers/plantWeatherWorker.js          # standalone
 *   Embedded: require and call startPlantWeatherWorker() from server.js
 */

require('dotenv').config();

const { executeDirectSQL } = require('../utils/postgresExecutor');
const https = require('https');

const API_KEY = process.env.OPENWEATHERMAP_API_KEY;
const POLL_INTERVAL_MS = parseInt(process.env.WEATHER_POLL_INTERVAL_MS) || 30 * 60 * 1000; // 30 minutes

/**
 * Fetch weather from OpenWeatherMap for given coordinates
 */
function fetchWeather(lat, lon) {
  return new Promise((resolve, reject) => {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=imperial&appid=${API_KEY}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

/**
 * Fetch and store weather for all plants
 */
async function fetchAllPlantWeather() {
  if (!API_KEY) {
    console.warn('[PlantWeather] OPENWEATHERMAP_API_KEY not configured — skipping');
    return;
  }

  try {
    // Get all plants with coordinates
    const plantsResult = await executeDirectSQL(
      'SELECT id, code, description, latitude, longitude FROM plants WHERE latitude IS NOT NULL AND longitude IS NOT NULL'
    );
    const plants = plantsResult.data || [];

    if (plants.length === 0) {
      console.log('[PlantWeather] No plants with coordinates found');
      return;
    }

    console.log(`[PlantWeather] Fetching weather for ${plants.length} plants...`);
    let updated = 0;
    let errors = 0;

    for (const plant of plants) {
      try {
        const weather = await fetchWeather(plant.latitude, plant.longitude);

        if (weather && weather.main) {
          const now = new Date().toISOString();

          // Check if row exists
          const existing = await executeDirectSQL(
            'SELECT id FROM plant_weather WHERE plant_id = $1 LIMIT 1',
            [plant.id]
          );

          if (existing.data && existing.data.length > 0) {
            // Update
            await executeDirectSQL(
              `UPDATE plant_weather SET
                latitude = $1, longitude = $2,
                temperature_fahrenheit = $3,
                weather_condition = $4, weather_icon = $5, weather_description = $6,
                humidity = $7, wind_speed = $8,
                fetched_at = $9, updated_at = $9
              WHERE plant_id = $10`,
              [
                plant.latitude, plant.longitude,
                Math.round(weather.main.temp),
                weather.weather?.[0]?.main || 'Unknown',
                weather.weather?.[0]?.icon || '',
                weather.weather?.[0]?.description || '',
                weather.main.humidity || 0,
                weather.wind?.speed || 0,
                now,
                plant.id
              ]
            );
          } else {
            // Insert
            await executeDirectSQL(
              `INSERT INTO plant_weather (plant_id, latitude, longitude, temperature_fahrenheit, weather_condition, weather_icon, weather_description, humidity, wind_speed, fetched_at, created_at, updated_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $10)`,
              [
                plant.id,
                plant.latitude, plant.longitude,
                Math.round(weather.main.temp),
                weather.weather?.[0]?.main || 'Unknown',
                weather.weather?.[0]?.icon || '',
                weather.weather?.[0]?.description || '',
                weather.main.humidity || 0,
                weather.wind?.speed || 0,
                now
              ]
            );
          }
          updated++;
        }

        // Rate limit: 200ms between requests
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        errors++;
        console.error(`[PlantWeather] Error for plant ${plant.code} (${plant.description}):`, err.message);
      }
    }

    console.log(`[PlantWeather] Done: ${updated} updated, ${errors} errors`);

    // Also backfill orders.weather_data for recent orders that don't have it
    await backfillOrderWeather();
  } catch (err) {
    console.error('[PlantWeather] Fatal error:', err.message);
  }
}

/**
 * Backfill orders.weather_data from plant_weather for orders missing weather.
 * Matches each order to its plant via order_product_schedules → plant_code → plants → plant_weather.
 * Same data the web app writes via api/orders/[orderId]/weather.
 */
async function backfillOrderWeather() {
  try {
    const result = await executeDirectSQL(`
      UPDATE orders o
      SET weather_data = jsonb_build_object(
        'temperature_fahrenheit', pw.temperature_fahrenheit,
        'weather_condition', pw.weather_condition,
        'weather_icon', pw.weather_icon,
        'weather_description', pw.weather_description,
        'humidity_percent', pw.humidity,
        'wind_speed_mph', pw.wind_speed,
        'location', p.description,
        'latitude', pw.latitude,
        'longitude', pw.longitude,
        'fetched_at', pw.fetched_at,
        'source', 'plant_weather_backfill'
      )
      FROM order_products op
      INNER JOIN order_product_schedules ops ON ops.order_product_id = op.id
      INNER JOIN plants p ON p.code = ops.plant_code
      INNER JOIN plant_weather pw ON pw.plant_id = p.id
      WHERE op.order_id = o.order_id
        AND op.is_mix = true
        AND o.weather_data IS NULL
        AND o.order_date >= (CURRENT_DATE - INTERVAL '7 days')
    `);

    const rowCount = result.data ? result.rowCount || 0 : 0;
    if (rowCount > 0) {
      console.log(`[PlantWeather] Backfilled weather_data for ${rowCount} orders`);
    }
  } catch (err) {
    console.error('[PlantWeather] Order backfill error:', err.message);
  }
}

/**
 * Start the weather worker (polling loop)
 */
function startPlantWeatherWorker() {
  console.log(`[PlantWeather] Starting worker (interval: ${POLL_INTERVAL_MS / 1000}s)`);

  // Fetch immediately on start
  fetchAllPlantWeather();

  // Then poll on interval
  setInterval(fetchAllPlantWeather, POLL_INTERVAL_MS);
}

// If run directly: node src/workers/plantWeatherWorker.js
if (require.main === module) {
  startPlantWeatherWorker();
}

module.exports = { startPlantWeatherWorker, fetchAllPlantWeather };
