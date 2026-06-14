const express = require('express');
const db = require('../db');

const router = express.Router();

router.post('/', (req, res) => {
  const {
    dispatch_id, holder_id, holder_code,
    condition, damage_description,
    has_missing_parts, missing_parts_description
  } = req.body;

  if (!dispatch_id && !holder_id && !holder_code) {
    return res.status(400).json({ error: '必须提供 dispatch_id、holder_id 或 holder_code 之一' });
  }

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
        return { error: '该配发记录已经回收过' };
      }

      const holder = db.prepare('SELECT * FROM badge_holders WHERE id = ?').get(dispatch.holder_id);
      if (!holder) return { error: '牌夹数据异常' };

      const hasMissing = has_missing_parts === true || has_missing_parts === 1 || has_missing_parts === 'true' || has_missing_parts === '1';

      const insertRecovery = db.prepare(`
        INSERT INTO recoveries (
          dispatch_id, holder_id, holder_code,
          recovery_date, condition, damage_description,
          has_missing_parts, missing_parts_description, review_status
        ) VALUES (?, ?, ?, datetime('now','localtime'), ?, ?, ?, ?, '待复查')
      `);

      let newStatus;
      if (hasMissing) {
        newStatus = '缺件观察';
      } else {
        newStatus = '待复查';
      }

      const info = insertRecovery.run(
        dispatch.id, holder.id, holder.holder_code,
        condition || '完好',
        damage_description || null,
        hasMissing ? 1 : 0,
        missing_parts_description || null
      );

      db.prepare('UPDATE dispatches SET returned = 1 WHERE id = ?').run(dispatch.id);
      db.prepare('UPDATE badge_holders SET status = ? WHERE id = ?').run(newStatus, holder.id);

      return {
        success: true,
        recovery_id: info.lastInsertRowid,
        holder_id: holder.id,
        holder_code: holder.holder_code,
        new_status: newStatus,
        message: hasMissing ? '回收成功，因发现缺件已自动进入「缺件观察」状态' : '回收成功，请安排复查'
      };
    })();

    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  const { review_status, has_missing_parts, start_date, end_date, page = 1, page_size = 20 } = req.query;
  const conditions = [];
  const params = [];

  if (review_status) { conditions.push('r.review_status = ?'); params.push(review_status); }
  if (has_missing_parts !== undefined) {
    conditions.push('r.has_missing_parts = ?');
    params.push(has_missing_parts === 'true' || has_missing_parts === '1' ? 1 : 0);
  }
  if (start_date) { conditions.push('r.recovery_date >= ?'); params.push(start_date); }
  if (end_date) { conditions.push('r.recovery_date <= ?'); params.push(end_date); }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const limit = Math.min(parseInt(page_size) || 20, 100);
  const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

  try {
    const total = db.prepare(`SELECT COUNT(*) as cnt FROM recoveries r ${where}`).get(...params).cnt;
    const data = db.prepare(`
      SELECT r.*, bh.spec, bh.lanyard_type, bh.responsible_person,
             d.recipient, d.dispatch_date, d.purpose
      FROM recoveries r
      LEFT JOIN badge_holders bh ON bh.id = r.holder_id
      LEFT JOIN dispatches d ON d.id = r.dispatch_id
      ${where}
      ORDER BY r.recovery_date DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({ success: true, total, page: parseInt(page) || 1, page_size: limit, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
