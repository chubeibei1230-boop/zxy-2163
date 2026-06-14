const express = require('express');
const path = require('path');

const holdersRoute = require('./routes/holders');
const dispatchesRoute = require('./routes/dispatches');
const recoveriesRoute = require('./routes/recoveries');
const { reviewsRouter, lossRouter } = require('./routes/reviews');
const statsRoute = require('./routes/stats');
const alertsRoute = require('./routes/alerts');

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
        'POST /api/holders/batch-import': '批次入库',
        'GET /api/holders': '多条件查询牌夹列表',
        'GET /api/holders/:id': '牌夹详情（含配发/回收/复查/补记记录）',
        'PUT /api/holders/:id': '更新牌夹信息',
        'GET /api/holders/drawers/list': '抽屉列表及使用情况'
      },
      dispatches: {
        'POST /api/dispatches': '牌夹配发（支持批量）',
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
