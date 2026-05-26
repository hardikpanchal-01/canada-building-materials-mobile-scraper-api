/**
 * Swagger/OpenAPI Configuration for Scraper API
 *
 * Configures swagger-jsdoc to generate OpenAPI specification
 * for Scraper API endpoints only.
 */

const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Truckast Scraper API',
      version: '2.0.0',
      description: `
## Overview

API for ingesting scraped order data from external Python scrapers.

This API provides endpoints for receiving order data that has been
scraped from external dispatch systems. The data is validated, sanitized,
stored in Supabase Storage as JSON, and tracked in PostgreSQL.

## Authentication

All endpoints require authentication using an API key.
Provide the API key in the \`x-scraper-api-key\` header.

## Rate Limits

No rate limits are currently enforced.

## Error Handling

All errors return a JSON response with:
- \`success\`: Always \`false\` for errors
- \`error\`: Human-readable error message
- \`error_code\`: Machine-readable error code

Error codes:
- \`UNAUTHORIZED\`: Invalid or missing API key
- \`INVALID_PAYLOAD\`: Request body structure is invalid
- \`VALIDATION_ERROR\`: Order data failed validation
- \`STORAGE_ERROR\`: Failed to upload to storage
- \`DATABASE_ERROR\`: Failed to create database record
- \`INTERNAL_ERROR\`: Unexpected server error
      `,
      contact: {
        name: 'API Support'
      }
    },
    servers: [
      {
        url: process.env.API_BASE_URL || 'https://api.truckast.ai',
        description: process.env.NODE_ENV === 'production' ? 'Production Server' : 'Development Server'
      }
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-scraper-api-key',
          description: 'API key for scraper authentication. Obtain from system administrator.'
        }
      }
    },
    tags: [
      {
        name: 'Health',
        description: 'Health check endpoints for monitoring and load balancers'
      },
      {
        name: 'Scraped Orders',
        description: 'Endpoints for ingesting scraped order data'
      }
    ]
  },
  apis: [
    './src/routes/healthRoutes.js',
    './src/routes/scrapedOrderRoutes.js',
    './src/controllers/healthController.js',
    './src/controllers/scrapedOrderController.js'
  ]
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = {
  swaggerSpec
};


