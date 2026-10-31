# Architecture — Express.js Migration

## Target Structure
backend/src/
- config/
- modules/
- middleware/
- services/
- database/
- integrations/
- websocket/
- workers/
- utils/
- app.js
- server.js

## Principles
- One Express app, one HTTP server, one Socket.IO instance.
- Feature modules export routers + services.
- Centralized error handling middleware.
- TypeORM DataSource managed in database/.
- BullMQ workers in workers/.
- Baileys AND whatsapp-web.js engines preserved via engine abstraction.
- No NestJS, no Next.js, no TS, no microservices, no iframes.

## Engine Support
- ENGINE_TYPE = 'baileys' | 'whatsapp-web.js' (default whatsapp-web.js).
- Both adapters migrated as-is; engine-specific 501 behavior preserved.

## Data & Sessions
- SQLite and PostgreSQL both supported.
- Session credential directories preserved (Baileys creds, wwebjs profiles).
