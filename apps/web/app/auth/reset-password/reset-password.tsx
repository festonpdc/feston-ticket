'use client';
import { useEffect, useMemo, useState } from 'react';
import { createBrowserClient } from '@programita/database/browser';
import { hasRecoveryIntent, resolveRecoverySession, validateNewPassword } from './recovery-core';

type State='verifying'|'ready'|'saving'|'success'|'invalid';

export function ResetPassword(){
  const supabase=useMemo(()=>createBrowserClient(),[]);
  const[state,setState]=useState<State>('verifying'),[password,setPassword]=useState(''),[confirmation,setConfirmation]=useState(''),[message,setMessage]=useState('');

  useEffect(()=>{
    let active=true;
    const search=location.search,hash=location.hash;
    if(!hasRecoveryIntent(search,hash)){queueMicrotask(()=>{if(active)setState('invalid')});return()=>{active=false}}
    const verify=async()=>{
      const valid=await resolveRecoverySession(supabase.auth,search,hash,()=>history.replaceState({},'',location.pathname));
      if(!active)return;
      setState(valid?'ready':'invalid');
    };
    void verify();
    return()=>{active=false};
  },[supabase]);

  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();
    if(state!=='ready')return;
    const invalid=validateNewPassword(password,confirmation);
    if(invalid){setMessage(invalid);return}
    setState('saving');setMessage('');
    const {error}=await supabase.auth.updateUser({password});
    if(error){setState('ready');setMessage('No pudimos actualizar la contraseña. Solicitá un enlace nuevo.');return}
    setPassword('');setConfirmation('');setState('success');
  };

  if(state==='success')return <main className="auth-recovery"><section className="auth-recovery-panel"><p className="scanner-kicker">FEST-ON · ACCESO</p><h1>CONTRASEÑA<br/><span>ACTUALIZADA</span></h1><p>Ya podés ingresar al control de puerta.</p><a className="auth-recovery-cta" href="/scanner">IR AL SCANNER</a></section></main>;
  if(state==='invalid')return <main className="auth-recovery"><section className="auth-recovery-panel"><p className="scanner-kicker">FEST-ON · ACCESO</p><h1>ENLACE<br/><span>NO VÁLIDO</span></h1><p>El enlace venció, fue utilizado o no corresponde a una recuperación válida.</p><p>Solicitá un nuevo email de recuperación.</p></section></main>;
  return <main className="auth-recovery"><form className="auth-recovery-panel" onSubmit={submit}><p className="scanner-kicker">FEST-ON · ACCESO</p><h1>NUEVA<br/><span>CONTRASEÑA</span></h1>{state==='verifying'?<p>VALIDANDO ENLACE...</p>:<><label>Nueva contraseña<input type="password" autoComplete="new-password" minLength={10} required value={password} onChange={e=>setPassword(e.target.value)}/></label><label>Confirmar contraseña<input type="password" autoComplete="new-password" minLength={10} required value={confirmation} onChange={e=>setConfirmation(e.target.value)}/></label>{message&&<p className="auth-recovery-error" role="alert">{message}</p>}<button className="auth-recovery-cta" disabled={state==='saving'}>{state==='saving'?'GUARDANDO...':'GUARDAR CONTRASEÑA'}</button></>}</form></main>;
}
