# Fase 2B · Inventory Hardening

Se mantiene el trabajo de Fase 2 sin commit ni conexión remota. La protección
anti-overselling **todavía no está validada con conexiones PostgreSQL reales**.

## Idempotencia persistida

Migración nueva: `202609240006_reservation_idempotency.sql`. Mantiene 001–005
intactas. Mueve la reserva sin clave al schema private, revocando EXECUTE a todos
los roles de aplicación; deja una sola firma pública
`reserve_tickets(org,event,customer,items,idempotency_key)`.

La clave es un identificador opaco de intento: 32 bytes criptográficos aleatorios,
representados por 64 caracteres hex minúsculos. `generateIdempotencyKey()` usa
randomBytes; el comando exige la clave del caller, no la genera por retry.
La forma se valida; la entropía no se deduce de una cadena aportada por un cliente.
La futura capa de compra debe generar claves seguras y mantener el mismo intento
ante doble click, refresh/reconexión; no registrar claves en logs.

Se normalizan UUIDs, cantidades enteras y orden de tipos por UUID. Se rechazan
duplicados/campos adicionales como precios. El payload material comprende versión
1 del contrato, organización, evento, cliente, tipos y cantidades. Precios,
moneda y deadline vienen de DB; cambios posteriores de catálogo, ventas o límites
no impiden recuperar la orden con su snapshot original.

`private.reservation_requests` guarda:

- key_hash SHA-256, PRIMARY KEY global;
- payload_hash SHA-256 del contexto normalizado;
- order_id NOT NULL, UNIQUE, FK a orders;
- created_at.

Sin key ni token de ownership en plaintext. RLS forzada, sin grants para
anon/authenticated/service_role y triggers append-only. La deduplicación persiste
en DB y funciona entre instancias/serverless. La clave es global: otro tenant,
evento o cliente con la misma clave produce conflicto, sin devolver la orden
anterior. El hash completo es la identidad única, no el lock reducido a 64 bits.

Flujo: validar → advisory lock transaccional por clave → buscar mapping. Si
existe, comparar payload_hash; diferencias producen SQLSTATE **PT409**, sin
escrituras. Si coincide, tomar lock de evento y orden, devolver snapshots
originales, estado actual y reservation_active. No renovar reserved_until,
reabrir estados terminales, consumir stock ni duplicar auditoría. Una pending
vencida puede continuar pending hasta el job, pero reservation_active es false.

Si no existe mapping, el motor original crea la reserva y registra la relación
única en la misma transacción. Un error revierte order, items, audit y mapping.
Una clave cuyo intento falló sin commit puede reintentarse. Una clave confirmada
no se recicla cuando la orden vence/cancela/paga: otra compra requiere otra clave.
Sin GC del mapping: conservarlo con la orden. Archivado futuro debe conservar
tombstones para impedir reutilización accidental. La canonicalización está
versionada: cambios futuros deben mantener comparación compatible con mappings
existentes. Idempotencia no es autorización, prueba de pago ni rate limiting.

## Filas y orden de locking

Una llamada de reserva por transacción READ COMMITTED:

1. `pg_advisory_xact_lock(hashtextextended('reservation:' || key_hash,0))`.
   No es una fila; serializa la clave. Colisiones de los 64 bits solo serializan
   claves distintas; se compara siempre el SHA-256 completo.
2. La única fila `public.events` con `id=event_id AND organization_id=org`,
   `FOR UPDATE`. Esta misma fila protege TODOS sus tipos y event.capacity.
3. Replay: fila de la orden asociada al mapping, también `FOR UPDATE`.
   Creación: nueva orden insertada/actualizada bajo el lock de evento.
4. Ítems insertados con `ORDER BY ticket_type.id`; FK adquieren locks implícitos
   KEY SHARE sobre referencias. No hay locks exclusivos individuales por tipo.

El lock de inventario no cambió de estrategia. Dos tipos del mismo evento
esperan la **misma fila de events** antes de verificar consumo global. Cambios
de estado y reducciones de capacidad usan ese evento para serializar. Confirm y
cancel: evento → orden. Expire: eventos ordenados por UUID y órdenes por UUID.

No hay inversión de tipos entre reservas: se serializan antes de tocar ítems y
el INSERT tiene orden explícito. No se promete ausencia universal de deadlocks:
UPDATE directo del catálogo adquiere su fila y luego el evento en el trigger;
transacciones administrativas/múltiples comandos con orden inverso pueden causar
40P01. PostgreSQL aborta una transacción. Usar una RPC por transacción y ninguna
llamada externa entre locks. Ante aborto confirmado, retry completo con la misma
key. El test real de arrays invertidos está preparado, todavía no ejecutado.

Referencia: [locks transaccionales PostgreSQL](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS).

## RPCs y disponibilidad pública

Todas las RPCs SECURITY DEFINER fijan `search_path=''`, califican objetos, validan
inputs y tienen grants explícitos. PUBLIC sin EXECUTE. Tests consultan pg_proc/ACL
y comprueban que no exista el overload público sin key. El owner de funciones es
el administrador de migraciones, no un rol de aplicación.

| RPC | anon | authenticated | service_role |
| --- | --- | --- | --- |
| ticket_availability | Ejecutar | Ejecutar | Ejecutar |
| reserve_tickets con key | No | No | Ejecutar |
| cancel_reservation | No | No | Ejecutar |
| confirm_reserved_order | No | No | Ejecutar |
| expire_reservations | No | No | Ejecutar |
| private.reserve_tickets sin key | No | No | No |

Policies públicas sin cambios. No se abren orders ni tickets. Comandos de staff
verifican auth.getUser() y membership antes de cada llamada, incluido replay.
No hay endpoint público. service_role sigue siendo credencial global confiable,
no una identidad de comprador.

Availability devuelve solo ticket_type_id público, name, price, currency, status,
available_quantity y sales_open. Sin order_id/customer_id/payment_id, emails,
teléfonos, tokens, mapping idempotente ni metadata. Tests comprueban que cambiar
PII o pasar pending a paid no altera la proyección. **No se promete cero inferencia
externa:** observar stock exacto permite inferir variaciones agregadas de demanda,
especialmente con poco stock. No identifica comprador ni permite consultar una
orden. Ocultar incluso esa señal exigiría stock aproximado, otro contrato público.

## Ownership futuro por token/magic link

No se agregan cuentas/passwords ni campos de tokens de comprador ahora. El patrón
previsto usa una capacidad temporal limitada a una orden, nunca a la organización
completa ni a un customer_id libremente aportado:

1. Backend genera token aleatorio de 256 bits. Persiste solo hash, organization_id,
   order_id, purpose, expires_at, used_at y revoked_at. Token de acceso a orden
   distinto de token de ingreso/QR e idempotency_key.
2. Magic link entregado exclusivamente al contacto de compra verificado por el
   backend, no a una dirección arbitraria del solicitante. Recuperación con
   respuesta uniforme/límites anti-abuso evita enumeración. Email aún no implementado.
3. No consumir en un GET que pueda abrir un previsualizador. Canje explícito por
   POST, validación atómica de hash, propósito, vencimiento y no-uso; consumir en
   esa transacción.
4. Sesión corta por orden: cookie HttpOnly/Secure/SameSite y credencial aleatoria
   con hash server-side. Endpoints verifican capacidad en cada consulta y filtran
   organization_id + order_id + vínculo de tickets. UUID/public_code/email/key
   de retry no bastan para autorizar.
5. Expiración, revocación y rotación invalidan acceso. Cache-Control no-store,
   sin secretos/PII en logs, analytics o Referer. Evitar tokens en query strings;
   concretar transporte seguro del link/canje antes de UI.

No abrir RLS anónima para este patrón. El mapping idempotente no es una API de
recuperación ni propiedad de órdenes.

## Auditoría de los 13 archivos untracked originales

| Archivo al iniciar 2B | Clasificación | Acción |
| --- | --- | --- |
| docs/inventory.md | Documentación | Conservado y actualizado con key/locks |
| docs/verification-phase-2.md | Documentación | Conservado como evidencia histórica, enlazado a 2B |
| packages/database/src/inventory-internal.ts | Código necesario | Conservado; confirmación/job internos |
| packages/database/src/inventory.ts | Código necesario | Conservado; exige key del intento |
| packages/ticketing/src/inventory.ts | Código necesario | Conservado; helpers y validación |
| supabase/migrations/202609230004_inventory_events.sql | Migración | Conservada intacta |
| supabase/migrations/202609230005_inventory_engine.sql | Migración | Conservada intacta; hardening incremental 006 |
| tests/database/inventory-concurrency.test.ts | Test | Conservado; key y dos escenarios reales adicionales |
| tests/database/inventory-support.ts | Fixture necesario | Conservado; harness/fixtures adaptados a key |
| tests/database/inventory.test.ts | Test | Conservado intacto; 33 casos |
| tests/support/server-only.ts | Test | Conservado; adaptador exclusivo del runner Node |
| tests/unit/inventory-authorization.test.ts | Test | Conservado; mismo coverage, firma con key |
| tests/unit/inventory.test.ts | Test | Conservado intacto |

Ninguno es artefacto temporal ni dump/reporte generado innecesario. No se elimina
documentación útil ni tests. Caches, dependencias y builds locales quedan fuera
del repo por .gitignore. database.types.ts es código necesario derivado de las
migraciones, no un resultado de QA.

## Verificación de 2B · 2026-09-24

| Comprobación | Resultado |
| --- | --- |
| pnpm db:types | PASS: 6 migraciones aplicadas, firma RPC generada con key obligatoria |
| pnpm test | 114 aprobados: 83 previos + 31 nuevos; 7 skipped |
| pnpm typecheck | PASS |
| pnpm lint | PASS, cero warnings |
| pnpm build | PASS, Next.js 16.3.6 |

Nuevos tests: clave/payload iguales, conflictos por cada componente material,
claves distintas, canonicalización, persistencia entre commits, snapshots tras
cambios de catálogo/configuración, replay pagado/cancelado/vencido, rollback del
mapping, hashes/constraints/inmutabilidad, formato/entropía de claves, ACLs y
search_path, ausencia de overload antiguo, privacidad de availability y capacidad
global compartida con input invertido.

Los 7 skipped son tres marcadores de suites Supabase local (Fase 1, Fase 2 y 2B)
y cuatro casos concurrentes preparados: capacidad por tipo, capacidad por evento,
múltiples tipos en orden inverso y 15 reintentos de la misma key. **Ninguno de los
cuatro casos reales fue ejecutado.** No hay validación de anti-overselling real,
deadlocks entre backends ni carreras de idempotencia hasta correrlos en PostgreSQL
local con conexiones separadas. Tampoco se probaron GoTrue/PostgREST/E2E reales.
No hubo conexión remota, deploy, implementación de pagos/UI/QR ni commit.
