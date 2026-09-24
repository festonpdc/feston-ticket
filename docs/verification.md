# Verificación de Fase 1 · 2026-09-23

Entorno: Windows, Node 24.14.1, pnpm 12.5.1, Next.js 16.3.6.

| Comando / prueba | Resultado |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm db:types` | PASS: las 3 migraciones aplicadas en PostgreSQL embebido; tipos generados |
| `pnpm typecheck` | PASS: paquetes, aplicación y tests |
| `pnpm lint` | PASS: cero warnings |
| `pnpm test` | PASS: 39 tests; 1 marcador Supabase local skipped |
| `pnpm build` | PASS: producción Next.js 16; home y 404 dinámicos |
| `pnpm test:http` con servidor de producción | PASS: 200/404, todos los scripts con nonce, nonces distintos por respuesta, CSP y headers |
| `pnpm audit --prod` | Sin vulnerabilidades conocidas reportadas |
| `pnpm exec supabase --version` | 2.117.0, CLI disponible |
| `git status --short` | Archivos nuevos sin seguimiento, repositorio inicializado sin commits |

Vitest cubre dinero exacto, cantidades inválidas, overflow, monedas mixtas,
estados y transiciones; 20.000 códigos públicos sin colisiones en la muestra,
tokens de 256 bits/hash/validación y autorización conceptual por organización.

En PostgreSQL: aplicación de migraciones; RLS en 13 tablas; owner A sin lectura
de B; manager A sin escritura sobre B; door sin finanzas/PII/tokens; anon sin
acceso; no-miembro sin datos; perfiles propios; prohibición de autoescalado y
tenant reassignment; último owner; constraints monetarios, cantidades, FK
multi-tenant/multi-evento/moneda; snapshots; totales; slugs/fechas/timezones;
unicidad de códigos/hash; auditoría append-only; metadata restringida; check-in
único y actor del tenant; seed idempotente en draft.

## No ejecutado

- Supabase local completo: Docker y servidor PostgreSQL local no disponibles.
  La suite SQL parametrizada está preparada; ver README para arrancar Supabase,
  aplicar migraciones y definir `TEST_DATABASE_URL`. El PASS de PGlite **no**
  representa una ejecución de GoTrue/PostgREST ni prueba JWT/HTTP real.
- Playwright E2E: configuración preparada, sin specs de producto en esta fase.
- Concurrencia entre conexiones reales, inventario, pagos, emisión y scanner:
  todavía no están implementados y no se afirman garantías sobre esos flujos.

El seed se verificó dentro de una DB embebida desechable. No se ejecutó contra
una DB Supabase externa/local persistente. No hay despliegue, integración de
pagos ni credenciales reales incluidas. El servidor usado para smoke se cerró.

## Revisión previa al commit inicial

Se repitieron `pnpm test` (39 aprobados, 1 skipped por Supabase local),
`pnpm typecheck`, `pnpm lint` y `pnpm build`: todos aprobados.
Se revisaron los 51 archivos candidatos al commit, sin secretos detectados
ni archivos `.env` reales. `.env.example` contiene solo variables vacías.
Se comprobaron 17 rutas de exclusión y se amplió `.gitignore` para cubrir
tipos generados de Next, caches, temporales, logs y archivos de claves.
Los artefactos locales de instalación, compilación y tests quedan excluidos.
