const { getSupabaseAdmin } = require('../config/database');

// =============================================================================
// Static default template definitions
// =============================================================================

const DEFAULT_TEMPLATES = [
  // Category: Order Request — matches web exactly (email-template-types.ts)
  {
    template_key: 'order_created',
    name: 'Order Request Created',
    category: 'Order Request',
    default_subject: 'New Order Request — {{order_code}} — {{company_name}}',
    body_content: '<p>{{creator_name}} placed an Order Request for {{company_name}}.</p><p>Please review the order details below.</p>',
    description: 'Sent to the order creator when a new order request is submitted',
    variables: ['{{creator_name}}', '{{company_name}}', '{{order_code}}', '{{order_url}}'],
  },
  {
    template_key: 'order_updated',
    name: 'Order Request Updated',
    category: 'Order Request',
    default_subject: 'Order Request Updated — {{order_code}} — {{company_name}}',
    body_content: '<p>{{updater_name}} updated an Order Request for {{company_name}}.</p><p>Please review the updated order details below.</p>',
    description: 'Sent to the updater and original creator when an order request is updated',
    variables: ['{{updater_name}}', '{{company_name}}', '{{order_code}}', '{{order_url}}'],
  },
  {
    template_key: 'order_accepted',
    name: 'Order Request Accepted',
    category: 'Order Request',
    default_subject: 'Order Request Accepted — {{order_code}}',
    body_content: '<p>Hello {{recipient_name}},</p><p>Congrats! Your order request {{order_code}} has been accepted.</p>',
    description: 'Sent to the order creator when an order request is accepted/approved',
    variables: ['{{recipient_name}}', '{{order_code}}', '{{status_label}}', '{{order_url}}'],
  },
  {
    template_key: 'order_rejected',
    name: 'Order Request Rejected',
    category: 'Order Request',
    default_subject: 'Order Request Rejected — {{order_code}}',
    body_content: '<p>Hello {{recipient_name}},</p><p>Your order request {{order_code}} has been rejected.</p>',
    description: 'Sent to the order creator when an order request is rejected',
    variables: ['{{recipient_name}}', '{{order_code}}', '{{status_label}}', '{{order_url}}'],
  },
];

// =============================================================================
// Database operations
// =============================================================================

// Fetch all email templates ordered by template_key
async function getEmailTemplates() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('email_templates')
    .select('*')
    .order('template_key', { ascending: true });

  if (error) throw new Error(`Failed to fetch email templates: ${error.message}`);
  return data || [];
}

// Fetch a single email template by id
async function getEmailTemplateById(id) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('email_templates')
    .select('*')
    .eq('id', id)
    .single();

  if (error) throw new Error(`Email template not found: ${error.message}`);
  return data;
}

// Fetch an active email template by template_key
async function getEmailTemplateByKey(templateKey) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('email_templates')
    .select('*')
    .eq('template_key', templateKey)
    .eq('is_active', true)
    .single();

  if (error) throw new Error(`Email template not found for key "${templateKey}": ${error.message}`);
  return data;
}

// Create a new email template
async function createEmailTemplate(input) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('email_templates')
    .insert({
      template_key: input.template_key,
      name: input.name,
      subject: input.subject,
      body_content: input.body_content || '',
      font_family: input.font_family || 'Arial, Helvetica, sans-serif',
      font_size: input.font_size || '14px',
      footer_text: input.footer_text || 'This is an automated notification...',
      is_active: input.is_active !== undefined ? input.is_active : true,
      tenant_id: input.tenant_id || null,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create email template: ${error.message}`);
  return data;
}

// Update an existing email template
async function updateEmailTemplate(id, input) {
  const supabase = getSupabaseAdmin();

  const updatePayload = { updated_at: new Date().toISOString() };

  if (input.template_key !== undefined) updatePayload.template_key = input.template_key;
  if (input.name !== undefined) updatePayload.name = input.name;
  if (input.subject !== undefined) updatePayload.subject = input.subject;
  if (input.body_content !== undefined) updatePayload.body_content = input.body_content;
  if (input.font_family !== undefined) updatePayload.font_family = input.font_family;
  if (input.font_size !== undefined) updatePayload.font_size = input.font_size;
  if (input.footer_text !== undefined) updatePayload.footer_text = input.footer_text;
  if (input.is_active !== undefined) updatePayload.is_active = input.is_active;
  if (input.tenant_id !== undefined) updatePayload.tenant_id = input.tenant_id;

  const { data, error } = await supabase
    .from('email_templates')
    .update(updatePayload)
    .eq('id', id)
    .select()
    .single();

  if (error) throw new Error(`Failed to update email template: ${error.message}`);
  return data;
}

// Delete an email template by id
async function deleteEmailTemplate(id) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('email_templates')
    .delete()
    .eq('id', id);

  if (error) throw new Error(`Failed to delete email template: ${error.message}`);
  return { id };
}

// Return static default template definitions
function getDefaultTemplates() {
  return DEFAULT_TEMPLATES;
}

module.exports = {
  getEmailTemplates,
  getEmailTemplateById,
  getEmailTemplateByKey,
  createEmailTemplate,
  updateEmailTemplate,
  deleteEmailTemplate,
  getDefaultTemplates,
};
