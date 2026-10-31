# Migration Progress

- Phase 4.1.2C-3D-1: Complete
  - whatsapp-web.js adapter scaffold created (config only, no launch).
  - Server boot and /health verified.
- Phase 4.1.2C-3D-2: Complete
  - SessionLifecycleService implements start / stop / logout / force-kill / delete / QR / pairing
    against the real engine adapters and the shared EngineRegistry.
  - Authenticated session router mounts CRUD + lifecycle at /sessions (re-mounted under /api in Phase 4.2).
  - WebSocket join authorization now uses the Express AuthService (previously imported the NestJS
    service, which has no `authorizeSession`, so every join threw).
  - Removed the unauthenticated C-3D-1 scaffold routes (/sessions/baileys/:id/connect|status).
  - Lifecycle, router and engine-provider specs added (36 + 18 + 9 tests).
  - allowedSessions scoping enforced on session lists and every /:id route (403 outside scope).
  - Verification: PHASE_4_1_2C_3D_2_LIFECYCLE_VERIFICATION.md
- Phase 4.2: Complete
  - Express API mounted under `/api` (`/api/health`, `/api/health/live`, `/api/health/ready`,
    `/api/sessions...`); `/health` kept as a public alias; no `/api/api` duplication.
  - Express port now `EXPRESS_PORT` (explicit) or default `2785`, with a fail-fast preflight that
    refuses an occupied port without terminating the existing NestJS listener.
  - Health parity implemented: public liveness + version-only-for-valid-key + DB-backed readiness
    (503 when the datasource is down or the probe times out).
  - Vite proxy target is now `VITE_API_PROXY_TARGET` with the existing NestJS `2785` default.
  - Added `start:express` / `start:express:dev`; `start`, `start:prod`, `prod` still run Nest.
  - Verification: 25 new focused tests + existing 63 targeted tests green (88 combined);
    PHASE_4_2_COMPATIBILITY_REPORT.md.
- Remaining:
  - Ownership leases / multi-node forwarding, automatic reconnect orchestration, audit logging and
    webhooks (later phases).
  - Real-device lifecycle verification (start → QR/pairing → ready → logout/force-kill).
  - Windows-only failure in session-auth-dir-migration.service.spec.js (symlink creation EPERM,
    pre-existing and unrelated to the lifecycle work).
  - Phase 4.2 limitation: Express still runs one datasource (data DB), while `api_keys` lives in the
    main DB, so API-key validation against the Express runtime returns 500 when a key is presented.
    This blocks real end-to-end session CRUD until the data layer is migrated (Phase 5+).
  - Readiness `details` reports only `dataDatabase`; draining (shutdown → 503) is not implemented in
    Express yet.
