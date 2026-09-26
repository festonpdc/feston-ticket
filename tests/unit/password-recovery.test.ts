import { readFileSync } from 'node:fs';
import { describe,expect,it } from 'vitest';
import { hasRecoveryIntent,resolveRecoverySession,validateNewPassword } from '../../apps/web/app/auth/reset-password/recovery-core';

const component=readFileSync('apps/web/app/auth/reset-password/reset-password.tsx','utf8');
const core=readFileSync('apps/web/app/auth/reset-password/recovery-core.ts','utf8');
const redirect=readFileSync('apps/web/app/auth/auth-recovery-redirect.tsx','utf8');
const scanner=readFileSync('apps/web/app/scanner/scanner-login.tsx','utf8');
const root=readFileSync('apps/web/app/page.tsx','utf8');
const checkout=readFileSync('apps/web/app/fiesta-de-disfraces/tickets.tsx','utf8');
const rls=readFileSync('supabase/migrations/202609230003_rls.sql','utf8');

describe('Supabase password recovery',()=>{
  it('recognizes official token-hash and implicit recovery intents only',()=>{
    expect(hasRecoveryIntent('?token_hash=opaque&type=recovery','')).toBe(true);
    expect(hasRecoveryIntent('','#access_token=secret&refresh_token=secret&type=recovery')).toBe(true);
    expect(hasRecoveryIntent('','')).toBe(false);
    expect(hasRecoveryIntent('?token_hash=opaque&type=signup','')).toBe(false);
  });
  it('rejects mismatched and weak passwords',()=>{
    expect(validateNewPassword('long-enough-password','different-password')).toMatch(/no coinciden/i);
    expect(validateNewPassword('short','short')).toMatch(/10/);
    expect(validateNewPassword('long-enough-password','long-enough-password')).toBeNull();
  });
  it('consumes the exact implicit recovery hash through the official session API and cleans it first',async()=>{
    const order:string[]=[];
    const auth={setSession:async(tokens:{access_token:string;refresh_token:string})=>{expect(order).toEqual(['clean']);order.push('set');expect(tokens).toEqual({access_token:'access',refresh_token:'refresh'});return{data:{session:{}},error:null}},verifyOtp:async()=>({data:{session:null},error:new Error('unused')})};
    const pending=resolveRecoverySession(auth,'','#access_token=access&expires_in=3600&refresh_token=refresh&token_type=bearer&type=recovery',()=>order.push('clean'));
    expect(await pending).toBe(true);expect(order).toEqual(['clean','set']);
  });
  it('keeps token-hash recovery independent and rejects failed implicit sessions',async()=>{
    const verifyOtp=async(input:{token_hash:string;type:'recovery'})=>{expect(input).toEqual({token_hash:'opaque',type:'recovery'});return{data:{session:{}},error:null}};
    expect(await resolveRecoverySession({verifyOtp,setSession:async()=>({data:{session:null},error:new Error('unused')})},'?token_hash=opaque&type=recovery','',()=>{})).toBe(true);
    expect(await resolveRecoverySession({verifyOtp,setSession:async()=>({data:{session:null},error:new Error('expired')})},'','#access_token=expired&refresh_token=expired&type=recovery',()=>{})).toBe(false);
  });
  it('verifies a recovery session before updating only its current user',()=>{
    expect(component).toContain('resolveRecoverySession(supabase.auth');
    expect(component).toContain("supabase.auth.updateUser({password})");
    expect(component).toContain("state!=='ready'");
  });
  it('fails safely for absent, invalid, or expired recovery and never logs or persists tokens',()=>{
    expect(component).toContain("setState(valid?'ready':'invalid')");
    expect(component+core+redirect).not.toMatch(/console\.|localStorage|sessionStorage/);
    expect(core).toContain('auth.setSession({access_token:accessToken,refresh_token:refreshToken})');
  });
  it('keeps owner membership DB-authoritative and scanner password login intact',()=>{
    expect(rls).toContain('members_owner_insert');
    expect(scanner).toContain('signInWithPassword');
    expect(component).toContain('IR AL SCANNER');
  });
  it('does not alter public checkout or the root event redirect',()=>{
    expect(root).toContain("redirect('/fiesta-de-disfraces')");
    expect(checkout).toContain("fetch('/api/reserve'");
  });
});
