# Motor de inventario y reservas · Fase 2

## Fuente de verdad

PostgreSQL deriva consumo desde `orders` + `order_items`. No hay caché de stock ni
contadores mutables. Precios leídos de `ticket_types`, snapshots congelados al
salir de draft, totales en minor units seguros. FK y triggers de Fase 1 permanecen.
Las migraciones 001–003 no se modifican; 004 agrega valores de auditoría y 005
implementa el motor. 006 agrega idempotencia persistida y cierra la firma pública
anterior sin key. Deben aplicarse por archivo: PostgreSQL exige confirmar una
ampliación de enum antes de usar los nuevos valores.

| Estado | Consumo |
| --- | --- |
| draft | No |
| pending_payment con reserved_until > hora de DB | Reserva temporal |
| pending_payment vencida | No, aunque el job todavía no la haya marcado expired |
| paid | Vendido, incluso después de reserved_until |
| refunded | Sigue consumiendo; sin restitución automática |
| expired / cancelled | No |

Por tipo: `available = capacity - sold - active_reserved`. En consultas públicas
se limita además por la capacidad restante del evento, si tiene capacity. Las
disponibilidades de varios tipos comparten ese límite y **no se suman** como stock
independiente del evento. La consulta es una instantánea informativa; solo el
comando reserve garantiza adjudicación. La venta requiere estado published,
evento no terminado, tipo active y ambas ventanas `[sales_start, sales_end)`.
`sales_open` representa habilitación/ventana; comprobar también available_quantity.

## Protección contra sobreventa

1. Se valida input acotado y se toma un advisory lock transaccional por hash de
   idempotency_key. Luego `SELECT ... FOR UPDATE` sobre la única fila de
   `events` con id=event_id y organization_id coincidente.
2. Con el lock adquirido se obtiene `clock_timestamp()` y se leen precios,
   estados, ventanas y relaciones. Otras reservas del mismo evento esperan.
3. Se crean order draft e items, luego pending_payment. El trigger calcula
   consumo total por tipo y evento; exceder capacity aborta **todo**, incluida
   auditoría. Los totales diferidos se fuerzan antes de devolver el resultado.
4. El lock persiste hasta commit/rollback. La siguiente transacción lee el
   consumo confirmado por la anterior. Los comandos requieren READ COMMITTED:
   se rechazan otros niveles para evitar snapshots viejos tras esperar un lock.

El advisory lock deduplica el intento; el lock de fila sigue siendo la autoridad
de inventario. Se bloquea por evento (granularidad más amplia que por tipo) para cubrir la
capacidad total y evitar ordenar múltiples locks de tipos en una reserva. Eventos
distintos no comparten lock. Es una elección simple: ventas de un mismo evento
se serializan, por lo que el throughput debe medirse antes de eventos masivos.

Una reserva usa clave → evento → nueva orden/ítems; un replay usa clave → evento
→ orden existente FOR UPDATE. No hay locks exclusivos individuales de tipos:
todos los tipos del evento comparten su fila de event. FK adquieren locks
implícitos KEY SHARE en filas referenciadas. Los ítems se insertan con ORDER BY
ticket_type.id; normalizar el input también ordena los tipos por UUID.
Cancelación/confirmación usan evento → orden. El job ordena por event_id → id.
Triggers protegen cambios de estado y reducciones de capacidad del catálogo;
ticket types no pueden trasladarse a otro evento. Ediciones administrativas
directas del catálogo o transacciones que mezclan varios comandos pueden causar
deadlocks (PostgreSQL aborta una transacción, no permite sobreventa). Mantener
transacciones cortas; ante 40P01/40001 reintentar la transacción completa solo si
se sabe que fue abortada. No hacer llamadas al proveedor dentro del lock.

Referencias: [locks de filas PostgreSQL](https://www.postgresql.org/docs/17/explicit-locking.html)
y [snapshots/volatilidad de funciones](https://www.postgresql.org/docs/17/xfunc-volatility.html).

## Configuración central

`private.inventory_settings` contiene una sola fila. Defaults: **900 segundos
(15 minutos)** y **10 tickets por orden** sumando todos los tipos. Un administrador
de DB puede cambiar esa fila; ni anon/authenticated/service_role tienen acceso
directo. Límites de configuración: 60–3600 segundos, 1–100 tickets. Reservas ya
creadas conservan su vencimiento original. Esto es solo política online: no
aplicar automáticamente a efectivo/OXXO ni otros pagos diferidos.

## RPCs y permisos

Todas fijan `search_path=''`, califican objetos y tienen grants explícitos.
Ninguna policy RLS histórica se relaja. Las 13 tablas públicas siguen con RLS
forzada, más la configuración privada cerrada. Se revocan las escrituras directas
de service_role sobre orders/order_items: la aplicación debe pasar por comandos.
Un superusuario puede cambiar funciones/desactivar triggers; queda fuera de la
frontera de amenazas del motor.

| RPC | Caller | Contrato |
| --- | --- | --- |
| ticket_availability(org,event) | anon/authenticated/service_role | Proyección pública sin clientes/órdenes/pagos/hashes. Solo eventos published/sales_closed y tipos active/paused/sold_out |
| reserve_tickets(org,event,customer,items,idempotency_key) | service_role | Items JSON `{ticket_type_id,quantity}` sin precio. Una order por clave/contexto, snapshot, deadline y auditoría atómicos |
| cancel_reservation(org,order) | service_role | Solo pending → cancelled; repetir cancelled no agrega auditoría |
| confirm_reserved_order(org,order) | service_role | Solo pending vigente → paid; repetir paid es idempotente. No crea payments/tickets |
| expire_reservations(before?,limit?) | service_role | Cutoff default hora de DB; rechaza futuro/infinito. Default 500, máximo 1000 por lote. Revalida estado tras lock |

Los helpers private no son RPCs ni se conceden a clientes. La proyección pública
expone exactamente id de tipo, name, price, currency, status, available_quantity,
sales_open. Un evento draft de cualquier organización no filtra detalles.

Comandos TypeScript en `@programita/database/inventory`: reserveTicketsForMember,
cancelReservationForMember, ticketAvailability. Los dos primeros requieren un
cliente de sesión del request, verifican `auth.getUser()` y membership
owner/manager antes de invocar el cliente administrativo. Es una autorización de
staff: la futura compra pública necesitará su propio contexto autenticado o una
capacidad de compra opaca, asociación segura de cliente, límites por identidad/IP
y política de rate limiting. No exponer estos comandos como acciones públicas
aceptando libremente customer_id del navegador.

`@programita/database/inventory-internal` contiene confirmReservedOrder y
expireReservations: solo backend confiable. No hay endpoint, cron externo ni
webhook implementado. El caller es responsable de autenticar job/webhook. El rol
service_role es una credencial global; organization_id delimita cada operación,
pero no constituye por sí solo autorización de una persona.

Ejemplo SQL de backend confiable (no ejecutar como comprador):

```sql
select public.reserve_tickets(:org, :event, :customer,
  jsonb_build_array(jsonb_build_object('ticket_type_id', :type, 'quantity', 2)),
  :idempotency_key);
```

## Expiración, cancelación y confirmación

El stock se libera lógicamente al alcanzar reserved_until. El job actualiza el
estado histórico a expired y agrega reservation_expired una sola vez. Ejecutar
lotes hasta recibir 0; no afecta paid y no requiere infraestructura para que la
consulta de disponibilidad sea correcta. Varias ejecuciones son idempotentes.

Cancelar pending libera stock; paid no admite ese comando. Confirmar exige una
reserva todavía vigente, conserva precio/importe/deadline y cambia la categoría
reserved → sold, sin duplicar consumo. Un pago que llegue tarde se rechazará en
dominio: el futuro proveedor deberá tener una política explícita de conciliación
o devolución; no reabrir expired/cancelled automáticamente.

Antes de un webhook real: verificar firma, vínculo de order, amount/currency e
idempotency del evento del proveedor; persistir payment y confirmar en una única
operación transaccional diseñada para ese proveedor. `order_confirmed` no prueba
que hubo cobro. La creación de reservas exige ahora idempotency_key de 256 bits.
Repetir la misma clave/contexto recupera la orden, incluso tras commit incierto,
sin renovar su deadline. El caller conserva la clave durante el intento y los
reintentos; nunca generar otra automáticamente al reintentar. Un nuevo pedido
material requiere otro intento/clave. Véase [revisión 2B](inventory-hardening.md).

Refunded conserva capacidad para no revender un asiento/ticket ya utilizado o
todavía válido. Una futura restitución necesitará estado de tickets y política
de evento; no hay refund financiero aquí.

## Cortesías y auditoría

`orders.order_kind` identifica standard/complimentary y es inmutable. Complimentary
exige total/subtotal 0; no se admite enviarla a pending_payment con el motor
actual. Queda preparado el modelo para un comando Manager futuro que use el
mismo lock, consuma capacidad como orden confirmada y registre
complimentary_created sin pago ficticio. No existe emisión completa de cortesías.

Eventos nuevos: inventory_reserved, reservation_cancelled, reservation_expired,
order_confirmed. Se insertan en la misma transacción; metadata solo source del
motor, sin PII. actor_user_id es null en estas operaciones de sistema; la futura
API podrá agregar atribución verificada de personas, nunca un actor libre del
comprador. Reintentos idempotentes no duplican eventos.

## Tests y límites de evidencia

`pnpm test` conserva las 39 pruebas de Fase 1 y agrega pruebas SQL del motor,
helpers y combinaciones de invariantes sin dependencias nuevas. PGlite aplica
migraciones completas y ejecuta PostgreSQL/RLS/triggers; no simula concurrencia.

Prueba concurrente real preparada en `tests/database/inventory-concurrency.test.ts`:
15 conexiones con PID distinto esperan simultáneamente el lock del evento;
después se libera y se exigen exactamente 2 reservas y 13 rechazos por capacidad,
sin órdenes/ítems/auditoría parciales. Se repite por capacidad del tipo y por
capacidad de evento compartida entre dos tipos. Fase 2B agrega orden inverso de
múltiples tipos (capacidad global 4, dos órdenes de dos unidades) y 15 reintentos
con la misma clave (15 respuestas exitosas, una sola orden/unidad/auditoría).

Para ejecutarla: iniciar Supabase **local** con Docker, `pnpm db:reset`, definir
TEST_DATABASE_URL con la conexión administrativa local, y `pnpm test:db` (o
`pnpm exec vitest run tests/database/inventory-concurrency.test.ts`). Se necesita
CREATEDB y roles anon/authenticated/service_role. Se crea una DB temporal con
nombre aleatorio ticketing_test_* y se elimina al finalizar, sin resetear la DB
del caller. El bootstrap de Auth es mínimo; esto prueba concurrencia de PostgreSQL,
no sesiones JWT/HTTP de GoTrue/PostgREST. No usar túneles a un servidor remoto.

Sin TEST_DATABASE_URL, las cuatro pruebas concurrentes y los marcadores de Supabase
local se reportan skipped. No se declara un resultado de concurrencia real a
partir de las pruebas secuenciales en PGlite.
### Capacidad sin límite comercial

Desde la migración `202609250007`, `ticket_types.capacity` puede ser `NULL`. Esto significa que no hay límite comercial configurado para ese tipo; no representa cero ni una capacidad artificial. `ticket_availability.available_quantity` también devuelve `NULL` para ese caso, una representación explícita de ilimitado. Las cantidades vendidas y reservadas continúan calculándose desde `order_items` y las órdenes; la capacidad global del evento permanece independiente.
