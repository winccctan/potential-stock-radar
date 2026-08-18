/**
 * 潜力股雷达 · 个股查询数据服务
 * 静态托管 潜力股雷达.html，并提供 /api/search 与 /api/stock 实时数据接口
 * 启动：node server.js   （默认端口 8890，云端部署使用 $PORT 环境变量）
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const NODE = process.execPath;
const CLI = path.join(__dirname, 'vendor', 'westock-data', 'scripts', 'index.js');
const PORT = process.env.PORT || 8890;
const ROOT = __dirname;

function runCli(args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(NODE, [CLI, ...args], { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { resolve({ ok: false, err: (stderr || err.message || 'CLI error').slice(0, 500) }); return; }
      const txt = stdout.trim();
      if (!txt) { resolve({ ok: false, err: 'no output' }); return; }
      try { resolve({ ok: true, data: JSON.parse(txt) }); }
      catch (e) { resolve({ ok: false, err: 'parse error: ' + txt.slice(0, 300) }); }
    });
  });
}

// HTTPS GET → JSON
function httpGet(url, timeout) {
  timeout = timeout || 10000;
  return new Promise(function (resolve, reject) {
    var req = https.get(url, { timeout: timeout }, function (res) {
      var data = '';
      res.on('data', function (chunk) { data += chunk; });
      res.on('end', function () {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function () { req.destroy(); reject(new Error('timeout')); });
  });
}

// 新浪全 A 股排行 → 候选列表
function sinaRank(sort, num) {
  var url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData' +
    '?page=1&num=' + num + '&sort=' + sort + '&asc=0&node=hs_a&_s_r_a=sort';
  return httpGet(url).catch(function () { return []; });
}

function codeOf(q) {
  q = (q || '').trim().toLowerCase();
  if (/^(sh|sz|bj)\d{6}$/.test(q)) return q;

  if (/^\d{6}$/.test(q)) {
    if (q.startsWith('6') || q.startsWith('9')) return 'sh' + q;
    if (q.startsWith('4') || q.startsWith('8')) return 'bj' + q;
    return 'sz' + q;
  }
  return null;
}

async function resolveCode(q) {
  const direct = codeOf(q);
  if (direct) return { code: direct, name: q };
  const r = await runCli(['search', q, '--type', 'stock', '--raw', '--limit', '5']);
  if (!r.ok) throw new Error('搜索失败：' + r.err);
  const arr = Array.isArray(r.data) ? r.data : (r.data.data || []);
  if (!arr.length) throw new Error('未找到匹配 "' + q + '" 的股票，请检查代码或名称');
  const stock = arr.find(x => x.type === 'GP-A') || arr[0];
  return { code: stock.code, name: stock.name };
}

async function getStock(q) {
  const { code } = await resolveCode(q);
  const [qRes, macdRes, kdjRes, rsiRes, bollRes, maRes, fundRes, chipRes] = await Promise.all([
    runCli(['quote', code, '--raw']),
    runCli(['technical', code, '--group', 'macd', '--raw']),
    runCli(['technical', code, '--group', 'kdj', '--raw']),
    runCli(['technical', code, '--group', 'rsi', '--raw']),
    runCli(['technical', code, '--group', 'boll', '--raw']),
    runCli(['technical', code, '--group', 'ma', '--raw']),
    runCli(['fund', 'flow', code, '--raw']),
    runCli(['chip', code, '--raw'])
  ]);

  const quote = (Array.isArray(qRes.data) ? qRes.data[0] : null) || (qRes.ok && qRes.data && qRes.data.data && qRes.data.data[code]) || null;
  if (!quote) throw new Error('未获取到行情，请确认代码正确（如 sh600519 / 600519）');

  const pick = (r, key) => {
    if (!r.ok || !r.data || !r.data.data) return {};
    return (r.data.data[code] && r.data.data[code][key]) || {};
  };
  const fund = (Array.isArray(fundRes.data) ? fundRes.data[0] : null) || {};
  const chip = (chipRes.ok && chipRes.data && chipRes.data.data && chipRes.data.data[code]) || {};

  return {
    ok: true,
    code: quote.code || code,
    name: quote.name || '',
    quote,
    macd: pick(macdRes, 'macd'),
    kdj: pick(kdjRes, 'kdj'),
    rsi: pick(rsiRes, 'rsi'),
    boll: pick(bollRes, 'boll'),
    ma: pick(maRes, 'ma'),
    fund,
    chip
  };
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

/* ================= 雷达选股：多源候选 + 多因子信号 ================= */

// 技术指标计算（与 live-api.js 前端算法一致）
function emaCalc(arr, n) {
  var k = 2 / (n + 1), out = [], prev = null;
  for (var i = 0; i < arr.length; i++) {
    prev = prev == null ? arr[i] : arr[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
function calcMACD(closes) {
  var e12 = emaCalc(closes, 12), e26 = emaCalc(closes, 26), dif = [], dea, hist = [];
  for (var i = 0; i < closes.length; i++) dif.push(e12[i] - e26[i]);
  dea = emaCalc(dif, 9);
  for (i = 0; i < closes.length; i++) hist.push((dif[i] - dea[i]) * 2);
  return { DIF: dif[dif.length - 1], DEA: dea[dea.length - 1], MACD: hist[hist.length - 1] };
}
function calcMA(closes, n) {
  if (closes.length < n) return null;
  var s = 0;
  for (var i = closes.length - n; i < closes.length; i++) s += closes[i];
  return s / n;
}

// 多因子信号计算
function computeSignals(quote, tech, fund) {
  var sigs = [];
  var macd = tech.macd || {};
  var ma = tech.ma || {};
  var fundData = fund || {};

  // 1. MACD 金叉：DIF > DEA 且 MACD > 0
  if (macd.DIF != null && macd.DEA != null && macd.DIF > macd.DEA && macd.MACD > 0) sigs.push('macd');

  // 2. 主力抢筹：今日主力净流入 > 1000 万
  if (+fundData.MainNetFlow > 1000e4) sigs.push('force');

  // 3. 资金 5 日流入：5 日主力净流入 > 0
  if (+fundData.MainNetFlow5D > 0) sigs.push('cap');

  // 4. 均线多头排列：MA5 > MA10 > MA20
  if (ma.MA_5 && ma.MA_10 && ma.MA_20 && ma.MA_5 > ma.MA_10 && ma.MA_10 > ma.MA_20) sigs.push('force');

  return sigs;
}

// 从批量行情结果中提取单股行情
function findQuote(batchRes, code) {
  if (!batchRes.ok || !batchRes.data) return null;
  var d = batchRes.data;
  // 批量模式：{ success, data: [{ symbol, data: {...} }] }
  if (d.success && Array.isArray(d.data)) {
    var item = d.data.find(function (x) { return x.symbol === code || x.code === code; });
    return item ? (item.data || item) : null;
  }
  // 单股模式：{ data: { code: {...} } }
  if (d.data && d.data[code]) return d.data[code];
  // 直接数组
  if (Array.isArray(d)) {
    var item2 = d.find(function (x) { return x.code === code || x.symbol === code; });
    return item2 || null;
  }
  return null;
}

// 从批量 K 线结果中提取单股收盘价数组
function findCloses(batchRes, code) {
  if (!batchRes.ok || !batchRes.data) return [];
  var d = batchRes.data;
  // 批量模式：flat array of { symbol, last, ... }
  if (Array.isArray(d)) {
    var rows = d.filter(function (r) { return r.symbol === code; });
    // 按日期排序（旧→新）
    rows.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    return rows.map(function (r) { return +(r.last || r.close); });
  }
  // 单股模式：{ data: { code: { qfqday/day: [[...]] } } }
  if (d.data && d.data[code]) {
    var obj = d.data[code];
    var klines = obj.qfqday || obj.day || [];
    return klines.map(function (r) { return +r[2]; });
  }
  return [];
}

// 从批量资金流结果中提取单股数据
function findFund(batchRes, code) {
  if (!batchRes.ok || !batchRes.data) return {};
  var d = batchRes.data;
  if (Array.isArray(d)) {
    return d.find(function (x) { return x.code === code || x.symbol === code; }) || {};
  }
  if (d.data && d.data[code]) return d.data[code];
  return {};
}

// 从批量 K 线结果中提取收盘价 + 阶段高低
function findKlineStats(batchRes, code) {
  var result = { closes: [], high52: 0, low52: 0 };
  if (!batchRes.ok || !batchRes.data) return result;
  var d = batchRes.data;
  if (Array.isArray(d)) {
    var rows = d.filter(function (r) { return r.symbol === code; });
    rows.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    var highs = [], lows = [];
    rows.forEach(function (r) {
      var c = +(r.last || r.close);
      if (c) result.closes.push(c);
      if (+r.high > 0) highs.push(+r.high);
      if (+r.low > 0) lows.push(+r.low);
    });
    if (highs.length) result.high52 = Math.max.apply(null, highs);
    if (lows.length) result.low52 = Math.min.apply(null, lows);
  } else if (d.data && d.data[code]) {
    var obj = d.data[code];
    var klines = obj.qfqday || obj.day || [];
    var highs2 = [], lows2 = [];
    klines.forEach(function (r) {
      result.closes.push(+r[2]);
      if (+r[3] > 0) highs2.push(+r[3]);
      if (+r[4] > 0) lows2.push(+r[4]);
    });
    if (highs2.length) result.high52 = Math.max.apply(null, highs2);
    if (lows2.length) result.low52 = Math.min.apply(null, lows2);
  }
  return result;
}

async function getRadar() {
  // 1. 新浪全 A 股排行获取候选（涨幅 + 换手率 + 成交额三榜合并）
  var rankConfigs = [
    { sort: 'changepercent', num: 30, name: '涨幅榜' },
    { sort: 'turnoverratio', num: 20, name: '换手率榜' },
    { sort: 'amount', num: 20, name: '成交额榜' }
  ];

  var rankResults = await Promise.all(rankConfigs.map(function (r) {
    return sinaRank(r.sort, r.num).then(function (arr) {
      return { name: r.name, data: arr || [] };
    }).catch(function () { return { name: r.name, data: [] }; });
  }));

  var candidates = [];
  var seen = {};

  rankResults.forEach(function (r) {
    if (!r.data || !r.data.length) return;
    r.data.forEach(function (s) {
      var code6 = String(s.code || '');
      if (!code6) return;
      var mk;
      if (code6.charAt(0) === '6' || code6.charAt(0) === '9') mk = 'sh';
      else if (code6.charAt(0) === '8' || code6.charAt(0) === '4') mk = 'bj';
      else mk = 'sz';
      var code = mk + code6;
      if (seen[code] || !(+s.trade > 0)) return;
      seen[code] = 1;
      candidates.push({
        code: code,
        name: (s.name || '').replace(/\s/g, ''),
        price: +s.trade,
        chg: +s.changepercent || 0,
        pe: +s.per || 0,
        pb: +s.pb || 0,
        cap: Math.round((+s.mktcap || 0) / 10000),
        turn: +s.turnoverratio || 0,
        source: r.name
      });
    });
  });

  // 降级：新浪排行不可用时，用 westock-data 热搜/龙虎榜
  if (!candidates.length) {
    var [hotRes, lhbRes] = await Promise.all([
      runCli(['hot', 'stock', '--raw', '--limit', '20']),
      runCli(['lhb', '--type', 'institution,hotmoney', '--raw']).catch(function () { return { ok: false }; })
    ]);
    if (hotRes.ok && Array.isArray(hotRes.data)) {
      hotRes.data.forEach(function (s) {
        var code = s.code;
        if (!code || seen[code] || !/^(sh|sz|bj)\d{6}$/.test(code)) return;
        seen[code] = 1;
        candidates.push({ code: code, name: (s.name || '').replace(/\s/g, ''), price: 0, source: 'hot' });
      });
    }
    if (lhbRes.ok && lhbRes.data && lhbRes.data.sections) {
      lhbRes.data.sections.forEach(function (sec) {
        if (!Array.isArray(sec)) return;
        sec.forEach(function (s) {
          var code = s.code || s['\u4ee3\u7801'];
          if (!code || seen[code] || !/^(sh|sz|bj)\d{6}$/.test(code)) return;
          seen[code] = 1;
          candidates.push({ code: code, name: (s.name || s['\u540d\u79f0'] || '').replace(/\s/g, ''), price: 0, source: 'lhb' });
        });
      });
    }
  }

  if (!candidates.length) throw new Error('未获取到候选股票');

  // 限制候选数量，批量获取 K 线 + 资金流
  candidates = candidates.slice(0, 30);
  var codesStr = candidates.map(function (c) { return c.code; }).join(',');

  // 2. 批量获取 K 线 + 资金流（新浪已提供行情基础数据）
  var [kRes, fRes] = await Promise.all([
    runCli(['kline', codesStr, '--period', 'day', '--limit', '250', '--fq', 'qfq', '--raw'], 60000),
    runCli(['fund', 'flow', codesStr, '--raw'], 45000).catch(function () { return { ok: false }; })
  ]);

  // 3. 逐股计算信号
  var results = [];
  candidates.forEach(function (c) {
    var ks = findKlineStats(kRes, c.code);
    var closes = ks.closes;
    var macd = closes.length >= 30 ? calcMACD(closes) : {};
    var ma5 = calcMA(closes, 5), ma10 = calcMA(closes, 10), ma20 = calcMA(closes, 20);
    var fund = findFund(fRes, c.code);

    // 5日 / 10日涨幅
    var chg5 = 0, chg10 = 0;
    if (closes.length >= 6) {
      var i5 = closes.length - 6;
      chg5 = closes[i5] ? (c.price - closes[i5]) / closes[i5] * 100 : 0;
    }
    if (closes.length >= 11) {
      var i10 = closes.length - 11;
      chg10 = closes[i10] ? (c.price - closes[i10]) / closes[i10] * 100 : 0;
    }

    var sigs = computeSignals({}, { macd: macd, ma: { MA_5: ma5, MA_10: ma10, MA_20: ma20 } }, fund);
    var uniqueSigs = [];
    sigs.forEach(function (s) { if (uniqueSigs.indexOf(s) < 0) uniqueSigs.push(s); });

    results.push({
      code: c.code,
      name: c.name || c.code,
      price: c.price,
      chg: c.chg,
      chg5: chg5,
      chg10: chg10,
      pe: c.pe,
      peF: 0,
      pb: c.pb,
      cap: c.cap,
      turn: c.turn,
      high52: ks.high52,
      low52: ks.low52,
      score: 0,
      sigs: uniqueSigs,
      sig3: uniqueSigs.length >= 3,
      source: c.source,
      note: '',
      risk: ''
    });
  });

  if (!results.length) throw new Error('候选股票均无法获取有效行情数据');

  // 4. 排序：信号数降序 → 涨幅降序
  results.sort(function (a, b) {
    if (b.sigs.length !== a.sigs.length) return b.sigs.length - a.sigs.length;
    return b.chg - a.chg;
  });

  // 5. 为 top 12 生成简评
  results.slice(0, 12).forEach(function (s) {
    var parts = [];
    if (s.sigs.indexOf('macd') >= 0) parts.push('MACD 金叉');
    if (s.sigs.indexOf('force') >= 0) parts.push('主力抢筹');
    if (s.sigs.indexOf('cap') >= 0) parts.push('资金 5 日净流入');
    s.note = parts.length ? parts.join(' + ') + '，' : '';
    s.note += '今日' + (s.chg > 0 ? '涨' : '跌') + Math.abs(s.chg).toFixed(2) + '%';
    if (s.pe > 0) s.note += '，PE ' + s.pe.toFixed(1) + ' 倍';
    if (s.cap > 0) s.note += '，市值 ' + s.cap + ' 亿';

    var risks = [];
    if (s.pe > 80) risks.push('PE ' + s.pe.toFixed(0) + ' 倍估值极高');
    if (s.chg10 > 30) risks.push('10 日 +' + s.chg10.toFixed(0) + '% 短线超买');
    if (s.turn > 15) risks.push('换手率 ' + s.turn.toFixed(1) + '% 波动剧烈');
    s.risk = risks.length ? risks.join('；') + '。注意追高风险' : '暂无明显风险信号';
  });

  return {
    ok: true,
    stocks: results.slice(0, 12),
    updatedAt: new Date().toISOString(),
    sources: ['新浪全A股排行'],
    count: results.length
  };
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost:' + PORT);
  const p = u.pathname;

  if (p === '/api/radar') {
    getRadar().then(d => send(res, 200, d)).catch(e => send(res, 500, { ok: false, err: e.message }));
    return;
  }

  if (p === '/api/search') {
    const q = u.searchParams.get('q') || '';
    if (!q) return send(res, 400, { ok: false, err: '缺少参数 q' });
    runCli(['search', q, '--type', 'stock', '--raw', '--limit', '6']).then(r => {
      if (!r.ok) return send(res, 502, { ok: false, err: r.err });
      const arr = Array.isArray(r.data) ? r.data : (r.data.data || []);
      send(res, 200, { ok: true, list: arr });
    });
    return;
  }

  if (p === '/api/stock') {
    const q = u.searchParams.get('q') || '';
    if (!q) return send(res, 400, { ok: false, err: '缺少参数 q' });
    getStock(q).then(d => send(res, 200, d)).catch(e => send(res, 404, { ok: false, err: e.message }));
    return;
  }

  // 静态文件
  let file = p === '/' ? '潜力股雷达.html' : decodeURIComponent(p.slice(1));
  if (file.includes('..')) { res.writeHead(403); res.end('forbidden'); return; }
  const fp = path.join(ROOT, file);
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(fp).toLowerCase();
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(fp).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log('潜力股雷达服务已启动: http://localhost:' + PORT);
});
