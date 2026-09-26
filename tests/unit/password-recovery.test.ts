import { readFileSync } from 'node:fs';
import { describe,expect,it } from 'vitest';
import { hasRecoveryIntent,validateNewPassword } from '../../apps/web/app/auth/reset-password/recovery-core';

const component=readFileSync('apps/web/app/auth/reset-password/reset-password.tsx','utf8');
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
  it('verifies a recovery session before updating only its current user',()=>{
    expect(component).toContain("verifyOtp({token_hash:tokenHash,type:'recovery'})");
    expect(component).toContain("event==='PASSWORD_RECOVERY'");
    expect(component).toContain("supabase.auth.updateUser({password})");
    expect(component).toContain("state!=='ready'");
  });
  it('fails safely for absent, invalid, or expired recovery and never logs or persists tokens',()=>{
    expect(component).toContain("setState(error?'invalid':'ready')");
    expect(component+redirect).not.toMatch(/console\.|localStorage|sessionStorage/);
    expect(component+redirect).not.toMatch(/get\(['\"]access_token|get\(['\"]refresh_token/);
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
