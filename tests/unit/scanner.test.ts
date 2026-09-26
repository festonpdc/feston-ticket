import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createFrameGuard, parseFestOnQr, resultCopy } from '../../apps/web/app/scanner/scanner-core';

const scanner=readFileSync('apps/web/app/scanner/scanner.tsx','utf8');
const page=readFileSync('apps/web/app/scanner/page.tsx','utf8');
const ticketPage=readFileSync('apps/web/app/t/[token]/page.tsx','utf8');
const origin='https://tickets.gruposantino.com.mx';
const token='fst1_'+'A'.repeat(43);

describe('mobile door scanner',()=>{
  it('accepts only official ticket URLs and extracts only the opaque token',()=>{
    expect(parseFestOnQr(`${origin}/t/${token}`,origin)).toBe(token);
    expect(parseFestOnQr(`https://attacker.example/t/${token}`,origin)).toBeNull();
    expect(parseFestOnQr(`${origin}/entradas/${token}`,origin)).toBeNull();
    expect(parseFestOnQr(`${origin}/t/${token}/extra`,origin)).toBeNull();
  });
  it('allows one active request for duplicate camera frames',async()=>{
    let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve});const handler=vi.fn(()=>pending);const guard=createFrameGuard(handler);
    const first=guard('payload');const duplicate=await guard('payload');expect(duplicate).toBe(false);expect(handler).toHaveBeenCalledTimes(1);release();expect(await first).toBe(true);
  });
  it('has clear non-color-only result copy for every domain outcome',()=>{
    expect(resultCopy('accepted')).toContain('ACCESO REGISTRADO');
    expect(resultCopy('already_checked_in')).toContain('ENTRADA YA UTILIZADA');
    expect(resultCopy('invalid')).toContain('ENTRADA NO VÁLIDA');
    expect(resultCopy('wrong_event')).toContain('ENTRADA DE OTRO EVENTO');
    expect(resultCopy('network')).toContain('NO SE REGISTRÓ EL ACCESO');
  });
  it('uses a rear-camera constraint, one decoder, and releases tracks on cleanup',()=>{
    expect(scanner).toContain("facingMode:{ideal:'environment'}");
    expect(scanner).toContain('new BrowserQRCodeReader');
    expect(scanner).toContain('controls.current?.stop()');
    expect(scanner).toContain("camera==='requesting'");
    expect(scanner).toContain('PERMISO DENEGADO');
  });
  it('calls the authenticated RPC once, increments only accepted, and never persists tokens',()=>{
    expect(scanner).toContain("supabase.rpc('check_in_ticket'");
    expect(scanner).toContain("if(data.result==='accepted'){setCount");
    expect(scanner).not.toMatch(/localStorage|sessionStorage|console\./);
    expect(scanner).not.toMatch(/service_role|SUPABASE_SERVICE_ROLE/);
  });
  it('stops on expired authorization and never paints network failures as accepted',()=>{
    expect(scanner).toContain("data.result==='unauthorized'");
    expect(scanner).toContain("finish({result:'network'}");
    expect(resultCopy('unauthorized')).toContain('SESIÓN VENCIDA');
  });
  it('requires a real user and an authorized organization membership',()=>{
    expect(page).toContain('client.auth.getUser()');
    expect(page).toContain("['owner','manager','door']");
    expect(page).toContain('ACCESO NO AUTORIZADO');
  });
  it('keeps bearer ticket GET read-only',()=>{expect(ticketPage).not.toMatch(/check_in_ticket|from\('check_ins'\)|db\.from\([^)]*\)\.(insert|update)/)});
});
