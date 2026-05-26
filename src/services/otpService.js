/**
 * OTP Service
 *
 * Handles OTP generation, storage (in Supabase), email sending (SMTP/nodemailer),
 * and phone sending (Twilio). Includes expiry, retry limits, and cooldown logic.
 */

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { getSupabaseAdmin } = require('../config/database');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const OTP_LENGTH = 6;
const OTP_EXPIRY_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;           // max wrong verifications before lockout
const OTP_RESEND_COOLDOWN_SECONDS = 60; // min gap between OTP sends
const OTP_MAX_SENDS = 5;              // max OTPs per email/phone per hour

// ---------------------------------------------------------------------------
// SMTP transporter (reuse existing env vars)
// ---------------------------------------------------------------------------
let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT, 10) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD
      }
    });
  }
  return transporter;
}

// ---------------------------------------------------------------------------
// Twilio client (lazy init)
// ---------------------------------------------------------------------------
let twilioClient = null;

function getTwilioClient() {
  if (!twilioClient) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) {
      throw new Error('Twilio credentials not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.');
    }
    const twilio = require('twilio');
    twilioClient = twilio(accountSid, authToken);
  }
  return twilioClient;
}

// ---------------------------------------------------------------------------
// OTP Generation
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically secure numeric OTP
 * @returns {string} 6-digit OTP string
 */
function generateOtp() {
  const max = Math.pow(10, OTP_LENGTH);
  const num = crypto.randomInt(0, max);
  return String(num).padStart(OTP_LENGTH, '0');
}

/**
 * Hash OTP before storing (SHA-256)
 * @param {string} otp - Plain-text OTP
 * @returns {string} Hex-encoded hash
 */
function hashOtp(otp) {
  return crypto.createHash('sha256').update(otp).digest('hex');
}

// ---------------------------------------------------------------------------
// Supabase OTP table helpers
// Table: signup_otps (auto-created via migration or manually)
//   id (uuid, pk), identifier (text), type (text: 'email'|'phone'),
//   otp_hash (text), expires_at (timestamptz), attempts (int default 0),
//   verified (bool default false), created_at (timestamptz default now())
// ---------------------------------------------------------------------------

/**
 * Check resend cooldown & hourly send limit
 * @param {string} identifier - email or phone
 * @param {string} type - 'email' or 'phone'
 * @returns {{ allowed: boolean, waitSeconds?: number, error?: string }}
 */
async function checkSendLimits(identifier, type) {
  const supabase = getSupabaseAdmin();

  // Get most recent OTP for this identifier+type
  const { data: recent } = await supabase
    .from('signup_otps')
    .select('created_at')
    .eq('identifier', identifier)
    .eq('type', type)
    .order('created_at', { ascending: false })
    .limit(1);

  if (recent && recent.length > 0) {
    const lastSentAt = new Date(recent[0].created_at);
    const secondsSince = (Date.now() - lastSentAt.getTime()) / 1000;
    if (secondsSince < OTP_RESEND_COOLDOWN_SECONDS) {
      const waitSeconds = Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - secondsSince);
      return { allowed: false, waitSeconds, error: `Please wait ${waitSeconds} seconds before requesting a new OTP.` };
    }
  }

  // Check hourly send limit
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('signup_otps')
    .select('id', { count: 'exact', head: true })
    .eq('identifier', identifier)
    .eq('type', type)
    .gte('created_at', oneHourAgo);

  if (count >= OTP_MAX_SENDS) {
    return { allowed: false, error: 'Too many OTP requests. Please try again after an hour.' };
  }

  return { allowed: true };
}

/**
 * Store OTP in database, invalidating previous unverified entries
 * @param {string} identifier - email or phone
 * @param {string} type - 'email' or 'phone'
 * @param {string} otp - Plain-text OTP (hashed before storage)
 */
async function storeOtp(identifier, type, otp) {
  const supabase = getSupabaseAdmin();

  // Invalidate previous unverified OTPs for this identifier+type
  await supabase
    .from('signup_otps')
    .delete()
    .eq('identifier', identifier)
    .eq('type', type)
    .eq('verified', false);

  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString();

  const { error } = await supabase
    .from('signup_otps')
    .insert({
      identifier,
      type,
      otp_hash: hashOtp(otp),
      expires_at: expiresAt,
      attempts: 0,
      verified: false
    });

  if (error) {
    console.error('Error storing OTP:', error.message);
    throw new Error('Failed to store OTP');
  }
}

/**
 * Verify OTP against database
 * @param {string} identifier - email or phone
 * @param {string} type - 'email' or 'phone'
 * @param {string} otp - Plain-text OTP to verify
 * @returns {{ success: boolean, error?: string, code?: string }}
 */
async function verifyOtp(identifier, type, otp) {
  const supabase = getSupabaseAdmin();

  // Fetch the latest unverified OTP for this identifier+type
  const { data: records } = await supabase
    .from('signup_otps')
    .select('*')
    .eq('identifier', identifier)
    .eq('type', type)
    .eq('verified', false)
    .order('created_at', { ascending: false })
    .limit(1);

  if (!records || records.length === 0) {
    return { success: false, error: 'No OTP found. Please request a new one.', code: 'OTP_NOT_FOUND' };
  }

  const record = records[0];

  // Check expiry
  if (new Date(record.expires_at) < new Date()) {
    await supabase.from('signup_otps').delete().eq('id', record.id);
    return { success: false, error: 'OTP has expired. Please request a new one.', code: 'OTP_EXPIRED' };
  }

  // Check max attempts
  if (record.attempts >= OTP_MAX_ATTEMPTS) {
    await supabase.from('signup_otps').delete().eq('id', record.id);
    return { success: false, error: 'Too many failed attempts. Please request a new OTP.', code: 'MAX_ATTEMPTS' };
  }

  // Compare hashes
  if (record.otp_hash !== hashOtp(otp)) {
    // Increment attempts
    await supabase
      .from('signup_otps')
      .update({ attempts: record.attempts + 1 })
      .eq('id', record.id);

    const remaining = OTP_MAX_ATTEMPTS - record.attempts - 1;
    return {
      success: false,
      error: `Invalid OTP`,
      code: 'INVALID_OTP'
    };
  }

  // Mark as verified
  await supabase
    .from('signup_otps')
    .update({ verified: true })
    .eq('id', record.id);

  return { success: true };
}

/**
 * Check if an identifier has a verified OTP
 * @param {string} identifier
 * @param {string} type - 'email' or 'phone'
 * @returns {boolean}
 */
async function isVerified(identifier, type) {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from('signup_otps')
    .select('id')
    .eq('identifier', identifier)
    .eq('type', type)
    .eq('verified', true)
    .limit(1);

  return data && data.length > 0;
}

// ---------------------------------------------------------------------------
// Email OTP Sending
// ---------------------------------------------------------------------------

/**
 * Send OTP to user's email via SMTP
 * @param {string} email
 * @param {string} otp
 */
async function sendEmailOtp(email, otp) {
  const transport = getTransporter();
  const fromEmail = process.env.SMTP_FROM_EMAIL || 'noreply@truckast.com';
  const fromName = process.env.SMTP_FROM_NAME || 'Truckast';

  await transport.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to: email,
    subject: 'Your Truckast Verification Code',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #1a1a1a; margin-bottom: 16px;">Email Verification</h2>
        <p style="color: #4a4a4a; font-size: 16px;">Your verification code is:</p>
        <div style="background: #f4f4f4; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #1a1a1a;">${otp}</span>
        </div>
        <p style="color: #4a4a4a; font-size: 14px;">This code expires in ${OTP_EXPIRY_MINUTES} minutes.</p>
        <p style="color: #999; font-size: 12px; margin-top: 24px;">If you didn't request this code, please ignore this email.</p>
      </div>
    `
  });
}

// ---------------------------------------------------------------------------
// Phone OTP Sending (Twilio SMS)
// ---------------------------------------------------------------------------

/**
 * Send OTP to user's phone via Twilio SMS
 * @param {string} phone - Full phone number with country code (e.g. +11234567890)
 * @param {string} otp
 */
async function sendPhoneOtp(phone, otp) {
  const client = getTwilioClient();
  const from = process.env.TWILIO_PHONE_NUMBER || process.env.SMS_TEST_PHONE_NUMBER;

  if (!from) {
    throw new Error('Twilio phone number not configured. Set TWILIO_PHONE_NUMBER in .env.');
  }

  await client.messages.create({
    body: `Your Truckast verification code is: ${otp}. It expires in ${OTP_EXPIRY_MINUTES} minutes.`,
    from,
    to: phone
  });
}

// ---------------------------------------------------------------------------
// High-level orchestration
// ---------------------------------------------------------------------------

/**
 * Generate, store, and send email OTP
 * @param {string} email
 * @returns {{ success: boolean, error?: string, waitSeconds?: number }}
 */
async function requestEmailOtp(email) {
  const limits = await checkSendLimits(email, 'email');
  if (!limits.allowed) {
    return { success: false, error: limits.error, waitSeconds: limits.waitSeconds, code: 'RATE_LIMITED' };
  }

  const otp = generateOtp();
  await storeOtp(email, 'email', otp);
  await sendEmailOtp(email, otp);
  return { success: true };
}

/**
 * Generate, store, and send phone OTP
 * @param {string} phone - Full phone number with country code
 * @returns {{ success: boolean, error?: string, waitSeconds?: number }}
 */
async function requestPhoneOtp(phone) {
  const limits = await checkSendLimits(phone, 'phone');
  if (!limits.allowed) {
    return { success: false, error: limits.error, waitSeconds: limits.waitSeconds, code: 'RATE_LIMITED' };
  }

  const otp = generateOtp();
  await storeOtp(phone, 'phone', otp);

  try {
    await sendPhoneOtp(phone, otp);
  } catch (err) {
    console.error('[OTP] Twilio SMS error:', err.message, err.code, err.moreInfo);
    return {
      success: false,
      error: `Failed to send SMS: ${err.message || 'Unknown Twilio error'}`,
      code: 'SMS_SEND_FAILED'
    };
  }

  return { success: true };
}

module.exports = {
  requestEmailOtp,
  requestPhoneOtp,
  verifyOtp,
  isVerified,
  OTP_EXPIRY_MINUTES
};
