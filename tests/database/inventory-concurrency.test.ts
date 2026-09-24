import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localDatabaseUrl, seedInventory, type InventoryDB } from './inventory-support';

// Opt-in: separate real PostgreSQL connections; never substitute a PGlite queue.
// The fixture uses unique IDs in the linked database and is removed by the owner
// connection after the test. It never resets, drops, or creates a remote database.
const connection = process.env.TEST_DATABASE_URL;
describe.skipIf(!connection)('Real PostgreSQL inventory concurrency (15 connections)', () => {
  let admin: Client; let db: Client; let url: string;
  const adapter = (client: Client): InventoryDB => ({ exec: sql=>client.query(sql), query:(sql,params)=>client.query(sql,params) });
  beforeAll(async () => {
    const base = localDatabaseUrl(connection!);
    admin = new Client({ connectionString:base.toString() }); await admin.connect();
    url=base.toString(); db=admin;
  });
  afterAll(async () => {
    if(admin) await admin.end();
  });

  it.each(['ticket type','shared event','multi-type reversed','same idempotency key'])('serializes 15 real backends: %s', async scope => {
    const f=await seedInventory(adapter(db), scope==='ticket type' ? 2 : 100);
    if(scope==='shared event') await db.query('update public.events set capacity=2 where id=$1',[f.event]);
    if(scope==='multi-type reversed') await db.query('update public.events set capacity=4 where id=$1',[f.event]);
    const sharedKey=randomBytes(32).toString('hex');
    const sameKey=scope==='same idempotency key';
    const expectedOrders=sameKey?1:2;
    const expectedUnits=scope==='multi-type reversed'?4:expectedOrders;
    // The pooler permits 15 sessions. The setup/observer session is also the
    // fifteenth attempt, so only 14 additional clients are opened.
    const clients=Array.from({length:14},()=>new Client({connectionString:url}));
    let work: Promise<{ ok: boolean; code?: string; orderId?: string }>[]=[];
    try {
      await Promise.all(clients.map(c=>c.connect()));
      const pids=(await Promise.all(clients.map(c=>c.query('select pg_backend_pid() as pid')))).map(r=>r.rows[0].pid as number);
      expect(new Set(pids).size).toBe(14);
      // Hold the event row until fourteen independent backends are waiting;
      // the setup session becomes the fifteenth attempt after releasing it.
      await db.query('begin');
      await db.query('select id from public.events where id=$1 for update',[f.event]);
      work=clients.map(async (client,index) => {
        try {
          await client.query('begin isolation level read committed');
          await client.query("set local statement_timeout='20s'");
          await client.query('set local role service_role');
          const items=scope==='multi-type reversed'
            ? (index%2?[f.type,f.secondType]:[f.secondType,f.type]).map(type=>({ticket_type_id:type,quantity:1}))
            : [{ticket_type_id:scope==='shared event' && index%2 ? f.secondType : f.type,quantity:1}];
          const result=await client.query('select public.reserve_tickets($1,$2,$3,$4::jsonb,$5) as receipt',[f.org,f.event,f.customer,
            JSON.stringify(items),sameKey?sharedKey:randomBytes(32).toString('hex')]);
          await client.query('commit'); return {ok:true,orderId:result.rows[0].receipt.order_id as string};
        } catch(error) {
          await client.query('rollback'); return {ok:false,code:(error as {code:string}).code};
        }
      });
      await db.query('commit');
      work.push((async()=>{
        try {
          await db.query('begin isolation level read committed');
          await db.query("set local statement_timeout='20s'");
          await db.query('set local role service_role');
          const items=scope==='multi-type reversed'
            ? [{ticket_type_id:f.type,quantity:1},{ticket_type_id:f.secondType,quantity:1}]
            : [{ticket_type_id:scope==='shared event'?f.secondType:f.type,quantity:1}];
          const result=await db.query('select public.reserve_tickets($1,$2,$3,$4::jsonb,$5) as receipt',[f.org,f.event,f.customer,JSON.stringify(items),sameKey?sharedKey:randomBytes(32).toString('hex')]);
          await db.query('commit'); return {ok:true,orderId:result.rows[0].receipt.order_id as string};
        } catch(error) { await db.query('rollback'); return {ok:false,code:(error as {code:string}).code}; }
      })());
      const results=await Promise.all(work);
      expect(results.filter(r=>r.ok)).toHaveLength(sameKey?15:2);
      expect(new Set(results.filter(r=>r.ok).map(r=>r.orderId)).size).toBe(expectedOrders);
      expect(results.filter(r=>!r.ok)).toHaveLength(sameKey?0:13);
      expect(results.filter(r=>!r.ok).every(r=>r.code==='23514')).toBe(true);
      expect(Number((await db.query('select coalesce(sum(quantity),0) as used from public.order_items where organization_id=$1',[f.org])).rows[0].used)).toBe(expectedUnits);
      expect(Number((await db.query('select count(*) from public.orders where organization_id=$1',[f.org])).rows[0].count)).toBe(expectedOrders);
      expect(Number((await db.query("select count(*) from public.audit_logs where organization_id=$1 and event_type='inventory_reserved'",[f.org])).rows[0].count)).toBe(expectedOrders);
    } finally {
      await db.query('rollback');
      await Promise.allSettled(work);
      await Promise.allSettled(clients.map(c=>c.end()));
      // Owner cleanup is deliberately best-effort and scoped to this UUID-only
      // fixture. Audit is append-only for application roles; postgres owner may
      // remove these rows after all child rows, without touching other tenants.
      await db.query('begin');
      await db.query('set local session_replication_role=replica');
      await db.query('delete from public.audit_logs where organization_id=$1',[f.org]);
      await db.query('delete from public.check_ins where organization_id=$1',[f.org]);
      await db.query('delete from public.tickets where organization_id=$1',[f.org]);
      await db.query('delete from public.payments where organization_id=$1',[f.org]);
      await db.query('delete from public.order_items where organization_id=$1',[f.org]);
      await db.query('delete from public.orders where organization_id=$1',[f.org]);
      await db.query('delete from public.customers where organization_id=$1',[f.org]);
      await db.query('delete from public.ticket_types where organization_id=$1',[f.org]);
      await db.query('delete from public.events where organization_id=$1',[f.org]);
      await db.query('delete from public.locations where organization_id=$1',[f.org]);
      await db.query('delete from public.organization_members where organization_id=$1',[f.org]);
      await db.query('delete from public.organizations where id=$1',[f.org]);
      await db.query('commit');
    }
  },30_000);
});
