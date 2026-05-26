const { secureCompare } = require('../utils/encryptionUtils');

const INTERNAL_CHAT_NOTIFY_TOKEN = process.env.INTERNAL_CHAT_NOTIFY_TOKEN || '';

function internalChatNotifyAuth(req, res, next) {
  const token = req.headers['x-internal-token'];

  if (!INTERNAL_CHAT_NOTIFY_TOKEN) {
    console.error('INTERNAL_CHAT_NOTIFY_TOKEN not set on server');
    return res.status(500).json({
      success: false,
      error_code: 'SERVER_CONFIG_ERROR',
      message: 'Internal token not configured',
    });
  }

  if (!token || !secureCompare(token, INTERNAL_CHAT_NOTIFY_TOKEN)) {
    return res.status(401).json({
      success: false,
      error_code: 'UNAUTHORIZED',
      message: 'Invalid internal token',
    });
  }

  next();
}

module.exports = { internalChatNotifyAuth };
