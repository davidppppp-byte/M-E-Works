// ============================================================
// app.js — 蒙恩水電保險管理平台 v4
// v4：全新介面、數字動效、走勢線、快捷鍵、拖放匯入、深淺色切換
// ============================================================

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const S = { sites: [], records: [], insurance: [] };
const ELEC_PALETTE  = ['#E9A20E','#D9541E','#B7791F','#F2C14E','#C2410C','#A16207','#FB923C','#8C6D1F'];
const WATER_PALETTE = ['#2448D8','#0E9FB0','#7C5CFF','#1F8A70','#5B8DEF','#3F51B5','#38BDF8','#6B7FA8'];
let elecChart = null, waterChart = null;
let inputMode = 'water';
let histPage  = 1;
const HIST_PAGE_SIZE = 15;
let unfilledOpen = false;
try { unfilledOpen = localStorage.getItem('mn-unfilled-open') === '1'; } catch (e) {}
let lastSaved = null;
let loaded = false;
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const TAB_META = {
  dashboard: ['01', 'Overview',    '儀表板'],
  input:     ['02', 'Meter entry', '輸入水電'],
  insurance: ['03', 'Policies',    '保險追蹤'],
  sites:     ['04', 'Sites',       '廠區管理'],
  io:        ['05', 'Import · Export', '匯入匯出'],
};

// ── 小工具 ───────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
const stripType = n => n.replace(/【水】|【電】/g, '').trim();
const fmt = n => Math.round(n).toLocaleString('zh-TW');
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

// ── 廠區分組邏輯 ─────────────────────────────────────────────
const LOCATION_KEYS = ['北屯總部','崇德門市','生產中心','物流中心','大雅宿舍','前村路','宿舍'];

function getLocation(n) {
  for (const k of LOCATION_KEYS) if (n.includes(k)) return k;
  return n.replace(/【水】|【電】/g,'').trim();
}
function getType(n) {
  return n.startsWith('【水】') ? 'water' : n.startsWith('【電】') ? 'elec' : 'unknown';
}
function groupByLocation(sites) {
  const m = {};
  for (const s of sites) { const l = getLocation(s.name); if (!m[l]) m[l]=[]; m[l].push(s); }
  return m;
}
function meterLabel(site, loc) {
  // 卡片內已顯示廠區名稱，列只顯示剩下的編號
  const rest = stripType(site.name).replace(loc, '').trim();
  return rest || '主表';
}

// ── 異常偵測 ─────────────────────────────────────────────────
function getAnomalyPct(siteId, key) {
  const recs = S.records.filter(r => r.siteId === siteId && r[key] > 0)
    .sort((a,b) => a.period.localeCompare(b.period));
  if (recs.length < 2) return null;
  const last = recs[recs.length - 1][key];
  const prev = recs[recs.length - 2][key];
  if (prev === 0) return null;
  return Math.round(((last - prev) / prev) * 100);
}

// ── 未填提醒 ─────────────────────────────────────────────────
function getExpectedPeriod(cycle) {
  const now = new Date();
  let y = now.getFullYear(), m = now.getMonth() + 1; // current month
  if (cycle === 2) { if (m % 2 !== 0) m -= 1; } // last even month
  if (m < 1) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2,'0')}`;
}

function getUnfilled() {
  const items = [];
  for (const s of S.sites) {
    const type = getType(s.name);
    const key  = type === 'water' ? 'water' : 'elec';
    const expected = getExpectedPeriod(s.cycle);
    const has = S.records.find(r => r.siteId === s.id && r.period === expected && r[key] > 0);
    if (!has) items.push({ id: s.id, name: s.name, type, period: expected });
  }
  return items;
}

function renderUnfilledFloat() {
  const items = getUnfilled();
  const el = $('unfilled-float');
  if (items.length === 0) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.classList.toggle('open', unfilledOpen);
  $('unfilled-toggle').setAttribute('aria-expanded', unfilledOpen);
  $('unfilled-chevron').style.transform = unfilledOpen ? '' : 'rotate(180deg)';
  $('unfilled-title').textContent = `本期待填 · ${items.length} 項`;
  $('unfilled-list').innerHTML = items.map(i =>
    `<button class="unfilled-item ${i.type}" data-fill="${esc(i.id)}" data-period="${i.period}" title="前往填寫">
      <span class="m-dot"></span><span class="u-name">${esc(stripType(i.name))}</span>
      <span class="unfilled-period">${i.period}</span><i class="ti ti-arrow-right"></i>
    </button>`).join('');
}

function toggleUnfilled() {
  unfilledOpen = !unfilledOpen;
  try { localStorage.setItem('mn-unfilled-open', unfilledOpen ? '1' : '0'); } catch (e) {}
  renderUnfilledFloat();
}

function jumpToFill(siteId, period) {
  const s = getSite(siteId); if (!s) return;
  goTab('input');
  setInputMode(getType(s.name) === 'elec' ? 'elec' : 'water');
  $('in-site').value = siteId;
  $('in-period').value = period;
  const inp = $(inputMode === 'water' ? 'in-water' : 'in-elec');
  inp.value = '';
  setTimeout(() => inp.focus(), 250);
}

// ── Supabase ─────────────────────────────────────────────────
async function loadAll() {
  setSyncStatus('busy');
  try {
    const [sR, rR, iR] = await Promise.all([
      db.from('sites').select('*').order('name'),
      db.from('utility_records').select('*').order('period'),
      db.from('insurance').select('*').order('expiry'),
    ]);
    if (sR.error) throw sR.error;
    if (rR.error) throw rR.error;
    if (iR.error) throw iR.error;
    S.sites     = sR.data.map(r => ({ id:r.id, name:r.name, cycle:r.cycle }));
    S.records   = rR.data.map(r => ({ id:r.id, siteId:r.site_id, period:r.period, elec:+r.elec, water:+r.water }));
    S.insurance = iR.data.map(r => ({ id:r.id, name:r.name, vendor:r.vendor, expiry:r.expiry, alertDays:r.alert_days, note:r.note }));
    loaded = true;
    setSyncStatus('ok'); syncSelects(); renderDash(); renderUnfilledFloat(); updateIOCounts();
    const active = document.querySelector('.tab.active')?.id.replace('tab-','');
    if (active && active !== 'dashboard') goTab(active, true);
  } catch (err) { setSyncStatus('err'); showToast('資料載入失敗：' + err.message, 'error'); $('dash-lede').textContent = '無法連線至資料庫，請稍後重新整理。'; }
}

async function upsertRecord(siteId, period, elec, water) {
  const ex = S.records.find(r => r.siteId === siteId && r.period === period);
  if (ex) {
    const { error } = await db.from('utility_records').update({ elec, water }).eq('id', ex.id);
    if (error) throw error; ex.elec = elec; ex.water = water;
  } else {
    const { data, error } = await db.from('utility_records').insert({ site_id:siteId, period, elec, water }).select().single();
    if (error) throw error; S.records.push({ id:data.id, siteId, period, elec, water });
  }
}
async function deleteRecord(id) {
  const { error } = await db.from('utility_records').delete().eq('id', id);
  if (error) throw error; S.records = S.records.filter(r => r.id !== id);
}
async function insertInsurance(item) {
  const { data, error } = await db.from('insurance')
    .insert({ name:item.name, vendor:item.vendor, expiry:item.expiry, alert_days:item.alertDays, note:item.note })
    .select().single();
  if (error) throw error; S.insurance.push({ ...item, id:data.id });
}
async function deleteInsurance(id) {
  const { error } = await db.from('insurance').delete().eq('id', id);
  if (error) throw error; S.insurance = S.insurance.filter(i => i.id !== id);
}
async function insertSite(name, cycle) {
  const { data, error } = await db.from('sites').insert({ name, cycle }).select().single();
  if (error) throw error; S.sites.push({ id:data.id, name, cycle });
}
async function deleteSite(id) {
  const { error } = await db.from('sites').delete().eq('id', id);
  if (error) throw error;
  S.sites   = S.sites.filter(s => s.id !== id);
  S.records = S.records.filter(r => r.siteId !== id);
}

// ── Helpers ──────────────────────────────────────────────────
function getSite(id)  { return S.sites.find(s => s.id === id); }
function siteRecs(id) { return S.records.filter(r => r.siteId === id).sort((a,b) => a.period.localeCompare(b.period)); }
function daysLeft(d)  { return Math.ceil((new Date(d) - new Date()) / 864e5); }
function todayStr()   { return new Date().toISOString().slice(0,10); }

function setSyncStatus(s) {
  const el = $('sync-status');
  const m = { ok:['sync-ok','ti-cloud-check','已同步'], busy:['sync-busy','ti-cloud-up','同步中…'], err:['sync-err','ti-cloud-x','同步失敗'] }[s];
  el.className = 'sync-badge ' + m[0];
  el.title = m[2];
  el.innerHTML = `<i class="ti ${m[1]}"></i><span>${m[2]}</span>`;
}

function showToast(msg, type='success') {
  const t = $('toast');
  t.className = 'toast ' + type;
  void t.offsetWidth; // 重新觸發動效
  t.classList.add('show');
  $('toast-icon').className = 'ti ' + (type==='success' ? 'ti-check' : 'ti-exclamation-mark');
  $('toast-msg').textContent = msg;
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 3200);
}

function setBusy(btn, on) { btn.disabled = on; btn.classList.toggle('is-loading', on); }

function syncSelects() {
  const filtered = S.sites.filter(s => getType(s.name) === inputMode);
  const inSite = $('in-site');
  if (inSite) { const v=inSite.value; inSite.innerHTML=filtered.map(s=>`<option value="${esc(s.id)}">${esc(stripType(s.name))}</option>`).join(''); if(v && filtered.some(s=>s.id===v)) inSite.value=v; }
  const hf = $('hist-filter');
  if (hf) { const v=hf.value; hf.innerHTML='<option value="all">所有計費項目</option>'+S.sites.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join(''); if(v) hf.value=v; }
  const locs = [...new Set(S.sites.map(s => getLocation(s.name)))].sort();
  const sf = $('site-filter');
  if (sf) { const v=sf.value; sf.innerHTML='<option value="all">所有廠區</option>'+locs.map(l=>`<option value="${esc(l)}">${esc(l)}</option>`).join(''); if(v) sf.value=v; }
}

function updateIOCounts() {
  const eu=$('export-util-count'); const ei=$('export-ins-count');
  if(eu) eu.textContent=`${S.records.length.toLocaleString()} 筆紀錄`;
  if(ei) ei.textContent=`${S.insurance.length.toLocaleString()} 筆保險`;
}

// ── 動效：數字滾動 ───────────────────────────────────────────
function countUp(root) {
  root.querySelectorAll('[data-count]').forEach(el => {
    const target = +el.dataset.count;
    if (REDUCED || !target) { el.textContent = fmt(target); return; }
    const start = performance.now(), dur = 1100;
    const tick = now => {
      const p = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - p, 4);
      el.textContent = fmt(target * e);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const cumsum = a => { let t = 0; return a.map(v => (t += v)); };

// ── 走勢線 ──────────────────────────────────────────────────
function sparkline(values) {
  const pts = values.map((v,i) => [i, v]).filter(p => p[1] > 0);
  if (pts.length < 2) return '';
  const W = 240, H = 80, pad = 6;
  const max = Math.max(...pts.map(p=>p[1])), min = Math.min(...pts.map(p=>p[1]));
  const n = values.length - 1 || 1;
  const xy = pts.map(([i,v]) => [pad + (i/n)*(W-pad*2), H-pad - ((v-min)/((max-min)||1))*(H-pad*2-6)]);
  let d = `M${xy[0][0]},${xy[0][1]}`;
  for (let i=1;i<xy.length;i++) {
    const [x0,y0]=xy[i-1], [x1,y1]=xy[i], cx=(x0+x1)/2;
    d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
  }
  const last = xy[xy.length-1];
  const area = `${d} L${last[0]},${H} L${xy[0][0]},${H} Z`;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <path class="area" d="${area}" fill="currentColor"/>
    <path class="ln" d="${d}" stroke="currentColor" pathLength="1" style="--len:1"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="3.5" fill="currentColor"/></svg>`;
}

// ── Tab ──────────────────────────────────────────────────────
function goTab(name, silent) {
  const swap = () => {
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b=>{ const on = b.dataset.tab===name; b.classList.toggle('active', on); on ? b.setAttribute('aria-current','page') : b.removeAttribute('aria-current'); });
    $('tab-'+name).classList.add('active');
    const [idx, en, zh] = TAB_META[name];
    $('page-idx').textContent = idx; $('page-en').textContent = en; $('page-title').textContent = zh;
    document.title = `${zh} — 蒙恩水電保險管理平台`;
    if (name==='dashboard') { renderDash(); renderUnfilledFloat(); }
    if (name==='input')     { syncSelects(); renderHistory(); }
    if (name==='insurance') renderIns();
    if (name==='sites')     { renderSites(); updateSitePreview(); }
    if (name==='io')        updateIOCounts();
  };
  swap();
  if (!silent) window.scrollTo({ top: 0, behavior: REDUCED ? 'auto' : 'smooth' });
}

// ── 儀表板 ───────────────────────────────────────────────────
function getBiPeriods() {
  const all = [...new Set(S.records.map(r=>r.period))].sort();
  const bi = []; for (let i=all.length-1; i>=0&&bi.length<12; i--) {
    const [y,m]=all[i].split('-').map(Number); const k=m%2===0?all[i]:`${y}-${String(m+1).padStart(2,'0')}`;
    if (!bi.includes(k)) bi.unshift(k);
  } return bi;
}
function getBiVal(siteId, biP, key) {
  const [y,m]=biP.split('-').map(Number);
  const p1=`${y}-${String(m-1).padStart(2,'0')}`, p2=biP;
  const r1=S.records.find(r=>r.siteId===siteId&&r.period===p1);
  const r2=S.records.find(r=>r.siteId===siteId&&r.period===p2);
  const v=(r1?.[key]||0)+(r2?.[key]||0); return v||null;
}

function renderInsAlerts(targetId) {
  const urgent  = S.insurance.filter(i=>{ const d=daysLeft(i.expiry); return d>0&&d<=i.alertDays; }).sort((a,b)=>a.expiry.localeCompare(b.expiry));
  const expired = S.insurance.filter(i=>daysLeft(i.expiry)<=0);
  let h='';
  expired.forEach(i=>{ h+=`<div class="alert-item danger"><i class="ti ti-alert-octagon"></i><span class="a-text">${esc(i.name)}<small>${esc(i.vendor)}</small></span><span class="a-days">已到期</span></div>`; });
  urgent.forEach(i=>{  h+=`<div class="alert-item warning"><i class="ti ti-bell-ringing"></i><span class="a-text">${esc(i.name)}<small>${esc(i.vendor)} · ${esc(i.expiry)}</small></span><span class="a-days">剩 ${daysLeft(i.expiry)} 天</span></div>`; });
  $(targetId).innerHTML = h;
  return urgent.length + expired.length;
}

function renderDash() {
  syncSelects();
  const locFilter  = $('site-filter')?.value || 'all';
  const threshold  = parseInt($('anomaly-threshold')?.value || '20');
  const allSites   = locFilter==='all' ? S.sites : S.sites.filter(s=>getLocation(s.name)===locFilter);
  const ids        = new Set(allSites.map(s=>s.id));

  // 保險警示
  const totalAlerts = renderInsAlerts('alert-list');
  const badge=$('top-badge');
  if (totalAlerts>0) { badge.style.display='inline-flex'; badge.className='pill danger'; badge.setAttribute('role','button'); badge.tabIndex=0; badge.innerHTML=`<i class="ti ti-bell"></i>${totalAlerts} 項保險需處理`; }
  else badge.style.display='none';

  if (!loaded) return;

  // 指標
  const now = new Date();
  const thisYear = String(now.getFullYear());
  let totalElec=0, totalWater=0;
  const monthE = Array(12).fill(0), monthW = Array(12).fill(0);
  S.records.filter(r=>r.period.startsWith(thisYear) && ids.has(r.siteId)).forEach(r=>{
    totalElec+=r.elec||0; totalWater+=r.water||0;
    const mi = +r.period.slice(5,7)-1; monthE[mi]+=r.elec||0; monthW[mi]+=r.water||0;
  });
  const curM = now.getMonth()+1;

  // 異常計數
  let anomalyCount=0;
  for (const s of allSites) {
    const key = getType(s.name)==='water' ? 'water' : 'elec';
    const pct = getAnomalyPct(s.id, key);
    if (pct !== null && Math.abs(pct) > threshold) anomalyCount++;
  }
  const nW = allSites.filter(s=>getType(s.name)==='water').length;
  const nE = allSites.filter(s=>getType(s.name)==='elec').length;
  const unfilled = getUnfilled().filter(u=>ids.has(u.id)).length;

  // 導言
  const dateTxt = `${now.getMonth()+1} 月 ${now.getDate()} 日`;
  const scope = locFilter==='all' ? '全公司' : `「${esc(locFilter)}」`;
  $('dash-lede').innerHTML = `截至 ${dateTxt}，${scope} ${allSites.length} 個計費項目本年度累計用電 <span class="hl-elec">${fmt(totalElec)} 度</span>、水費 <span class="hl-water">$${fmt(totalWater)}</span>。`
    + (anomalyCount ? ` 有 <span class="hl-red">${anomalyCount} 項</span>用量變動超過 ±${threshold}%。` : ` 所有項目用量變動皆在 ±${threshold}% 內。`)
    + (unfilled ? ` 本期尚有 <strong>${unfilled} 項</strong>待填。` : '');

  $('metrics').innerHTML=`
    <article class="kpi elec">
      <div class="kpi-top"><span class="kpi-label"><i class="ti ti-bolt"></i>今年累計用電</span><span class="kpi-unit">kWh</span></div>
      ${sparkline(cumsum(monthE.slice(0,curM)))}
      <div class="kpi-value" data-count="${totalElec}">0</div>
      <div class="kpi-foot"><span>單位：度</span><span>1–${curM} 月</span></div>
    </article>
    <article class="kpi water">
      <div class="kpi-top"><span class="kpi-label"><i class="ti ti-droplet"></i>今年累計水費</span><span class="kpi-unit">TWD</span></div>
      ${sparkline(cumsum(monthW.slice(0,curM)))}
      <div class="kpi-value"><span class="cur">$</span><span data-count="${totalWater}">0</span></div>
      <div class="kpi-foot"><span>單位：元</span><span>1–${curM} 月</span></div>
    </article>
    <article class="kpi">
      <div class="kpi-top"><span class="kpi-label"><i class="ti ti-gauge"></i>計費項目</span><span class="kpi-unit">Meters</span></div>
      <div class="kpi-value" data-count="${allSites.length}">0</div>
      <div class="split-bar" aria-hidden="true"><span class="w" style="flex:${nW||0.0001}"></span><span class="e" style="flex:${nE||0.0001}"></span></div>
      <div class="kpi-foot"><span>水 <b>${nW}</b></span><span>電 <b>${nE}</b></span></div>
    </article>
    <article class="kpi ${anomalyCount>0?'alert':'ok'}">
      <div class="kpi-top"><span class="kpi-label"><i class="ti ${anomalyCount>0?'ti-activity-heartbeat':'ti-circle-check'}"></i>用量異常</span><span class="kpi-unit">±${threshold}%</span></div>
      <div class="kpi-value" data-count="${anomalyCount}">0</div>
      <div class="kpi-foot"><span>${anomalyCount>0?'與上一期相比變動過大':'一切正常'}</span></div>
    </article>`;
  countUp($('metrics'));

  // 廠區卡片
  const grouped=groupByLocation(allSites);
  const locs=Object.keys(grouped).sort();
  $('location-cards').innerHTML = locs.length ? locs.map((loc, li)=>{
    const locSites=grouped[loc];
    const waterSites=locSites.filter(s=>getType(s.name)==='water');
    const elecSites =locSites.filter(s=>getType(s.name)==='elec');
    let hot = 0;
    const mkRow=(s,key)=>{
      const recs=siteRecs(s.id).filter(r=>r[key]>0); const last=recs[recs.length-1];
      const val=last?(key==='water'?'$'+fmt(last.water):fmt(last.elec)+' 度'):'—';
      const pct=getAnomalyPct(s.id, key);
      const isAnomaly=pct!==null&&Math.abs(pct)>threshold;
      if (isAnomaly) hot++;
      const delta = pct===null ? '' : `<span class="m-delta${isAnomaly?' hot':''}" title="與上一期相比">${pct>0?'▲':pct<0?'▼':'±'} ${Math.abs(pct)}%</span>`;
      return `<div class="meter ${key}${isAnomaly?' anomaly':''}">
        <span class="m-dot"></span>
        <span class="m-name" title="${esc(s.name)}"><b>${esc(meterLabel(s, loc))}</b><span>${last?last.period:'尚無紀錄'}</span></span>
        ${delta||'<span></span>'}<span class="m-val">${val}</span>
      </div>`;
    };
    const rows=[...waterSites.map(s=>mkRow(s,'water')), ...elecSites.map(s=>mkRow(s,'elec'))].join('');
    return `<article class="loc-card" style="--i:${li}">
      <header class="loc-head"><h3 class="loc-name">${esc(loc)}</h3><span class="loc-meta">${hot?`<span class="warn">${hot} 異常 · </span>`:''}${String(locSites.length).padStart(2,'0')} 項</span></header>
      <div class="meters">${rows||'<div class="loc-empty">尚無資料</div>'}</div>
    </article>`;
  }).join('') : `<div class="panel empty-state"><i class="ti ti-building-off"></i><b>尚無計費項目</b>到「廠區管理」新增第一個項目</div>`;

  renderCharts(allSites);
}

function renderCharts(allSites) {
  const biP=getBiPeriods();
  const ink2 = cssVar('--ink-2'), ink3 = cssVar('--ink-3'), line = cssVar('--line');
  const surface = cssVar('--surface');
  const mono = "'JetBrains Mono', ui-monospace, monospace";
  const mkDs=(siteList,key,pal)=>siteList.slice(0,8).map((s,i)=>{
    const c = i===0 ? cssVar(key==='elec'?'--elec':'--water') : pal[i%pal.length];
    return {
      label: stripType(s.name),
      data: biP.map(p=>getBiVal(s.id,p,key)),
      borderColor: c, backgroundColor: c, pointBackgroundColor: surface, pointBorderColor: c,
      tension:.38, spanGaps:true, pointRadius:0, pointHoverRadius:5, pointHoverBorderWidth:2, borderWidth:2,
    };
  });
  const opts=(unit, prefix)=>({
    responsive:true, maintainAspectRatio:false,
    interaction:{ mode:'index', intersect:false },
    animation:{ duration: REDUCED?0:900, easing:'easeOutQuart' },
    plugins:{
      legend:{ position:'bottom', align:'start', labels:{ color:ink2, font:{size:11.5, family:"'Inter Tight','Noto Sans TC',sans-serif"}, boxWidth:8, boxHeight:8, padding:14, useBorderRadius:true, borderRadius:4 } },
      tooltip:{
        backgroundColor:'#17160F', titleColor:'#FBFAF6', bodyColor:'#E8E4D8', padding:12, cornerRadius:10, boxPadding:5,
        titleFont:{ family:mono, size:11, weight:'500' }, bodyFont:{ size:12 }, usePointStyle:true,
        itemSort:(a,b)=>(b.parsed.y||0)-(a.parsed.y||0),
        callbacks:{ label:ctx=> ctx.parsed.y==null ? null : ` ${ctx.dataset.label}　${prefix}${ctx.parsed.y.toLocaleString()} ${unit}` }
      }
    },
    scales:{
      x:{ ticks:{ color:ink3, font:{size:10.5, family:mono}, maxRotation:0, autoSkipPadding:12 }, grid:{ display:false }, border:{ color:line } },
      y:{ ticks:{ color:ink3, font:{size:10.5, family:mono}, maxTicksLimit:5, callback:v=>v>=1000?(v/1000)+'k':v }, grid:{ color:line, drawTicks:false }, border:{ display:false } }
    }
  });
  if(elecChart)  elecChart.destroy();
  if(waterChart) waterChart.destroy();
  elecChart  = new Chart($('c-elec'),  { type:'line', data:{ labels:biP, datasets:mkDs(allSites.filter(s=>getType(s.name)==='elec'), 'elec', ELEC_PALETTE) },  options:opts('度','') });
  waterChart = new Chart($('c-water'), { type:'line', data:{ labels:biP, datasets:mkDs(allSites.filter(s=>getType(s.name)==='water'),'water', WATER_PALETTE) }, options:opts('元','$') });
}

// ── 水電輸入 ─────────────────────────────────────────────────
function setInputMode(mode) {
  inputMode=mode;
  $('seg').dataset.mode = mode;
  $('input-type-water').classList.toggle('active', mode==='water');
  $('input-type-elec').classList.toggle('active',  mode==='elec');
  $('input-type-water').setAttribute('aria-selected', mode==='water');
  $('input-type-elec').setAttribute('aria-selected', mode==='elec');
  $('input-elec-row').style.display  = mode==='elec'  ? '' : 'none';
  $('input-water-row').style.display = mode==='water' ? '' : 'none';
  if (mode==='water') $('in-elec').value='0';
  else                $('in-water').value='0';
  syncSelects();
}

async function addRecord() {
  const siteId=$('in-site').value;
  const period=$('in-period').value;
  const elec  =parseFloat($('in-elec').value)||0;
  const water =parseFloat($('in-water').value)||0;
  if (!siteId||!period) { showToast('請選擇計費項目並填寫期別','error'); return; }
  const btn=$('btn-add-record'); setBusy(btn, true); setSyncStatus('busy');
  try {
    await upsertRecord(siteId, period, elec, water);
    if (inputMode==='water') $('in-water').value='';
    else                     $('in-elec').value='';
    lastSaved = siteId + '|' + period;
    renderHistory(); renderUnfilledFloat(); setSyncStatus('ok');
    showToast(`已儲存 ${stripType(getSite(siteId)?.name||'')} · ${period}`);
  } catch(err) { setSyncStatus('err'); showToast('儲存失敗：'+err.message,'error'); }
  finally { setBusy(btn, false); }
}

function renderHistory() {
  syncSelects();
  const f=$('hist-filter').value;
  const q=($('hist-search')?.value||'').trim().toLowerCase();
  let recs=[...S.records].filter(r=>{
    if (f!=='all'&&r.siteId!==f) return false;
    if (q) { const s=getSite(r.siteId); if (!s?.name.toLowerCase().includes(q)&&!r.period.includes(q)) return false; }
    return true;
  }).sort((a,b)=>b.period.localeCompare(a.period));
  const total=recs.length; const paged=recs.slice(0,histPage*HIST_PAGE_SIZE);
  $('hist-tbody').innerHTML=paged.length
    ? paged.map(r=>{ const s=getSite(r.siteId); const type=s?getType(s.name):'unknown';
        const val=type==='water'?`$${r.water.toLocaleString()}`:`${r.elec.toLocaleString()} 度`;
        const isNew = lastSaved === r.siteId+'|'+r.period;
        return `<tr class="${isNew?'row-new':''}"><td><span class="cell-name"><span class="type-badge ${type}">${type==='water'?'水':'電'}</span><span class="strong">${s?esc(stripType(s.name)):'—'}</span></span></td><td class="mono">${r.period}</td><td class="num">${val}</td><td class="act"><button class="icon-btn del" data-delrec="${esc(r.id)}" aria-label="刪除此紀錄"><i class="ti ti-trash"></i></button></td></tr>`; }).join('')
    : `<tr><td colspan="4"><div class="empty-state"><i class="ti ti-database-off"></i><b>${q||f!=='all'?'找不到符合的紀錄':'尚無紀錄'}</b>${q||f!=='all'?'試試其他關鍵字或篩選':'從左側表單新增第一筆'}</div></td></tr>`;
  lastSaved = null;
  const mb=$('hist-more-btn');
  if (paged.length<total) { mb.style.display=''; mb.innerHTML=`<i class="ti ti-chevrons-down"></i>查看更多（還有 ${total-paged.length} 筆）`; }
  else mb.style.display='none';
}

async function handleDelRecord(id, btn) {
  const rec = S.records.find(r=>r.id===id); const s = rec && getSite(rec.siteId);
  if (!confirm(`確定刪除「${s?stripType(s.name):''} ${rec?.period||''}」這筆紀錄？`)) return;
  setSyncStatus('busy');
  try {
    await deleteRecord(id);
    await fadeRow(btn);
    renderHistory(); renderUnfilledFloat(); setSyncStatus('ok'); showToast('紀錄已刪除');
  }
  catch(err) { setSyncStatus('err'); showToast('刪除失敗：'+err.message,'error'); }
}
function fadeRow(btn) {
  const tr = btn?.closest('tr'); if (!tr || REDUCED) return Promise.resolve();
  tr.classList.add('removing'); return new Promise(r=>setTimeout(r, 280));
}

// ── 保險追蹤 ─────────────────────────────────────────────────
function renderIns() {
  renderInsAlerts('ins-alerts');
  const sorted=[...S.insurance].sort((a,b)=>a.expiry.localeCompare(b.expiry));
  $('ins-tbody').innerHTML = sorted.length ? sorted.map(i=>{
    const d=daysLeft(i.expiry); let pc='ok',lb=`${d} 天`;
    if(d<=0){pc='danger';lb='已到期';}else if(d<=i.alertDays)pc='danger';else if(d<=i.alertDays*2)pc='warning';
    const pct = Math.max(2, Math.min(100, d/365*100));
    return `<tr><td class="strong">${esc(i.name)}</td><td class="muted">${esc(i.vendor)||'—'}</td><td class="mono">${esc(i.expiry)}</td>
      <td><div class="life ${pc}"><span class="pill ${pc}">${lb}</span><div class="life-bar"><span style="width:${pct}%"></span></div></div></td>
      <td class="muted">${esc(i.note)||'—'}</td><td class="act"><button class="icon-btn del" data-delins="${esc(i.id)}" aria-label="刪除此保險"><i class="ti ti-trash"></i></button></td></tr>`;
  }).join('') : `<tr><td colspan="6"><div class="empty-state"><i class="ti ti-shield-off"></i><b>尚無保險資料</b>於上方表單新增</div></td></tr>`;
}

async function addIns() {
  const name=$('ins-name').value.trim(); const vendor=$('ins-vendor').value.trim();
  const expiry=$('ins-expiry').value; const alertDays=parseInt($('ins-days').value)||30;
  const note=$('ins-note').value.trim();
  if (!name||!expiry) { showToast('請填寫保險名稱與到期日','error'); return; }
  const btn=$('btn-add-ins'); setBusy(btn, true); setSyncStatus('busy');
  try {
    await insertInsurance({name,vendor,expiry,alertDays,note});
    ['ins-name','ins-vendor','ins-expiry','ins-note'].forEach(id=>$(id).value='');
    renderIns(); setSyncStatus('ok'); showToast('保險已新增');
  } catch(err) { setSyncStatus('err'); showToast('新增失敗：'+err.message,'error'); }
  finally { setBusy(btn, false); }
}

async function handleDelIns(id, btn) {
  const it = S.insurance.find(i=>i.id===id);
  if (!confirm(`確定刪除保險「${it?.name||''}」？`)) return;
  setSyncStatus('busy');
  try { await deleteInsurance(id); await fadeRow(btn); renderIns(); setSyncStatus('ok'); showToast('保險已刪除'); }
  catch(err) { setSyncStatus('err'); showToast('刪除失敗：'+err.message,'error'); }
}

// ── 廠區管理 ─────────────────────────────────────────────────
function renderSites() {
  const g=groupByLocation(S.sites); const locs=Object.keys(g).sort();
  $('sites-tbody').innerHTML = locs.length ? locs.map(loc=>{
    const rows=g[loc].map(s=>{ const c=S.records.filter(r=>r.siteId===s.id).length; const type=getType(s.name);
      return `<tr><td class="indent"><span class="cell-name">${esc(stripType(s.name))}</span></td><td><span class="type-badge ${type}">${type==='water'?'水':'電'}</span></td><td><span class="pill ${s.cycle===1?'monthly':'bimonthly'}">${s.cycle===1?'每月':'雙月'}</span></td><td class="num">${c}</td><td class="act"><button class="icon-btn del" data-delsite="${esc(s.id)}" aria-label="刪除此項目"><i class="ti ti-trash"></i></button></td></tr>`; }).join('');
    return `<tr class="group-row"><td colspan="5">${esc(loc)}<span>${g[loc].length} 項</span></td></tr>${rows}`;
  }).join('') : `<tr><td colspan="5"><div class="empty-state"><i class="ti ti-building-off"></i><b>尚無計費項目</b>於上方表單新增</div></td></tr>`;
}

function buildSiteName() {
  const type=$('new-site-type').value; const loc=$('new-site-loc').value.trim();
  const label=$('new-site-label').value.trim();
  if (!loc) return '';
  const pre = type==='water'?'【水】':'【電】';
  return label ? `${pre}${loc} ${label}` : `${pre}${loc}`;
}
function updateSitePreview() { $('site-preview').textContent = buildSiteName(); }

async function addSite() {
  const cycle=parseInt($('new-site-cycle').value);
  const name=buildSiteName();
  if (!name) { showToast('請輸入廠區名稱','error'); $('new-site-loc').focus(); return; }
  if (S.sites.find(s=>s.name===name)) { showToast('此計費項目已存在','error'); return; }
  const btn=$('btn-add-site'); setBusy(btn, true); setSyncStatus('busy');
  try {
    await insertSite(name, cycle);
    ['new-site-loc','new-site-label'].forEach(id=>$(id).value='');
    updateSitePreview(); renderSites(); syncSelects(); setSyncStatus('ok'); showToast(`${name} 已新增`);
  } catch(err) { setSyncStatus('err'); showToast('新增失敗：'+err.message,'error'); }
  finally { setBusy(btn, false); }
}

async function handleDelSite(id, btn) {
  const c=S.records.filter(r=>r.siteId===id).length;
  const s=getSite(id);
  const msg = c>0 ? `「${s?.name}」有 ${c} 筆紀錄，刪除後無法復原，確定？` : `確定刪除「${s?.name}」？`;
  if (!confirm(msg)) return;
  setSyncStatus('busy');
  try { await deleteSite(id); await fadeRow(btn); renderSites(); syncSelects(); setSyncStatus('ok'); showToast('已刪除'); }
  catch(err) { setSyncStatus('err'); showToast('刪除失敗：'+err.message,'error'); }
}

// ── Excel ─────────────────────────────────────────────────────
function dlXLSX(rows, sheetName, filename, cols) {
  const ws=XLSX.utils.aoa_to_sheet(rows); if(cols) ws['!cols']=cols;
  const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,sheetName); XLSX.writeFile(wb,filename);
}
function readXLSX(file) {
  return new Promise((res,rej)=>{ const r=new FileReader();
    r.onload=e=>{ try{ const wb=XLSX.read(e.target.result,{type:'array',cellDates:true}); const ws=wb.Sheets[wb.SheetNames[0]]; res(XLSX.utils.sheet_to_json(ws,{defval:''})); }catch(e){rej(e);} };
    r.onerror=rej; r.readAsArrayBuffer(file); });
}
const TMPL={
  utility:{sheet:'水電紀錄',filename:'蒙恩_水電紀錄範本.xlsx',cols:[{wch:26},{wch:14},{wch:14},{wch:12}],
    rows:[['計費項目名稱','期別(YYYY-MM)','用電度數(度)','水費(元)'],['【水】北屯總部 K','2026-07',0,443],['【電】北屯總部 010','2026-06',1607,0]]},
  insurance:{sheet:'保險清單',filename:'蒙恩_保險清單範本.xlsx',cols:[{wch:28},{wch:16},{wch:16},{wch:10},{wch:20}],
    rows:[['保險名稱','保險公司','到期日(YYYY-MM-DD)','預警天數','備註'],['火災險－北屯總部','和泰產物','2027-06-09',30,'自動扣款']]},
  sites:{sheet:'計費項目',filename:'蒙恩_計費項目範本.xlsx',cols:[{wch:28},{wch:20}],
    rows:[['計費項目名稱（含【水】【電】前綴）','計費週期(1=每月/2=雙月)'],['【水】新廠宿舍',2],['【電】新廠 A線',1]]},
};
function dlTemplate(type) { const t=TMPL[type]; dlXLSX(t.rows,t.sheet,t.filename,t.cols); showToast(`${t.sheet}範本下載完成`); }

async function handleFileImport(input) {
  const file=input.files[0]; if(!file) return;
  const type=$('import-type').value;
  try {
    const rows=await readXLSX(file); setSyncStatus('busy'); let count=0;
    if (type==='utility') {
      for (const r of rows) { const sn=String(r['計費項目名稱']||'').trim(); const p=String(r['期別(YYYY-MM)']||'').trim(); const site=S.sites.find(s=>s.name===sn); if(!site||!p) continue; await upsertRecord(site.id,p,parseFloat(r['用電度數(度)'])||0,parseFloat(r['水費(元)'])||0); count++; }
    } else if (type==='insurance') {
      for (const r of rows) { const name=String(r['保險名稱']||'').trim(); const expiry=String(r['到期日(YYYY-MM-DD)']||'').trim(); if(!name||!expiry) continue; await insertInsurance({name,vendor:String(r['保險公司']||'').trim(),expiry,alertDays:parseInt(r['預警天數'])||30,note:String(r['備註']||'').trim()}); count++; }
    } else if (type==='sites') {
      for (const r of rows) { const name=String(r['計費項目名稱（含【水】【電】前綴）']||'').trim(); if(!name||S.sites.find(s=>s.name===name)) continue; await insertSite(name,parseInt(r['計費週期(1=每月/2=雙月)'])||2); count++; }
    }
    input.value=''; syncSelects(); updateIOCounts(); setSyncStatus('ok'); showToast(`成功匯入 ${count} 筆資料`); renderDash(); renderUnfilledFloat();
  } catch(err) { setSyncStatus('err'); showToast('匯入失敗：'+err.message,'error'); }
}

function exportExcel(type) {
  if (type==='utility') { const rows=[['計費項目名稱','期別','用電度數(度)','水費(元)']]; S.records.forEach(r=>{ const s=getSite(r.siteId); if(s) rows.push([s.name,r.period,r.elec,r.water]); }); dlXLSX(rows,'水電紀錄',`蒙恩_水電紀錄_${todayStr()}.xlsx`,[{wch:26},{wch:14},{wch:14},{wch:12}]); }
  else if (type==='insurance') { const rows=[['保險名稱','保險公司','到期日','預警天數','備註']]; S.insurance.forEach(i=>rows.push([i.name,i.vendor,i.expiry,i.alertDays,i.note])); dlXLSX(rows,'保險清單',`蒙恩_保險清單_${todayStr()}.xlsx`,[{wch:28},{wch:16},{wch:14},{wch:10},{wch:20}]); }
  showToast('Excel 匯出完成');
}
function exportJSON() {
  const blob=new Blob([JSON.stringify(S,null,2)],{type:'application/json'}); const a=document.createElement('a');
  a.href=URL.createObjectURL(blob); a.download=`蒙恩_完整備份_${todayStr()}.json`; a.click(); URL.revokeObjectURL(a.href); showToast('完整備份匯出完成');
}
async function handleJSONImport(input) {
  const file=input.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=async e=>{
    try {
      const data=JSON.parse(e.target.result);
      if(!data.sites||!data.records||!data.insurance) throw new Error('格式不正確');
      if(!confirm('確定要覆蓋現有資料庫的所有資料嗎？此動作無法復原。')) { input.value=''; return; }
      setSyncStatus('busy');
      await db.from('utility_records').delete().neq('id','x');
      await db.from('insurance').delete().neq('id','x');
      await db.from('sites').delete().neq('id','x');
      for(const s of data.sites)     await db.from('sites').insert({id:s.id,name:s.name,cycle:s.cycle});
      for(const r of data.records)   await db.from('utility_records').insert({id:r.id,site_id:r.siteId,period:r.period,elec:r.elec,water:r.water});
      for(const i of data.insurance) await db.from('insurance').insert({id:i.id,name:i.name,vendor:i.vendor,expiry:i.expiry,alert_days:i.alertDays,note:i.note});
      await loadAll(); input.value=''; showToast('備份還原成功');
    } catch(err) { setSyncStatus('err'); showToast('還原失敗：'+err.message,'error'); }
  };
  reader.readAsText(file,'UTF-8');
}

// ── 主題 ─────────────────────────────────────────────────────
function toggleTheme() {
  const root = document.documentElement;
  const isDark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = isDark ? 'light' : 'dark';
  try { localStorage.setItem('mn-theme', root.dataset.theme); } catch (e) {}
  if (loaded && $('tab-dashboard').classList.contains('active')) renderCharts(currentDashSites());
}
function currentDashSites() {
  const f = $('site-filter')?.value || 'all';
  return f==='all' ? S.sites : S.sites.filter(s=>getLocation(s.name)===f);
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!document.documentElement.dataset.theme && loaded) renderCharts(currentDashSites());
});

// ── 事件代理 ─────────────────────────────────────────────────
document.addEventListener('click', e => {
  const nb=e.target.closest('.nav-btn');       if(nb)  { goTab(nb.dataset.tab); return; }
  if(e.target.closest('#input-type-water'))            { setInputMode('water'); return; }
  if(e.target.closest('#input-type-elec'))             { setInputMode('elec');  return; }
  if(e.target.closest('#btn-add-record'))              { addRecord();  return; }
  if(e.target.closest('#btn-add-ins'))                 { addIns();     return; }
  if(e.target.closest('#btn-add-site'))                { addSite();    return; }
  if(e.target.closest('#btn-export-json'))             { exportJSON(); return; }
  if(e.target.closest('#theme-btn'))                   { toggleTheme(); return; }
  if(e.target.closest('#top-badge'))                   { goTab('insurance'); return; }
  if(e.target.closest('#hist-more-btn'))               { histPage++; renderHistory(); return; }
  const uf=e.target.closest('[data-fill]');    if(uf)  { jumpToFill(uf.dataset.fill, uf.dataset.period); return; }
  const tpl=e.target.closest('[data-tpl]');    if(tpl) { dlTemplate(tpl.dataset.tpl); return; }
  const exp=e.target.closest('[data-export]'); if(exp) { exportExcel(exp.dataset.export); return; }
  const dr=e.target.closest('[data-delrec]');  if(dr)  { handleDelRecord(dr.dataset.delrec, dr);  return; }
  const di=e.target.closest('[data-delins]');  if(di)  { handleDelIns(di.dataset.delins, di);    return; }
  const ds=e.target.closest('[data-delsite]'); if(ds)  { handleDelSite(ds.dataset.delsite, ds);  return; }
});

// 鍵盤：1–5 切換分頁；輸入表單內 Enter 送出
document.addEventListener('keydown', e => {
  const tag = e.target.tagName;
  const typing = /INPUT|SELECT|TEXTAREA/.test(tag) || e.target.isContentEditable;
  if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && /^[1-5]$/.test(e.key)) {
    goTab(['dashboard','input','insurance','sites','io'][+e.key-1]);
  }
  if (e.key === 'Enter' && tag === 'INPUT') {
    if (e.target.closest('#tab-input .form-card')) { e.preventDefault(); addRecord(); }
    else if (e.target.closest('#tab-insurance .form-card')) { e.preventDefault(); addIns(); }
    else if (e.target.closest('#tab-sites .form-card')) { e.preventDefault(); addSite(); }
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.id === 'top-badge') { e.preventDefault(); goTab('insurance'); }
});

$('site-filter')?.addEventListener('change', renderDash);
$('anomaly-threshold')?.addEventListener('change', renderDash);
$('hist-filter')?.addEventListener('change', ()=>{ histPage=1; renderHistory(); });
$('hist-search')?.addEventListener('input',  ()=>{ histPage=1; renderHistory(); });
$('file-input')?.addEventListener('change',  function(){ handleFileImport(this); });
$('json-input')?.addEventListener('change',  function(){ handleJSONImport(this); });
['new-site-type','new-site-loc','new-site-label'].forEach(id => $(id)?.addEventListener('input', updateSitePreview));

// 拖放上傳
document.querySelectorAll('.drop-zone').forEach(z => {
  const input = z.querySelector('input[type=file]');
  ['dragenter','dragover'].forEach(ev => z.addEventListener(ev, e => { e.preventDefault(); z.classList.add('drag'); }));
  ['dragleave','drop'].forEach(ev => z.addEventListener(ev, e => { e.preventDefault(); z.classList.remove('drag'); }));
  z.addEventListener('drop', e => {
    const f = e.dataTransfer?.files; if (!f?.length) return;
    const dt = new DataTransfer(); dt.items.add(f[0]); input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  });
});

// ── 初始化 ────────────────────────────────────────────────────
const _n=new Date(); const _p=$('in-period');
if(_p) _p.value=`${_n.getFullYear()}-${String(_n.getMonth()+1).padStart(2,'0')}`;
$('today').innerHTML = `<b>${_n.toLocaleDateString('en-US',{weekday:'long'})}</b>${_n.getFullYear()}.${String(_n.getMonth()+1).padStart(2,'0')}.${String(_n.getDate()).padStart(2,'0')}`;
setInputMode('water'); loadAll();
