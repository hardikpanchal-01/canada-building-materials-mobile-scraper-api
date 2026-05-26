/**
 * Swagger/OpenAPI Configuration for Mobile Backend API
 *
 * Configures swagger-jsdoc to generate OpenAPI specification
 * for Mobile Backend endpoints only.
 */

const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Truckast Mobile Backend API',
      version: '2.0.0',
      description: `
## Overview

Mobile Backend API for Truckast application.

This API provides:
- **Authentication**: JWT-based authentication with email/password login
- **Federated Auth**: OAuth 2.0 Authorization Code Flow for multi-tenant authentication
- **User Management**: User profile and session management
- **Push Notifications**: Firebase Cloud Messaging (FCM) integration
- **Device Management**: Device registration and tracking
- **Orders**: Order listing, filtering, and detail retrieval for mobile app
- **Tickets**: Ticket listing, tracking, and details with status derivation from timestamps
- **Trucks**: Truck listing, filtering, and real-time map display with location data
- **Weather**: Weather data, metrics, and product recommendations for concrete operations
- **Health**: Health check endpoints for monitoring API status and database connectivity

## Authentication

All protected endpoints require JWT authentication.
1. Login using \`POST /api/auth/login\` to obtain access and refresh tokens
2. Include the access token in the \`Authorization: Bearer <token>\` header for protected endpoints
3. Use \`POST /api/auth/refresh\` to refresh expired access tokens

## Rate Limits

No rate limits are currently enforced.

## Error Handling

All errors return a JSON response with:
- \`success\`: Always \`false\` for errors
- \`message\`: Human-readable error message
- \`error\`: Detailed error information (in development mode)

Error codes:
- \`UNAUTHORIZED\`: Invalid or missing authentication token
- \`INVALID_JSON\`: Invalid JSON format in request body
- \`PAYLOAD_TOO_LARGE\`: Request payload exceeds size limit
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
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT token obtained from /api/auth/login endpoint'
        }
      }
    },
    tags: [
      {
        name: 'Auth',
        description: 'Authentication endpoints for mobile backend'
      },
      {
        name: 'Mobile Auth',
        description: 'OAuth 2.0 Authorization Code Flow endpoints for federated multi-tenant authentication'
      },
      {
        name: 'Tenant',
        description: 'Tenant configuration endpoints for multi-tenant authentication'
      },
      {
        name: 'Dashboard',
        description: 'Dashboard endpoint for mobile app home screen - user info, weather, order overview, progress, active deliveries'
      },
      {
        name: 'Notifications',
        description: 'Push notification and notification history endpoints - send via FCM, notification queue history'
      },
      {
        name: 'Orders',
        description: 'Order management endpoints for mobile app - listing, filtering, and details'
      },
      {
        name: 'Weather',
        description: 'Weather data endpoints - provides weather updates, evaporation details, and product recommendations for concrete operations'
      },
      {
        name: 'Users',
        description: 'User profile management endpoints - get and update user profile information'
      },
      {
        name: 'Tickets',
        description: 'Ticket management endpoints - listing, tracking, and details with status derivation from timestamps'
      },
      {
        name: 'Trucks',
        description: 'Truck management endpoints - listing, filtering, and map display with real-time location data'
      },
      {
        name: 'Health',
        description: 'Health check endpoints for monitoring API status and connectivity'
      },
      {
        name: 'Favourites',
        description: 'Favourite order endpoints - toggle favourite/unfavourite and retrieve all favourite orders'
      },
      {
        name: 'Announcements',
        description: 'Announcement management endpoints - CRUD operations for announcements with filters for published status, plant_ids, and date ranges'
      },
      {
        name: 'NLQ',
        description: 'Natural Language Query (AI Chatbot) - ask questions in plain English and get answers from the database. Read-only; all write operations are blocked.'
      },
      {
        name: 'QR',
        description: 'QR code verification - decrypt [TK/E] encrypted payloads or pipe-separated fallback and return enriched ticket/truck details'
      },
      {
        name: 'Scan History',
        description: 'User-scoped QR/barcode scan history - list (paginated), save, delete one, or clear all scan records'
      }
    ]
  },
  apis: [
    './src/routes/authRoutes.js',
    './src/routes/mobileAuthRoutes.js',
    './src/routes/tenantRoutes.js',
    './src/routes/userRoutes.js',
    './src/routes/dashboardRoutes.js',
    './src/routes/newDashboardRoutes.js',
    './src/routes/notificationRoutes.js',
    './src/routes/orderRoutes.js',
    './src/routes/weatherRoutes.js',
    './src/routes/ticketRoutes.js',
    './src/routes/truckRoutes.js',
    './src/routes/healthRoutes.js',
    './src/routes/announcementRoutes.js',
    './src/controllers/authController.js',
    './src/controllers/mobileAuthController.js',
    './src/controllers/tenantController.js',
    './src/controllers/userController.js',
    './src/controllers/dashboardController.js',
    './src/controllers/newDashboardController.js',
    './src/controllers/notificationController.js',
    './src/controllers/notificationPushController.js',
    './src/controllers/notificationQueueController.js',
    './src/controllers/orderController.js',
    './src/controllers/weatherController.js',
    './src/controllers/ticketController.js',
    './src/controllers/truckController.js',
    './src/controllers/healthController.js',
    './src/controllers/favouriteOrderController.js',
    './src/controllers/announcementController.js',
    './src/routes/nlqRoutes.js',
    './src/controllers/nlqController.js',
    './src/routes/qrRoutes.js',
    './src/controllers/qrController.js',
    './src/routes/scanHistoryRoutes.js',
    './src/controllers/scanHistoryController.js'
  ]
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = {
  swaggerSpec
};


