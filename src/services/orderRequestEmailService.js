/**
 * Order Request Email Service
 *
 * Sends email notifications for order request accept/reject/update actions.
 * Supports custom templates from email_templates table with fallback to default HTML.
 */

const nodemailer = require('nodemailer');
const { getSupabaseAdmin } = require('../config/database');

// --- SMTP Config ---
function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'email-smtp.us-east-1.amazonaws.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  });
}

// Fallback timezone when no user timezone is available
const FALLBACK_TZ = 'America/Chicago';

const ORDER_STATUS_MAP = {
  0: 'Normal', 1: 'Will Call', 2: 'Weather Permitting',
  3: 'Hold', 4: 'Completed', 5: 'Wait List',
};

function formatOrderCode(id) {
  return `OE-${(id || '').slice(0, 6).toUpperCase()}`;
}

/**
 * Format a date string in the user's timezone.
 * on_job_date is a plain date (YYYY-MM-DD) so we use UTC to avoid shifting.
 */
function formatDate(dateStr, tz) {
  if (!dateStr) return 'N/A';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 'N/A';
    // on_job_date is a plain date — use UTC to prevent server TZ shifts
    return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}-${d.getUTCFullYear()}`;
  } catch { return 'N/A'; }
}

/**
 * Format a plain time string (e.g. "12:40" or "18:30") to 12h format.
 */
function formatTime(timeStr) {
  if (!timeStr) return 'N/A';
  try {
    const str = String(timeStr).trim();
    // Already in 12h format
    const match12h = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (match12h) return str;
    const [h, m] = str.split(':');
    const hour = parseInt(h, 10);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const h12 = hour % 12 || 12;
    return `${h12}:${m} ${ampm}`;
  } catch { return timeStr; }
}

/**
 * Format the current date/time ("now") in the user's timezone.
 */
function formatNow(tz) {
  const timeZone = tz?.iana || FALLBACK_TZ;
  return new Date().toLocaleString('en-US', { timeZone });
}

/**
 * Format a UTC timestamp (like created_at) in the user's timezone.
 */
function formatTimestamp(dateTimeStr, tz) {
  if (!dateTimeStr) return 'N/A';
  try {
    const d = new Date(dateTimeStr);
    if (isNaN(d.getTime())) return 'N/A';
    const timeZone = tz?.iana || FALLBACK_TZ;
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    }).format(d);
  } catch { return 'N/A'; }
}

function computeTruckRate(spacing) {
  if (!spacing) return 'N/A';
  const mins = parseFloat(spacing);
  if (isNaN(mins) || mins <= 0) return 'N/A';
  return `${(60 / mins).toFixed(1)}/hr`;
}

function getOrderUrl(orderId) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://sws.truckast.ai';
  return `${baseUrl}/order-request/${orderId}`;
}

// --- Custom Template Support ---

async function getEmailTemplateByKey(templateKey) {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('email_templates')
      .select('*')
      .eq('template_key', templateKey)
      .eq('is_active', true)
      .limit(1)
      .single();

    if (error || !data) return null;
    return data;
  } catch {
    return null;
  }
}

function replaceVariables(text, variables) {
  if (!text) return '';
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return variables[key] !== undefined ? variables[key] : match;
  });
}

function toEmailSafeHtml(html, fontFamily, fontSize) {
  const baseStyle = `font-family: ${fontFamily}; font-size: ${fontSize}; color: #333333; line-height: 1.6;`;
  return html
    .replace(/<p>/g, `<p style="margin: 0 0 12px; ${baseStyle}">`)
    .replace(/<ul>/g, `<ul style="margin: 0 0 12px; padding-left: 24px; list-style-type: disc; ${baseStyle}">`)
    .replace(/<ol>/g, `<ol style="margin: 0 0 12px; padding-left: 24px; list-style-type: decimal; ${baseStyle}">`)
    .replace(/<li>/g, `<li style="margin: 0 0 4px; display: list-item; ${baseStyle}">`)
    .replace(/<strong>/g, '<strong style="font-weight: 700;">')
    .replace(/<em>/g, '<em style="font-style: italic;">')
    .replace(/<u>/g, '<u style="text-decoration: underline;">');
}

// Per-email-type layout builders for custom templates (matches web exactly)
function buildOrderSubmittedCustomHtml(body, footerText, fontFamily, fontSize, orderUrl) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:${fontFamily};font-size:${fontSize};background-color:#ffffff;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#ffffff;"><tr><td align="center">
<table cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;">
<tr><td style="padding:14px 24px;text-align:center;border-bottom:1px solid #eee;">
<p style="margin:0;color:#ef4444;font-size:12px;font-style:italic;">Please do not reply to this email. In order to respond, please reply in Truckast by clicking on the link <a href="${orderUrl}" style="color:#ef4444;font-weight:700;">View Order</a>.</p>
</td></tr>
<tr><td style="padding:22px 24px 6px;">
<a href="${orderUrl}" style="color:#22c55e;text-decoration:none;font-size:19px;font-weight:800;">Order Request - SUBMITTED</a>
</td></tr>
<tr><td style="padding:10px 24px 18px;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f5;border-left:4px solid #999;">
<tr><td style="padding:16px 18px;font-size:${fontSize};color:#333;line-height:1.8;font-family:${fontFamily};">
${body}
</td></tr></table>
</td></tr>
<tr><td style="padding:0 24px 14px;">
<table cellpadding="0" cellspacing="0" style="width:100%;">
<tr>
<td style="background-color:#1e293b;padding:10px 18px;text-align:center;border-right:2px solid #fff;width:33%;"><div style="font-size:9px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;">STATUS</div><div style="font-size:20px;font-weight:900;color:#fff;margin-top:2px;">PENDING</div></td>
<td style="background-color:#1e293b;padding:10px 18px;text-align:center;border-right:2px solid #fff;width:33%;"><div style="font-size:9px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;">ON JOB</div><div style="font-size:20px;font-weight:900;color:#fff;margin-top:2px;">—</div></td>
<td style="background-color:#1e293b;padding:10px 18px;text-align:center;width:33%;"><div style="font-size:9px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;">RATE</div><div style="font-size:20px;font-weight:900;color:#fff;margin-top:2px;">—</div></td>
</tr></table>
</td></tr>
<tr><td style="padding:0 24px 10px;"><table width="90%" cellpadding="0" cellspacing="0" style="background-color:#3b82f6;border-radius:4px;"><tr><td style="padding:14px 18px;">
<p style="margin:0;color:#fff;font-size:12px;font-weight:800;text-transform:uppercase;">USAGE / POUR METHOD / PO</p>
</td></tr></table></td></tr>
<tr><td style="padding:0 24px 10px;"><table width="90%" cellpadding="0" cellspacing="0" style="background-color:#3b82f6;border-radius:4px;"><tr><td style="padding:14px 18px;">
<p style="margin:0;color:#dbeafe;font-size:11px;text-transform:uppercase;font-weight:600;">Job Location</p>
<p style="margin:4px 0 0;color:#fff;font-size:15px;font-weight:900;text-transform:uppercase;">Address</p>
</td></tr></table></td></tr>
<tr><td style="padding:0 24px 10px;"><table width="90%" cellpadding="0" cellspacing="0" style="background-color:#6b8e23;border-radius:4px;"><tr><td style="padding:14px 18px;">
<p style="margin:0;color:#fff;font-size:12px;font-weight:800;text-transform:uppercase;">Concrete Product</p>
</td></tr></table></td></tr>
<tr><td style="padding:0 24px 10px;"><table width="90%" cellpadding="0" cellspacing="0" style="background-color:#3b82f6;border-radius:4px;"><tr><td style="padding:14px 18px;">
<p style="margin:0;color:#fff;font-size:12px;font-weight:800;text-transform:uppercase;">Admixture / Other Product</p>
</td></tr></table></td></tr>
<tr><td style="padding:14px 24px;text-align:center;border-top:1px solid #eee;">
<p style="margin:0;color:#ef4444;font-size:11px;line-height:1.6;font-family:${fontFamily};">${footerText}</p>
</td></tr>
</table></td></tr></table></body></html>`;
}

function buildOrderStatusCustomHtml(body, footerText, fontFamily, fontSize, orderUrl) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:${fontFamily};font-size:${fontSize};background-color:#ffffff;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#ffffff;"><tr><td align="center">
<table cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;">
<tr><td style="padding:14px 24px;text-align:center;border-bottom:1px solid #eee;">
<p style="margin:0;color:#ef4444;font-size:12px;font-style:italic;">Please do not reply to this email. In order to respond, please reply in Truckast.</p>
</td></tr>
<tr><td style="padding:22px 24px 6px;">
<a href="${orderUrl}" style="color:#22c55e;text-decoration:none;font-size:19px;font-weight:800;">Order Request - ACCEPTED</a>
</td></tr>
<tr><td style="padding:10px 24px 18px;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#eee;border-left:4px solid #999;">
<tr><td style="padding:14px 16px;font-size:${fontSize};color:#222;line-height:1.6;font-family:${fontFamily};">
${body}
</td></tr></table>
</td></tr>
<tr><td style="padding:0 24px 14px;">
<table cellpadding="0" cellspacing="0" style="width:100%;">
<tr>
<td style="background-color:#1e293b;padding:10px 18px;text-align:center;border-right:2px solid #fff;width:33%;"><div style="font-size:9px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;">STATUS</div><div style="font-size:20px;font-weight:900;color:#fff;margin-top:2px;">ACCEPTED</div></td>
<td style="background-color:#1e293b;padding:10px 18px;text-align:center;border-right:2px solid #fff;width:33%;"><div style="font-size:9px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;">ON JOB</div><div style="font-size:20px;font-weight:900;color:#fff;margin-top:2px;">—</div></td>
<td style="background-color:#1e293b;padding:10px 18px;text-align:center;width:33%;"><div style="font-size:9px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;">RATE</div><div style="font-size:20px;font-weight:900;color:#fff;margin-top:2px;">—</div></td>
</tr></table>
</td></tr>
<tr><td style="padding:0 24px 10px;"><table width="90%" cellpadding="0" cellspacing="0" style="background-color:#3b82f6;border-radius:4px;"><tr><td style="padding:14px 18px;">
<p style="margin:0;color:#fff;font-size:12px;font-weight:800;text-transform:uppercase;">USAGE / POUR METHOD</p>
</td></tr></table></td></tr>
<tr><td style="padding:0 24px 10px;"><table width="90%" cellpadding="0" cellspacing="0" style="background-color:#3b82f6;border-radius:4px;"><tr><td style="padding:14px 18px;">
<p style="margin:0;color:#dbeafe;font-size:11px;text-transform:uppercase;font-weight:600;">Job Location</p>
<p style="margin:4px 0 0;color:#fff;font-size:15px;font-weight:900;text-transform:uppercase;">Address</p>
</td></tr></table></td></tr>
<tr><td style="padding:0 24px 10px;"><table width="90%" cellpadding="0" cellspacing="0" style="background-color:#3b82f6;border-radius:4px;"><tr><td style="padding:14px 18px;">
<p style="margin:0;color:#fff;font-size:12px;font-weight:800;text-transform:uppercase;">CONTACT</p>
</td></tr></table></td></tr>
<tr><td style="padding:0 24px 10px;"><table width="90%" cellpadding="0" cellspacing="0" style="background-color:#6b8e23;border-radius:4px;"><tr><td style="padding:14px 18px;">
<p style="margin:0;color:#fff;font-size:12px;font-weight:800;text-transform:uppercase;">Concrete Product</p>
</td></tr></table></td></tr>
<tr><td style="padding:22px 24px 28px;text-align:center;">
<a href="${orderUrl}" style="display:inline-block;background-color:#111;color:#fff;text-decoration:none;padding:13px 36px;border-radius:6px;font-size:13px;font-weight:700;">View Order Details</a>
</td></tr>
<tr><td style="padding:14px 24px;text-align:center;border-top:1px solid #e5e7eb;">
<p style="margin:0;color:#ef4444;font-size:11px;line-height:1.6;font-family:${fontFamily};">${footerText}</p>
</td></tr>
</table></td></tr></table></body></html>`;
}

const CUSTOM_BUILDERS = {
  order_created: buildOrderSubmittedCustomHtml,
  order_updated: buildOrderSubmittedCustomHtml,
  order_accepted: buildOrderStatusCustomHtml,
  order_rejected: buildOrderStatusCustomHtml,
};

function renderCustomEmail(template, variables, templateKey) {
  const subject = replaceVariables(template.subject, variables);
  const bodyContent = replaceVariables(template.body_content || '', variables);
  const fontFamily = template.font_family || 'Arial, Helvetica, sans-serif';
  const fontSize = template.font_size || '14px';
  const footerText = replaceVariables(template.footer_text || 'This is an automated notification from Truckast.', variables);
  const safeBody = toEmailSafeHtml(bodyContent, fontFamily, fontSize);
  const orderUrl = variables.order_url || '#';

  // Use per-email-type layout builder (same as web)
  const builder = CUSTOM_BUILDERS[templateKey];
  if (builder) {
    return { subject, html: builder(safeBody, footerText, fontFamily, fontSize, orderUrl) };
  }

  // Fallback generic wrapper
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:${fontFamily};font-size:${fontSize};">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:24px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
<tr><td style="padding:32px 40px;">${safeBody}</td></tr>
<tr><td style="padding:16px 40px 24px;text-align:center;color:#9ca3af;font-size:12px;">${footerText}</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, html };
}

// --- Default HTML Generators ---

function generateOrderStatusEmailHTML(order, newStatus, recipientName, tz) {
  const orderCode = formatOrderCode(order.id);
  const orderUrl = getOrderUrl(order.id);
  const isAccepted = newStatus === 'approved';
  const statusLabel = isAccepted ? 'ACCEPTED' : 'REJECTED';
  const statusColor = isAccepted ? '#22c55e' : '#ef4444';
  const statusMessage = isAccepted
    ? 'Congrats, this Order Request has been accepted!'
    : 'This Order Request has been rejected.';
  const orderStatus = ORDER_STATUS_MAP[order.order_status] || 'Normal';
  const onJobDate = formatDate(order.on_job_date);
  const onJobTime = formatTime(order.on_job_time);
  const truckRate = computeTruckRate(order.truck_spacing);
  const now = formatNow(tz);

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:24px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">

<!-- Do not reply notice -->
<tr><td style="padding:16px 40px 8px;text-align:center;">
<p style="margin:0;color:#ef4444;font-size:12px;font-weight:600;">Please do not reply to this email.</p>
</td></tr>

<!-- Company & Plant -->
<tr><td style="padding:8px 40px;text-align:center;">
<h2 style="margin:0;color:#1f2937;font-size:18px;">${order.company_name || 'N/A'}</h2>
${order.plant_name ? `<p style="margin:4px 0 0;color:#6b7280;font-size:13px;">${order.plant_name}</p>` : ''}
</td></tr>

<!-- Request # with status -->
<tr><td style="padding:16px 40px;text-align:center;">
<a href="${orderUrl}" style="color:#3b82f6;font-size:16px;font-weight:600;text-decoration:none;">${orderCode}</a>
<span style="display:inline-block;margin-left:8px;padding:3px 10px;border-radius:12px;background:${statusColor}15;color:${statusColor};font-size:12px;font-weight:700;">${statusLabel}</span>
</td></tr>

<!-- Status message -->
<tr><td style="padding:0 40px 16px;">
<div style="background:${statusColor}08;border:1px solid ${statusColor}20;border-radius:8px;padding:16px;text-align:center;">
<p style="margin:0;color:#374151;font-size:14px;">${statusMessage}</p>
<p style="margin:8px 0 0;color:#9ca3af;font-size:12px;">${now}</p>
</div>
</td></tr>

<!-- Quick stats bar -->
<tr><td style="padding:0 40px 16px;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:8px;overflow:hidden;">
<tr>
<td style="padding:12px 16px;text-align:center;width:33%;border-right:2px solid #fff;">
<p style="margin:0;color:#9ca3af;font-size:10px;text-transform:uppercase;">Status</p>
<p style="margin:4px 0 0;color:#ffffff;font-size:13px;font-weight:600;">${orderStatus}</p>
</td>
<td style="padding:12px 16px;text-align:center;width:34%;border-right:2px solid #fff;">
<p style="margin:0;color:#9ca3af;font-size:10px;text-transform:uppercase;">On Job Date/Time</p>
<p style="margin:4px 0 0;color:#ffffff;font-size:13px;font-weight:600;">${onJobDate} ${onJobTime}</p>
</td>
<td style="padding:12px 16px;text-align:center;width:33%;">
<p style="margin:0;color:#9ca3af;font-size:10px;text-transform:uppercase;">Rate</p>
<p style="margin:4px 0 0;color:#ffffff;font-size:13px;font-weight:600;">${truckRate}</p>
</td>
</tr>
</table>
</td></tr>

<!-- Usage / Pour Method / PO -->
<tr><td style="padding:0 40px 12px;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#3b82f6;border-radius:4px;">
<tr>
<td style="padding:12px 16px;width:33%;"><p style="margin:0;color:#fff;font-size:12px;font-weight:800;text-transform:uppercase;">USAGE: ${order.usage_name || 'N/A'}</p></td>
<td style="padding:12px 16px;width:34%;"><p style="margin:0;color:#fff;font-size:12px;font-weight:800;text-transform:uppercase;">POUR METHOD: ${order.pour_method_name || 'N/A'}</p></td>
<td style="padding:12px 16px;width:33%;"><p style="margin:0;color:#dbeafe;font-size:12px;">PO: ${order.po_number || 'N/A'}</p></td>
</tr>
</table>
</td></tr>

<!-- Job Location -->
<tr><td style="padding:0 40px 12px;">
<table width="90%" cellpadding="0" cellspacing="0" style="background:#3b82f6;border-radius:4px;">
<tr><td style="padding:14px 18px;">
<p style="margin:0;color:#dbeafe;font-size:11px;text-transform:uppercase;font-weight:600;">${order.job_name || 'Job Location'}</p>
<p style="margin:4px 0 0;color:#fff;font-size:15px;font-weight:900;text-transform:uppercase;">${order.job_address || 'N/A'}</p>
<p style="margin:4px 0 0;color:#dbeafe;font-size:13px;text-transform:uppercase;">${order.job_city || ''}${order.job_state ? `, ${order.job_state}` : ''} ${order.job_zip_code || ''}</p>
</td></tr></table>
</td></tr>

<!-- Contact -->
<tr><td style="padding:0 40px 12px;">
<table width="90%" cellpadding="0" cellspacing="0" style="background:#3b82f6;border-radius:4px;">
<tr><td style="padding:14px 18px;">
<p style="margin:0;color:#fff;font-size:12px;font-weight:800;text-transform:uppercase;">CONTACT: ${order.job_contact_name || 'N/A'}</p>
<p style="margin:4px 0 0;color:#dbeafe;font-size:12px;">PHONE: ${order.job_contact_phone || 'N/A'}</p>
</td></tr></table>
</td></tr>

${order.driver_instructions ? `
<!-- Driver Instructions -->
<tr><td style="padding:0 40px 12px;">
<table width="90%" cellpadding="0" cellspacing="0" style="background:#3b82f6;border-radius:4px;">
<tr><td style="padding:14px 18px;">
<p style="margin:0;color:#fff;font-size:12px;font-weight:800;text-transform:uppercase;">DRIVER INSTRUCTIONS</p>
<p style="margin:4px 0 0;color:#dbeafe;font-size:12px;">${order.driver_instructions}</p>
</td></tr></table>
</td></tr>
` : ''}

${order.admixture_product_name ? `
<!-- Admixture -->
<tr><td style="padding:0 40px 12px;">
<table width="90%" cellpadding="0" cellspacing="0" style="background:#3b82f6;border-radius:4px;">
<tr><td style="padding:14px 18px;">
<p style="margin:0;color:#fff;font-size:12px;font-weight:800;text-transform:uppercase;">Admixture Product</p>
<p style="margin:4px 0 0;color:#dbeafe;font-size:12px;">${order.admixture_product_code || ''} — ${order.admixture_product_name}</p>
${order.admixture_notes ? `<p style="margin:4px 0 0;color:#dbeafe;font-size:12px;">${order.admixture_notes}</p>` : ''}
</td></tr></table>
</td></tr>
` : ''}

<!-- Concrete Product -->
<tr><td style="padding:0 40px 12px;">
<table width="90%" cellpadding="0" cellspacing="0" style="background:#6b8e23;border-radius:4px;">
<tr><td style="padding:14px 18px;">
<p style="margin:0;color:#fff;font-size:12px;font-weight:800;text-transform:uppercase;">${order.concrete_product_code || ''} ${order.concrete_product_name ? `(${order.concrete_product_name})` : ''}</p>
<p style="margin:5px 0 0;color:#fff;font-size:12px;text-transform:uppercase;">${order.air_non_air || 'AIR'}</p>
<p style="margin:6px 0 0;color:#fff;font-size:14px;font-weight:900;">${order.quantity || 'N/A'} CY</p>
<p style="margin:4px 0 0;color:#e2e8c0;font-size:12px;">SLUMP: ${order.slump || 'N/A'}</p>
<p style="margin:4px 0 0;color:#e2e8c0;font-size:12px;">PSI: ${order.psi || 'N/A'}</p>
${order.rock_size ? `<p style="margin:4px 0 0;color:#e2e8c0;font-size:12px;">ROCK SIZE: ${order.rock_size}</p>` : ''}
${order.fly_ash ? `<p style="margin:4px 0 0;color:#e2e8c0;font-size:12px;">FLY ASH: ${order.fly_ash}</p>` : ''}
${order.concrete_notes ? `<p style="margin:4px 0 0;color:#e2e8c0;font-size:12px;">NOTES: ${order.concrete_notes}</p>` : ''}
</td></tr></table>
</td></tr>

${order.other_product_name ? `
<!-- Other Product -->
<tr><td style="padding:0 40px 12px;">
<table width="90%" cellpadding="0" cellspacing="0" style="background:#3b82f6;border-radius:4px;">
<tr><td style="padding:14px 18px;">
<p style="margin:0;color:#fff;font-size:12px;font-weight:800;text-transform:uppercase;">OTHER PRODUCT</p>
<p style="margin:6px 0 0;color:#dbeafe;font-size:12px;text-transform:uppercase;">${order.other_product_code || ''} — ${order.other_product_name}</p>
${order.other_notes ? `<p style="margin:4px 0 0;color:#dbeafe;font-size:12px;">${order.other_notes}</p>` : ''}
</td></tr></table>
</td></tr>
` : ''}

<!-- CTA Button -->
<tr><td style="padding:22px 24px 28px;text-align:center;">
<a href="${orderUrl}" style="display:inline-block;background-color:#111;color:#fff;text-decoration:none;padding:13px 36px;border-radius:6px;font-size:13px;font-weight:700;">View Order Details</a>
</td></tr>

<!-- Footer -->
<tr><td style="padding:16px 40px 24px;text-align:center;border-top:1px solid #e5e7eb;">
<p style="margin:0;color:#9ca3af;font-size:12px;">This is an automated notification from Truckast.</p>
</td></tr>

</table>
</td></tr></table>
</body></html>`;
}

function generateOrderUpdatedEmailHTML(order, updaterName, showRegion = true, tz = null) {
  const orderCode = formatOrderCode(order.id);
  const orderUrl = getOrderUrl(order.id);
  const orderStatus = ORDER_STATUS_MAP[order.order_status] || 'Normal';
  const onJobDate = formatDate(order.on_job_date);
  const onJobTime = formatTime(order.on_job_time);
  const truckRate = computeTruckRate(order.truck_spacing);
  const now = formatNow(tz);

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:24px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">

<!-- Do not reply notice -->
<tr><td style="padding:16px 40px 8px;text-align:center;">
<p style="margin:0;color:#ef4444;font-size:12px;font-weight:600;">Please do not reply to this email. <a href="${orderUrl}" style="color:#3b82f6;">View order request</a></p>
</td></tr>

<!-- Company & Job Name -->
<tr><td style="padding:8px 40px;text-align:center;">
<h2 style="margin:0;color:#1f2937;font-size:18px;">${order.company_name || 'N/A'}</h2>
${order.job_name ? `<p style="margin:4px 0 0;color:#6b7280;font-size:13px;">${order.job_name}</p>` : ''}
</td></tr>

<!-- Request # with UPDATED label -->
<tr><td style="padding:16px 40px;text-align:center;">
<a href="${orderUrl}" style="color:#3b82f6;font-size:16px;font-weight:600;text-decoration:none;">${orderCode}</a>
<span style="display:inline-block;margin-left:8px;padding:3px 10px;border-radius:12px;background:#3b82f615;color:#3b82f6;font-size:12px;font-weight:700;">UPDATED</span>
</td></tr>

<!-- Details box -->
<tr><td style="padding:0 40px 16px;">
<div style="background:#f9fafb;border-left:4px solid #d1d5db;border-radius:4px;padding:16px;">
<p style="margin:0 0 12px;color:#374151;font-size:14px;font-weight:600;">${updaterName} updated an Order Request for ${order.company_name || 'N/A'}${order.company_id ? ` - ${order.company_id}` : ''}</p>
<table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#4b5563;">
<tr><td style="padding:3px 0;width:40%;color:#6b7280;">Order Request Number</td><td style="padding:3px 0;">${orderCode}</td></tr>
<tr><td style="padding:3px 0;color:#6b7280;">Requested Start Time</td><td style="padding:3px 0;">${onJobTime}</td></tr>
${showRegion !== false ? `<tr><td style="padding:3px 0;color:#6b7280;">Region</td><td style="padding:3px 0;">${order.region_name || 'N/A'}</td></tr>` : ''}
<tr><td style="padding:3px 0;color:#6b7280;">Customer</td><td style="padding:3px 0;">${order.company_name || 'N/A'}</td></tr>
<tr><td style="padding:3px 0;color:#6b7280;">Job</td><td style="padding:3px 0;">${order.job_name || 'N/A'}</td></tr>
<tr><td style="padding:3px 0;color:#6b7280;">Address</td><td style="padding:3px 0;">${order.job_address || 'N/A'}${order.job_city ? `, ${order.job_city}` : ''}${order.job_state ? `, ${order.job_state}` : ''} ${order.job_zip_code || ''}</td></tr>
${order.driver_instructions ? `<tr><td style="padding:3px 0;color:#6b7280;">Driver Instruction</td><td style="padding:3px 0;">${order.driver_instructions}</td></tr>` : ''}
<tr><td style="padding:3px 0;color:#6b7280;">Purchase Order</td><td style="padding:3px 0;">${order.po_number || 'N/A'}</td></tr>
<tr><td style="padding:3px 0;color:#6b7280;">Customer Job Number</td><td style="padding:3px 0;">${order.customer_job_number || 'N/A'}</td></tr>
<tr><td style="padding:3px 0;color:#6b7280;">Order Status</td><td style="padding:3px 0;">${orderStatus}</td></tr>
</table>
${order.concrete_product_name ? `
<p style="margin:12px 0 4px;color:#374151;font-size:13px;font-weight:600;">Products</p>
<table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;color:#4b5563;">
<tr><td style="padding:2px 0;color:#6b7280;">Product</td><td>${order.concrete_product_code || ''} — ${order.concrete_product_name}</td></tr>
<tr><td style="padding:2px 0;color:#6b7280;">Quantity</td><td>${order.quantity || 'N/A'}</td></tr>
<tr><td style="padding:2px 0;color:#6b7280;">Slump</td><td>${order.slump || 'N/A'}</td></tr>
${order.concrete_notes ? `<tr><td style="padding:2px 0;color:#6b7280;">Notes</td><td>${order.concrete_notes}</td></tr>` : ''}
</table>
` : ''}
${order.admixture_product_name ? `
<p style="margin:8px 0 2px;color:#6b7280;font-size:12px;">Admixture: ${order.admixture_product_name}</p>
` : ''}
<p style="margin:12px 0 0;color:#9ca3af;font-size:11px;">${now}</p>
</div>
</td></tr>

<!-- Quick stats bar -->
<tr><td style="padding:0 40px 16px;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:8px;overflow:hidden;">
<tr>
<td style="padding:12px 16px;text-align:center;width:33%;border-right:2px solid #fff;">
<p style="margin:0;color:#9ca3af;font-size:10px;text-transform:uppercase;">Status</p>
<p style="margin:4px 0 0;color:#ffffff;font-size:13px;font-weight:600;">${orderStatus}</p>
</td>
<td style="padding:12px 16px;text-align:center;width:34%;border-right:2px solid #fff;">
<p style="margin:0;color:#9ca3af;font-size:10px;text-transform:uppercase;">On Job Date/Time</p>
<p style="margin:4px 0 0;color:#ffffff;font-size:13px;font-weight:600;">${onJobDate} ${onJobTime}</p>
</td>
<td style="padding:12px 16px;text-align:center;width:33%;">
<p style="margin:0;color:#9ca3af;font-size:10px;text-transform:uppercase;">Rate</p>
<p style="margin:4px 0 0;color:#ffffff;font-size:13px;font-weight:600;">${truckRate}</p>
</td>
</tr>
</table>
</td></tr>

<!-- Usage / Pour Method / PO -->
<tr><td style="padding:0 24px 10px;">
<table width="90%" cellpadding="0" cellspacing="0" style="background-color:#3b82f6;border-radius:4px;">
<tr><td style="padding:14px 18px;">
<p style="margin:0;color:#fff;font-size:12px;font-weight:800;text-transform:uppercase;">USAGE: ${order.usage_name || 'N/A'}</p>
<p style="margin:5px 0 0;color:#fff;font-size:12px;font-weight:800;text-transform:uppercase;">POUR METHOD: ${order.pour_method_name || 'N/A'}</p>
<p style="margin:5px 0 0;color:#dbeafe;font-size:12px;">PO: ${order.po_number || 'N/A'}</p>
</td></tr></table>
</td></tr>

<!-- Job Location -->
<tr><td style="padding:0 24px 10px;">
<table width="90%" cellpadding="0" cellspacing="0" style="background-color:#3b82f6;border-radius:4px;">
<tr><td style="padding:14px 18px;">
<p style="margin:0;color:#dbeafe;font-size:11px;text-transform:uppercase;font-weight:600;">${order.job_name || 'Job Location'}</p>
<p style="margin:4px 0 0;color:#fff;font-size:15px;font-weight:900;text-transform:uppercase;">${order.job_address || 'N/A'}</p>
<p style="margin:4px 0 0;color:#dbeafe;font-size:13px;text-transform:uppercase;">${order.job_city || ''}${order.job_state ? `, ${order.job_state}` : ''} ${order.job_zip_code || ''}</p>
</td></tr></table>
</td></tr>

<!-- Concrete Product -->
<tr><td style="padding:0 24px 10px;">
<table width="90%" cellpadding="0" cellspacing="0" style="background-color:#6b8e23;border-radius:4px;">
<tr><td style="padding:14px 18px;">
<p style="margin:0;color:#fff;font-size:12px;font-weight:800;text-transform:uppercase;">${order.concrete_product_code || ''} ${order.concrete_product_name ? `(${order.concrete_product_name})` : ''}</p>
<p style="margin:5px 0 0;color:#fff;font-size:12px;text-transform:uppercase;">${order.air_non_air || 'AIR'}</p>
<p style="margin:6px 0 0;color:#fff;font-size:14px;font-weight:900;">${order.quantity || 'N/A'} CY</p>
<p style="margin:4px 0 0;color:#e2e8c0;font-size:12px;">SLUMP: ${order.slump || 'N/A'}</p>
<p style="margin:4px 0 0;color:#e2e8c0;font-size:12px;">PSI: ${order.psi || 'N/A'}</p>
${order.rock_size ? `<p style="margin:4px 0 0;color:#e2e8c0;font-size:12px;">ROCK SIZE: ${order.rock_size}</p>` : ''}
${order.fly_ash ? `<p style="margin:4px 0 0;color:#e2e8c0;font-size:12px;">FLY ASH: ${order.fly_ash}</p>` : ''}
${order.concrete_notes ? `<p style="margin:4px 0 0;color:#e2e8c0;font-size:12px;">NOTES: ${order.concrete_notes}</p>` : ''}
</td></tr></table>
</td></tr>

${order.admixture_product_name ? `
<!-- Admixture -->
<tr><td style="padding:0 24px 10px;">
<table width="90%" cellpadding="0" cellspacing="0" style="background-color:#3b82f6;border-radius:4px;">
<tr><td style="padding:14px 18px;">
<p style="margin:0;color:#fff;font-size:12px;font-weight:800;text-transform:uppercase;">Admixture Product</p>
<p style="margin:4px 0 0;color:#dbeafe;font-size:12px;">${order.admixture_product_code || ''} — ${order.admixture_product_name}</p>
${order.admixture_notes ? `<p style="margin:4px 0 0;color:#dbeafe;font-size:12px;">${order.admixture_notes}</p>` : ''}
</td></tr></table>
</td></tr>
` : ''}

${order.other_product_name ? `
<!-- Other Product -->
<tr><td style="padding:0 24px 10px;">
<table width="90%" cellpadding="0" cellspacing="0" style="background-color:#3b82f6;border-radius:4px;">
<tr><td style="padding:14px 18px;">
<p style="margin:0;color:#fff;font-size:12px;font-weight:800;text-transform:uppercase;">OTHER PRODUCT</p>
<p style="margin:6px 0 0;color:#dbeafe;font-size:12px;text-transform:uppercase;">${order.other_product_code || ''} — ${order.other_product_name}</p>
${order.other_notes ? `<p style="margin:4px 0 0;color:#dbeafe;font-size:12px;">${order.other_notes}</p>` : ''}
</td></tr></table>
</td></tr>
` : ''}

<!-- Footer -->
<tr><td style="padding:14px 24px;text-align:center;border-top:1px solid #eee;">
<p style="margin:0;color:#ef4444;font-size:11px;line-height:1.6;">This is an automated notification from Truckast.</p>
</td></tr>

</table>
</td></tr></table>
</body></html>`;
}

// --- Main Send Functions ---

async function sendOrderStatusEmail({ recipientEmail, recipientName, order, newStatus, tz }) {
  try {
    const orderCode = formatOrderCode(order.id);
    const statusLabel = newStatus === 'approved' ? 'Accepted' : 'Rejected';
    const orderUrl = getOrderUrl(order.id);

    const templateKey = newStatus === 'approved' ? 'order_accepted' : 'order_rejected';
    const variables = {
      recipient_name: recipientName || 'User',
      order_code: orderCode,
      status: statusLabel.toLowerCase(),
      status_label: statusLabel,
      order_url: orderUrl,
    };

    let subject = `Order Request ${statusLabel} — ${orderCode}`;
    let html;

    // Try custom template first
    const customTemplate = await getEmailTemplateByKey(templateKey);
    if (customTemplate) {
      const rendered = renderCustomEmail(customTemplate, variables, templateKey);
      subject = rendered.subject;
      html = rendered.html;
    } else {
      html = generateOrderStatusEmailHTML(order, newStatus, recipientName, tz);
    }

    const qty = order.quantity ? `${Number(order.quantity).toFixed(2)} CY` : '—';
    const text = `Hello ${recipientName},\n\nYour order request ${orderCode} has been ${statusLabel.toLowerCase()}.\n\nOrder Summary:\n- Company: ${order.company_name || '—'}\n- Job: ${order.job_name || '—'}\n- Date: ${formatDate(order.on_job_date)}${order.on_job_time ? ` at ${formatTime(order.on_job_time)}` : ''}\n- Location: ${order.job_address || '—'}, ${order.job_city || ''}${order.job_state ? `, ${order.job_state}` : ''} ${order.job_zip_code || ''}\n- Contact: ${order.job_contact_name || '—'} - ${order.job_contact_phone || '—'}\n- Concrete: ${order.concrete_product_name || '—'} - ${qty}\n\nView Order: ${orderUrl}\n\n---\nThis email was sent by Truckast. Please do not reply.`;

    const transporter = createTransporter();
    const fromEmail = process.env.SMTP_FROM_EMAIL || 'noreply@truckast.com';
    const fromName = process.env.SMTP_FROM_NAME || 'Truckast';

    await transporter.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to: recipientEmail,
      subject,
      html,
      text,
    });

    console.log(`[OrderRequestEmail] ${statusLabel} email sent to ${recipientEmail} for ${orderCode}`);
  } catch (error) {
    console.error(`[OrderRequestEmail] Failed to send status email:`, error.message);
  }
}

async function sendOrderCreatedEmail({ recipientEmail, recipientName, order, showRegion = true, tz }) {
  try {
    const orderCode = formatOrderCode(order.id);
    const orderUrl = getOrderUrl(order.id);

    const templateKey = 'order_created';
    const variables = {
      creator_name: recipientName || 'User',
      company_name: order.company_name || 'N/A',
      order_code: orderCode,
      order_url: orderUrl,
    };

    let subject = `New Order Request — ${orderCode} — ${order.company_name || ''}`;
    let html;

    const customTemplate = await getEmailTemplateByKey(templateKey);
    if (customTemplate) {
      const rendered = renderCustomEmail(customTemplate, variables, templateKey);
      subject = rendered.subject;
      html = rendered.html;
    } else {
      html = generateOrderUpdatedEmailHTML(order, recipientName, showRegion, tz);
    }

    const text = `${recipientName} placed an Order Request for ${order.company_name || '—'}\n\nRequest #${orderCode} - SUBMITTED\n\nCompany: ${order.company_name || '—'}\nJob: ${order.job_name || '—'}\nAddress: ${order.job_address || '—'}, ${order.job_city || ''}${order.job_state ? `, ${order.job_state}` : ''} ${order.job_zip_code || ''}\nDate: ${formatDate(order.on_job_date)} at ${formatTime(order.on_job_time)}\nProduct: ${order.concrete_product_name || '—'}\nQuantity: ${order.quantity ? `${Number(order.quantity).toFixed(2)} CY` : '—'}\nContact: ${order.job_contact_name || '—'} - ${order.job_contact_phone || '—'}\n\nView Order: ${orderUrl}\n\n---\nThis email was sent by Truckast. Please do not reply.`;

    const transporter = createTransporter();
    const fromEmail = process.env.SMTP_FROM_EMAIL || 'noreply@truckast.com';
    const fromName = process.env.SMTP_FROM_NAME || 'Truckast';

    await transporter.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to: recipientEmail,
      subject,
      html,
      text,
    });

    console.log(`[OrderRequestEmail] Created email sent to ${recipientEmail} for ${orderCode}`);
  } catch (error) {
    console.error(`[OrderRequestEmail] Failed to send created email:`, error.message);
  }
}

async function sendOrderUpdatedEmail({ recipientEmails, updaterName, order, showRegion = true, tz }) {
  try {
    const orderCode = formatOrderCode(order.id);
    const orderUrl = getOrderUrl(order.id);

    const templateKey = 'order_updated';
    const variables = {
      updater_name: updaterName || 'User',
      creator_name: updaterName || 'User',
      company_name: order.company_name || 'N/A',
      order_code: orderCode,
      order_url: orderUrl,
    };

    let subject = `Order Request Updated — ${orderCode} — ${order.company_name || ''}`;
    let html;

    const customTemplate = await getEmailTemplateByKey(templateKey);
    if (customTemplate) {
      const rendered = renderCustomEmail(customTemplate, variables, templateKey);
      subject = rendered.subject;
      html = rendered.html;
    } else {
      html = generateOrderUpdatedEmailHTML(order, updaterName, showRegion, tz);
    }

    const text = `${updaterName} updated an Order Request for ${order.company_name || '—'}\n\nRequest #${orderCode} - UPDATED\n\nCompany: ${order.company_name || '—'}\nJob: ${order.job_name || '—'}\nAddress: ${order.job_address || '—'}, ${order.job_city || ''}${order.job_state ? `, ${order.job_state}` : ''} ${order.job_zip_code || ''}\nDate: ${formatDate(order.on_job_date)} at ${formatTime(order.on_job_time)}\nProduct: ${order.concrete_product_name || '—'}\nQuantity: ${order.quantity ? `${Number(order.quantity).toFixed(2)} CY` : '—'}\nContact: ${order.job_contact_name || '—'} - ${order.job_contact_phone || '—'}\n\nView Order: ${orderUrl}\n\n---\nThis email was sent by Truckast. Please do not reply.`;

    const transporter = createTransporter();
    const fromEmail = process.env.SMTP_FROM_EMAIL || 'noreply@truckast.com';
    const fromName = process.env.SMTP_FROM_NAME || 'Truckast';

    const emails = Array.isArray(recipientEmails) ? recipientEmails : [recipientEmails];
    const uniqueEmails = [...new Set(emails.filter(Boolean))];

    await transporter.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to: uniqueEmails.join(', '),
      subject,
      html,
      text,
    });

    console.log(`[OrderRequestEmail] Updated email sent to ${uniqueEmails.join(', ')} for ${orderCode}`);
  } catch (error) {
    console.error(`[OrderRequestEmail] Failed to send updated email:`, error.message);
  }
}

module.exports = {
  sendOrderStatusEmail,
  sendOrderCreatedEmail,
  sendOrderUpdatedEmail,
};
