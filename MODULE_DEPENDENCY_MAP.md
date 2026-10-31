# Module Dependency Map

## Engine Selection
- Config: ENGINE_TYPE = 'baileys' | 'whatsapp-web.js' (default whatsapp-web.js).
- Engine abstraction under src/engine/ with adapters for both.
- Modules call engine interface, not library directly.

## Core Dependencies
- session -> engine adapter
- message -> session, engine, queue
- contact/group/profile -> session, engine
- media/chat-media -> storage, engine
- automation -> message, queue, engine
- webhook -> events, queue
- plugins -> core/plugins, config
- queue -> redis, bullmq
- events/socket -> redis adapter, session
- auth -> api keys, roles
- database -> typeorm, sqlite/pg

## Module List (30+)
audit, auth, automation, call, catalog, channel, chat-media, contact, docker, events, group, health, infra, integration, label, mcp, media, message, metrics, plugins, profile, queue, search, session, settings, stats, status, status-store, takeover, template, webhook.
Common: cache, errors, interceptors, media, metrics, middleware, openapi, security, services, storage, throttler, transformers, utils, validation.
Core: agent-tools, hooks, plugins.
Engine: adapters (baileys, whatsapp-web-js), builtin, identity, interfaces, types.
