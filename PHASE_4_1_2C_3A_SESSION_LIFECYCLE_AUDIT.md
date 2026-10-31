# Phase 4.1.2C-3A Session Lifecycle Audit

## Original NestJS lifecycle endpoints (from controller)
- POST /sessions/:sessionId/start (200)
- POST /sessions/:sessionId/stop (200)
- POST /sessions/:sessionId/logout (200)
- POST /sessions/:sessionId/force-kill (200)

## Current Express
- No lifecycle endpoints implemented.
- BaileysConnection basic connect/disconnect exists.
- No connection registry.
- No whatsapp-web.js adapter in Express.

## Risks
- Duplicate connections.
- Credential overwrite.
- No logout distinction.
- No retry/reconnect orchestration.

## Recommended subphases
- C-3B: Start/stop for Baileys.
- C-3C: Logout + force-kill.
- C-3D: whatsapp-web.js lifecycle.
- C-3E: Registry + concurrency + tests.

## Status
Read-only audit complete. No code modified.
