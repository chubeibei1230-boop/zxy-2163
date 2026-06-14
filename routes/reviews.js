const express = require('express');
const db = require('../db');
const { getOrCreateException, closeException } = require('./exceptions');

const router = express.Router();

const VALID_RESULTS = ['可继续使用', '缺件观察', '停用', '待整理'];
const VALID_RECOVERY_REVIEW_STATUSES = ['待复查', '复查通过', '复查不通过'];

router.post('/', (req, res) => {
  const { recovery_id, reviewer, review_result, review_notes } = req.body;

  if (!recovery_id || !reviewer || !review_result) {
    return res.status(400).json({ error: 'recovery_id、reviewer、review_result 必填' });
  }
  if (!VALID_RESULTS.includes(review_result)) {
    return res.status(400).json({ error: `review_result 必须是: ${VALID_RESULTS.join(', ')}` });
  }

  try {
    const result = db.transaction(() => {
      const recovery = db.prepare('SELECT * FROM recoveries WHERE id = ?').get(recovery_id);
      if (!recovery) return { error: '回收记录不存在' };
      if (recovery.review_status !== '待复查') {
        return { error: '该回收记录已复查，不能重复操作' };
      }

      const holder = db.prepare('SELECT * FROM badge_holders WHERE id = ?').get(recovery.holder_id);
      if (!holder) return { error: '牌夹数据异常' };

      const insertReview = db.prepare(`
        INSERT INTO reviews (recovery_id, holder_id, reviewer, review_result, review_notes)
        VALUES (?, ?, ?, ?, ?)
      `);

      const info = insertReview.run(recovery.id, holder.id, reviewer, review_result, review_notes || null);
      const recoveryReviewStatus = review_result === '可继续使用' ? '复查通过' : '复查不通过';
      db.prepare('UPDATE recoveries SET review_status = ? WHERE id = ?').run(recoveryReviewStatus, recovery.id);
      db.prepare('UPDATE badge_holders SET status = ? WHERE id = ?').run(review_result, holder.id);

      closeException('recovery', recovery.id, '复查超时', reviewer, `复查完成，结果：${review_result}`, review_notes, db);

      if (recovery.has_missing_parts) {
        if (review_result === '可继续使用' || review_result === '停用' || review_result === '待整理') {
          closeException('recovery', recovery.id, '缺件异常', reviewer, `复查后${review_result}`, review_notes, db);
        }
      }

      if (recovery.condition && recovery.condition !== '完好') {
        if (review_result === '可继续使用' || review_result === '停用' || review_result === '缺件观察') {
          closeException('recovery', recovery.id, '损坏异常', reviewer, `复查后${review_result}`, review_notes, db);
        }
      }

      return {
        success: true,
        review_id: info.lastInsertRowid,
        holder_id: holder.id,
        holder_code: holder.holder_code,
        new_status: review_result,
        message: `复查完成，牌夹状态已更新为「${review_result}」`
      };
    })();

    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  const { holder_id, reviewer, start_date, end_date, page = 1, page_size = 20 } = req.query;
  const conditions = [];
  const params = [];

  if (holder_id) { conditions.push('rv.holder_id = ?'); params.push(holder_id); }
  if (reviewer) { conditions.push('rv.reviewer = ?'); params.push(reviewer); }
  if (start_date) { conditions.push('rv.review_date >= ?'); params.push(start_date); }
  if (end_date) { conditions.push('rv.review_date <= ?'); params.push(end_date); }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const limit = Math.min(parseInt(page_size) || 20, 100);
  const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

  try {
    const total = db.prepare(`SELECT COUNT(*) as cnt FROM reviews rv ${where}`).get(...params).cnt;
    const data = db.prepare(`
      SELECT rv.*, bh.holder_code, bh.spec, bh.lanyard_type,
             r.condition as recovery_condition, r.has_missing_parts
      FROM reviews rv
      LEFT JOIN badge_holders bh ON bh.id = rv.holder_id
      LEFT JOIN recoveries r ON r.id = rv.recovery_id
      ${where}
      ORDER BY rv.review_date DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({ success: true, total, page: parseInt(page) || 1, page_size: limit, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const lossRouter = express.Router();

lossRouter.post('/', (req, res) => {
  const { holder_id, holder_code, reporter, loss_date, loss_description, supplement_notes } = req.body;

  if (!reporter || !loss_description) {
    return res.status(400).json({ error: 'reporter 和 loss_description 必填' });
  }
  if (!holder_id && !holder_code) {
    return res.status(400).json({ error: 'holder_id 或 holder_code 必须提供其一' });
  }

  try {
    const result = db.transaction(() => {
      let holder = null;
      if (holder_id) {
        holder = db.prepare('SELECT * FROM badge_holders WHERE id = ?').get(holder_id);
      } else if (holder_code) {
        holder = db.prepare('SELECT * FROM badge_holders WHERE holder_code = ?').get(holder_code);
      }

      const hid = holder ? holder.id : null;
      const hcode = holder ? holder.holder_code : (holder_code || null);

      const insert = db.prepare(`
        INSERT INTO loss_supplements (holder_id, holder_code, reporter, loss_date, loss_description, supplement_notes)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const info = insert.run(hid, hcode, reporter, loss_date || null, loss_description, supplement_notes || null);
      const supplementId = info.lastInsertRowid;

      if (holder && holder.status !== '停用') {
        db.prepare("UPDATE badge_holders SET status = '缺件观察' WHERE id = ?").run(holder.id);
      }

      getOrCreateException(
        hid, hcode, '遗失异常',
        'loss_supplement', supplementId,
        loss_description,
        holder ? holder.responsible_person : null,
        db
      );

      return {
        success: true,
        supplement_id: supplementId,
        holder_id: hid,
        holder_code: hcode,
        message: holder ? '补记成功，牌夹状态已更新为「缺件观察」' : '补记成功（牌夹不在库中，仅记录）'
      };
    })();

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

lossRouter.get('/', (req, res) => {
  const { holder_id, reporter, is_resolved, start_date, end_date, page = 1, page_size = 20 } = req.query;
  const conditions = [];
  const params = [];

  if (holder_id) { conditions.push('(ls.holder_id = ? OR ls.holder_code IN (SELECT holder_code FROM badge_holders WHERE id = ?))'); params.push(holder_id, holder_id); }
  if (reporter) { conditions.push('ls.reporter = ?'); params.push(reporter); }
  if (is_resolved !== undefined) {
    conditions.push('ls.is_resolved = ?');
    params.push(is_resolved === 'true' || is_resolved === '1' ? 1 : 0);
  }
  if (start_date) { conditions.push('ls.report_date >= ?'); params.push(start_date); }
  if (end_date) { conditions.push('ls.report_date <= ?'); params.push(end_date); }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const limit = Math.min(parseInt(page_size) || 20, 100);
  const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

  try {
    const total = db.prepare(`SELECT COUNT(*) as cnt FROM loss_supplements ls ${where}`).get(...params).cnt;
    const data = db.prepare(`
      SELECT ls.*, bh.spec, bh.lanyard_type, bh.status as holder_status, bh.responsible_person
      FROM loss_supplements ls
      LEFT JOIN badge_holders bh ON bh.id = ls.holder_id
      ${where}
      ORDER BY ls.report_date DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({ success: true, total, page: parseInt(page) || 1, page_size: limit, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

lossRouter.put('/:id/resolve', (req, res) => {
  const { resolved_notes, handler } = req.body;
  try {
    const rec = db.prepare('SELECT * FROM loss_supplements WHERE id = ?').get(req.params.id);
    if (!rec) return res.status(404).json({ error: '补记记录不存在' });
    if (rec.is_resolved === 1) return res.status(400).json({ error: '该记录已标记为已解决' });

    db.prepare('UPDATE loss_supplements SET is_resolved = 1, supplement_notes = COALESCE(?, supplement_notes) WHERE id = ?')
      .run(resolved_notes || null, req.params.id);

    closeException('loss_supplement', rec.id, '遗失异常', handler || null, '已解决', resolved_notes, db);

    res.json({ success: true, message: '已标记为解决' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { reviewsRouter: router, lossRouter };
