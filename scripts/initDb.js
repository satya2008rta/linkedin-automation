// One-off smoke test: creates/opens data/app.db, applies the schema (via config/db.js's
// side effect on require), and prints the resulting tables so you can confirm the local
// database is wired up correctly before building anything on top of it.
const db = require('../src/config/db');

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((row) => row.name);

console.log('SQLite database ready at:', require('../src/config/env').env.dbPath);
console.log('Tables:', tables.join(', '));
