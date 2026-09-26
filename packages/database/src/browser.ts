import { createBrowserClient as createSSRBrowserClient } from '@supabase/ssr';
import type { Database } from './database.types';

export function createBrowserClient() {
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if(!url||!key)throw new Error('Supabase public environment is not configured');
  return createSSRBrowserClient<Database>(url,key);
}
