const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/supplement-frequency', (req, res) => {
  const { days = 30, threshold = 3 } = req.query;
  const daysVal = parseInt(days) || 30;
  const thresholdVal = parseInt(threshold) || 3;

  try {
    const data = db.prepare(`
      SELECT
        COALESCE(bh.responsible_person, ls.reporter) as responsible_person,
        COUNT(*) as supplement_count,
        MIN(ls.report_date) as first_date,
        MAX(ls.report_date) as last_date
      FROM loss_supplements ls
      LEFT JOIN badge_holders bh ON bh.id = ls.holder_id
      WHERE ls.report_date >= datetime('now','localtime', '-' || ? || ' days')
      GROUP BY COALESCE(bh.responsible_person, ls.reporter)
      HAVING supplement_count >= ?
      ORDER BY supplement_count DESC
    `).all(daysVal, thresholdVal);

    res.json({
      success: true,
      data,
      params: { days: daysVal, threshold: thresholdVal }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/consecutive-losses', (req, res) => {
  const { threshold = 2 } = req.query;
  const thresholdVal = parseInt(threshold) || 2;

  try {
    const supplements = db.prepare(`
      SELECT
        ls.id,
        ls.holder_id,
        ls.holder_code,
        ls.loss_date,
        ls.report_date,
        ls.loss_description,
        ls.is_resolved,
        ls.reporter,
        bh.responsible_person
      FROM loss_supplements ls
      LEFT JOIN badge_holders bh ON bh.id = ls.holder_id
      ORDER BY COALESCE(bh.responsible_person, ls.reporter), ls.report_date DESC
    `).all();

    const grouped = {};
    for (const s of supplements) {
      const key = s.responsible_person || s.reporter;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(s);
    }

    const result = [];
    for (const [person, list] of Object.entries(grouped)) {
      let consecutive = 0;
      let maxConsecutive = 0;
      const streak = [];

      for (let i = 0; i < list.length; i++) {
        if (list[i].is_resolved === 0) {
          consecutive++;
          streak.push(list[i]);
          maxConsecutive = Math.max(maxConsecutive, consecutive);
        } else {
          consecutive = 0;
          streak.length = 0;
        }
      }

      if (maxConsecutive >= thresholdVal) {
        result.push({
          responsible_person: person,
          consecutive_unresolved: maxConsecutive,
          total_supplements: list.length,
          recent_unresolved: streak.slice(0, 10)
        });
      }
    }

    result.sort((a, b) => b.consecutive_unresolved - a.consecutive_unresolved);

    res.json({
      success: true,
      data: result,
      params: { threshold: thresholdVal }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/review-delays', (req, res) => {
  const { hours = 24 } = req.query;
  const hoursVal = parseInt(hours) || 24;

  try {
    const data = db.prepare(`
      SELECT
        r.id as recovery_id,
        r.recovery_date,
        bh.id as holder_id,
        bh.holder_code,
        bh.spec,
        bh.lanyard_type,
        bh.responsible_person,
        d.recipient,
        d.dispatch_date,
        CAST((julianday('now','localtime') - julianday(r.recovery_date)) * 24 AS INTEGER) as delay_hours
      FROM recoveries r
      LEFT JOIN badge_holders bh ON bh.id = r.holder_id
      LEFT JOIN dispatches d ON d.id = r.dispatch_id
      WHERE r.review_status = '待复查'
        AND CAST((julianday('now','localtime') - julianday(r.recovery_date)) * 24 AS INTEGER) >= ?
      ORDER BY delay_hours DESC
    `).all(hoursVal);

    const byPerson = {};
    for (const d of data) {
      const key = d.responsible_person || '(未分配)';
      if (!byPerson[key]) byPerson[key] = { count: 0, total_delay: 0, items: [] };
      byPerson[key].count++;
      byPerson[key].total_delay += d.delay_hours;
      byPerson[key].items.push(d);
    }
    const summary = Object.entries(byPerson)
      .map(([person, info]) => ({
        responsible_person: person,
        pending_count: info.count,
        avg_delay_hours: Math.round(info.total_delay / info.count),
        max_delay_hours: Math.max(...info.items.map(i => i.delay_hours))
      }))
      .sort((a, b) => b.pending_count - a.pending_count);

    res.json({
      success: true,
      total_delayed: data.length,
      by_responsible_person: summary,
      details: data,
      params: { threshold_hours: hoursVal }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/drawer-overcapacity', (req, res) => {
  const { ratio = 0.8 } = req.query;
  const ratioVal = parseFloat(ratio) || 0.8;

  try {
    const drawers = db.prepare('SELECT * FROM drawers ORDER BY drawer_code').all();
    const result = [];

    for (const d of drawers) {
      const specUsage = db.prepare(`
        SELECT spec, COUNT(*) as count
        FROM badge_holders
        WHERE drawer_id = ? AND status != '停用'
        GROUP BY spec
      `).all(d.id);

      const overloaded = specUsage.filter(s => s.count >= d.capacity_per_spec * ratioVal);
      if (overloaded.length > 0) {
        result.push({
          drawer_id: d.id,
          drawer_code: d.drawer_code,
          capacity_per_spec: d.capacity_per_spec,
          threshold_ratio: ratioVal,
          threshold_count: Math.ceil(d.capacity_per_spec * ratioVal),
          overloaded_specs: overloaded.map(s => ({
            spec: s.spec,
            count: s.count,
            ratio: Math.round(s.count / d.capacity_per_spec * 100) / 100,
            remaining: d.capacity_per_spec - s.count
          }))
        });
      }
    }

    result.sort((a, b) => {
      const maxA = Math.max(...a.overloaded_specs.map(s => s.ratio));
      const maxB = Math.max(...b.overloaded_specs.map(s => s.ratio));
      return maxB - maxA;
    });

    res.json({
      success: true,
      overloaded_drawer_count: result.length,
      data: result,
      params: { threshold_ratio: ratioVal }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/all', (req, res) => {
  try {
    const result = {
      success: true,
      generated_at: new Date().toISOString(),
      alerts: {}
    };

    result.alerts.high_frequency_supplements = db.prepare(`
      SELECT
        COALESCE(bh.responsible_person, ls.reporter) as responsible_person,
        COUNT(*) as supplement_count
      FROM loss_supplements ls
      LEFT JOIN badge_holders bh ON bh.id = ls.holder_id
      WHERE ls.report_date >= datetime('now','localtime', '-30 days')
      GROUP BY COALESCE(bh.responsible_person, ls.reporter) HAVING supplement_count >= 3
      ORDER BY supplement_count DESC LIMIT 10
    `).all();

    const pendingReviews = db.prepare(`
      SELECT COUNT(*) as cnt,
             COALESCE(MAX(CAST((julianday('now','localtime') - julianday(recovery_date)) * 24 AS INTEGER)), 0) as max_delay_hours
      FROM recoveries WHERE review_status = '待复查'
    `).get();
    result.alerts.pending_reviews_over_24h = {
      count: pendingReviews.cnt,
      max_delay_hours: pendingReviews.max_delay_hours,
      needs_attention: pendingReviews.max_delay_hours >= 24
    };

    const drawers = db.prepare('SELECT * FROM drawers').all();
    let overloadedDrawerCount = 0;
    for (const d of drawers) {
      const cnt = db.prepare(`
        SELECT COUNT(*) as cnt FROM badge_holders
        WHERE drawer_id = ? AND status != '停用'
        GROUP BY spec HAVING COUNT(*) >= ? * 0.8
      `).all(d.id, d.capacity_per_spec);
      overloadedDrawerCount += cnt.length;
    }
    result.alerts.drawer_overcapacity = {
      overloaded_spec_slot_count: overloadedDrawerCount,
      threshold_ratio: 0.8
    };

    const exceptionSummary = db.prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = '待处理' THEN 1 ELSE 0 END), 0) as pending,
        COALESCE(SUM(CASE WHEN status = '处理中' THEN 1 ELSE 0 END), 0) as processing,
        COALESCE(SUM(CASE WHEN status = '已闭环' THEN 1 ELSE 0 END), 0) as closed
      FROM exception_records
    `).get();

    const exceptionsByType = db.prepare(`
      SELECT exception_type, exception_level, COUNT(*) as count,
             SUM(CASE WHEN status != '已闭环' THEN 1 ELSE 0 END) as open_count
      FROM exception_records
      GROUP BY exception_type, exception_level
      ORDER BY count DESC
    `).all();

    const recentExceptions = db.prepare(`
      SELECT er.*, bh.spec, bh.responsible_person
      FROM exception_records er
      LEFT JOIN badge_holders bh ON bh.id = er.holder_id
      WHERE er.status != '已闭环'
      ORDER BY
        CASE er.exception_level
          WHEN '紧急' THEN 1
          WHEN '重要' THEN 2
          WHEN '一般' THEN 3
        END,
        er.discovered_date ASC
      LIMIT 10
    `).all();

    result.alerts.exception_overview = {
      total: exceptionSummary.total,
      pending: exceptionSummary.pending,
      processing: exceptionSummary.processing,
      closed: exceptionSummary.closed,
      open_total: (exceptionSummary.pending || 0) + (exceptionSummary.processing || 0),
      close_rate: exceptionSummary.total > 0 ? Math.round(exceptionSummary.closed / exceptionSummary.total * 100) / 100 : 0,
      by_type: exceptionsByType,
      top_pending: recentExceptions
    };

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
