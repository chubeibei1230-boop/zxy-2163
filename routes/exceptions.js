const express = require('express');
const db = require('../db');

const router = express.Router();

const VALID_EXCEPTION_TYPES = ['缺件异常', '损坏异常', '遗失异常', '逾期未归还', '复查超时'];
const VALID_STATUSES = ['待处理', '处理中', '已闭环'];
const VALID_LEVELS = ['一般', '重要', '紧急'];

const buildExceptionFilters = (query, defaultOpenOnly = false) => {
  const {
    exception_type, status, responsible_person, holder_code, spec,
    start_date, end_date, exception_level
  } = query;

  const conditions = [];
  const params = [];

  if (exception_type) {
    conditions.push('er.exception_type = ?');
    params.push(exception_type);
  }
  if (status) {
    conditions.push('er.status = ?');
    params.push(status);
  } else if (defaultOpenOnly) {
    conditions.push("er.status != '已闭环'");
  }
  if (exception_level) {
    conditions.push('er.exception_level = ?');
    params.push(exception_level);
  }
  if (responsible_person) {
    conditions.push('er.responsible_person = ?');
    params.push(responsible_person);
  }
  if (holder_code) {
    conditions.push('er.holder_code LIKE ?');
    params.push('%' + holder_code + '%');
  }
  if (spec) {
    conditions.push('bh.spec = ?');
    params.push(spec);
  }
  if (start_date) {
    conditions.push('er.discovered_date >= ?');
    params.push(start_date);
  }
  if (end_date) {
    conditions.push('er.discovered_date <= ?');
    params.push(end_date);
  }

  return {
    where: conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '',
    params
  };
};

const syncTimeBasedExceptions = (txDb = db) => {
  let createdCount = 0;

  const overdueDispatches = txDb.prepare(`
    SELECT d.*, bh.responsible_person, bh.spec
    FROM dispatches d
    LEFT JOIN badge_holders bh ON bh.id = d.holder_id
    WHERE d.returned = 0
      AND d.expected_return_date IS NOT NULL
      AND d.expected_return_date < datetime('now','localtime')
  `).all();

  for (const d of overdueDispatches) {
    const existing = txDb.prepare(`
      SELECT * FROM exception_records
      WHERE source_type = 'dispatch' AND source_id = ? AND exception_type = '逾期未归还' AND status != '已闭环'
    `).get(d.id);

    if (!existing) {
      const days = Math.floor((Date.now() - new Date(d.expected_return_date).getTime()) / (1000 * 60 * 60 * 24));
      txDb.prepare(`
        INSERT INTO exception_records (
          holder_id, holder_code, exception_type, exception_level,
          source_type, source_id, status, responsible_person,
          discovered_date, description
        ) VALUES (?, ?, '逾期未归还', '重要', 'dispatch', ?, '待处理', ?, ?, ?)
      `).run(
        d.holder_id, d.holder_code, d.id,
        d.responsible_person || null,
        d.expected_return_date,
        `牌夹已逾期 ${days} 天未归还，领用人: ${d.recipient}`
      );
      createdCount++;
    }
  }

  const reviewDelays = txDb.prepare(`
    SELECT r.*, bh.responsible_person, bh.spec,
           CAST((julianday('now','localtime') - julianday(r.recovery_date)) * 24 AS INTEGER) as delay_hours
    FROM recoveries r
    LEFT JOIN badge_holders bh ON bh.id = r.holder_id
    WHERE r.review_status = '待复查'
      AND CAST((julianday('now','localtime') - julianday(r.recovery_date)) * 24 AS INTEGER) >= 24
  `).all();

  for (const r of reviewDelays) {
    const existing = txDb.prepare(`
      SELECT * FROM exception_records
      WHERE source_type = 'recovery' AND source_id = ? AND exception_type = '复查超时' AND status != '已闭环'
    `).get(r.id);

    if (!existing) {
      txDb.prepare(`
        INSERT INTO exception_records (
          holder_id, holder_code, exception_type, exception_level,
          source_type, source_id, status, responsible_person,
          discovered_date, description
        ) VALUES (?, ?, '复查超时', '一般', 'recovery', ?, '待处理', ?, ?, ?)
      `).run(
        r.holder_id, r.holder_code, r.id,
        r.responsible_person || null,
        r.recovery_date,
        `回收后已超过 ${r.delay_hours} 小时未复查，回收时状态: ${r.condition}`
      );
      createdCount++;
    }
  }

  return createdCount;
};

const getOrCreateException = (holderId, holderCode, exceptionType, sourceType, sourceId, description, responsiblePerson, txDb = db) => {
  const existing = txDb.prepare(`
    SELECT * FROM exception_records
    WHERE holder_id = ? AND exception_type = ? AND source_type = ? AND source_id = ? AND status != '已闭环'
  `).get(holderId, exceptionType, sourceType, sourceId);

  if (existing) return existing;

  const level = exceptionType === '遗失异常' || exceptionType === '逾期未归还' ? '重要' : '一般';

  const info = txDb.prepare(`
    INSERT INTO exception_records (
      holder_id, holder_code, exception_type, exception_level,
      source_type, source_id, status, responsible_person, description
    ) VALUES (?, ?, ?, ?, ?, ?, '待处理', ?, ?)
  `).run(holderId, holderCode, exceptionType, level, sourceType, sourceId, responsiblePerson || null, description || null);

  return txDb.prepare('SELECT * FROM exception_records WHERE id = ?').get(info.lastInsertRowid);
};

const closeException = (sourceType, sourceId, exceptionType, handler, handleResult, handleNotes, txDb = db) => {
  const record = txDb.prepare(`
    SELECT * FROM exception_records
    WHERE source_type = ? AND source_id = ? AND exception_type = ? AND status != '已闭环'
  `).get(sourceType, sourceId, exceptionType);

  if (!record) return null;

  txDb.prepare(`
    UPDATE exception_records SET
      status = '已闭环',
      handler = ?,
      handle_date = datetime('now','localtime'),
      handle_result = ?,
      handle_notes = COALESCE(?, handle_notes),
      updated_at = datetime('now','localtime')
    WHERE id = ?
  `).run(handler || null, handleResult || null, handleNotes || null, record.id);

  return txDb.prepare('SELECT * FROM exception_records WHERE id = ?').get(record.id);
};

router.get('/', (req, res) => {
  const { page = 1, page_size = 20 } = req.query;
  const { where, params } = buildExceptionFilters(req.query);
  const limit = Math.min(parseInt(page_size) || 20, 100);
  const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

  try {
    db.transaction(() => syncTimeBasedExceptions(db))();

    const total = db.prepare(`
      SELECT COUNT(*) as cnt FROM exception_records er
      LEFT JOIN badge_holders bh ON bh.id = er.holder_id
      ${where}
    `).get(...params).cnt;

    const data = db.prepare(`
      SELECT er.*, bh.spec, bh.lanyard_type, bh.status as holder_status, bh.drawer_id, d.drawer_code
      FROM exception_records er
      LEFT JOIN badge_holders bh ON bh.id = er.holder_id
      LEFT JOIN drawers d ON d.id = bh.drawer_id
      ${where}
      ORDER BY
        CASE er.status
          WHEN '待处理' THEN 1
          WHEN '处理中' THEN 2
          WHEN '已闭环' THEN 3
        END,
        CASE er.exception_level
          WHEN '紧急' THEN 1
          WHEN '重要' THEN 2
          WHEN '一般' THEN 3
        END,
        er.discovered_date DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const withRelated = data.map(item => {
      const related = getRelatedInfo(item, db);
      return { ...item, ...related };
    });

    res.json({ success: true, total, page: parseInt(page) || 1, page_size: limit, data: withRelated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const getRelatedInfo = (exception, txDb = db) => {
  const result = {
    latest_dispatch: null,
    recovery: null,
    review: null,
    loss_supplement: null
  };

  const holderId = exception.holder_id;
  if (!holderId) return result;

  result.latest_dispatch = txDb.prepare(`
    SELECT * FROM dispatches WHERE holder_id = ? ORDER BY dispatch_date DESC LIMIT 1
  `).get(holderId);

  if (exception.source_type === 'recovery') {
    result.recovery = txDb.prepare(`
      SELECT r.*, d.recipient, d.dispatch_date, d.purpose, d.expected_return_date
      FROM recoveries r
      LEFT JOIN dispatches d ON d.id = r.dispatch_id
      WHERE r.id = ?
    `).get(exception.source_id);
  } else {
    result.recovery = txDb.prepare(`
      SELECT r.*, d.recipient, d.dispatch_date, d.purpose
      FROM recoveries r
      LEFT JOIN dispatches d ON d.id = r.dispatch_id
      WHERE r.holder_id = ? ORDER BY r.recovery_date DESC LIMIT 1
    `).get(holderId);
  }

  if (result.recovery) {
    result.review = txDb.prepare(`
      SELECT * FROM reviews WHERE recovery_id = ? ORDER BY review_date DESC LIMIT 1
    `).get(result.recovery.id);
  }

  if (exception.source_type === 'loss_supplement') {
    result.loss_supplement = txDb.prepare(`
      SELECT * FROM loss_supplements WHERE id = ?
    `).get(exception.source_id);
  } else {
    result.loss_supplement = txDb.prepare(`
      SELECT * FROM loss_supplements
      WHERE holder_id = ? OR holder_code = ?
      ORDER BY report_date DESC LIMIT 1
    `).get(holderId, exception.holder_code);
  }

  return result;
};

router.get('/:id', (req, res) => {
  try {
    const exception = db.prepare(`
      SELECT er.*, bh.spec, bh.lanyard_type, bh.status as holder_status,
             bh.responsible_person, bh.drawer_id, d.drawer_code,
             ib.batch_code
      FROM exception_records er
      LEFT JOIN badge_holders bh ON bh.id = er.holder_id
      LEFT JOIN drawers d ON d.id = bh.drawer_id
      LEFT JOIN import_batches ib ON ib.id = bh.batch_id
      WHERE er.id = ?
    `).get(req.params.id);

    if (!exception) return res.status(404).json({ error: '异常记录不存在' });

    const related = getRelatedInfo(exception);

    const history = db.prepare(`
      SELECT * FROM exception_records
      WHERE holder_id = ? OR (holder_code = ? AND holder_id IS NULL)
      ORDER BY discovered_date DESC
    `).all(exception.holder_id, exception.holder_code);

    res.json({ success: true, exception, ...related, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/handle', (req, res) => {
  const { handler, handle_result, handle_notes, status } = req.body;

  if (!handle_result && !status) {
    return res.status(400).json({ error: 'handle_result 或 status 至少提供一个' });
  }
  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status 必须是: ${VALID_STATUSES.join(', ')}` });
  }

  try {
    const result = db.transaction(() => {
      const record = db.prepare('SELECT * FROM exception_records WHERE id = ?').get(req.params.id);
      if (!record) return { error: '异常记录不存在' };
      if (record.status === '已闭环') {
        return { error: '该异常已闭环，不能重复处理' };
      }

      const newStatus = status || '已闭环';

      db.prepare(`
        UPDATE exception_records SET
          status = ?,
          handler = COALESCE(?, handler),
          handle_date = CASE WHEN ? = '已闭环' THEN datetime('now','localtime') ELSE handle_date END,
          handle_result = COALESCE(?, handle_result),
          handle_notes = COALESCE(?, handle_notes),
          updated_at = datetime('now','localtime')
        WHERE id = ?
      `).run(newStatus, handler || null, newStatus, handle_result || null, handle_notes || null, req.params.id);

      if (newStatus === '已闭环' && record.source_type === 'loss_supplement') {
        db.prepare(`
          UPDATE loss_supplements SET
            is_resolved = 1,
            supplement_notes = COALESCE(?, supplement_notes)
          WHERE id = ?
        `).run(handle_notes || handle_result || null, record.source_id);
      }

      const updated = db.prepare('SELECT * FROM exception_records WHERE id = ?').get(req.params.id);

      return { success: true, exception: updated };
    })();

    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  const { exception_level, description, responsible_person } = req.body;

  try {
    const record = db.prepare('SELECT * FROM exception_records WHERE id = ?').get(req.params.id);
    if (!record) return res.status(404).json({ error: '异常记录不存在' });

    if (exception_level && !VALID_LEVELS.includes(exception_level)) {
      return res.status(400).json({ error: `exception_level 必须是: ${VALID_LEVELS.join(', ')}` });
    }

    db.prepare(`
      UPDATE exception_records SET
        exception_level = COALESCE(?, exception_level),
        description = COALESCE(?, description),
        responsible_person = COALESCE(?, responsible_person),
        updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(
      exception_level || null,
      description !== undefined ? description : null,
      responsible_person !== undefined ? responsible_person : null,
      req.params.id
    );

    const updated = db.prepare('SELECT * FROM exception_records WHERE id = ?').get(req.params.id);
    res.json({ success: true, exception: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats/summary', (req, res) => {
  try {
    db.transaction(() => syncTimeBasedExceptions(db))();

    const byType = db.prepare(`
      SELECT exception_type, COUNT(*) as count,
             SUM(CASE WHEN status = '待处理' THEN 1 ELSE 0 END) as pending_count,
             SUM(CASE WHEN status = '处理中' THEN 1 ELSE 0 END) as processing_count,
             SUM(CASE WHEN status = '已闭环' THEN 1 ELSE 0 END) as closed_count
      FROM exception_records
      GROUP BY exception_type
      ORDER BY count DESC
    `).all();

    const byStatus = db.prepare(`
      SELECT status, COUNT(*) as count FROM exception_records
      GROUP BY status ORDER BY count DESC
    `).all();

    const byLevel = db.prepare(`
      SELECT exception_level, COUNT(*) as count,
             SUM(CASE WHEN status != '已闭环' THEN 1 ELSE 0 END) as open_count
      FROM exception_records
      GROUP BY exception_level
      ORDER BY
        CASE exception_level
          WHEN '紧急' THEN 1
          WHEN '重要' THEN 2
          WHEN '一般' THEN 3
        END
    `).all();

    const total = db.prepare('SELECT COUNT(*) as cnt FROM exception_records').get().cnt;
    const pending = db.prepare("SELECT COUNT(*) as cnt FROM exception_records WHERE status = '待处理'").get().cnt;
    const processing = db.prepare("SELECT COUNT(*) as cnt FROM exception_records WHERE status = '处理中'").get().cnt;
    const closed = db.prepare("SELECT COUNT(*) as cnt FROM exception_records WHERE status = '已闭环'").get().cnt;

    const recentTrend = db.prepare(`
      SELECT
        date(discovered_date) as date,
        exception_type,
        COUNT(*) as count
      FROM exception_records
      WHERE discovered_date >= datetime('now','localtime', '-30 days')
      GROUP BY date(discovered_date), exception_type
      ORDER BY date DESC
    `).all();

    const extensionsTotal = db.prepare('SELECT COUNT(*) as cnt FROM dispatch_extensions').get().cnt;
    const extensionsPending = db.prepare("SELECT COUNT(*) as cnt FROM dispatch_extensions WHERE approval_status = '待审批'").get().cnt;
    const extensionsApproved = db.prepare("SELECT COUNT(*) as cnt FROM dispatch_extensions WHERE approval_status = '已通过'").get().cnt;
    const extensionsRejected = db.prepare("SELECT COUNT(*) as cnt FROM dispatch_extensions WHERE approval_status = '已驳回'").get().cnt;

    const currentOverdue = db.prepare(`
      SELECT COUNT(*) as cnt
      FROM dispatches d
      WHERE d.returned = 0
        AND d.expected_return_date IS NOT NULL
        AND d.expected_return_date < datetime('now','localtime')
    `).get().cnt;

    const closedOverdue = db.prepare(`
      SELECT COUNT(*) as cnt
      FROM exception_records er
      WHERE er.exception_type = '逾期未归还'
        AND er.status = '已闭环'
    `).get().cnt;

    const totalOverdueRecords = db.prepare(`
      SELECT COUNT(*) as cnt
      FROM exception_records er
      WHERE er.exception_type = '逾期未归还'
    `).get().cnt;

    res.json({
      success: true,
      data: {
        total,
        pending,
        processing,
        closed,
        close_rate: total > 0 ? Math.round(closed / total * 100) / 100 : 0,
        by_type: byType,
        by_status: byStatus,
        by_level: byLevel,
        recent_trend: recentTrend,
        extensions: {
          total: extensionsTotal,
          pending: extensionsPending,
          approved: extensionsApproved,
          rejected: extensionsRejected,
          approve_rate: extensionsTotal > 0 ? Math.round(extensionsApproved / extensionsTotal * 100) / 100 : 0
        },
        overdue: {
          current_count: currentOverdue,
          closed_count: closedOverdue,
          total_records: totalOverdueRecords,
          close_rate: totalOverdueRecords > 0 ? Math.round(closedOverdue / totalOverdueRecords * 100) / 100 : 0
        }
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/todo/list', (req, res) => {
  const { page = 1, page_size = 50, include_extensions = 'true' } = req.query;
  const { where, params } = buildExceptionFilters(req.query, true);
  const limit = Math.min(parseInt(page_size) || 50, 200);
  const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

  try {
    db.transaction(() => syncTimeBasedExceptions(db))();

    const total = db.prepare(`
      SELECT COUNT(*) as cnt
      FROM exception_records er
      LEFT JOIN badge_holders bh ON bh.id = er.holder_id
      ${where}
    `).get(...params).cnt;

    const data = db.prepare(`
      SELECT er.*, bh.spec, bh.lanyard_type, bh.status as holder_status, bh.responsible_person, bh.drawer_id, d.drawer_code
      FROM exception_records er
      LEFT JOIN badge_holders bh ON bh.id = er.holder_id
      LEFT JOIN drawers d ON d.id = bh.drawer_id
      ${where}
      ORDER BY
        CASE er.exception_level
          WHEN '紧急' THEN 1
          WHEN '重要' THEN 2
          WHEN '一般' THEN 3
        END,
        er.discovered_date ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const withRelated = data.map(item => {
      const related = getRelatedInfo(item, db);
      return { ...item, ...related };
    });

    let pendingExtensions = [];
    if (include_extensions === 'true' || include_extensions === '1') {
      pendingExtensions = db.prepare(`
        SELECT de.*,
               d.recipient, d.dispatch_date, d.purpose, d.expected_return_date,
               bh.spec, bh.lanyard_type, bh.responsible_person
        FROM dispatch_extensions de
        LEFT JOIN dispatches d ON d.id = de.dispatch_id
        LEFT JOIN badge_holders bh ON bh.id = de.holder_id
        WHERE de.approval_status = '待审批'
        ORDER BY de.created_at ASC
      `).all();
    }

    const currentOverdueCount = db.prepare(`
      SELECT COUNT(*) as cnt
      FROM dispatches d
      WHERE d.returned = 0
        AND d.expected_return_date IS NOT NULL
        AND d.expected_return_date < datetime('now','localtime')
    `).get().cnt;

    const pendingExtensionCount = db.prepare("SELECT COUNT(*) as cnt FROM dispatch_extensions WHERE approval_status = '待审批'").get().cnt;

    res.json({
      success: true,
      total,
      page: parseInt(page) || 1,
      page_size: limit,
      data: withRelated,
      pending_extensions: pendingExtensions,
      pending_extension_count: pendingExtensionCount,
      current_overdue_count: currentOverdueCount
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/sync/generate-time-based', (req, res) => {
  try {
    const result = db.transaction(() => {
      const createdCount = syncTimeBasedExceptions(db);

      return { success: true, created: createdCount, message: `已生成 ${createdCount} 条时间驱动异常记录` };
    })();

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { exceptionsRouter: router, getOrCreateException, closeException, syncTimeBasedExceptions };
