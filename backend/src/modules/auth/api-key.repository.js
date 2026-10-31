const { getDb } = require('../../database');
const { hashApiKey } = require('./api-key-hash');

class ApiKeyRepository {
  async findByRawKey(rawKey) {
    const db = getDb();
    if (!db) return null;
    const repo = db.getRepository('ApiKey');
    return repo.findOne({ where: { keyHash: hashApiKey(rawKey, process.env.API_KEY_PEPPER) } });
  }
}

module.exports = { ApiKeyRepository };
