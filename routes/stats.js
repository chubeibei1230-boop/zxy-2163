const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/missing-parts-by-spec', (req, res) => {
  const { start_date, end_date, limit = 20 } = req.query;
  const conditions = ['r.has_missing_parts = 1'];
  const params = [];

  if (start_date) { conditions.push('r.recovery_date >= ?'); params.push(start_date); }
  if (end_date) { conditions.push('r.recovery_date <= ?'); params.push(end_date); }

  const where = 'WHERE ' + conditions.join(' AND ');

  try {
    const data = db.prepare(`
      SELECT
        bh.spec,
        COUNT(*) as missing_count,
        COUNT(DISTINCT bh.id) as affected_holders,
        ROUND(COUNT(*) * 100.0 / (
          SELECT COUNT(*) FROM recoveries r2
          LEFT JOIN badge_holders bh2 ON bh2.id = r2.holder_id
          WHERE bh2.spec = bh.spec
          ${start_date ? 'AND r2.recovery_date >= ?' : ''}
          ${end_date ? 'AND r2.recovery_date <= ?' : ''}
        ), 2) as missing_rate_percent
      FROM recoveries r
      LEFT JOIN badge_holders bh ON bh.id = r.holder_id
      ${where}
      GROUP BY bh.spec
      ORDER BY missing_count DESC
      LIMIT ?
    `).all(...params, ...(start_date ? [start_date] : []), ...(end_date ? [end_date] : []), parseInt(limit) || 20);

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/recovery-delay-ranking', (req, res) => {
  const { start_date, end_date, limit = 20 } = req.query;
  const conditions = ['d.returned = 1'];
  const params = [];

  if (start_date) { conditions.push('d.dispatch_date >= ?'); params.push(start_date); }
  if (end_date) { conditions.push('d.dispatch_date <= ?'); params.push(end_date); }

  const where = 'WHERE ' + conditions.join(' AND ');

  try {
    const data = db.prepare(`
      SELECT
        d.recipient,
        COUNT(*) as total_dispatches,
        AVG(
          CAST((julianday(r.recovery_date) - julianday(d.dispatch_date)) * 24 * 60 AS INTEGER)
        ) as avg_delay_minutes,
        MAX(
          CAST((julianday(r.recovery_date) - julianday(d.dispatch_date)) * 24 * 60 AS INTEGER)
        ) as max_delay_minutes,
        SUM(CASE WHEN d.expected_return_date IS NOT NULL AND r.recovery_date > d.expected_return_date THEN 1 ELSE 0 END) as overdue_count
      FROM dispatches d
      LEFT JOIN recoveries r ON r.dispatch_id = d.id
      ${where}
      GROUP BY d.recipient
      HAVING total_dispatches > 0
      ORDER BY avg_delay_minutes DESC
      LIMIT ?
    `).all(...params, parseInt(limit) || 20);

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/pending-review-list', (req, res) => {
  const { page = 1, page_size = 50 } = req.query;
  const limit = Math.min(parseInt(page_size) || 50, 200);
  const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

  try {
    const total = db.prepare(`
      SELECT COUNT(*) as cnt FROM recoveries
      WHERE review_status = '待复查'
    `).get().cnt;

    const data = db.prepare(`
      SELECT
        r.id as recovery_id,
        r.recovery_date,
        r.condition,
        r.has_missing_parts,
        r.missing_parts_description,
        r.damage_description,
        bh.id as holder_id,
        bh.holder_code,
        bh.spec,
        bh.lanyard_type,
        bh.responsible_person,
        bh.status,
        d.recipient,
        d.dispatch_date,
        d.purpose,
        CAST((julianday('now','localtime') - julianday(r.recovery_date)) * 24 AS INTEGER) as pending_hours
      FROM recoveries r
      LEFT JOIN badge_holders bh ON bh.id = r.holder_id
      LEFT JOIN dispatches d ON d.id = r.dispatch_id
      WHERE r.review_status = '待复查'
      ORDER BY r.recovery_date ASC
      LIMIT ? OFFSET ?
    `).all(limit, offset);

    res.json({ success: true, total, page: parseInt(page) || 1, page_size: limit, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/status-overview', (req, res) => {
  try {
    const byStatus = db.prepare(`
      SELECT status, COUNT(*) as count FROM badge_holders
      GROUP BY status ORDER BY count DESC
    `).all();

    const total = byStatus.reduce((s, r) => s + r.count, 0);
    const dispatchesTotal = db.prepare('SELECT COUNT(*) as cnt FROM dispatches').get().cnt;
    const dispatchesOpen = db.prepare("SELECT COUNT(*) as cnt FROM dispatches WHERE returned = 0").get().cnt;
    const recoveriesPending = db.prepare("SELECT COUNT(*) as cnt FROM recoveries WHERE review_status = '待复查'").get().cnt;
    const lossUnresolved = db.prepare("SELECT COUNT(*) as cnt FROM loss_supplements WHERE is_resolved = 0").get().cnt;

    const exceptionsTotal = db.prepare('SELECT COUNT(*) as cnt FROM exception_records').get().cnt;
    const exceptionsPending = db.prepare("SELECT COUNT(*) as cnt FROM exception_records WHERE status = '待处理'").get().cnt;
    const exceptionsProcessing = db.prepare("SELECT COUNT(*) as cnt FROM exception_records WHERE status = '处理中'").get().cnt;
    const exceptionsClosed = db.prepare("SELECT COUNT(*) as cnt FROM exception_records WHERE status = '已闭环'").get().cnt;

    const exceptionsByType = db.prepare(`
      SELECT exception_type, COUNT(*) as count,
             SUM(CASE WHEN status != '已闭环' THEN 1 ELSE 0 END) as open_count
      FROM exception_records
      GROUP BY exception_type ORDER BY count DESC
    `).all();

    res.json({
      success: true,
      data: {
        total_holders: total,
        by_status: byStatus,
        total_dispatches: dispatchesTotal,
        open_dispatches: dispatchesOpen,
        pending_reviews: recoveriesPending,
        unresolved_losses: lossUnresolved,
        exceptions: {
          total: exceptionsTotal,
          pending: exceptionsPending,
          processing: exceptionsProcessing,
          closed: exceptionsClosed,
          close_rate: exceptionsTotal > 0 ? Math.round(exceptionsClosed / exceptionsTotal * 100) / 100 : 0,
          by_type: exceptionsByType
        }
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
