import { createAdminClient } from '@programita/database/admin';
import { supabaseServer } from '../../lib/supabase';
import { ScannerLogin } from './scanner-login';
import { DoorScanner } from './scanner';
import { publicAppUrl } from '../../lib/public-app-url';

export const dynamic='force-dynamic';

export default async function ScannerPage(){
  const client=await supabaseServer();
  const {data:{user}}=await client.auth.getUser();
  if(!user)return <ScannerLogin/>;
  const memberships=await client.from('organization_members').select('organization_id,role').eq('user_id',user.id);
  const allowed=(memberships.data??[]).filter(member=>['owner','manager','door'].includes(member.role));
  if(!allowed.length)return <ScannerDenied expired={false}/>;
  const organizationIds=allowed.map(member=>member.organization_id);
  const admin=createAdminClient();
  const events=await admin.from('events').select('id,organization_id,name,starts_at,timezone,location_id').in('organization_id',organizationIds).eq('status','published').order('starts_at');
  const locationIds=[...new Set((events.data??[]).map(event=>event.location_id))];
  const locations=locationIds.length?await admin.from('locations').select('id,name').in('id',locationIds):{data:[]};
  const names=new Map((locations.data??[]).map(location=>[location.id,location.name]));
  const contexts=(events.data??[]).map(event=>({...event,location_name:names.get(event.location_id)??'Ubicación'}));
  if(!contexts.length)return <ScannerDenied expired={false}/>;
  return <DoorScanner events={contexts} operatorLabel="OPERADOR AUTORIZADO" publicOrigin={new URL(publicAppUrl('/')).origin}/>;
}

function ScannerDenied({expired}:{expired:boolean}){return <main className="scanner-shell scanner-centered"><section className="scanner-panel"><p className="scanner-kicker">FEST-ON · PUERTA</p><h1>{expired?'SESIÓN VENCIDA':'ACCESO NO AUTORIZADO'}</h1><p>{expired?'Volvé a ingresar para continuar.':'Tu cuenta no tiene permisos de puerta.'}</p><a href="/scanner">VOLVER A INGRESAR</a></section></main>}
