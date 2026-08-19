// ============================================================
// app.js — 蒙恩水電保險管理平台 v3
// 新增：異常偵測、未填提醒浮窗、升級儀表板
// ============================================================

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const S = { sites: [], records: [], insurance: [] };
const PALETTE = ['#1557A0','#0A6E54','#7A4800','#9B1F1F','#4A2D8A','#1A7A8A','#2D6A0A','#6B3A7A'];
let elecChart = null, waterChart = null;
let inputMode = 'water';
let histPage  = 1;
const HIST_PAGE_SIZE = 15;
let unfilledOpen = true;

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

function renderUnfilledFloat() {
  const items = [];
  for (const s of S.sites) {
    const type = getType(s.name);
    const key  = type === 'water' ? 'water' : 'elec';
    const expected = getExpectedPeriod(s.cycle);
    const has = S.records.find(r => r.siteId === s.id && r.period === expected && r[key] > 0);
    if (!has) items.push({ name: s.name, period: expected });
  }
  const el = document.getElementById('unfilled-float');
  const listEl = document.getElementById('unfilled-list');
  const titleEl = document.getElementById('unfilled-title');
  if (items.length === 0) { el.style.display = 'none'; return; }
  el.style.display = '';
  titleEl.textContent = `本期待填（${items.length}）`;
  listEl.innerHTML = items.map(i =>
    `<div class="unfilled-item"><i class="ti ti-alert-circle"></i><span>${i.name.replace(/【水】|【電】/,'')}</span><span class="unfilled-period">${i.period}</span></div>`
  ).join('') || `<div class="unfilled-empty">全部已填寫 ✓</div>`;
}

function toggleUnfilled() {
  unfilledOpen = !unfilledOpen;
  const listEl    = document.getElementById('unfilled-list');
  const chevronEl = document.getElementById('unfilled-chevron');
  listEl.style.display    = unfilledOpen ? '' : 'none';
  chevronEl.style.transform = unfilledOpen ? '' : 'rotate(-90deg)';
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
    setSyncStatus('ok'); syncSelects(); renderDash(); renderUnfilledFloat(); updateIOCounts();
  } catch (err) { setSyncStatus('err'); showToast('資料載入失敗：' + err.message, 'error'); }
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
  const el = document.getElementById('sync-status');
  const m = { ok:['sync-ok','ti-cloud-check','已同步'], busy:['sync-busy','ti-cloud','同步中…'], err:['sync-err','ti-cloud-x','同步失敗'] }[s];
  el.className = 'sync-badge ' + m[0];
  el.innerHTML = `<i class="ti ${m[1]}"></i><span>${m[2]}</span>`;
}

function showToast(msg, type='success') {
  const t = document.getElementById('toast');
  t.className = 'toast show ' + type;
  document.getElementById('toast-icon').className = 'ti ' + (type==='success' ? 'ti-check' : 'ti-alert-circle');
  document.getElementById('toast-msg').textContent = msg;
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 3200);
}

function syncSelects() {
  const filtered = S.sites.filter(s => getType(s.name) === inputMode);
  const inSite = document.getElementById('in-site');
  if (inSite) { const v=inSite.value; inSite.innerHTML=filtered.map(s=>`<option value="${s.id}">${s.name}</option>`).join(''); if(v) inSite.value=v; }
  const hf = document.getElementById('hist-filter');
  if (hf) { const v=hf.value; hf.innerHTML='<option value="all">所有計費項目</option>'+S.sites.map(s=>`<option value="${s.id}">${s.name}</option>`).join(''); if(v) hf.value=v; }
  const locs = [...new Set(S.sites.map(s => getLocation(s.name)))].sort();
  const sf = document.getElementById('site-filter');
  if (sf) { const v=sf.value; sf.innerHTML='<option value="all">所有廠區</option>'+locs.map(l=>`<option value="${l}">${l}</option>`).join(''); if(v) sf.value=v; }
}

function updateIOCounts() {
  const eu=document.getElementById('export-util-count'); const ei=document.getElementById('export-ins-count');
  if(eu) eu.textContent=`共 ${S.records.length} 筆紀錄`;
  if(ei) ei.textContent=`共 ${S.insurance.length} 筆保險`;
}

// ── Tab ──────────────────────────────────────────────────────
function goTab(name) {
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('tab-'+name).classList.add('active');
  document.querySelector(`.nav-btn[data-tab="${name}"]`).classList.add('active');
  if (name==='dashboard') { renderDash(); renderUnfilledFloat(); }
  if (name==='input')     { syncSelects(); renderHistory(); }
  if (name==='insurance') renderIns();
  if (name==='sites')     renderSites();
  if (name==='io')        updateIOCounts();
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

function renderDash() {
  syncSelects();
  const locFilter  = document.getElementById('site-filter')?.value || 'all';
  const threshold  = parseInt(document.getElementById('anomaly-threshold')?.value || '20');
  const allSites   = locFilter==='all' ? S.sites : S.sites.filter(s=>getLocation(s.name)===locFilter);

  // 保險警示
  const urgent  = S.insurance.filter(i=>{ const d=daysLeft(i.expiry); return d>0&&d<=i.alertDays; });
  const expired = S.insurance.filter(i=>daysLeft(i.expiry)<=0);
  const totalAlerts = urgent.length+expired.length;
  const badge=document.getElementById('top-badge');
  if (totalAlerts>0) { badge.style.display='inline-flex'; badge.className='pill danger'; badge.innerHTML=`<i class="ti ti-bell" style="font-size:13px"></i>${totalAlerts} 項保險警示`; }
  else badge.style.display='none';
  let alertHtml='';
  expired.forEach(i=>{ alertHtml+=`<div class="alert-item danger"><i class="ti ti-alert-circle"></i><span class="a-text">${i.name}（${i.vendor}）</span><span class="a-days">已到期</span></div>`; });
  urgent.forEach(i=>{ alertHtml+=`<div class="alert-item warning"><i class="ti ti-bell"></i><span class="a-text">${i.name}</span><span class="a-days">剩 ${daysLeft(i.expiry)} 天</span></div>`; });
  document.getElementById('alert-list').innerHTML=alertHtml;

  // 指標
  const thisYear=new Date().getFullYear().toString();
  let totalElec=0, totalWater=0;
  S.records.filter(r=>r.period.startsWith(thisYear)).forEach(r=>{ if(allSites.find(s=>s.id===r.siteId)){ totalElec+=r.elec||0; totalWater+=r.water||0; } });

  // 異常計數
  let anomalyCount=0;
  for (const s of allSites) {
    const key = getType(s.name)==='water' ? 'water' : 'elec';
    const pct = getAnomalyPct(s.id, key);
    if (pct !== null && Math.abs(pct) > threshold) anomalyCount++;
  }

  document.getElementById('metrics').innerHTML=`
    <div class="metric-card c-teal"><div class="metric-icon mi-teal"><i class="ti ti-building"></i></div><div class="metric-label">計費項目</div><div class="metric-value">${allSites.length}</div><div class="metric-delta">個</div></div>
    <div class="metric-card c-blue"><div class="metric-icon mi-blue"><i class="ti ti-bolt"></i></div><div class="metric-label">今年累計用電</div><div class="metric-value">${totalElec.toLocaleString()}</div><div class="metric-delta">度</div></div>
    <div class="metric-card c-teal"><div class="metric-icon mi-teal"><i class="ti ti-droplet"></i></div><div class="metric-label">今年累計水費</div><div class="metric-value">$${totalWater.toLocaleString()}</div><div class="metric-delta">元</div></div>
    <div class="metric-card ${anomalyCount>0?'c-red':'c-teal'}"><div class="metric-icon ${anomalyCount>0?'mi-red':'mi-teal'}"><i class="ti ti-chart-line"></i></div><div class="metric-label">用量異常</div><div class="metric-value" style="color:${anomalyCount>0?'var(--red)':'var(--teal)'}">${anomalyCount}</div><div class="metric-delta">項</div></div>
  `;

  // 廠區卡片
  const grouped=groupByLocation(allSites);
  const locs=Object.keys(grouped).sort();
  document.getElementById('location-cards').innerHTML=locs.map(loc=>{
    const locSites=grouped[loc];
    const waterSites=locSites.filter(s=>getType(s.name)==='water');
    const elecSites =locSites.filter(s=>getType(s.name)==='elec');
    const mkRow=(s,key)=>{
      const recs=siteRecs(s.id); const last=recs[recs.length-1];
      const val=last?(key==='water'?'$'+last.water.toLocaleString():last.elec.toLocaleString()+'度'):'—';
      const pct=getAnomalyPct(s.id, key);
      const isAnomaly=pct!==null&&Math.abs(pct)>threshold;
      const badge=isAnomaly?`<span class="anomaly-badge">${pct>0?'+':''}${pct}%</span>`:'';
      const type=key==='water'?'water':'elec';
      return `<div class="meter-row ${type}${isAnomaly?' anomaly':''}">
        <div class="meter-left"><div class="meter-type-dot"></div><span class="meter-name">${s.name.replace(/【水】|【電】/,'').trim()}</span></div>
        <div class="meter-right">${badge}<span class="meter-val">${val}</span></div>
      </div>`;
    };
    const rows=[...waterSites.map(s=>mkRow(s,'water')), ...elecSites.map(s=>mkRow(s,'elec'))].join('');
    return `<div class="loc-card">
      <div class="loc-card-header"><span class="loc-name"><i class="ti ti-building"></i>${loc}</span><span class="loc-count">${locSites.length} 項</span></div>
      <div class="loc-body">${rows||'<div style="font-size:12px;color:var(--text-3);padding:4px 0">尚無資料</div>'}</div>
    </div>`;
  }).join('');

  // 趨勢圖
  const biP=getBiPeriods();
  const mkDs=(siteList,key)=>siteList.slice(0,8).map((s,i)=>({
    label:s.name.replace(/【水】|【電】/,'').trim(),
    data:biP.map(p=>getBiVal(s.id,p,key)),
    borderColor:PALETTE[i%PALETTE.length], backgroundColor:PALETTE[i%PALETTE.length]+'18',
    tension:.35, spanGaps:true, pointRadius:3, pointHoverRadius:5, borderWidth:2,
  }));
  const opts=(unit)=>({ responsive:true, maintainAspectRatio:false,
    plugins:{ legend:{ position:'bottom', labels:{ font:{size:11}, boxWidth:10, padding:10, usePointStyle:true } },
      tooltip:{ callbacks:{ label:ctx=>` ${ctx.dataset.label}：${ctx.parsed.y?.toLocaleString()} ${unit}` } } },
    scales:{ x:{ticks:{font:{size:11}},grid:{color:'rgba(128,128,128,.06)'}}, y:{ticks:{font:{size:11}},grid:{color:'rgba(128,128,128,.06)'}} }
  });
  if(elecChart)  elecChart.destroy();
  if(waterChart) waterChart.destroy();
  elecChart  = new Chart(document.getElementById('c-elec'),  { type:'line', data:{ labels:biP, datasets:mkDs(allSites.filter(s=>getType(s.name)==='elec'), 'elec') },  options:opts('度') });
  waterChart = new Chart(document.getElementById('c-water'), { type:'line', data:{ labels:biP, datasets:mkDs(allSites.filter(s=>getType(s.name)==='water'),'water') }, options:opts('元') });
}

// ── 水電輸入 ─────────────────────────────────────────────────
function setInputMode(mode) {
  inputMode=mode;
  document.getElementById('input-type-water').classList.toggle('active', mode==='water');
  document.getElementById('input-type-elec').classList.toggle('active',  mode==='elec');
  document.getElementById('input-elec-row').style.display  = mode==='elec'  ? '' : 'none';
  document.getElementById('input-water-row').style.display = mode==='water' ? '' : 'none';
  if (mode==='water') document.getElementById('in-elec').value='0';
  else                document.getElementById('in-water').value='0';
  syncSelects();
}

async function addRecord() {
  const siteId=document.getElementById('in-site').value;
  const period=document.getElementById('in-period').value;
  const elec  =parseFloat(document.getElementById('in-elec').value)||0;
  const water =parseFloat(document.getElementById('in-water').value)||0;
  if (!siteId||!period) { showToast('請選擇計費項目並填寫期別','error'); return; }
  const btn=document.getElementById('btn-add-record'); btn.disabled=true; setSyncStatus('busy');
  try {
    await upsertRecord(siteId, period, elec, water);
    if (inputMode==='water') document.getElementById('in-water').value='';
    else                     document.getElementById('in-elec').value='';
    renderHistory(); renderUnfilledFloat(); setSyncStatus('ok'); showToast('紀錄已儲存');
  } catch(err) { setSyncStatus('err'); showToast('儲存失敗：'+err.message,'error'); }
  finally { btn.disabled=false; }
}

function renderHistory() {
  syncSelects();
  const f=document.getElementById('hist-filter').value;
  const q=(document.getElementById('hist-search')?.value||'').trim().toLowerCase();
  let recs=[...S.records].filter(r=>{
    if (f!=='all'&&r.siteId!==f) return false;
    if (q) { const s=getSite(r.siteId); if (!s?.name.toLowerCase().includes(q)&&!r.period.includes(q)) return false; }
    return true;
  }).sort((a,b)=>b.period.localeCompare(a.period));
  const total=recs.length; const paged=recs.slice(0,histPage*HIST_PAGE_SIZE);
  document.getElementById('hist-tbody').innerHTML=paged.length
    ? paged.map(r=>{ const s=getSite(r.siteId); const type=s?getType(s.name):'unknown';
        const val=type==='water'?`<span class="type-badge water">水</span> $${r.water.toLocaleString()}`:`<span class="type-badge elec">電</span> ${r.elec.toLocaleString()}度`;
        return `<tr><td style="font-weight:600">${s?s.name:'—'}</td><td>${r.period}</td><td>${val}</td><td><button class="icon-btn del" data-delrec="${r.id}"><i class="ti ti-trash"></i></button></td></tr>`; }).join('')
    : `<tr><td colspan="4"><div class="empty-state"><i class="ti ti-database-off"></i>尚無紀錄</div></td></tr>`;
  const mb=document.getElementById('hist-more-btn');
  if (paged.length<total) { mb.style.display=''; mb.textContent=`查看更多紀錄（還有 ${total-paged.length} 筆）`; }
  else mb.style.display='none';
}

async function handleDelRecord(id) {
  setSyncStatus('busy');
  try { await deleteRecord(id); renderHistory(); renderUnfilledFloat(); setSyncStatus('ok'); showToast('紀錄已刪除'); }
  catch(err) { setSyncStatus('err'); showToast('刪除失敗：'+err.message,'error'); }
}

// ── 保險追蹤 ─────────────────────────────────────────────────
function renderIns() {
  const urgent=S.insurance.filter(i=>{ const d=daysLeft(i.expiry); return d>0&&d<=i.alertDays; });
  const expired=S.insurance.filter(i=>daysLeft(i.expiry)<=0);
  let h='';
  expired.forEach(i=>{ h+=`<div class="alert-item danger"><i class="ti ti-alert-circle"></i><span class="a-text">${i.name}（${i.vendor}）</span><span class="a-days">已到期</span></div>`; });
  urgent.forEach(i=>{  h+=`<div class="alert-item warning"><i class="ti ti-bell"></i><span class="a-text">${i.name}</span><span class="a-days">剩 ${daysLeft(i.expiry)} 天</span></div>`; });
  document.getElementById('ins-alerts').innerHTML=h;
  const sorted=[...S.insurance].sort((a,b)=>a.expiry.localeCompare(b.expiry));
  document.getElementById('ins-tbody').innerHTML=sorted.map(i=>{
    const d=daysLeft(i.expiry); let pc='ok',lb=`${d} 天`;
    if(d<=0){pc='danger';lb='已到期';}else if(d<=i.alertDays)pc='danger';else if(d<=i.alertDays*2)pc='warning';
    return `<tr><td style="font-weight:600">${i.name}</td><td style="color:var(--text-2)">${i.vendor}</td><td>${i.expiry}</td><td><span class="pill ${pc}">${lb}</span></td><td style="color:var(--text-2);font-size:12px">${i.note||'—'}</td><td><button class="icon-btn del" data-delins="${i.id}"><i class="ti ti-trash"></i></button></td></tr>`;
  }).join('');
}

async function addIns() {
  const name=document.getElementById('ins-name').value.trim(); const vendor=document.getElementById('ins-vendor').value.trim();
  const expiry=document.getElementById('ins-expiry').value; const alertDays=parseInt(document.getElementById('ins-days').value)||30;
  const note=document.getElementById('ins-note').value.trim();
  if (!name||!expiry) { showToast('請填寫保險名稱與到期日','error'); return; }
  const btn=document.getElementById('btn-add-ins'); btn.disabled=true; setSyncStatus('busy');
  try {
    await insertInsurance({name,vendor,expiry,alertDays,note});
    ['ins-name','ins-vendor','ins-expiry','ins-note'].forEach(id=>document.getElementById(id).value='');
    renderIns(); setSyncStatus('ok'); showToast('保險已新增');
  } catch(err) { setSyncStatus('err'); showToast('新增失敗：'+err.message,'error'); }
  finally { btn.disabled=false; }
}

async function handleDelIns(id) {
  setSyncStatus('busy');
  try { await deleteInsurance(id); renderIns(); setSyncStatus('ok'); showToast('保險已刪除'); }
  catch(err) { setSyncStatus('err'); showToast('刪除失敗：'+err.message,'error'); }
}

// ── 廠區管理 ─────────────────────────────────────────────────
function renderSites() {
  const g=groupByLocation(S.sites); const locs=Object.keys(g).sort();
  document.getElementById('sites-tbody').innerHTML=locs.map(loc=>{
    const rows=g[loc].map(s=>{ const c=S.records.filter(r=>r.siteId===s.id).length; const type=getType(s.name);
      return `<tr><td style="padding-left:2rem;color:var(--text-2)">${s.name}</td><td><span class="type-badge ${type}">${type==='water'?'水':'電'}</span></td><td><span class="pill ${s.cycle===1?'monthly':'bimonthly'}">${s.cycle===1?'每月':'雙月'}</span></td><td>${c}</td><td><button class="icon-btn del" data-delsite="${s.id}"><i class="ti ti-trash"></i></button></td></tr>`; }).join('');
    return `<tr class="loc-group-row"><td colspan="5"><i class="ti ti-building"></i> ${loc}</td></tr>${rows}`;
  }).join('');
}

async function addSite() {
  const type=document.getElementById('new-site-type').value; const loc=document.getElementById('new-site-loc').value.trim();
  const label=document.getElementById('new-site-label').value.trim(); const cycle=parseInt(document.getElementById('new-site-cycle').value);
  if (!loc) { showToast('請輸入廠區名稱','error'); return; }
  const name=label?`${type==='water'?'【水】':'【電】'}${loc} ${label}`:`${type==='water'?'【水】':'【電】'}${loc}`;
  if (S.sites.find(s=>s.name===name)) { showToast('此計費項目已存在','error'); return; }
  const btn=document.getElementById('btn-add-site'); btn.disabled=true; setSyncStatus('busy');
  try {
    await insertSite(name, cycle);
    ['new-site-loc','new-site-label'].forEach(id=>document.getElementById(id).value='');
    renderSites(); syncSelects(); setSyncStatus('ok'); showToast(`${name} 已新增`);
  } catch(err) { setSyncStatus('err'); showToast('新增失敗：'+err.message,'error'); }
  finally { btn.disabled=false; }
}

async function handleDelSite(id) {
  const c=S.records.filter(r=>r.siteId===id).length;
  if (c>0&&!confirm(`此項目有 ${c} 筆紀錄，刪除後無法復原，確定？`)) return;
  setSyncStatus('busy');
  try { await deleteSite(id); renderSites(); syncSelects(); setSyncStatus('ok'); showToast('已刪除'); }
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
  const type=document.getElementById('import-type').value;
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
      if(!confirm('確定要覆蓋現有資料庫的所有資料嗎？')) return;
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

// ── 事件代理 ─────────────────────────────────────────────────
document.addEventListener('click', e => {
  const nb=e.target.closest('.nav-btn');       if(nb)  { goTab(nb.dataset.tab); return; }
  if(e.target.closest('#input-type-water'))            { setInputMode('water'); return; }
  if(e.target.closest('#input-type-elec'))             { setInputMode('elec');  return; }
  if(e.target.closest('#btn-add-record'))              { addRecord();  return; }
  if(e.target.closest('#btn-add-ins'))                 { addIns();     return; }
  if(e.target.closest('#btn-add-site'))                { addSite();    return; }
  if(e.target.closest('#btn-export-json'))             { exportJSON(); return; }
  if(e.target.closest('#hist-more-btn'))               { histPage++; renderHistory(); return; }
  const tpl=e.target.closest('[data-tpl]');    if(tpl) { dlTemplate(tpl.dataset.tpl); return; }
  const exp=e.target.closest('[data-export]'); if(exp) { exportExcel(exp.dataset.export); return; }
  const dr=e.target.closest('[data-delrec]');  if(dr)  { handleDelRecord(dr.dataset.delrec);  return; }
  const di=e.target.closest('[data-delins]');  if(di)  { handleDelIns(di.dataset.delins);    return; }
  const ds=e.target.closest('[data-delsite]'); if(ds)  { handleDelSite(ds.dataset.delsite);  return; }
});

document.getElementById('site-filter')?.addEventListener('change', renderDash);
document.getElementById('hist-filter')?.addEventListener('change', ()=>{ histPage=1; renderHistory(); });
document.getElementById('hist-search')?.addEventListener('input',  ()=>{ histPage=1; renderHistory(); });
document.getElementById('file-input')?.addEventListener('change',  function(){ handleFileImport(this); });
document.getElementById('json-input')?.addEventListener('change',  function(){ handleJSONImport(this); });

// ── 初始化 ────────────────────────────────────────────────────
const _n=new Date(); const _p=document.getElementById('in-period');
if(_p) _p.value=`${_n.getFullYear()}-${String(_n.getMonth()+1).padStart(2,'0')}`;
setInputMode('water'); loadAll();
