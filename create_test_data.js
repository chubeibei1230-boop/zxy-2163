const db = require('./db');

const result = db.transaction(() => {
  const holders = db.prepare("SELECT * FROM badge_holders WHERE status = '可继续使用' LIMIT 1").all();
  if (holders.length === 0) return { error: '没有可配发的牌夹' };

  const holder = holders[0];

  const dispatchInfo = db.prepare(`
    INSERT INTO dispatches (holder_id, holder_code, recipient, purpose, expected_return_date, returned)
    VALUES (?, ?, '测试领用人', '测试用途', datetime('now','localtime','-5 days'), 0)
  `).run(holder.id, holder.holder_code);

  db.prepare("UPDATE badge_holders SET status = '已配发' WHERE id = ?").run(holder.id);

  const recoveryInfo = db.prepare(`
    INSERT INTO recoveries (dispatch_id, holder_id, holder_code, recovery_date, condition, review_status, has_missing_parts)
    VALUES (?, ?, ?, datetime('now','localtime','-2 days'), '完好', '待复查', 0)
  `).run(dispatchInfo.lastInsertRowid, holder.id, holder.holder_code);

  db.prepare("UPDATE badge_holders SET status = '已回收' WHERE id = ?").run(holder.id);

  const lossException = db.prepare(`
    INSERT INTO exception_records (
      holder_id, holder_code, exception_type, exception_level,
      source_type, source_id, status, responsible_person, description
    ) VALUES (?, ?, '遗失异常', '重要', 'loss_supplement', 999, '待处理', ?, '测试遗失异常')
  `).run(holder.id, holder.holder_code, holder.responsible_person);

  return {
    holder_id: holder.id,
    holder_code: holder.holder_code,
    dispatch_id: dispatchInfo.lastInsertRowid,
    recovery_id: recoveryInfo.lastInsertRowid,
    exception_id: lossException.lastInsertRowid
  };
})();

console.log('测试数据创建结果:', JSON.stringify(result, null, 2));
