const express = require('express');
const db = require('../db');
const { syncTimeBasedExceptions } = require('./exceptions');

const router = express.Router();

const VALID_RISK_TYPES = [
  '当前未归还',
  '逾期未归还',
  '延期申请待审批',
  '待复查',
  '缺件观察',
  '未闭环异常'
];

const VALID_HANDLE_STATUSES = ['待处理', '处理中', '已闭环'];

const RISK_LEVEL_MAP = {
  '逾期未归还': '重要',
  '未闭环异常': '重要',
  '延期申请待审批': '一般',
  '待复查': '一般',
  '缺件观察': '一般',
  '当前未归还': '一般'
};

const buildRiskFilters = (query) => {
  const {
    risk_type, risk_level, responsible_person, recipient,
    holder_status, holder_code, start_date, end_date
  } = query;

  const conditions = [];
  const params = [];

  if (risk_type) {
    if (Array.isArray(risk_type)) {
      const placeholders = risk_type.map(() => '?').join(',');
      conditions.push(`r.risk_type IN (${placeholders})`);
      params.push(...risk_type);
    } else {
      conditions.push('r.risk_type = ?');
      params.push(risk_type);
    }
  }
  if (risk_level) {
    conditions.push('r.risk_level = ?');
    params.push(risk_level);
  }
  if (responsible_person) {
    conditions.push('r.responsible_person = ?');
    params.push(responsible_person);
  }
  if (recipient) {
    conditions.push('r.recipient = ?');
    params.push(recipient);
  }
  if (holder_status) {
    conditions.push('r.holder_status = ?');
    params.push(holder_status);
  }
  if (holder_code) {
    conditions.push('r.holder_code LIKE ?');
    params.push('%' + holder_code + '%');
  }
  if (start_date) {
    conditions.push('r.risk_date >= ?');
    params.push(start_date);
  }
  if (end_date) {
    conditions.push('r.risk_date <= ?');
    params.push(end_date);
  }

  return {
    where: conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '',
    params
  };
};

const collectAllRisks = (txDb = db) => {
  txDb.transaction(() => syncTimeBasedExceptions(txDb))();

  const risks = [];

  const unreturnedDispatches = txDb.prepare(`
    SELECT
      d.id as dispatch_id,
      d.holder_id,
      d.holder_code,
      d.recipient,
      d.dispatch_date,
      d.purpose,
      d.expected_return_date,
      bh.spec,
      bh.lanyard_type,
      bh.responsible_person,
      bh.status as holder_status,
      bh.drawer_id,
      dr.drawer_code
    FROM dispatches d
    LEFT JOIN badge_holders bh ON bh.id = d.holder_id
    LEFT JOIN drawers dr ON dr.id = bh.drawer_id
    WHERE d.returned = 0
    ORDER BY d.dispatch_date ASC
  `).all();

  for (const d of unreturnedDispatches) {
    const isOverdue = d.expected_return_date
      && new Date(d.expected_return_date) < new Date();

    if (isOverdue) {
      const overdueDays = Math.floor(
        (Date.now() - new Date(d.expected_return_date).getTime()) / (1000 * 60 * 60 * 24)
      );
      risks.push({
        risk_key: `overdue_${d.dispatch_id}`,
        risk_type: '逾期未归还',
        risk_level: '重要',
        risk_date: d.expected_return_date,
        holder_id: d.holder_id,
        holder_code: d.holder_code,
        spec: d.spec,
        lanyard_type: d.lanyard_type,
        responsible_person: d.responsible_person,
        recipient: d.recipient,
        holder_status: d.holder_status,
        drawer_id: d.drawer_id,
        drawer_code: d.drawer_code,
        dispatch_id: d.dispatch_id,
        dispatch_date: d.dispatch_date,
        purpose: d.purpose,
        expected_return_date: d.expected_return_date,
        overdue_days: overdueDays,
        risk_description: `牌夹已逾期 ${overdueDays} 天未归还，领用人: ${d.recipient}`
      });
    } else {
      const daysRemaining = d.expected_return_date
        ? Math.ceil((new Date(d.expected_return_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        : null;
      risks.push({
        risk_key: `unreturned_${d.dispatch_id}`,
        risk_type: '当前未归还',
        risk_level: '一般',
        risk_date: d.dispatch_date,
        holder_id: d.holder_id,
        holder_code: d.holder_code,
        spec: d.spec,
        lanyard_type: d.lanyard_type,
        responsible_person: d.responsible_person,
        recipient: d.recipient,
        holder_status: d.holder_status,
        drawer_id: d.drawer_id,
        drawer_code: d.drawer_code,
        dispatch_id: d.dispatch_id,
        dispatch_date: d.dispatch_date,
        purpose: d.purpose,
        expected_return_date: d.expected_return_date,
        days_remaining: daysRemaining,
        risk_description: d.expected_return_date
          ? `牌夹借用中，距预计归还还有 ${daysRemaining} 天，领用人: ${d.recipient}`
          : `牌夹借用中（未设归还时间），领用人: ${d.recipient}`
      });
    }
  }

  const pendingExtensions = txDb.prepare(`
    SELECT
      de.id as extension_id,
      de.dispatch_id,
      de.holder_id,
      de.holder_code,
      de.applicant,
      de.extension_reason,
      de.original_expected_return_date,
      de.new_expected_return_date,
      de.created_at,
      d.recipient,
      d.dispatch_date,
      d.purpose,
      bh.spec,
      bh.lanyard_type,
      bh.responsible_person,
      bh.status as holder_status
    FROM dispatch_extensions de
    LEFT JOIN dispatches d ON d.id = de.dispatch_id
    LEFT JOIN badge_holders bh ON bh.id = de.holder_id
    WHERE de.approval_status = '待审批'
    ORDER BY de.created_at ASC
  `).all();

  for (const e of pendingExtensions) {
    risks.push({
      risk_key: `extension_${e.extension_id}`,
      risk_type: '延期申请待审批',
      risk_level: '一般',
      risk_date: e.created_at,
      holder_id: e.holder_id,
      holder_code: e.holder_code,
      spec: e.spec,
      lanyard_type: e.lanyard_type,
      responsible_person: e.responsible_person,
      recipient: e.recipient,
      holder_status: e.holder_status,
      dispatch_id: e.dispatch_id,
      dispatch_date: e.dispatch_date,
      purpose: e.purpose,
      extension_id: e.extension_id,
      extension_applicant: e.applicant,
      extension_reason: e.extension_reason,
      original_expected_return_date: e.original_expected_return_date,
      new_expected_return_date: e.new_expected_return_date,
      risk_description: `延期申请待审批，申请人: ${e.applicant}，延期原因: ${e.extension_reason}`
    });
  }

  const pendingReviews = txDb.prepare(`
    SELECT
      r.id as recovery_id,
      r.holder_id,
      r.holder_code,
      r.dispatch_id,
      r.recovery_date,
      r.condition,
      r.damage_description,
      r.has_missing_parts,
      r.missing_parts_description,
      r.review_status,
      d.recipient,
      d.dispatch_date,
      d.purpose,
      d.expected_return_date,
      bh.spec,
      bh.lanyard_type,
      bh.responsible_person,
      bh.status as holder_status,
      CAST((julianday('now','localtime') - julianday(r.recovery_date)) * 24 AS INTEGER) as delay_hours
    FROM recoveries r
    LEFT JOIN dispatches d ON d.id = r.dispatch_id
    LEFT JOIN badge_holders bh ON bh.id = r.holder_id
    WHERE r.review_status = '待复查'
    ORDER BY r.recovery_date ASC
  `).all();

  for (const r of pendingReviews) {
    risks.push({
      risk_key: `review_${r.recovery_id}`,
      risk_type: '待复查',
      risk_level: r.delay_hours >= 24 ? '重要' : '一般',
      risk_date: r.recovery_date,
      holder_id: r.holder_id,
      holder_code: r.holder_code,
      spec: r.spec,
      lanyard_type: r.lanyard_type,
      responsible_person: r.responsible_person,
      recipient: r.recipient,
      holder_status: r.holder_status,
      recovery_id: r.recovery_id,
      recovery_date: r.recovery_date,
      recovery_condition: r.condition,
      has_missing_parts: r.has_missing_parts,
      missing_parts_description: r.missing_parts_description,
      review_delay_hours: r.delay_hours,
      dispatch_id: r.dispatch_id ? r.dispatch_id : null,
      dispatch_date: r.dispatch_date,
      expected_return_date: r.expected_return_date,
      risk_description: r.delay_hours >= 24
        ? `回收后已超过 ${r.delay_hours} 小时未复查，回收状态: ${r.condition}`
        : `待复查，已回收 ${r.delay_hours} 小时，回收状态: ${r.condition}`
    });
  }

  const missingPartsHolders = txDb.prepare(`
    SELECT
      bh.id as holder_id,
      bh.holder_code,
      bh.spec,
      bh.lanyard_type,
      bh.responsible_person,
      bh.status as holder_status,
      bh.created_at as holder_created_at,
      dr.drawer_code,
      r.id as recovery_id,
      r.recovery_date,
      r.missing_parts_description,
      d.recipient,
      d.dispatch_date
    FROM badge_holders bh
    LEFT JOIN drawers dr ON dr.id = bh.drawer_id
    LEFT JOIN recoveries r ON r.holder_id = bh.id AND r.has_missing_parts = 1
    LEFT JOIN dispatches d ON d.id = r.dispatch_id
    WHERE bh.status = '缺件观察'
    ORDER BY r.recovery_date ASC
  `).all();

  for (const h of missingPartsHolders) {
    const days = h.recovery_date
      ? Math.floor((Date.now() - new Date(h.recovery_date).getTime()) / (1000 * 60 * 60 * 24))
      : 0;
    risks.push({
      risk_key: `missing_${h.holder_id}`,
      risk_type: '缺件观察',
      risk_level: '一般',
      risk_date: h.recovery_date || h.holder_created_at,
      holder_id: h.holder_id,
      holder_code: h.holder_code,
      spec: h.spec,
      lanyard_type: h.lanyard_type,
      responsible_person: h.responsible_person,
      recipient: h.recipient,
      holder_status: h.holder_status,
      drawer_code: h.drawer_code,
      recovery_id: h.recovery_id,
      recovery_date: h.recovery_date,
      missing_parts_description: h.missing_parts_description,
      missing_days: days,
      risk_description: `缺件观察中，已持续 ${days} 天，${h.missing_parts_description || '缺件详情待补充'}`
    });
  }

  const openExceptions = txDb.prepare(`
    SELECT
      er.id as exception_id,
      er.holder_id,
      er.holder_code,
      er.exception_type,
      er.exception_level,
      er.source_type,
      er.source_id,
      er.status,
      er.responsible_person,
      er.discovered_date,
      er.description,
      bh.spec,
      bh.lanyard_type,
      bh.status as holder_status,
      d.recipient,
      d.dispatch_date,
      d.expected_return_date
    FROM exception_records er
    LEFT JOIN badge_holders bh ON bh.id = er.holder_id
    LEFT JOIN dispatches d ON d.id = er.source_id AND er.source_type = 'dispatch'
    WHERE er.status != '已闭环'
      AND er.exception_type NOT IN ('逾期未归还', '缺件异常', '复查超时')
    ORDER BY
      CASE er.exception_level WHEN '紧急' THEN 1 WHEN '重要' THEN 2 WHEN '一般' THEN 3 END,
      er.discovered_date ASC
  `).all();

  for (const e of openExceptions) {
    const days = Math.floor(
      (Date.now() - new Date(e.discovered_date).getTime()) / (1000 * 60 * 60 * 24)
    );
    risks.push({
      risk_key: `exception_${e.exception_id}`,
      risk_type: '未闭环异常',
      risk_level: e.exception_level || '一般',
      risk_date: e.discovered_date,
      holder_id: e.holder_id,
      holder_code: e.holder_code,
      spec: e.spec,
      lanyard_type: e.lanyard_type,
      responsible_person: e.responsible_person,
      recipient: e.recipient,
      holder_status: e.holder_status,
      exception_id: e.exception_id,
      exception_type: e.exception_type,
      exception_status: e.status,
      source_type: e.source_type,
      source_id: e.source_id,
      exception_description: e.description,
      exception_open_days: days,
      risk_description: `未闭环异常「${e.exception_type}」已 ${days} 天，${e.description || ''}`
    });
  }

  return risks;
};

const attachHandleInfo = (risks, txDb = db) => {
  if (risks.length === 0) return risks;

  const keys = risks.map(r => r.risk_key);
  const placeholders = keys.map(() => '?').join(',');

  const handleRecords = txDb.prepare(`
    SELECT * FROM risk_ledger_handles
    WHERE risk_key IN (${placeholders})
    ORDER BY updated_at DESC
  `).all(...keys);

  const handleMap = {};
  for (const h of handleRecords) {
    if (!handleMap[h.risk_key]) {
      handleMap[h.risk_key] = {
        latest_handle: h,
        handle_history: [h]
      };
    } else {
      handleMap[h.risk_key].handle_history.push(h);
    }
  }

  return risks.map(r => {
    const handle = handleMap[r.risk_key];
    return {
      ...r,
      handle_status: handle ? handle.latest_handle.handle_status : '待处理',
      handler: handle ? handle.latest_handle.handler : null,
      handle_result: handle ? handle.latest_handle.handle_result : null,
      handle_notes: handle ? handle.latest_handle.handle_notes : null,
      latest_handle_at: handle ? handle.latest_handle.updated_at : null,
      handle_count: handle ? handle.handle_history.length : 0,
      handle_history: handle ? handle.handle_history : []
    };
  });
};

const enrichRisksWithRelatedInfo = (risks, txDb = db) => {
  if (risks.length === 0) return risks;

  const holderIds = risks.filter(r => r.holder_id).map(r => r.holder_id);
  const uniqueHolderIds = [...new Set(holderIds)];
  if (uniqueHolderIds.length === 0) return risks;

  const placeholders = uniqueHolderIds.map(() => '?').join(',');

  const extStats = txDb.prepare(`
    SELECT holder_id,
           COUNT(*) as total,
           SUM(CASE WHEN approval_status = '待审批' THEN 1 ELSE 0 END) as pending,
           SUM(CASE WHEN approval_status = '已通过' THEN 1 ELSE 0 END) as approved,
           SUM(CASE WHEN approval_status = '已驳回' THEN 1 ELSE 0 END) as rejected
    FROM dispatch_extensions
    WHERE holder_id IN (${placeholders})
    GROUP BY holder_id
  `).all(...uniqueHolderIds);

  const extMap = {};
  for (const e of extStats) extMap[e.holder_id] = e;

  const recoveryInfo = txDb.prepare(`
    SELECT r.holder_id,
           r.id as recovery_id,
           r.recovery_date,
           r.condition,
           r.review_status,
           r.has_missing_parts,
           rv.id as review_id,
           rv.review_date,
           rv.review_result,
           rv.reviewer
    FROM recoveries r
    LEFT JOIN reviews rv ON rv.recovery_id = r.id
    WHERE r.holder_id IN (${placeholders})
    ORDER BY r.recovery_date DESC
  `).all(...uniqueHolderIds);

  const recoveryMap = {};
  for (const r of recoveryInfo) {
    if (!recoveryMap[r.holder_id]) recoveryMap[r.holder_id] = r;
  }

  const exceptionStats = txDb.prepare(`
    SELECT holder_id,
           COUNT(*) as total_count,
           SUM(CASE WHEN status != '已闭环' THEN 1 ELSE 0 END) as open_count,
           MAX(CASE WHEN status != '已闭环' THEN discovered_date ELSE NULL END) as latest_open_date
    FROM exception_records
    WHERE holder_id IN (${placeholders})
    GROUP BY holder_id
  `).all(...uniqueHolderIds);

  const excMap = {};
  for (const e of exceptionStats) excMap[e.holder_id] = e;

  const latestExceptions = txDb.prepare(`
    SELECT er.holder_id, er.id as exception_id, er.exception_type, er.status, er.discovered_date
    FROM exception_records er
    INNER JOIN (
      SELECT holder_id, MAX(id) as max_id
      FROM exception_records
      WHERE holder_id IN (${placeholders})
      GROUP BY holder_id
    ) latest ON latest.holder_id = er.holder_id AND latest.max_id = er.id
  `).all(...uniqueHolderIds);

  const latestExcMap = {};
  for (const e of latestExceptions) latestExcMap[e.holder_id] = e;

  return risks.map(r => {
    const holderId = r.holder_id;
    const ext = extMap[holderId];
    const rec = recoveryMap[holderId];
    const excStat = excMap[holderId];
    const latestExc = latestExcMap[holderId];

    return {
      ...r,
      extension_info: ext ? {
        total: ext.total,
        pending: ext.pending,
        approved: ext.approved,
        rejected: ext.rejected,
        has_pending: ext.pending > 0
      } : { total: 0, pending: 0, approved: 0, rejected: 0, has_pending: false },
      recovery_info: rec ? {
        recovery_id: rec.recovery_id,
        recovery_date: rec.recovery_date,
        condition: rec.condition,
        review_status: rec.review_status,
        has_missing_parts: rec.has_missing_parts,
        latest_review: rec.review_id ? {
          review_id: rec.review_id,
          review_date: rec.review_date,
          review_result: rec.review_result,
          reviewer: rec.reviewer
        } : null
      } : null,
      exception_info: excStat ? {
        total_count: excStat.total_count,
        open_count: excStat.open_count,
        latest_open_date: excStat.latest_open_date,
        latest_exception_type: latestExc ? latestExc.exception_type : null,
        latest_exception_status: latestExc ? latestExc.status : null,
        latest_exception_id: latestExc ? latestExc.exception_id : null,
        has_open: excStat.open_count > 0
      } : { total_count: 0, open_count: 0, latest_open_date: null, latest_exception_type: null, latest_exception_status: null, latest_exception_id: null, has_open: false }
    };
  });
};

router.get('/', (req, res) => {
  const {
    page = 1, page_size = 20,
    group_by = 'list',
    sort_by = 'priority'
  } = req.query;

  const { where, params } = buildRiskFilters(req.query);
  const limit = Math.min(parseInt(page_size) || 20, 200);
  const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

  try {
    const allRisks = collectAllRisks(db);
    const withHandle = attachHandleInfo(allRisks, db);
    const enriched = enrichRisksWithRelatedInfo(withHandle, db);

    enriched.sort((a, b) => {
      if (sort_by === 'date') {
        return new Date(b.risk_date) - new Date(a.risk_date);
      }
      const levelOrder = { '紧急': 0, '重要': 1, '一般': 2 };
      const statusOrder = { '待处理': 0, '处理中': 1, '已闭环': 2 };
      const la = levelOrder[a.risk_level] ?? 3;
      const lb = levelOrder[b.risk_level] ?? 3;
      if (la !== lb) return la - lb;
      const sa = statusOrder[a.handle_status] ?? 3;
      const sb = statusOrder[b.handle_status] ?? 3;
      if (sa !== sb) return sa - sb;
      return new Date(a.risk_date) - new Date(b.risk_date);
    });

    const filterFn = (item) => {
      for (let i = 0; i < params.length; i++) {
        const p = params[i];
      }
      if (req.query.risk_type) {
        const types = Array.isArray(req.query.risk_type) ? req.query.risk_type : [req.query.risk_type];
        if (!types.includes(item.risk_type)) return false;
      }
      if (req.query.risk_level && item.risk_level !== req.query.risk_level) return false;
      if (req.query.responsible_person && item.responsible_person !== req.query.responsible_person) return false;
      if (req.query.recipient && item.recipient !== req.query.recipient) return false;
      if (req.query.holder_status && item.holder_status !== req.query.holder_status) return false;
      if (req.query.holder_code && !item.holder_code.includes(req.query.holder_code)) return false;
      if (req.query.start_date && item.risk_date < req.query.start_date) return false;
      if (req.query.end_date && item.risk_date > req.query.end_date) return false;
      return true;
    };

    const filtered = enriched.filter(filterFn);
    const total = filtered.length;
    const pageData = filtered.slice(offset, offset + limit);

    if (group_by === 'holder') {
      const grouped = {};
      for (const r of filtered) {
        const key = r.holder_id || r.holder_code;
        if (!grouped[key]) {
          grouped[key] = {
            holder_id: r.holder_id,
            holder_code: r.holder_code,
            spec: r.spec,
            lanyard_type: r.lanyard_type,
            responsible_person: r.responsible_person,
            holder_status: r.holder_status,
            risk_count: 0,
            risk_types: new Set(),
            risk_levels: new Set(),
            items: []
          };
        }
        grouped[key].risk_count++;
        grouped[key].risk_types.add(r.risk_type);
        grouped[key].risk_levels.add(r.risk_level);
        grouped[key].items.push(r);
      }
      const result = Object.values(grouped).map(g => ({
        ...g,
        risk_types: Array.from(g.risk_types),
        risk_levels: Array.from(g.risk_levels),
        has_important: g.risk_levels.has('重要') || g.risk_levels.has('紧急')
      }));
      result.sort((a, b) => {
        if (a.has_important && !b.has_important) return -1;
        if (!a.has_important && b.has_important) return 1;
        return b.risk_count - a.risk_count;
      });
      const groupedPage = result.slice(offset, offset + limit);
      return res.json({
        success: true,
        total: result.length,
        page: parseInt(page) || 1,
        page_size: limit,
        group_by: 'holder',
        data: groupedPage
      });
    }

    if (group_by === 'recipient') {
      const grouped = {};
      for (const r of filtered) {
        if (!r.recipient) continue;
        const key = r.recipient;
        if (!grouped[key]) {
          grouped[key] = {
            recipient: key,
            risk_count: 0,
            risk_types: new Set(),
            risk_levels: new Set(),
            items: []
          };
        }
        grouped[key].risk_count++;
        grouped[key].risk_types.add(r.risk_type);
        grouped[key].risk_levels.add(r.risk_level);
        grouped[key].items.push(r);
      }
      const result = Object.values(grouped).map(g => ({
        ...g,
        risk_types: Array.from(g.risk_types),
        risk_levels: Array.from(g.risk_levels),
        has_important: g.risk_levels.has('重要') || g.risk_levels.has('紧急')
      }));
      result.sort((a, b) => {
        if (a.has_important && !b.has_important) return -1;
        if (!a.has_important && b.has_important) return 1;
        return b.risk_count - a.risk_count;
      });
      const groupedPage = result.slice(offset, offset + limit);
      return res.json({
        success: true,
        total: result.length,
        page: parseInt(page) || 1,
        page_size: limit,
        group_by: 'recipient',
        data: groupedPage
      });
    }

    if (group_by === 'responsible_person') {
      const grouped = {};
      for (const r of filtered) {
        if (!r.responsible_person) continue;
        const key = r.responsible_person;
        if (!grouped[key]) {
          grouped[key] = {
            responsible_person: key,
            risk_count: 0,
            risk_types: new Set(),
            risk_levels: new Set(),
            items: []
          };
        }
        grouped[key].risk_count++;
        grouped[key].risk_types.add(r.risk_type);
        grouped[key].risk_levels.add(r.risk_level);
        grouped[key].items.push(r);
      }
      const result = Object.values(grouped).map(g => ({
        ...g,
        risk_types: Array.from(g.risk_types),
        risk_levels: Array.from(g.risk_levels),
        has_important: g.risk_levels.has('重要') || g.risk_levels.has('紧急')
      }));
      result.sort((a, b) => {
        if (a.has_important && !b.has_important) return -1;
        if (!a.has_important && b.has_important) return 1;
        return b.risk_count - a.risk_count;
      });
      const groupedPage = result.slice(offset, offset + limit);
      return res.json({
        success: true,
        total: result.length,
        page: parseInt(page) || 1,
        page_size: limit,
        group_by: 'responsible_person',
        data: groupedPage
      });
    }

    res.json({
      success: true,
      total,
      page: parseInt(page) || 1,
      page_size: limit,
      group_by: 'list',
      data: pageData
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:risk_key', (req, res) => {
  try {
    const allRisks = collectAllRisks(db);
    const withHandle = attachHandleInfo(allRisks, db);
    const enriched = enrichRisksWithRelatedInfo(withHandle, db);

    const risk = enriched.find(r => r.risk_key === req.params.risk_key);
    if (!risk) {
      return res.status(404).json({ error: '风险记录不存在' });
    }

    const relatedData = {};

    if (risk.holder_id) {
      relatedData.holder = db.prepare(`
        SELECT bh.*, dr.drawer_code, ib.batch_code
        FROM badge_holders bh
        LEFT JOIN drawers dr ON dr.id = bh.drawer_id
        LEFT JOIN import_batches ib ON ib.id = bh.batch_id
        WHERE bh.id = ?
      `).get(risk.holder_id);

      relatedData.latest_dispatch = db.prepare(`
        SELECT * FROM dispatches WHERE holder_id = ? ORDER BY dispatch_date DESC LIMIT 1
      `).get(risk.holder_id);

      relatedData.latest_recovery = db.prepare(`
        SELECT r.*, d.recipient, d.dispatch_date
        FROM recoveries r
        LEFT JOIN dispatches d ON d.id = r.dispatch_id
        WHERE r.holder_id = ?
        ORDER BY r.recovery_date DESC LIMIT 1
      `).get(risk.holder_id);

      if (relatedData.latest_recovery) {
        relatedData.latest_review = db.prepare(`
          SELECT * FROM reviews WHERE recovery_id = ? ORDER BY review_date DESC LIMIT 1
        `).get(relatedData.latest_recovery.id);
      }

      relatedData.all_exceptions = db.prepare(`
        SELECT * FROM exception_records
        WHERE holder_id = ? OR holder_code = ?
        ORDER BY discovered_date DESC
      `).all(risk.holder_id, risk.holder_code);

      relatedData.all_extensions = db.prepare(`
        SELECT de.*, d.recipient
        FROM dispatch_extensions de
        LEFT JOIN dispatches d ON d.id = de.dispatch_id
        WHERE de.holder_id = ?
        ORDER BY de.created_at DESC
      `).all(risk.holder_id);
    }

    relatedData.handle_history = db.prepare(`
      SELECT * FROM risk_ledger_handles
      WHERE risk_key = ?
      ORDER BY created_at DESC
    `).all(req.params.risk_key);

    res.json({
      success: true,
      risk,
      related: relatedData
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:risk_key/handle', (req, res) => {
  const { handler, handle_result, handle_notes, handle_status } = req.body;

  if (!handler) {
    return res.status(400).json({ error: '处理人 handler 必填' });
  }
  if (handle_status && !VALID_HANDLE_STATUSES.includes(handle_status)) {
    return res.status(400).json({
      error: `handle_status 必须是: ${VALID_HANDLE_STATUSES.join(', ')}`
    });
  }

  try {
    const result = db.transaction(() => {
      const allRisks = collectAllRisks(db);
      const risk = allRisks.find(r => r.risk_key === req.params.risk_key);

      if (!risk) {
        return { error: '风险记录不存在或已消除' };
      }

      const finalStatus = handle_status || (handle_result ? '已闭环' : '处理中');

      const info = db.prepare(`
        INSERT INTO risk_ledger_handles (
          risk_key, holder_id, holder_code, risk_type,
          handle_result, handler, handle_notes, handle_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.params.risk_key,
        risk.holder_id || null,
        risk.holder_code,
        risk.risk_type,
        handle_result || null,
        handler,
        handle_notes || null,
        finalStatus
      );

      if (finalStatus === '已闭环' && risk.risk_type === '未闭环异常' && risk.exception_id) {
        db.prepare(`
          UPDATE exception_records SET
            status = '已闭环',
            handler = COALESCE(?, handler),
            handle_date = datetime('now','localtime'),
            handle_result = COALESCE(?, handle_result),
            handle_notes = COALESCE(?, handle_notes),
            updated_at = datetime('now','localtime')
          WHERE id = ?
        `).run(handler || null, handle_result || null, handle_notes || null, risk.exception_id);
      }

      if (finalStatus === '已闭环' && risk.risk_type === '逾期未归还' && risk.dispatch_id) {
        db.prepare(`
          UPDATE exception_records SET
            status = '已闭环',
            handler = COALESCE(?, handler),
            handle_date = datetime('now','localtime'),
            handle_result = COALESCE(?, handle_result),
            handle_notes = COALESCE(?, handle_notes),
            updated_at = datetime('now','localtime')
          WHERE source_type = 'dispatch'
            AND source_id = ?
            AND exception_type = '逾期未归还'
            AND status != '已闭环'
        `).run(handler || null, handle_result || null, handle_notes || null, risk.dispatch_id);
      }

      if (finalStatus === '已闭环' && risk.risk_type === '延期申请待审批' && risk.extension_id) {
        db.prepare(`
          UPDATE dispatch_extensions SET
            approval_status = '已驳回',
            approver = COALESCE(?, approver),
            approval_notes = COALESCE(?, approval_notes),
            approval_date = datetime('now','localtime'),
            updated_at = datetime('now','localtime')
          WHERE id = ?
        `).run(handler || null, handle_notes || null, risk.extension_id);
      }

      if (finalStatus === '已闭环' && risk.risk_type === '待复查' && risk.recovery_id) {
        const recovery = db.prepare('SELECT * FROM recoveries WHERE id = ?').get(risk.recovery_id);
        if (recovery && recovery.review_status === '待复查') {
          const reviewResult = '可继续使用';
          db.prepare(`
            INSERT INTO reviews (recovery_id, holder_id, reviewer, review_result, review_notes)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            recovery.id,
            recovery.holder_id,
            handler,
            reviewResult,
            handle_notes || handle_result || '风险台账闭环处理'
          );

          db.prepare("UPDATE recoveries SET review_status = '复查通过' WHERE id = ?").run(recovery.id);
          db.prepare('UPDATE badge_holders SET status = ? WHERE id = ?').run(reviewResult, recovery.holder_id);

          for (const exceptionType of ['复查超时', '缺件异常', '损坏异常']) {
            db.prepare(`
              UPDATE exception_records SET
                status = '已闭环',
                handler = COALESCE(?, handler),
                handle_date = datetime('now','localtime'),
                handle_result = COALESCE(?, handle_result),
                handle_notes = COALESCE(?, handle_notes),
                updated_at = datetime('now','localtime')
              WHERE source_type = 'recovery'
                AND source_id = ?
                AND exception_type = ?
                AND status != '已闭环'
            `).run(handler || null, handle_result || `复查完成，结果：${reviewResult}`, handle_notes || null, recovery.id, exceptionType);
          }
        }
      }

      const record = db.prepare('SELECT * FROM risk_ledger_handles WHERE id = ?').get(info.lastInsertRowid);

      return {
        success: true,
        handle_record: record,
        risk_key: req.params.risk_key
      };
    })();

    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats/summary', (req, res) => {
  try {
    const allRisks = collectAllRisks(db);
    const withHandle = attachHandleInfo(allRisks, db);
    const enriched = enrichRisksWithRelatedInfo(withHandle, db);

    const total = enriched.length;

    const byType = {};
    const byLevel = { '紧急': 0, '重要': 0, '一般': 0 };
    const byHandleStatus = { '待处理': 0, '处理中': 0, '已闭环': 0 };
    const byResponsiblePerson = {};
    const byRecipient = {};

    for (const r of enriched) {
      if (!byType[r.risk_type]) {
        byType[r.risk_type] = { count: 0, pending: 0, processing: 0, closed: 0 };
      }
      byType[r.risk_type].count++;
      if (r.handle_status === '待处理') byType[r.risk_type].pending++;
      else if (r.handle_status === '处理中') byType[r.risk_type].processing++;
      else if (r.handle_status === '已闭环') byType[r.risk_type].closed++;

      if (byLevel[r.risk_level] !== undefined) byLevel[r.risk_level]++;

      if (byHandleStatus[r.handle_status] !== undefined) byHandleStatus[r.handle_status]++;

      if (r.responsible_person) {
        if (!byResponsiblePerson[r.responsible_person]) {
          byResponsiblePerson[r.responsible_person] = { count: 0, important: 0 };
        }
        byResponsiblePerson[r.responsible_person].count++;
        if (r.risk_level === '重要' || r.risk_level === '紧急') {
          byResponsiblePerson[r.responsible_person].important++;
        }
      }

      if (r.recipient) {
        if (!byRecipient[r.recipient]) {
          byRecipient[r.recipient] = { count: 0, important: 0 };
        }
        byRecipient[r.recipient].count++;
        if (r.risk_level === '重要' || r.risk_level === '紧急') {
          byRecipient[r.recipient].important++;
        }
      }
    }

    const byTypeList = Object.entries(byType)
      .map(([type, info]) => ({ risk_type: type, ...info }))
      .sort((a, b) => b.count - a.count);

    const topResponsiblePersons = Object.entries(byResponsiblePerson)
      .map(([person, info]) => ({ responsible_person: person, ...info }))
      .sort((a, b) => b.important - a.important || b.count - a.count)
      .slice(0, 10);

    const topRecipients = Object.entries(byRecipient)
      .map(([person, info]) => ({ recipient: person, ...info }))
      .sort((a, b) => b.important - a.important || b.count - a.count)
      .slice(0, 10);

    const pendingCount = byHandleStatus['待处理'];
    const processingCount = byHandleStatus['处理中'];
    const closedCount = byHandleStatus['已闭环'];
    const openCount = pendingCount + processingCount;

    const trendData = {};
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      trendData[dateStr] = { date: dateStr, total: 0, new_risks: 0 };
    }

    for (const r of enriched) {
      const riskDate = (r.risk_date || '').split(' ')[0].split('T')[0];
      if (trendData[riskDate]) {
        trendData[riskDate].new_risks++;
      }
      for (const k of Object.keys(trendData)) {
        if (riskDate <= k) trendData[k].total++;
      }
    }

    const trendList = Object.values(trendData);

    res.json({
      success: true,
      data: {
        total,
        open_count: openCount,
        pending_count: pendingCount,
        processing_count: processingCount,
        closed_count: closedCount,
        close_rate: total > 0 ? Math.round(closedCount / total * 100) / 100 : 0,
        important_count: byLevel['重要'] + byLevel['紧急'],
        by_level: byLevel,
        by_handle_status: byHandleStatus,
        by_type: byTypeList,
        top_responsible_persons: topResponsiblePersons,
        top_recipients: topRecipients,
        recent_trend: trendList
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/options/filters', (req, res) => {
  try {
    const responsiblePersons = db.prepare(`
      SELECT DISTINCT responsible_person FROM badge_holders
      WHERE responsible_person IS NOT NULL AND responsible_person != ''
      ORDER BY responsible_person
    `).all().map(r => r.responsible_person);

    const recipients = db.prepare(`
      SELECT DISTINCT recipient FROM dispatches
      WHERE recipient IS NOT NULL AND recipient != ''
      ORDER BY recipient
    `).all().map(r => r.recipient);

    const holderStatuses = db.prepare(`
      SELECT DISTINCT status FROM badge_holders
      WHERE status IS NOT NULL AND status != ''
      ORDER BY status
    `).all().map(r => r.status);

    res.json({
      success: true,
      data: {
        risk_types: VALID_RISK_TYPES,
        risk_levels: ['紧急', '重要', '一般'],
        handle_statuses: VALID_HANDLE_STATUSES,
        responsible_persons: responsiblePersons,
        recipients: recipients,
        holder_statuses: holderStatuses
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { riskLedgerRouter: router };
