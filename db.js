const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'badgeholders.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const initDb = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS drawers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drawer_code TEXT UNIQUE NOT NULL,
      capacity_per_spec INTEGER NOT NULL DEFAULT 50
    );

    CREATE TABLE IF NOT EXISTS badge_holders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      holder_code TEXT UNIQUE NOT NULL,
      spec TEXT NOT NULL,
      lanyard_type TEXT NOT NULL,
      drawer_id INTEGER NOT NULL,
      responsible_person TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '待配发',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (drawer_id) REFERENCES drawers(id)
    );

    CREATE TABLE IF NOT EXISTS dispatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      holder_id INTEGER NOT NULL,
      holder_code TEXT NOT NULL,
      recipient TEXT NOT NULL,
      dispatch_date TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      purpose TEXT,
      expected_return_date TEXT,
      returned INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (holder_id) REFERENCES badge_holders(id)
    );

    CREATE TABLE IF NOT EXISTS recoveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dispatch_id INTEGER NOT NULL,
      holder_id INTEGER NOT NULL,
      holder_code TEXT NOT NULL,
      recovery_date TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      condition TEXT NOT NULL DEFAULT '完好',
      damage_description TEXT,
      has_missing_parts INTEGER NOT NULL DEFAULT 0,
      missing_parts_description TEXT,
      review_status TEXT NOT NULL DEFAULT '待复查',
      FOREIGN KEY (dispatch_id) REFERENCES dispatches(id),
      FOREIGN KEY (holder_id) REFERENCES badge_holders(id)
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recovery_id INTEGER NOT NULL,
      holder_id INTEGER NOT NULL,
      reviewer TEXT NOT NULL,
      review_date TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      review_result TEXT NOT NULL,
      review_notes TEXT,
      FOREIGN KEY (recovery_id) REFERENCES recoveries(id),
      FOREIGN KEY (holder_id) REFERENCES badge_holders(id)
    );

    CREATE TABLE IF NOT EXISTS loss_supplements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      holder_id INTEGER,
      holder_code TEXT,
      reporter TEXT NOT NULL,
      report_date TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      loss_date TEXT,
      loss_description TEXT NOT NULL,
      supplement_notes TEXT,
      is_resolved INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (holder_id) REFERENCES badge_holders(id)
    );

    CREATE INDEX IF NOT EXISTS idx_holders_status ON badge_holders(status);
    CREATE INDEX IF NOT EXISTS idx_holders_spec ON badge_holders(spec);
    CREATE INDEX IF NOT EXISTS idx_holders_lanyard ON badge_holders(lanyard_type);
    CREATE INDEX IF NOT EXISTS idx_holders_person ON badge_holders(responsible_person);
    CREATE INDEX IF NOT EXISTS idx_holders_drawer ON badge_holders(drawer_id);
    CREATE INDEX IF NOT EXISTS idx_dispatches_returned ON dispatches(returned);
    CREATE INDEX IF NOT EXISTS idx_recoveries_review ON recoveries(review_status);
  `);

  const drawerCount = db.prepare('SELECT COUNT(*) as cnt FROM drawers').get().cnt;
  if (drawerCount === 0) {
    const insertDrawer = db.prepare('INSERT INTO drawers (drawer_code, capacity_per_spec) VALUES (?, ?)');
    const defaultDrawers = [
      ['A-01', 50],
      ['A-02', 50],
      ['A-03', 50],
      ['B-01', 40],
      ['B-02', 40]
    ];
    const tx = db.transaction(drawers => {
      for (const d of drawers) insertDrawer.run(...d);
    });
    tx(defaultDrawers);
  }
};

initDb();

module.exports = db;
