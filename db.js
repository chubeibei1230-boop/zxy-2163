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

    CREATE TABLE IF NOT EXISTS import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_code TEXT UNIQUE NOT NULL,
      operator TEXT NOT NULL,
      total_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      fail_count INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS badge_holders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      holder_code TEXT UNIQUE NOT NULL,
      spec TEXT NOT NULL,
      lanyard_type TEXT NOT NULL,
      drawer_id INTEGER NOT NULL,
      responsible_person TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '待配发',
      batch_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (drawer_id) REFERENCES drawers(id),
      FOREIGN KEY (batch_id) REFERENCES import_batches(id)
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

    CREATE TABLE IF NOT EXISTS exception_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      holder_id INTEGER,
      holder_code TEXT NOT NULL,
      exception_type TEXT NOT NULL,
      exception_level TEXT NOT NULL DEFAULT '一般',
      source_type TEXT NOT NULL,
      source_id INTEGER,
      status TEXT NOT NULL DEFAULT '待处理',
      responsible_person TEXT,
      discovered_date TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      description TEXT,
      handler TEXT,
      handle_date TEXT,
      handle_result TEXT,
      handle_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (holder_id) REFERENCES badge_holders(id)
    );

    CREATE TABLE IF NOT EXISTS dispatch_extensions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dispatch_id INTEGER NOT NULL,
      holder_id INTEGER NOT NULL,
      holder_code TEXT NOT NULL,
      applicant TEXT NOT NULL,
      extension_reason TEXT NOT NULL,
      original_expected_return_date TEXT NOT NULL,
      new_expected_return_date TEXT NOT NULL,
      approval_status TEXT NOT NULL DEFAULT '待审批',
      approver TEXT,
      approval_notes TEXT,
      approval_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (dispatch_id) REFERENCES dispatches(id),
      FOREIGN KEY (holder_id) REFERENCES badge_holders(id)
    );

    CREATE INDEX IF NOT EXISTS idx_extensions_dispatch ON dispatch_extensions(dispatch_id);
    CREATE INDEX IF NOT EXISTS idx_extensions_holder ON dispatch_extensions(holder_id);
    CREATE INDEX IF NOT EXISTS idx_extensions_status ON dispatch_extensions(approval_status);
    CREATE INDEX IF NOT EXISTS idx_extensions_applicant ON dispatch_extensions(applicant);

    CREATE INDEX IF NOT EXISTS idx_holders_status ON badge_holders(status);
    CREATE INDEX IF NOT EXISTS idx_holders_spec ON badge_holders(spec);
    CREATE INDEX IF NOT EXISTS idx_holders_lanyard ON badge_holders(lanyard_type);
    CREATE INDEX IF NOT EXISTS idx_holders_person ON badge_holders(responsible_person);
    CREATE INDEX IF NOT EXISTS idx_holders_drawer ON badge_holders(drawer_id);
    CREATE INDEX IF NOT EXISTS idx_holders_batch ON badge_holders(batch_id);
    CREATE INDEX IF NOT EXISTS idx_dispatches_returned ON dispatches(returned);
    CREATE INDEX IF NOT EXISTS idx_recoveries_review ON recoveries(review_status);
    CREATE INDEX IF NOT EXISTS idx_exceptions_type ON exception_records(exception_type);
    CREATE INDEX IF NOT EXISTS idx_exceptions_status ON exception_records(status);
    CREATE INDEX IF NOT EXISTS idx_exceptions_holder ON exception_records(holder_id);
    CREATE INDEX IF NOT EXISTS idx_exceptions_person ON exception_records(responsible_person);
    CREATE INDEX IF NOT EXISTS idx_exceptions_source ON exception_records(source_type, source_id);

    CREATE TABLE IF NOT EXISTS risk_ledger_handles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      risk_key TEXT NOT NULL,
      holder_id INTEGER,
      holder_code TEXT NOT NULL,
      risk_type TEXT NOT NULL,
      handle_result TEXT,
      handler TEXT,
      handle_notes TEXT,
      handle_status TEXT NOT NULL DEFAULT '待处理',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (holder_id) REFERENCES badge_holders(id)
    );

    CREATE TABLE IF NOT EXISTS handovers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      handover_code TEXT UNIQUE NOT NULL,
      operator TEXT NOT NULL,
      new_responsible_person TEXT NOT NULL,
      reason TEXT NOT NULL,
      notes TEXT,
      risk_confirmed INTEGER NOT NULL DEFAULT 0,
      risk_warnings TEXT,
      total_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      risk_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS handover_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      handover_id INTEGER NOT NULL,
      holder_id INTEGER NOT NULL,
      holder_code TEXT NOT NULL,
      spec TEXT,
      drawer_code TEXT,
      previous_responsible_person TEXT NOT NULL,
      new_responsible_person TEXT NOT NULL,
      holder_status TEXT,
      risk_warning TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (handover_id) REFERENCES handovers(id),
      FOREIGN KEY (holder_id) REFERENCES badge_holders(id)
    );

    CREATE INDEX IF NOT EXISTS idx_handover_items_handover ON handover_items(handover_id);
    CREATE INDEX IF NOT EXISTS idx_handover_items_holder ON handover_items(holder_id);
    CREATE INDEX IF NOT EXISTS idx_handover_items_previous ON handover_items(previous_responsible_person);
    CREATE INDEX IF NOT EXISTS idx_handover_items_new ON handover_items(new_responsible_person);
    CREATE INDEX IF NOT EXISTS idx_handovers_operator ON handovers(operator);
    CREATE INDEX IF NOT EXISTS idx_handovers_new_person ON handovers(new_responsible_person);
    CREATE INDEX IF NOT EXISTS idx_handovers_created ON handovers(created_at);

    CREATE INDEX IF NOT EXISTS idx_risk_handles_key ON risk_ledger_handles(risk_key);
    CREATE INDEX IF NOT EXISTS idx_risk_handles_holder ON risk_ledger_handles(holder_id);
    CREATE INDEX IF NOT EXISTS idx_risk_handles_status ON risk_ledger_handles(handle_status);
    CREATE INDEX IF NOT EXISTS idx_risk_handles_type ON risk_ledger_handles(risk_type);
  `);

  try {
    db.exec("ALTER TABLE badge_holders ADD COLUMN batch_id INTEGER REFERENCES import_batches(id)");
  } catch (e) {}

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
