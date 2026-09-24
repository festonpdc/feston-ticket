# Festón Ticket · Programita Ticketing Core

Núcleo reusable multi-organización/multi-evento. Fases 1–2: foundation, datos,
seguridad y motor transaccional de inventario/reservas. Sin landing del evento, checkout, proveedores de pago,
emisión automática, scanner ni Manager visual.

## Arquitectura

```text
apps/web/                 Next.js 16 App Router; shell técnico, sin UI de evento
packages/database/        clientes Supabase, comandos server-only y tipos generados
packages/ticketing/        dinero, totales, estados y helpers de inventario
packages/security/        validación y criptografía
packages/ui/              reservado
packages/payments/        reservado, sin integración
supabase/migrations/      SQL incremental: dominio, integridad, RLS e inventario
supabase/seeds/demo.sql    DEMO separado, deshabilitado por defecto
tests/unit/               Vitest
tests/database/           PostgreSQL embebido + suite Supabase local opcional
tests/e2e/                Playwright preparado; sin specs de producto todavía
docs/architecture.md      decisiones y límites
docs/inventory.md         contratos de reserva, locking y pruebas concurrentes
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
La suite concurrente crea una DB temporal `ticketing_test_<uuid>` con 15 conexiones
reales y la elimina al finalizar; requiere permiso CREATEDB y roles locales de
Supabase. No modifica ni recrea la DB indicada en la URL. Ver `docs/inventory.md`.
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
| anon | Sin acceso a tablas privadas; solo RPC pública de disponibilidad sin PII |

Owner/manager pueden usar comandos server-only de reserva/cancelación que verifican
su sesión y membership. No hay endpoints ni server actions públicos nuevos.
Las RPC de escritura solo admiten `service_role`; ni siquiera ese rol puede ahora
insertar/actualizar directamente orders/order_items. Las policies de Fase 1 no
cambian. Pagos, emisión, check-ins y sus UIs siguen pendientes. `service_role`
omite RLS y jamás debe usarse como cliente general de usuario.

## Inventario y reservas

`reserve_tickets` crea order + items + auditoría en una transacción con precios de
DB, reserva **15 minutos** y máximo **10 entradas** por orden. Ambos parámetros
son configurables en `private.inventory_settings` por un administrador de DB.
No son parámetros aceptados del comprador; OXXO/efectivo no usan esta política.

Capacidad consumida: `paid` + `refunded` + `pending_payment` no vencidas.
`draft`, `cancelled`, `expired` y pending vencida no consumen. Lock de la fila del
evento bajo READ COMMITTED serializa las mutaciones, con capacidad por tipo y
capacidad global del evento. No hay contadores mutables ni cron externo requerido.

La reserva exige `idempotency_key` de 64 caracteres hex aleatorios (256 bits).
Generarla una vez por intento con `generateIdempotencyKey` y conservarla para
reintentos. PostgreSQL persiste solo hashes: mismo contexto/key recupera la orden;
cambio material con la misma key devuelve conflicto `PT409`. Repetir no extiende
la reserva; la clave no autoriza consultar órdenes ni tickets.

RPCs: `ticket_availability`, `reserve_tickets`, `cancel_reservation`,
`expire_reservations`, `confirm_reserved_order`. Esta última solo cambia dominio:
no acredita dinero, registra pagos ni emite tickets. Requiere un caller interno
confiable; un futuro webhook deberá verificar proveedor/importe/moneda primero.

Disponibilidad pública devuelve únicamente tipo, nombre, precio, moneda, estado,
cantidad disponible y ventana de venta; drafts no se publican. Inventario exacto,
privacidad, límites de concurrencia y comandos TypeScript: [docs/inventory.md](docs/inventory.md).
Idempotencia, audit de archivos, permisos y ownership futuro: [revisión 2B](docs/inventory-hardening.md).

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
