# Fase 2C — verificación remota

La conexión PostgreSQL configurada en `TEST_DATABASE_URL` fue verificada con `SELECT 1` sin exponer credenciales.

## Estado

- Migraciones remotas aplicadas: 001–006.
- No se creó una migración 007+: no apareció un bug de producto durante las pruebas.
- RLS/Auth remoto: aprobado mediante la suite de `database.test.ts` (38 casos, incluyendo embedded y Supabase).
- Hardening remoto: 46/46 casos aprobados.
- Concurrencia remota: 4 escenarios aprobados en conexiones PostgreSQL separadas (`inventory-concurrency.test.ts`, ~14.9 s).
- Limpieza: los fixtures de concurrencia se eliminan en cada escenario; las demás suites usan transacciones con rollback. No se dejaron fixtures QA persistentes.

## Concurrencia observada

- Capacidad por tipo: 2 éxitos y 13 rechazos de 15; nunca hubo disponibilidad negativa.
- Capacidad global: 2 éxitos y 13 rechazos de 15.
- Multi-item en orden inverso: sin deadlock ni overselling; rollback completo ante fallo.
- Misma clave idempotente: una orden/reserva lógica y consumo único; payload distinto devuelve `PT409`.

## Confirmación y expiración

Las pruebas remotas validan `ACTIVE → EXPIRED`, recuperación idempotente de inventario y `pending_payment → paid`; una orden pagada continúa consumiendo capacidad aunque venza `reserved_until`. No se emiten tickets.

## Verificación local final

`pnpm test`: 114 aprobados, 7 omitidos (121 totales). `typecheck`, `lint` y `build` aprobados.

No se hizo commit, push ni deploy.
