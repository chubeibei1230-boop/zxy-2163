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
  console.log('=== 测试 1: 风险类型列表（验证6种类型） ===');
  const list = await doRequest('GET', '/api/risk-ledger?page_size=50');
  const types = [...new Set(list.data.map(r => r.risk_type))];
  console.log('风险类型:', types);
  console.log('总数:', list.total);

  console.log('\n=== 测试 2: 待复查风险包含 dispatch_id ===');
  const reviewRisks = list.data.filter(r => r.risk_type === '待复查');
  if (reviewRisks.length > 0) {
    console.log('待复查风险数:', reviewRisks.length);
    console.log('第一条:', {
      risk_key: reviewRisks[0].risk_key,
      holder_code: reviewRisks[0].holder_code,
      recovery_id: reviewRisks[0].recovery_id,
      dispatch_id: reviewRisks[0].dispatch_id
    });
    console.log('dispatch_id 存在:', !!reviewRisks[0].dispatch_id);
  } else {
    console.log('无待复查风险');
  }

  console.log('\n=== 测试 3: 未闭环异常类型（验证排除了逾期/缺件/复查超时） ===');
  const excRisks = list.data.filter(r => r.risk_type === '未闭环异常');
  if (excRisks.length > 0) {
    const excTypes = [...new Set(excRisks.map(r => r.exception_type))];
    console.log('未闭环异常包含的异常类型:', excTypes);
    console.log('是否包含逾期未归还:', excTypes.includes('逾期未归还'));
    console.log('是否包含缺件异常:', excTypes.includes('缺件异常'));
    console.log('是否包含复查超时:', excTypes.includes('复查超时'));
  } else {
    console.log('无未闭环异常风险');
  }

  console.log('\n=== 测试 4: 每条风险都有 extension_info / recovery_info / exception_info ===');
  const hasExt = list.data.every(r => r.extension_info !== undefined);
  const hasRec = list.data.every(r => r.recovery_info !== undefined);
  const hasExc = list.data.every(r => r.exception_info !== undefined);
  console.log('全部有 extension_info:', hasExt);
  console.log('全部有 recovery_info:', hasRec);
  console.log('全部有 exception_info:', hasExc);

  console.log('\n=== 测试 5: 未闭环异常标记已闭环同步关闭异常记录 ===');
  if (excRisks.length > 0) {
    const excRisk = excRisks[0];
    const excId = excRisk.exception_id;
    console.log('异常ID:', excId);
    
    const beforeExc = await doRequest('GET', `/api/exceptions/${excId}`);
    console.log('处理前异常状态:', beforeExc.exception?.status);
    
    const handleResult = await doRequest('POST', `/api/risk-ledger/${excRisk.risk_key}/handle`, {
      handler: '测试管理员',
      handle_result: '已核实并解决',
      handle_notes: '风险台账标记闭环测试',
      handle_status: '已闭环'
    });
    console.log('风险处理登记:', handleResult.success ? '成功' : '失败');
    
    const afterExc = await doRequest('GET', `/api/exceptions/${excId}`);
    console.log('处理后异常状态:', afterExc.exception?.status);
    console.log('异常状态是否同步:', afterExc.exception?.status === '已闭环');
  } else {
    console.log('无未闭环异常风险，跳过此测试');
  }

  console.log('\n=== 所有测试完成 ===');
}

test().catch(console.error);
