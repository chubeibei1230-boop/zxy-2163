const express = require('express');
const db = require('../db');
const { syncTimeBasedExceptions } = require('./exceptions');

const router = express.Router();

const VALID_APPROVAL_STATUSES = ['待审批', '已通过', '已驳回'];

const buildExtensionFilters = (query) => {
  const {
    dispatch_id, holder_id, holder_code, applicant, approver,
    approval_status, start_date, end_date,
    original_start_date, original_end_date,
    new_start_date, new_end_date
  } = query;

  const conditions = [];
  const params = [];

  if (dispatch_id) { conditions.push('de.dispatch_id = ?'); params.push(dispatch_id); }
  if (holder_id) { conditions.push('de.holder_id = ?'); params.push(holder_id); }
  if (holder_code) {
    conditions.push('de.holder_code LIKE ?');
    params.push('%' + holder_code + '%');
  }
  if (applicant) { conditions.push('de.applicant = ?'); params.push(applicant); }
  if (approver) { conditions.push('de.approver = ?'); params.push(approver); }
  if (approval_status) {
    if (Array.isArray(approval_status)) {
      const placeholders = approval_status.map(() => '?').join(',');
      conditions.push(`de.approval_status IN (${placeholders})`);
      params.push(...approval_status);
    } else {
      conditions.push('de.approval_status = ?');
      params.push(approval_status);
    }
  }
  if (start_date) { conditions.push('de.created_at >= ?'); params.push(start_date); }
  if (end_date) { conditions.push('de.created_at <= ?'); params.push(end_date); }
  if (original_start_date) { conditions.push('de.original_expected_return_date >= ?'); params.push(original_start_date); }
  if (original_end_date) { conditions.push('de.original_expected_return_date <= ?'); params.push(original_end_date); }
  if (new_start_date) { conditions.push('de.new_expected_return_date >= ?'); params.push(new_start_date); }
  if (new_end_date) { conditions.push('de.new_expected_return_date <= ?'); params.push(new_end_date); }

  return {
    where: conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '',
    params
  };
};

const getDispatchOverdueInfo = (dispatch, txDb = db) => {
  if (!dispatch || dispatch.returned === 1 || !dispatch.expected_return_date) {
    return { is_overdue: false, overdue_days: 0, overdue_hours: 0 };
  }
  const now = new Date();
  const expected = new Date(dispatch.expected_return_date);
  if (now <= expected) {
    return { is_overdue: false, overdue_days: 0, overdue_hours: 0 };
  }
  const diffMs = now.getTime() - expected.getTime();
  const overdueDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const overdueHours = Math.floor(diffMs / (1000 * 60 * 60));
  return { is_overdue: true, overdue_days: overdueDays, overdue_hours: overdueHours };
};

router.post('/', (req, res) => {
  const {
    dispatch_id, holder_id, holder_code,
    applicant, extension_reason, new_expected_return_date
  } = req.body;

  if (!dispatch_id && !holder_id && !holder_code) {
    return res.status(400).json({ error: '必须提供 dispatch_id、holder_id 或 holder_code 之一' });
  }
  if (!applicant) return res.status(400).json({ error: '申请人 applicant 必填' });
  if (!extension_reason) return res.status(400).json({ error: '延期原因 extension_reason 必填' });
  if (!new_expected_return_date) return res.status(400).json({ error: '新预计归还时间 new_expected_return_date 必填' });

  try {
    const result = db.transaction(() => {
      let dispatch = null;

      if (dispatch_id) {
        dispatch = db.prepare('SELECT * FROM dispatches WHERE id = ?').get(dispatch_id);
        if (!dispatch) return { error: '配发记录不存在' };
      } else {
        let holder = null;
        if (holder_id) {
          holder = db.prepare('SELECT * FROM badge_holders WHERE id = ?').get(holder_id);
        } else if (holder_code) {
          holder = db.prepare('SELECT * FROM badge_holders WHERE holder_code = ?').get(holder_code);
        }
        if (!holder) return { error: '牌夹不存在' };

        dispatch = db.prepare(`
          SELECT * FROM dispatches
          WHERE holder_id = ? AND returned = 0
          ORDER BY dispatch_date DESC LIMIT 1
        `).get(holder.id);
        if (!dispatch) return { error: '该牌夹没有未回收的配发记录' };
      }

      if (dispatch.returned === 1) {
        return { error: '该配发记录已回收，不能申请延期' };
      }
      if (!dispatch.expected_return_date) {
        return { error: '该配发记录未设置预计归还时间，不能申请延期' };
      }

      const newDate = new Date(new_expected_return_date);
      const originalDate = new Date(dispatch.expected_return_date);
      if (newDate <= originalDate) {
        return { error: '新预计归还时间必须晚于原预计归还时间' };
      }

      const pendingCount = db.prepare(`
        SELECT COUNT(*) as cnt FROM dispatch_extensions
        WHERE dispatch_id = ? AND approval_status = '待审批'
      `).get(dispatch.id).cnt;
      if (pendingCount > 0) {
        return { error: '该配发记录已有待审批的延期申请，请先处理' };
      }

      const insertExt = db.prepare(`
        INSERT INTO dispatch_extensions (
          dispatch_id, holder_id, holder_code,
          applicant, extension_reason,
          original_expected_return_date, new_expected_return_date,
          approval_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '待审批')
      `);

      const info = insertExt.run(
        dispatch.id, dispatch.holder_id, dispatch.holder_code,
        applicant, extension_reason,
        dispatch.expected_return_date, new_expected_return_date
      );

      return {
        success: true,
        extension_id: info.lastInsertRowid,
        dispatch_id: dispatch.id,
        holder_id: dispatch.holder_id,
        holder_code: dispatch.holder_code
      };
    })();

    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/approve', (req, res) => {
  const { approver, approval_notes } = req.body;

  if (!approver) return res.status(400).json({ error: '审批人 approver 必填' });

  try {
    const result = db.transaction(() => {
      const ext = db.prepare('SELECT * FROM dispatch_extensions WHERE id = ?').get(req.params.id);
      if (!ext) return { error: '延期申请不存在' };
      if (ext.approval_status !== '待审批') {
        return { error: `该申请当前状态为「${ext.approval_status}」，不能重复审批` };
      }

      const dispatch = db.prepare('SELECT * FROM dispatches WHERE id = ?').get(ext.dispatch_id);
      if (!dispatch) return { error: '关联配发记录不存在' };
      if (dispatch.returned === 1) {
        return { error: '该配发记录已回收，无法审批延期' };
      }

      db.prepare(`
        UPDATE dispatch_extensions SET
          approval_status = '已通过',
          approver = ?,
          approval_notes = ?,
          approval_date = datetime('now','localtime'),
          updated_at = datetime('now','localtime')
        WHERE id = ?
      `).run(approver, approval_notes || null, ext.id);

      db.prepare(`
        UPDATE dispatches SET
          expected_return_date = ?
        WHERE id = ?
      `).run(ext.new_expected_return_date, ext.dispatch_id);

      const updatedExt = db.prepare('SELECT * FROM dispatch_extensions WHERE id = ?').get(ext.id);
      const updatedDispatch = db.prepare('SELECT * FROM dispatches WHERE id = ?').get(ext.dispatch_id);

      syncTimeBasedExceptions(db);

      return {
        success: true,
        extension: updatedExt,
        dispatch: {
          id: updatedDispatch.id,
          expected_return_date: updatedDispatch.expected_return_date
        }
      };
    })();

    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/reject', (req, res) => {
  const { approver, approval_notes } = req.body;

  if (!approver) return res.status(400).json({ error: '审批人 approver 必填' });
  if (!approval_notes) return res.status(400).json({ error: '驳回原因 approval_notes 必填' });

  try {
    const result = db.transaction(() => {
      const ext = db.prepare('SELECT * FROM dispatch_extensions WHERE id = ?').get(req.params.id);
      if (!ext) return { error: '延期申请不存在' };
      if (ext.approval_status !== '待审批') {
        return { error: `该申请当前状态为「${ext.approval_status}」，不能重复审批` };
      }

      db.prepare(`
        UPDATE dispatch_extensions SET
          approval_status = '已驳回',
          approver = ?,
          approval_notes = ?,
          approval_date = datetime('now','localtime'),
          updated_at = datetime('now','localtime')
        WHERE id = ?
      `).run(approver, approval_notes, ext.id);

      const updatedExt = db.prepare('SELECT * FROM dispatch_extensions WHERE id = ?').get(ext.id);

      return {
        success: true,
        extension: updatedExt,
        message: '已驳回，原预计归还时间保持不变'
      };
    })();

    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  const { page = 1, page_size = 20 } = req.query;
  const { where, params } = buildExtensionFilters(req.query);
  const limit = Math.min(parseInt(page_size) || 20, 100);
  const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

  try {
    const total = db.prepare(`
      SELECT COUNT(*) as cnt FROM dispatch_extensions de
      LEFT JOIN dispatches d ON d.id = de.dispatch_id
      LEFT JOIN badge_holders bh ON bh.id = de.holder_id
      ${where}
    `).get(...params).cnt;

    const data = db.prepare(`
      SELECT de.*,
             d.recipient, d.dispatch_date, d.purpose, d.returned,
             bh.spec, bh.lanyard_type, bh.responsible_person, bh.status as holder_status
      FROM dispatch_extensions de
      LEFT JOIN dispatches d ON d.id = de.dispatch_id
      LEFT JOIN badge_holders bh ON bh.id = de.holder_id
      ${where}
      ORDER BY
        CASE de.approval_status
          WHEN '待审批' THEN 1
          WHEN '已通过' THEN 2
          WHEN '已驳回' THEN 3
        END,
        de.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({ success: true, total, page: parseInt(page) || 1, page_size: limit, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const ext = db.prepare(`
      SELECT de.*,
             d.recipient, d.dispatch_date, d.purpose, d.returned, d.expected_return_date as current_expected_return_date,
             bh.spec, bh.lanyard_type, bh.responsible_person, bh.status as holder_status
      FROM dispatch_extensions de
      LEFT JOIN dispatches d ON d.id = de.dispatch_id
      LEFT JOIN badge_holders bh ON bh.id = de.holder_id
      WHERE de.id = ?
    `).get(req.params.id);

    if (!ext) return res.status(404).json({ error: '延期申请不存在' });

    const history = db.prepare(`
      SELECT * FROM dispatch_extensions
      WHERE dispatch_id = ?
      ORDER BY created_at DESC
    `).all(ext.dispatch_id);

    res.json({ success: true, extension: ext, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats/summary', (req, res) => {
  try {
    const total = db.prepare('SELECT COUNT(*) as cnt FROM dispatch_extensions').get().cnt;
    const pending = db.prepare("SELECT COUNT(*) as cnt FROM dispatch_extensions WHERE approval_status = '待审批'").get().cnt;
    const approved = db.prepare("SELECT COUNT(*) as cnt FROM dispatch_extensions WHERE approval_status = '已通过'").get().cnt;
    const rejected = db.prepare("SELECT COUNT(*) as cnt FROM dispatch_extensions WHERE approval_status = '已驳回'").get().cnt;

    const byApplicant = db.prepare(`
      SELECT applicant, COUNT(*) as count,
             SUM(CASE WHEN approval_status = '待审批' THEN 1 ELSE 0 END) as pending_count,
             SUM(CASE WHEN approval_status = '已通过' THEN 1 ELSE 0 END) as approved_count,
             SUM(CASE WHEN approval_status = '已驳回' THEN 1 ELSE 0 END) as rejected_count
      FROM dispatch_extensions
      GROUP BY applicant
      ORDER BY count DESC
      LIMIT 20
    `).all();

    const recentTrend = db.prepare(`
      SELECT
        date(created_at) as date,
        approval_status,
        COUNT(*) as count
      FROM dispatch_extensions
      WHERE created_at >= datetime('now','localtime', '-30 days')
      GROUP BY date(created_at), approval_status
      ORDER BY date DESC
    `).all();

    res.json({
      success: true,
      data: {
        total,
        pending,
        approved,
        rejected,
        approve_rate: total > 0 ? Math.round(approved / total * 100) / 100 : 0,
        by_applicant: byApplicant,
        recent_trend: recentTrend
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/overdue/list', (req, res) => {
  const {
    recipient, responsible_person, holder_code,
    page = 1, page_size = 50
  } = req.query;

  const conditions = ['d.returned = 0', 'd.expected_return_date IS NOT NULL', "d.expected_return_date < datetime('now','localtime')"];
  const params = [];

  if (recipient) { conditions.push('d.recipient = ?'); params.push(recipient); }
  if (responsible_person) { conditions.push('bh.responsible_person = ?'); params.push(responsible_person); }
  if (holder_code) { conditions.push('bh.holder_code LIKE ?'); params.push('%' + holder_code + '%'); }

  const where = 'WHERE ' + conditions.join(' AND ');
  const limit = Math.min(parseInt(page_size) || 50, 200);
  const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

  try {
    db.transaction(() => syncTimeBasedExceptions(db))();

    const total = db.prepare(`
      SELECT COUNT(*) as cnt
      FROM dispatches d
      LEFT JOIN badge_holders bh ON bh.id = d.holder_id
      ${where}
    `).get(...params).cnt;

    const data = db.prepare(`
      SELECT
        d.id as dispatch_id,
        d.holder_id,
        d.holder_code,
        d.recipient,
        d.dispatch_date,
        d.purpose,
        d.expected_return_date,
        d.returned,
        bh.spec,
        bh.lanyard_type,
        bh.responsible_person,
        bh.status as holder_status,
        CAST((julianday('now','localtime') - julianday(d.expected_return_date)) AS INTEGER) as overdue_days,
        CAST((julianday('now','localtime') - julianday(d.expected_return_date)) * 24 AS INTEGER) as overdue_hours
      FROM dispatches d
      LEFT JOIN badge_holders bh ON bh.id = d.holder_id
      ${where}
      ORDER BY d.expected_return_date ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const withExtAndException = data.map(item => {
      const extensions = db.prepare(`
        SELECT * FROM dispatch_extensions
        WHERE dispatch_id = ?
        ORDER BY created_at DESC
      `).all(item.dispatch_id);

      const overdueException = db.prepare(`
        SELECT * FROM exception_records
        WHERE source_type = 'dispatch' AND source_id = ? AND exception_type = '逾期未归还'
        ORDER BY discovered_date DESC LIMIT 1
      `).get(item.dispatch_id);

      return {
        ...item,
        extensions,
        extension_count: extensions.length,
        pending_extension_count: extensions.filter(e => e.approval_status === '待审批').length,
        overdue_exception: overdueException
      };
    });

    res.json({ success: true, total, page: parseInt(page) || 1, page_size: limit, data: withExtAndException });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { extensionsRouter: router, getDispatchOverdueInfo };
