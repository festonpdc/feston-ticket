import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const id=(prefix:number,n=1)=>`${prefix}0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const tokenA='fst1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const tokenB='fst1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

describe('atomic ticket check-in embedded',()=>{
  let db:PGlite;
  beforeAll(async()=>{
    db=new PGlite();
    await db.exec(await readFile('tests/database/bootstrap.sql','utf8'));
    for(const file of (await readdir('supabase/migrations')).filter(file=>file.endsWith('.sql')).sort())await db.exec(await readFile(`supabase/migrations/${file}`,'utf8'));
  });
  afterAll(async()=>db.close());
  beforeEach(async()=>{
    await db.exec('begin');
    await db.exec(await readFile('tests/database/fixtures.sql','utf8'));
    await db.query('update public.tickets set secure_token_hash=$1 where id=$2',[createHash('sha256').update(tokenA).digest('hex'),id(8)]);
    await db.query('update public.tickets set secure_token_hash=$1 where id=$2',[createHash('sha256').update(tokenB).digest('hex'),id(8,2)]);
  });
  afterEach(async()=>db.exec('rollback'));

  async function actor(n:number,role:'authenticated'|'anon'='authenticated'){
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[n?id(0,n):'',JSON.stringify(n?{sub:id(0,n),role}:{role})]);
    await db.exec(`set local role ${role}`);
  }
  async function scan(token=tokenA,event=id(3),organization=id(1)){
    return (await db.query<{value:{result:string;checked_in_at?:string}}>('select public.check_in_ticket($1,$2,$3) value',[organization,event,token])).rows[0]!.value;
  }

  it.each([1,2,3])('allows authorized role member %s',async member=>{
    await actor(member);
    expect(await scan()).toMatchObject({result:'accepted'});
  });
  it('accepts once with a server timestamp, audit, and no raw token persistence',async()=>{
    const before=Date.now();await actor(3);const result=await scan();const after=Date.now();
    expect(result).toMatchObject({result:'accepted',ticket_type_name:'General',public_code:`TKT_${'1'.padStart(32,'0')}`});
    expect(Date.parse(result.checked_in_at!)).toBeGreaterThanOrEqual(before-1000);
    expect(Date.parse(result.checked_in_at!)).toBeLessThanOrEqual(after+1000);
    await db.exec('reset role');
    expect((await db.query('select status,redeemed_at from public.tickets where id=$1',[id(8)])).rows[0]).toMatchObject({status:'redeemed'});
    expect((await db.query<{count:number}>('select count(*)::int count from public.check_ins where ticket_id=$1',[id(8)])).rows[0]!.count).toBe(1);
    expect((await db.query<{count:number}>("select count(*)::int count from public.audit_logs where entity_id in(select id from public.check_ins where ticket_id=$1)and event_type='ticket_redeemed'",[id(8)])).rows[0]!.count).toBe(1);
    const stored=JSON.stringify((await db.query("select metadata from public.check_ins where ticket_id=$1 union all select metadata from public.audit_logs where entity_type='check_in'",[id(8)])).rows);
    expect(stored).not.toContain(tokenA);
  });
  it('returns already_checked_in on retry without a second record',async()=>{
    await actor(3);expect((await scan()).result).toBe('accepted');expect(await scan()).toMatchObject({result:'already_checked_in',ticket_type_name:'General',public_code:`TKT_${'1'.padStart(32,'0')}`});
    await db.exec('reset role');expect((await db.query<{count:number}>('select count(*)::int count from public.check_ins where ticket_id=$1',[id(8)])).rows[0]!.count).toBe(1);
  });
  it('returns invalid without disclosing ticket data',async()=>{await actor(3);expect(await scan('fst1_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC')).toEqual({result:'invalid'})});
  it('rejects a valid ticket for another event without mutation',async()=>{await actor(3);expect(await scan(tokenB)).toEqual({result:'wrong_event'});await db.exec('reset role');expect((await db.query<{count:number}>('select count(*)::int count from public.check_ins')).rows[0]!.count).toBe(0)});
  it.each(['cancelled','refunded'] as const)('rejects %s tickets',async status=>{await db.query('update public.tickets set status=$1 where id=$2',[status,id(8)]);await actor(3);expect(await scan()).toEqual({result:'unavailable'})});
  it('rejects a ticket whose order is not paid',async()=>{await db.exec('set local session_replication_role=replica');await db.query("update public.orders set status='pending_payment',reserved_until=now()+interval '15 minutes' where id=$1",[id(6)]);await db.exec('set local session_replication_role=origin');await actor(3);expect(await scan()).toEqual({result:'unavailable'})});
  it('denies anon, buyer bearer context, and an unrelated authenticated user',async()=>{
    await actor(0,'anon');await db.exec('savepoint anon_denied');await expect(scan()).rejects.toMatchObject({code:'42501'});await db.exec('rollback to savepoint anon_denied');await db.exec('reset role');
    await actor(5);expect(await scan()).toEqual({result:'unauthorized'});
    await db.exec('reset role');expect((await db.query<{count:number}>('select count(*)::int count from public.check_ins')).rows[0]!.count).toBe(0);
  });
  it('keeps the public ticket GET implementation read-only',async()=>{
    const page=await readFile('apps/web/app/t/[token]/page.tsx','utf8');
    expect(page).not.toMatch(/check_in_ticket|from\('check_ins'\)|db\.from\([^)]*\)\.(insert|update)|redeemed_at\s*:/);
  });
  it('exposes only authenticated execute with a fixed search_path',async()=>{
    const row=(await db.query(`select p.prosecdef,p.proconfig,has_function_privilege('anon',p.oid,'execute')anon,has_function_privilege('authenticated',p.oid,'execute')authenticated,has_function_privilege('service_role',p.oid,'execute')service from pg_proc p where p.oid='public.check_in_ticket(uuid,uuid,text)'::regprocedure`)).rows[0]!;
    expect(row).toEqual({prosecdef:true,proconfig:['search_path=""'],anon:false,authenticated:true,service:false});
  });
});
