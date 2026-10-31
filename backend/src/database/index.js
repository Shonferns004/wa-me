const { DataSource } = require('typeorm');
const path = require('path');

let ds = null;

async function initDb() {
  const type = process.env.DATABASE_TYPE === 'postgres' ? 'postgres' : 'sqlite';
  const base = path.join(__dirname, '..');
  const entities = [
    path.join(base, 'modules', '**', '*.entity.js'),
    path.join(base, 'engine', '**', '*.entity.js'),
  ];
  const options = type === 'postgres'
    ? {
        type: 'postgres',
        host: process.env.DATABASE_HOST || 'localhost',
        port: Number(process.env.DATABASE_PORT || 5432),
        username: process.env.DATABASE_USER,
        password: process.env.DATABASE_PASSWORD,
        database: process.env.DATABASE_NAME || 'openwa',
        entities,
        synchronize: false,
        logging: false,
      }
    : {
        type: 'better-sqlite3',
        database: process.env.DATABASE_NAME || './data/main.sqlite',
        entities,
        synchronize: false,
        logging: false,
      };
  ds = new DataSource(options);
  await ds.initialize();
  console.log('Database connected:', type);
  return ds;
}

function getDb() { return ds; }

module.exports = { initDb, getDb };
