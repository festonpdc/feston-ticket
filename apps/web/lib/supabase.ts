import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@programita/database/server';
export async function supabaseServer() {
  const store = await cookies();
  return createServerClient({
    getAll: () => store.getAll(),
    setAll: (values) => {
      // Cookie writes are supported in Route Handlers / Server Actions only.
      for (const { name, value, options } of values) store.set(name, value, options);
    },
  });
}
