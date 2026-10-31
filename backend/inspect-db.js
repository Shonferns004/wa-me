const Database = require('better-sqlite3');
for (const f of ['data/main.sqlite', 'data/openwa.sqlite']) {
  const db = new Database(f, { readonly: true });
  console.log('===', f);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  console.log(tables.join(', '));
  db.close();
}
