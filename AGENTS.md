# AGENTS.md - YPass

Index for agents. Read this first, then open only the files listed for your task.

## What this is

YPass is a production-grade Node.js 22+ ESM hall-pass application built with Express 5 and EJS. It provides local, Formbar, and optional Microsoft Entra authentication; SQLite/PostgreSQL persistence; server-side sessions; Socket.IO realtime support; manager workflows; appointments; and a separately deployed kiosk machine client.

The application is layered deliberately:

- Routes bind URLs and middleware.
- Controllers translate HTTP requests into service calls and responses.
- Services own use cases and business rules.
- Repositories own Knex queries only.
- Integrations talk to Formbar, Entra, Redis, or SMTP.
- `src/container.js` constructs enabled dependencies.
- `kioskMachine/` is a thin local kiosk UI and proxy. The central server remains authoritative for kiosk identity, pass decisions, and state transitions.

Disabled features must not register routes, sockets, jobs, or external connections.

## Agent operating rules

- Read this file first, then open only the files needed for the specific task.
- Prefer the smallest possible fix and keep edits tightly scoped to the relevant module.
- For any behavior change, add or update the closest failing Vitest test before implementing the fix.
- Keep routes and controllers thin; business rules belong in services and repositories.
- Treat `src/container.js` and the feature flags as the source of truth for enabled integrations and startup wiring.
- Do not introduce a second browser auth mechanism, a client-trusted roles model, or raw `process.env` reads in business logic.
- Production-only safeguards remain mandatory: no SQLite in multi-worker deployment, no clustered realtime/jobs without Redis, and no feature activation based on env-var presence alone.

## Run

| Command                    | Purpose                           |
| -------------------------- | --------------------------------- |
| `npm run dev`              | Start the watch-mode server       |
| `npm start`                | Start the production-style server |
| `npm test`                 | Run all Vitest suites             |
| `npm run test:unit`        | Run unit tests                    |
| `npm run test:integration` | Run integration tests             |
| `npm run test:e2e`         | Run HTTP end-to-end tests         |
| `npm run test:security`    | Run security-focused tests        |
| `npm run lint`             | Run ESLint                        |
| `npm run format:check`     | Check Prettier formatting         |
| `npm run audit`            | Audit production dependencies     |
| `npm run loadtest`         | Run the localhost-only load CLI   |

Local setup: copy `.env.example` to `.env`, disable integrations you do not have credentials for, run `npm install`, then `npm run db:init`. For the simplest local run use local auth, SQLite, one worker, and disabled Formbar/Entra/email. Do not commit `.env`, secrets, `kiosk-config.json`, logs, or runtime database files under `data/`.

## Layout (start here)

```
src/server.js                 Config validation and process entrypoint
src/bootstrap.js              HTTP listen, health checks, realtime/jobs startup, shutdown
src/app.js                    Express middleware stack and route registration
src/container.js              Composition root; constructs enabled dependencies
src/config/                   Environment parsing, typed config, feature flags
src/routes/                   URL and middleware binding only
src/controllers/              HTTP request/response adapters
src/services/                 Application use cases and business rules
src/repositories/             Knex persistence queries
src/models/                   Domain model helpers
src/auth/                     Password and token authentication primitives
src/authorization/            RBAC and Formbar permission mapping
src/middleware/               Sessions, CSRF, auth, validation, errors, readiness
src/integrations/             Formbar, Entra, email, Redis clients
src/realtime/                 This application's Socket.IO server
src/services/sis/             SIS provider contracts, adapters, normalization, and synchronization
src/database/                 Knex setup, sql.js adapter, migrations, seeds
src/validators/                Zod request/event schemas
src/errors/                   Typed application errors and error mapping
src/logging/                  Pino, audit, redaction, file, and Seq logging
views/                        EJS pages, emails, layouts, and partials
public/                       Browser JavaScript and CSS
scripts/                      Database and operational CLIs
tests/unit/                   Isolated unit tests
tests/integration/            Database and integration tests
tests/e2e/                    Real app HTTP tests
tests/security/               CSRF, identity linking, and authorization tests
tools/loadtest/               CLI load-test harness; not an HTTP route
wiki/                         Operator and developer documentation
docs/openapi/v1.yaml          API contract documentation
deploy/                       Nginx, Docker, and Ubuntu/PM2 deployment files
kioskMachine/                 Separate kiosk UI, local proxy, and kiosk-client tests
```

## Task router

| If you need to… | Open first | Then usually |
| --- | --- | --- |
| Change an environment variable or feature flag | `src/config/env.js`, `src/config/features.js` | `.env.example`, `wiki/system/feature-flags.md`, config tests |
| Change startup, shutdown, health, or dependency wiring | `src/server.js`, `src/bootstrap.js`, `src/container.js` | `src/app.js`, `src/realtime/`, `src/jobs/`, ops tests |
| Add or change an HTTP endpoint | `src/routes/` | Matching controller, service, validator, tests, and `docs/openapi/v1.yaml` |
| Change HTML pages or form behavior | Matching `src/routes/` and controller | `views/`, `public/`, CSRF/auth middleware, e2e tests |
| Change the teacher panel or its location-scoped data | `src/routes/web.js`, `src/controllers/web-controller.js` | `src/services/pass-service.js`, `src/repositories/index.js`, `views/pages/teacher.ejs`, `tests/unit/pass-staff.test.js`; teacher pass visibility and actions are scoped to the assigned origin location |
| Change API behavior | `src/routes/api.v1.js` | `src/controllers/api-controller.js`, validator, OpenAPI, e2e tests |
| Change login, registration, password, or session behavior | `src/services/local-auth-service.js`, `src/auth/` | `src/controllers/auth-controller.js`, `src/routes/auth.js`, `src/middleware/session.js`, security tests |
| Change Formbar OAuth or account linking | `src/integrations/formbar/`, `src/services/user-service.js` | `src/controllers/auth-controller.js`, `src/routes/account.js`, `tests/security/linking.test.js`, Formbar tests |
| Change Entra authentication | `src/integrations/entra/` | Auth controller/routes, config dependencies, auth tests |
| Change roles or permissions | `src/authorization/rbac.js`, `src/repositories/index.js` | Auth middleware, service checks, seed permissions, security tests |
| Change passwords or token security | `src/auth/password.js`, `src/auth/tokens.js` | Local auth service, redaction/audit logging, security tests |
| Change database schema | `src/database/migrations/` | Repository queries, seeds, integration tests, `npm run db:status` |
| Change database connection/provider behavior | `src/database/`, `knexfile.js` | `scripts/db-*.js`, config tests, database integration tests |
| Change realtime behavior | `src/realtime/index.js` | `src/bootstrap.js`, session/config dependencies, Formbar WS only if external |
| Change email delivery | `src/integrations/email/` | Local auth service, feature flags, email views, tests |
| Change SIS integration | `src/services/sis/`, `src/repositories/index.js` | `src/database/migrations/014_sis_integration.js`, `src/routes/api.v1.js`, provider unit tests, SIS integration/e2e tests, `wiki/system/sis-integration.md` |
| Change Redis, rate limits, or distributed sessions | `src/integrations/redis.js`, `src/middleware/rate-limit.js`, `src/middleware/session.js` | `src/config/features.js`, deployment docs, ops tests |
| Change request validation | `src/validators/` | Controller, route, error mapping, focused tests |
| Change error responses | `src/errors/`, `src/middleware/error.js` | Controllers, HTML error views, API/e2e tests |
| Change logging or audit events | `src/logging/` | Services/controllers, redaction tests, deployment config |
| Change deployment or process management | `Dockerfile`, `docker-compose*.yml`, `deploy/`, `ecosystem.config.cjs` | `README.md`, `deploy/ubuntu/setup.md`, health endpoints |
| Change kiosk enrollment, credentials, or kiosk transport | `src/services/kiosk-service.js`, `src/routes/api.v1.js` | `src/controllers/api-controller.js`, `src/routes/web.js`, `kioskMachine/`, kiosk e2e/unit tests |
| Change documentation or operator guidance | `wiki/` | Keep `README.md`, OpenAPI, and affected source behavior consistent |

## Request and startup flow

A normal HTTP request follows:

1. `src/server.js` loads and validates environment configuration.
2. `src/bootstrap.js` creates the container, checks dependencies, creates the app/server, and starts optional realtime/jobs.
3. `src/app.js` applies request IDs, logging, security headers, compression, parsing, cookies, sessions, CSRF, rate limits, and current-user loading.
4. `src/routes/` selects middleware and a controller.
5. The controller calls a service; services call repositories or integrations.
6. Typed errors reach `src/middleware/error.js`, which chooses HTML or JSON output.

Keep business rules out of route files and keep `req`/`res` out of services and repositories. Use the container's typed `config`; do not read `process.env` throughout the application.

## Security invariants

- Sessions are server-side; do not introduce a second browser auth mechanism or put roles in client-controlled data.
- Mutating browser forms/API requests require CSRF protection as configured by `src/middleware/csrf.js`.
- Authorization is server-side. Client-supplied user IDs, roles, permissions, or manager status are not trusted.
- Passwords use the existing Argon2id implementation. Tokens and sensitive values must follow existing redaction/audit patterns.
- Feature flags are explicit. Do not infer that an integration is enabled because an environment variable happens to exist.
- Production guards in `src/config/features.js` are intentional. SQLite cannot be used with multiple workers; clustered Socket.IO/background jobs require Redis.
- Never log secrets, access tokens, passwords, session IDs, or raw credential payloads.

## Database and environment rules

- SQLite uses the sql.js adapter for local development and tests; PostgreSQL uses `pg` in production.
- Schema changes belong in migrations, not startup code. Use `npm run db:migrate` as a one-shot migration step for production; do not auto-migrate every worker.
- Seeds establish roles and permissions and should remain safe to run through the existing seed command.
- `.env` is local secret/config state. Use `.env.example` and `wiki/system/` as the documented configuration surface.

## Tests and verification

Use the narrowest relevant suite first, then widen as needed:

- Config/feature changes: `npm run test:unit -- tests/unit/config.test.js`
- Auth/RBAC/password changes: `npm run test:unit` plus relevant `tests/security/`
- Database changes: `npm run test:integration`
- HTTP/controller/view changes: `npm run test:e2e`
- Realtime changes: `npm run test:unit -- tests/unit/formbar-ws.test.js` and affected e2e/integration coverage
- Broad changes: `npm test && npm run lint`

Tests use Vitest and temporary SQLite databases through `tests/helpers/`. External systems should be mocked. For browser-facing or networking changes, smoke `/health/live` and `/health/ready` and run the affected server mode when practical.

## After you add a feature or change behavior

1. Update the owning source of truth (`config`, service, repository, integration, or migration).
2. Thread the change through the nearest controller/route or client/view surface.
3. Preserve feature-flag dependency and production guard rules.
4. Add or update the narrowest relevant Vitest coverage.
5. Update `docs/openapi/v1.yaml`, `wiki/`, or `.env.example` when the public contract or setup changes.
6. Run focused tests, then `npm run lint` and broader tests when the change warrants it.
7. Update this index if you add a major module, command, route family, or ownership boundary.
8. Alter AGENTS.md to be up to date with any made changes

## Hall-pass and kiosk ownership

- `src/services/pass-service.js` is the authoritative pass state machine. It enforces student identity, one active pass, destination-aware scans, round-trip transitions, appointment auto-approval, server-clock expiry, a six-student bathroom capacity, and a two-student-per-origin-classroom bathroom capacity.
- Teacher dashboards and pass actions are authorized by the assigned teacher of the pass's origin location; destination-location assignment does not grant pass access.
- Pending pass requests and auto-started appointment passes notify the assigned origin teacher through the server-side Socket.IO room `teacher:<userId>` after the database transaction commits; the teacher page may subscribe only when Socket.IO is enabled.
- `src/repositories/index.js` owns hall-pass, appointment, location, kiosk, event, and heartbeat queries. The partial unique index `passes_one_active_per_student` is the database concurrency guard.
- Locations have a persisted `default_location` flag managed by the manager panel; kiosk options expose it so default destinations are immediately selectable while all active destinations remain searchable.
- Migrations `002_pass_system.js` through `017_nullable_manager_references.js` define students, locations, kiosks, passes, events, appointments, kiosk credential hashes, heartbeats, appointment usage, the returning-state concurrency guard, persisted default locations, and nullable manager-deletion references.
- `src/database/seeds/002_pass_system.js` creates the standard and sample hall-pass locations with their demo kiosks; rerun `npm run db:seed` to apply seed additions safely.
- `/api/v1/kiosks/enroll` accepts a short-lived manager-generated enrollment code and returns the kiosk code plus one secret. Enrollment codes expire after 10 minutes and can be used once.
- `/api/v1/kiosks/options`, `/heartbeat`, `/scan`, and `/request-pass` are authenticated with `x-kiosk-code` and `x-kiosk-secret`. Only the hash is persisted centrally; the secret is returned once during enrollment.
- The manager panel at `/manager` creates enrollment codes and regenerates credentials. Credential regeneration disables the kiosk until the new code is used.
- Manager kiosk/location deletion preserves referencing records, clears the deleted IDs and bathroom assignments, and cancels open passes and scheduled appointments that lose required context. Kiosks unassigned by location deletion are deactivated until reassigned.
- `kioskMachine/` stores the issued secret in local `kiosk-config.json` with restrictive file permissions. It must never send that secret to browser JavaScript or expose it in logs.
- The kiosk UI may collect student details and destination selections, but it must display central responses and must not implement pass approval, completion, expiration, or state transitions.

Focused hall-pass verification: `npx vitest run tests/unit/pass-staff.test.js tests/e2e/kiosk.test.js tests/e2e/kiosk-enrollment.test.js` and `npm --prefix kioskMachine test`.

Focused SIS verification: `npx vitest run tests/unit/sis-normalizer.test.js tests/unit/sis-provider.test.js tests/unit/oneroster-provider.test.js tests/unit/sis-service.test.js tests/unit/sis-sync.test.js tests/integration/sis.test.js tests/e2e/sis.test.js`.
