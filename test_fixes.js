const http = require('http');

function doRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'localhost',
      port: 8123,
      path,
      method,
      headers: bodyStr ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      } : {}
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function test() {
  console.log('=== 测试 1: 风险类型列表（验证无重复） ===');
  const list = await doRequest('GET', '/api/risk-ledger?page_size=20');
  const types = [...new Set(list.data.map(r => r.risk_type))];
  console.log('风险类型:', types);
  console.log('总数:', list.total);

  console.log('\n=== 测试 2: 风险列表包含的字段（验证延期/回收/异常信息） ===');
  if (list.data.length > 0) {
    const first = list.data[0];
    console.log('有 extension_info:', first.extension_info !== undefined);
    console.log('extension_info 字段:', Object.keys(first.extension_info || {}));
    console.log('有 recovery_info:', first.recovery_info !== undefined);
    console.log('recovery_info 字段:', first.recovery_info ? Object.keys(first.recovery_info) : 'null');
    console.log('有 exception_info:', first.exception_info !== undefined);
    console.log('exception_info 字段:', Object.keys(first.exception_info || {}));
  }

  console.log('\n=== 测试 3: 待复查风险是否有 dispatch_id ===');
  const reviewRisks = list.data.filter(r => r.risk_type === '待复查');
  if (reviewRisks.length > 0) {
    console.log('待复查风险数:', reviewRisks.length);
    console.log('第一条dispatch_id:', reviewRisks[0].dispatch_id);
    console.log('dispatch_id存在:', !!reviewRisks[0].dispatch_id);
  } else {
    console.log('(当前无待复查风险)');
  }

  console.log('\n=== 测试 4: 风险详情（验证补充信息） ===');
  if (list.data.length > 0) {
    const detail = await doRequest('GET', `/api/risk-ledger/${list.data[0].risk_key}`);
    console.log('有 extension_info:', detail.risk.extension_info !== undefined);
    console.log('有 recovery_info:', detail.risk.recovery_info !== undefined);
    console.log('有 exception_info:', detail.risk.exception_info !== undefined);
  }

  console.log('\n=== 测试 5: 未闭环异常同步关闭 ===');
  const exceptionRisks = list.data.filter(r => r.risk_type === '未闭环异常');
  if (exceptionRisks.length > 0) {
    const excRisk = exceptionRisks[0];
    console.log('处理前异常状态（风险列表中）:', excRisk.exception_info);
    console.log('处理前异常状态（详情中）:', excRisk.exception_status || excRisk.exception_info?.latest_exception_status);
    
    const handleResult = await doRequest('POST', `/api/risk-ledger/${excRisk.risk_key}/handle`, {
      handler: '测试管理员',
      handle_result: '已核实并解决',
      handle_notes: '经核实，异常已处理完毕',
      handle_status: '已闭环'
    });
    console.log('处理登记结果:', handleResult.success ? '成功' : '失败');
    
    const afterDetail = await doRequest('GET', `/api/risk-ledger/${excRisk.risk_key}`);
    console.log('处理后风险handle_status:', afterDetail.risk.handle_status);
    console.log('处理后关联异常最新状态:', afterDetail.risk.exception_info.latest_exception_status);
    
    const exceptionDetail = await doRequest('GET', `/api/exceptions/${excRisk.exception_id || excRisk.exception_info.latest_exception_id}`);
    console.log('异常记录实际状态:', exceptionDetail.exception?.status || '未找到');
  } else {
    console.log('(当前无未闭环异常风险，跳过此测试)');
  }

  console.log('\n=== 所有测试完成 ===');
}

test().catch(console.error);
