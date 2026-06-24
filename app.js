// ============================================================
// app.js — 蒙恩水電保險管理平台
// ============================================================

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── 全域狀態 ────────────────────────────────────────────────
const S = { sites: [], records: [], insurance: [] };
const PALETTE = ['#1D9E75','#378ADD','#BA7517','#D4537E','#7F77DD','#D85A30','#3B6D11','#A32D2D'];
let elecChart = null, waterChart = null;

// ── Supabase 資料存取 ────────────────────────────────────────

async function loadAll() {
  setSyncStatus('busy');
  try {
    const [sitesRes, recRes, insRes] = await Promise.all([
      db.from('sites').select('*').order('created_at'),
      db.from('utility_records').select('*').order('period'),
      db.from('insurance').select('*').order('expiry'),
    ]);
    if (sitesRes.error) throw sitesRes.error;
    if (recRes.error)   throw recRes.error;
    if (insRes.error)   throw insRes.error;

    S.sites     = sitesRes.data.map(r => ({ id: r.id, name: r.name, cycle: r.cycle }));
    S.records   = recRes.data.map(r => ({ id: r.id, siteId: r.site_id, period: r.period, elec: +r.elec, water: +r.water }));
    S.insurance = insRes.data.map(r => ({ id: r.id, name: r.name, vendor: r.vendor, expiry: r.expiry, alertDays: r.alert_days, note: r.note }));

    setSyncStatus('ok');
    syncSelects();
    renderDash();
    updateIOCounts();
  } catch (err) {
    setSyncStatus('err');
    showToast('資料載入失敗：' + err.message, 'error');
  }
}

async function upsertRecord(siteId, period, elec, water) {
  const existing = S.records.find(r => r.siteId === siteId && r.period === period);
  if (existing) {
    const { error } = await db.from('utility_records')
      .update({ elec, water })
      .eq('id', existing.id);
    if (error) throw error;
    existing.elec = elec; existing.water = water;
  } else {
    const { data, error } = await db.from('utility_records')
      .insert({ site_id: siteId, period, elec, water })
      .select().single();
    if (error) throw error;
    S.records.push({ id: data.id, siteId, period, elec, water });
  }
}

async function deleteRecord(id) {
  const { error } = await db.from('utility_records').delete().eq('id', id);
  if (error) throw error;
  S.records = S.records.filter(r => r.id !== id);
}

async function insertInsurance(item) {
  const { data, error } = await db.from('insurance')
    .insert({ name: item.name, vendor: item.vendor, expiry: item.expiry, alert_days: item.alertDays, note: item.note })
    .select().single();
  if (error) throw error;
  S.insurance.push({ ...item, id: data.id });
}

async function deleteInsurance(id) {
  const { error } = await db.from('insurance').delete().eq('id', id);
  if (error) throw error;
  S.insurance = S.insurance.filter(i => i.id !== id);
}

async function insertSite(name, cycle) {
  const { data, error } = await db.from('sites')
    .insert({ name, cycle })
    .select().single();
  if (error) throw error;
  S.sites.push({ id: data.id, name, cycle });
}

async function deleteSite(id) {
  const { error } = await db.from('sites').delete().eq('id', id);
  if (error) throw error;
  S.sites    = S.sites.filter(s => s.id !== id);
  S.records  = S.records.filter(r => r.siteId !== id);
}

// ── Helpers ─────────────────────────────────────────────────

function getSite(id) { return S.sites.find(s => s.id === id); }
function siteRecs(id) { return S.records.filter(r => r.siteId === id).sort((a, b) => a.period.localeCompare(b.period)); }
function daysLeft(d) { return Math.ceil((new Date(d) - new Date()) / 864e5); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

function setSyncStatus(state) {
  const el = document.getElementById('sync-status');
  const map = {
    ok:   { cls: 'sync-ok',   icon: 'ti-cloud-check', label: '已同步' },
    busy: { cls: 'sync-busy', icon: 'ti-cloud',        label: '同步中…' },
    err:  { cls: 'sync-err',  icon: 'ti-cloud-x',      label: '同步失敗' },
  };
  const m = map[state];
  el.className = 'sync-badge ' + m.cls;
  el.innerHTML = `<i class="ti ${m.icon}"></i><span>${m.label}</span>`;
}

function showToast(msg, type = 'success') {
  const t  = document.getElementById('toast');
  const ic = document.getElementById('toast-icon');
  t.className = 'toast show ' + type;
  ic.className = 'ti ' + (type === 'success' ? 'ti-check' : 'ti-alert-circle');
  document.getElementById('toast-msg').textContent = msg;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3000);
}

function syncSelects() {
  ['in-site', 'site-filter', 'hist-filter'].forEach(id => {
    const el = document.getElementById(id); if (!el) return;
    const v = el.value;
    const isFilter = id !== 'in-site';
    el.innerHTML = (isFilter ? '<option value="all">所有廠區</option>' : '') +
      S.sites.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    if (v) el.value = v;
  });
}

function updateIOCounts() {
  const eu = document.getElementById('export-util-count');
  const ei = document.getElementById('export-ins-count');
  if (eu) eu.textContent = `共 ${S.records.length} 筆紀錄`;
  if (ei) ei.textContent = `共 ${S.insurance.length} 筆保險`;
}

// ── Tab 切換 ─────────────────────────────────────────────────

function goTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  document.querySelector(`.nav-btn[data-tab="${name}"]`).classList.add('active');
  if (name === 'dashboard') renderDash();
  if (name === 'input')     { syncSelects(); renderHistory(); }
  if (name === 'insurance') renderIns();
  if (name === 'sites')     renderSites();
  if (name === 'io')        updateIOCounts();
}

// ── 儀表板 ──────────────────────────────────────────────────

const chartOpts = {
  responsive: true, maintainAspectRatio: false,
  plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }, boxWidth: 10, padding: 10, usePointStyle: true } } },
  scales: {
    x: { ticks: { font: { size: 11 } }, grid: { color: 'rgba(128,128,128,.08)' } },
    y: { ticks: { font: { size: 11 } }, grid: { color: 'rgba(128,128,128,.08)' } },
  },
};

function renderDash() {
  syncSelects();
  const filter = document.getElementById('site-filter').value;
  const sites  = filter === 'all' ? S.sites : S.sites.filter(s => s.id === filter);
  const urgent  = S.insurance.filter(i => { const d = daysLeft(i.expiry); return d > 0 && d <= i.alertDays; });
  const expired = S.insurance.filter(i => daysLeft(i.expiry) <= 0);
  const totalAlerts = urgent.length + expired.length;

  const badge = document.getElementById('top-badge');
  if (totalAlerts > 0) {
    badge.style.display = 'inline-flex';
    badge.className = 'pill danger';
    badge.innerHTML = `<i class="ti ti-bell" style="font-size:13px"></i>${totalAlerts} 項保險警示`;
  } else badge.style.display = 'none';

  let alertHtml = '';
  expired.forEach(i => { alertHtml += `<div class="alert-item danger"><i class="ti ti-alert-circle"></i><span class="a-text">${i.name}（${i.vendor}）</span><span class="a-days">已到期</span></div>`; });
  urgent.forEach(i  => { alertHtml += `<div class="alert-item warning"><i class="ti ti-bell"></i><span class="a-text">${i.name}</span><span class="a-days">剩 ${daysLeft(i.expiry)} 天</span></div>`; });
  document.getElementById('alert-list').innerHTML = alertHtml;

  let totalElec = 0, totalWater = 0;
  sites.forEach(s => {
    const r = siteRecs(s.id);
    if (r.length) { totalElec += r[r.length - 1].elec || 0; totalWater += r[r.length - 1].water || 0; }
  });
  document.getElementById('metrics').innerHTML = `
    <div class="metric-card"><div class="metric-icon mi-teal"><i class="ti ti-building"></i></div><div class="metric-label">追蹤廠區</div><div class="metric-value">${sites.length}</div><div class="metric-delta">個廠區</div></div>
    <div class="metric-card"><div class="metric-icon mi-blue"><i class="ti ti-bolt"></i></div><div class="metric-label">最新總用電</div><div class="metric-value">${totalElec.toLocaleString()}</div><div class="metric-delta">度</div></div>
    <div class="metric-card"><div class="metric-icon mi-teal"><i class="ti ti-droplet"></i></div><div class="metric-label">最新總水費</div><div class="metric-value">$${totalWater.toLocaleString()}</div><div class="metric-delta">元</div></div>
    <div class="metric-card"><div class="metric-icon ${totalAlerts > 0 ? 'mi-amber' : 'mi-teal'}"><i class="ti ti-shield"></i></div><div class="metric-label">保險警示</div><div class="metric-value" style="color:${totalAlerts > 0 ? '#854F0B' : '#0F6E56'}">${totalAlerts}</div><div class="metric-delta">項</div></div>
  `;

  const periods = [...new Set(S.records.map(r => r.period))].sort().slice(-8);
  const mkDs = (key) => sites.slice(0, 6).map((s, i) => ({
    label: s.name,
    data: periods.map(p => { const r = S.records.find(x => x.siteId === s.id && x.period === p); return r ? r[key] : null; }),
    borderColor: PALETTE[i % PALETTE.length], backgroundColor: PALETTE[i % PALETTE.length] + '18',
    tension: .35, spanGaps: true, pointRadius: 3, pointHoverRadius: 5, borderWidth: 2,
  }));

  if (elecChart)  elecChart.destroy();
  if (waterChart) waterChart.destroy();
  elecChart  = new Chart(document.getElementById('c-elec'),  { type: 'line', data: { labels: periods, datasets: mkDs('elec') },  options: chartOpts });
  waterChart = new Chart(document.getElementById('c-water'), { type: 'line', data: { labels: periods, datasets: mkDs('water') }, options: chartOpts });

  document.getElementById('dash-tbody').innerHTML = sites.map(s => {
    const r = siteRecs(s.id); const last = r[r.length - 1];
    return `<tr>
      <td style="font-weight:500">${s.name}</td>
      <td><span class="pill ${s.cycle === 1 ? 'monthly' : 'bimonthly'}">${s.cycle === 1 ? '每月' : '雙月'}</span></td>
      <td>${last ? last.elec.toLocaleString() + ' 度' : '—'}</td>
      <td>${last ? '$' + last.water.toLocaleString() : '—'}</td>
      <td style="color:#999">${last ? last.period : '—'}</td>
    </tr>`;
  }).join('');
}

// ── 水電輸入 ─────────────────────────────────────────────────

async function addRecord() {
  const siteId = document.getElementById('in-site').value;
  const period = document.getElementById('in-period').value;
  const elec   = parseFloat(document.getElementById('in-elec').value)  || 0;
  const water  = parseFloat(document.getElementById('in-water').value) || 0;
  if (!siteId || !period) { showToast('請選擇廠區並填寫期別', 'error'); return; }
  const btn = document.getElementById('btn-add-record');
  btn.disabled = true;
  setSyncStatus('busy');
  try {
    await upsertRecord(siteId, period, elec, water);
    document.getElementById('in-elec').value = '';
    document.getElementById('in-water').value = '';
    renderHistory(); setSyncStatus('ok'); showToast('紀錄已儲存');
  } catch (err) { setSyncStatus('err'); showToast('儲存失敗：' + err.message, 'error'); }
  finally { btn.disabled = false; }
}

function renderHistory() {
  syncSelects();
  const f = document.getElementById('hist-filter').value;
  const recs = [...S.records].filter(r => f === 'all' || r.siteId === f).sort((a, b) => b.period.localeCompare(a.period));
  document.getElementById('hist-tbody').innerHTML = recs.length
    ? recs.map(r => {
        const s = getSite(r.siteId);
        return `<tr>
          <td>${s ? s.name : '—'}</td><td>${r.period}</td>
          <td>${r.elec.toLocaleString()}</td><td>${r.water.toLocaleString()}</td>
          <td><button class="icon-btn del" data-delrec="${r.id}" aria-label="刪除"><i class="ti ti-trash"></i></button></td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="5"><div class="empty-state"><i class="ti ti-database-off"></i>尚無水電紀錄</div></td></tr>`;
}

async function handleDelRecord(id) {
  setSyncStatus('busy');
  try { await deleteRecord(id); renderHistory(); setSyncStatus('ok'); showToast('紀錄已刪除'); }
  catch (err) { setSyncStatus('err'); showToast('刪除失敗：' + err.message, 'error'); }
}

// ── 保險追蹤 ─────────────────────────────────────────────────

function renderIns() {
  const urgent  = S.insurance.filter(i => { const d = daysLeft(i.expiry); return d > 0 && d <= i.alertDays; });
  const expired = S.insurance.filter(i => daysLeft(i.expiry) <= 0);
  let h = '';
  expired.forEach(i => { h += `<div class="alert-item danger"><i class="ti ti-alert-circle"></i><span class="a-text">${i.name}（${i.vendor}）</span><span class="a-days">已到期</span></div>`; });
  urgent.forEach(i  => { h += `<div class="alert-item warning"><i class="ti ti-bell"></i><span class="a-text">${i.name}</span><span class="a-days">剩 ${daysLeft(i.expiry)} 天</span></div>`; });
  document.getElementById('ins-alerts').innerHTML = h;

  const sorted = [...S.insurance].sort((a, b) => a.expiry.localeCompare(b.expiry));
  document.getElementById('ins-tbody').innerHTML = sorted.map(i => {
    const d = daysLeft(i.expiry);
    let pc = 'ok', lb = `${d} 天`;
    if (d <= 0) { pc = 'danger'; lb = '已到期'; }
    else if (d <= i.alertDays) pc = 'danger';
    else if (d <= i.alertDays * 2) pc = 'warning';
    return `<tr>
      <td style="font-weight:500">${i.name}</td>
      <td style="color:#666">${i.vendor}</td>
      <td>${i.expiry}</td>
      <td><span class="pill ${pc}">${lb}</span></td>
      <td style="color:#666;font-size:12px">${i.note || '—'}</td>
      <td><button class="icon-btn del" data-delins="${i.id}" aria-label="刪除"><i class="ti ti-trash"></i></button></td>
    </tr>`;
  }).join('');
}

async function addIns() {
  const name      = document.getElementById('ins-name').value.trim();
  const vendor    = document.getElementById('ins-vendor').value.trim();
  const expiry    = document.getElementById('ins-expiry').value;
  const alertDays = parseInt(document.getElementById('ins-days').value) || 30;
  const note      = document.getElementById('ins-note').value.trim();
  if (!name || !expiry) { showToast('請填寫保險名稱與到期日', 'error'); return; }
  const btn = document.getElementById('btn-add-ins');
  btn.disabled = true; setSyncStatus('busy');
  try {
    await insertInsurance({ name, vendor, expiry, alertDays, note });
    ['ins-name','ins-vendor','ins-expiry','ins-note'].forEach(id => document.getElementById(id).value = '');
    renderIns(); setSyncStatus('ok'); showToast('保險已新增');
  } catch (err) { setSyncStatus('err'); showToast('新增失敗：' + err.message, 'error'); }
  finally { btn.disabled = false; }
}

async function handleDelIns(id) {
  setSyncStatus('busy');
  try { await deleteInsurance(id); renderIns(); setSyncStatus('ok'); showToast('保險已刪除'); }
  catch (err) { setSyncStatus('err'); showToast('刪除失敗：' + err.message, 'error'); }
}

// ── 廠區管理 ─────────────────────────────────────────────────

function renderSites() {
  document.getElementById('sites-tbody').innerHTML = S.sites.map(s => {
    const c = S.records.filter(r => r.siteId === s.id).length;
    return `<tr>
      <td style="font-weight:500">${s.name}</td>
      <td><span class="pill ${s.cycle === 1 ? 'monthly' : 'bimonthly'}">${s.cycle === 1 ? '每月一期' : '兩個月一期'}</span></td>
      <td>${c}</td>
      <td><button class="icon-btn del" data-delsite="${s.id}" aria-label="刪除"><i class="ti ti-trash"></i></button></td>
    </tr>`;
  }).join('');
}

async function addSite() {
  const name  = document.getElementById('new-site-name').value.trim();
  const cycle = parseInt(document.getElementById('new-site-cycle').value);
  if (!name) { showToast('請輸入廠區名稱', 'error'); return; }
  if (S.sites.find(s => s.name === name)) { showToast('廠區名稱已存在', 'error'); return; }
  const btn = document.getElementById('btn-add-site');
  btn.disabled = true; setSyncStatus('busy');
  try {
    await insertSite(name, cycle);
    document.getElementById('new-site-name').value = '';
    renderSites(); syncSelects(); setSyncStatus('ok'); showToast('廠區已新增');
  } catch (err) { setSyncStatus('err'); showToast('新增失敗：' + err.message, 'error'); }
  finally { btn.disabled = false; }
}

async function handleDelSite(id) {
  const c = S.records.filter(r => r.siteId === id).length;
  if (c > 0 && !confirm(`此廠區有 ${c} 筆水電紀錄，刪除後無法復原，確定？`)) return;
  setSyncStatus('busy');
  try { await deleteSite(id); renderSites(); syncSelects(); setSyncStatus('ok'); showToast('廠區已刪除'); }
  catch (err) { setSyncStatus('err'); showToast('刪除失敗：' + err.message, 'error'); }
}

// ── 匯入 / 匯出 ──────────────────────────────────────────────

function dlCSV(content, filename) {
  const blob = new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  URL.revokeObjectURL(a.href);
}

const TEMPLATES = {
  utility:   `廠區名稱,期別(YYYY-MM),用電度數(度),水費(元)\n北屯總部,2026-01,1650,2900\n崇德門市,2026-01,880,1100`,
  insurance: `保險名稱,保險公司,到期日(YYYY-MM-DD),預警天數,備註\n火災險－新廠,新光產物,2027-01-01,30,`,
  sites:     `廠區名稱,計費週期(1=每月/2=雙月)\n新竹廠,1\n嘉義門市,2`,
};
const TPL_NAMES = { utility: '水電紀錄範本', insurance: '保險清單範本', sites: '廠區設定範本' };

function dlTemplate(type) {
  dlCSV(TEMPLATES[type], `蒙恩_${TPL_NAMES[type]}.csv`);
  showToast(`${TPL_NAMES[type]} 下載完成`);
}

function parseCSV(text) {
  const lines = text.trim().split('\n').map(l => l.replace(/\r/, ''));
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).filter(l => l.trim()).map(l => {
    const vals = l.split(',').map(v => v.trim());
    const obj = {};
    headers.forEach((h, i) => obj[h] = vals[i] || '');
    return obj;
  });
}

async function handleFileImport(input) {
  const file = input.files[0]; if (!file) return;
  const type = document.getElementById('import-type').value;
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const rows = parseCSV(e.target.result);
      setSyncStatus('busy');
      let count = 0;
      if (type === 'utility') {
        for (const r of rows) {
          const site = S.sites.find(s => s.name === r['廠區名稱']);
          if (!site) continue;
          await upsertRecord(site.id, r['期別(YYYY-MM)'], parseFloat(r['用電度數(度)']) || 0, parseFloat(r['水費(元)']) || 0);
          count++;
        }
      } else if (type === 'insurance') {
        for (const r of rows) {
          await insertInsurance({ name: r['保險名稱'], vendor: r['保險公司'], expiry: r['到期日(YYYY-MM-DD)'], alertDays: parseInt(r['預警天數']) || 30, note: r['備註'] || '' });
          count++;
        }
      } else if (type === 'sites') {
        for (const r of rows) {
          const name = r['廠區名稱'];
          if (!name || S.sites.find(s => s.name === name)) continue;
          await insertSite(name, parseInt(r['計費週期(1=每月/2=雙月)']) || 1);
          count++;
        }
      }
      input.value = '';
      syncSelects(); updateIOCounts(); setSyncStatus('ok');
      showToast(`成功匯入 ${count} 筆資料`);
      renderDash();
    } catch (err) { setSyncStatus('err'); showToast('匯入失敗：' + err.message, 'error'); }
  };
  reader.readAsText(file, 'UTF-8');
}

function exportCSV(type) {
  let csv = '', filename = '';
  if (type === 'utility') {
    csv = '廠區名稱,期別,用電度數(度),水費(元)\n';
    S.records.forEach(r => { const s = getSite(r.siteId); if (s) csv += `${s.name},${r.period},${r.elec},${r.water}\n`; });
    filename = `蒙恩_水電紀錄_${todayStr()}.csv`;
  } else if (type === 'insurance') {
    csv = '保險名稱,保險公司,到期日,預警天數,備註\n';
    S.insurance.forEach(i => { csv += `${i.name},${i.vendor},${i.expiry},${i.alertDays},${i.note}\n`; });
    filename = `蒙恩_保險清單_${todayStr()}.csv`;
  }
  dlCSV(csv, filename); showToast('匯出完成');
}

function exportJSON() {
  const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `蒙恩_完整備份_${todayStr()}.json`;
  a.click(); URL.revokeObjectURL(a.href);
  showToast('完整備份匯出完成');
}

async function handleJSONImport(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.sites || !data.records || !data.insurance) throw new Error('格式不正確');
      if (!confirm('確定要覆蓋現有資料庫的所有資料嗎？此操作無法復原。')) return;
      setSyncStatus('busy');
      // 清空後重新寫入
      await db.from('utility_records').delete().neq('id', 'x');
      await db.from('insurance').delete().neq('id', 'x');
      await db.from('sites').delete().neq('id', 'x');
      for (const s of data.sites) await db.from('sites').insert({ id: s.id, name: s.name, cycle: s.cycle });
      for (const r of data.records) await db.from('utility_records').insert({ id: r.id, site_id: r.siteId, period: r.period, elec: r.elec, water: r.water });
      for (const i of data.insurance) await db.from('insurance').insert({ id: i.id, name: i.name, vendor: i.vendor, expiry: i.expiry, alert_days: i.alertDays, note: i.note });
      await loadAll();
      input.value = '';
      showToast('備份還原成功');
    } catch (err) { setSyncStatus('err'); showToast('還原失敗：' + err.message, 'error'); }
  };
  reader.readAsText(file, 'UTF-8');
}

// ── 事件代理 & 初始化 ────────────────────────────────────────

document.addEventListener('click', e => {
  const nb = e.target.closest('.nav-btn');
  if (nb) { goTab(nb.dataset.tab); return; }

  const sb = e.target.closest('.seg-btn');
  if (sb) {
    document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
    sb.classList.add('active'); renderDash(); return;
  }

  if (e.target.closest('#btn-add-record')) { addRecord(); return; }
  if (e.target.closest('#btn-add-ins'))    { addIns();    return; }
  if (e.target.closest('#btn-add-site'))   { addSite();   return; }
  if (e.target.closest('#btn-export-json')){ exportJSON(); return; }

  const tplBtn = e.target.closest('[data-tpl]');
  if (tplBtn) { dlTemplate(tplBtn.dataset.tpl); return; }

  const expBtn = e.target.closest('[data-export]');
  if (expBtn) { exportCSV(expBtn.dataset.export); return; }

  const delRec  = e.target.closest('[data-delrec]');
  if (delRec)  { handleDelRecord(delRec.dataset.delrec);  return; }

  const delIns  = e.target.closest('[data-delins]');
  if (delIns)  { handleDelIns(delIns.dataset.delins);    return; }

  const delSite = e.target.closest('[data-delsite]');
  if (delSite) { handleDelSite(delSite.dataset.delsite); return; }
});

document.getElementById('site-filter').addEventListener('change', renderDash);
document.getElementById('hist-filter').addEventListener('change', renderHistory);
document.getElementById('file-input').addEventListener('change', function() { handleFileImport(this); });
document.getElementById('json-input').addEventListener('change', function() { handleJSONImport(this); });

// 初始化
const now = new Date();
document.getElementById('in-period').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
loadAll();
