-- Migration: Create signup_pending and signup_otps tables
-- These tables support the 4-step signup flow:
--   Step 1: signup_pending record created (email + name)
--   Step 2: email OTP verified → email_verified = true
--   Step 3: phone OTP sent → phone stored
--   Step 4: phone OTP verified → real user created, pending record cleaned up

-- ============================================================================
-- signup_pending: Stores incomplete signups until fully verified
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.signup_pending (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL DEFAULT '',
  phone_number TEXT NOT NULL DEFAULT '',
  phone_country_code TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast email lookups
CREATE INDEX IF NOT EXISTS idx_signup_pending_email ON public.signup_pending (email);

-- ============================================================================
-- signup_otps: Stores hashed OTP codes for email and phone verification
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.signup_otps (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  identifier TEXT NOT NULL,          -- email address or full phone number
  type TEXT NOT NULL CHECK (type IN ('email', 'phone')),
  otp_hash TEXT NOT NULL,            -- SHA-256 hash of the OTP
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for OTP lookups
CREATE INDEX IF NOT EXISTS idx_signup_otps_identifier_type ON public.signup_otps (identifier, type);
CREATE INDEX IF NOT EXISTS idx_signup_otps_expires ON public.signup_otps (expires_at);

-- ============================================================================
-- RLS: Disable RLS on these tables (server uses service key)
-- ============================================================================
ALTER TABLE public.signup_pending ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signup_otps ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY IF NOT EXISTS "Service role full access on signup_pending"
  ON public.signup_pending FOR ALL
  USING (true) WITH CHECK (true);

CREATE POLICY IF NOT EXISTS "Service role full access on signup_otps"
  ON public.signup_otps FOR ALL
  USING (true) WITH CHECK (true);
