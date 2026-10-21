-- Least-privilege Supabase role for the weekly KB sync (KVM2 /root/kb-v2). Applied 2026-10-21.
-- SELECT on five columns of the 17 <vertical>_kb tables, recurated rows only (RLS), nothing else.
-- The password is never in this file: :'verifier' is a SCRAM-SHA-256 verifier computed on KVM2 from a random
-- 64-hex-char password that lives only in /root/.kb_sync_pg (connection URI, mode 600).
-- Rotate: generate a new password + verifier on KVM2, then ALTER ROLE kb_sync_reader PASSWORD '<verifier>'.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kb_sync_reader') THEN
    CREATE ROLE kb_sync_reader LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3;
  END IF;
END $$;
ALTER ROLE kb_sync_reader PASSWORD :'verifier';
ALTER ROLE kb_sync_reader SET statement_timeout = '60s';
ALTER ROLE kb_sync_reader SET default_transaction_read_only = on;
GRANT USAGE ON SCHEMA public TO kb_sync_reader;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ads','business_strategy','community','content','creator','design','developer','ecom',
    'entrepreneurship','finance','hr','leadership_management','legal','local','marketing_fundamentals','pr','sales']
  LOOP
    EXECUTE format('GRANT SELECT (id, title, summary, source_url, audit_status) ON public.%I TO kb_sync_reader', t || '_kb');
    EXECUTE format('DROP POLICY IF EXISTS kb_sync_reader_read ON public.%I', t || '_kb');
    EXECUTE format('CREATE POLICY kb_sync_reader_read ON public.%I FOR SELECT TO kb_sync_reader USING (audit_status = %L)', t || '_kb', 'recurated');
  END LOOP;
END $$;
-- Other permissive SELECT policies on these tables (e.g. kb_read_all) are OR'ed with ours, so a RESTRICTIVE policy
-- is what actually limits this role to recurated rows.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ads','business_strategy','community','content','creator','design','developer','ecom',
    'entrepreneurship','finance','hr','leadership_management','legal','local','marketing_fundamentals','pr','sales']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS kb_sync_reader_recurated_only ON public.%I', t || '_kb');
    EXECUTE format('CREATE POLICY kb_sync_reader_recurated_only ON public.%I AS RESTRICTIVE FOR SELECT TO kb_sync_reader USING (audit_status = %L)', t || '_kb', 'recurated');
  END LOOP;
END $$;
