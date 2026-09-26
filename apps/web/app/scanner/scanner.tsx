'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BrowserQRCodeReader, type IScannerControls } from '@zxing/browser';
import { createBrowserClient } from '@programita/database/browser';
import { parseFestOnQr, resultCopy, type ScanResult } from './scanner-core';

type EventContext={id:string;organization_id:string;name:string;starts_at:string;timezone:string;location_id:string;location_name:string};
type CameraState='idle'|'requesting'|'scanning'|'denied'|'unavailable';
type ResultData={result:ScanResult;checked_in_at?:string;ticket_type_name?:string;public_code?:string};

export function DoorScanner({events,operatorLabel,publicOrigin}:{events:EventContext[];operatorLabel:string;publicOrigin:string}){
  const[eventId,setEventId]=useState(events[0]!.id),[camera,setCamera]=useState<CameraState>('idle'),[result,setResult]=useState<ResultData|null>(null),[count,setCount]=useState(0);
  const supabase=useMemo(()=>createBrowserClient(),[]);
  const video=useRef<HTMLVideoElement>(null),controls=useRef<IScannerControls|null>(null),busy=useRef(false),lastToken=useRef<string|null>(null),cooldown=useRef<ReturnType<typeof setTimeout>|null>(null);
  const event=events.find(item=>item.id===eventId)??events[0]!;
  const date=useMemo(()=>new Intl.DateTimeFormat('es-MX',{day:'2-digit',month:'2-digit',year:'2-digit',timeZone:event.timezone}).format(new Date(event.starts_at)).replaceAll('/',' · '),[event]);
  const stop=()=>{controls.current?.stop();controls.current=null;setCamera('idle')};
  useEffect(()=>()=>{controls.current?.stop();if(cooldown.current)clearTimeout(cooldown.current)},[]);
  useEffect(()=>{const {data}=supabase.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT'){controls.current?.stop();setCamera('idle');setResult({result:'unauthorized'})}});return()=>data.subscription.unsubscribe()},[supabase]);

  const finish=(data:ResultData,token:string)=>{void token;setResult(data);if(data.result==='accepted'){setCount(value=>value+1);navigator.vibrate?.(80)}else navigator.vibrate?.([120,70,120]);if(data.result==='unauthorized'){controls.current?.stop();setCamera('idle');return}cooldown.current=setTimeout(()=>{setResult(null);lastToken.current=null;busy.current=false},data.result==='accepted'?1400:2200)};
  const submit=async(token:string)=>{if(busy.current||lastToken.current===token)return;busy.current=true;lastToken.current=token;try{const {data,error}=await supabase.rpc('check_in_ticket',{p_organization_id:event.organization_id,p_event_id:event.id,p_token:token});if(error){if(error.code==='401'||error.code==='PGRST301'){finish({result:'unauthorized'},token);return}finish({result:'network'},token);return}const value=data as ResultData;finish(['accepted','already_checked_in','wrong_event','unavailable','unauthorized'].includes(value.result)?value:{result:'invalid'},token)}catch{finish({result:'network'},token)}};
  const detected=(payload:string)=>{const token=parseFestOnQr(payload,publicOrigin);if(!token){if(!busy.current){busy.current=true;finish({result:'invalid'},payload)}return}void submit(token)};
  const start=async()=>{if(camera==='requesting'||camera==='scanning')return;setCamera('requesting');try{const reader=new BrowserQRCodeReader(undefined,{delayBetweenScanAttempts:100});controls.current=await reader.decodeFromConstraints({audio:false,video:{facingMode:{ideal:'environment'}}},video.current??undefined,(decoded)=>{if(decoded)detected(decoded.getText())});setCamera('scanning')}catch(error){const name=error instanceof DOMException?error.name:'';setCamera(name==='NotAllowedError'?'denied':'unavailable')}};
  const retry=()=>{const token=lastToken.current;if(token){setResult(null);busy.current=false;lastToken.current=null;void submit(token)}};
  const logout=async()=>{stop();await supabase.auth.signOut();location.reload()};
  const copy=result?resultCopy(result.result):null;
  return <main className="scanner-shell"><header className="scanner-header"><div><p className="scanner-kicker">FEST-ON · PUERTA / SCANNER</p><h1>{event.name}</h1><p>{date} · {event.location_name}</p></div><div><small>{operatorLabel}</small><button onClick={logout}>SALIR</button></div></header>{events.length>1&&<label className="scanner-event">EVENTO<select value={eventId} onChange={e=>{stop();setEventId(e.target.value)}}>{events.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label>}<section className="scanner-camera"><video ref={video} muted playsInline/><div className="scanner-guide" aria-hidden="true"/><div className="scanner-instruction"><strong>{camera==='scanning'?'ESCANEANDO':camera==='requesting'?'SOLICITANDO PERMISO':camera==='denied'?'PERMISO DENEGADO':camera==='unavailable'?'CÁMARA NO DISPONIBLE':'LISTO PARA ESCANEAR'}</strong><span>APUNTÁ AL QR DE LA ENTRADA</span></div>{camera!=='scanning'&&camera!=='requesting'&&<button className="scanner-start" onClick={start}>INICIAR CÁMARA</button>}</section><aside className="scanner-count"><span>INGRESOS ESTA SESIÓN</span><strong>{count}</strong></aside>{result&&copy&&<section className={`scanner-result is-${result.result}`} aria-live="assertive" role="status"><p>{copy[0]}</p><h2>{copy[1]}</h2>{result.ticket_type_name&&<strong>{result.ticket_type_name}</strong>}{result.public_code&&<code>{result.public_code}</code>}{result.checked_in_at&&<time>{new Intl.DateTimeFormat('es-MX',{hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(result.checked_in_at))}</time>}{result.result==='network'&&<button onClick={retry}>REINTENTAR</button>}{result.result==='unauthorized'&&<a href="/scanner">VOLVER A INGRESAR</a>}</section>}</main>
}
