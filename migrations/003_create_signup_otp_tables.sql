-- ============================================================================
-- Migration: Create signup_otps and signup_pending tables
-- Description: Supports OTP-based signup flow with email & phone verification
-- ============================================================================

-- Table: signup_otps
-- Stores hashed OTPs for both email and phone verification
CREATE TABLE IF NOT EXISTS signup_otps (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  identifier TEXT NOT NULL,           -- email address or full phone number
  type TEXT NOT NULL CHECK (type IN ('email', 'phone')),
  otp_hash TEXT NOT NULL,             -- SHA-256 hash of OTP
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER DEFAULT 0,         -- failed verification attempts
  verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_signup_otps_identifier_type
  ON signup_otps (identifier, type, verified);

CREATE INDEX IF NOT EXISTS idx_signup_otps_expires_at
  ON signup_otps (expires_at);

-- Table: signup_pending
-- Stores user data during the multi-step signup flow (before final creation)
CREATE TABLE IF NOT EXISTS signup_pending (
  email TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,        -- AES-256-GCM encrypted password
  full_name TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  phone_country_code TEXT NOT NULL,
  title TEXT NOT NULL,
  email_verified BOOLEAN DEFAULT FALSE,
  phone_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-cleanup: delete pending signups older than 24 hours (optional cron)
-- You can schedule: DELETE FROM signup_pending WHERE created_at < NOW() - INTERVAL '24 hours';
-- And: DELETE FROM signup_otps WHERE expires_at < NOW();
