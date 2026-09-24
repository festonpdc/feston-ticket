import 'server-only';
import { createServerClient as createSSRClient, type CookieMethodsServer } from '@supabase/ssr';
import type { Database } from './database.types';
export function createServerClient(cookies: CookieMethodsServer) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('Supabase public environment is not configured');
  return createSSRClient<Database>(url, key, { cookies });
}
