const { ApiKeyRepository } = require('./api-key.repository');

class AuthService {
  constructor(apiKeyRepo = new ApiKeyRepository(), sessionService = null) {
    this.apiKeyRepo = apiKeyRepo;
    this.sessionService = sessionService;
  }
  async validateApiKey(rawKey) {
    if (!rawKey) return null;
    const key = await this.apiKeyRepo.findByRawKey(rawKey);
    if (!key || key.isActive === false) return null;
    return key;
  }
  async authorizeSession(rawKey, sessionId) {
    const key = await this.validateApiKey(rawKey);
    if (!key) return { ok: false, error: 'Unauthorized' };
    if (!sessionId) return { ok: false, error: 'Invalid sessionId' };
    if (Array.isArray(key.allowedSessions) && key.allowedSessions.length > 0) {
      if (!key.allowedSessions.includes(sessionId)) {
        return { ok: false, error: 'Forbidden' };
      }
    }
    // empty/null => unrestricted
    return { ok: true };
  }
}

module.exports = { AuthService };
