import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Client } from 'pg';
import { readFile, readdir } from 'node:fs/promises';

export type InventoryDB = {
  exec(sql: string): Promise<unknown>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};
export function localDatabaseUrl(value: string): URL {
  const url = new URL(value);
  if (!url.hostname || !['postgresql:','postgres:'].includes(url.protocol)) throw new Error('Invalid PostgreSQL test URL');
  return url;
}
export async function migrate(db: InventoryDB) {
  for (const file of (await readdir('supabase/migrations')).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'));
  }
}
export async function inventoryDB(url?: string) {
  if (url) {
    const client = new Client({ connectionString: localDatabaseUrl(url).toString() });
    await client.connect();
    return { db: { exec: (sql: string) => client.query(sql), query: (sql: string, params?: unknown[]) => client.query(sql, params) } as InventoryDB, close: () => client.end() };
  }
  const db = new PGlite();
  await db.exec(await readFile('tests/database/bootstrap.sql','utf8'));
  await migrate(db);
  return { db: db as InventoryDB, close: () => db.close() };
}
export type InventoryFixture = { org: string; event: string; customer: string; type: string; secondType: string };
export async function seedInventory(db: InventoryDB, capacity = 100): Promise<InventoryFixture> {
  const f = { org: randomUUID(), event: randomUUID(), customer: randomUUID(), type: randomUUID(), secondType: randomUUID() };
  const location = randomUUID();
  await db.query("insert into public.organizations(id,name,slug) values($1,'Inventory test',$2)",[f.org,`test-${f.org}`]);
  await db.query("insert into public.locations(id,organization_id,name,slug,timezone) values($1,$2,'Test','test','UTC')",[location,f.org]);
  await db.query(`insert into public.events(id,organization_id,location_id,name,slug,starts_at,ends_at,timezone,status)
    values($1,$2,$3,'Test','test',now()-interval '1 hour',now()+interval '2 days','UTC','published')`,[f.event,f.org,location]);
  await db.query("insert into public.customers(id,organization_id,full_name,email) values($1,$2,'Test','inventory@example.invalid')",[f.customer,f.org]);
  for (const [type, price] of [[f.type,1500],[f.secondType,2500]]) {
    await db.query(`insert into public.ticket_types(id,organization_id,event_id,name,price,currency,capacity,status)
      values($1,$2,$3,'Test', $4,'USD',$5,'active')`,[type,f.org,f.event,price,capacity]);
  }
  return f;
}
export async function reserve(db: InventoryDB, f: InventoryFixture, count = 1, items?: unknown, key = randomBytes(32).toString('hex')) {
  const { rows } = await db.query<{ value: { order_id: string; total: number; subtotal: number; reserved_until: string; currency: string; status: string; reservation_active: boolean } }>(
    'select public.reserve_tickets($1,$2,$3,$4::jsonb,$5) as value',
    [f.org,f.event,f.customer,JSON.stringify(items ?? [{ ticket_type_id: f.type, quantity: count }]),key]);
  return rows[0]!.value;
}
export async function availability(db: InventoryDB, f: InventoryFixture) {
  return (await db.query('select * from public.ticket_availability($1,$2)',[f.org,f.event])).rows;
}
// Historical states are fixture data, not commands. New pending reservations can
// never be confirmed after expiry; paid/refunded still count at a future instant.
export async function historicalOrder(db: InventoryDB, f: InventoryFixture, count: number, state: 'pending_payment'|'paid'|'cancelled'|'refunded', expired: boolean) {
  const order = randomUUID();
  await db.exec('set constraints all deferred');
  await db.query(`insert into public.orders(id,organization_id,event_id,customer_id,public_code,currency,created_at,subtotal,total)
    values($1,$2,$3,$4,$5,'USD',now()-interval '1 day',$6,$6)`,[order,f.org,f.event,f.customer,`ORD_${randomUUID().replaceAll('-','')}`,count*1500]);
  await db.query(`insert into public.order_items(organization_id,order_id,event_id,ticket_type_id,currency,quantity,unit_price,subtotal)
    values($1,$2,$3,$4,'USD',$5,1500,$6)`,[f.org,order,f.event,f.type,count,count*1500]);
  await db.query(`update public.orders set status='pending_payment',reserved_until=now()+$2::interval where id=$1`,[order,expired ? '-1 hour' : '1 hour']);
  if (state==='paid' || state==='refunded') await db.query("update public.orders set status='paid' where id=$1",[order]);
  if (state==='cancelled' || state==='refunded') await db.query('update public.orders set status=$2::public.order_status where id=$1',[order,state]);
  await db.exec('set constraints all immediate');
  return order;
}
