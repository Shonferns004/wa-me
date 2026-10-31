# Phase 4.1.2 Session & Authentication Model Migration Plan

## 1. Original architecture (NestJS)
- Entities: Session (sessions), ApiKey (api_keys), plus audit, message, template, etc.
- API-key auth with allowedSessions (simple-array; empty/null = unrestricted).
- Session CRUD and lifecycle managed by SessionService.
- Baileys auth state stored per session directory.
- whatsapp-web.js Puppeteer profiles per session.

## 2. Current Express architecture
- Express foundation + Socket.IO.
- BaileysConnection adapter (basic).
- Auth/authorization extracted (allowedSessions).
- Entities loaded via glob.
- No session CRUD endpoints yet.
- No connection registry.

## 3. Entity inventory
- Session (sessions) - migrated entity definition, loaded.
- ApiKey (api_keys) - migrated entity definition, loaded.
- Others loaded via glob.

## 4. Endpoint inventory
- Missing: session CRUD, status, connect/disconnect, pairing.
- Existing: /health, /sessions/baileys/:id/connect, /sessions/baileys/:id/status.

## 5. Authentication comparison
- Nest: DB-backed API keys, allowedSessions, roles.
- Express: DB-backed API keys, allowedSessions, no roles yet.

## 6. Session lifecycle comparison
- Nest: full lifecycle, restoration, reconnection, logout, desiredState.
- Express: basic connect/reconnect/disconnect.

## 7. Database compatibility
- Same entities/table structures loaded via glob.
- synchronize disabled.
- No migrations executed.

## 8. Credential preservation
- Session directories untouched.
- No credential files read/modified.

## 9. Migration sequence
1. Migrate session service (read-only lookup first).
2. Migrate session CRUD endpoints.
3. Migrate auth middleware/roles.
4. Migrate session restoration on boot.
5. Migrate logout/disconnect.
6. Tests.

## 10. Test requirements
- Session lookup tests.
- Auth/session authorization tests (done for socket).
- Lifecycle tests (done basic).

## 11. Risks
- Ownership model complexity.
- desiredState/nodeId/lease columns.
- Multi-process clustering.

## Unresolved questions
- Per-user vs API-key ownership.
- Role enforcement scope.
