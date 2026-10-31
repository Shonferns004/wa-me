# WhatsApp Engine Decision

## Finding
The application supports TWO WhatsApp engines selectable via ENGINE_TYPE:
1. Baileys (@whiskeysockets/baileys)
2. whatsapp-web.js

Both are first-class, actively used. Modules handle engine-specific behavior (501 for unsupported features). Plugins and agent tools account for both.

## Decision
Preserve BOTH engines in the Express migration. Do NOT remove either. Maintain engine abstraction layer. Migrate adapter code as-is, preserving engine-specific behavior and feature availability.

## Session Storage
- Baileys: creds.json + auth state files per session directory.
- whatsapp-web.js: Puppeteer profile directories per session.
Both stored under data/sessions (or configured storage root). Must preserve paths and credentials.

## Risks
- Puppeteer/Chromium dependency for whatsapp-web.js.
- Baileys patch scripts (pairing, appstate, newsletter).
- Engine-specific error handling and retry logic.
