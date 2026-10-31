const { getDb } = require('../../database');

class SessionRepository {
  async findById(sessionId) {
    const db = getDb();
    if (!db) return null;
    return db.getRepository('Session').findOne({ where: { id: sessionId } });
  }
  async findAll() {
    const db = getDb();
    if (!db) return [];
    return db.getRepository('Session').find();
  }
  async create(data) {
    const db = getDb();
    if (!db) throw new Error('No DB');
    const repo = db.getRepository('Session');
    const existing = await repo.findOne({ where: { name: data.name } });
    if (existing) throw new Error('Duplicate session');
    const entity = repo.create(data);
    return repo.save(entity);
  }
  async update(id, data) {
    const db = getDb();
    if (!db) return null;
    const repo = db.getRepository('Session');
    const s = await repo.findOne({ where: { id } });
    if (!s) return null;
    Object.assign(s, data);
    return repo.save(s);
  }
  async delete(id) {
    const db = getDb();
    if (!db) return false;
    const repo = db.getRepository('Session');
    const s = await repo.findOne({ where: { id } });
    if (!s) return false;
    await repo.remove(s);
    return true;
  }
}

module.exports = { SessionRepository };
