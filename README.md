# Programita Ticketing Core

Núcleo reusable multi-organización/multi-evento. Fase 1: foundation, datos,
seguridad y tests. Sin landing del evento, checkout, proveedores de pago,
emisión automática, scanner ni Manager visual.

## Arquitectura

```text
apps/web/                 Next.js 16 App Router; shell técnico, sin UI de evento
packages/database/        clientes Supabase server-only y tipos generados
packages/ticketing/        dinero, totales y estados
packages/security/        validación y criptografía
packages/ui/              reservado
packages/payments/        reservado, sin integración
supabase/migrations/      SQL versionado: dominio, integridad, RLS
supabase/seeds/demo.sql    DEMO separado, deshabilitado por defecto
tests/unit/               Vitest
tests/database/           PostgreSQL embebido + suite Supabase local opcional
tests/e2e/                Playwright preparado; sin specs de producto todavía
docs/architecture.md      decisiones y límites
```

## Setup

Node >=22.14 y pnpm 12.5.1. `pnpm install --frozen-lockfile`.
`pnpm dev` levanta el shell en localhost:3000; no requiere credenciales para compilar.
Copiar `.env.example` a `apps/web/.env.local` y completar únicamente para usar Supabase.

| Variable | Uso |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | URL de Supabase |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Clave pública, sometida a RLS |
| `SUPABASE_SERVICE_ROLE_KEY` | Secreto opcional, solo operaciones administrativas server-side; bypass RLS |
| `TEST_DATABASE_URL` | Conexión PostgreSQL administrativa a Supabase local desechable para tests |
| `DEMO_DATABASE_URL` | Conexión PostgreSQL administrativa local para seed explícito |

No incluir credenciales en código, comandos guardados o logs. Scripts de DB leen
variables del proceso, no cargan automáticamente `apps/web/.env.local`.

## Base de datos local

Instalar/iniciar Docker Desktop. La CLI Supabase está fijada en el lockfile:

```sh
pnpm db:start
pnpm db:reset
pnpm exec supabase status
```

`db:reset` recrea **la DB local** y aplica `supabase/migrations/*.sql`; elimina sus
datos. El seed automático está desactivado. Usar la conexión local indicada por
`supabase status` como `DEMO_DATABASE_URL` y ejecutar `pnpm db:seed`.
El script solo acepta loopback y rechaza `NODE_ENV=production`; no usar túneles a
DB remotas. El seed es idempotente, no crea usuarios/contraseñas y no habilita ventas.
Todos los importes, capacidades, moneda y horario/zona son DEMO sin confirmar.

Los usuarios Auth crean su perfil mediante trigger. Crear la organización y su
primer owner requiere una operación administrativa confiable en una transacción:
insertar organización y membership con el UUID de un usuario Auth existente.
No existe endpoint público de alta de organizaciones en esta fase. El seed no
asigna owners; hacerlo explícitamente para desarrollo.

`pnpm db:types` regenera tipos aplicando las migraciones en PostgreSQL embebido;
no necesita secretos ni Docker. Las migraciones se aplicarán a entornos remotos
mediante un proceso revisado posterior; esta fase no realiza deploy.

## Verificación

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Smoke HTTP de producción: en una terminal `pnpm start`, en otra `pnpm test:http`.
Verifica 200/404, nonce nuevo por respuesta y coherente con todos los scripts,
CSP sin unsafe-inline/unsafe-eval y headers de seguridad. No requiere navegador.

`pnpm test:unit`: helpers y seguridad. `pnpm test:db`: migraciones completas,
constraints, grants y RLS **ejecutados por PostgreSQL** mediante PGlite. Solo se
reproduce el límite Auth (`auth.users`, `auth.uid()` y roles); RLS no se simula.

Para la misma suite contra Supabase real local: ejecutar `db:start`, `db:reset`,
definir `TEST_DATABASE_URL` con la conexión PostgreSQL local administrativa y
ejecutar `pnpm test:db`. En PowerShell: `$env:TEST_DATABASE_URL = '<conexión local>'`.
Los fixtures se crean en transacciones y se revierten después de cada test.
Usar una DB local desechable sin los UUID de fixtures; no apuntar a producción.
Sin esa variable la suite Supabase se informa **skipped**, no aprobada.

Playwright está configurado para futuros E2E. Todavía no hay specs de producto;
no se contabiliza como suite ejecutada. Instrucciones en `tests/e2e/README.md`.

## Seguridad y multi-tenancy

RLS habilitada y forzada en las 13 tablas. Claves foráneas compuestas incluyen
organización y, cuando corresponde, evento, orden, tipo de entrada y moneda.

| Rol | Permisos directos |
| --- | --- |
| owner | Catálogo/clientes CRUD, configuración de su organización, gestión de miembros, lectura operacional/financiera |
| manager | Catálogo/clientes CRUD y lectura operacional/financiera de su organización; sin gestión de roles/configuración organizacional |
| door | Su perfil, identificación de su organización y su propia membership. Sin datos operacionales, PII de clientes, finanzas ni hashes de tickets |
| anon | Sin acceso a tablas privadas |

Incluso owner/manager requieren **futuros comandos server-side autorizados** para
escribir órdenes, pagos, tickets, check-ins y auditoría. No se expone una vía
directa para marcar órdenes pagadas o emitir entradas desde el navegador.
Los permisos administrativos completos son de dominio; estas operaciones no
tienen implementación de producto en Fase 1. `service_role` es una credencial
de confianza que omite RLS, jamás debe usarse como cliente general de usuario.

Precios en minor units `bigint`, limitados a enteros seguros de JavaScript.
Snapshots y totales en DB; una compra no se recalcula desde el catálogo actual.
Tokens aleatorios de 256 bits y hash SHA-256; solo el token entregado al cliente
será secreto. Los códigos públicos no autorizan acceso. Nunca loguear tokens,
PII ni payloads de proveedores. Metadata solo admite una lista pequeña de claves;
esa validación no sustituye revisar el contenido al agregar futuros escritores.

CSP con nonce por respuesta, SSR dinámico, headers de seguridad y HSTS en
producción. Supabase se consume server-side; la CSP no habilita terceros.
Auth preparado mediante cliente SSR con cookies, sin UI de login ni flujo de
refresh completo todavía. `supabaseServer()` debe usarse en Route Handlers o
Server Actions donde se puedan escribir cookies.

Referencias de diseño: [RLS Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security)
y [CSP Next.js](https://nextjs.org/docs/app/guides/content-security-policy).
