'use client';
import { useState } from 'react';
import { createBrowserClient } from '@programita/database/browser';

export function ScannerLogin(){
  const[email,setEmail]=useState(''),[password,setPassword]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const submit=async(event:React.FormEvent)=>{event.preventDefault();setBusy(true);setError('');const {error:failure}=await createBrowserClient().auth.signInWithPassword({email,password});if(failure){setError('NO PUDIMOS INICIAR SESIÓN');setBusy(false);return}location.reload()};
  return <main className="scanner-shell scanner-centered"><form className="scanner-panel scanner-login" onSubmit={submit}><p className="scanner-kicker">FEST-ON · PUERTA</p><h1>INGRESO<br/>DE STAFF</h1><label>Email<input type="email" required autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)}/></label><label>Contraseña<input type="password" required autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)}/></label>{error&&<p role="alert">{error}</p>}<button disabled={busy}>{busy?'INGRESANDO...':'INGRESAR'}</button></form></main>
}
