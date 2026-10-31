# Migration Plan

## Phases
1. Audit (done)
2. Design (in progress)
3. Express foundation
4. Baileys & session management
5. Messaging, contacts, groups, media, status
6. Automation, queues, integrations, webhooks, plugins
7. Socket.IO
8. Frontend integration
9. Testing
10. Cutover & NestJS removal

## Strategy
- Incremental, module by module.
- Keep NestJS running until replacement verified.
- Preserve DB data, sessions, API contracts.
- Backups before DB changes.
