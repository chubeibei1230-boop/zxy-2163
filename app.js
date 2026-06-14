const express = require('express');
const path = require('path');

const holdersRoute = require('./routes/holders');
const dispatchesRoute = require('./routes/dispatches');
const recoveriesRoute = require('./routes/recoveries');
const { reviewsRouter, lossRouter } = require('./routes/reviews');
const statsRoute = require('./routes/stats');
const alertsRoute = require('./routes/alerts');
const { exceptionsRouter } = require('./routes/exceptions');
const { extensionsRouter } = require('./routes/extensions');
const { riskLedgerRouter } = require('./routes/riskLedger');
const { handoversRouter } = require('./routes/handovers');

const app = express();
const PORT = 8123;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

app.get('/', (req, res) => {
  res.json({
    name: '讲解牌夹管理系统',
    version: '1.0.0',
    port: PORT,
    endpoints: {
      holders: {
        'POST /api/holders/batch-import': '批次入库（需传operator）',
        'GET /api/holders': '多条件查询牌夹列表（支持batch_id）',
        'GET /api/holders/:id': '牌夹详情（含批次、配发/回收/复查/补记记录）',
        'PUT /api/holders/:id': '更新牌夹信息（改抽屉/规格时校验容量）',
        'GET /api/holders/drawers/list': '抽屉列表及使用情况',
        'GET /api/holders/batches/list': '入库批次列表',
        'GET /api/holders/batches/:id': '批次详情及包含的牌夹'
      },
      dispatches: {
        'POST /api/dispatches': '牌夹配发（仅待配发/可继续使用可配发）',
        'GET /api/dispatches': '配发记录列表',
        'GET /api/dispatches/:id': '配发详情'
      },
      recoveries: {
        'POST /api/recoveries': '牌夹回收（缺件自动进入缺件观察）',
        'GET /api/recoveries': '回收记录列表'
      },
      reviews: {
        'POST /api/reviews': '复查操作',
        'GET /api/reviews': '复查记录列表'
      },
      loss: {
        'POST /api/loss': '遗失补记',
        'GET /api/loss': '补记记录列表',
        'PUT /api/loss/:id/resolve': '标记补记为已解决'
      },
      stats: {
        'GET /api/stats/status-overview': '总览统计',
        'GET /api/stats/missing-parts-by-spec': '缺件高发规格排行',
        'GET /api/stats/recovery-delay-ranking': '回收滞后排行',
        'GET /api/stats/pending-review-list': '待复查清单'
      },
      alerts: {
        'GET /api/alerts/all': '所有异常概览',
        'GET /api/alerts/supplement-frequency': '补记频率异常',
        'GET /api/alerts/consecutive-losses': '同一责任人连续遗失',
        'GET /api/alerts/review-delays': '复查拖延',
        'GET /api/alerts/drawer-overcapacity': '抽屉容量偏满'
      },
      exceptions: {
        'GET /api/exceptions': '异常记录列表（多条件筛选）',
        'GET /api/exceptions/:id': '异常详情（含关联配发/回收/复查/补记）',
        'POST /api/exceptions/:id/handle': '异常处理登记（闭环处理）',
        'PUT /api/exceptions/:id': '更新异常信息',
        'GET /api/exceptions/stats/summary': '异常统计汇总',
        'GET /api/exceptions/todo/list': '异常待办清单',
        'GET /api/exceptions/sync/generate-time-based': '生成时间驱动异常（逾期、超时）'
      },
      extensions: {
        'POST /api/extensions': '创建延期归还申请',
        'POST /api/extensions/:id/approve': '审批通过延期申请',
        'POST /api/extensions/:id/reject': '审批驳回延期申请',
        'GET /api/extensions': '延期申请列表（多条件筛选）',
        'GET /api/extensions/:id': '延期申请详情（含该配发所有延期历史）',
        'GET /api/extensions/stats/summary': '延期申请统计汇总',
        'GET /api/extensions/overdue/list': '逾期牌夹列表（含逾期时长、延期历史、关联异常）'
      },
      risk_ledger: {
        'GET /api/risk-ledger': '风险台账清单（支持多条件筛选、按牌夹/领用人/责任人聚合、分页）',
        'GET /api/risk-ledger/:risk_key': '风险详情（含牌夹基础信息、配发/回收/复查/异常/延期历史及处理记录）',
        'POST /api/risk-ledger/:risk_key/handle': '登记风险处理结果（处理人、处理结果、处理备注、处理状态）',
        'GET /api/risk-ledger/stats/summary': '风险统计汇总（按类型、等级、处理状态、责任人、领用人、趋势）',
        'GET /api/risk-ledger/options/filters': '获取筛选下拉选项（风险类型、等级、责任人、领用人、牌夹状态）'
      },
      handovers: {
        'POST /api/handovers': '批量发起责任人交接（含风险提示，确认后执行）',
        'GET /api/handovers': '交接记录列表（多条件筛选，含牌夹明细）',
        'GET /api/handovers/:id': '交接详情（含每个牌夹当前状态及未闭环异常）',
        'GET /api/handovers/holder/:holder_id': '牌夹交接历史',
        'GET /api/handovers/stats/summary': '交接统计汇总（按责任人/规格/月份等汇总）',
        'GET /api/handovers/options/filters': '获取筛选下拉选项'
      }
    }
  });
});

app.use('/api/holders', holdersRoute);
app.use('/api/dispatches', dispatchesRoute);
app.use('/api/recoveries', recoveriesRoute);
app.use('/api/reviews', reviewsRouter);
app.use('/api/loss', lossRouter);
app.use('/api/stats', statsRoute);
app.use('/api/alerts', alertsRoute);
app.use('/api/exceptions', exceptionsRouter);
app.use('/api/extensions', extensionsRouter);
app.use('/api/risk-ledger', riskLedgerRouter);
app.use('/api/handovers', handoversRouter);

app.use((req, res) => {
  res.status(404).json({ error: '接口不存在', path: req.path });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`讲解牌夹管理系统已启动`);
  console.log(`服务地址: http://localhost:${PORT}`);
  console.log(`数据库文件: ${path.join(__dirname, 'data', 'badgeholders.db')}`);
});

module.exports = app;
