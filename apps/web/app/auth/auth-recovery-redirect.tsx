'use client';
import { useEffect } from 'react';

export function AuthRecoveryRedirect(){
  useEffect(()=>{
    if(location.pathname==='/auth/reset-password')return;
    const type=new URLSearchParams(location.hash.slice(1)).get('type');
    if(type==='recovery')location.replace('/auth/reset-password'+location.hash);
  },[]);
  return null;
}
