/**
 * live-api.js — 纯前端直连数据引擎（在线静态版专用）
 * ------------------------------------------------------------------
 * GitHub Pages 纯静态托管无法运行 Node 服务，本模块让在线版也能
 * 实时查询全市场 A 股，数据直接来自公开行情接口（浏览器直连）：
 *
 *   股票搜索  : https://smartbox.gtimg.cn/s3/          (JSONP, UTF-8转义)
 *   实时行情  : https://qt.gtimg.cn/q=                 (JSONP, script+charset=gbk)
 *   日 K 线   : https://web.ifzq.gtimg.cn/appstock/...  (fetch, CORS *)
 *   资金流    : https://push2his.eastmoney.com/...      (fetch, 回声 CORS)
 *   技术指标  : 前端本地计算 (MACD/KDJ/RSI/BOLL/MA)
 *   筹码分布  : 基于 K 线的估算值（卡片内标注"估算"）
 *
 * 暴露：window.LiveAPI = { detect, search, stock, normCode, mode }
 *  - detect(): Promise<'backend'|'live'>，探测本地 Node 服务是否可用
 *  - search(key): Promise<[{code,name},...]>，模糊搜索 A 股
 *  - stock(key): Promise<schema与后端 /api/stock 一致的数据对象>
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';

  var MODE = null; // 'backend' | 'live'

  /* ================= 基础工具 ================= */

  function normCode(raw) {
    var s = String(raw || '').trim().toLowerCase();
    var m = s.match(/^(sh|sz|bj)(\d{6})$/);
    if (m) {
      var secid = (m[1] === 'sh' ? '1' : '0') + '.' + m[2];
      return { code: m[0], market: m[1], num: m[2], secid: secid };
    }
    if (/^\d{6}$/.test(s)) {
      var mk;
      if (s.charAt(0) === '6' || s.indexOf('90') === 0) mk = 'sh';
      else if (s.indexOf('92') === 0 || s.indexOf('43') === 0 || s.indexOf('83') === 0 ||
               s.indexOf('87') === 0 || s.indexOf('88') === 0) mk = 'bj';
      else mk = 'sz';
      return { code: mk + s, market: mk, num: s, secid: (mk === 'sh' ? '1' : '0') + '.' + s };
    }
    return null;
  }

  /* JSONP 加载（script 标签，绕开 CORS；用于腾讯系接口） */
  function jsonp(src, varName, timeout) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var s = document.createElement('script');
      var timer = null;
      function cleanup() {
        if (s && s.parentNode) s.parentNode.removeChild(s);
        if (timer) clearTimeout(timer);
      }
      s.src = src;
      s.charset = 'gbk'; // 腾讯行情接口为 GBK 编码
      s.onload = function () {
        if (done) return; done = true;
        var v = window[varName];
        cleanup();
        if (v == null) return reject(new Error(varName + ' 未定义'));
        resolve(v);
      };
      s.onerror = function () {
        if (done) return; done = true;
        cleanup();
        reject(new Error('数据源加载失败'));
      };
      timer = setTimeout(function () {
        if (done) return; done = true;
        cleanup();
        reject(new Error('数据源加载超时'));
      }, timeout || 9000);
      document.head.appendChild(s);
    });
  }

  /* fetch JSON（带超时与 CORS 兜底） */
  function fetchJSON(url, timeout) {
    var ctrl = null;
    var t = timeout || 12000;
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
      ctrl = AbortSignal.timeout(t);
    } else {
      ctrl = new AbortController();
      setTimeout(function () { ctrl.abort(); }, t);
    }
    return fetch(url, { cache: 'no-store', signal: ctrl }).then(function (r) {
      if (!r.ok) throw new Error('接口返回 HTTP ' + r.status);
      return r.json();
    });
  }

  function isGoodName(s) {
    if (!s) return false;
    s = String(s);
    if (!/[\u4e00-\u9fa5]/.test(s)) return false; // 必须含中文
    if (/�/.test(s) || s.indexOf('\uFFFD') > -1) return false; // 解码失败乱码
    return s.length <= 16;
  }

  /* ================= 搜索（smartbox.gtimg.cn） ================= */

  function search(key) {
    var k = String(key || '').trim();
    if (!k) return Promise.resolve([]);
    var direct = normCode(k);
    if (direct) return Promise.resolve([{ code: direct.code, name: k }]);
    return jsonp(
      'https://smartbox.gtimg.cn/s3/?v=2&q=' + encodeURIComponent(k) + '&t=all&c=1',
      'v_hint',
      8000
    ).then(function (raw) {
      var txt = String(raw);
      txt = txt.replace(/^v_hint\s*=\s*/, '').replace(/;\s*$/, '').replace(/^"|"$/g, '');
      var out = [];
      txt.split('^').forEach(function (seg) {
        var p = seg.split('~');
        if (p.length < 3) return;
        var mk = p[0], code = p[1], name = p[2], type = p[4] || '';
        if (!/^(sh|sz|bj)$/.test(mk)) return;
        if (type !== 'GP-A' && type !== 'KCB' && type !== 'CYB' && type !== 'BJ') return; // 只要 A 股
        out.push({ code: mk + code, name: name });
      });
      return out.slice(0, 8);
    });
  }

  /* ================= 实时行情（qt.gtimg.cn JSONP） ================= */

  function parseTencentQuote(raw) {
    var p = String(raw || '').split('~');
    function n(i) { var v = parseFloat(p[i]); return isNaN(v) ? null : v; }
    return {
      name: p[1] || '',
      price: n(3), pre_close: n(4), open: n(5), volume: n(6), // 成交量(手)
      change: n(31), change_percent: n(32), high: n(33), low: n(34),
      amount_wan: n(37), turnover_rate: n(38), pe_ratio: n(39),
      float_market_cap: n(44), total_market_cap: n(45), pb_ratio: n(46),
      volume_ratio: n(49), avg_price: n(51), pe_fwd: n(52),
      time: p[30] || ''
    };
  }

  function jsonpQuote(code, timeout) {
    return jsonp('https://qt.gtimg.cn/q=' + code, 'v_' + code, timeout || 9000)
      .then(function (raw) { return parseTencentQuote(raw); });
  }

  /* ================= 日 K 线（web.ifzq.gtimg.cn，CORS *） ================= */

  function fetchKline(code, count) {
    return fetchJSON(
      'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + code + ',day,,,' + (count || 250) + ',qfq'
    ).then(function (j) {
      var d = j && j.data && j.data[code];
      if (!d) throw new Error('K线数据为空');
      var rows = d.qfqday || d.day || [];
      if (!rows.length) throw new Error('K线数据为空');
      return rows.map(function (r) {
        return { date: r[0], open: +r[1], close: +r[2], high: +r[3], low: +r[4], vol: +r[5] || 0 };
      });
    });
  }

  /* ================= 资金流（push2his.eastmoney.com，回声 CORS） ================= */

  function fetchFund(secid) {
    return fetchJSON(
      'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=' + secid +
      '&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65' +
      '&klt=101&lmt=30'
    ).then(function (j) {
      var ks = (j && j.data && j.data.klines) || [];
      if (!ks.length) throw new Error('资金流数据为空');
      var arr = ks.map(function (line) {
        var p = line.split(',');
        return { date: p[0], main: +p[1], small: +p[2], mid: +p[3], block: +p[4], jumbo: +p[5] };
      });
      var last = arr[arr.length - 1];
      function sum(n) {
        var s = 0;
        for (var i = arr.length - n; i < arr.length; i++) s += arr[i].main;
        return s;
      }
      return {
        MainNetFlow: last.main, MainNetFlow5D: sum(5), MainNetFlow10D: sum(10), MainNetFlow20D: sum(20),
        JumboNetFlow: last.jumbo, BlockNetFlow: last.block, MidNetFlow: last.mid, SmallNetFlow: last.small
      };
    });
  }

  /* 备用：从东财 K 线接口取股票名称（UTF-8 JSON） */
  function fetchName(secid) {
    return fetchJSON(
      'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + secid +
      '&fields1=f1,f2,f3&fields2=f51&klt=101&fqt=1&end=20500101&lmt=1'
    ).then(function (j) { return (j && j.data && j.data.name) || ''; })
      .catch(function () { return ''; });
  }

  /* ================= 技术指标（前端计算） ================= */

  function ema(arr, n) {
    var k = 2 / (n + 1), out = [], prev = null;
    for (var i = 0; i < arr.length; i++) {
      prev = prev == null ? arr[i] : arr[i] * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  }
  function calcMACD(closes) {
    var e12 = ema(closes, 12), e26 = ema(closes, 26), dif = [], dea, hist = [];
    for (var i = 0; i < closes.length; i++) dif.push(e12[i] - e26[i]);
    dea = ema(dif, 9);
    for (i = 0; i < closes.length; i++) hist.push((dif[i] - dea[i]) * 2);
    return { DIF: dif[dif.length - 1], DEA: dea[dea.length - 1], MACD: hist[hist.length - 1] };
  }
  function calcKDJ(rows) {
    var K = 50, D = 50, out = { KDJ_K: null, KDJ_D: null, KDJ_J: null };
    for (var i = 0; i < rows.length; i++) {
      var start = Math.max(0, i - 8), h = -Infinity, l = Infinity, j;
      for (j = start; j <= i; j++) { if (rows[j].high > h) h = rows[j].high; if (rows[j].low < l) l = rows[j].low; }
      var rsv = (h === l) ? 50 : (rows[i].close - l) / (h - l) * 100;
      K = (2 * K + rsv) / 3; D = (2 * D + K) / 3;
      if (i === rows.length - 1) { out.KDJ_K = K; out.KDJ_D = D; out.KDJ_J = 3 * K - 2 * D; }
    }
    return out;
  }
  function calcRSI(closes, n) {
    if (closes.length <= n) return null;
    var i, gains = 0, loses = 0;
    for (i = 1; i <= n; i++) { var d0 = closes[i] - closes[i - 1]; if (d0 >= 0) gains += d0; else loses -= d0; }
    var ag = gains / n, al = loses / n;
    for (i = n + 1; i < closes.length; i++) {
      var dd = closes[i] - closes[i - 1];
      ag = (ag * (n - 1) + Math.max(dd, 0)) / n;
      al = (al * (n - 1) + Math.max(-dd, 0)) / n;
    }
    if (al === 0) return 100;
    return 100 - 100 / (1 + ag / al);
  }
  function calcBOLL(closes) {
    var n = 20;
    if (closes.length < n) return { BOLL_MID: null, BOLL_UPPER: null, BOLL_LOWER: null };
    var slice = closes.slice(-n), sum = 0;
    for (var i = 0; i < n; i++) sum += slice[i];
    var mid = sum / n, v = 0;
    for (i = 0; i < n; i++) v += (slice[i] - mid) * (slice[i] - mid);
    var sd = Math.sqrt(v / n);
    return { BOLL_MID: mid, BOLL_UPPER: mid + 2 * sd, BOLL_LOWER: mid - 2 * sd };
  }
  function calcMA(closes, n) {
    if (closes.length < n) return null;
    var s = 0;
    for (var i = closes.length - n; i < closes.length; i++) s += closes[i];
    return s / n;
  }
  function indicators(rows) {
    var closes = [];
    for (var i = 0; i < rows.length; i++) closes.push(rows[i].close);
    return {
      macd: calcMACD(closes),
      kdj: calcKDJ(rows),
      rsi: { RSI_2: calcRSI(closes, 6), RSI_6: calcRSI(closes, 24) },
      boll: calcBOLL(closes),
      ma: { MA_5: calcMA(closes, 5), MA_10: calcMA(closes, 10), MA_20: calcMA(closes, 20), MA_60: calcMA(closes, 60) }
    };
  }

  /* ================= 区间统计 / 涨跌 / 筹码估算 ================= */

  function stats(rows, price) {
    var n = rows.length, i;
    var hi = -Infinity, lo = Infinity, ytdBase = null;
    var thisYear = rows[n - 1].date.slice(0, 4);
    for (i = n - 1; i >= 0; i--) {
      if (rows[i].date.slice(0, 4) === thisYear) ytdBase = rows[i].close;
      else break;
    }
    if (ytdBase == null && n) ytdBase = rows[0].close;
    for (i = 0; i < n; i++) {
      if (rows[i].high > hi) hi = rows[i].high;
      if (rows[i].low < lo) lo = rows[i].low;
    }
    function chg(k) {
      var idx = n - 1 - k;
      if (idx < 0) idx = 0;
      var base = rows[idx].close;
      return base ? (price - base) / base * 100 : null;
    }
    return {
      hi: hi, lo: lo,
      chg5: chg(5), chg10: chg(10), chg20: chg(20),
      ytdBase: ytdBase
    };
  }

  function chipEstimate(rows, price) {
    var n = rows.length;
    var hi = -Infinity, lo = Infinity, sw = 0, sv = 0;
    var start = Math.max(0, n - 60);
    for (var i = 0; i < n; i++) {
      if (rows[i].high > hi) hi = rows[i].high;
      if (rows[i].low < lo) lo = rows[i].low;
      if (i >= start) { sw += rows[i].close * rows[i].vol; sv += rows[i].vol; }
    }
    var profit = (hi > lo) ? Math.min(100, Math.max(0, (price - lo) / (hi - lo) * 100)) : 50;
    var avg = sv > 0 ? sw / sv : price;
    var mid = (hi + lo) / 2 || 1;
    var range = (hi - lo) / mid * 100;
    return {
      chipProfitRate: profit,
      chipAvgCost: avg,
      chipConcentration90: range,
      chipConcentration70: range * 0.7,
      estimated: true
    };
  }

  /* ================= 对外主入口 ================= */

  function detect() {
    if (MODE) return Promise.resolve(MODE);
    return fetch('/api/stock?q=probe', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (d) { if (!d || !d.ok) throw 0; MODE = 'backend'; return MODE; })
      .catch(function () { MODE = 'live'; return MODE; });
  }

  function stock(key) {
    var q = String(key || '').trim();
    var direct = normCode(q);
    var metaP = direct
      ? Promise.resolve({ code: direct.code, name: q })
      : search(q).then(function (list) {
          if (!list.length) throw new Error('未找到匹配 "' + q + '" 的股票，请检查代码或名称');
          return { code: list[0].code, name: list[0].name };
        });

    return metaP.then(function (meta) {
      var norm = normCode(meta.code);
      if (!norm) throw new Error('无效代码: ' + meta.code);
      return Promise.all([
        jsonpQuote(norm.code),
        fetchKline(norm.code, 250),
        fetchFund(norm.secid).catch(function () { return null; }) // 资金流失败不阻塞查询
      ]).then(function (res) {
        var qd = res[0], rows = res[1], fund = res[2];
        if (!qd.price) throw new Error('未获取到行情，请确认代码正确（如 sh600519 / 600519）');
        var ind = indicators(rows);
        var st = stats(rows, qd.price);
        var chip = chipEstimate(rows, qd.price);
        var nameOk = isGoodName(meta.name) ? meta.name : (isGoodName(qd.name) ? qd.name : '');
        var nameP = nameOk ? Promise.resolve(nameOk) : fetchName(norm.secid);
        return nameP.then(function (name) {
          var finalName = name || qd.name || meta.name || norm.code;
          return {
            ok: true,
            code: norm.code,
            name: finalName,
            live: true,
            quote: {
              price: qd.price, pre_close: qd.pre_close, open: qd.open,
              change_percent: qd.change_percent,
              high_52week: st.hi, low_52week: st.lo,
              pe_ratio: qd.pe_ratio, pe_fwd: qd.pe_fwd, pb_ratio: qd.pb_ratio,
              dividend_ratio_ttm: null,
              total_market_cap: qd.total_market_cap,
              turnover_rate: qd.turnover_rate, volume_ratio: qd.volume_ratio,
              avg_price: qd.avg_price,
              chg_5d: st.chg5, chg_10d: st.chg10, chg_20d: st.chg20,
              chg_ytd: st.ytdBase ? (qd.price - st.ytdBase) / st.ytdBase * 100 : null
            },
            macd: ind.macd, kdj: ind.kdj, rsi: ind.rsi, boll: ind.boll, ma: ind.ma,
            fund: fund, chip: chip
          };
        });
      });
    });
  }

  window.LiveAPI = {
    detect: detect,
    search: search,
    stock: stock,
    normCode: normCode,
    get mode() { return MODE; }
  };
})();
