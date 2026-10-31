const { SessionRepository } = require('./session.repository');

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * Thin persistence-facing service for the Express session module.
 *
 * Lifecycle verbs (start/stop/logout/force-kill/delete) live in SessionLifecycleService; this class
 * only owns the row operations they and the CRUD routes share, so both layers see the same
 * repository instance and error mapping.
 */
class SessionService {
  constructor(repo = new SessionRepository()) {
    this.repo = repo;
  }

  async getSessionById(sessionId) {
    if (!sessionId) return null;
    return this.repo.findById(sessionId);
  }

  async getSessionByIdOrFail(sessionId) {
    const session = await this.getSessionById(sessionId);
    if (!session) throw httpError(404, `Session ${sessionId} not found`);
    return session;
  }

  async listSessions(allowedSessions) {
    const sessions = await this.repo.findAll();
    // An empty/null allowedSessions means unrestricted (same rule as AuthService.authorizeSession).
    if (!Array.isArray(allowedSessions) || allowedSessions.length === 0) return sessions;
    const allowed = new Set(allowedSessions);
    return sessions.filter((session) => allowed.has(session.id));
  }

  async createSession(data) {
    try {
      return await this.repo.create(data);
    } catch (error) {
      // The repository checks the unique name before inserting; a concurrent create can still race
      // the insert, so map both shapes to the documented 409 rather than leaking a 500.
      if (/duplicate/i.test(error?.message ?? '')) {
        throw httpError(409, `Session with name '${data?.name}' already exists`);
      }
      throw error;
    }
  }

  async updateSession(id, data) {
    return this.repo.update(id, data);
  }

  async deleteSession(id) {
    return this.repo.delete(id);
  }
}

module.exports = { SessionService };
