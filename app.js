const express = require('express');
const cors = require('cors');
const compression = require('compression');
require('dotenv').config();
const swaggerUi = require('swagger-ui-express');
const { swaggerSpec: scraperSwaggerSpec } = require('./src/config/swaggerScraper');
const { swaggerSpec: mobileSwaggerSpec } = require('./src/config/swaggerMobile');

const app = express();

// Trust proxy
app.set('trust proxy', 1);

// =============================================================================
// Middleware
// =============================================================================

// Response compression (gzip/deflate) - skip tiny responses under 1KB
app.use(compression({ threshold: 1024 }));

// CORS configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'x-scraper-api-key']
}));

// JSON parsing with 10MB limit for large order payloads
app.use(express.json({
  limit: '10mb',
  strict: true
}));

app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const timestamp = new Date().toISOString();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${timestamp}] ${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
  });
  next();
});

// =============================================================================
// Swagger Documentation
// =============================================================================

// Helper to create spec with dynamic server URL based on request protocol.
// This prevents mixed-content errors when Swagger UI is accessed over HTTPS
// but the static spec has an HTTP server URL.
// Resolution order: API_BASE_URL env var → X-Forwarded-Proto header →
// forced HTTPS for any non-localhost host → req.protocol fallback.
const resolveServerUrl = (req) => {
  if (process.env.API_BASE_URL) return process.env.API_BASE_URL;

  const host = req.get('host') || 'localhost';
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);

  const fwd = req.get('x-forwarded-proto');
  let protocol;
  if (fwd) {
    protocol = fwd.split(',')[0].trim();
  } else if (!isLocal) {
    protocol = 'https';
  } else {
    protocol = req.protocol;
  }

  return `${protocol}://${host}`;
};

const createDynamicSpec = (baseSpec, req) => ({
  ...baseSpec,
  servers: [
    {
      url: resolveServerUrl(req),
      description: process.env.NODE_ENV === 'production' ? 'Production Server' : 'Development Server'
    }
  ]
});

// Middleware to set req.swaggerDoc dynamically (swagger-ui-express checks this)
const dynamicSwaggerDoc = (baseSpec) => (req, res, next) => {
  req.swaggerDoc = createDynamicSpec(baseSpec, req);
  next();
};

// Create separate routers for each swagger docs to avoid serve middleware conflicts
const scraperDocsRouter = express.Router();
scraperDocsRouter.use('/',
  dynamicSwaggerDoc(scraperSwaggerSpec),
  swaggerUi.serveFiles(scraperSwaggerSpec),
  swaggerUi.setup(scraperSwaggerSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'Truckast Scraper API Documentation'
  })
);
app.use('/scraper-api-docs', scraperDocsRouter);

// Serve raw OpenAPI spec as JSON for Scraper API
app.get('/scraper-api-docs.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(createDynamicSpec(scraperSwaggerSpec, req));
});

// Create separate router for mobile docs
const mobileDocsRouter = express.Router();
mobileDocsRouter.use('/',
  dynamicSwaggerDoc(mobileSwaggerSpec),
  swaggerUi.serveFiles(mobileSwaggerSpec),
  swaggerUi.setup(mobileSwaggerSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'Truckast Mobile Backend API Documentation'
  })
);
app.use('/mobile-api-docs', mobileDocsRouter);

// Serve raw OpenAPI spec as JSON for Mobile API
app.get('/mobile-api-docs.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(createDynamicSpec(mobileSwaggerSpec, req));
});

// =============================================================================
// Well-Known (Universal Links / App Links)
// =============================================================================

const path = require('path');

// Serve apple-app-site-association without file extension
app.get('/.well-known/apple-app-site-association', (req, res) => {
  res.set('Content-Type', 'application/json');
  res.sendFile(path.join(__dirname, 'public', '.well-known', 'apple-app-site-association'));
});

// Serve Android assetlinks.json
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.set('Content-Type', 'application/json');
  res.sendFile(path.join(__dirname, 'public', '.well-known', 'assetlinks.json'));
});

// Serve public PDF documents (NRMCA CIP guides) for mobile clients
app.use('/pdfs', express.static(path.join(__dirname, 'public', 'pdfs')));

// Explicit PDF endpoint as fallback (in case express.static fails on deployed server)
app.get('/api/pdfs/:filename', (req, res) => {
  const allowedFiles = [
    'nrmca-cip-3-crazing.pdf',
    'nrmca-cip-4-drying-shrinkage.pdf',
    'nrmca-cip-5-plastic-shrinkage.pdf',
  ];
  const { filename } = req.params;
  if (!allowedFiles.includes(filename)) {
    return res.status(404).json({ success: false, message: 'PDF not found' });
  }
  const filePath = path.join(__dirname, 'public', 'pdfs', filename);
  res.sendFile(filePath, (err) => {
    if (err) {
      console.error('PDF sendFile error:', err.message);
      res.status(404).json({ success: false, message: 'PDF file not found on server' });
    }
  });
});

// =============================================================================
// Routes
// =============================================================================

// Health check routes (no auth required)
app.use('/', require('./src/routes/healthRoutes'));

// API Routes
app.use('/api/auth', require('./src/routes/authRoutes'));
app.use('/api/users', require('./src/routes/userRoutes'));
app.use('/api/notifications', require('./src/routes/notificationRoutes'));
app.use('/api/orders', require('./src/routes/orderRoutes'));
app.use('/api/dashboard', require('./src/routes/dashboardRoutes'));
app.use('/api/new-dashboard', require('./src/routes/newDashboardRoutes'));
app.use('/api', require('./src/routes/scrapedOrderRoutes'));
app.use('/api/queue', require('./src/routes/queueRoutes'));
app.use('/api/weather', require('./src/routes/weatherRoutes'));
app.use('/api/tickets', require('./src/routes/ticketRoutes'));
app.use('/api/trucks', require('./src/routes/truckRoutes'));
app.use('/api/announcements', require('./src/routes/announcementRoutes'));
app.use('/api/order-requests', require('./src/routes/orderRequestRoutes'));
app.use('/api/email-templates', require('./src/routes/emailTemplateRoutes'));
app.use('/api/ai', require('./src/routes/nlqRoutes'));
app.use('/api/ai', require('./src/routes/aiAssistantRoutes'));
app.use('/api/chat', require('./src/routes/chatRoutes'));
app.use('/api/qr', require('./src/routes/qrRoutes'));

// Mobile Federated Authentication Routes
app.use('/api/auth/mobile', require('./src/routes/mobileAuthRoutes'));
app.use('/api/tenant', require('./src/routes/tenantRoutes'));
app.use('/api/scan-history', require('./src/routes/scanHistoryRoutes'));

// User Preferences (private)
app.use('/api/user-preferences', require('./src/routes/userPreferenceRoutes'));

// Timezones (public, no auth)
app.use('/api/timezones', require('./src/routes/timezoneRoutes'));

app.use('/api/short-urls', require('./src/routes/shortUrlRoutes'));

// Root route
app.get('/', (req, res) => {
  res.status(200).json({
    message: 'Truckast Unified API - Mobile Backend & Scraper API',
    version: '2.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      documentation: {
        scraperApi: '/scraper-api-docs',
        mobileApi: '/mobile-api-docs'
      },
      mobile: {
        auth: {
          login: 'POST /api/auth/login',
          logout: 'POST /api/auth/logout',
          refresh: 'POST /api/auth/refresh',
          me: 'GET /api/auth/me',
          appPermissions: 'GET /api/auth/app-permissions',
          federated: {
            login: 'POST /api/auth/mobile/login (email, password - tenant auto-detected)',
            exchangeCode: 'POST /api/auth/mobile/exchange-code',
            tenants: 'GET /api/auth/mobile/tenants',
            switchTenant: 'POST /api/auth/mobile/switch-tenant'
          }
        },
        tenant: {
          get: 'GET /api/tenant?subdomain={subdomain}'
        },
        users: {
          getProfile: 'GET /api/users/profile',
          updateProfile: 'PUT /api/users/profile'
        },
        dashboard: {
          home: 'GET /api/dashboard'
        },
        notifications: {
          send: 'POST /api/notifications/send',
          fcm: 'POST /api/notifications/fcm',
          sendOrder: 'POST /api/notifications/send-order',
          history: 'GET /api/notifications/history?user_id={user_id}&tenant_id={tenant_id}&page={page}&limit={limit}'
        },
        tickets: {
          list: 'GET /api/tickets',
          details: 'GET /api/tickets/details?order_code={order_code}&order_date={order_date}&ticket_code={ticket_code}'
        },
        trucks: {
          list: 'GET /api/trucks',
          map: 'GET /api/trucks/map'
        },
        orders: {
          list: 'GET /api/orders',
          details: 'GET /api/orders/details?order_code={order_code}&order_date={order_date}',
          scheduledLoads: 'GET /api/orders/scheduled-loads?order_code={order_code}&order_date={order_date}',
          summary: 'GET /api/orders/summary',
          favourites: 'GET /api/orders/favourites',
          toggleFavourite: 'POST /api/orders/{order_id}/favourite'
        },
        orderRequests: {
          list: 'GET /api/order-requests',
          create: 'POST /api/order-requests',
          getById: 'GET /api/order-requests/{id}',
          update: 'PUT /api/order-requests/{id}',
          updateStatus: 'PATCH /api/order-requests/{id}/status',
          updateVerification: 'PATCH /api/order-requests/{id}/verification',
          formData: 'GET /api/order-requests/form-data',
          searchOrders: 'GET /api/order-requests/search-orders',
          searchProducts: 'GET /api/order-requests/search-products',
          ordersByProject: 'GET /api/order-requests/orders-by-project?projectCode={code}',
          recentEntities: 'GET /api/order-requests/recent-entities',
          messages: 'GET /api/order-requests/{id}/messages',
          sendMessage: 'POST /api/order-requests/{id}/messages'
        },
        weather: {
          all: 'GET /api/weather/all'
        },
        qr: {
          verify: 'POST /api/qr/verify'
        },
        scanHistory: {
          list: 'GET /api/scan-history',
          save: 'POST /api/scan-history',
          delete: 'DELETE /api/scan-history/{id}',
          clear: 'DELETE /api/scan-history'
        },
        chat: {
          readStatus: 'GET /api/chat/read-status',
          unreadCounts: 'GET /api/chat/unread-counts',
          markRead: 'POST /api/chat/mark-read'
        },
        emailTemplates: {
          list: 'GET /api/email-templates',
          defaults: 'GET /api/email-templates/defaults',
          create: 'POST /api/email-templates',
          update: 'PUT /api/email-templates/{id}',
          delete: 'DELETE /api/email-templates/{id}'
        },
        ai: {
          chat: 'POST /api/ai/chat',
          history: 'GET /api/ai/history/{sessionId}',
          clearHistory: 'DELETE /api/ai/history/{sessionId}'
        },
        shortUrls: {
          resolve: 'GET /api/short-urls/resolve/{code}'
        }
      },
      scraper: {
        scrapedOrders: {
          ingest: 'POST /api/scraped-orders/ingest'
        }
      },
      queue: {
        process: 'POST /api/queue/process',
        stats: 'GET /api/queue/stats',
        status: 'GET /api/queue/status/:batchId'
      }
    }
  });
});

// =============================================================================
// Error Handling
// =============================================================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
    path: req.path,
    method: req.method
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('❌ Error:', err);
  
  // Handle JSON parsing errors
  if (err instanceof SyntaxError) {
    const isJsonError = err.message.includes('JSON') || 
                       err.message.includes('Unexpected') ||
                       err.message.includes('property name') ||
                       err.status === 400 ||
                       err.statusCode === 400 ||
                       err.type === 'entity.parse.failed' ||
                       err.type === 'entity.verify.failed';
    
    if (isJsonError) {
      return res.status(400).json({
        success: false,
        message: 'Invalid JSON format in request body. Please check your JSON syntax.',
        error: err.message,
        error_code: 'INVALID_JSON'
      });
    }
  }
  
  // Handle other body-parser errors
  if (err.type === 'entity.parse.failed' || err.type === 'entity.verify.failed') {
    return res.status(400).json({
      success: false,
      message: 'Invalid JSON format in request body. Please check your JSON syntax.',
      error: err.message,
      error_code: 'INVALID_JSON'
    });
  }

  // Handle payload too large
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      error: 'Payload too large. Maximum size is 10MB',
      error_code: 'PAYLOAD_TOO_LARGE'
    });
  }
  
  // Don't leak error details in production
  const isDevelopment = process.env.NODE_ENV !== 'production';
  
  res.status(err.status || err.statusCode || 500).json({
    success: false,
    message: err.message || 'Internal server error',
    error_code: err.code || 'INTERNAL_ERROR',
    ...(isDevelopment && { stack: err.stack })
  });
});

module.exports = app;

