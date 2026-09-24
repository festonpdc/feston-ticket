# Verificación · Fase 2 · 2026-09-23

Informe histórico anterior al hardening 2B. Los resultados y pendientes actuales
están en [inventory-hardening.md](inventory-hardening.md).

Base aprobada: `92cf0c4fdc1a497fbacb776b232b525763d107f1`.
Las migraciones 202609230001, 002 y 003 y los 39 tests originales se conservan
sin cambios. Nuevas migraciones: 004 inventory_events y 005 inventory_engine.

| Verificación | Resultado |
| --- | --- |
| `pnpm db:types` | PASS: migraciones completas en PostgreSQL embebido, tipos de tablas y RPCs regenerados |
| `pnpm test` | 83 aprobados: 39 originales + 44 nuevos; 4 skipped |
| `pnpm typecheck` | PASS: paquetes, aplicación, tests y configuración |
| `pnpm lint` | PASS: cero warnings |
| `pnpm build` | PASS: producción Next.js 16.3.6 |

Los 44 nuevos tests son 33 SQL y 11 unitarios/autorización. Incluyen los casos
A–E, ventas fuera de ventana, tipos inactivos, cantidad/suma sobre el límite,
overflow, monedas mixtas, rollback de reservas multi-tipo, stock de evento,
inmutabilidad de precios, expiración por lotes/idempotencia, cancelación,
confirmación sin pagos/tickets, grants de RPCs, proyección anónima sin PII,
restricción del cliente service_role, modelo de cortesías y secuencias de estados.
Las pruebas de autorización usan dobles de cliente solo para comprobar la capa
TypeScript; las pruebas SQL sí ejecutan constraints, triggers, grants y RLS reales.

## No ejecutado

Los 4 skipped corresponden a dos marcadores de suites Supabase local (Fase 1 y
Fase 2) y **dos escenarios concurrentes reales**:

1. Tipo con capacidad 2, 15 conexiones: preparado para exigir 2 reservas y 13 rechazos.
2. Evento con capacidad 2 compartida entre tipos, 15 conexiones: misma exigencia.

**Resultado real de concurrencia: NO EJECUTADO.** No hay Docker/PostgreSQL local
disponible ni TEST_DATABASE_URL configurada. PGlite no se usa para fingir 15
conexiones ni cobertura de locks entre backends. La prueba preparada verifica
15 PIDs distintos y que todos esperan un lock real antes de liberar la carrera.
Instrucciones completas y limpieza de la DB temporal en `docs/inventory.md`.

No se ejecutaron sesiones GoTrue/PostgREST ni nuevos E2E de navegador. No hay
checkout, proveedor, webhook, cron externo, emisión, QR, scanner ni UI nueva.
No se realizó deploy, conexión remota ni commit de Fase 2.

## Límites de revisión

La protección está implementada transaccionalmente; falta demostrar su ejecución
concurrente en el servidor local real antes de habilitar ventas. El lock por
evento prioriza integridad y sencillez; medir throughput con carga real. El
reserve no tiene todavía idempotency key para reintentos HTTP con commit incierto.
La futura compra pública necesita su frontera de autorización/anti-abuso; solo
se entregan comandos internos y de staff. Confirmación es dominio, no evidencia
de pago. Refunded conserva inventario y cortesías solo tienen modelo preparatorio.
