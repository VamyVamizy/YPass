[Download Kiosk Machine](https://github.com/csmith1188/YPass/raw/refs/heads/main/kioskMachine.zip)


# YPass

YPass is a server-side hall-pass system for students, teachers, managers, and physical kiosk machines. It manages students, destinations, appointments, pass state transitions, kiosk heartbeats, and audit events in one central application.

The main application is an Express 5 + EJS Node.js service. A separate project in [`kioskMachine/`](kioskMachine/) runs on each physical kiosk and proxies browser actions to the central API.

## Requirements

- Node.js 22 or newer for the central server
- A browser for the web application
- SQLite for local development, or PostgreSQL for production
- Redis only when sharing sessions/rate limits across workers, scaling Socket.IO, or running background jobs

SQLite uses sql.js, so local development does not require native SQLite build tools.

## Local setup

For a minimal local installation, use local authentication and SQLite:

```bash
Copy-Item .env.example .env
npm install
npm run db:init
npm run dev
```

Before starting, edit `.env` and set `FORMBAR_AUTH_ENABLED=false`, `ENTRA_AUTH_ENABLED=false`, and `EMAIL_ENABLED=false` unless those integrations are configured. Keep `WEB_CONCURRENCY=1` with SQLite. On macOS/Linux, replace `Copy-Item .env.example .env` with `cp .env.example .env`.

Open <http://localhost:3000>. Health probes are available at `/health/live` and `/health/ready`.

## Core workflows

- Students request and use passes through the web kiosk or a physical kiosk.
- Teachers approve, deny, and complete passes and can create appointments.
- Managers maintain students and destinations, inspect pass history, and manage kiosks.
- Managers create a one-time enrollment code at `/manager`. A kiosk enters that code during first setup; it receives a kiosk code and secret from the server.
- Kiosk requests use `x-kiosk-code` and `x-kiosk-secret`. The central server hashes the secret and owns all pass validation and transitions.

Kiosk enrollment codes expire after 10 minutes and are single-use. Regenerating a kiosk credential disables the kiosk until its replacement enrollment code is used.

## Configuration

Configuration is loaded from `.env`, parsed and validated at startup, and controlled by explicit feature flags. Start with `.env.example`; the most important settings are:

| Setting                | Purpose                                              |
| ---------------------- | ---------------------------------------------------- |
| `LOCAL_AUTH_ENABLED`   | Enable local registration and password login         |
| `FORMBAR_AUTH_ENABLED` | Enable Formbar OAuth                                 |
| `ENTRA_AUTH_ENABLED`   | Enable Microsoft Entra login                         |
| `DATABASE_PROVIDER`    | `sqlite` locally or `postgres` in production         |
| `API_ENABLED`          | Enable `/api/v1` and kiosk transport                 |
| `SIS_ENABLED`          | Enable SIS adapters, management API, and manager UI  |
| `SOCKET_IO_ENABLED`    | Enable realtime updates                              |
| `REDIS_ENABLED`        | Enable Redis-backed shared state and scaling support |
| `MANAGERS`             | Comma-separated manager email addresses              |

Feature dependencies and production restrictions are documented in [`wiki/system/feature-flags.md`](wiki/system/feature-flags.md). Never commit `.env`, credentials, logs, `kiosk-config.json`, or runtime files under `data/`.

SIS setup, OneRoster configuration, synchronization behavior, and provider development are documented in [`wiki/system/sis-integration.md`](wiki/system/sis-integration.md).

## Commands

| Command                                                              | Purpose                                                  |
| -------------------------------------------------------------------- | -------------------------------------------------------- |
| `npm run dev` / `npm start`                                          | Development watch mode / production-style single process |
| `npm run db:init`                                                    | Run migrations and seeds                                 |
| `npm run db:migrate` / `db:rollback` / `db:seed` / `db:status`       | Manage database schema and seed data                     |
| `npm test`                                                           | Run all Vitest suites                                    |
| `npm run test:unit`, `test:integration`, `test:e2e`, `test:security` | Run focused suites                                       |
| `npm run lint` / `npm run format:check` / `npm run audit`            | Quality and dependency checks                            |
| `npm run docker:up` / `docker:down` / `docker:logs`                  | Run the Compose deployment                               |
| `npm run pm2:start` / `npm run pm2:reload`                           | Start or reload the Ubuntu PM2 deployment                |
| `npm run loadtest`                                                   | Run the localhost-only load-test CLI                     |

## Kiosk machine

See [`kioskMachine/README.md`](kioskMachine/README.md) for installation and enrollment. The central server must be running with `API_ENABLED=true` before a kiosk can enroll or submit events.

## Documentation

- [`AGENTS.md`](AGENTS.md): architecture, ownership boundaries, and engineering rules
- [`wiki/`](wiki/): operator and developer documentation
- [`docs/openapi/v1.yaml`](docs/openapi/v1.yaml): API contract
- [`deploy/ubuntu/setup.md`](deploy/ubuntu/setup.md): Ubuntu, Nginx, PM2, PostgreSQL, and Redis deployment notes
