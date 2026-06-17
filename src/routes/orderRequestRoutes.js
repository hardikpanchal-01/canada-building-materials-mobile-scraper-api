const express = require('express');
const router = express.Router();
const orderRequestController = require('../controllers/orderRequestController');
const { authenticate, authorizeOrderManagement } = require('../middleware/auth');

router.get('/', authenticate, orderRequestController.getOrderRequests);
router.get('/form-data', authenticate, orderRequestController.getFormData);
router.get('/orders-by-project', authenticate, orderRequestController.getOrdersByProjectCode);
router.get('/search-orders', authenticate, orderRequestController.searchOrders);
router.get('/search-products', authenticate, orderRequestController.searchProducts);
router.get('/recent-entities', authenticate, orderRequestController.getRecentOrderEntities);
router.get('/:id', authenticate, orderRequestController.getOrderRequestById);
router.post('/', authenticate, orderRequestController.createOrderRequest);
router.put('/:id', authenticate, orderRequestController.updateOrderRequest);
router.patch('/:id/status', authenticate, authorizeOrderManagement, orderRequestController.updateOrderRequestStatus);
router.patch('/:id/verification', authenticate, authorizeOrderManagement, orderRequestController.updateOrderVerification);
router.get('/:id/messages', authenticate, orderRequestController.getMessages);
router.post('/:id/messages', authenticate, orderRequestController.sendMessage);

module.exports = router;
