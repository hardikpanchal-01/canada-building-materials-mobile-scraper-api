const emailTemplateService = require('../services/emailTemplateService');

// GET /api/email-templates
async function getTemplates(req, res) {
  try {
    const templates = await emailTemplateService.getEmailTemplates();
    const defaults = emailTemplateService.getDefaultTemplates();

    // Merge: mark each default with whether a custom DB version exists
    const customKeySet = new Set(templates.map(t => t.template_key));
    const merged = defaults.map(def => ({
      ...def,
      has_custom: customKeySet.has(def.template_key),
      custom_template: templates.find(t => t.template_key === def.template_key) || null,
    }));

    return res.status(200).json({
      success: true,
      message: 'Email templates retrieved successfully',
      data: { templates, defaults: merged },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch email templates',
      error_code: 'INTERNAL_ERROR',
    });
  }
}

// GET /api/email-templates/defaults
async function getDefaults(req, res) {
  try {
    const defaults = emailTemplateService.getDefaultTemplates();

    return res.status(200).json({
      success: true,
      message: 'Default email template definitions retrieved successfully',
      data: { defaults },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch default templates',
      error_code: 'INTERNAL_ERROR',
    });
  }
}

// GET /api/email-templates/:id
async function getTemplateById(req, res) {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Email template ID is required',
        error_code: 'VALIDATION_ERROR',
      });
    }

    const data = await emailTemplateService.getEmailTemplateById(id);
    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Email template not found',
        error_code: 'NOT_FOUND',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Email template retrieved successfully',
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch email template',
      error_code: 'INTERNAL_ERROR',
    });
  }
}

// POST /api/email-templates
async function createTemplate(req, res) {
  try {
    const { template_key, name, subject } = req.body;

    if (!template_key || !name || !subject) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: template_key, name, subject',
        error_code: 'VALIDATION_ERROR',
      });
    }

    const data = await emailTemplateService.createEmailTemplate(req.body);

    return res.status(201).json({
      success: true,
      message: 'Email template created successfully',
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to create email template',
      error_code: 'INTERNAL_ERROR',
    });
  }
}

// PUT /api/email-templates/:id
async function updateTemplate(req, res) {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Email template ID is required',
        error_code: 'VALIDATION_ERROR',
      });
    }

    const data = await emailTemplateService.updateEmailTemplate(id, req.body);

    return res.status(200).json({
      success: true,
      message: 'Email template updated successfully',
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to update email template',
      error_code: 'INTERNAL_ERROR',
    });
  }
}

// DELETE /api/email-templates/:id
async function deleteTemplate(req, res) {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Email template ID is required',
        error_code: 'VALIDATION_ERROR',
      });
    }

    const data = await emailTemplateService.deleteEmailTemplate(id);

    return res.status(200).json({
      success: true,
      message: 'Email template deleted successfully',
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete email template',
      error_code: 'INTERNAL_ERROR',
    });
  }
}

module.exports = {
  getTemplates,
  getDefaults,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate,
};
