# Phase 4.1.2C-1V NestJS Session API Contract Audit

## Original NestJS SessionController (compiled)
File: backend/src/modules/session/session.controller.js
Base path: /sessions

## Endpoints (from decorators)
- POST /sessions (create) - 201
- GET /sessions (list) - 200, query limit/offset/name
- GET /sessions/:sessionId - 200
- GET /sessions/:sessionId/config - 200
- PATCH /sessions/:sessionId/config - 200
- GET /sessions/:sessionId/proxy - 200
- PATCH /sessions/:sessionId/proxy - 200
- DELETE /sessions/:sessionId - 204
- POST /sessions/:sessionId/start - 200
- POST /sessions/:sessionId/stop - 200
- POST /sessions/:sessionId/logout - 200
- POST /sessions/:sessionId/force-kill - 200
- GET /sessions/:sessionId/qr - 200
- POST /sessions/:sessionId/pairing-code - 201
- GET /sessions/:sessionId/groups - 200
- GET /sessions/:sessionId/chats - 200
- ... many more chat/presence endpoints

## Express current
- GET /sessions
- GET /sessions/:id
- POST /sessions
- PUT /sessions/:id
- DELETE /sessions/:id

## Mismatches
- Express uses PUT instead of PATCH for config/proxy? Actually only basic CRUD.
- Missing most endpoints.
- Auth: Express uses X-API-Key header; Nest uses ApiKeyGuard.
- Status codes: create 201, delete 204 (match for basic).
- Params: sessionId must be UUID (ParseUUIDPipe).

## Compatibility risks
- Express router only covers basic CRUD; full API parity requires migrating many endpoints.
- Role/permission checks (RequireRole, RequireUnscopedKey, ChatScoped) not implemented.
- Validation (ParseUUIDPipe, DTO validation) not implemented.

## Conclusion
Express Session API is a minimal subset. Full parity requires extensive migration beyond this subphase.
