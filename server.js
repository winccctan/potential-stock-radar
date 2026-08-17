/**
 * 潜力股雷达 · 个股查询数据服务
 * 静态托管 潜力股雷达.html，并提供 /api/search 与 /api/stock 实时数据接口
 * 启动：node server.js   （默认端口 8890）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const NODE = '/Users/tansy/.workbuddy/binaries/node/versions/22.22.2/bin/node';
const CLI = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/resources/builtin-skills/westock-data/scripts/index.js';
const PORT = 8890;
const ROOT = __dirname;

function runCli(args, timeout = 20000) {
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

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost:' + PORT);
  const p = u.pathname;

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
