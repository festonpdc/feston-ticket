export function hasRecoveryIntent(search:string,hash:string){
  const query=new URLSearchParams(search),fragment=new URLSearchParams(hash.replace(/^#/,''));
  return (query.get('type')==='recovery'&&Boolean(query.get('token_hash')))||fragment.get('type')==='recovery';
}

export function validateNewPassword(password:string,confirmation:string){
  if(password.length<10)return 'Usá al menos 10 caracteres.';
  if(password!==confirmation)return 'Las contraseñas no coinciden.';
  return null;
}
