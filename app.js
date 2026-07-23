/* ===========================================================
   策方 Ledger — 财务规划 App
   纯前端实现，数据保存在浏览器 localStorage 中。
   =========================================================== */
(function () {
  'use strict';

  var STORAGE_KEY = 'cefang_ledger_v1';

  /* ---------- 常量数据 ---------- */
  var DEFAULT_CATS = [
    { id: 'housing', name: '住房', hue: 150 },
    { id: 'food', name: '餐饮', hue: 25 },
    { id: 'shopping', name: '购物', hue: 300 },
    { id: 'transport', name: '交通', hue: 230 },
    { id: 'entertainment', name: '娱乐', hue: 340 }
  ];
  var CAT_HUE_CHOICES = [150, 25, 300, 230, 340, 195, 45, 280, 10, 200];
  var CHANNELS = [
    { id: 'wechat', name: '微信支付' },
    { id: 'alipay', name: '支付宝' },
    { id: 'bank', name: '银行卡' },
    { id: 'cash', name: '现金' },
    { id: 'other', name: '其他' }
  ];
  function channelName(id) { var c = CHANNELS.filter(function (c) { return c.id === id; })[0]; return c ? c.name : ''; }

  var ASSET_CATEGORIES = [
    { id: 'cash', name: '现金', icon: '💵', tracksDep: false },
    { id: 'bank', name: '银行存款', icon: '🏦', tracksDep: false },
    { id: 'electronics', name: '电子设备', icon: '💻', tracksDep: true },
    { id: 'furniture', name: '家居物品', icon: '🛋️', tracksDep: true },
    { id: 'vehicle', name: '车辆', icon: '🚗', tracksDep: true },
    { id: 'valuables', name: '收藏/贵重物品', icon: '💎', tracksDep: true },
    { id: 'other', name: '其他物品', icon: '📦', tracksDep: true }
  ];
  function assetCatById(id) { return ASSET_CATEGORIES.filter(function (c) { return c.id === id; })[0] || ASSET_CATEGORIES[ASSET_CATEGORIES.length - 1]; }

  /* ---------- 账单导入：分类关键词猜测 ---------- */
  var CATEGORY_KEYWORDS = {
    food: ['餐', '美团', '饿了么', '肯德基', '麦当劳', '星巴克', '咖啡', '奶茶', '外卖', '食', '菜市场', '生鲜'],
    transport: ['滴滴', '打车', '地铁', '公交', '高铁', '机票', '出行', '停车', '加油', '火车', '航空'],
    housing: ['房租', '物业', '水费', '电费', '燃气', '宽带', '房贷', '房屋'],
    entertainment: ['电影', '票务', '游戏', 'KTV', '演唱会', '视频', '音乐', '票'],
    shopping: ['淘宝', '天猫', '京东', '拼多多', '超市', '商场', '购物']
  };
  function guessCategoryId(text) {
    var t = text || '';
    var ids = Object.keys(CATEGORY_KEYWORDS);
    for (var i = 0; i < ids.length; i++) {
      var kws = CATEGORY_KEYWORDS[ids[i]];
      for (var j = 0; j < kws.length; j++) {
        if (t.indexOf(kws[j]) >= 0) {
          var found = catById(ids[i]);
          if (found) return found.id;
        }
      }
    }
    return null;
  }
  function normHeader(h) { return String(h || '').replace(/[（）()\s]/g, ''); }
  function findCol(headers, keyword) {
    for (var i = 0; i < headers.length; i++) {
      if (normHeader(headers[i]).indexOf(keyword) >= 0) return i;
    }
    return -1;
  }
  function parseBillAmount(raw) {
    var n = parseFloat(String(raw || '').replace(/[¥￥,\s]/g, ''));
    return isNaN(n) ? 0 : Math.abs(n);
  }
  function parseBillDate(raw) {
    var s = String(raw || '').trim();
    var m = s.match(/(\d{4})-(\d{2})-(\d{2})/) || s.match(/(\d{4})\/(\d{2})\/(\d{2})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    return todayISO();
  }

  /* 极简 CSV 解析器（不依赖任何外部库），支持带引号字段、字段内逗号/换行、双引号转义 */
  function parseCSV(text) {
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    var s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (inQuotes) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; }
          else { inQuotes = false; }
        } else {
          field += c;
        }
      } else {
        if (c === '"') { inQuotes = true; }
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else { field += c; }
      }
    }
    row.push(field);
    rows.push(row);
    // drop fully-empty trailing rows
    while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
    return rows;
  }

  /* Parses raw CSV text (already decoded) from an Alipay or WeChat Pay bill export
     into an array of candidate transaction rows: {type, cat, channel, note, amount, date, include} */
  function parseBillCsv(text, channel) {
    var rows = parseCSV(text);
    var headerIdx = -1;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].indexOf('收/支') >= 0) { headerIdx = i; break; }
    }
    if (headerIdx < 0) return [];
    var headers = rows[headerIdx];
    var colDir = findCol(headers, '收/支');
    var colAmount = findCol(headers, '金额');
    var colCounterparty = findCol(headers, '交易对方');
    var colGoods = findCol(headers, '商品');
    var colStatus = channel === 'alipay' ? findCol(headers, '交易状态') : findCol(headers, '当前状态');
    var colDate = channel === 'alipay' ? findCol(headers, '付款时间') : findCol(headers, '交易时间');
    if (colDate < 0) colDate = channel === 'alipay' ? findCol(headers, '交易创建时间') : findCol(headers, '交易时间');

    var out = [];
    for (var r = headerIdx + 1; r < rows.length; r++) {
      var row = rows[r];
      if (!row || row.length < 2) continue;
      var dir = (row[colDir] || '').trim();
      if (dir !== '收入' && dir !== '支出') continue; // 跳过"不计收支"等
      var status = colStatus >= 0 ? (row[colStatus] || '') : '';
      if (status.indexOf('失败') >= 0 || status.indexOf('关闭') >= 0) continue;
      var amount = parseBillAmount(row[colAmount]);
      if (amount <= 0) continue;
      var counterparty = colCounterparty >= 0 ? (row[colCounterparty] || '').trim() : '';
      var goods = colGoods >= 0 ? (row[colGoods] || '').trim() : '';
      var note = (goods && goods !== counterparty) ? (counterparty + (goods ? ' ' + goods : '')) : (counterparty || goods);
      var type = dir === '收入' ? 'income' : 'expense';
      var cat = type === 'expense' ? (guessCategoryId(note) || cats()[0].id) : 'salary';
      out.push({
        type: type, cat: cat, channel: channel, note: note.slice(0, 40),
        amount: amount, date: parseBillDate(row[colDate]), include: true
      });
    }
    return out;
  }

  var INCOME_CATS = [
    { id: 'salary', name: '工资' },
    { id: 'freelance', name: '兼职' },
    { id: 'investment', name: '理财收益' },
    { id: 'other_income', name: '其他' }
  ];
  var SKINS = [
    { id: 'aurora', name: '极光蓝', css: 'linear-gradient(135deg, oklch(38% .11 230), oklch(24% .09 260) 55%, oklch(16% .05 250))' },
    { id: 'nebula', name: '深空紫', css: 'linear-gradient(135deg, oklch(36% .11 300), oklch(22% .09 270) 60%, oklch(14% .04 250))' },
    { id: 'forest', name: '森林绿', css: 'linear-gradient(135deg, oklch(40% .1 155), oklch(24% .08 200) 60%, oklch(15% .04 240))' },
    { id: 'sunset', name: '日落橙', css: 'linear-gradient(135deg, oklch(48% .13 45), oklch(28% .1 320) 60%, oklch(17% .05 260))' },
    { id: 'mono', name: '极简线条', css: 'linear-gradient(135deg, oklch(30% .02 250), oklch(20% .015 250) 100%)' },
    { id: 'worldcup', name: '2026世界杯', css: 'radial-gradient(circle at 82% 12%, oklch(80% .16 95 / .4) 0%, transparent 45%), linear-gradient(150deg, oklch(48% .13 150), oklch(30% .1 165) 55%, oklch(18% .06 200))' }
  ];
  var ACCENT_HUES = [195, 230, 300, 340, 150];
  var THEME = {
    dark: { bg: 'oklch(15% 0.012 250)', surface: 'oklch(27% 0.018 250)', surface2: 'oklch(30% 0.018 250)', track: 'oklch(35% 0.02 250)', border: 'oklch(40% 0.02 250)', sheet: 'oklch(23% 0.015 250)', tabbar: 'oklch(22% 0.015 250 / .92)', text: 'oklch(97% 0.01 250)', textSoft: 'oklch(85% 0.01 250)', textMute: 'oklch(68% 0.015 250)', textFaint: 'oklch(60% 0.015 250)' },
    light: { bg: 'oklch(95% 0.01 85)', surface: 'oklch(99% 0.006 85)', surface2: 'oklch(93% 0.012 85)', track: 'oklch(88% 0.012 85)', border: 'oklch(84% 0.012 85)', sheet: 'oklch(99% 0.005 85)', tabbar: 'oklch(97% 0.008 85 / .92)', text: 'oklch(22% 0.012 85)', textSoft: 'oklch(38% 0.012 85)', textMute: 'oklch(52% 0.012 85)', textFaint: 'oklch(60% 0.012 85)' }
  };
  var DEFAULT_BUDGET_LIMITS = { housing: 3500, food: 1500, shopping: 800, transport: 400, entertainment: 300 };

  /* ---------- 工具函数 ---------- */
  function hue(h, l, c) { return 'oklch(' + l + '% ' + c + ' ' + h + ')'; }
  function fmt(n) { return '¥' + Math.round(n || 0).toLocaleString('zh-CN'); }
  function pad2(n) { return String(n).length < 2 ? '0' + n : String(n); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() { return Date.now() + Math.floor(Math.random() * 1000); }
  function cats() { return (state && state.categories && state.categories.length) ? state.categories : DEFAULT_CATS; }
  function catById(id) { return cats().filter(function (c) { return c.id === id; })[0]; }
  function incomeCatById(id) { return INCOME_CATS.filter(function (c) { return c.id === id; })[0]; }

  function monthsWindow(n) {
    var out = [];
    var now = new Date();
    for (var i = n - 1; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      out.push({
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        label: (d.getMonth() + 1) + '月',
        key: d.getFullYear() + '-' + pad2(d.getMonth() + 1)
      });
    }
    return out;
  }
  function txMonthKey(t) { return String(t.date).slice(0, 7); }
  function todayISO(offsetDays) {
    var d = new Date();
    if (offsetDays) d.setDate(d.getDate() + offsetDays);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function fmtDate(iso) {
    var parts = String(iso).split('-');
    return parts[1] + '-' + parts[2];
  }

  function defaultState() {
    return {
      userName: '',
      tab: 'home', overlay: null, accentHue: 195, skinId: 'aurora',
      txType: 'expense', txCategory: null, txAmount: '', txNote: '', txChannel: 'wechat', toast: null,
      reportMonthIdx: 5, budgetPeriodIdx: 5,
      depMethods: {}, mode: 'dark', budgetLimits: Object.assign({}, DEFAULT_BUDGET_LIMITS),
      piggyBalance: 0, piggyGoal: 10000, piggyHistory: [],
      piggyDepositAmount: '',
      remindOnOpen: true, reminderDismissedDate: null,
      customColors: ['#2dd4bf', '#38bdf8', '#818cf8', '#f472b6', '#fbbf24'],
      transactions: [],
      assets: [],
      nextAssetId: 6,
      avatarImg: null, wallpaperImg: null,
      newAsset: { name: '', category: 'electronics', buy: '', current: '', dateStr: '', uses: '' },
      streakStart: todayISO(),
      categories: DEFAULT_CATS.map(function (c) { return Object.assign({}, c); }),
      newCategoryName: '', newCategoryHue: 195,
      editingTxId: null,
      txDateStr: todayISO(),
      txList: { search: '', type: 'all', cat: 'all', monthKey: 'all' },
      security: { pinEnabled: false, pinCode: null },
      pinSetupStage: 'enter', pinSetupFirst: '', pinInput: '', pinError: '',
      billRows: [], pendingBillChannel: 'alipay'
    };
  }

  var PROFILES_KEY = 'cefang_ledger_profiles_v1';
  var ACTIVE_KEY = 'cefang_ledger_active_v1';
  function profileDataKey(id) { return 'cefang_ledger_data_v1__' + id; }

  function loadProfiles() {
    try {
      var raw = localStorage.getItem(PROFILES_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveProfiles() {
    try { localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles)); } catch (e) { console.error('保存账号列表失败', e); }
  }

  function loadProfileState(id) {
    try {
      var raw = localStorage.getItem(profileDataKey(id));
      if (!raw) return defaultState();
      var saved = JSON.parse(raw);
      return Object.assign(defaultState(), saved, {
        // keep nested objects merged properly
        remindOnOpen: saved.remindOnOpen !== false,
        reminderDismissedDate: saved.reminderDismissedDate || null,
        budgetLimits: Object.assign({}, DEFAULT_BUDGET_LIMITS, saved.budgetLimits || {}),
        newAsset: saved.newAsset || { name: '', category: 'electronics', buy: '', current: '', dateStr: '', uses: '' },
        categories: (saved.categories && saved.categories.length) ? saved.categories : DEFAULT_CATS.map(function (c) { return Object.assign({}, c); }),
        txList: Object.assign({ search: '', type: 'all', cat: 'all', monthKey: 'all' }, saved.txList || {}),
        security: Object.assign({ pinEnabled: false, pinCode: null }, saved.security || {}),
        editingTxId: null, pinSetupStage: 'enter', pinSetupFirst: '', pinInput: '', pinError: ''
      });
    } catch (e) {
      console.error('加载账号数据失败，使用初始数据', e);
      return defaultState();
    }
  }
  function persist() {
    if (!activeProfileId) return;
    try {
      var toSave = Object.assign({}, state);
      delete toSave.toast; // never persist transient toast
      delete toSave.billRows; // transient bill-import review data
      localStorage.setItem(profileDataKey(activeProfileId), JSON.stringify(toSave));
    } catch (e) {
      console.error('保存本地数据失败', e);
    }
  }

  var profiles = loadProfiles();
  var activeProfileId = localStorage.getItem(ACTIVE_KEY) || null;
  if (activeProfileId && !profiles.some(function (p) { return p.id === activeProfileId; })) activeProfileId = null;
  var state = activeProfileId ? loadProfileState(activeProfileId) : null;
  var locked = !!(state && state.security && state.security.pinEnabled && state.security.pinCode);
  var toastTimer = null;
  var newProfileNameDraft = '';

  function update(patch) {
    if (typeof patch === 'function') {
      state = Object.assign({}, state, patch(state));
    } else {
      state = Object.assign({}, state, patch);
    }
    persist();
    render();
  }
  function showToast(msg) {
    if (!state) return;
    state.toast = msg;
    render();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { if (state) { state.toast = null; render(); } }, 2000);
  }

  /* ---------- 派生数据计算 ---------- */
  function monthStats(monthKey) {
    var income = 0, expense = 0, byCat = {};
    cats().forEach(function (c) { byCat[c.id] = 0; });
    state.transactions.forEach(function (t) {
      if (txMonthKey(t) !== monthKey) return;
      if (t.type === 'income') income += t.amount;
      else { expense += t.amount; byCat[t.cat] = (byCat[t.cat] || 0) + t.amount; }
    });
    return { income: income, expense: expense, byCat: byCat };
  }

  function computeDerived() {
    var s = state;
    var accent = hue(s.accentHue, 72, 0.14);
    var negative = hue(25, 66, 0.19);
    var positive = hue(150, 72, 0.16);
    var customGradientCss = 'linear-gradient(135deg, ' + s.customColors.join(', ') + ')';
    var skinIsPhoto = s.skinId === 'photo';
    var heroBg, skinName;
    if (skinIsPhoto) { heroBg = 'transparent'; skinName = '自定义壁纸'; }
    else if (s.skinId === 'customGradient') { heroBg = customGradientCss; skinName = '自定义渐变'; }
    else { var sk = SKINS.filter(function (k) { return k.id === s.skinId; })[0] || SKINS[0]; heroBg = sk.css; skinName = sk.name; }

    var months = monthsWindow(6);
    var curKey = months[months.length - 1].key;
    var homeStats = monthStats(curKey);

    var totalLimit = 0;
    cats().forEach(function (c) { totalLimit += (s.budgetLimits[c.id] || 0); });
    var totalSpent = homeStats.expense;
    var budgetPct = totalLimit > 0 ? Math.round((totalSpent / totalLimit) * 100) : 0;
    var net = homeStats.income - homeStats.expense;

    var assetsTotal = 0, assetsBuy = 0;
    s.assets.forEach(function (a) { assetsTotal += a.current; assetsBuy += a.buy; });
    var assetsDiffPct = assetsBuy > 0 ? Math.round(((assetsTotal - assetsBuy) / assetsBuy) * 100) : 0;

    var compact = function (n) { return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(Math.round(n)); };

    function buildBudgetsList(monthKeyForSpent) {
      var mStats = monthStats(monthKeyForSpent);
      var maxSpent = 0;
      cats().forEach(function (c) { if (mStats.byCat[c.id] > maxSpent) maxSpent = mStats.byCat[c.id]; });
      maxSpent = maxSpent || 1;
      return cats().map(function (cat) {
        var limit = s.budgetLimits[cat.id] || 1;
        var spent = mStats.byCat[cat.id] || 0;
        var pct = Math.min(100, Math.round((spent / limit) * 100));
        var over = pct >= 90;
        var color = over ? negative : hue(cat.hue, 68, 0.14);
        var barHeightPct = Math.max(4, Math.round((spent / maxSpent) * 100));
        var limitMarkerTop = (100 - Math.min(100, Math.round((limit / maxSpent) * 100))) + '%';
        return {
          cat: cat.id, catName: cat.name, limit: limit, spent: spent,
          spentFmt: fmt(spent), limitFmt: fmt(limit), pctFmt: pct + '%', color: color,
          barHeightPct: barHeightPct + '%', limitMarkerTop: limitMarkerTop, spentShort: compact(spent)
        };
      });
    }

    var homeBudgetsList = buildBudgetsList(curKey);

    var repIdx = Math.max(0, Math.min(5, s.reportMonthIdx));
    var reportMonthKey = months[repIdx].key;
    var reportStats = monthStats(reportMonthKey);
    var reportBudgetsList = buildBudgetsList(reportMonthKey);

    var insights = [];
    if (repIdx > 0) {
      var prevKey = months[repIdx - 1].key;
      var prevStats = monthStats(prevKey);
      if (prevStats.expense > 0) {
        var diffPct = Math.round(((reportStats.expense - prevStats.expense) / prevStats.expense) * 100);
        if (diffPct !== 0) insights.push('支出比上月' + (diffPct > 0 ? '增加了 ' + diffPct + '%' : '减少了 ' + Math.abs(diffPct) + '%'));
      } else if (reportStats.expense > 0) {
        insights.push('上月没有支出记录，本月新增支出 ' + fmt(reportStats.expense));
      }
      if (prevStats.income > 0) {
        var incDiffPct = Math.round(((reportStats.income - prevStats.income) / prevStats.income) * 100);
        if (incDiffPct !== 0) insights.push('收入比上月' + (incDiffPct > 0 ? '增加了 ' + incDiffPct + '%' : '减少了 ' + Math.abs(incDiffPct) + '%'));
      }
    }
    var topCat = reportBudgetsList.slice().sort(function (a, b) { return b.spent - a.spent; })[0];
    if (topCat && topCat.spent > 0) {
      var topPct = reportStats.expense > 0 ? Math.round((topCat.spent / reportStats.expense) * 100) : 0;
      insights.push(topCat.catName + '支出最高，占本月支出的 ' + topPct + '%');
    }
    var overCats = reportBudgetsList.filter(function (b) { return b.limit > 0 && b.spent >= b.limit; });
    if (overCats.length) {
      insights.push(overCats.map(function (b) { return b.catName; }).join('、') + ' 已超出预算');
    }
    if (!insights.length) insights.push('这个月数据还不多，继续记账会有更多分析');

    var reportTotalSpent = reportStats.expense || 0;
    var acc = 0;
    var pieLegend = reportBudgetsList.map(function (b) {
      var pct = reportTotalSpent > 0 ? Math.round((b.spent / reportTotalSpent) * 100) : 0;
      return { name: b.catName, pctFmt: pct + '%', pct: pct, color: b.color };
    });
    var conicParts = [];
    if (reportTotalSpent > 0) {
      pieLegend.forEach(function (p) {
        var start = acc, end = acc + p.pct;
        conicParts.push(p.color + ' ' + start + '% ' + end + '%');
        acc = end;
      });
    } else {
      conicParts.push('var(--track) 0% 100%');
    }
    var pieBg = 'conic-gradient(' + conicParts.join(', ') + ')';

    var incomeTrend = months.map(function (m) { return monthStats(m.key).income; });
    var expenseTrend = months.map(function (m) { return monthStats(m.key).expense; });
    function seriesPoints(arr) {
      var min = Math.min.apply(null, arr), max = Math.max.apply(null, arr);
      var range = (max - min) || 1;
      return arr.map(function (v, i) {
        var x = (i / (arr.length - 1)) * 300;
        var y = 100 - ((v - min) / range) * 88;
        return { x: +x.toFixed(1), y: +y.toFixed(1) };
      });
    }
    var incomePts = seriesPoints(incomeTrend);
    var expensePts = seriesPoints(expenseTrend);
    var toStr = function (pts) { return pts.map(function (p) { return p.x + ',' + p.y; }).join(' '); };
    var toArea = function (pts) { return toStr(pts) + ' 300,108 0,108'; };

    var pIdx = Math.max(0, Math.min(5, s.budgetPeriodIdx));
    var periodMonth = months[pIdx];
    var periodBudgetsList = buildBudgetsList(periodMonth.key).map(function (b) {
      return Object.assign({}, b, {
        incLimit: 'adjustBudgetLimit', decLimit: 'adjustBudgetLimit'
      });
    });
    var periodTotalLimit = 0, periodTotalSpent = 0;
    periodBudgetsList.forEach(function (b) { periodTotalLimit += b.limit; periodTotalSpent += b.spent; });
    var periodPct = periodTotalLimit > 0 ? Math.round((periodTotalSpent / periodTotalLimit) * 100) : 0;

    var recentTx = state.transactions.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return b.id - a.id;
    }).slice(0, 4).map(function (t) {
      var cat = t.type === 'income' ? incomeCatById(t.cat) : catById(t.cat);
      var name = cat ? cat.name : (t.type === 'income' ? '收入' : '其他');
      var chue = t.type === 'income' ? 195 : (catById(t.cat) ? catById(t.cat).hue : 195);
      var sign = t.type === 'income' ? '+' : '−';
      return {
        id: t.id, note: t.note || name, catName: name, date: fmtDate(t.date),
        channelName: channelName(t.channel),
        swatchBg: hue(chue, 38, 0.04),
        amountFmt: sign + fmt(t.amount),
        amountColor: t.type === 'income' ? positive : 'oklch(90% 0.01 250)'
      };
    });

    var assetsList = s.assets.map(function (a) {
      var catInfo = assetCatById(a.category);
      var depTotal = a.buy - a.current;
      var days = Math.round(a.years * 365) || 1;
      var method = s.depMethods[a.id] || 'years';
      var rates = {
        years: { label: '年', denom: a.years || 1, unit: '年' },
        days: { label: '天', denom: days, unit: '天' },
        uses: { label: '次', denom: a.uses || 1, unit: '次' }
      };
      var r = rates[method];
      var rateVal = depTotal / r.denom;
      function pill(m) { return { bg: method === m ? accent : 'var(--surface2)', color: method === m ? '#0b1220' : 'var(--text-soft)' }; }
      var py = pill('years'), pd = pill('days'), pu = pill('uses');
      return Object.assign({}, a, {
        buyFmt: fmt(a.buy), currentFmt: fmt(a.current),
        catName: catInfo.name, catIcon: catInfo.icon, tracksDep: catInfo.tracksDep,
        iconBg: hue(230, 68, 0.13),
        depTotalFmt: fmt(depTotal), depRateFmt: r.label + '折旧 ' + fmt(rateVal) + '/' + r.unit,
        yearsBg: py.bg, yearsColor: py.color, daysBg: pd.bg, daysColor: pd.color, usesBg: pu.bg, usesColor: pu.color
      });
    });

    var assetCatBreakdown = ASSET_CATEGORIES.map(function (c) {
      var list = s.assets.filter(function (a) { return a.category === c.id; });
      var total = list.reduce(function (sum, a) { return sum + a.current; }, 0);
      return { id: c.id, name: c.name, icon: c.icon, count: list.length, total: total, totalFmt: fmt(total) };
    }).filter(function (c) { return c.count > 0; });

    var txCatSource = s.txType === 'expense' ? cats() : INCOME_CATS;
    var txCategoryOptions = txCatSource.map(function (c) {
      return { id: c.id, name: c.name, chipBg: s.txCategory === c.id ? accent : 'var(--surface2)', chipColor: s.txCategory === c.id ? '#0b1220' : 'var(--text-soft)' };
    });

    var streakDays = Math.max(1, Math.round((Date.parse(todayISO()) - Date.parse(s.streakStart)) / 86400000) + 1);
    var hasLoggedToday = s.transactions.some(function (t) { return t.date === todayISO(); });
    var pastReminderHour = new Date().getHours() >= 10;
    var showReminderBanner = s.remindOnOpen && pastReminderHour && !hasLoggedToday && s.reminderDismissedDate !== todayISO();

    return {
      accent: accent, negative: negative, positive: positive, heroBg: heroBg, skinName: skinName,
      skinIsPhoto: skinIsPhoto, months: months, curKey: curKey,
      monthIncomeFmt: fmt(homeStats.income), monthExpenseFmt: fmt(homeStats.expense), netBalanceFmt: fmt(net),
      budgetPct: budgetPct, budgetPctFmt: budgetPct + '%', budgetBarWidth: Math.min(100, budgetPct) + '%',
      totalLimit: totalLimit, totalSpent: totalSpent,
      assetsTotalFmt: fmt(assetsTotal), assetsBuyFmt: fmt(assetsBuy), assetsDiffFmt: (assetsDiffPct >= 0 ? '+' : '') + assetsDiffPct + '%',
      assetsDepTotalFmt: fmt(assetsBuy - assetsTotal),
      assetCatBreakdown: assetCatBreakdown,
      recentTx: recentTx, homeBudgetsList: homeBudgetsList,
      reportMonthLabel: months[repIdx].label, reportStats: reportStats, insights: insights,
      reportMonthIncomeFmt: fmt(reportStats.income), reportMonthExpenseFmt: fmt(reportStats.expense),
      reportNetFmt: fmt(reportStats.income - reportStats.expense),
      pieBg: pieBg, pieLegend: pieLegend, reportBudgetsList: reportBudgetsList,
      lineIncomePoints: toStr(incomePts), lineExpensePoints: toStr(expensePts),
      incomeAreaPoints: toArea(incomePts), expenseAreaPoints: toArea(expensePts),
      lastIncomeX: incomePts[incomePts.length - 1].x, lastIncomeY: incomePts[incomePts.length - 1].y,
      lastExpenseX: expensePts[expensePts.length - 1].x, lastExpenseY: expensePts[expensePts.length - 1].y,
      monthsLabels: months.map(function (m) { return m.label; }),
      periodLabel: periodMonth.year + '年' + periodMonth.month + '月',
      periodBudgetsList: periodBudgetsList, periodTotalLimit: periodTotalLimit, periodTotalSpent: periodTotalSpent, periodPct: periodPct,
      periodPctFmt: periodPct + '%', periodSpentFmt: fmt(periodTotalSpent), periodLimitFmt: fmt(periodTotalLimit),
      periodRemainFmt: fmt(periodTotalLimit - periodTotalSpent),
      periodRingBg: 'conic-gradient(' + accent + ' ' + Math.min(100, periodPct) + '%, var(--track) 0)',
      budgetRingBg: 'conic-gradient(' + accent + ' ' + Math.min(100, budgetPct) + '%, var(--track) 0)',
      assetsList: assetsList, customGradientCss: customGradientCss,
      txCategoryOptions: txCategoryOptions,
      piggyPct: Math.min(100, Math.round((s.piggyBalance / s.piggyGoal) * 100)) + '%',
      piggyBalanceFmt: fmt(s.piggyBalance), piggyGoalFmt: fmt(s.piggyGoal),
      streakDays: streakDays, showReminderBanner: showReminderBanner
    };
  }

  /* ---------- 各页面渲染 ---------- */
  function avatarBlock(d, size) {
    var img = state.avatarImg
      ? '<div style="width:' + size + 'px;height:' + size + 'px;border-radius:50%;background-image:url(' + state.avatarImg + ');background-size:cover;background-position:center;"></div>'
      : '<div style="width:' + size + 'px;height:' + size + 'px;border-radius:50%;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:' + Math.round(size * 0.42) + 'px;">🙂</div>';
    return img;
  }

  function renderHome(d) {
    var wallpaperLayer = d.skinIsPhoto
      ? (state.wallpaperImg
          ? '<div style="position:absolute;inset:0;background-image:url(' + state.wallpaperImg + ');background-size:cover;background-position:center;"></div><div style="position:absolute;inset:0;background:linear-gradient(180deg, rgba(0,0,0,.1), rgba(0,0,0,.55));"></div>'
          : '<div style="position:absolute;inset:0;background:var(--surface2);display:flex;align-items:center;justify-content:center;color:var(--text-mute);font-size:12px;">点击"换肤"上传照片</div>')
      : '<div style="position:absolute;inset:0;background:' + d.heroBg + ';"></div>';

    var txRows = d.recentTx.length ? d.recentTx.map(function (t) {
      return '<div data-act="editTx" data-arg="' + t.id + '" class="dc-btn" style="display:flex;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid color-mix(in oklch, var(--track) 60%, transparent);">'
        + '<div style="width:34px;height:34px;border-radius:10px;flex-shrink:0;background:' + t.swatchBg + ';"></div>'
        + '<div style="flex:1;min-width:0;">'
        + '<div style="font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(t.note) + '</div>'
        + '<div style="font-size:11px;color:var(--text-mute);margin-top:2px;">' + esc(t.catName) + (t.channelName ? ' · ' + esc(t.channelName) : '') + ' · ' + t.date + '</div>'
        + '</div>'
        + '<div style="font-family:var(--font-mono);font-size:14px;font-weight:700;flex-shrink:0;color:' + t.amountColor + ';">' + t.amountFmt + '</div>'
        + '<div data-act="deleteTx" data-arg="' + t.id + '" class="dc-btn" style="font-size:16px;color:var(--text-faint);padding:0 2px 0 4px;">×</div>'
        + '</div>';
    }).join('') : '<div style="padding:24px;text-align:center;color:var(--text-mute);font-size:12.5px;">还没有记录，点击下方 + 记一笔</div>';

    return '<div style="flex:1;overflow-y:auto;padding-top:calc(env(safe-area-inset-top,0px) + 20px);">'
      + '<div style="padding:0 20px 4px;display:flex;align-items:center;justify-content:space-between;">'
      + '<div><div style="font-size:12px;color:var(--text-mute);letter-spacing:.04em;">' + monthsWindow(1)[0].year + '年' + monthsWindow(1)[0].month + '月 · 早上好</div>'
      + '<div style="font-size:20px;font-weight:800;margin-top:2px;">' + (state.userName ? esc(state.userName) : '我的账本') + '</div></div>'
      + '<div data-act="setTab" data-arg="profile" class="dc-btn" style="flex-shrink:0;">' + avatarBlock(d, 38) + '</div>'
      + '</div>'

      + '<div style="margin:14px 20px 0;border-radius:22px;position:relative;overflow:hidden;box-shadow:0 12px 30px rgba(0,0,0,.35);">'
      + wallpaperLayer
      + '<div style="position:relative;z-index:2;padding:22px;">'
      + '<div data-act="openOverlay" data-arg="themes" class="dc-btn" style="position:absolute;top:16px;right:16px;font-size:11px;padding:5px 10px;border-radius:100px;background:rgba(0,0,0,.28);backdrop-filter:blur(6px);">换肤 ›</div>'
      + '<div style="font-size:12px;color:rgba(255,255,255,.72);">本月结余</div>'
      + '<div style="font-family:var(--font-mono);font-size:34px;font-weight:700;margin-top:4px;color:#fff;">' + d.netBalanceFmt + '</div>'
      + '<div style="display:flex;gap:18px;margin-top:14px;">'
      + '<div><div style="font-size:11px;color:rgba(255,255,255,.65);">收入</div><div style="font-family:var(--font-mono);font-size:15px;font-weight:600;color:#fff;">' + d.monthIncomeFmt + '</div></div>'
      + '<div style="width:1px;background:rgba(255,255,255,.2);"></div>'
      + '<div><div style="font-size:11px;color:rgba(255,255,255,.65);">支出</div><div style="font-family:var(--font-mono);font-size:15px;font-weight:600;color:#fff;">' + d.monthExpenseFmt + '</div></div>'
      + '</div></div></div>'

      + '<div style="display:flex;gap:12px;margin:14px 20px 0;">'
      + '<div data-act="setTab" data-arg="budget" class="dc-btn" style="flex:1;background:var(--surface);border-radius:16px;padding:14px;">'
      + '<div style="font-size:11px;color:var(--text-mute);">预算使用</div>'
      + '<div style="font-size:18px;font-weight:700;margin-top:4px;">' + d.budgetPctFmt + '</div>'
      + '<div style="height:5px;border-radius:3px;background:var(--track);margin-top:8px;overflow:hidden;"><div style="height:100%;border-radius:3px;width:' + d.budgetBarWidth + ';background:' + d.accent + ';"></div></div>'
      + '</div>'
      + '<div data-act="setTab" data-arg="assets" class="dc-btn" style="flex:1;background:var(--surface);border-radius:16px;padding:14px;">'
      + '<div style="font-size:11px;color:var(--text-mute);">资产总值</div>'
      + '<div style="font-family:var(--font-mono);font-size:18px;font-weight:700;margin-top:4px;">' + d.assetsTotalFmt + '</div>'
      + '<div style="font-size:11px;color:oklch(66% 0.19 25);margin-top:8px;">较购入 ' + d.assetsDiffFmt + '</div>'
      + '</div></div>'

      + '<div data-act="setTab" data-arg="report" class="dc-btn" style="margin:12px 20px 0;background:var(--surface);border-radius:16px;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;">'
      + '<div style="font-size:13px;font-weight:600;">查看本月完整财务报表</div><div style="font-size:16px;color:var(--text-mute);">›</div></div>'

      + reminderBanner(d)
      + overspendBanner(d)

      + '<div style="margin:18px 20px 8px;display:flex;align-items:center;justify-content:space-between;">'
      + '<div style="font-size:14px;font-weight:700;">近期收支</div>'
      + '<div data-act="setTab" data-arg="txlist" class="dc-btn" style="font-size:12px;color:var(--text-mute);">全部 ›</div></div>'
      + '<div style="margin:0 20px;background:var(--surface);border-radius:16px;overflow:hidden;">' + txRows + '</div>'
      + '<div style="height:110px;"></div>'
      + '</div>';
  }

  function reminderBanner(d) {
    if (!d.showReminderBanner) return '';
    return '<div style="margin:12px 20px 0;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:12px 14px;display:flex;align-items:center;gap:10px;">'
      + '<div style="font-size:16px;">📒</div>'
      + '<div data-act="openOverlay" data-arg="add" class="dc-btn" style="flex:1;font-size:12.5px;color:var(--text-soft);">今天还没记账，点这里记一笔</div>'
      + '<div data-act="dismissReminderBanner" class="dc-btn" style="font-size:12px;color:var(--text-faint);padding:2px 4px;">✕</div></div>';
  }

  function overspendBanner(d) {
    var over = d.homeBudgetsList.filter(function (b) { return b.limit > 0 && (b.spent / b.limit) >= 0.9; });
    if (!over.length) return '';
    var names = over.map(function (b) { return b.catName + (b.spent >= b.limit ? '已超支' : '已用' + Math.round((b.spent / b.limit) * 100) + '%'); }).join(' · ');
    return '<div data-act="setTab" data-arg="budget" class="dc-btn" style="margin:12px 20px 0;background:oklch(30% 0.05 25);border:1px solid oklch(45% 0.1 25);border-radius:14px;padding:12px 14px;display:flex;align-items:center;gap:10px;">'
      + '<div style="font-size:16px;">⚠️</div>'
      + '<div style="flex:1;font-size:12px;color:oklch(88% 0.04 25);">' + esc(names) + '</div>'
      + '<div style="font-size:14px;color:oklch(80% 0.05 25);">›</div></div>';
  }

  function renderReport(d) {
    var pieLegendHtml = d.pieLegend.map(function (p) {
      return '<div style="display:flex;align-items:center;gap:8px;font-size:12.5px;">'
        + '<div style="width:9px;height:9px;border-radius:2px;flex-shrink:0;background:' + p.color + ';"></div>'
        + '<div style="flex:1;color:var(--text-soft);font-weight:500;">' + esc(p.name) + '</div>'
        + '<div style="font-family:var(--font-mono);font-weight:700;color:' + p.color + ';">' + p.pctFmt + '</div></div>';
    }).join('');

    var monthLabelsHtml = d.monthsLabels.map(function (m) { return '<div style="font-size:10px;color:var(--text-mute);">' + m + '</div>'; }).join('');

    var barsHtml = d.reportBudgetsList.map(function (b) {
      return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;">'
        + '<div style="width:100%;max-width:30px;height:104px;border-radius:6px 6px 0 0;position:relative;">'
        + '<div style="position:absolute;left:-5px;right:-5px;border-top:1.5px dashed var(--text-mute);top:' + b.limitMarkerTop + ';"></div>'
        + '<div style="position:absolute;bottom:0;left:0;right:0;border-radius:6px 6px 0 0;height:' + b.barHeightPct + ';background:' + b.color + ';">'
        + '<div style="position:absolute;top:-16px;left:50%;transform:translateX(-50%);font-size:9px;font-family:var(--font-mono);color:var(--text-soft);white-space:nowrap;">' + b.spentShort + '</div>'
        + '</div></div>'
        + '<div style="font-size:10px;color:var(--text-faint);">' + esc(b.catName) + '</div></div>';
    }).join('');

    return '<div style="flex:1;overflow-y:auto;padding-top:calc(env(safe-area-inset-top,0px) + 20px);">'
      + '<div style="padding:0 20px;display:flex;align-items:center;justify-content:space-between;">'
      + '<div style="font-size:20px;font-weight:800;">月度报表</div>'
      + '<div style="display:flex;align-items:center;gap:14px;background:var(--surface);border-radius:100px;padding:6px 12px;">'
      + '<div data-act="moveMonth" data-arg="-1" class="dc-btn" style="font-size:14px;color:var(--text-mute);">‹</div>'
      + '<div style="font-size:13px;font-weight:700;min-width:44px;text-align:center;">' + d.reportMonthLabel + '</div>'
      + '<div data-act="moveMonth" data-arg="1" class="dc-btn" style="font-size:14px;color:var(--text-mute);">›</div>'
      + '</div></div>'

      + '<div style="display:flex;gap:10px;margin:16px 20px 0;">'
      + '<div style="flex:1;background:var(--surface);border-radius:14px;padding:12px;"><div style="font-size:10.5px;color:var(--text-mute);">收入</div><div style="font-family:var(--font-mono);font-size:15px;font-weight:700;color:oklch(72% 0.16 150);margin-top:3px;">' + d.reportMonthIncomeFmt + '</div></div>'
      + '<div style="flex:1;background:var(--surface);border-radius:14px;padding:12px;"><div style="font-size:10.5px;color:var(--text-mute);">支出</div><div style="font-family:var(--font-mono);font-size:15px;font-weight:700;color:oklch(66% 0.19 25);margin-top:3px;">' + d.reportMonthExpenseFmt + '</div></div>'
      + '<div style="flex:1;background:var(--surface);border-radius:14px;padding:12px;"><div style="font-size:10.5px;color:var(--text-mute);">结余</div><div style="font-family:var(--font-mono);font-size:15px;font-weight:700;margin-top:3px;">' + d.reportNetFmt + '</div></div>'
      + '</div>'

      + '<div style="margin:16px 20px 0;background:var(--surface);border-radius:18px;padding:16px;">'
      + '<div style="font-size:13px;font-weight:700;margin-bottom:12px;">支出构成</div>'
      + '<div style="display:flex;align-items:center;gap:20px;">'
      + '<div style="width:118px;height:118px;border-radius:50%;flex-shrink:0;position:relative;background:' + d.pieBg + ';">'
      + '<div style="position:absolute;inset:16px;border-radius:50%;background:var(--surface);display:flex;flex-direction:column;align-items:center;justify-content:center;">'
      + '<div style="font-size:9.5px;color:var(--text-mute);">总支出</div><div style="font-family:var(--font-mono);font-size:13px;font-weight:700;">' + d.reportMonthExpenseFmt + '</div></div></div>'
      + '<div style="flex:1;display:flex;flex-direction:column;gap:9px;">' + pieLegendHtml + '</div>'
      + '</div></div>'

      + '<div style="margin:14px 20px 0;background:var(--surface);border-radius:18px;padding:16px;">'
      + '<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:2px;">'
      + '<div style="font-size:13px;font-weight:700;">近6个月趋势</div>'
      + '<div style="display:flex;gap:12px;">'
      + '<div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text-mute);"><div style="width:8px;height:8px;border-radius:50%;background:oklch(72% 0.16 150);"></div>收入</div>'
      + '<div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text-mute);"><div style="width:8px;height:8px;border-radius:50%;background:oklch(66% 0.19 25);"></div>支出</div>'
      + '</div></div>'
      + '<div style="position:relative;margin-top:10px;">'
      + '<div style="position:absolute;left:0;right:0;top:0;height:1px;background:color-mix(in oklch, var(--border) 50%, transparent);"></div>'
      + '<div style="position:absolute;left:0;right:0;top:50%;height:1px;background:color-mix(in oklch, var(--border) 50%, transparent);"></div>'
      + '<div style="position:absolute;left:0;right:0;bottom:0;height:1px;background:color-mix(in oklch, var(--border) 50%, transparent);"></div>'
      + '<svg viewBox="0 0 300 110" style="width:100%;height:112px;overflow:visible;display:block;">'
      + '<defs><linearGradient id="incFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="oklch(72% 0.16 150)" stop-opacity=".32"></stop><stop offset="100%" stop-color="oklch(72% 0.16 150)" stop-opacity="0"></stop></linearGradient>'
      + '<linearGradient id="expFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="oklch(66% 0.19 25)" stop-opacity=".32"></stop><stop offset="100%" stop-color="oklch(66% 0.19 25)" stop-opacity="0"></stop></linearGradient></defs>'
      + '<polygon points="' + d.incomeAreaPoints + '" fill="url(#incFill)"></polygon>'
      + '<polygon points="' + d.expenseAreaPoints + '" fill="url(#expFill)"></polygon>'
      + '<polyline points="' + d.lineIncomePoints + '" fill="none" stroke="oklch(72% 0.16 150)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>'
      + '<polyline points="' + d.lineExpensePoints + '" fill="none" stroke="oklch(66% 0.19 25)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>'
      + '<circle cx="' + d.lastIncomeX + '" cy="' + d.lastIncomeY + '" r="4.5" fill="oklch(72% 0.16 150)"></circle>'
      + '<circle cx="' + d.lastExpenseX + '" cy="' + d.lastExpenseY + '" r="4.5" fill="oklch(66% 0.19 25)"></circle>'
      + '</svg></div>'
      + '<div style="display:flex;justify-content:space-between;margin-top:8px;">' + monthLabelsHtml + '</div>'
      + '</div>'

      + '<div style="margin:14px 20px 0;background:var(--surface);border-radius:18px;padding:16px;">'
      + '<div style="font-size:13px;font-weight:700;margin-bottom:10px;">💡 消费洞察</div>'
      + '<div style="display:flex;flex-direction:column;gap:8px;">' + d.insights.map(function (t) {
        return '<div style="font-size:12.5px;color:var(--text-soft);line-height:1.5;">· ' + esc(t) + '</div>';
      }).join('') + '</div></div>'

      + '<div style="margin:14px 20px 0;background:var(--surface);border-radius:18px;padding:16px;">'
      + '<div style="font-size:13px;font-weight:700;margin-bottom:4px;">预算 vs 实际</div>'
      + '<div style="font-size:11px;color:var(--text-mute);margin-bottom:16px;">柱高 = 实际支出 · 虚线 = 预算上限</div>'
      + '<div style="display:flex;align-items:flex-end;gap:14px;">' + barsHtml + '</div></div>'
      + '<div style="margin:14px 20px 0;text-align:center;padding:12px;border:1px solid var(--border);border-radius:14px;font-size:12px;color:var(--text-mute);">报表根据本机记录自动汇总</div>'
      + '<div style="height:110px;"></div></div>';
  }

  function renderAssets(d) {
    var rows = d.assetsList.length ? d.assetsList.map(function (a) {
      var depSection = a.tracksDep
        ? ('<div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;padding-top:12px;border-top:1px solid color-mix(in oklch, var(--border) 50%, transparent);">'
          + '<div style="font-size:11px;color:oklch(66% 0.19 25);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1;margin-right:8px;">折旧' + a.depTotalFmt + ' · ' + a.depRateFmt + '</div>'
          + '<div style="display:flex;gap:4px;background:var(--surface2);border-radius:100px;padding:3px;flex-shrink:0;">'
          + '<div data-act="setDepMethod" data-arg="' + a.id + '|years" class="dc-btn" style="padding:4px 9px;border-radius:100px;font-size:10.5px;font-weight:600;background:' + a.yearsBg + ';color:' + a.yearsColor + ';">年</div>'
          + '<div data-act="setDepMethod" data-arg="' + a.id + '|days" class="dc-btn" style="padding:4px 9px;border-radius:100px;font-size:10.5px;font-weight:600;background:' + a.daysBg + ';color:' + a.daysColor + ';">天</div>'
          + '<div data-act="setDepMethod" data-arg="' + a.id + '|uses" class="dc-btn" style="padding:4px 9px;border-radius:100px;font-size:10.5px;font-weight:600;background:' + a.usesBg + ';color:' + a.usesColor + ';">次</div>'
          + '</div></div>')
        : '';
      return '<div style="background:var(--surface);border-radius:16px;padding:14px;">'
        + '<div style="display:flex;gap:12px;align-items:center;">'
        + '<div style="width:42px;height:42px;border-radius:12px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:19px;background:' + a.iconBg + ';">' + a.catIcon + '</div>'
        + '<div style="flex:1;min-width:0;"><div style="font-size:13.5px;font-weight:600;">' + esc(a.name) + '</div>'
        + '<div style="font-size:11px;color:var(--text-faint);margin-top:2px;">' + esc(a.catName) + (a.tracksDep ? ' · 已用' + a.years + '年' : '') + '</div></div>'
        + '<div style="text-align:right;flex-shrink:0;"><div style="font-family:var(--font-mono);font-size:14px;font-weight:700;">' + a.currentFmt + '</div>'
        + (a.tracksDep ? '<div style="font-size:10.5px;color:var(--text-faint);margin-top:2px;">购入 ' + a.buyFmt + '</div>' : '')
        + '</div>'
        + '<div data-act="deleteAsset" data-arg="' + a.id + '" class="dc-btn" style="font-size:15px;color:var(--text-faint);padding:0 0 0 8px;">×</div>'
        + '</div>'
        + depSection + '</div>';
    }).join('') : '<div style="padding:24px;text-align:center;color:var(--text-mute);font-size:12.5px;">还没有资产记录</div>';

    var breakdownHtml = d.assetCatBreakdown.length ? d.assetCatBreakdown.map(function (c) {
      return '<div style="flex:1;min-width:88px;background:var(--surface);border-radius:14px;padding:12px;text-align:center;">'
        + '<div style="font-size:18px;">' + c.icon + '</div>'
        + '<div style="font-family:var(--font-mono);font-size:13px;font-weight:700;margin-top:4px;">' + c.totalFmt + '</div>'
        + '<div style="font-size:10.5px;color:var(--text-mute);margin-top:2px;">' + esc(c.name) + ' · ' + c.count + '项</div></div>';
    }).join('') : '';

    return '<div style="flex:1;overflow-y:auto;padding-top:calc(env(safe-area-inset-top,0px) + 20px);">'
      + '<div style="padding:0 20px;font-size:20px;font-weight:800;">资产清单</div>'
      + '<div style="margin:14px 20px 0;background:var(--surface);border-radius:18px;padding:18px;">'
      + '<div style="font-size:11.5px;color:var(--text-mute);">资产现值合计</div>'
      + '<div style="font-family:var(--font-mono);font-size:28px;font-weight:700;margin-top:4px;">' + d.assetsTotalFmt + '</div>'
      + '<div style="font-size:12px;color:var(--text-mute);margin-top:6px;">购入总值 ' + d.assetsBuyFmt + ' · 总折旧 ' + d.assetsDepTotalFmt + '（' + d.assetsDiffFmt + '）</div></div>'
      + (breakdownHtml ? ('<div style="display:flex;flex-wrap:wrap;gap:10px;margin:14px 20px 0;">' + breakdownHtml + '</div>') : '')
      + '<div style="margin:16px 20px 8px;font-size:14px;font-weight:700;">全部资产</div>'
      + '<div style="margin:0 20px;display:flex;flex-direction:column;gap:10px;">' + rows + '</div>'
      + '<div data-act="openAddAsset" class="dc-btn" style="margin:16px 20px 0;border:1.5px dashed var(--border);border-radius:16px;padding:14px;text-align:center;font-size:13px;color:var(--text-mute);">+ 添加资产</div>'
      + '<div style="height:110px;"></div></div>';
  }

  function renderProfile(d) {
    var accentSwatches = ACCENT_HUES.map(function (h) {
      var c = hue(h, 72, 0.14);
      var ring = h === state.accentHue ? ('2px solid ' + c) : '2px solid var(--border)';
      return '<div data-act="setAccent" data-arg="' + h + '" class="dc-btn" style="width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:' + ring + ';"><div style="width:24px;height:24px;border-radius:50%;background:' + c + ';"></div></div>';
    }).join('');

    var wallpaperLayer = d.skinIsPhoto
      ? (state.wallpaperImg ? '<div style="position:absolute;inset:0;background-image:url(' + state.wallpaperImg + ');background-size:cover;background-position:center;"></div><div style="position:absolute;inset:0;background:linear-gradient(180deg, rgba(0,0,0,.1), rgba(0,0,0,.55));"></div>' : '<div style="position:absolute;inset:0;background:var(--surface2);"></div>')
      : '<div style="position:absolute;inset:0;background:' + d.heroBg + ';"></div>';

    var modeLightBg = state.mode === 'light' ? d.accent : 'transparent', modeLightColor = state.mode === 'light' ? '#0b1220' : 'var(--text-mute)';
    var modeDarkBg = state.mode === 'dark' ? d.accent : 'transparent', modeDarkColor = state.mode === 'dark' ? '#0b1220' : 'var(--text-mute)';

    return '<div style="flex:1;overflow-y:auto;padding-top:calc(env(safe-area-inset-top,0px) + 20px);">'
      + '<div style="padding:0 20px;display:flex;align-items:center;gap:14px;">'
      + '<div data-act="pickAvatar" class="dc-btn">' + avatarBlock(d, 56) + '</div>'
      + '<div><div style="font-size:17px;font-weight:800;">' + (state.userName ? esc(state.userName) + '的账本' : '我的账本') + '</div><div style="font-size:12px;color:var(--text-mute);margin-top:3px;">已连续记账 ' + d.streakDays + ' 天</div></div></div>'

      + '<div data-act="openOverlay" data-arg="themes" class="dc-btn" style="margin:20px 20px 0;border-radius:18px;position:relative;overflow:hidden;">'
      + wallpaperLayer
      + '<div style="position:relative;z-index:2;padding:16px;display:flex;align-items:center;justify-content:space-between;">'
      + '<div><div style="font-size:11px;color:rgba(255,255,255,.7);">当前主题皮肤</div><div style="font-size:16px;font-weight:700;color:#fff;margin-top:3px;">' + esc(d.skinName) + '</div></div>'
      + '<div style="font-size:12px;padding:6px 12px;border-radius:100px;background:rgba(0,0,0,.28);color:#fff;">更换 ›</div></div></div>'

      + '<div style="margin:14px 20px 0;"><div style="font-size:11px;color:var(--text-mute);text-transform:uppercase;letter-spacing:.05em;padding:0 4px 8px;">强调色</div>'
      + '<div style="background:var(--surface);border-radius:16px;padding:14px;display:flex;gap:14px;">' + accentSwatches + '</div></div>'

      + '<div style="margin:14px 20px 0;"><div style="font-size:11px;color:var(--text-mute);text-transform:uppercase;letter-spacing:.05em;padding:0 4px 8px;">外观模式</div>'
      + '<div style="display:flex;background:var(--surface2);border-radius:100px;padding:4px;">'
      + '<div data-act="setMode" data-arg="light" class="dc-btn" style="flex:1;text-align:center;padding:9px 0;border-radius:100px;font-size:12.5px;font-weight:700;background:' + modeLightBg + ';color:' + modeLightColor + ';">白天</div>'
      + '<div data-act="setMode" data-arg="dark" class="dc-btn" style="flex:1;text-align:center;padding:9px 0;border-radius:100px;font-size:12.5px;font-weight:700;background:' + modeDarkBg + ';color:' + modeDarkColor + ';">夜晚</div>'
      + '</div></div>'

      + '<div style="margin:14px 20px 0;">'
      + '<div style="font-size:11px;color:var(--text-mute);text-transform:uppercase;letter-spacing:.05em;padding:0 4px 8px;">分类与预算</div>'
      + '<div style="background:var(--surface);border-radius:16px;overflow:hidden;">'
      + '<div data-act="openOverlay" data-arg="manageCategories" class="dc-btn" style="padding:14px 16px;font-size:13.5px;border-bottom:1px solid color-mix(in oklch, var(--track) 60%, transparent);display:flex;justify-content:space-between;">分类管理<span style="color:var(--text-mute);">' + cats().length + ' 个 ›</span></div>'
      + '<div data-act="openOverlay" data-arg="editBudget" class="dc-btn" style="padding:14px 16px;font-size:13.5px;display:flex;justify-content:space-between;">编辑预算<span style="color:var(--text-mute);">›</span></div>'
      + '</div></div>'

      + '<div style="margin:14px 20px 0;">'
      + '<div style="font-size:11px;color:var(--text-mute);text-transform:uppercase;letter-spacing:.05em;padding:0 4px 8px;">数据备份</div>'
      + '<div style="background:var(--surface);border-radius:16px;overflow:hidden;">'
      + '<div data-act="exportBackup" class="dc-btn" style="padding:14px 16px;font-size:13.5px;border-bottom:1px solid color-mix(in oklch, var(--track) 60%, transparent);display:flex;justify-content:space-between;">导出备份文件<span style="color:var(--text-mute);">›</span></div>'
      + '<div data-act="pickImportFile" class="dc-btn" style="padding:14px 16px;font-size:13.5px;display:flex;justify-content:space-between;">导入备份文件<span style="color:var(--text-mute);">›</span></div>'
      + '</div>'
      + '<div style="font-size:11px;color:var(--text-faint);padding:8px 4px 0;">数据只保存在本机浏览器里，换设备前记得先导出备份</div></div>'

      + '<div style="margin:14px 20px 0;">'
      + '<div style="font-size:11px;color:var(--text-mute);text-transform:uppercase;letter-spacing:.05em;padding:0 4px 8px;">批量导入账单</div>'
      + '<div style="background:var(--surface);border-radius:16px;overflow:hidden;">'
      + '<div data-act="pickAlipayBill" class="dc-btn" style="padding:14px 16px;font-size:13.5px;border-bottom:1px solid color-mix(in oklch, var(--track) 60%, transparent);display:flex;justify-content:space-between;">导入支付宝账单 CSV<span style="color:var(--text-mute);">›</span></div>'
      + '<div data-act="pickWechatBill" class="dc-btn" style="padding:14px 16px;font-size:13.5px;display:flex;justify-content:space-between;">导入微信支付账单 CSV<span style="color:var(--text-mute);">›</span></div>'
      + '</div>'
      + '<div style="font-size:11px;color:var(--text-faint);padding:8px 4px 0;">在支付宝/微信 App 里导出账单明细（CSV 格式），导入后会先给你核对一遍再存进账本</div></div>'

      + '<div style="margin:14px 20px 0;">'
      + '<div style="font-size:11px;color:var(--text-mute);text-transform:uppercase;letter-spacing:.05em;padding:0 4px 8px;">安全锁</div>'
      + '<div style="background:var(--surface);border-radius:16px;overflow:hidden;">'
      + '<div style="padding:14px 16px;font-size:13.5px;display:flex;justify-content:space-between;align-items:center;' + (state.security.pinEnabled ? 'border-bottom:1px solid color-mix(in oklch, var(--track) 60%, transparent);' : '') + '">'
      + '<div>开启安全锁</div>'
      + '<div data-act="toggleSecurity" class="dc-btn" style="width:42px;height:24px;border-radius:100px;position:relative;background:' + (state.security.pinEnabled ? d.accent : 'var(--track)') + ';"><div style="position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform .15s ease;transform:' + (state.security.pinEnabled ? 'translateX(18px)' : 'translateX(0)') + ';"></div></div>'
      + '</div>'
      + (state.security.pinEnabled ? '<div data-act="changePin" class="dc-btn" style="padding:14px 16px;font-size:13.5px;display:flex;justify-content:space-between;">修改密码<span style="color:var(--text-mute);">›</span></div>' : '')
      + '</div>'
      + '<div style="font-size:11px;color:var(--text-faint);padding:8px 4px 0;">简单的 4 位数字锁，用于防止旁人随手打开查看，不是真正的加密</div></div>'

      + '<div style="margin:14px 20px 0;background:var(--surface);border-radius:16px;overflow:hidden;">'
      + '<div data-act="openOverlay" data-arg="reminders" class="dc-btn" style="padding:14px 16px;font-size:13.5px;border-bottom:1px solid color-mix(in oklch, var(--track) 60%, transparent);display:flex;justify-content:space-between;">记账提醒<span style="color:var(--text-mute);">›</span></div>'
      + '<div data-act="switchAccount" class="dc-btn" style="padding:14px 16px;font-size:13.5px;border-bottom:1px solid color-mix(in oklch, var(--track) 60%, transparent);display:flex;justify-content:space-between;">切换 / 新建账号<span style="color:var(--text-mute);">›</span></div>'
      + '<div data-act="toastGeneric" class="dc-btn" style="padding:14px 16px;font-size:13.5px;display:flex;justify-content:space-between;">关于策方<span style="color:var(--text-mute);">›</span></div>'
      + '</div>'
      + '<div style="height:110px;"></div></div>';
  }

  function renderBudget(d) {
    var rows = d.periodBudgetsList.map(function (b) {
      return '<div style="background:var(--surface);border-radius:16px;padding:14px;">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;">'
        + '<div style="display:flex;align-items:center;gap:8px;"><div style="width:9px;height:9px;border-radius:2px;background:' + b.color + ';"></div><div style="font-size:13.5px;font-weight:600;">' + esc(b.catName) + '</div></div>'
        + '<div style="font-family:var(--font-mono);font-size:12.5px;color:var(--text-mute);">' + b.spentFmt + ' / ' + b.limitFmt + '</div></div>'
        + '<div style="height:6px;border-radius:3px;background:var(--track);margin-top:10px;overflow:hidden;"><div style="height:100%;border-radius:3px;width:' + b.pctFmt + ';background:' + b.color + ';"></div></div></div>';
    }).join('');

    var piggyHistoryHtml = state.piggyHistory.map(function (h) {
      return '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-faint);margin-top:6px;"><div>' + esc(h.label) + ' 存入</div><div style="font-family:var(--font-mono);">+' + fmt(h.amount) + '</div></div>';
    }).join('');

    return '<div style="flex:1;overflow-y:auto;padding-top:calc(env(safe-area-inset-top,0px) + 20px);">'
      + '<div style="padding:0 20px;display:flex;align-items:center;justify-content:space-between;">'
      + '<div style="font-size:20px;font-weight:800;">预算规划</div>'
      + '<div style="display:flex;align-items:center;gap:14px;background:var(--surface);border-radius:100px;padding:6px 12px;">'
      + '<div data-act="moveBudgetPeriod" data-arg="-1" class="dc-btn" style="font-size:14px;color:var(--text-mute);">‹</div>'
      + '<div style="font-size:13px;font-weight:700;min-width:64px;text-align:center;">' + d.periodLabel + '</div>'
      + '<div data-act="moveBudgetPeriod" data-arg="1" class="dc-btn" style="font-size:14px;color:var(--text-mute);">›</div>'
      + '</div></div>'

      + '<div style="margin:16px 20px 0;display:flex;align-items:center;gap:20px;background:var(--surface);border-radius:20px;padding:20px;">'
      + '<div style="width:96px;height:96px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;position:relative;background:' + d.periodRingBg + ';">'
      + '<div style="width:70px;height:70px;border-radius:50%;background:var(--surface);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;">' + d.periodPctFmt + '</div></div>'
      + '<div style="flex:1;"><div style="font-size:11.5px;color:var(--text-mute);">已用 / 预算总额</div>'
      + '<div style="font-family:var(--font-mono);font-size:14px;font-weight:700;margin-top:4px;white-space:nowrap;">' + d.periodSpentFmt + ' / ' + d.periodLimitFmt + '</div>'
      + '<div style="font-size:12px;color:var(--text-mute);margin-top:8px;">剩余 ' + d.periodRemainFmt + '</div></div>'
      + '<div data-act="openOverlay" data-arg="editBudget" class="dc-btn" style="flex-shrink:0;font-size:12px;font-weight:700;padding:9px 14px;border-radius:100px;background:' + d.accent + ';color:#0b1220;white-space:nowrap;">编辑预算</div>'
      + '</div>'

      + '<div style="margin:18px 20px 0;background:var(--surface);border-radius:18px;padding:16px;">'
      + '<div style="display:flex;align-items:center;justify-content:space-between;"><div style="font-size:13px;font-weight:700;">存钱罐</div><div style="font-size:11px;color:var(--text-mute);">目标 ' + d.piggyGoalFmt + '</div></div>'
      + '<div style="font-family:var(--font-mono);font-size:24px;font-weight:700;margin-top:8px;">' + d.piggyBalanceFmt + '</div>'
      + '<div style="height:8px;border-radius:4px;background:var(--track);margin-top:10px;overflow:hidden;"><div style="height:100%;border-radius:4px;width:' + d.piggyPct + ';background:' + d.accent + ';"></div></div>'
      + '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;">'
      + '<div style="font-size:11px;color:var(--text-mute);">点击右侧按钮存入储蓄罐</div>'
      + '<div data-act="openOverlay" data-arg="piggyDeposit" class="dc-btn" style="font-size:12px;font-weight:700;padding:6px 12px;border-radius:100px;background:' + d.accent + ';color:#0b1220;">+ 存入</div>'
      + '</div>' + piggyHistoryHtml + '</div>'

      + '<div style="margin:18px 20px 8px;display:flex;align-items:center;justify-content:space-between;">'
      + '<div style="font-size:14px;font-weight:700;">分类预算</div>'
      + '<div data-act="openOverlay" data-arg="editBudget" class="dc-btn" style="font-size:12px;font-weight:700;color:' + d.accent + ';">编辑 ›</div></div>'
      + '<div style="margin:0 20px;display:flex;flex-direction:column;gap:10px;">' + rows + '</div>'
      + '<div style="height:110px;"></div></div>';
  }

  function renderTxList(d) {
    var f = state.txList;
    var months = d.months;
    var all = state.transactions.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return b.id - a.id;
    });
    var filtered = all.filter(function (t) {
      if (f.type !== 'all' && t.type !== f.type) return false;
      if (f.cat !== 'all' && t.cat !== f.cat) return false;
      if (f.monthKey !== 'all' && txMonthKey(t) !== f.monthKey) return false;
      if (f.search) {
        var kw = f.search.toLowerCase();
        var cat = t.type === 'income' ? incomeCatById(t.cat) : catById(t.cat);
        var hay = ((t.note || '') + ' ' + (cat ? cat.name : '')).toLowerCase();
        if (hay.indexOf(kw) < 0) return false;
      }
      return true;
    });

    var catOptions = '<option value="all">全部分类</option>'
      + cats().map(function (c) { return '<option value="' + c.id + '"' + (f.cat === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('')
      + INCOME_CATS.map(function (c) { return '<option value="' + c.id + '"' + (f.cat === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('');
    var monthOptions = '<option value="all">全部时间</option>'
      + months.slice().reverse().map(function (m) { return '<option value="' + m.key + '"' + (f.monthKey === m.key ? ' selected' : '') + '>' + m.year + '年' + m.label + '</option>'; }).join('');

    var rows = filtered.length ? filtered.map(function (t) {
      var cat = t.type === 'income' ? incomeCatById(t.cat) : catById(t.cat);
      var name = cat ? cat.name : (t.type === 'income' ? '收入' : '其他');
      var chue = t.type === 'income' ? 195 : (catById(t.cat) ? catById(t.cat).hue : 195);
      var sign = t.type === 'income' ? '+' : '−';
      var amountColor = t.type === 'income' ? d.positive : 'oklch(90% 0.01 250)';
      return '<div data-act="editTx" data-arg="' + t.id + '" class="dc-btn" style="display:flex;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid color-mix(in oklch, var(--track) 60%, transparent);">'
        + '<div style="width:34px;height:34px;border-radius:10px;flex-shrink:0;background:' + hue(chue, 38, 0.04) + ';"></div>'
        + '<div style="flex:1;min-width:0;"><div style="font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(t.note || name) + '</div>'
        + '<div style="font-size:11px;color:var(--text-mute);margin-top:2px;">' + esc(name) + (t.channel ? ' · ' + esc(channelName(t.channel)) : '') + ' · ' + t.date + '</div></div>'
        + '<div style="font-family:var(--font-mono);font-size:14px;font-weight:700;flex-shrink:0;color:' + amountColor + ';">' + sign + fmt(t.amount) + '</div>'
        + '<div data-act="deleteTx" data-arg="' + t.id + '" class="dc-btn" style="font-size:16px;color:var(--text-faint);padding:0 2px 0 4px;">×</div></div>';
    }).join('') : '<div style="padding:24px;text-align:center;color:var(--text-mute);font-size:12.5px;">没有匹配的记录</div>';

    var selectStyle = 'flex:1;background:var(--surface2);border:none;border-radius:10px;padding:9px 8px;font-size:12px;color:var(--text);outline:none;';

    return '<div style="flex:1;overflow-y:auto;padding-top:calc(env(safe-area-inset-top,0px) + 20px);">'
      + '<div style="padding:0 20px;display:flex;align-items:center;gap:12px;">'
      + '<div data-act="setTab" data-arg="home" class="dc-btn" style="font-size:18px;color:var(--text-mute);">‹</div>'
      + '<div style="font-size:20px;font-weight:800;">全部记录</div></div>'
      + '<div style="margin:14px 20px 0;">'
      + '<input data-bind="txList.search" data-live="1" value="' + esc(f.search) + '" placeholder="搜索备注或分类" style="width:100%;background:var(--surface);border:none;border-radius:12px;padding:11px 14px;font-size:13px;color:var(--text);outline:none;">'
      + '</div>'
      + '<div style="display:flex;gap:8px;margin:10px 20px 0;">'
      + '<select data-bind="txList.type" style="' + selectStyle + '"><option value="all"' + (f.type === 'all' ? ' selected' : '') + '>全部类型</option><option value="expense"' + (f.type === 'expense' ? ' selected' : '') + '>支出</option><option value="income"' + (f.type === 'income' ? ' selected' : '') + '>收入</option></select>'
      + '<select data-bind="txList.cat" style="' + selectStyle + '">' + catOptions + '</select>'
      + '<select data-bind="txList.monthKey" style="' + selectStyle + '">' + monthOptions + '</select>'
      + '</div>'
      + '<div style="margin:10px 20px 0;font-size:11px;color:var(--text-mute);">共 ' + filtered.length + ' 条记录</div>'
      + '<div style="margin:8px 20px 0;background:var(--surface);border-radius:16px;overflow:hidden;">' + rows + '</div>'
      + '<div style="height:110px;"></div></div>';
  }

  function renderBillReview(d) {
    var rows = state.billRows;
    var includedCount = rows.filter(function (r) { return r.include; }).length;
    var rowsHtml = rows.length ? rows.map(function (r, idx) {
      var sign = r.type === 'income' ? '+' : '−';
      var amountColor = r.type === 'income' ? d.positive : 'oklch(90% 0.01 250)';
      var catOptions = (r.type === 'expense' ? cats() : INCOME_CATS).map(function (c) {
        return '<option value="' + c.id + '"' + (r.cat === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>';
      }).join('');
      return '<div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid color-mix(in oklch, var(--track) 60%, transparent);opacity:' + (r.include ? 1 : 0.4) + ';">'
        + '<div data-act="toggleBillRow" data-arg="' + idx + '" class="dc-btn" style="width:20px;height:20px;border-radius:6px;flex-shrink:0;background:' + (r.include ? d.accent : 'var(--surface2)') + ';display:flex;align-items:center;justify-content:center;font-size:12px;color:#0b1220;">' + (r.include ? '✓' : '') + '</div>'
        + '<div style="flex:1;min-width:0;">'
        + '<div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(r.note || '（无备注）') + '</div>'
        + '<div style="font-size:10.5px;color:var(--text-mute);margin-top:2px;">' + r.date + ' · ' + esc(channelName(r.channel)) + '</div>'
        + '<select data-bill-idx="' + idx + '" style="margin-top:6px;background:var(--surface2);border:none;border-radius:8px;padding:5px 8px;font-size:11.5px;color:var(--text);outline:none;">' + catOptions + '</select>'
        + '</div>'
        + '<div style="font-family:var(--font-mono);font-size:13.5px;font-weight:700;flex-shrink:0;color:' + amountColor + ';">' + sign + fmt(r.amount) + '</div>'
        + '</div>';
    }).join('') : '<div style="padding:24px;text-align:center;color:var(--text-mute);font-size:12.5px;">没有可导入的记录</div>';

    return '<div style="flex:1;overflow-y:auto;padding-top:calc(env(safe-area-inset-top,0px) + 20px);">'
      + '<div style="padding:0 20px;display:flex;align-items:center;gap:12px;">'
      + '<div data-act="cancelBillImport" class="dc-btn" style="font-size:18px;color:var(--text-mute);">‹</div>'
      + '<div style="font-size:20px;font-weight:800;">核对账单</div></div>'
      + '<div style="margin:10px 20px 0;font-size:12px;color:var(--text-mute);">识别到 ' + rows.length + ' 笔，已选中 ' + includedCount + ' 笔。金额和方向来自账单文件，分类是猜的，点分类可以改，不需要的可以取消勾选。</div>'
      + '<div style="margin:14px 20px 0;background:var(--surface);border-radius:16px;overflow:hidden;">' + rowsHtml + '</div>'
      + '<div style="margin:16px 20px 0;display:flex;gap:10px;">'
      + '<div data-act="cancelBillImport" class="dc-btn" style="flex:1;border-radius:16px;padding:14px;text-align:center;font-size:14px;font-weight:700;background:var(--surface2);color:var(--text-soft);">取消</div>'
      + '<div data-act="confirmBillImport" class="dc-btn" style="flex:2;border-radius:16px;padding:14px;text-align:center;font-size:14px;font-weight:700;background:' + d.accent + ';color:#0b1220;">导入选中的 ' + includedCount + ' 笔</div>'
      + '</div>'
      + '<div style="height:110px;"></div></div>';
  }

  function fullPageBackgroundLayer(d) {
    var inner = '';
    if (d.skinIsPhoto) {
      if (!state.wallpaperImg) return '';
      inner = '<div style="position:absolute;inset:0;background-image:url(' + state.wallpaperImg + ');background-size:cover;background-position:center;"></div>';
    } else {
      inner = '<div style="position:absolute;inset:0;background:' + d.heroBg + ';"></div>';
    }
    var dimOpacity = state.mode === 'light' ? 0.78 : 0.68;
    return '<div style="position:absolute;inset:0;z-index:0;overflow:hidden;">'
      + inner
      + '<div style="position:absolute;inset:0;background:var(--bg);opacity:' + dimOpacity + ';"></div>'
      + '</div>';
  }

  function renderTabBar() {
    var accent = hue(state.accentHue, 72, 0.14);
    function dot(tab) { return state.tab === tab ? accent : 'transparent'; }
    function label(tab) { return state.tab === tab ? accent : 'var(--text-mute)'; }
    var fabBg = 'linear-gradient(135deg, ' + accent + ', ' + hue(state.accentHue, 55, 0.14) + ')';
    return '<div class="safe-bottom" style="position:relative;z-index:5;display:flex;align-items:center;justify-content:space-around;padding:10px 8px 22px;background:var(--tabbar);backdrop-filter:blur(16px);border-top:1px solid color-mix(in oklch, var(--border) 50%, transparent);">'
      + '<div data-act="setTab" data-arg="home" class="dc-btn" style="display:flex;flex-direction:column;align-items:center;gap:4px;width:52px;"><div style="width:5px;height:5px;border-radius:50%;background:' + dot('home') + ';"></div><div style="font-size:10.5px;font-weight:600;color:' + label('home') + ';">首页</div></div>'
      + '<div data-act="setTab" data-arg="report" class="dc-btn" style="display:flex;flex-direction:column;align-items:center;gap:4px;width:52px;"><div style="width:5px;height:5px;border-radius:50%;background:' + dot('report') + ';"></div><div style="font-size:10.5px;font-weight:600;color:' + label('report') + ';">报表</div></div>'
      + '<div data-act="openOverlay" data-arg="add" class="dc-btn" style="width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin-top:-30px;box-shadow:0 8px 20px rgba(0,0,0,.4);background:' + fabBg + ';">'
      + '<div style="position:relative;width:18px;height:18px;"><div style="position:absolute;left:0;right:0;top:8px;height:2.5px;background:#0b1220;border-radius:2px;"></div><div style="position:absolute;top:0;bottom:0;left:8px;width:2.5px;background:#0b1220;border-radius:2px;"></div></div></div>'
      + '<div data-act="setTab" data-arg="assets" class="dc-btn" style="display:flex;flex-direction:column;align-items:center;gap:4px;width:52px;"><div style="width:5px;height:5px;border-radius:50%;background:' + dot('assets') + ';"></div><div style="font-size:10.5px;font-weight:600;color:' + label('assets') + ';">资产</div></div>'
      + '<div data-act="setTab" data-arg="profile" class="dc-btn" style="display:flex;flex-direction:column;align-items:center;gap:4px;width:52px;"><div style="width:5px;height:5px;border-radius:50%;background:' + dot('profile') + ';"></div><div style="font-size:10.5px;font-weight:600;color:' + label('profile') + ';">我的</div></div>'
      + '</div>';
  }

  function renderOverlayAdd(d) {
    var isEdit = !!state.editingTxId;
    var segmentBg = state.txType === 'expense' ? d.negative : d.positive;
    var segmentTransform = state.txType === 'expense' ? 'translateX(0)' : 'translateX(100%)';
    var amountColor = state.txType === 'expense' ? d.negative : d.positive;
    var chips = d.txCategoryOptions.map(function (c) {
      return '<div data-act="setTxCategory" data-arg="' + c.id + '" class="dc-btn" style="padding:8px 14px;border-radius:100px;font-size:12.5px;font-weight:600;background:' + c.chipBg + ';color:' + c.chipColor + ';">' + esc(c.name) + '</div>';
    }).join('');
    var channelChips = CHANNELS.map(function (c) {
      var on = state.txChannel === c.id;
      return '<div data-act="setTxChannel" data-arg="' + c.id + '" class="dc-btn" style="padding:6px 12px;border-radius:100px;font-size:11.5px;font-weight:600;background:' + (on ? d.accent : 'var(--surface2)') + ';color:' + (on ? '#0b1220' : 'var(--text-soft)') + ';">' + c.name + '</div>';
    }).join('');
    var keys = ['1','2','3','4','5','6','7','8','9','.','0','del'];
    var keypad = keys.map(function (k) {
      return '<div data-act="keypadPress" data-arg="' + k + '" class="dc-btn" style="height:50px;border-radius:14px;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:19px;font-weight:600;">' + (k === 'del' ? '⌫' : k) + '</div>';
    }).join('');
    var canSave = parseFloat(state.txAmount) > 0;
    return '<div style="display:flex;justify-content:center;margin-bottom:12px;"><div style="width:36px;height:4px;border-radius:3px;background:var(--track);"></div></div>'
      + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">'
      + '<div data-act="closeOverlay" class="dc-btn" style="font-size:20px;color:var(--text-mute);width:24px;">✕</div>'
      + '<div style="font-size:15px;font-weight:700;">' + (isEdit ? '编辑记录' : '记一笔') + '</div>'
      + (isEdit ? '<div data-act="deleteTx" data-arg="' + state.editingTxId + '" class="dc-btn" style="font-size:12.5px;color:oklch(66% 0.19 25);width:36px;text-align:right;">删除</div>' : '<div style="width:24px;"></div>')
      + '</div>'
      + '<div style="display:flex;background:var(--surface2);border-radius:100px;padding:4px;position:relative;">'
      + '<div style="position:absolute;top:4px;bottom:4px;width:calc(50% - 4px);border-radius:100px;transition:transform .2s ease;background:' + segmentBg + ';transform:' + segmentTransform + ';"></div>'
      + '<div data-act="setTxType" data-arg="expense" class="dc-btn" style="flex:1;text-align:center;padding:9px 0;font-size:13.5px;font-weight:700;position:relative;z-index:1;">支出</div>'
      + '<div data-act="setTxType" data-arg="income" class="dc-btn" style="flex:1;text-align:center;padding:9px 0;font-size:13.5px;font-weight:700;position:relative;z-index:1;">收入</div></div>'
      + '<div style="text-align:center;margin:20px 0 6px;font-family:var(--font-mono);font-size:38px;font-weight:700;color:' + amountColor + ';">¥' + (state.txAmount || '0') + '</div>'
      + '<input data-bind="txNote" value="' + esc(state.txNote) + '" placeholder="添加备注（可选）" style="width:100%;background:var(--surface2);border:none;border-radius:12px;padding:10px 12px;font-size:13px;color:var(--text);margin-bottom:10px;outline:none;">'
      + '<input data-bind="txDateStr" type="date" value="' + esc(state.txDateStr) + '" style="width:100%;background:var(--surface2);border:none;border-radius:12px;padding:10px 12px;font-size:13px;color:var(--text);margin-bottom:10px;outline:none;">'
      + '<div style="font-size:11px;color:var(--text-mute);margin-bottom:6px;">支付渠道</div>'
      + '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">' + channelChips + '</div>'
      + '<div style="display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 14px;">' + chips + '</div>'
      + '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px;">' + keypad + '</div>'
      + '<div data-act="saveTx" class="dc-btn" style="margin-top:16px;border-radius:16px;padding:15px;text-align:center;font-size:15px;font-weight:700;background:' + d.accent + ';color:#0b1220;opacity:' + (canSave ? 1 : 0.55) + ';">' + (isEdit ? '保存修改' : '保存记录') + '</div>';
  }

  function renderOverlayThemes(d) {
    var skinsHtml = SKINS.map(function (sk) {
      var selected = sk.id === state.skinId;
      var ring = selected ? ('2px solid ' + d.accent) : '2px solid transparent';
      var check = selected ? '<div style="position:absolute;top:8px;right:8px;width:20px;height:20px;border-radius:50%;background:rgba(255,255,255,.9);display:flex;align-items:center;justify-content:center;font-size:11px;color:#0b1220;font-weight:700;">✓</div>' : '';
      return '<div data-act="setSkin" data-arg="' + sk.id + '" class="dc-btn" style="border-radius:16px;padding:3px;border:' + ring + ';">'
        + '<div style="border-radius:14px;height:74px;position:relative;overflow:hidden;background:' + sk.css + ';">' + check + '</div>'
        + '<div style="font-size:12px;font-weight:600;text-align:center;margin-top:7px;font-family:var(--font-mono);">' + esc(sk.name) + '</div></div>';
    }).join('');
    var customGradRing = state.skinId === 'customGradient' ? ('2px solid ' + d.accent) : '2px solid var(--border)';
    var photoRing = d.skinIsPhoto ? ('2px solid ' + d.accent) : '2px solid var(--border)';
    var wallpaperThumb = state.wallpaperImg ? ('background-image:url(' + state.wallpaperImg + ');background-size:cover;background-position:center;') : 'background:var(--surface2);';

    var colorInputs = state.customColors.map(function (val, idx) {
      return '<input type="color" value="' + val + '" data-color-idx="' + idx + '" style="width:36px;height:36px;border-radius:50%;border:2px solid var(--border);padding:0;background:none;">';
    }).join('');
    var accentSwatches = ACCENT_HUES.map(function (h) {
      var c = hue(h, 72, 0.14);
      var ring = h === state.accentHue ? ('2px solid ' + c) : '2px solid var(--border)';
      return '<div data-act="setAccent" data-arg="' + h + '" class="dc-btn" style="width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:' + ring + ';"><div style="width:28px;height:28px;border-radius:50%;background:' + c + ';"></div></div>';
    }).join('');

    return '<div style="display:flex;justify-content:center;margin-bottom:12px;"><div style="width:36px;height:4px;border-radius:3px;background:var(--track);"></div></div>'
      + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">'
      + '<div data-act="closeOverlay" class="dc-btn" style="font-size:20px;color:var(--text-mute);width:24px;">✕</div>'
      + '<div style="font-size:15px;font-weight:700;">主题皮肤商店</div><div style="width:24px;"></div></div>'
      + '<div style="font-size:12px;color:var(--text-mute);margin-bottom:10px;">背景皮肤 · 应用于整个 App</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' + skinsHtml
      + '<div data-act="setSkin" data-arg="customGradient" class="dc-btn" style="border-radius:16px;padding:3px;border:' + customGradRing + ';">'
      + '<div style="border-radius:14px;height:74px;background:' + d.customGradientCss + ';"></div>'
      + '<div style="font-size:12px;font-weight:600;text-align:center;margin-top:7px;font-family:var(--font-mono);">自定义渐变</div></div>'
      + '<div data-act="setSkin" data-arg="photo" class="dc-btn" style="border-radius:16px;padding:3px;border:' + photoRing + ';">'
      + '<div style="border-radius:14px;height:74px;overflow:hidden;position:relative;' + wallpaperThumb + '"></div>'
      + '<div style="font-size:12px;font-weight:600;text-align:center;margin-top:7px;font-family:var(--font-mono);">自定义壁纸</div></div>'
      + '</div>'
      + '<div data-act="pickWallpaper" class="dc-btn" style="margin-top:10px;text-align:center;font-size:12px;color:' + d.accent + ';text-decoration:underline;">上传壁纸照片</div>'
      + '<div style="font-size:12px;color:var(--text-mute);margin:20px 0 10px;">自定义渐变色盘 · 直接调整5个颜色</div>'
      + '<div style="border-radius:14px;height:36px;margin-bottom:10px;background:' + d.customGradientCss + ';"></div>'
      + '<div style="display:flex;gap:12px;">' + colorInputs + '</div>'
      + '<div style="font-size:12px;color:var(--text-mute);margin:20px 0 10px;">强调色 · 应用于按钮与高亮</div>'
      + '<div style="display:flex;gap:14px;">' + accentSwatches + '</div>'
      + '<div data-act="closeOverlay" class="dc-btn" style="margin-top:22px;border-radius:16px;padding:15px;text-align:center;font-size:15px;font-weight:700;background:' + d.accent + ';color:#0b1220;">应用</div>';
  }

  function renderOverlayEditBudget(d) {
    var rows = d.periodBudgetsList.map(function (b) {
      return '<div style="display:flex;align-items:center;justify-content:space-between;background:var(--surface2);border-radius:14px;padding:12px 14px;">'
        + '<div style="display:flex;align-items:center;gap:8px;min-width:0;"><div style="width:9px;height:9px;border-radius:2px;flex-shrink:0;background:' + b.color + ';"></div><div style="font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(b.catName) + '</div></div>'
        + '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">'
        + '<div data-act="adjustBudgetLimit" data-arg="' + b.cat + '|-100" class="dc-btn" style="width:24px;height:24px;border-radius:50%;background:var(--track);display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;">−</div>'
        + '<input type="number" inputmode="numeric" data-budget-cat="' + b.cat + '" value="' + b.limit + '" style="width:76px;background:var(--surface);border:none;border-radius:8px;padding:6px 4px;font-family:var(--font-mono);font-size:13px;font-weight:700;text-align:center;color:var(--text);outline:none;">'
        + '<div data-act="adjustBudgetLimit" data-arg="' + b.cat + '|100" class="dc-btn" style="width:24px;height:24px;border-radius:50%;background:var(--track);display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;">+</div>'
        + '</div></div>';
    }).join('');
    return '<div style="display:flex;justify-content:center;margin-bottom:12px;"><div style="width:36px;height:4px;border-radius:3px;background:var(--track);"></div></div>'
      + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">'
      + '<div data-act="closeOverlay" class="dc-btn" style="font-size:20px;color:var(--text-mute);width:24px;">✕</div>'
      + '<div style="font-size:15px;font-weight:700;">编辑预算</div><div style="width:24px;"></div></div>'
      + '<div style="font-size:11px;color:var(--text-mute);margin-bottom:12px;">点击数字可以直接输入金额，也可以用 +/− 微调</div>'
      + '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--surface2);border-radius:14px;margin-bottom:14px;">'
      + '<div style="font-size:12.5px;color:var(--text-mute);">' + d.periodLabel + ' 总预算</div>'
      + '<div style="font-family:var(--font-mono);font-size:15px;font-weight:700;">' + d.periodLimitFmt + '</div></div>'
      + '<div style="display:flex;flex-direction:column;gap:10px;">' + rows + '</div>'
      + '<div data-act="closeOverlay" class="dc-btn" style="margin-top:20px;border-radius:16px;padding:15px;text-align:center;font-size:15px;font-weight:700;background:' + d.accent + ';color:#0b1220;">完成</div>';
  }

  function renderOverlayReminders(d) {
    var on = state.remindOnOpen;
    return '<div style="display:flex;justify-content:center;margin-bottom:12px;"><div style="width:36px;height:4px;border-radius:3px;background:var(--track);"></div></div>'
      + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">'
      + '<div data-act="closeOverlay" class="dc-btn" style="font-size:20px;color:var(--text-mute);width:24px;">✕</div>'
      + '<div style="font-size:15px;font-weight:700;">记账提醒</div><div style="width:24px;"></div></div>'
      + '<div style="font-size:12.5px;color:var(--text-soft);line-height:1.6;margin-bottom:16px;">开启后，如果当天过了 <b>10:00</b> 还没记过账，打开 App 首页时会出现一条提醒条，点一下就能直接去记一笔。</div>'
      + '<div style="display:flex;align-items:center;justify-content:space-between;background:var(--surface2);border-radius:14px;padding:14px;">'
      + '<div style="font-size:13.5px;font-weight:600;">打开 App 时提醒</div>'
      + '<div data-act="toggleRemindOnOpen" class="dc-btn" style="width:42px;height:24px;border-radius:100px;position:relative;background:' + (on ? d.accent : 'var(--track)') + ';"><div style="position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform .15s ease;transform:' + (on ? 'translateX(18px)' : 'translateX(0)') + ';"></div></div>'
      + '</div>'
      + '<div style="font-size:11px;color:var(--text-faint);margin-top:12px;line-height:1.6;">这是纯本地提醒，只在你打开 App 的时候检查一次，不会像原生 App 那样锁屏弹通知——这个网页在关闭后不会做任何后台的事，所以没法主动推送。</div>';
  }


  function renderOverlayAddAsset(d) {
    var na = state.newAsset;
    var selectedCat = assetCatById(na.category);
    var catChips = ASSET_CATEGORIES.map(function (c) {
      var on = na.category === c.id;
      return '<div data-act="setNewAssetCategory" data-arg="' + c.id + '" class="dc-btn" style="padding:8px 12px;border-radius:100px;font-size:12.5px;font-weight:600;background:' + (on ? d.accent : 'var(--surface2)') + ';color:' + (on ? '#0b1220' : 'var(--text-soft)') + ';white-space:nowrap;">' + c.icon + ' ' + c.name + '</div>';
    }).join('');
    var valueLabel = selectedCat.tracksDep ? '购入价（¥）' : '金额（¥）';
    var depFields = selectedCat.tracksDep
      ? (fieldRow('当前估值（¥，可留空）', 'newAsset.current', na.current, 'number', '默认等于购入价')
        + fieldRow('购入日期', 'newAsset.dateStr', na.dateStr, 'date', '')
        + fieldRow('预计已使用次数（可选）', 'newAsset.uses', na.uses, 'number', '用于按次折旧'))
      : '';
    return '<div style="display:flex;justify-content:center;margin-bottom:12px;"><div style="width:36px;height:4px;border-radius:3px;background:var(--track);"></div></div>'
      + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">'
      + '<div data-act="closeOverlay" class="dc-btn" style="font-size:20px;color:var(--text-mute);width:24px;">✕</div>'
      + '<div style="font-size:15px;font-weight:700;">添加资产</div><div style="width:24px;"></div></div>'
      + '<div style="font-size:11px;color:var(--text-mute);margin-bottom:8px;">分类</div>'
      + '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;">' + catChips + '</div>'
      + fieldRow('名称', 'newAsset.name', na.name, 'text', selectedCat.tracksDep ? '如：MacBook Pro' : '如：招商银行储蓄卡')
      + fieldRow(valueLabel, 'newAsset.buy', na.buy, 'number', '0')
      + depFields
      + '<div data-act="saveNewAsset" class="dc-btn" style="margin-top:16px;border-radius:16px;padding:15px;text-align:center;font-size:15px;font-weight:700;background:' + d.accent + ';color:#0b1220;">保存资产</div>';
  }

  function renderOverlayPiggyDeposit(d) {
    return '<div style="display:flex;justify-content:center;margin-bottom:12px;"><div style="width:36px;height:4px;border-radius:3px;background:var(--track);"></div></div>'
      + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">'
      + '<div data-act="closeOverlay" class="dc-btn" style="font-size:20px;color:var(--text-mute);width:24px;">✕</div>'
      + '<div style="font-size:15px;font-weight:700;">存入储蓄罐</div><div style="width:24px;"></div></div>'
      + fieldRow('存入金额（¥）', 'piggyDepositAmount', state.piggyDepositAmount, 'number', '0')
      + '<div data-act="confirmPiggyDeposit" class="dc-btn" style="margin-top:16px;border-radius:16px;padding:15px;text-align:center;font-size:15px;font-weight:700;background:' + d.accent + ';color:#0b1220;">确认存入</div>';
  }

  function fieldRow(label, bind, val, type, placeholder) {
    return '<div style="margin-bottom:12px;"><div style="font-size:11.5px;color:var(--text-mute);margin-bottom:6px;">' + esc(label) + '</div>'
      + '<input data-bind="' + bind + '" type="' + type + '" value="' + esc(val) + '" placeholder="' + esc(placeholder) + '" style="width:100%;background:var(--surface2);border:none;border-radius:12px;padding:11px 12px;font-size:14px;color:var(--text);outline:none;"></div>';
  }

  function renderOverlayManageCategories(d) {
    var rows = cats().map(function (c) {
      var c2 = hue(c.hue, 68, 0.14);
      var limit = state.budgetLimits[c.id] || 0;
      return '<div style="display:flex;align-items:center;gap:10px;background:var(--surface2);border-radius:14px;padding:12px 14px;">'
        + '<div style="width:10px;height:10px;border-radius:50%;flex-shrink:0;background:' + c2 + ';"></div>'
        + '<div style="flex:1;min-width:0;"><div style="font-size:13.5px;font-weight:600;">' + esc(c.name) + '</div>'
        + '<div style="font-size:11px;color:var(--text-faint);margin-top:2px;">预算 ' + fmt(limit) + '/月</div></div>'
        + '<div data-act="deleteCategory" data-arg="' + c.id + '" class="dc-btn" style="font-size:15px;color:var(--text-faint);padding:4px;">×</div></div>';
    }).join('');
    var hueChoices = CAT_HUE_CHOICES.map(function (h) {
      var c = hue(h, 68, 0.14);
      var ring = h === state.newCategoryHue ? ('2px solid ' + c) : '2px solid var(--border)';
      return '<div data-act="setNewCategoryHue" data-arg="' + h + '" class="dc-btn" style="width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:' + ring + ';"><div style="width:18px;height:18px;border-radius:50%;background:' + c + ';"></div></div>';
    }).join('');
    return '<div style="display:flex;justify-content:center;margin-bottom:12px;"><div style="width:36px;height:4px;border-radius:3px;background:var(--track);"></div></div>'
      + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">'
      + '<div data-act="closeOverlay" class="dc-btn" style="font-size:20px;color:var(--text-mute);width:24px;">✕</div>'
      + '<div style="font-size:15px;font-weight:700;">分类管理</div><div style="width:24px;"></div></div>'
      + '<div style="font-size:11.5px;color:var(--text-mute);margin-bottom:10px;">支出分类 · 用于记账与预算</div>'
      + '<div style="display:flex;flex-direction:column;gap:10px;">' + rows + '</div>'
      + '<div style="font-size:12px;color:var(--text-mute);margin:20px 0 10px;">新增分类</div>'
      + '<input data-bind="newCategoryName" value="' + esc(state.newCategoryName) + '" placeholder="分类名称，如：宠物" style="width:100%;background:var(--surface2);border:none;border-radius:12px;padding:11px 12px;font-size:14px;color:var(--text);outline:none;margin-bottom:10px;">'
      + '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;">' + hueChoices + '</div>'
      + '<div data-act="addCategory" class="dc-btn" style="border-radius:16px;padding:14px;text-align:center;font-size:14px;font-weight:700;background:' + d.accent + ';color:#0b1220;">添加分类</div>';
  }

  function renderOverlaySetPin() {
    var accent = hue(state.accentHue, 72, 0.14);
    var stage = state.pinSetupStage;
    var dots = '';
    for (var i = 0; i < 4; i++) {
      var filled = i < state.pinInput.length;
      dots += '<div style="width:13px;height:13px;border-radius:50%;background:' + (filled ? accent : 'var(--track)') + ';"></div>';
    }
    return '<div style="display:flex;justify-content:center;margin-bottom:12px;"><div style="width:36px;height:4px;border-radius:3px;background:var(--track);"></div></div>'
      + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">'
      + '<div data-act="closeOverlay" class="dc-btn" style="font-size:20px;color:var(--text-mute);width:24px;">✕</div>'
      + '<div style="font-size:15px;font-weight:700;">设置安全锁密码</div><div style="width:24px;"></div></div>'
      + '<div style="text-align:center;font-size:12.5px;color:var(--text-mute);margin:10px 0 18px;">' + (stage === 'enter' ? '请输入 4 位数字密码' : '请再次输入以确认') + '</div>'
      + '<div style="display:flex;gap:14px;justify-content:center;margin-bottom:6px;">' + dots + '</div>'
      + (state.pinError ? '<div style="text-align:center;font-size:12px;color:oklch(66% 0.19 25);margin-top:6px;">' + esc(state.pinError) + '</div>' : '')
      + '<div style="max-width:260px;margin:0 auto;">' + renderNumPad('setPinPress') + '</div>';
  }

  var lastOverlay = null;
  var lastToastMsg = null;

  function renderOverlay(d) {
    if (!state.overlay) { lastOverlay = null; return ''; }
    var inner = '';
    if (state.overlay === 'add') inner = renderOverlayAdd(d);
    else if (state.overlay === 'themes') inner = renderOverlayThemes(d);
    else if (state.overlay === 'editBudget') inner = renderOverlayEditBudget(d);
    else if (state.overlay === 'reminders') inner = renderOverlayReminders(d);
    else if (state.overlay === 'addAsset') inner = renderOverlayAddAsset(d);
    else if (state.overlay === 'piggyDeposit') inner = renderOverlayPiggyDeposit(d);
    else if (state.overlay === 'manageCategories') inner = renderOverlayManageCategories(d);
    else if (state.overlay === 'setPin') inner = renderOverlaySetPin(d);
    var isNew = state.overlay !== lastOverlay;
    lastOverlay = state.overlay;
    var animStyle = isNew ? 'animation:sheetUp .28s ease-out;' : '';
    return '<div style="position:absolute;inset:0;z-index:40;background:rgba(0,0,0,.55);display:flex;flex-direction:column;justify-content:flex-end;">'
      + '<div class="safe-bottom" style="background:var(--sheet);border-radius:24px 24px 0 0;padding:16px 20px 20px;max-height:85%;overflow-y:auto;' + animStyle + '">' + inner + '</div></div>';
  }

  function renderToast() {
    if (!state.toast) { lastToastMsg = null; return ''; }
    var isNew = state.toast !== lastToastMsg;
    lastToastMsg = state.toast;
    var animStyle = isNew ? 'animation:toastUp .25s ease-out;' : '';
    return '<div style="position:absolute;bottom:110px;left:50%;padding:10px 18px;border-radius:100px;background:var(--surface2);color:#fff;font-size:12.5px;font-weight:600;box-shadow:0 8px 20px rgba(0,0,0,.4);z-index:60;' + animStyle + 'white-space:nowrap;">' + esc(state.toast) + '</div>';
  }

  function render() {
    if (!activeProfileId || !state) { renderProfilePicker(); return; }
    if (locked) { renderLockScreen(); return; }
    var d = computeDerived();
    var theme = THEME[state.mode] || THEME.dark;
    var themeVars = '--bg:' + theme.bg + ';--surface:' + theme.surface + ';--surface2:' + theme.surface2 + ';--track:' + theme.track + ';--border:' + theme.border + ';--sheet:' + theme.sheet + ';--tabbar:' + theme.tabbar + ';--text:' + theme.text + ';--text-soft:' + theme.textSoft + ';--text-mute:' + theme.textMute + ';--text-faint:' + theme.textFaint + ';';

    var body;
    if (state.tab === 'report') body = renderReport(d);
    else if (state.tab === 'assets') body = renderAssets(d);
    else if (state.tab === 'profile') body = renderProfile(d);
    else if (state.tab === 'budget') body = renderBudget(d);
    else if (state.tab === 'txlist') body = renderTxList(d);
    else if (state.tab === 'billReview') body = renderBillReview(d);
    else body = renderHome(d);

    var html = '<div style="height:100dvh;height:100vh;position:relative;overflow:hidden;font-family:var(--font-display);' + themeVars + 'background:var(--bg);color:var(--text);">'
      + fullPageBackgroundLayer(d)
      + '<div style="position:relative;z-index:1;height:100%;display:flex;flex-direction:column;">'
      + body
      + renderTabBar()
      + '</div>'
      + renderOverlay(d)
      + renderToast()
      + '<input type="file" id="avatarFileInput" accept="image/*" style="display:none;">'
      + '<input type="file" id="wallpaperFileInput" accept="image/*" style="display:none;">'
      + '<input type="file" id="importFileInput" accept="application/json,.json" style="display:none;">'
      + '<input type="file" id="billFileInput" accept=".csv,text/csv" style="display:none;">'
      + '</div>';

    var root = document.getElementById('app');
    var activeEl = document.activeElement;
    var activeBind = activeEl && activeEl.getAttribute ? activeEl.getAttribute('data-bind') : null;
    var selStart = activeEl && 'selectionStart' in activeEl ? activeEl.selectionStart : null;

    root.innerHTML = html;

    // restore focus to the input the user was typing in, to avoid losing keyboard focus
    if (activeBind) {
      var reEl = root.querySelector('[data-bind="' + activeBind + '"]');
      if (reEl) {
        reEl.focus();
        if (selStart != null && reEl.setSelectionRange) {
          try { reEl.setSelectionRange(selStart, selStart); } catch (e) {}
        }
      }
    }
  }

  function renderNumPad(actionName) {
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];
    return '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:24px;">' + keys.map(function (k) {
      if (k === '') return '<div></div>';
      return '<div data-act="' + actionName + '" data-arg="' + k + '" class="dc-btn" style="height:56px;border-radius:16px;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:600;">' + (k === 'del' ? '⌫' : k) + '</div>';
    }).join('') + '</div>';
  }

  function renderProfilePicker() {
    var accent = hue(195, 72, 0.14);
    var theme = THEME.dark;
    var themeVars = '--bg:' + theme.bg + ';--surface:' + theme.surface + ';--surface2:' + theme.surface2 + ';--track:' + theme.track + ';--border:' + theme.border + ';--sheet:' + theme.sheet + ';--tabbar:' + theme.tabbar + ';--text:' + theme.text + ';--text-soft:' + theme.textSoft + ';--text-mute:' + theme.textMute + ';--text-faint:' + theme.textFaint + ';';

    var listHtml = profiles.length ? profiles.map(function (p) {
      return '<div style="display:flex;align-items:center;gap:10px;background:var(--surface2);border-radius:14px;padding:4px;margin-bottom:10px;">'
        + '<div data-act="selectProfile" data-arg="' + p.id + '" class="dc-btn" style="flex:1;display:flex;align-items:center;gap:12px;padding:10px 12px;">'
        + '<div style="width:38px;height:38px;border-radius:50%;background:' + accent + ';display:flex;align-items:center;justify-content:center;font-weight:700;color:#0b1220;flex-shrink:0;">' + esc((p.name || '？').charAt(0)) + '</div>'
        + '<div style="flex:1;min-width:0;"><div style="font-size:14.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(p.name || '未命名账号') + '</div></div>'
        + '<div style="font-size:14px;color:var(--text-mute);">›</div></div>'
        + '<div data-act="deleteProfile" data-arg="' + p.id + '" class="dc-btn" style="font-size:14px;color:var(--text-faint);padding:0 12px;">×</div>'
        + '</div>';
    }).join('') : '<div style="font-size:12px;color:var(--text-faint);text-align:center;padding:12px 0 20px;">这台设备上还没有账号</div>';

    return document.getElementById('app').innerHTML =
      '<div style="height:100dvh;height:100vh;display:flex;flex-direction:column;justify-content:center;padding:32px;overflow-y:auto;' + themeVars + 'background:var(--bg);color:var(--text);">'
      + '<div style="font-size:36px;margin-bottom:10px;">📒</div>'
      + '<div style="font-size:20px;font-weight:800;margin-bottom:6px;">策方 Ledger</div>'
      + '<div style="font-size:12.5px;color:var(--text-mute);line-height:1.6;margin-bottom:22px;">这台设备上每个账号的数据都是独立的，互不影响。选择你的账号，或者创建一个新的。</div>'
      + listHtml
      + '<div style="font-size:11px;color:var(--text-mute);text-transform:uppercase;letter-spacing:.05em;margin:16px 0 10px;">新建账号</div>'
      + '<input id="newProfileNameInput" value="' + esc(newProfileNameDraft) + '" placeholder="想怎么称呼这个账本，比如：小明" style="width:100%;background:var(--surface2);border:none;border-radius:12px;padding:13px 14px;font-size:15px;color:var(--text);outline:none;margin-bottom:14px;">'
      + '<div data-act="createProfile" class="dc-btn" style="border-radius:16px;padding:15px;text-align:center;font-size:15px;font-weight:700;background:' + accent + ';color:#0b1220;">创建并进入</div>'
      + '<div style="font-size:11px;color:var(--text-faint);margin-top:16px;line-height:1.6;">新账号从空白开始记账。所有账号的数据都只保存在这台设备的浏览器里，不会同步到其他设备，也不会和别人共享。</div>'
      + '</div>';
  }

  function renderLockScreen() {
    var accent = hue(state.accentHue, 72, 0.14);
    var theme = THEME[state.mode] || THEME.dark;
    var themeVars = '--bg:' + theme.bg + ';--surface:' + theme.surface + ';--surface2:' + theme.surface2 + ';--track:' + theme.track + ';--border:' + theme.border + ';--sheet:' + theme.sheet + ';--tabbar:' + theme.tabbar + ';--text:' + theme.text + ';--text-soft:' + theme.textSoft + ';--text-mute:' + theme.textMute + ';--text-faint:' + theme.textFaint + ';';
    var dots = '';
    for (var i = 0; i < 4; i++) {
      var filled = i < state.pinInput.length;
      dots += '<div style="width:13px;height:13px;border-radius:50%;background:' + (filled ? accent : 'var(--track)') + ';"></div>';
    }
    var html = '<div style="height:100dvh;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px;' + themeVars + 'background:var(--bg);color:var(--text);">'
      + '<div style="font-size:36px;margin-bottom:8px;">🔒</div>'
      + '<div style="font-size:16px;font-weight:700;margin-bottom:4px;">策方 Ledger 已锁定</div>'
      + '<div style="font-size:12px;color:var(--text-mute);margin-bottom:24px;">输入 4 位密码解锁</div>'
      + '<div style="display:flex;gap:14px;margin-bottom:8px;">' + dots + '</div>'
      + (state.pinError ? '<div style="font-size:12px;color:oklch(66% 0.19 25);margin-top:6px;">' + esc(state.pinError) + '</div>' : '')
      + '<div style="width:240px;">' + renderNumPad('lockPress') + '</div>'
      + renderToast()
      + '</div>';
    var root = document.getElementById('app');
    root.innerHTML = html;
  }

  /* ---------- 事件绑定辅助 ---------- */
  function setPath(obj, path, value) {
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
    cur[parts[parts.length - 1]] = value;
  }
  function getPath(obj, path) {
    return path.split('.').reduce(function (acc, k) { return acc == null ? acc : acc[k]; }, obj);
  }

  /* ---------- 图片压缩上传 ---------- */
  function compressImageFile(file, maxW, cb) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var img = new Image();
      img.onload = function () {
        var w = img.width, h = img.height;
        if (w > maxW) { h = Math.round(h * (maxW / w)); w = maxW; }
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        cb(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  /* ---------- 动作 ---------- */
  var Actions = {
    selectProfile: function (id) {
      var p = profiles.filter(function (pp) { return pp.id === id; })[0];
      if (!p) return;
      activeProfileId = id;
      try { localStorage.setItem(ACTIVE_KEY, id); } catch (e) {}
      state = loadProfileState(id);
      locked = !!(state.security && state.security.pinEnabled && state.security.pinCode);
      render();
    },
    createProfile: function () {
      var name = (newProfileNameDraft || '').trim();
      var id = uid() + '_' + Math.floor(Math.random() * 10000);
      var p = { id: id, name: name || '未命名账号', createdAt: todayISO() };
      profiles = profiles.concat([p]);
      saveProfiles();
      newProfileNameDraft = '';
      activeProfileId = id;
      try { localStorage.setItem(ACTIVE_KEY, id); } catch (e) {}
      state = defaultState();
      state.userName = name;
      state.streakStart = todayISO();
      locked = false;
      persist();
      render();
    },
    deleteProfile: function (id) {
      var p = profiles.filter(function (pp) { return pp.id === id; })[0];
      var ok = window.confirm ? window.confirm('删除账号"' + (p ? p.name : '') + '"会清除这个账号在本设备上的全部记账数据，且无法恢复，确定要删除吗？') : true;
      if (!ok) return;
      profiles = profiles.filter(function (pp) { return pp.id !== id; });
      saveProfiles();
      try { localStorage.removeItem(profileDataKey(id)); } catch (e) {}
      if (activeProfileId === id) {
        activeProfileId = null;
        state = null;
        try { localStorage.removeItem(ACTIVE_KEY); } catch (e) {}
      }
      render();
    },
    switchAccount: function () {
      activeProfileId = null;
      state = null;
      try { localStorage.removeItem(ACTIVE_KEY); } catch (e) {}
      render();
    },
    setTab: function (tab) { update({ tab: tab, overlay: null }); },
    openOverlay: function (name) {
      if (name === 'add') update({ overlay: 'add', editingTxId: null, txType: 'expense', txCategory: null, txAmount: '', txNote: '', txDateStr: todayISO(), txChannel: 'wechat' });
      else update({ overlay: name });
    },
    closeOverlay: function () { update({ overlay: null, txAmount: '', txCategory: null, txNote: '', editingTxId: null, pinSetupStage: 'enter', pinSetupFirst: '', pinInput: '', pinError: '' }); },
    editTx: function (id) {
      var tx = state.transactions.filter(function (t) { return String(t.id) === String(id); })[0];
      if (!tx) return;
      update({ overlay: 'add', editingTxId: tx.id, txType: tx.type, txCategory: tx.cat, txAmount: String(tx.amount), txNote: tx.note || '', txDateStr: tx.date, txChannel: tx.channel || 'wechat' });
    },
    setTxType: function (t) { update({ txType: t, txCategory: null }); },
    setTxCategory: function (id) { update({ txCategory: id }); },
    setTxChannel: function (id) { update({ txChannel: id }); },
    keypadPress: function (k) {
      update(function (s) {
        var amt = s.txAmount;
        if (k === 'del') return { txAmount: amt.slice(0, -1) };
        if (k === '.') return amt.indexOf('.') >= 0 ? {} : { txAmount: amt + '.' };
        if (amt.replace('.', '').length >= 8) return {};
        return { txAmount: amt + k };
      });
    },
    saveTx: function () {
      var amt = parseFloat(state.txAmount);
      if (!amt || amt <= 0) { showToast('请输入金额'); return; }
      var cat = state.txCategory || (state.txType === 'expense' ? cats()[0].id : INCOME_CATS[0].id);
      var dateStr = state.txDateStr || todayISO();
      var channel = state.txChannel || 'wechat';
      if (state.editingTxId) {
        update(function (s) {
          var list = s.transactions.map(function (t) {
            if (String(t.id) !== String(s.editingTxId)) return t;
            return { id: t.id, type: s.txType, cat: cat, note: s.txNote || '', amount: amt, date: dateStr, channel: channel };
          });
          return { transactions: list, overlay: null, txAmount: '', txCategory: null, txNote: '', editingTxId: null };
        });
        showToast('记录已更新');
        return;
      }
      var tx = { id: uid(), type: state.txType, cat: cat, note: state.txNote || '', amount: amt, date: dateStr, channel: channel };
      update(function (s) {
        return { transactions: [tx].concat(s.transactions), overlay: null, txAmount: '', txCategory: null, txNote: '' };
      });
      showToast(state.txType === 'expense' ? '支出已记录' : '收入已记录');
    },
    deleteTx: function (id) {
      update(function (s) { return { transactions: s.transactions.filter(function (t) { return String(t.id) !== String(id); }), overlay: (s.editingTxId && String(s.editingTxId) === String(id)) ? null : s.overlay }; });
      showToast('记录已删除');
    },
    setAccent: function (h) { update({ accentHue: parseInt(h, 10) }); },
    setSkin: function (id) { update({ skinId: id }); },
    setMode: function (m) { update({ mode: m }); },
    setDepMethod: function (arg) {
      var parts = String(arg).split('|'); var id = parts[0], m = parts[1];
      update(function (s) { var dm = Object.assign({}, s.depMethods); dm[id] = m; return { depMethods: dm }; });
    },
    adjustBudgetLimit: function (arg) {
      var parts = String(arg).split('|'); var cat = parts[0], delta = parseInt(parts[1], 10);
      update(function (s) {
        var bl = Object.assign({}, s.budgetLimits);
        bl[cat] = Math.max(100, (bl[cat] || 0) + delta);
        return { budgetLimits: bl };
      });
    },
    toggleRemindOnOpen: function () {
      update(function (s) { return { remindOnOpen: !s.remindOnOpen }; });
    },
    dismissReminderBanner: function () {
      update({ reminderDismissedDate: todayISO() });
    },
    moveMonth: function (d) {
      update(function (s) { return { reportMonthIdx: Math.max(0, Math.min(5, s.reportMonthIdx + parseInt(d, 10))) }; });
    },
    moveBudgetPeriod: function (d) {
      update(function (s) { return { budgetPeriodIdx: Math.max(0, Math.min(5, s.budgetPeriodIdx + parseInt(d, 10))) }; });
    },
    toastGeneric: function () { showToast('功能开发中'); },
    openAddAsset: function () { update({ overlay: 'addAsset', newAsset: { name: '', category: 'electronics', buy: '', current: '', dateStr: todayISO(), uses: '' } }); },
    setNewAssetCategory: function (id) {
      update(function (s) { return { newAsset: Object.assign({}, s.newAsset, { category: id }) }; });
    },
    saveNewAsset: function () {
      var na = state.newAsset;
      var catInfo = assetCatById(na.category);
      var buy = parseFloat(na.buy);
      if (!na.name || !buy || buy <= 0) { showToast('请填写名称和金额'); return; }
      var asset;
      if (!catInfo.tracksDep) {
        // cash / bank deposits: no depreciation tracking needed
        asset = { id: uid(), name: na.name, category: na.category, buy: buy, current: buy, years: 0, uses: 0 };
      } else {
        var cur = parseFloat(na.current);
        if (!cur || cur <= 0) cur = buy;
        var years = 0.05;
        if (na.dateStr) {
          var days = Math.max(1, Math.round((Date.parse(todayISO()) - Date.parse(na.dateStr)) / 86400000));
          years = Math.max(0.02, +(days / 365).toFixed(2));
        }
        var uses = parseInt(na.uses, 10) || 1;
        asset = { id: uid(), name: na.name, category: na.category, buy: buy, current: cur, years: years, uses: uses };
      }
      update(function (s) { return { assets: [asset].concat(s.assets), overlay: null }; });
      showToast('资产已添加');
    },
    deleteAsset: function (id) {
      update(function (s) { return { assets: s.assets.filter(function (a) { return String(a.id) !== String(id); }) }; });
      showToast('资产已删除');
    },
    openPiggyDeposit: function () { update({ overlay: 'piggyDeposit', piggyDepositAmount: '' }); },
    confirmPiggyDeposit: function () {
      var amt = parseFloat(state.piggyDepositAmount);
      if (!amt || amt <= 0) { showToast('请输入存入金额'); return; }
      var label = monthsWindow(1)[0].year + '年' + monthsWindow(1)[0].month + '月';
      update(function (s) {
        var hist = [{ label: label, amount: amt }].concat(s.piggyHistory).slice(0, 6);
        return { piggyBalance: s.piggyBalance + amt, piggyHistory: hist, overlay: null, piggyDepositAmount: '' };
      });
      showToast('已存入储蓄罐');
    },
    pickAvatar: function () { var el = document.getElementById('avatarFileInput'); if (el) el.click(); },
    pickWallpaper: function () { var el = document.getElementById('wallpaperFileInput'); if (el) el.click(); },
    pickAlipayBill: function () { state.pendingBillChannel = 'alipay'; var el = document.getElementById('billFileInput'); if (el) el.click(); },
    pickWechatBill: function () { state.pendingBillChannel = 'wechat'; var el = document.getElementById('billFileInput'); if (el) el.click(); },
    toggleBillRow: function (idx) {
      update(function (s) {
        var rows = s.billRows.slice();
        var i = parseInt(idx, 10);
        rows[i] = Object.assign({}, rows[i], { include: !rows[i].include });
        return { billRows: rows };
      });
    },
    setBillRowCat: function (arg) {
      var parts = String(arg).split('|'); var idx = parseInt(parts[0], 10); var catId = parts[1];
      update(function (s) {
        var rows = s.billRows.slice();
        rows[idx] = Object.assign({}, rows[idx], { cat: catId });
        return { billRows: rows };
      });
    },
    confirmBillImport: function () {
      var chosen = state.billRows.filter(function (r) { return r.include; });
      if (!chosen.length) { showToast('没有勾选任何记录'); return; }
      var newTx = chosen.map(function (r) {
        return { id: uid() + Math.floor(Math.random() * 1000), type: r.type, cat: r.cat, note: r.note, amount: r.amount, date: r.date, channel: r.channel };
      });
      update(function (s) { return { transactions: newTx.concat(s.transactions), billRows: [], tab: 'home' }; });
      showToast('已导入 ' + newTx.length + ' 笔记录');
    },
    cancelBillImport: function () { update({ billRows: [], tab: 'profile' }); },

    /* ---- 分类管理 ---- */
    setNewCategoryHue: function (h) { update({ newCategoryHue: parseInt(h, 10) }); },
    addCategory: function () {
      var name = (state.newCategoryName || '').trim();
      if (!name) { showToast('请输入分类名称'); return; }
      var id = 'cat_' + uid();
      update(function (s) {
        var list = s.categories.concat([{ id: id, name: name, hue: s.newCategoryHue }]);
        var bl = Object.assign({}, s.budgetLimits); bl[id] = 300;
        return { categories: list, budgetLimits: bl, newCategoryName: '', newCategoryHue: s.newCategoryHue };
      });
      showToast('分类已添加');
    },
    deleteCategory: function (id) {
      if (cats().length <= 1) { showToast('至少保留一个分类'); return; }
      update(function (s) {
        var list = s.categories.filter(function (c) { return c.id !== id; });
        var bl = Object.assign({}, s.budgetLimits); delete bl[id];
        return { categories: list, budgetLimits: bl };
      });
      showToast('分类已删除（历史记录仍会保留原分类名）');
    },

    /* ---- 交易列表筛选 ---- */
    setTxListSearch: function () {},
    resetTxListFilters: function () { update({ txList: { search: '', type: 'all', cat: 'all', monthKey: 'all' } }); },

    /* ---- 数据备份 ---- */
    exportBackup: function () {
      var s = state;
      var payload = {
        exportedAt: new Date().toISOString(), app: 'cefang-ledger', version: 1,
        transactions: s.transactions, assets: s.assets, categories: s.categories,
        budgetLimits: s.budgetLimits, piggyBalance: s.piggyBalance, piggyGoal: s.piggyGoal,
        piggyHistory: s.piggyHistory,
        customColors: s.customColors, accentHue: s.accentHue, skinId: s.skinId, mode: s.mode
      };
      try {
        var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'cefang-ledger-backup-' + todayISO() + '.json';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
        showToast('备份文件已导出');
      } catch (e) { console.error(e); showToast('导出失败'); }
    },
    pickImportFile: function () { var el = document.getElementById('importFileInput'); if (el) el.click(); },

    /* ---- 安全锁 ---- */
    toggleSecurity: function () {
      if (state.security.pinEnabled) {
        update(function (s) { return { security: Object.assign({}, s.security, { pinEnabled: false }) }; });
        showToast('安全锁已关闭');
      } else {
        update({ overlay: 'setPin', pinSetupStage: 'enter', pinSetupFirst: '', pinInput: '', pinError: '' });
      }
    },
    changePin: function () { update({ overlay: 'setPin', pinSetupStage: 'enter', pinSetupFirst: '', pinInput: '', pinError: '' }); },
    setPinPress: function (k) {
      update(function (s) {
        var v = s.pinInput;
        if (k === 'del') return { pinInput: v.slice(0, -1) };
        if (v.length >= 4) return {};
        v = v + k;
        if (v.length < 4) return { pinInput: v, pinError: '' };
        // reached 4 digits
        if (s.pinSetupStage === 'enter') {
          return { pinSetupFirst: v, pinInput: '', pinSetupStage: 'confirm', pinError: '' };
        }
        if (v === s.pinSetupFirst) {
          return {
            security: { pinEnabled: true, pinCode: v },
            overlay: null, pinInput: '', pinSetupFirst: '', pinSetupStage: 'enter', pinError: ''
          };
        }
        return { pinInput: '', pinSetupFirst: '', pinSetupStage: 'enter', pinError: '两次输入不一致，请重新设置' };
      });
      if (state.overlay === null) showToast('安全锁已开启');
    },
    lockPress: function (k) {
      var v = state.pinInput;
      if (k === 'del') { update({ pinInput: v.slice(0, -1) }); return; }
      if (v.length >= 4) return;
      v = v + k;
      if (v.length < 4) { update({ pinInput: v, pinError: '' }); return; }
      if (v === state.security.pinCode) {
        state.pinInput = ''; state.pinError = '';
        locked = false;
        render();
      } else {
        state.pinInput = ''; state.pinError = '密码错误，请重试';
        render();
      }
    }
  };

  function handleClick(e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    var arg = el.getAttribute('data-arg');
    if (Actions[act]) { e.preventDefault(); Actions[act](arg, el); }
  }
  function handleInput(e) {
    var el = e.target;
    if (el.id === 'newProfileNameInput') { newProfileNameDraft = el.value; return; }
    var bind = el.getAttribute && el.getAttribute('data-bind');
    if (!bind || !state) return;
    setPath(state, bind, el.value);
    persist();
    if (el.getAttribute('data-live') === '1') render();
  }
  function handleChange(e) {
    if (!state) return;
    var el = e.target;
    if (el.id === 'avatarFileInput' && el.files && el.files[0]) {
      compressImageFile(el.files[0], 480, function (dataUrl) { update({ avatarImg: dataUrl }); });
      return;
    }
    if (el.id === 'wallpaperFileInput' && el.files && el.files[0]) {
      compressImageFile(el.files[0], 800, function (dataUrl) { update({ wallpaperImg: dataUrl, skinId: 'photo' }); });
      return;
    }
    if (el.id === 'billFileInput' && el.files && el.files[0]) {
      var channel = state.pendingBillChannel || 'alipay';
      var freader = new FileReader();
      freader.onload = function (ev) {
        try {
          var buf = ev.target.result;
          var encoding = channel === 'alipay' ? 'gbk' : 'utf-8';
          var text;
          try { text = new TextDecoder(encoding).decode(buf); }
          catch (encErr) { text = new TextDecoder('utf-8').decode(buf); }
          var rows = parseBillCsv(text, channel);
          if (!rows.length) { showToast('没有识别到有效交易，确认文件是官方导出的账单 CSV'); return; }
          update({ billRows: rows, tab: 'billReview' });
          showToast('识别到 ' + rows.length + ' 笔交易，请核对后导入');
        } catch (err) {
          console.error(err); showToast('账单解析失败，请确认文件格式');
        }
      };
      freader.readAsArrayBuffer(el.files[0]);
      return;
    }
    if (el.id === 'importFileInput' && el.files && el.files[0]) {
      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var data = JSON.parse(ev.target.result);
          if (!data || !Array.isArray(data.transactions)) { showToast('文件格式不正确'); return; }
          var ok = window.confirm ? window.confirm('导入将覆盖当前的记账数据，确定要继续吗？') : true;
          if (!ok) return;
          update(function (s) {
            return {
              transactions: data.transactions || s.transactions,
              assets: data.assets || s.assets,
              categories: (data.categories && data.categories.length) ? data.categories : s.categories,
              budgetLimits: data.budgetLimits || s.budgetLimits,
              piggyBalance: (typeof data.piggyBalance === 'number') ? data.piggyBalance : s.piggyBalance,
              piggyGoal: (typeof data.piggyGoal === 'number') ? data.piggyGoal : s.piggyGoal,
              piggyHistory: data.piggyHistory || s.piggyHistory,
              customColors: data.customColors || s.customColors,
              accentHue: (typeof data.accentHue === 'number') ? data.accentHue : s.accentHue,
              skinId: data.skinId || s.skinId,
              mode: data.mode || s.mode
            };
          });
          showToast('备份已导入');
        } catch (err) {
          console.error(err); showToast('文件解析失败，请确认是正确的备份文件');
        }
      };
      reader.readAsText(el.files[0]);
      return;
    }
    var budgetCat = el.getAttribute && el.getAttribute('data-budget-cat');
    if (budgetCat != null) {
      var newLimit = Math.max(0, parseFloat(el.value) || 0);
      update(function (s) {
        var bl = Object.assign({}, s.budgetLimits);
        bl[budgetCat] = newLimit;
        return { budgetLimits: bl };
      });
      return;
    }
    var billIdx = el.getAttribute && el.getAttribute('data-bill-idx');
    if (billIdx != null) {
      var bi = parseInt(billIdx, 10);
      update(function (s) {
        var rows = s.billRows.slice();
        rows[bi] = Object.assign({}, rows[bi], { cat: el.value });
        return { billRows: rows };
      });
      return;
    }
    var colorBind = el.getAttribute && el.getAttribute('data-color-idx');
    if (colorBind != null) {
      var idx = parseInt(colorBind, 10);
      update(function (s) { var arr = s.customColors.slice(); arr[idx] = el.value; return { customColors: arr }; });
      return;
    }
    var selBind = el.getAttribute && el.getAttribute('data-bind');
    if (selBind) {
      setPath(state, selBind, el.value);
      persist();
      if (el.tagName === 'SELECT' || el.getAttribute('data-live') === '1') render();
    }
  }

  var bound = false;
  function bindEvents() {
    if (bound) return;
    bound = true;
    var root = document.getElementById('app');
    root.addEventListener('click', handleClick);
    root.addEventListener('input', handleInput);
    root.addEventListener('change', handleChange);
  }

  /* expose for debugging */
  window.__App = { state: function () { return state; }, update: update, showToast: showToast, parseBillCsv: parseBillCsv };

  document.addEventListener('DOMContentLoaded', function () {
    bindEvents();
    render();
  });
})();
