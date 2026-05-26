const express = require('express');
const router = express.Router();
const emailTemplateController = require('../controllers/emailTemplateController');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, emailTemplateController.getTemplates);
router.get('/defaults', authenticate, emailTemplateController.getDefaults);
router.get('/:id', authenticate, emailTemplateController.getTemplateById);
router.post('/', authenticate, emailTemplateController.createTemplate);
router.put('/:id', authenticate, emailTemplateController.updateTemplate);
router.delete('/:id', authenticate, emailTemplateController.deleteTemplate);

module.exports = router;
