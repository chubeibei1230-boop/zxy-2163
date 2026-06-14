const express = require('express');
const db = require('../db');

const router = express.Router();

router.post('/', (req, res) => {
  const { holder_ids, holder_codes, recipient, purpose, expected_return_date } = req.body;

  if (!recipient) {
    return res.status(400).json({ error: '领用人 recipient 必填' });
  }

  let targetIds = [];
  let targetCodes = [];

  if (Array.isArray(holder_ids) && holder_ids.length > 0) {
    targetIds = holder_ids;
  } else if (Array.isArray(holder_codes) && holder_codes.length > 0) {
    targetCodes = holder_codes;
  } else {
    return res.status(400).json({ error: 'holder_ids 或 holder_codes 必须提供非空数组' });
  }

  try {
    const result = db.transaction(() => {
      const dispatched = [];
      const failed = [];

      let holders = [];
      if (targetIds.length > 0) {
        const placeholders = targetIds.map(() => '?').join(',');
        holders = db.prepare(
          `SELECT * FROM badge_holders WHERE id IN (${placeholders})`
        ).all(...targetIds);
      } else {
        const placeholders = targetCodes.map(() => '?').join(',');
        holders = db.prepare(
          `SELECT * FROM badge_holders WHERE holder_code IN (${placeholders})`
        ).all(...targetCodes);
      }

      const idSet = new Set(holders.map(h => h.id));
      if (targetIds.length > 0 && holders.length !== targetIds.length) {
        for (const id of targetIds) {
          if (!idSet.has(id)) failed.push({ holder_id: id, reason: '牌夹不存在' });
        }
      }
      if (targetCodes.length > 0 && holders.length !== targetCodes.length) {
        const codeSet = new Set(holders.map(h => h.holder_code));
        for (const code of targetCodes) {
          if (!codeSet.has(code)) failed.push({ holder_code: code, reason: '牌夹不存在' });
        }
      }

      const insertDispatch = db.prepare(`
        INSERT INTO dispatches (holder_id, holder_code, recipient, purpose, expected_return_date, returned)
        VALUES (?, ?, ?, ?, ?, 0)
      `);
      const updateStatus = db.prepare("UPDATE badge_holders SET status = '已配发' WHERE id = ?");

      const DISPATCHABLE_STATUSES = ['待配发', '可继续使用'];

      for (const h of holders) {
        if (!DISPATCHABLE_STATUSES.includes(h.status)) {
          failed.push({ holder_id: h.id, holder_code: h.holder_code, reason: `牌夹状态为「${h.status}」，不可配发，仅「待配发」和「可继续使用」状态允许配发` });
          continue;
        }

        const activeDispatch = db.prepare(`
          SELECT COUNT(*) as cnt FROM dispatches WHERE holder_id = ? AND returned = 0
        `).get(h.id).cnt;
        if (activeDispatch > 0) {
          failed.push({ holder_id: h.id, holder_code: h.holder_code, reason: '牌夹存在未回收的配发记录，不能重复配发' });
          continue;
        }

        const info = insertDispatch.run(
          h.id, h.holder_code, recipient, purpose || null, expected_return_date || null
        );
        updateStatus.run(h.id);
        dispatched.push({
          dispatch_id: info.lastInsertRowid,
          holder_id: h.id,
          holder_code: h.holder_code
        });
      }

      return { dispatched, failed, dispatchedCount: dispatched.length, failedCount: failed.length };
    })();

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  const { returned, recipient, start_date, end_date, page = 1, page_size = 20 } = req.query;
  const conditions = [];
  const params = [];

  if (returned !== undefined) {
    conditions.push('d.returned = ?');
    params.push(returned === 'true' || returned === '1' ? 1 : 0);
  }
  if (recipient) { conditions.push('d.recipient = ?'); params.push(recipient); }
  if (start_date) { conditions.push('d.dispatch_date >= ?'); params.push(start_date); }
  if (end_date) { conditions.push('d.dispatch_date <= ?'); params.push(end_date); }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const limit = Math.min(parseInt(page_size) || 20, 100);
  const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

  try {
    const total = db.prepare(`SELECT COUNT(*) as cnt FROM dispatches d ${where}`).get(...params).cnt;
    const data = db.prepare(`
      SELECT d.*, bh.spec, bh.lanyard_type, bh.responsible_person
      FROM dispatches d
      LEFT JOIN badge_holders bh ON bh.id = d.holder_id
      ${where}
      ORDER BY d.dispatch_date DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({ success: true, total, page: parseInt(page) || 1, page_size: limit, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const dispatch = db.prepare(`
      SELECT d.*, bh.spec, bh.lanyard_type, bh.responsible_person, bh.status as holder_status
      FROM dispatches d
      LEFT JOIN badge_holders bh ON bh.id = d.holder_id
      WHERE d.id = ?
    `).get(req.params.id);

    if (!dispatch) return res.status(404).json({ error: '配发记录不存在' });

    const recovery = db.prepare(`
      SELECT * FROM recoveries WHERE dispatch_id = ?
    `).get(req.params.id);

    res.json({ success: true, dispatch, recovery });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
