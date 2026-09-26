import 'server-only';
export function publicAppUrl(path:string){
  const configured=process.env.PUBLIC_APP_URL;
  if(!configured)throw new Error('PUBLIC_APP_URL is required');
  const origin=new URL(configured);
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('PUBLIC_APP_URL must be an HTTPS origin');
  return new URL(path,origin).toString();
}
