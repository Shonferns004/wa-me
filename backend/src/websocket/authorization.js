// Express-layer auth service: it owns `authorizeSession` (API key lookup + allowedSessions scoping).
// The NestJS `auth.service` instance has a different surface (no authorizeSession), so importing it
// here made every `join:session` throw.
const { AuthService } = require('../modules/auth/auth.express.service');

const authService = new AuthService();

async function authorizeSocketJoin(sessionId, apiKeyRaw) {
  return authService.authorizeSession(apiKeyRaw, sessionId);
}

module.exports = { authorizeSocketJoin, authService };
