
CREATE TABLE IF NOT EXISTS public.sweetspot_call_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_msisdn text,
  asterisk_channel_id text,
  customer_name text,
  status text NOT NULL DEFAULT 'active',
  cart jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_ai_line text,
  last_caller_transcript text,
  current_intent text,
  language text DEFAULT 'en',
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sweetspot_call_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.sweetspot_call_sessions(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  text text,
  payload jsonb
);

CREATE TABLE IF NOT EXISTS public.sweetspot_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES public.sweetspot_call_sessions(id) ON DELETE SET NULL,
  caller_msisdn text,
  customer_name text,
  receipt_no text,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_pence integer NOT NULL DEFAULT 0,
  whatsapp_sent_at timestamptz,
  dispatched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ss_sessions_started ON public.sweetspot_call_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ss_sessions_status  ON public.sweetspot_call_sessions(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ss_events_session   ON public.sweetspot_call_events(session_id, at);
CREATE INDEX IF NOT EXISTS idx_ss_orders_created   ON public.sweetspot_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ss_orders_receipt   ON public.sweetspot_orders(receipt_no);

CREATE OR REPLACE FUNCTION public.sweetspot_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS sweetspot_sessions_touch ON public.sweetspot_call_sessions;
CREATE TRIGGER sweetspot_sessions_touch BEFORE UPDATE ON public.sweetspot_call_sessions
FOR EACH ROW EXECUTE FUNCTION public.sweetspot_touch_updated_at();

ALTER TABLE public.sweetspot_call_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sweetspot_call_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sweetspot_orders        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ss_sessions_read_auth" ON public.sweetspot_call_sessions;
CREATE POLICY "ss_sessions_read_auth" ON public.sweetspot_call_sessions
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "ss_events_read_auth" ON public.sweetspot_call_events;
CREATE POLICY "ss_events_read_auth" ON public.sweetspot_call_events
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "ss_orders_read_auth" ON public.sweetspot_orders;
CREATE POLICY "ss_orders_read_auth" ON public.sweetspot_orders
  FOR SELECT TO authenticated USING (true);

ALTER TABLE public.sweetspot_call_sessions REPLICA IDENTITY FULL;
ALTER TABLE public.sweetspot_call_events REPLICA IDENTITY FULL;
ALTER TABLE public.sweetspot_orders REPLICA IDENTITY FULL;

DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sweetspot_call_sessions;
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sweetspot_call_events;
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sweetspot_orders;
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;
