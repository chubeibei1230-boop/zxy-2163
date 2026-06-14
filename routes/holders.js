const express = require('express');
const db = require('../db');

const router = express.Router();

const VALID_STATUSES = [
  '待配发', '已配发', '待整理', '待复查',
  '可继续使用', '缺件观察', '停用'
];

router.post('/batch-import', (req, res) => {
  const { holders, operator, batch_notes } = req.body;
  if (!Array.isArray(holders) || holders.length === 0) {
    return res.status(400).json({ error: 'holders 必须是非空数组' });
  }
  if (!operator) {
    return res.status(400).json({ error: 'operator 入库操作人必填' });
  }

  const requiredFields = ['holder_code', 'spec', 'lanyard_type', 'drawer_code', 'responsible_person'];
  for (const h of holders) {
    for (const f of requiredFields) {
      if (!h[f]) return res.status(400).json({ error: `缺少必填字段: ${f}` });
    }
  }

  try {
    const result = db.transaction(() => {
      const inserted = [];
      const failed = [];

      const batchCode = 'BATCH-' + Date.now();
      const insertBatch = db.prepare(`
        INSERT INTO import_batches (batch_code, operator, total_count, success_count, fail_count, notes)
        VALUES (?, ?, ?, 0, 0, ?)
      `);
      const batchInfo = insertBatch.run(batchCode, operator, holders.length, batch_notes || null);
      const batchId = batchInfo.lastInsertRowid;

      const getDrawer = db.prepare('SELECT * FROM drawers WHERE drawer_code = ?');
      const countInDrawer = db.prepare(
        'SELECT COUNT(*) as cnt FROM badge_holders WHERE drawer_id = ? AND spec = ? AND status != ?'
      );
      const checkCode = db.prepare('SELECT COUNT(*) as cnt FROM badge_holders WHERE holder_code = ?');
      const insertHolder = db.prepare(`
        INSERT INTO badge_holders (holder_code, spec, lanyard_type, drawer_id, responsible_person, status, batch_id)
        VALUES (?, ?, ?, ?, ?, '待配发', ?)
      `);

      for (const h of holders) {
        if (checkCode.get(h.holder_code).cnt > 0) {
          failed.push({ holder_code: h.holder_code, reason: '牌夹编号已存在' });
          continue;
        }

        const drawer = getDrawer.get(h.drawer_code);
        if (!drawer) {
          failed.push({ holder_code: h.holder_code, reason: `抽屉 ${h.drawer_code} 不存在` });
          continue;
        }

        const current = countInDrawer.get(drawer.id, h.spec, '停用').cnt;
        if (current + 1 > drawer.capacity_per_spec) {
          failed.push({
            holder_code: h.holder_code,
            reason: `抽屉 ${h.drawer_code} 中规格 ${h.spec} 已达容量上限 ${drawer.capacity_per_spec}`
          });
          continue;
        }

        const info = insertHolder.run(
          h.holder_code, h.spec, h.lanyard_type, drawer.id, h.responsible_person, batchId
        );
        inserted.push({ id: info.lastInsertRowid, holder_code: h.holder_code });
      }

      db.prepare(`
        UPDATE import_batches SET success_count = ?, fail_count = ? WHERE id = ?
      `).run(inserted.length, failed.length, batchId);

      return {
        batch_id: batchId,
        batch_code: batchCode,
        inserted, failed, insertedCount: inserted.length, failedCount: failed.length
      };
    })();

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  const {
    spec, lanyard_type, responsible_person, status,
    start_date, end_date, has_missing_parts, batch_id, page = 1, page_size = 20
  } = req.query;

  const conditions = [];
  const params = [];

  if (spec) { conditions.push('bh.spec = ?'); params.push(spec); }
  if (lanyard_type) { conditions.push('bh.lanyard_type = ?'); params.push(lanyard_type); }
  if (responsible_person) { conditions.push('bh.responsible_person = ?'); params.push(responsible_person); }
  if (status) { conditions.push('bh.status = ?'); params.push(status); }
  if (start_date) { conditions.push('bh.created_at >= ?'); params.push(start_date); }
  if (end_date) { conditions.push('bh.created_at <= ?'); params.push(end_date); }
  if (batch_id) { conditions.push('bh.batch_id = ?'); params.push(batch_id); }

  let joinSql = '';
  if (has_missing_parts !== undefined) {
    joinSql = `LEFT JOIN recoveries r ON r.holder_id = bh.id AND r.has_missing_parts = 1`;
    if (has_missing_parts === 'true' || has_missing_parts === '1') {
      conditions.push('r.id IS NOT NULL');
    } else {
      conditions.push('r.id IS NULL');
    }
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const limit = Math.min(parseInt(page_size) || 20, 100);
  const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

  try {
    const countSql = `SELECT COUNT(DISTINCT bh.id) as cnt FROM badge_holders bh ${joinSql} ${where}`;
    const total = db.prepare(countSql).get(...params).cnt;

    const dataSql = `
      SELECT bh.*, d.drawer_code
      FROM badge_holders bh
      LEFT JOIN drawers d ON d.id = bh.drawer_id
      ${joinSql.includes('recoveries') ? joinSql : ''}
      ${where}
      GROUP BY bh.id
      ORDER BY bh.id DESC
      LIMIT ? OFFSET ?
    `;
    const data = db.prepare(dataSql).all(...params, limit, offset);

    res.json({ success: true, total, page: parseInt(page) || 1, page_size: limit, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const holder = db.prepare(`
      SELECT bh.*, d.drawer_code, ib.batch_code, ib.operator as batch_operator, ib.created_at as batch_created_at, ib.notes as batch_notes
      FROM badge_holders bh
      LEFT JOIN drawers d ON d.id = bh.drawer_id
      LEFT JOIN import_batches ib ON ib.id = bh.batch_id
      WHERE bh.id = ?
    `).get(req.params.id);

    if (!holder) return res.status(404).json({ error: '牌夹不存在' });

    const dispatches = db.prepare(`
      SELECT * FROM dispatches WHERE holder_id = ? ORDER BY dispatch_date DESC
    `).all(req.params.id);

    const recoveries = db.prepare(`
      SELECT * FROM recoveries WHERE holder_id = ? ORDER BY recovery_date DESC
    `).all(req.params.id);

    const reviews = db.prepare(`
      SELECT * FROM reviews WHERE holder_id = ? ORDER BY review_date DESC
    `).all(req.params.id);

    const supplements = db.prepare(`
      SELECT * FROM loss_supplements WHERE holder_id = ? OR holder_code = ? ORDER BY report_date DESC
    `).all(req.params.id, holder.holder_code);

    res.json({ success: true, holder, dispatches, recoveries, reviews, supplements });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  const { spec, lanyard_type, drawer_code, responsible_person, status } = req.body;
  try {
    const existing = db.prepare('SELECT * FROM badge_holders WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: '牌夹不存在' });

    const newSpec = spec || existing.spec;
    let newDrawerId = existing.drawer_id;
    let newDrawer = null;

    if (drawer_code) {
      newDrawer = db.prepare('SELECT * FROM drawers WHERE drawer_code = ?').get(drawer_code);
      if (!newDrawer) return res.status(400).json({ error: '抽屉不存在' });
      newDrawerId = newDrawer.id;
    } else {
      newDrawer = db.prepare('SELECT * FROM drawers WHERE id = ?').get(existing.drawer_id);
    }

    const drawerChanged = newDrawerId !== existing.drawer_id;
    const specChanged = spec && spec !== existing.spec;

    if (drawerChanged || specChanged) {
      const countInDrawer = db.prepare(
        'SELECT COUNT(*) as cnt FROM badge_holders WHERE drawer_id = ? AND spec = ? AND status != ? AND id != ?'
      );
      const current = countInDrawer.get(newDrawerId, newSpec, '停用', existing.id).cnt;
      if (current + 1 > newDrawer.capacity_per_spec) {
        return res.status(400).json({
          error: `抽屉 ${newDrawer.drawer_code} 中规格 ${newSpec} 已达容量上限 ${newDrawer.capacity_per_spec}，当前 ${current} 个，无法放入`
        });
      }
    }

    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `状态无效，必须是: ${VALID_STATUSES.join(', ')}` });
    }

    db.prepare(`
      UPDATE badge_holders SET
        spec = COALESCE(?, spec),
        lanyard_type = COALESCE(?, lanyard_type),
        drawer_id = COALESCE(?, drawer_id),
        responsible_person = COALESCE(?, responsible_person),
        status = COALESCE(?, status)
      WHERE id = ?
    `).run(spec, lanyard_type, newDrawerId, responsible_person, status, req.params.id);

    res.json({ success: true, message: '更新成功' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/drawers/list', (req, res) => {
  try {
    const drawers = db.prepare('SELECT * FROM drawers ORDER BY drawer_code').all();
    const withStats = drawers.map(d => {
      const stats = db.prepare(`
        SELECT spec, COUNT(*) as count
        FROM badge_holders
        WHERE drawer_id = ? AND status != '停用'
        GROUP BY spec
      `).all(d.id);
      return { ...d, usage: stats };
    });
    res.json({ success: true, data: withStats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/batches/list', (req, res) => {
  const { operator, start_date, end_date, page = 1, page_size = 20 } = req.query;
  const conditions = [];
  const params = [];

  if (operator) { conditions.push('ib.operator = ?'); params.push(operator); }
  if (start_date) { conditions.push('ib.created_at >= ?'); params.push(start_date); }
  if (end_date) { conditions.push('ib.created_at <= ?'); params.push(end_date); }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const limit = Math.min(parseInt(page_size) || 20, 100);
  const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

  try {
    const total = db.prepare(`SELECT COUNT(*) as cnt FROM import_batches ib ${where}`).get(...params).cnt;
    const data = db.prepare(`
      SELECT ib.* FROM import_batches ib
      ${where}
      ORDER BY ib.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({ success: true, total, page: parseInt(page) || 1, page_size: limit, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/batches/:id', (req, res) => {
  try {
    const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(req.params.id);
    if (!batch) return res.status(404).json({ error: '批次不存在' });

    const holders = db.prepare(`
      SELECT bh.*, d.drawer_code
      FROM badge_holders bh
      LEFT JOIN drawers d ON d.id = bh.drawer_id
      WHERE bh.batch_id = ?
      ORDER BY bh.id
    `).all(req.params.id);

    res.json({ success: true, batch, holders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
