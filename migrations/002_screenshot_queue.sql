-- Phase 1: Supabase Queue Schema for Asynchronous Screenshot System
-- Run this in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS screenshot_queue (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sheet_url TEXT NOT NULL,
  target_id TEXT NOT NULL,
  is_group BOOLEAN DEFAULT false,
  seatalk_app_id TEXT NOT NULL,
  seatalk_app_secret TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  created_at TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ
);

-- Index for fast polling of pending jobs
CREATE INDEX idx_screenshot_queue_status_created 
ON screenshot_queue(status, created_at) 
WHERE status = 'pending';

-- Row Level Security (optional, using service_role bypasses this)
ALTER TABLE screenshot_queue ENABLE ROW LEVEL SECURITY;

-- Policy: Service role has full access
CREATE POLICY "Service role full access"
ON screenshot_queue
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);