// Browser-side Supabase client. The site is static, so the anon key ships to the
// client by design; the real security is the row-level policies in the database
// (see supabase/migration.sql).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const URL = import.meta.env.PUBLIC_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string | undefined;

/** True when both keys were present at build time. */
export const supabaseConfigured = Boolean(URL && KEY);

let client: SupabaseClient | null = null;

/** The shared client. Throws if the keys are missing, so guard with `supabaseConfigured`. */
export function getSupabase(): SupabaseClient {
  if (!supabaseConfigured) {
    throw new Error(
      'Supabase is not configured. Set PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_ANON_KEY (see .env.example).',
    );
  }
  if (!client) {
    client = createClient(URL!, KEY!, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }
  return client;
}
