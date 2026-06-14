const express = require('express');
const db = require('../db');
const { syncTimeBasedExceptions } = require('./exceptions');

const router = express.Router();

const RISK_STATUSES = ['已配发', '缺件观察', '待复查'];

const assessHandoverRisk = (holder, txDb = db) => {
  const warnings = [];

  if (RISK_STATUSES.includes(holder.status)) {
    const reasons = {
      '已配发': '该牌夹当前处于已配发状态，存在未回收的配发记录，交接后新责任人将承担逾期归还等相关责任',
      '缺件观察': '该牌夹当前处于缺件观察状态，缺件问题尚未解决，交接后新责任人需跟进缺件处理',
      '待复查': '该牌夹当前处于待复查状态，复查尚未完成，交接后新责任人将承担复查相关责任'
    };
    warnings.push({
      type: '状态风险',
      level: holder.status === '已配发' ? '重要' : '一般',
      message: reasons[holder.status],
      detail: { holder_status: holder.status }
    });
  }

  const openExceptions = txDb.prepare(`
    SELECT id, exception_type, exception_level, status, description
    FROM exception_records
    WHERE holder_id = ? AND status != '已闭环'
    ORDER BY
      CASE exception_level WHEN '紧急' THEN 1 WHEN '重要' THEN 2 WHEN '一般' THEN 3 END,
      discovered_date DESC
  `).all(holder.id);

  if (openExceptions.length > 0) {
    warnings.push({
      type: '未闭环异常',
      level: '重要',
      message: `该牌夹存在 ${openExceptions.length} 条未闭环异常记录，交接后异常责任将转移至新责任人`,
      detail: {
        exception_count: openExceptions.length,
        exceptions: openExceptions.map(e => ({
          id: e.id,
          type: e.exception_type,
          level: e.exception_level,
          description: e.description
        }))
      }
    });
  }

  const unresolvedLoss = txDb.prepare(`
    SELECT id, loss_description, report_date
    FROM loss_supplements
    WHERE holder_id = ? AND is_resolved = 0
    ORDER BY report_date DESC
  `).all(holder.id);

  if (unresolvedLoss.length > 0) {
    warnings.push({
      type: '未解决遗失补记',
      level: '一般',
      message: `该牌夹存在 ${unresolvedLoss.length} 条未解决的遗失补记，交接后新责任人需跟进处理`,
      detail: {
        loss_count: unresolvedLoss.length,
        losses: unresolvedLoss.map(l => ({
          id: l.id,
          description: l.loss_description,
          report_date: l.report_date
        }))
      }
    });
  }

  return warnings;
};

router.post('/', (req, res) => {
  const {
    holder_ids, holder_codes,
    new_responsible_person, reason, notes, operator,
    risk_confirmed
  } = req.body;

  if (!new_responsible_person) {
    return res.status(400).json({ error: '新责任人 new_responsible_person 必填' });
  }
  if (!reason) {
    return res.status(400).json({ error: '交接原因 reason 必填' });
  }
  if (!operator) {
    return res.status(400).json({ error: '操作人 operator 必填' });
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
      let holders = [];
      if (targetIds.length > 0) {
        const placeholders = targetIds.map(() => '?').join(',');
        holders = db.prepare(
          `SELECT bh.*, d.drawer_code FROM badge_holders bh LEFT JOIN drawers d ON d.id = bh.drawer_id WHERE bh.id IN (${placeholders})`
        ).all(...targetIds);
      } else {
        const placeholders = targetCodes.map(() => '?').join(',');
        holders = db.prepare(
          `SELECT bh.*, d.drawer_code FROM badge_holders bh LEFT JOIN drawers d ON d.id = bh.drawer_id WHERE bh.holder_code IN (${placeholders})`
        ).all(...targetCodes);
      }

      const notFound = [];
      const idSet = new Set(holders.map(h => h.id));
      if (targetIds.length > 0) {
        for (const id of targetIds) {
          if (!idSet.has(id)) notFound.push({ holder_id: id, reason: '牌夹不存在' });
        }
      }
      if (targetCodes.length > 0) {
        const codeSet = new Set(holders.map(h => h.holder_code));
        for (const code of targetCodes) {
          if (!codeSet.has(code)) notFound.push({ holder_code: code, reason: '牌夹不存在' });
        }
      }

      const samePerson = [];
      const validHolders = holders.filter(h => {
        if (h.responsible_person === new_responsible_person) {
          samePerson.push({
            holder_id: h.id,
            holder_code: h.holder_code,
            reason: `当前责任人已是「${new_responsible_person}」，无需交接`
          });
          return false;
        }
        return true;
      });

      const holderRisks = [];
      for (const h of validHolders) {
        const warnings = assessHandoverRisk(h, db);
        if (warnings.length > 0) {
          holderRisks.push({
            holder_id: h.id,
            holder_code: h.holder_code,
            holder_status: h.status,
            warnings
          });
        }
      }

      const isConfirmed = risk_confirmed === true || risk_confirmed === 1 || risk_confirmed === 'true' || risk_confirmed === '1';

      if (holderRisks.length > 0 && !isConfirmed) {
        return {
          success: false,
          need_confirm: true,
          message: `本次交接涉及 ${holderRisks.length} 个牌夹存在风险提示，请确认后重新提交（risk_confirmed=true）`,
          risk_holders: holderRisks,
          not_found: notFound,
          same_person: samePerson
        };
      }

      const handoverCode = 'HO-' + Date.now();
      const riskWarningsJson = holderRisks.length > 0 ? JSON.stringify(holderRisks) : null;

      const insertHandover = db.prepare(`
        INSERT INTO handovers (handover_code, operator, new_responsible_person, reason, notes, risk_confirmed, risk_warnings, total_count, success_count, risk_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const handoverInfo = insertHandover.run(
        handoverCode, operator, new_responsible_person,
        reason, notes || null,
        isConfirmed ? 1 : 0,
        riskWarningsJson,
        validHolders.length, validHolders.length, holderRisks.length
      );
      const handoverId = handoverInfo.lastInsertRowid;

      const insertItem = db.prepare(`
        INSERT INTO handover_items (handover_id, holder_id, holder_code, spec, drawer_code, previous_responsible_person, new_responsible_person, holder_status, risk_warning)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updateHolder = db.prepare('UPDATE badge_holders SET responsible_person = ? WHERE id = ?');
      const updateException = db.prepare(`
        UPDATE exception_records SET responsible_person = ?, updated_at = datetime('now','localtime')
        WHERE holder_id = ? AND status != '已闭环'
      `);

      const items = [];
      for (const h of validHolders) {
        const warnings = assessHandoverRisk(h, db);
        const warningJson = warnings.length > 0 ? JSON.stringify(warnings) : null;

        insertItem.run(
          handoverId, h.id, h.holder_code, h.spec, h.drawer_code,
          h.responsible_person, new_responsible_person, h.status, warningJson
        );

        updateHolder.run(new_responsible_person, h.id);
        updateException.run(new_responsible_person, h.id);

        items.push({
          holder_id: h.id,
          holder_code: h.holder_code,
          spec: h.spec,
          drawer_code: h.drawer_code,
          previous_responsible_person: h.responsible_person,
          new_responsible_person,
          holder_status: h.status,
          has_risk: warnings.length > 0
        });
      }

      return {
        success: true,
        handover_id: handoverId,
        handover_code: handoverCode,
        operator,
        new_responsible_person,
        reason,
        total_count: validHolders.length,
        risk_count: holderRisks.length,
        items,
        not_found: notFound,
        same_person: samePerson
      };
    })();

    if (result.need_confirm) {
      return res.status(200).json(result);
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  const {
    holder_code, spec, drawer_code,
    previous_responsible_person, new_responsible_person,
    operator, start_date, end_date,
    has_risk, page = 1, page_size = 20
  } = req.query;

  const conditions = [];
  const params = [];

  if (holder_code || spec || drawer_code || previous_responsible_person || has_risk !== undefined) {
    const subConditions = [];
    if (holder_code) { subConditions.push('hi.holder_code LIKE ?'); params.push('%' + holder_code + '%'); }
    if (spec) { subConditions.push('hi.spec = ?'); params.push(spec); }
    if (drawer_code) { subConditions.push('hi.drawer_code = ?'); params.push(drawer_code); }
    if (previous_responsible_person) { subConditions.push('hi.previous_responsible_person = ?'); params.push(previous_responsible_person); }
    if (has_risk === 'true' || has_risk === '1') { subConditions.push('hi.risk_warning IS NOT NULL'); }

    const subWhere = subConditions.length > 0 ? 'WHERE ' + subConditions.join(' AND ') : '';
    conditions.push(`h.id IN (SELECT DISTINCT handover_id FROM handover_items hi ${subWhere})`);
  }

  if (new_responsible_person) { conditions.push('h.new_responsible_person = ?'); params.push(new_responsible_person); }
  if (operator) { conditions.push('h.operator = ?'); params.push(operator); }
  if (start_date) { conditions.push('h.created_at >= ?'); params.push(start_date); }
  if (end_date) { conditions.push('h.created_at <= ?'); params.push(end_date); }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const limit = Math.min(parseInt(page_size) || 20, 100);
  const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

  try {
    const total = db.prepare(`SELECT COUNT(*) as cnt FROM handovers h ${where}`).get(...params).cnt;

    const data = db.prepare(`
      SELECT h.* FROM handovers h
      ${where}
      ORDER BY h.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const withItems = data.map(h => {
      const items = db.prepare(`
        SELECT hi.* FROM handover_items hi WHERE hi.handover_id = ? ORDER BY hi.id
      `).all(h.id);
      return { ...h, items };
    });

    res.json({ success: true, total, page: parseInt(page) || 1, page_size: limit, data: withItems });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats/summary', (req, res) => {
  const { start_date, end_date } = req.query;

  const conditions = [];
  const params = [];
  if (start_date) { conditions.push('h.created_at >= ?'); params.push(start_date); }
  if (end_date) { conditions.push('h.created_at <= ?'); params.push(end_date); }
  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  try {
    const totalHandovers = db.prepare(`SELECT COUNT(*) as cnt FROM handovers h ${where}`).get(...params).cnt;

    const totalItems = db.prepare(`
      SELECT COUNT(*) as cnt FROM handover_items hi
      INNER JOIN handovers h ON h.id = hi.handover_id
      ${where}
    `).get(...params).cnt;

    const riskItems = db.prepare(`
      SELECT COUNT(*) as cnt FROM handover_items hi
      INNER JOIN handovers h ON h.id = hi.handover_id
      ${where.length > 0 ? where.replace('WHERE', 'WHERE') + ' AND' : 'WHERE'} hi.risk_warning IS NOT NULL
    `).get(...params).cnt;

    const byPreviousPerson = db.prepare(`
      SELECT hi.previous_responsible_person,
             COUNT(DISTINCT h.id) as handover_count,
             COUNT(hi.id) as item_count
      FROM handover_items hi
      INNER JOIN handovers h ON h.id = hi.handover_id
      ${where}
      GROUP BY hi.previous_responsible_person
      ORDER BY item_count DESC
    `).all(...params);

    const byNewPerson = db.prepare(`
      SELECT hi.new_responsible_person,
             COUNT(DISTINCT h.id) as handover_count,
             COUNT(hi.id) as item_count
      FROM handover_items hi
      INNER JOIN handovers h ON h.id = hi.handover_id
      ${where}
      GROUP BY hi.new_responsible_person
      ORDER BY item_count DESC
    `).all(...params);

    const byOperator = db.prepare(`
      SELECT h.operator,
             COUNT(*) as handover_count
      FROM handovers h
      ${where}
      GROUP BY h.operator
      ORDER BY handover_count DESC
    `).all(...params);

    const bySpec = db.prepare(`
      SELECT hi.spec,
             COUNT(hi.id) as item_count
      FROM handover_items hi
      INNER JOIN handovers h ON h.id = hi.handover_id
      ${where}
      GROUP BY hi.spec
      ORDER BY item_count DESC
    `).all(...params);

    const byMonth = db.prepare(`
      SELECT strftime('%Y-%m', h.created_at) as month,
             COUNT(*) as handover_count,
             SUM(h.total_count) as total_items,
             SUM(h.risk_count) as risk_items
      FROM handovers h
      ${where}
      GROUP BY strftime('%Y-%m', h.created_at)
      ORDER BY month DESC
    `).all(...params);

    const byHolderStatus = db.prepare(`
      SELECT hi.holder_status,
             COUNT(hi.id) as item_count
      FROM handover_items hi
      INNER JOIN handovers h ON h.id = hi.handover_id
      ${where}
      GROUP BY hi.holder_status
      ORDER BY item_count DESC
    `).all(...params);

    const personSummary = db.prepare(`
      SELECT person, role, handover_count, item_count FROM (
        SELECT hi.previous_responsible_person as person, '交接出' as role,
               COUNT(DISTINCT h.id) as handover_count,
               COUNT(hi.id) as item_count
        FROM handover_items hi
        INNER JOIN handovers h ON h.id = hi.handover_id
        ${where}
        GROUP BY hi.previous_responsible_person

        UNION ALL

        SELECT hi.new_responsible_person as person, '交接入' as role,
               COUNT(DISTINCT h.id) as handover_count,
               COUNT(hi.id) as item_count
        FROM handover_items hi
        INNER JOIN handovers h ON h.id = hi.handover_id
        ${where}
        GROUP BY hi.new_responsible_person
      )
      ORDER BY person, role
    `).all(...params);

    res.json({
      success: true,
      data: {
        total_handovers: totalHandovers,
        total_items: totalItems,
        risk_items: riskItems,
        risk_rate: totalItems > 0 ? Math.round(riskItems / totalItems * 100) / 100 : 0,
        by_previous_person: byPreviousPerson,
        by_new_person: byNewPerson,
        by_operator: byOperator,
        by_spec: bySpec,
        by_month: byMonth,
        by_holder_status: byHolderStatus,
        person_summary: personSummary
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/options/filters', (req, res) => {
  try {
    const previousPersons = db.prepare(`
      SELECT DISTINCT previous_responsible_person FROM handover_items
      WHERE previous_responsible_person IS NOT NULL AND previous_responsible_person != ''
      ORDER BY previous_responsible_person
    `).all().map(r => r.previous_responsible_person);

    const newPersons = db.prepare(`
      SELECT DISTINCT new_responsible_person FROM handover_items
      WHERE new_responsible_person IS NOT NULL AND new_responsible_person != ''
      ORDER BY new_responsible_person
    `).all().map(r => r.new_responsible_person);

    const operators = db.prepare(`
      SELECT DISTINCT operator FROM handovers
      WHERE operator IS NOT NULL AND operator != ''
      ORDER BY operator
    `).all().map(r => r.operator);

    const specs = db.prepare(`
      SELECT DISTINCT spec FROM handover_items
      WHERE spec IS NOT NULL AND spec != ''
      ORDER BY spec
    `).all().map(r => r.spec);

    const drawerCodes = db.prepare(`
      SELECT DISTINCT drawer_code FROM handover_items
      WHERE drawer_code IS NOT NULL AND drawer_code != ''
      ORDER BY drawer_code
    `).all().map(r => r.drawer_code);

    res.json({
      success: true,
      data: {
        previous_responsible_persons: previousPersons,
        new_responsible_persons: newPersons,
        operators,
        specs,
        drawer_codes: drawerCodes
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/holder/:holder_id', (req, res) => {
  const { page = 1, page_size = 20 } = req.query;
  const limit = Math.min(parseInt(page_size) || 20, 100);
  const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

  try {
    const holder = db.prepare('SELECT * FROM badge_holders WHERE id = ?').get(req.params.holder_id);
    if (!holder) return res.status(404).json({ error: '牌夹不存在' });

    const total = db.prepare(`
      SELECT COUNT(*) as cnt FROM handover_items WHERE holder_id = ?
    `).get(req.params.holder_id).cnt;

    const data = db.prepare(`
      SELECT hi.*, h.handover_code, h.operator, h.reason, h.notes as handover_notes, h.created_at as handover_created_at
      FROM handover_items hi
      INNER JOIN handovers h ON h.id = hi.handover_id
      WHERE hi.holder_id = ?
      ORDER BY hi.created_at DESC
      LIMIT ? OFFSET ?
    `).all(req.params.holder_id, limit, offset);

    res.json({ success: true, total, page: parseInt(page) || 1, page_size: limit, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const handover = db.prepare('SELECT * FROM handovers WHERE id = ?').get(req.params.id);
    if (!handover) return res.status(404).json({ error: '交接记录不存在' });

    const items = db.prepare(`
      SELECT hi.* FROM handover_items hi
      WHERE hi.handover_id = ?
      ORDER BY hi.id
    `).all(req.params.id);

    const enrichedItems = items.map(item => {
      const holder = db.prepare(`
        SELECT bh.*, d.drawer_code FROM badge_holders bh LEFT JOIN drawers d ON d.id = bh.drawer_id WHERE bh.id = ?
      `).get(item.holder_id);

      const currentExceptions = db.prepare(`
        SELECT id, exception_type, exception_level, status, description
        FROM exception_records
        WHERE holder_id = ? AND status != '已闭环'
        ORDER BY discovered_date DESC
      `).all(item.holder_id);

      const currentLoss = db.prepare(`
        SELECT id, loss_description, is_resolved
        FROM loss_supplements
        WHERE holder_id = ? AND is_resolved = 0
        ORDER BY report_date DESC
      `).all(item.holder_id);

      return {
        ...item,
        current_holder: holder,
        current_open_exceptions: currentExceptions,
        current_unresolved_loss: currentLoss
      };
    });

    res.json({
      success: true,
      handover,
      items: enrichedItems
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { handoversRouter: router };
