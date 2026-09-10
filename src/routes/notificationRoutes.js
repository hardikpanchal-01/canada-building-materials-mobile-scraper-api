const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const notificationPushController = require('../controllers/notificationPushController');
const notificationQueueController = require('../controllers/notificationQueueController');
const orderNotificationController = require('../controllers/orderNotificationController');
const { authenticate } = require('../middleware/auth');

/**
 * @route   POST /api/notifications/send
 * @desc    Send push notification to device(s) (uses main database)
 * @access  Private
 */
router.post('/send', authenticate, notificationController.sendNotification);

/**
 * @route   POST /api/notifications/fcm
 * @desc    Send push notification via FCM (uses notification database)
 * @access  Private
 */
router.post('/fcm', authenticate, notificationPushController.sendNotification);

/**
 * @route   POST /api/notifications/send-order
 * @desc    Send order notification with navigation data (FCM + notification_queue)
 * @access  Private
 */
router.post('/send-order', authenticate, orderNotificationController.sendOrderNotification);

/**
 * @route   GET /api/notifications/history
 * @desc    Get notification history for authenticated user (uses notification database)
 * @access  Private
 */
router.get('/history', authenticate, notificationQueueController.getNotifications);

/**
 * @route   PUT /api/notifications/read/:queueUuid
 * @desc    Mark a single notification as read
 * @access  Private
 */
router.put('/read/:queueUuid', authenticate, notificationQueueController.markAsRead);

/**
 * @route   PUT /api/notifications/read-all
 * @desc    Mark all notifications as read for authenticated user
 * @access  Private
 */
router.put('/read-all', authenticate, notificationQueueController.markAllAsRead);

module.exports = router;


