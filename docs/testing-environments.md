# Testing environments

Tests are separated by data-safety boundary:

- Unit/pure tests (`tests/unit`) do not require a database.
- Embedded/isolated database tests (`tests/database` without a remote opt-in) use a fresh PGlite instance and may create transactional fixtures.
- Remote safe smoke checks are read-only or operate only on explicitly namespaced QA data.
- Destructive integration, RLS/Auth, inventory and concurrency suites require a dedicated test database. They refuse to run when `TEST_DATABASE_URL` is present unless `ALLOW_DESTRUCTIVE_REMOTE_TESTS=1` is set by an operator who has verified the target is isolated.

The commercial Fest-On Supabase project is not an integration-test database. Do not run destructive fixtures, global updates/deletes, truncates or empty-database assertions against it. Use a dedicated Supabase project, local PostgreSQL/Docker, or an ephemeral CI database before enabling the destructive suites.

The current product smoke evidence remains: public availability, selection of 1 HOMBRE + 2 MUJERES, `$540 MXN`, checkout, `pending_payment`, countdown, and E.164 phone normalization. Rate limiting distributed for `/api/reserve` remains a production blocker.
