const fs = require('fs/promises');
const configuration = require('../../config/configuration').default;
const { isSafeSessionName } = require('../../common/utils/path-safety');
const { ensurePrivateDir } = require('../../common/utils/private-dir.util');
const { wwjsAuthDir, baileysAuthDir } = require('../../engine/auth-dir-paths');

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * Builds the real engine adapters (both whatsapp-web.js and Baileys) for the Express layer.
 *
 * The NestJS EngineFactory cannot be reused as-is: it is an @Injectable that needs PluginLoaderService,
 * the message store, the LID store and the chat-state store from the Nest container. The plugin classes
 * themselves are plain constructors, so the Express layer instantiates the configured one directly and
 * passes the same engine-neutral fields the factory would. Everything below the plugin boundary — the
 * adapters, the lifecycle delegates, the credential directories — is the production implementation,
 * not a second engine stack.
 *
 * The plugin require is lazy so that loading the HTTP router (and the CRUD tests) never pulls in
 * whatsapp-web.js/puppeteer or Baileys.
 */
class SessionEngineProvider {
  constructor({ config = configuration() } = {}) {
    const engineConfig = config.engine || {};
    this.engineType = engineConfig.type || 'whatsapp-web.js';
    this.engineConfig = engineConfig;
    this.sessionDataPath = engineConfig.sessionDataPath || './data/sessions';
    this.baileysAuthBase = engineConfig.baileys?.authDir || './data/baileys';
    this.plugin = null;
  }

  getPlugin() {
    if (this.plugin) return this.plugin;
    if (this.engineType === 'whatsapp-web.js') {
      const { WhatsAppWebJsPlugin } = require('../../engine/builtin/whatsapp-web-js');
      this.plugin = new WhatsAppWebJsPlugin(this.engineConfig, undefined);
    } else if (this.engineType === 'baileys') {
      const { BaileysPlugin } = require('../../engine/builtin/baileys');
      // The message/LID/chat-state stores are Nest services; the Express messaging modules will wire
      // them when they are migrated. Lifecycle, QR/pairing and credential teardown do not need them.
      this.plugin = new BaileysPlugin(undefined, this.engineConfig, undefined, undefined);
    } else {
      throw new Error(`Unknown ENGINE_TYPE: ${this.engineType}`);
    }
    return this.plugin;
  }

  createEngine({ sessionId, dbSessionId, proxyUrl, proxyType }) {
    if (!isSafeSessionName(sessionId)) {
      throw httpError(400, `Invalid session id: ${JSON.stringify(sessionId)}`);
    }
    // Same hardening the Nest EngineFactory performs before handing off to the plugin: create both
    // credential directories owner-only so a fresh session never starts from a world-readable profile.
    ensurePrivateDir(wwjsAuthDir(this.sessionDataPath, sessionId));
    ensurePrivateDir(baileysAuthDir(this.baileysAuthBase, sessionId));
    return this.getPlugin().createEngine({
      sessionId,
      dbSessionId: dbSessionId ?? sessionId,
      proxyUrl,
      proxyType,
      sessionDataPath: this.sessionDataPath,
      authDir: this.baileysAuthBase,
    });
  }

  /**
   * Remove both engines' credential directories for a session (DELETE /sessions/:id).
   * The key is the row id, which `isSafeSessionName` constrains to [a-zA-Z0-9-] before it becomes a
   * path segment — the guard the lifecycle audit flagged as missing on the old router.
   */
  async purgeSessionData(sessionId, legacyName) {
    if (!isSafeSessionName(sessionId)) {
      throw httpError(400, `Invalid session id: ${JSON.stringify(sessionId)}`);
    }
    const dirs = [
      wwjsAuthDir(this.sessionDataPath, sessionId),
      baileysAuthDir(this.baileysAuthBase, sessionId),
    ];
    if (legacyName && legacyName !== sessionId && isSafeSessionName(legacyName)) {
      dirs.push(wwjsAuthDir(this.sessionDataPath, legacyName));
      dirs.push(baileysAuthDir(this.baileysAuthBase, legacyName));
    }
    for (const dir of dirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}

module.exports = { SessionEngineProvider };
