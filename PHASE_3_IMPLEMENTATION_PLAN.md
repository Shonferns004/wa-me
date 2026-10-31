# Phase 3 Implementation Plan

## Scope
Build Express foundation only. No module migration yet.

## Exact Order
1. Create backend/src/app.js, server.js skeleton.
2. Config module (dotenv + validation).
3. Database layer (TypeORM DataSource init, migrations runner guarded).
4. Auth middleware (API key, roles).
5. Common middleware (helmet, cors, rate limit, body parser, error handler, logging).
6. Health endpoint.
7. Socket.IO attach (empty handlers placeholder).
8. Graceful shutdown hooks.

## Files/Modules Affected
- backend/src/app.js (new)
- backend/src/server.js (new)
- backend/src/config/* (port from Nest)
- backend/src/database/* (adapt)
- backend/src/middleware/* (new)
- backend/src/common/services/logger (adapt)

## Dependencies
Config -> Database -> Auth -> Middleware -> Health -> Socket attach -> Shutdown.

## Acceptance Criteria
- Server boots on documented port.
- /health returns 200.
- DB connects (SQLite & PG) without migration changes.
- API key guard rejects unauthenticated requests.
- Graceful shutdown closes DB/Redis cleanly.
- No NestJS runtime invoked.

## Testing
- Unit tests for config validation, auth middleware, error handler.
- Integration smoke: boot + health + DB connect.

## Rollback
- Keep Nest backend untouched; Express runs on separate port during dev.
- No DB changes in Phase 3.
