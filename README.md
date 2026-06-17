# Truckast Unified API

A unified Node.js Express API combining Mobile Backend and Scraper API functionality. This API provides authentication, push notifications, and scraped order ingestion with validation and comparison.

## Features

### Mobile Backend
- **Authentication**: JWT-based authentication with email/password login
- **User Management**: User profile and session management
- **Push Notifications**: Firebase Cloud Messaging (FCM) integration
- **Device Management**: Device registration and tracking

### Scraper API
- **Order Ingestion**: REST API endpoint for order data ingestion
- **Data Validation**: Comprehensive validation with detailed error reporting
- **Order Comparison**: Automatic comparison with system database
- **Email Notifications**: Comparison report emails with HTML formatting
- **Storage**: Supabase Storage for JSON file storage
- **Database**: PostgreSQL for tracking imports and comparisons
- **API Documentation**: Swagger/OpenAPI documentation

## Prerequisites

Before setting up the project, ensure you have:

- **Node.js 18+** installed on your system
- **Supabase account** with a project created
- **PostgreSQL database** (can be Supabase PostgreSQL) - Optional for scraper features
- **Firebase project** with FCM enabled - Required for push notifications
- **SMTP server** credentials (optional, for email notifications)

## Installation

### Step 1: Install Dependencies

```bash
npm install
```

### Step 2: Configure Environment Variables

Create a `.env` file in the root directory and configure the following variables:

#### Required Variables

**Supabase Configuration:**
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_ANON_KEY` - Supabase anonymous key (for mobile backend)
- `SUPABASE_SERVICE_KEY` - Supabase service role key (for scraper storage features)

**JWT Configuration:**
- `JWT_SECRET` - Secret key for access tokens (generate a secure random key)
- `JWT_REFRESH_SECRET` - Secret key for refresh tokens (generate a secure random key)

**Firebase Configuration:**
- Place your Firebase service account JSON file at: `src/config/truckast-app-firebase-adminsdk-fbsvc-9c40fa6a9f.json`

#### Optional Variables

- `PORT` - Server port number (default: 3000)
- `NODE_ENV` - Environment mode (development/production)
- `CORS_ORIGIN` - CORS allowed origin (default: '*')

**For Scraper Features (Optional):**
- `DATABASE_URL` - PostgreSQL connection string (format: `postgresql://user:password@host:port/database`)
- `SCRAPER_API_KEY` - API key for scraper authentication (generate a secure random key)

**Email Configuration (Optional):**
- `SMTP_HOST` - SMTP server hostname
- `SMTP_PORT` - SMTP server port (default: 587)
- `SMTP_USER` - SMTP username
- `SMTP_PASSWORD` - SMTP password
- `SMTP_FROM_EMAIL` - Email sender address
- `SMTP_TO` - Email recipient(s) - comma-separated for multiple recipients
- `SMTP_CC` - CC recipient(s) - comma-separated
- `SMTP_SECURE` - Use secure connection (true/false, default: false)

### Step 3: Generate Secrets

Generate secure keys for JWT and API authentication:

```bash
# Generate JWT Secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate JWT Refresh Secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate Scraper API Key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 4: Database Setup (Optional)

If using scraper features, run the database migration to create the required tables:

```bash
psql -d your_database -f migrations/create_scraped_order_imports_table.sql
```

Or use your database management tool to run the SQL script.

### Step 5: Verify Installation

Start the development server:

```bash
npm run dev
```

Check if the server is running by visiting:
- Health check: `http://localhost:3000/health`
- Scraper API documentation: `http://localhost:3000/scraper-api-docs`
- Mobile Backend API documentation: `http://localhost:3000/mobile-api-docs`
- Root endpoint: `http://localhost:3000/`

## Running the Application

### Development Mode

For development with auto-reload:

```bash
npm run dev
```

### Production Mode

For production:

```bash
npm start
```

## API Endpoints

### Health Check
- `GET /health` - Detailed health status with database connectivity
- `GET /ready` - Simple readiness check
- `GET /live` - Liveness check

### Authentication (Mobile Backend)
- `POST /api/auth/login` - Login with email and password
- `POST /api/auth/logout` - Logout user (requires authentication)
- `POST /api/auth/refresh` - Refresh access token
- `GET /api/auth/me` - Get current authenticated user (requires authentication)

### Notifications (Mobile Backend)
- `POST /api/notifications/send` - Send push notification to device(s) (requires authentication)

### Scraped Orders (Scraper API)
- `POST /api/scraped-orders/ingest` - Ingest scraped order data (requires API key)

### Documentation
- `GET /scraper-api-docs` - Interactive Swagger UI documentation for Scraper API
- `GET /scraper-api-docs.json` - OpenAPI specification JSON for Scraper API
- `GET /mobile-api-docs` - Interactive Swagger UI documentation for Mobile Backend API
- `GET /mobile-api-docs.json` - OpenAPI specification JSON for Mobile Backend API

## Authentication

### Mobile Backend Endpoints

Use JWT tokens obtained from `/api/auth/login`. Include the token in the request header:

```
Authorization: Bearer <access_token>
```

### Scraper Endpoints

Use API key in the request header:

```
x-scraper-api-key: <your-api-key>
```

## Configuration Details

### Supabase Setup

1. Create a Supabase project at https://supabase.com
2. Go to Settings > API to find your project URL and keys
3. For scraper features, create a storage bucket named `scraped-orders`
4. Set the bucket to public or configure appropriate access policies

### Firebase Setup

1. Create a Firebase project at https://firebase.google.com
2. Enable Cloud Messaging (FCM)
3. Generate a service account key
4. Download the JSON file and place it at: `src/config/truckast-app-firebase-adminsdk-fbsvc-9c40fa6a9f.json`

### Database Connection

The `DATABASE_URL` should be in the following format:

```
postgresql://username:password@host:port/database
```

For Supabase PostgreSQL, you can find the connection string in:
- Supabase Dashboard > Settings > Database > Connection string > URI

### Email Configuration

Email notifications are optional. If SMTP configuration is not provided, the API will skip email sending without errors.

For Gmail SMTP:
- `SMTP_HOST`: `smtp.gmail.com`
- `SMTP_PORT`: `587`
- `SMTP_SECURE`: `false`
- Use an App Password instead of your regular password

## API Usage Examples

### Mobile Backend - Login

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "password123",
    "device_info": {
      "device_token": "fcm-device-token-here",
      "device_id": "device-id-123"
    }
  }'
```

### Mobile Backend - Send Notification

```bash
curl -X POST http://localhost:3000/api/notifications/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <access_token>" \
  -d '{
    "deviceToken": "fcm-device-token-here",
    "title": "Test Notification",
    "body": "This is a test notification"
  }'
```

### Scraper API - Ingest Orders

```bash
curl -X POST http://localhost:3000/api/scraped-orders/ingest \
  -H "Content-Type: application/json" \
  -H "x-scraper-api-key: <your-api-key>" \
  -d '{
    "orders": [
      {
        "order_code": "26324",
        "order_date": "2025-12-25",
        "customer_name": "ABC Construction",
        "product_code": "T355N0",
        "ordered_qty": 21.01,
        "delivered_qty": 0.00,
        "status": "Normal"
      }
    ]
  }'
```

## Deployment

### Using PM2 (Recommended)

PM2 is a process manager for Node.js applications:

1. Install PM2 globally:
   ```bash
   npm install -g pm2
   ```

2. Start the application:
   ```bash
   pm2 start server.js --name truckast-unified-api
   ```

3. Save PM2 configuration:
   ```bash
   pm2 save
   ```

4. Setup PM2 to start on system boot:
   ```bash
   pm2 startup
   ```

### Environment Variables in Production

Make sure all environment variables are set in your production environment. You can:
- Use environment variable files (`.env`)
- Set them in your hosting platform's configuration
- Use a secrets management service

### Health Checks for Load Balancers

Configure your load balancer to use:
- **Health endpoint**: `/health` - Returns 503 if database is disconnected
- **Ready endpoint**: `/ready` - Always returns 200 if server is running
- **Live endpoint**: `/live` - Liveness check

## Troubleshooting

### Common Issues

**Database Connection Errors**
- Verify your `DATABASE_URL` is correct
- Check if your database is accessible from your server
- Ensure database credentials are correct
- Note: Database is optional for scraper features - API will continue without it

**Supabase Storage Errors**
- Verify `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are correct
- Check if the storage bucket exists and has proper permissions
- Ensure the service role key has storage access

**Firebase Errors**
- Verify the service account JSON file is in the correct location
- Check if FCM is enabled in your Firebase project
- Ensure the service account has proper permissions

**Email Not Sending**
- Verify all SMTP configuration variables are set correctly
- Check SMTP server credentials
- Test SMTP connection with a simple email client first
- Email failures are non-critical and won't break the API

**API Key Authentication Failing**
- Ensure the API key in your request header matches `SCRAPER_API_KEY` in `.env`
- Check for extra spaces or newlines in the API key
- Verify the header name is exactly `x-scraper-api-key`

**JWT Token Errors**
- Verify `JWT_SECRET` and `JWT_REFRESH_SECRET` are set
- Check token expiration times
- Ensure tokens are included in the `Authorization: Bearer <token>` header format

## Project Structure

```
.
├── app.js                 # Express application setup
├── server.js              # Server entry point
├── package.json           # Dependencies and scripts
├── src/
│   ├── config/            # Configuration files
│   │   ├── database.js        # Supabase configuration
│   │   ├── Firebase.js        # Firebase Admin SDK
│   │   ├── jwt.js             # JWT configuration
│   │   ├── swaggerScraper.js  # Swagger/OpenAPI config for Scraper API
│   │   └── swaggerMobile.js   # Swagger/OpenAPI config for Mobile Backend API
│   ├── controllers/       # Request handlers
│   │   ├── authController.js
│   │   ├── notificationController.js
│   │   ├── healthController.js
│   │   └── scrapedOrderController.js
│   ├── middleware/         # Express middleware
│   │   ├── auth.js         # JWT authentication
│   │   └── scraperAuth.js  # API key authentication
│   ├── routes/             # Route definitions
│   │   ├── authRoutes.js
│   │   ├── notificationRoutes.js
│   │   ├── healthRoutes.js
│   │   └── scrapedOrderRoutes.js
│   ├── services/           # Business logic
│   │   ├── authService.js
│   │   ├── deviceService.js
│   │   ├── notificationService.js
│   │   ├── emailService.js
│   │   ├── orderComparisonService.js
│   │   └── database/
│   │       ├── postgresClient.js
│   │       ├── supabaseClient.js
│   │       ├── scrapedOrderDatabaseService.js
│   │       └── comparisonDatabaseService.js
│   └── utils/              # Utility functions
│       ├── jwtUtils.js
│       ├── supabaseHelper.js
│       ├── postgresExecutor.js
│       └── scrapedOrderValidation.js
└── README.md               # This file
```

## Support

For issues or questions:
- Check the Scraper API documentation at `/scraper-api-docs`
- Check the Mobile Backend API documentation at `/mobile-api-docs`
- Review the error messages in the API responses
- Check server logs for detailed error information

## License

ISC

