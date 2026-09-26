export function hasRecoveryIntent(search:string,hash:string){
  const query=new URLSearchParams(search),fragment=new URLSearchParams(hash.replace(/^#/,''));
  return (query.get('type')==='recovery'&&Boolean(query.get('token_hash')))||fragment.get('type')==='recovery';
}

export function validateNewPassword(password:string,confirmation:string){
  if(password.length<10)return 'Usá al menos 10 caracteres.';
  if(password!==confirmation)return 'Las contraseñas no coinciden.';
  return null;
}

type RecoveryAuth={
  setSession(tokens:{access_token:string;refresh_token:string}):Promise<{data:{session:unknown|null};error:unknown}>;
  verifyOtp(input:{token_hash:string;type:'recovery'}):Promise<{data:{session:unknown|null};error:unknown}>;
};

export async function resolveRecoverySession(auth:RecoveryAuth,search:string,hash:string,cleanUrl:()=>void){
  const query=new URLSearchParams(search);
  const tokenHash=query.get('type')==='recovery'?query.get('token_hash'):null;
  if(tokenHash){
    const result=await auth.verifyOtp({token_hash:tokenHash,type:'recovery'});
    cleanUrl();
    return !result.error&&Boolean(result.data.session);
  }
  const fragment=new URLSearchParams(hash.replace(/^#/,''));
  if(fragment.get('type')!=='recovery')return false;
  const accessToken=fragment.get('access_token'),refreshToken=fragment.get('refresh_token');
  if(!accessToken||!refreshToken){cleanUrl();return false}
  cleanUrl();
  const result=await auth.setSession({access_token:accessToken,refresh_token:refreshToken});
  return !result.error&&Boolean(result.data.session);
}
