-- ============================================================
-- VASA Seatalk Bot - Supabase Schema (Migration 001)
-- ============================================================
-- Project: seatalk_bot
-- Project ID: gsdtravhmqbzkwdujkve
-- ============================================================

-- 1. TENANTS (System Accounts)
-- Untuk multi-tenant: setiap user bisa punya bot custom
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id TEXT UNIQUE NOT NULL,
  app_secret TEXT NOT NULL,
  webhook_url TEXT,
  owner_email TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_tenants_app_id ON tenants(app_id);
CREATE INDEX idx_tenants_owner_email ON tenants(owner_email);

-- 2. SCHEDULES (Automated Screenshot Jobs)
-- Cron jobs untuk auto-report
CREATE TABLE IF NOT EXISTS schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cron_minute INT[] DEFAULT '{0}',
  cron_hour INT[] DEFAULT '{9}',
  cron_dow INT[] DEFAULT '{1,2,3,4,5}', -- 1=Senin, 5=Jumat
  sheet_id TEXT NOT NULL,
  sheet_name TEXT,
  range TEXT DEFAULT 'A1:Z100',
  webhook_url TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  last_run_at TIMESTAMP WITH TIME ZONE,
  last_run_status TEXT CHECK (last_run_status IN ('success', 'failed', 'timeout')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_schedules_tenant_id ON schedules(tenant_id);
CREATE INDEX idx_schedules_is_active ON schedules(is_active);
CREATE INDEX idx_schedules_last_run_at ON schedules(last_run_at);

-- 3. DELIVERY LOGS
-- Audit trail untuk setiap screenshot yang dikirim
CREATE TABLE IF NOT EXISTS delivery_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID REFERENCES schedules(id) ON DELETE SET NULL,
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'timeout')),
  error_message TEXT,
  pdf_size_bytes INT,
  png_size_bytes INT,
  render_duration_ms INT,
  target_id TEXT NOT NULL,
  is_group BOOLEAN DEFAULT false
);

CREATE INDEX idx_delivery_logs_schedule_id ON delivery_logs(schedule_id);
CREATE INDEX idx_delivery_logs_sent_at ON delivery_logs(sent_at);
CREATE INDEX idx_delivery_logs_status ON delivery_logs(status);

-- 4. SCREENSHOT SESSIONS (Interactive Flow)
-- State machine untuk multi-turn screenshot collection
CREATE TABLE IF NOT EXISTS screenshot_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL, -- employee_code atau group_id
  state TEXT DEFAULT 'AWAITING_URL' CHECK (state IN (
    'AWAITING_URL',
    'AWAITING_SHEET', 
    'AWAITING_RANGE',
    'AWAITING_WEBHOOK',
    'AWAITING_GROUP',
    'COMPLETE',
    'CANCELLED'
  )),
  context JSONB DEFAULT '{}', -- { sheetId, sheetName, range, webhookUrl, groupId }
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT now() + INTERVAL '30 minutes',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_screenshot_sessions_user_id ON screenshot_sessions(user_id);
CREATE INDEX idx_screenshot_sessions_expires_at ON screenshot_sessions(expires_at);

-- 5. ROW LEVEL SECURITY (RLS)
-- Enable RLS untuk semua tables
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE screenshot_sessions ENABLE ROW LEVEL SECURITY;

-- Policies untuk service_role (backend only, no public access)
CREATE POLICY "Service role full access tenants" ON tenants FOR ALL TO service_role USING (true);
CREATE POLICY "Service role full access schedules" ON schedules FOR ALL TO service_role USING (true);
CREATE POLICY "Service role full access delivery_logs" ON delivery_logs FOR ALL TO service_role USING (true);
CREATE POLICY "Service role full access screenshot_sessions" ON screenshot_sessions FOR ALL TO service_role USING (true);

-- 6. FUNCTIONS & TRIGGERS
-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_tenants_updated_at BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER update_schedules_updated_at BEFORE UPDATE ON schedules FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER update_screenshot_sessions_updated_at BEFORE UPDATE ON screenshot_sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 7. HELPER FUNCTIONS
-- Get active schedules untuk cron job
CREATE OR REPLACE FUNCTION get_active_schedules()
RETURNS TABLE (
  id UUID,
  tenant_id UUID,
  name TEXT,
  cron_minute INT[],
  cron_hour INT[],
  cron_dow INT[],
  sheet_id TEXT,
  sheet_name TEXT,
  range TEXT,
  webhook_url TEXT,
  target_id TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    s.id, s.tenant_id, s.name, s.cron_minute, s.cron_hour, s.cron_dow,
    s.sheet_id, s.sheet_name, s.range, s.webhook_url,
    t.app_id as target_id -- fallback untuk webhook
  FROM schedules s
  JOIN tenants t ON t.id = s.tenant_id
  WHERE s.is_active = true
    AND t.is_active = true;
END;
$$ LANGUAGE plpgsql STABLE;

-- 8. SAMPLE DATA (Optional - untuk testing)
-- INSERT INTO tenants (app_id, app_secret, owner_email, webhook_url)
-- VALUES (
--   'test_app_id',
--   'test_app_secret',
--   'bawanappratama@gmail.com',
--   'https://openapi.seatalk.io/webhook/group/lxtWMFmyRdC5Ggp-qA4Aww'
-- );

-- INSERT INTO schedules (tenant_id, name, cron_hour, cron_minute, sheet_id, webhook_url)
-- SELECT 
--   id, 
--   'Test Schedule', 
--   '{9}', 
--   '{0}', 
--   'your_sheet_id',
--   'https://openapi.seatalk.io/webhook/group/lxtWMFmyRdC5Ggp-qA4Aww'
-- FROM tenants WHERE app_id = 'test_app_id' LIMIT 1;

COMMENT ON TABLE tenants IS 'System accounts / SeaTalk Custom Apps';
COMMENT ON TABLE schedules IS 'Automated screenshot jobs (cron)';
COMMENT ON TABLE delivery_logs IS 'Audit trail untuk setiap pengiriman screenshot';
COMMENT ON TABLE screenshot_sessions IS 'Interactive multi-turn screenshot state machine';