# Arquitectura · Fases 1–2

Un monorepo pnpm, una aplicación Next.js 16, una DB PostgreSQL/Supabase.
Sin microservicios ni compilación separada de librerías. Paquetes internos TypeScript
strict consumidos por Next. Vercel: root directory `apps/web`; instalar desde el
workspace y ejecutar el build de `@programita/web`. No hay deploy realizado.

## Dominio

Organization contiene Locations, Events, Customers y Members. Cada evento tiene
Ticket Types; las órdenes pertenecen a un cliente de la misma organización y a
un único evento. Cada Order Item conserva cantidad, moneda y precio histórico.
Payments referencia Order. Cada Ticket representa una unidad de Order Item.
Check-in referencia Ticket y un miembro de la misma organización. Profiles es
la extensión mínima de Supabase Auth, no almacena contraseñas.

Flujo **futuro**: `Event → Order → Payment → Ticket → Check-in`.

**Payments y ticket issuance NO están implementados.** Existen tablas y helpers,
no checkout, webhooks, confirmación de pagos ni emisión. Tampoco scanner,
emails o WhatsApp. Fase 2 agrega reservas transaccionales e inventario derivado;
la transición interna a paid no acredita un pago ni ejecuta efectos externos.

## Integridad

- UUID aleatorios; helpers ORD/TKT con 128 bits aleatorios, constraint UNIQUE.
  Las reservas SQL generan su código ORD desde UUIDv4 (122 bits aleatorios).
  Futuros escritores reintentarían una colisión única; el test de 10.000 códigos
  por clase comprueba regresiones, no demuestra matemáticamente ausencia de colisiones.
- FK compuestas evitan referencias cruzadas entre tenants y eventos, incluso
  para escritores confiables que omiten RLS. Columnas redundantes `event_id` y
  `currency` en items permiten validar esos límites en PostgreSQL.
- Dinero en minor units, sin floats, intervalo 0..9.007.199.254.740.991.
  `quantity` integer >0. El formato de moneda es `[A-Z]{3}`; no es un catálogo
  ISO completo. Conversión decimal por moneda y soporte comercial se definirán
  antes de checkout. En Fase 1 `total = subtotal`, sin descuentos/impuestos/cargos.
- Totales igual a SUM(items) mediante constraint triggers diferidos. Insertar
  items y actualizar total en una transacción. Salir de draft congela snapshots.
  El trigger de items bloquea la orden para serializar cambios concurrentes.
  Transiciones terminales no vuelven a abrir órdenes; reembolso parcial no está modelado.
- Capacidad válida >=0; consumo derivado de órdenes y bloqueos por evento en
  READ COMMITTED. Los cambios de capacidad no pueden quedar debajo del consumo.
  Véase [inventario](inventory.md) para la estrategia y sus límites de verificación.
- Zonas IANA verificadas, fechas `timestamptz`, orden cronológico y ventanas válidas.
- UNIQUE(ticket_id) en check-ins prepara un único ingreso exitoso. Los intentos
  fallidos futuros irán a auditoría, no consumirán ese registro único.
- Audit Logs append-only incluso frente a update/delete/truncate administrativo
  ordinario. Un superusuario siempre puede alterar el esquema: no se promete
  protección contra operadores de infraestructura.

## Límite de autorización

Helpers `private.has_org_role` con SECURITY DEFINER, `search_path=''`, nombres
calificados y EXECUTE restringido. El schema private no está expuesto por API.
Consulta memberships actuales con `auth.uid()`, evita políticas recursivas y
no confía en claims de roles editables. Grants y RLS son capas complementarias.
Toda selección de tenant recibida del cliente se considera entrada no confiable.

Owner administra catálogo, clientes, miembros y configuración dentro del tenant;
manager opera catálogo/clientes y lee registros financieros; door queda cerrado
hasta una RPC mínima futura. Perfil solo propio. Ningún cliente autenticado puede
insertar auditoría o escribir estado financiero directamente. La aplicación
autentica y comprueba membership antes de los comandos server-only de reserva y
cancelación. Las RPCs de escritura solo son ejecutables con service_role;
confirmación y expiración están en un módulo interno separado. No hay endpoints
de escritura implementados todavía. La proyección pública de disponibilidad es
una RPC con campos limitados, sin grants de lectura sobre tablas privadas.

La identidad y tenant de registros son inmutables. No hay borrados en cascada de
datos operacionales/históricos. El último owner no puede ser removido o degradado;
bootstrap/provisión y recuperación quedan como operaciones administrativas.

## Tokens y privacidad

`randomBytes(32)` → base64url (43 caracteres); DB guarda SHA-256 hexadecimal de
64 caracteres con unicidad. Comparación constante de hashes. La alta entropía
permite SHA-256 sin almacenamiento reversible; no son contraseñas humanas.
Reenvío futuro debe rotar/inutilizar el token anterior: el original no se recupera
de la DB. Código público y UUID jamás sustituyen autenticación ni token secreto.
Helpers criptográficos usan Node y están en un subpath separado para no importar
accidentalmente Node en código de navegador.

Metadata allowlist: source, reason_code, correlation_id, demo; máximo 2048 bytes,
valores string/bool limitados. Nunca almacenar tarjetas, CVV, PAN ni respuestas
completas de proveedor. No se ha creado un logger con datos personales.

## Límites y siguiente revisión

Antes de implementar ventas: confirmar ubicación, timezone, horario, moneda,
precios, capacidades; ejecutar las pruebas concurrentes preparadas en PostgreSQL local,
conservar/reutilizar la idempotency_key en la futura experiencia de compra; RPC autorizadas
para emisión limitada por quantity y check-in atómico (lock/update condicional,
audit en la misma transacción); validar transiciones de pagos/tickets y callbacks;
implementar Auth/refresh y tests HTTP/E2E. No hay emisión ni sincronización de
check-in/estado hasta implementar esas operaciones. El inventario tiene protección
transaccional SQL; su prueba con conexiones reales permanece pendiente si el
entorno solo dispone de PGlite.

PGlite ejecuta PostgreSQL real pero no todo Supabase: el límite Auth se configura
en fixtures y no se prueba PostgREST, GoTrue, sesiones reales ni concurrencia entre
conexiones. La misma suite SQL está disponible contra Supabase local. No equivale
a afirmar que se validó el despliegue Supabase sin Docker.

Fase 2B incorpora deduplicación persistida en tabla privada: hash SHA-256 de la
clave, hash del contexto normalizado y order_id único. No hay cuentas ni permisos
públicos sobre órdenes. Acceso futuro de compradores mediante capacidades
temporales por orden/magic link, separadas de idempotencia y del token de ingreso.
Véase [hardening](inventory-hardening.md).
