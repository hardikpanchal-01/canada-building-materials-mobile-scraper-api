const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const controller = require('../controllers/dailyIntelligenceController');

router.get('/', authenticate, controller.getDailyIntelligence);
router.get('/odp', authenticate, controller.getODPData);

module.exports = router;
