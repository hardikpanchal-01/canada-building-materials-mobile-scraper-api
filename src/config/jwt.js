module.exports = {
  accessTokenSecret: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
  refreshTokenSecret: process.env.JWT_REFRESH_SECRET || 'your-refresh-secret-key-change-in-production',
  accessTokenExpiry: process.env.JWT_EXPIRY || '2h', // 2 hours
  refreshTokenExpiry: process.env.JWT_REFRESH_EXPIRY || '30d', // 30 days
};


