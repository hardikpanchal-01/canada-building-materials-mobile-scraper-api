/**
 * AWS Location Services - Route API Integration
 * Calculates truck routes with traffic-aware ETA
 * Ported from web: truckast-dolese-readymix-frontend/src/lib/aws-route-service.ts
 */

const AWS_REGION = process.env.AWS_LOCATION_REGION || 'us-east-1';

// Default concrete mixer truck specs (same as web)
const DEFAULT_TRUCK_SPECS = {
  grossWeight: parseInt(process.env.TRUCK_GROSS_WEIGHT || '33000', 10),
  height: parseInt(process.env.TRUCK_HEIGHT || '395', 10),
  length: parseInt(process.env.TRUCK_LENGTH || '950', 10),
  width: parseInt(process.env.TRUCK_WIDTH || '255', 10),
  axleCount: parseInt(process.env.TRUCK_AXLE_COUNT || '3', 10),
  tireCount: parseInt(process.env.TRUCK_TIRE_COUNT || '10', 10),
  weightPerAxle: parseInt(process.env.TRUCK_WEIGHT_PER_AXLE || '9000', 10),
  maxSpeed: parseInt(process.env.TRUCK_MAX_SPEED || '90', 10),
};

function getApiKey() {
  const apiKey = process.env.NEXT_PUBLIC_AWS_LOCATION_API_KEY;
  if (!apiKey) {
    throw new Error('ETA service is not configured. Please contact your administrator.');
  }
  return apiKey;
}

/**
 * Calculate truck route ETA using AWS Location Services
 * @param {number} originLat
 * @param {number} originLng
 * @param {number} destinationLat
 * @param {number} destinationLng
 * @param {object} truckSpecs - Optional truck spec overrides
 * @param {object} options - { optimizeFor, avoid }
 * @returns {Promise<object>} ETAData
 */
async function calculateTruckETA(originLat, originLng, destinationLat, destinationLng, truckSpecs = {}, options = {}) {
  if (!originLat || !originLng || !destinationLat || !destinationLng) {
    throw new Error('Origin and destination coordinates are required');
  }

  const apiKey = getApiKey();

  const specs = { ...DEFAULT_TRUCK_SPECS, ...truckSpecs };

  const requestBody = {
    Origin: [originLng, originLat],
    Destination: [destinationLng, destinationLat],
    TravelMode: 'Truck',
    DepartNow: true,
    OptimizeRoutingFor: options.optimizeFor || 'FastestRoute',
    LegAdditionalFeatures: ['Summary', 'TravelStepInstructions'],
    TravelModeOptions: {
      Truck: {
        GrossWeight: specs.grossWeight,
        Height: specs.height,
        Length: specs.length,
        Width: specs.width,
        AxleCount: specs.axleCount,
        TireCount: specs.tireCount,
        WeightPerAxle: specs.weightPerAxle,
        MaxSpeed: (specs.maxSpeed * 100) / 360,
        EngineType: 'InternalCombustion',
        TruckType: 'StraightTruck',
      },
    },
  };

  if (options.avoid) {
    requestBody.Avoid = { [options.avoid]: true };
  }

  const routeUrl = `https://routes.geo.${AWS_REGION}.amazonaws.com/v2/routes?key=${apiKey}`;

  const response = await fetch(routeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`AWS Route API error (${response.status}): ${errBody}`);
  }

  const data = await response.json();

  const route = data.Routes?.[0];
  if (!route) throw new Error('No route found');

  const leg = route.Legs?.[0];
  if (!leg) throw new Error('No leg data found');

  const details = leg.VehicleLegDetails || leg.PedestrianLegDetails;
  if (!details) throw new Error('No route details found');

  // Duration
  let durationSeconds = 0;
  if (details.Summary?.Overview?.Duration) {
    durationSeconds = details.Summary.Overview.Duration;
  } else if (details.TravelSteps) {
    durationSeconds = details.TravelSteps.reduce((sum, step) => sum + (step.Duration || 0), 0);
  }

  // Distance
  let distanceMeters = 0;
  if (details.Summary?.Overview?.Distance) {
    distanceMeters = details.Summary.Overview.Distance;
  } else if (details.TravelSteps) {
    distanceMeters = details.TravelSteps.reduce((sum, step) => sum + (step.Distance || 0), 0);
  }

  // Format
  const hours = Math.floor(durationSeconds / 3600);
  const minutes = Math.round((durationSeconds % 3600) / 60);
  const durationFormatted = hours > 0 ? `${hours}h ${minutes}m` : `${minutes} min`;

  const distanceKm = (distanceMeters / 1000).toFixed(1);
  const distanceMiles = (distanceMeters / 1609.34).toFixed(1);

  const arrivalTime = details.Arrival?.Time || null;
  const departureTime = details.Departure?.Time || null;

  return {
    calculatedAt: new Date().toISOString(),
    originLat,
    originLng,
    destinationLat,
    destinationLng,
    durationSeconds,
    distanceMeters,
    arrivalTime,
    departureTime,
    durationFormatted,
    distanceKm,
    distanceMiles,
    truckSpecs: specs,
  };
}

module.exports = {
  calculateTruckETA,
  DEFAULT_TRUCK_SPECS,
};
