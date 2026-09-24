import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir, writeFile } from 'node:fs/promises';
const db = new PGlite();
try {
  await db.exec(await readFile('tests/database/bootstrap.sql', 'utf8'));
  for (const file of (await readdir('supabase/migrations')).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(`supabase/migrations/${file}`, 'utf8'));
  }
  const { rows: columns } = await db.query(`select table_name, column_name, is_nullable, column_default,
    data_type, udt_name, domain_name from information_schema.columns where table_schema='public' order by table_name, ordinal_position`);
  const { rows: enums } = await db.query(`select t.typname, e.enumlabel from pg_type t join pg_enum e on e.enumtypid=t.oid join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' order by t.typname,e.enumsortorder`);
  const enumMap = Object.groupBy(enums, e => e.typname);
  const { rows: fks } = await db.query(`select c.conname, c.conrelid::regclass::text as table_name,
    c.confrelid::regclass::text as referenced_relation,
    array(select a.attname from unnest(c.conkey) with ordinality k(num,ord) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.num order by k.ord) as columns,
    array(select a.attname from unnest(c.confkey) with ordinality k(num,ord) join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.num order by k.ord) as referenced_columns
    from pg_constraint c join pg_namespace n on n.oid=c.connamespace where c.contype='f' and n.nspname='public'`);
  const type = c => {
    let t = enumMap[c.udt_name] ? `Database['public']['Enums']['${c.udt_name}']`
      : ['bigint','integer','smallint','numeric'].includes(c.data_type) ? 'number'
      : c.data_type === 'boolean' ? 'boolean' : c.data_type === 'jsonb' ? 'Json' : 'string';
    if(c.is_nullable === 'YES') t += ' | null';
    return t;
  };
  let out = '// Generated from versioned migrations by pnpm db:types. Do not hand edit.\n';
  out += 'export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];\n';
  out += 'export type Database = { public: { Tables: {\n';
  for (const [table, cols] of Object.entries(Object.groupBy(columns, c => c.table_name))) {
    out += `${table}: {\n`;
    for (const mode of ['Row','Insert','Update']) {
      out += `${mode}: {\n`;
      for (const c of cols) out += `${c.column_name}${mode === 'Update' || (mode === 'Insert' && (c.column_default !== null || c.is_nullable === 'YES')) ? '?' : ''}: ${type(c)};\n`;
      out += '};\n';
    }
    out += 'Relationships: [\n';
    for(const fk of fks.filter(f => f.table_name.replace('public.','') === table && !f.referenced_relation.startsWith('auth.'))) {
      out += `{ foreignKeyName: ${JSON.stringify(fk.conname)}; columns: ${JSON.stringify(fk.columns)}; isOneToOne: false; referencedRelation: ${JSON.stringify(fk.referenced_relation.replace('public.',''))}; referencedColumns: ${JSON.stringify(fk.referenced_columns)} },\n`;
    }
    out += '];\n};\n';
  }
  out += '}; Views: { [_ in never]: never }; Functions: { [_ in never]: never }; Enums: {\n';
  for(const [name, values] of Object.entries(enumMap)) out += `${name}: ${values.map(v => JSON.stringify(v.enumlabel)).join(' | ')};\n`;
  out += '}; CompositeTypes: { [_ in never]: never }; }; };\n';
  await writeFile('packages/database/src/database.types.ts', out);
  console.log('Generated database.types.ts from applied migrations.');
} finally { await db.close(); }
