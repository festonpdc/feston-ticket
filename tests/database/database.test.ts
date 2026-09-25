import { PGlite } from '@electric-sql/pglite';
import { Client } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertIsolatedDestructiveTarget } from './remote-guard';

type DB = { exec(sql: string): Promise<unknown>; query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
const id = (prefix: number, n = 1) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tables = ['organizations','organization_members','locations','events','ticket_types','customers','orders','order_items','payments','tickets','check_ins','audit_logs'];

function suite(label: string, remote: boolean) {
  describe(label, () => {
    let db: DB;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (remote) {
        assertIsolatedDestructiveTarget();
        const url = new URL(process.env.TEST_DATABASE_URL!);
        const client = new Client({ connectionString: url.toString() });
        await client.connect();
        db = { exec: sql => client.query(sql), query: (sql, params) => client.query(sql, params) };
        close = () => client.end();
      } else {
        const embedded = new PGlite();
        db = embedded;
        close = () => embedded.close();
        await db.exec(await readFile('tests/database/bootstrap.sql', 'utf8'));
        for (const file of (await readdir('supabase/migrations')).filter(f => f.endsWith('.sql')).sort()) {
          await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'));
        }
      }
    });
    afterAll(async () => { if (close) await close(); });
    beforeEach(async () => {
      await db.exec('begin');
      await db.exec(await readFile('tests/database/fixtures.sql', 'utf8'));
    });
    afterEach(async () => { await db.exec('rollback'); });
    async function actor(n: number, role: 'authenticated' | 'anon' = 'authenticated') {
      await db.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)",
        [n ? id(0,n) : '', JSON.stringify(n ? { sub: id(0,n), role } : { role })]);
      await db.exec(`set local role ${role}`);
    }
    async function rejected(sql: string, code = '23514') {
      await db.exec('savepoint expected_failure');
      try { await expect(db.exec(sql)).rejects.toMatchObject({ code }); }
      finally { await db.exec('rollback to savepoint expected_failure'); }
    }
    async function paymentId() {
      const { rows } = await db.query(`select id from public.payments where organization_id='${id(1)}' and order_id='${id(6)}'`);
      expect(rows).toHaveLength(1);
      return rows[0]!.id as string;
    }
    async function reconciliationFixture() {
      const order='92000000-0000-4000-8000-000000000001';
      const item='93000000-0000-4000-8000-000000000001';
      const payment='94000000-0000-4000-8000-000000000001';
      await db.exec(`set constraints all deferred;
        insert into public.orders(id,organization_id,event_id,customer_id,public_code,currency,subtotal,total,reserved_until)
        values ('${order}','${id(1)}','${id(3)}','${id(5)}','ORD_92000000000000000000000000000001','USD',0,0,now()+interval '15 minutes');
        insert into public.order_items(id,organization_id,order_id,event_id,ticket_type_id,currency,quantity,unit_price,subtotal)
        values ('${item}','${id(1)}','${order}','${id(3)}','${id(4)}','USD',1,1500,1500);
        update public.orders set subtotal=1500,total=1500,status='pending_payment' where id='${order}';
        insert into public.payments(id,organization_id,order_id,provider,method,status,amount,currency)
        values ('${payment}','${id(1)}','${order}','stripe','card','pending',1500,'USD');
        set constraints all immediate`);
      const reconcile=async(overrides:Record<string,string>={})=>{
        const values={payment,organization:id(1),order,provider:'pi_reconcile_1',amount:'1500',currency:'USD',...overrides};
        return (await db.query(`select public.reconcile_stripe_payment_provider_id(
          $1,$2,$3,$4,$5,$6
        ) as value`,[values.payment,values.organization,values.order,values.provider,values.amount,values.currency])).rows[0]!.value as {status:string;reason?:string};
      };
      return {order,payment,reconcile};
    }
    it('enables and forces RLS on all 14 private tables', async () => {
      const { rows } = await db.query("select relname,relrowsecurity,relforcerowsecurity from pg_class join pg_namespace n on n.oid=relnamespace where n.nspname='public' and relkind='r'");
      expect(rows).toHaveLength(14);
      expect(rows.every(r => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
    });
    it('owner A can read own operational records and never B', async () => {
      await actor(1);
      for (const table of tables) {
        const column = table === 'organizations' ? 'id' : 'organization_id';
        const { rows } = await db.query(`select ${column} as tenant from public.${table}`);
        expect(rows.every(r => r.tenant === id(1))).toBe(true);
        if (table !== 'check_ins') expect(rows.length).toBeGreaterThan(0);
      }
    });
    it('manager A cannot update, insert or delete B', async () => {
      await actor(2);
      expect((await db.query(`update public.events set name='Blocked' where organization_id='${id(1,2)}' returning id`)).rows).toHaveLength(0);
      expect((await db.query(`delete from public.customers where organization_id='${id(1,2)}' returning id`)).rows).toHaveLength(0);
      await rejected(`insert into public.customers(organization_id,full_name,email) values ('${id(1,2)}','Blocked','blocked@example.invalid')`, '42501');
      expect((await db.query(`update public.events set name='Allowed' where organization_id='${id(1)}' returning id`)).rows).toHaveLength(1);
    });
    it('rejects tenant reassignment even when actor owns both organizations', async () => {
      await db.exec(`insert into public.organization_members values ('${id(1,2)}','${id(0)}','owner',now(),now())`);
      await actor(1);
      await rejected(`update public.events set organization_id='${id(1,2)}' where id='${id(3)}'`);
    });
    it('door has no finance, PII, token or operational access', async () => {
      await actor(3);
      for (const table of tables.filter(t => !['organizations','organization_members'].includes(t))) {
        expect((await db.query(`select * from public.${table}`)).rows).toHaveLength(0);
      }
      await rejected(`update public.payments set status='refunded'`, '42501');
    });
    it('anonymous cannot select any private table', async () => {
      await actor(0,'anon');
      for (const table of [...tables,'profiles']) await rejected(`select * from public.${table}`, '42501');
    });
    it('authenticated non-member sees no organization data', async () => {
      await actor(5);
      for (const table of tables) expect((await db.query(`select * from public.${table}`)).rows).toHaveLength(0);
    });
    it('manager cannot escalate role, change organization settings or forge payment/audit', async () => {
      await actor(2);
      expect((await db.query(`update public.organization_members set role='owner' where user_id='${id(0,2)}' returning user_id`)).rows).toHaveLength(0);
      expect((await db.query(`update public.organizations set name='Blocked' returning id`)).rows).toHaveLength(0);
      await rejected(`update public.orders set status='refunded'`, '42501');
      await rejected(`insert into public.audit_logs(organization_id,event_type,entity_type,entity_id) values ('${id(1)}','refund','order','${id(6)}')`, '42501');
    });
    it('owner can manage membership but cannot remove last owner', async () => {
      await actor(1);
      expect((await db.query(`update public.organization_members set role='door' where user_id='${id(0,2)}' returning user_id`)).rows).toHaveLength(1);
      await rejected(`delete from public.organization_members where user_id='${id(0)}'`);
    });
    it('profiles are self-only and auth insertion creates them', async () => {
      await actor(2);
      expect((await db.query('select id from public.profiles')).rows).toEqual([{ id: id(0,2) }]);
      expect((await db.query(`update public.profiles set full_name='Self' where id='${id(0,2)}' returning id`)).rows).toHaveLength(1);
    });
    it('rejects zero/negative quantities, negative price and invalid enums', async () => {
      await rejected(`update public.ticket_types set price=-1`);
      // Separate draft order permits testing quantity constraint rather than snapshot guard.
      await db.exec(`insert into public.orders(id,organization_id,event_id,customer_id,public_code,currency) values ('${id(6,3)}','${id(1)}','${id(3)}','${id(5)}','ORD_${'3'.repeat(32)}','USD')`);
      for (const q of [0,-1]) await rejected(`insert into public.order_items(organization_id,order_id,event_id,ticket_type_id,currency,quantity,unit_price,subtotal) values ('${id(1)}','${id(6,3)}','${id(3)}','${id(4)}','USD',${q},0,0)`);
      await rejected(`update public.events set status='invalid'`, '22P02');
    });
    it('rejects cross-organization and cross-event references', async () => {
      await rejected(`update public.events set location_id='${id(2,2)}' where id='${id(3)}'`, '23503');
      await rejected(`insert into public.orders(organization_id,event_id,customer_id,public_code,currency) values ('${id(1)}','${id(3)}','${id(5,2)}','ORD_${'9'.repeat(32)}','USD')`, '23503');
      await rejected(`update public.tickets set event_id='${id(3,2)}' where id='${id(8)}'`, '23503');
      await db.exec(`insert into public.events(id,organization_id,location_id,name,slug,starts_at,ends_at,timezone) values ('${id(3,3)}','${id(1)}','${id(2)}','Other','other','2026-10-31','2026-11-01','UTC')`);
      await rejected(`update public.tickets set event_id='${id(3,3)}' where id='${id(8)}'`, '23503');
    });
    it('freezes purchased prices and does not depend on current catalog price', async () => {
      await db.exec(`update public.ticket_types set price=9000 where id='${id(4)}'`);
      expect((await db.query('select unit_price::text from public.order_items')).rows.every(r => r.unit_price === '1500')).toBe(true);
      await rejected(`update public.order_items set unit_price=9000,subtotal=9000 where id='${id(7)}'`);
      await rejected(`update public.orders set subtotal=9000,total=9000 where id='${id(6)}'`);
      await rejected(`update public.payments set amount=9000 where id='${await paymentId()}'`);
    });
    it('enforces totals, currency, capacity, slugs, timezones and chronology', async () => {
      await rejected(`update public.ticket_types set capacity=-1 where id='${id(4)}'`);
      await rejected(`update public.ticket_types set currency='usd' where id='${id(4)}'`);
      await rejected(`update public.events set slug='Invalid Slug' where id='${id(3)}'`);
      await rejected(`update public.events set timezone='Not/AZone' where id='${id(3)}'`);
      await rejected(`update public.events set ends_at=starts_at where id='${id(3)}'`);
      await rejected(`insert into public.orders(organization_id,event_id,customer_id,public_code,currency,subtotal,total) values ('${id(1)}','${id(3)}','${id(5)}','ORD_${'a'.repeat(32)}','USD',99,99)`);
      await rejected(`update public.orders set status='draft' where id='${id(6)}'`);
    });
    it('payment status supports canonical paid while retaining legacy approved', async () => {
      const { rows } = await db.query("select enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='payment_status' order by enumsortorder");
      expect(rows.map(r => r.enumlabel)).toEqual(expect.arrayContaining(['approved', 'paid']));
    });
    it('exposes a minimal service-only Stripe RPC bridge to the private core', async () => {
      const { rows } = await db.query("select p.prosecdef,p.proconfig,p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='apply_stripe_payment_event'");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.prosecdef).toBe(true);
      expect(rows[0]!.proconfig).toEqual(['search_path=pg_catalog']);
      expect(String(rows[0]!.prosrc)).toContain('private.apply_stripe_payment_event');
      expect(String(rows[0]!.prosrc)).not.toContain('update ');
      const result = await db.query("select public.apply_stripe_payment_event('evt_missing','pi_missing','payment_intent.succeeded',100,'MXN','card',now()) as value");
      expect(result.rows[0]!.value).toEqual({ status: 'rejected', reason: 'payment_not_found' });
    });
    it('reconciles a missing Stripe provider ID once and remains idempotent',async()=>{
      const f=await reconciliationFixture();
      expect(await f.reconcile()).toMatchObject({status:'applied'});
      expect(await f.reconcile()).toMatchObject({status:'already_applied'});
      expect(await f.reconcile({provider:'pi_reconcile_other'})).toMatchObject({status:'rejected',reason:'provider_payment_id_immutable'});
      await rejected(`update public.payments set provider_payment_id='pi_direct_change' where id='${f.payment}'`);
    });
    it.each([
      ['amount mismatch',{amount:'1501'},'amount_or_currency_mismatch'],
      ['currency mismatch',{currency:'MXN'},'amount_or_currency_mismatch'],
      ['organization mismatch',{organization:'10000000-0000-4000-8000-000000000002'},'organization_or_order_mismatch'],
      ['order mismatch',{order:'60000000-0000-4000-8000-000000000002'},'organization_or_order_mismatch'],
    ])('rejects Stripe reconciliation %s',async(_label,overrides,reason)=>{
      const f=await reconciliationFixture();
      expect(await f.reconcile(overrides)).toMatchObject({status:'rejected',reason});
    });
    it.each([
      ['consumed event',`update public.payments set provider_event_id='evt_consumed' where id='94000000-0000-4000-8000-000000000001'`,'event_already_consumed'],
      ['non-pending payment',`update public.payments set status='failed' where id='94000000-0000-4000-8000-000000000001'`,'payment_state'],
      ['non-pending order',`update public.orders set status='expired' where id='92000000-0000-4000-8000-000000000001'`,'order_state'],
    ])('rejects reconciliation for %s',async(_label,mutation,reason)=>{
      const f=await reconciliationFixture();
      await db.exec(mutation);
      expect(await f.reconcile()).toMatchObject({status:'rejected',reason});
    });
    it('rejects a provider ID already used by another payment',async()=>{
      const f=await reconciliationFixture();
      await db.exec(`insert into public.payments(organization_id,order_id,provider,provider_payment_id,method,status,amount,currency)
        values ('${id(1)}','${id(6)}','stripe','pi_reconcile_1','card','pending',1500,'USD')`);
      expect(await f.reconcile()).toMatchObject({status:'rejected',reason:'provider_payment_id_in_use'});
    });
    it('rejects ambiguous Stripe payments for an order',async()=>{
      const f=await reconciliationFixture();
      await db.exec(`insert into public.payments(organization_id,order_id,provider,method,status,amount,currency)
        values ('${id(1)}','${f.order}','stripe','card','pending',1500,'USD')`);
      expect(await f.reconcile()).toMatchObject({status:'rejected',reason:'ambiguous_payment'});
    });
    it('keeps reconciliation service-only with a fixed search path',async()=>{
      const {rows}=await db.query(`select p.prosecdef,p.proconfig,
        has_function_privilege('anon',p.oid,'execute') anon,
        has_function_privilege('authenticated',p.oid,'execute') authenticated,
        has_function_privilege('service_role',p.oid,'execute') service
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='reconcile_stripe_payment_provider_id'`);
      expect(rows[0]).toMatchObject({prosecdef:true,anon:false,authenticated:false,service:true});
      expect(rows[0]!.proconfig).toContain('search_path=pg_catalog');
    });
    it('enforces unique public codes, token hashes and append-only audit', async () => {
      await rejected(`update public.tickets set public_code='TKT_${'1'.padStart(32,'0')}' where id='${id(8,2)}'`, '23505');
      await rejected(`update public.tickets set secure_token_hash='${'1'.padStart(64,'0')}' where id='${id(8,2)}'`, '23505');
      await rejected(`update public.audit_logs set metadata='{}' where organization_id='${id(1)}' and entity_id='${id(6)}'`);
      await rejected(`delete from public.audit_logs where organization_id='${id(1)}' and entity_id='${id(6)}'`);
      await rejected(`truncate public.audit_logs`);
    });
    it('rejects sensitive metadata keys and raw provider payloads', async () => {
      const payment = await paymentId();
      await rejected(`update public.payments set metadata='{"cvv":"123"}' where id='${payment}'`);
      await rejected(`update public.payments set metadata='{"provider_payload":{"card":"123"}}' where id='${payment}'`);
    });
    it('permits one check-in per ticket and requires an actor in the same tenant', async () => {
      await db.exec(`insert into public.check_ins(organization_id,event_id,ticket_id,checked_in_by) values ('${id(1)}','${id(3)}','${id(8)}','${id(0,3)}')`);
      await rejected(`insert into public.check_ins(organization_id,event_id,ticket_id,checked_in_by) values ('${id(1)}','${id(3)}','${id(8)}','${id(0,3)}')`, '23505');
      await rejected(`insert into public.check_ins(organization_id,event_id,ticket_id,checked_in_by) values ('${id(1,2)}','${id(3,2)}','${id(8,2)}','${id(0,3)}')`, '23503');
    });
    it('DEMO seed is repeatable, draft-only and has no credentials or payments', async () => {
      const seed = await readFile('supabase/seeds/demo.sql', 'utf8');
      await db.exec(seed);
      await db.exec(seed);
      const tenant = 'd0000000-0000-4000-8000-000000000001';
      expect((await db.query(`select status from public.events where organization_id='${tenant}'`)).rows).toEqual([{ status: 'draft' }]);
      expect((await db.query(`select * from public.ticket_types where organization_id='${tenant}'`)).rows).toHaveLength(3);
      expect((await db.query(`select * from public.payments where organization_id='${tenant}'`)).rows).toHaveLength(0);
      expect((await db.query(`select * from public.organization_members where organization_id='${tenant}'`)).rows).toHaveLength(0);
    });
    it('accepts a consistent draft transaction and rejects wrong event, currency and line totals', async () => {
      await db.exec('set constraints all deferred');
      await db.exec(`insert into public.orders(id,organization_id,event_id,customer_id,public_code,currency) values ('${id(6,3)}','${id(1)}','${id(3)}','${id(5)}','ORD_${'c'.repeat(32)}','USD')`);
      const insert = (event: string, money: string, unitPrice: number, subtotal: number) => `insert into public.order_items(organization_id,order_id,event_id,ticket_type_id,currency,quantity,unit_price,subtotal) values ('${id(1)}','${id(6,3)}','${event}','${id(4)}','${money}',2,${unitPrice},${subtotal})`;
      await rejected(insert(id(3),'USD',-1,0));
      await rejected(insert(id(3),'USD',1500,2999));
      await rejected(insert(id(3),'EUR',1500,3000), '23503');
      await db.exec(`insert into public.events(id,organization_id,location_id,name,slug,starts_at,ends_at,timezone) values ('${id(3,3)}','${id(1)}','${id(2)}','Other','other','2026-10-31','2026-11-01','UTC')`);
      await rejected(insert(id(3,3),'USD',1500,3000), '23503');
      await db.exec(insert(id(3),'USD',1500,3000));
      await db.exec(`update public.orders set subtotal=3000,total=3000 where id='${id(6,3)}'`);
      await db.exec('set constraints all immediate');
      expect((await db.query(`select total::text from public.orders where id='${id(6,3)}'`)).rows).toEqual([{ total: '3000' }]);
    });
  });
}
suite('PostgreSQL embedded: migrations, constraints and real RLS', false);
if (process.env.TEST_DATABASE_URL) suite('Supabase local: same database contract', true);
else it.skip('Supabase local integration requires TEST_DATABASE_URL');
