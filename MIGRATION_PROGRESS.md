# Migration Progress

- Phase 4.1.2C-3D-1: Complete
  - whatsapp-web.js adapter scaffold created (config only, no launch).
  - Server boot and /health verified.
- Phase 4.1.2C-3D-2: Complete
  - SessionLifecycleService implements start / stop / logout / force-kill / delete / QR / pairing
    against the real engine adapters and the shared EngineRegistry.
  - Authenticated session router mounts CRUD + lifecycle at /sessions.
  - WebSocket join authorization now uses the Express AuthService (previously imported the NestJS
    service, which has no `authorizeSession`, so every join threw).
  - Removed the unauthenticated C-3D-1 scaffold routes (/sessions/baileys/:id/connect|status).
  - Lifecycle, router and engine-provider specs added (36 + 18 + 9 tests).
  - allowedSessions scoping enforced on session lists and every /:id route (403 outside scope).
  - Verification: PHASE_4_1_2C_3D_2_LIFECYCLE_VERIFICATION.md
- Remaining:
  - Ownership leases / multi-node forwarding, automatic reconnect orchestration, audit logging and
    webhooks (later phases).
  - Real-device lifecycle verification (start → QR/pairing → ready → logout/force-kill).
  - Windows-only failure in session-auth-dir-migration.service.spec.js (symlink creation EPERM,
    pre-existing and unrelated to the lifecycle work).
