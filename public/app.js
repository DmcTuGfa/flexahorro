
/* Finanzas Dashboard PWA (base)
 * - Dark theme: #171718 / #1f2124 / #393d42
 * - Drive Sync (OAuth token + download/upload by fileId)
 * - Captura rápida con presets +100/-100 etc.
 */

const LS_KEY = "finanzas_local_cache_v1";
const LS_DRIVE = "finanzas_drive_settings_v1";

let tokenClient = null;
let accessToken = null;
let isConnected = false;

function nowIso(){
  return new Date().toISOString();
}
function fmtMXN(n){
  const v = Number(n || 0);
  return v.toLocaleString('es-MX', {style:'currency', currency:(window.APP_CONFIG?.CURRENCY || 'MXN')});
}
function parseNum(v){
  if (v === null || v === undefined) return 0;
  const s = String(v).replace(/,/g,'').trim();
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}
function clamp0(n){ return Math.max(0, n); }

function loadLocal(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  }catch(e){ return null; }
}
function saveLocal(data){
  localStorage.setItem(LS_KEY, JSON.stringify(data));
}
function loadDriveSettings(){
  try{
    const raw = localStorage.getItem(LS_DRIVE);
    return raw ? JSON.parse(raw) : {};
  }catch(e){ return {}; }
}
function saveDriveSettings(s){
  localStorage.setItem(LS_DRIVE, JSON.stringify(s));
}

function ensureSkeleton(){
  // If no local data, create minimal skeleton (compatible with your JSON)
  const sk = {
    meta: {
      version: "1.0.0",
      currency: window.APP_CONFIG?.CURRENCY || "MXN",
      timezone: window.APP_CONFIG?.TIMEZONE || "America/Mexico_City",
      created_at: nowIso(),
      updated_at: nowIso(),
      device_id: "device"
    },
    settings: { week_starts_on:"MON", weekly_summary_day:"SUN", monthly_close_day:"LAST_DAY", dark_mode:true },
    plan: {
      income: { weekly_income_amount: 2870.44, notes:"Ingreso semanal" },
      savings_plan: { monthly_total:6000, monthly_rigid:5000, monthly_flexible:1000, flexible_rules:"Fondo flexible mensual" },
      fixed_costs: { rent_monthly:2300, travel_daily:100, travel_no_spend_weekday:"SUN", shopping_monthly_cash:580 }
    },
    accounts: { investments:[], debts:[], receivables:[], vouchers:{monthly_average:900, balance_estimated:0, notes:"Vales"} },
    ledger: { days: [] },
    goals: {},
    alerts: { soft_alerts_enabled:true, rules:{} }
  };
  return sk;
}

async function driveDownload(fileId){
  if (!accessToken) throw new Error("Sin token");
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    { headers: { "Authorization": "Bearer " + accessToken } }
  );
  if (!res.ok) throw new Error("No pude descargar de Drive ("+res.status+")");
  const text = await res.text();
  const etag = res.headers.get("etag");
  return { text, etag };
}

async function driveUpload(fileId, jsonText){
  if (!accessToken) throw new Error("Sin token");
  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`,
    {
      method: "PATCH",
      headers: {
        "Authorization": "Bearer " + accessToken,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: jsonText
    }
  );
  if (!res.ok) throw new Error("No pude subir a Drive ("+res.status+")");
  const etag = res.headers.get("etag");
  return { etag };
}

// Merge by date with updated_at
function mergeByDate(local, remote){
  const out = structuredClone(remote); // remote as base (simple rule)
  const map = new Map();
  const daysR = (remote?.ledger?.days || []);
  for (const d of daysR) map.set(d.date, d);

  const daysL = (local?.ledger?.days || []);
  for (const d of daysL){
    const r = map.get(d.date);
    if (!r){
      map.set(d.date, d);
    } else {
      const lu = Date.parse(d.updated_at || "1970-01-01T00:00:00Z");
      const ru = Date.parse(r.updated_at || "1970-01-01T00:00:00Z");
      map.set(d.date, (lu >= ru) ? d : r);
    }
  }
  out.ledger = out.ledger || {};
  out.ledger.days = Array.from(map.values()).sort((a,b) => (a.date||"").localeCompare(b.date||""));

  // meta.updated_at
  const lu = Date.parse(local?.meta?.updated_at || "1970-01-01T00:00:00Z");
  const ru = Date.parse(remote?.meta?.updated_at || "1970-01-01T00:00:00Z");
  out.meta = out.meta || {};
  out.meta.updated_at = new Date(Math.max(lu, ru, Date.now())).toISOString();
  out.meta.currency = out.meta.currency || (window.APP_CONFIG?.CURRENCY || "MXN");
  out.meta.timezone = out.meta.timezone || (window.APP_CONFIG?.TIMEZONE || "America/Mexico_City");
  return out;
}

function monthKey(dateStr){
  return (dateStr || "").slice(0,7);
}
function getCurrentMonth(){
  const d = new Date();
  const m = String(d.getMonth()+1).padStart(2,'0');
  return `${d.getFullYear()}-${m}`;
}

function calcMonth(data, ym){
  const days = (data?.ledger?.days || []).filter(d => monthKey(d.date) === ym);
  const sum = (arr, fn) => arr.reduce((a,x)=>a+fn(x),0);

  const incomeCash = sum(days, d => parseNum(d?.income?.cash));
  const incomeVouchers = sum(days, d => parseNum(d?.income?.vouchers));

  const spendCash = sum(days, d => parseNum(d?.spend?.travel) + parseNum(d?.spend?.shopping_cash) + parseNum(d?.spend?.other));
  const spendVouchers = sum(days, d => parseNum(d?.spend?.shopping_vouchers));
  const flexUsed = sum(days, d => parseNum(d?.flex_fund_used));

  const rigid = parseNum(data?.plan?.savings_plan?.monthly_rigid) || 5000;
  const flexPlan = parseNum(data?.plan?.savings_plan?.monthly_flexible) || 1000;
  const flexRemaining = clamp0(flexPlan - flexUsed);
  const ahorroReal = rigid + flexRemaining;

  const cashNet = incomeCash - spendCash - (rigid + flexPlan); // plan based
  const vouchersNet = incomeVouchers - spendVouchers;

  const inv = data?.accounts?.investments || [];
  const invTotal = inv.reduce((a,f)=>a+parseNum(f.principal),0);
  const rendAnual = inv.reduce((a,f)=>a+parseNum(f.principal)*parseNum(f.annual_rate),0);

  const debts = data?.accounts?.debts || [];
  const debtTotal = debts.reduce((a,d)=>a+parseNum(d.balance),0);

  const rcv = data?.accounts?.receivables || [];
  const rcvTotal = rcv.filter(x => (x.status||"pending") !== "paid").reduce((a,x)=>a+parseNum(x.amount),0);

  return {
    ym, incomeCash, incomeVouchers, spendCash, spendVouchers, flexUsed,
    rigid, flexPlan, flexRemaining, ahorroReal, cashNet, vouchersNet,
    invTotal, rendAnual, debtTotal, rcvTotal
  };
}

function softAlerts(data, m){
  const chips = [];
  if (m.flexUsed > 0) chips.push({t:"Fondo flexible usado", level:"warn"});

  const days = (data?.ledger?.days || []);
  if (days.length){
    const last = days.map(d=>d.date).sort().slice(-1)[0];
    const lastD = new Date(last+"T00:00:00");
    const diff = Math.floor((Date.now() - lastD.getTime()) / (1000*60*60*24));
    if (diff >= 3) chips.push({t:`${diff} días sin actualizar`, level:"warn"});
  }
  return chips;
}

function goalSummary(data, m){
  const gs = data?.goals || {};
  const invTotal = m.invTotal;
  const goal = gs?.savings_total_target;
  if (goal && goal.enabled){
    const target = parseNum(goal.target_amount);
    const pct = target>0 ? Math.min(1, invTotal/target) : 0;
    const falta = target - invTotal;
    return `Meta ahorro: ${Math.round(pct*100)}% — faltan ${fmtMXN(Math.max(0,falta))}`;
  }
  return "Metas: (configura en finanzas.json si quieres)";
}

function setSyncBadge(state, subtitle){
  const badge = document.getElementById("syncBadge");
  const dot = badge.querySelector(".dot");
  const txt = document.getElementById("syncText");
  const sub = document.getElementById("syncSub");
  sub.textContent = subtitle || "";
  dot.classList.remove("ok","warn","bad");
  if (state === "ok"){ dot.classList.add("ok"); txt.textContent="Sincronizado";}
  else if (state === "bad"){ dot.classList.add("bad"); txt.textContent="Error";}
  else { dot.classList.add("warn"); txt.textContent="Pendiente";}
}

function renderDashboard(data){
  const ym = getCurrentMonth();
  const m = calcMonth(data, ym);

  document.getElementById("appTitle").textContent = `Finanzas — ${ym}`;
  const kpi = [
    {title:"Ingresos (efectivo)", val: fmtMXN(m.incomeCash), sub:`Vales: ${fmtMXN(m.incomeVouchers)}`},
    {title:"Gastos (efectivo)", val: fmtMXN(m.spendCash), sub:`Vales: ${fmtMXN(m.spendVouchers)}`},
    {title:"Ahorro real", val: fmtMXN(m.ahorroReal), sub:`Rígido ${fmtMXN(m.rigid)} · Flex restante ${fmtMXN(m.flexRemaining)}`},
    {title:"Deudas MSI", val: fmtMXN(m.debtTotal), sub:"Fin: Dic"},
    {title:"Por cobrar", val: fmtMXN(m.rcvTotal), sub:"Pendiente"},
    {title:"Neto (efectivo)", val: fmtMXN(m.cashNet), sub:`Neto vales: ${fmtMXN(m.vouchersNet)}`}
  ];
  const grid = document.getElementById("kpiGrid");
  grid.innerHTML = "";
  for (const c of kpi){
    const div = document.createElement("div");
    div.className = "card";
    div.innerHTML = `<div class="kpi-title">${c.title}</div>
                     <div class="kpi-value">${c.val}</div>
                     <div class="kpi-sub">${c.sub}</div>`;
    grid.appendChild(div);
  }

  const legend = [
    {name:"Gastos efectivo", val: m.spendCash},
    {name:"Gastos vales", val: m.spendVouchers},
    {name:"Ahorro rígido", val: m.rigid},
    {name:"Flex no usado", val: m.flexRemaining}
  ];
  const donutLegend = document.getElementById("donutLegend");
  donutLegend.innerHTML = "";
  for (const it of legend){
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `<span class="dot ok" style="background:#393d42"></span>${it.name}: <b>${fmtMXN(it.val)}</b>`;
    donutLegend.appendChild(chip);
  }

  const alerts = softAlerts(data, m);
  const alertsBox = document.getElementById("alertsBox");
  alertsBox.innerHTML = "";
  if (!alerts.length){
    const c = document.createElement("span"); c.className="chip";
    c.innerHTML = `<span class="dot ok"></span>Sin alertas`;
    alertsBox.appendChild(c);
  } else {
    for (const a of alerts){
      const c = document.createElement("span");
      c.className="chip";
      c.innerHTML = `<span class="dot ${a.level}"></span>${a.t}`;
      alertsBox.appendChild(c);
    }
  }
  document.getElementById("goalsBox").textContent = goalSummary(data, m);

  document.getElementById("accountsDump").textContent = JSON.stringify(data.accounts, null, 2);
  const ds = loadDriveSettings();
  const last = ds.lastSyncAt ? new Date(ds.lastSyncAt).toLocaleString('es-MX') : "—";
  document.getElementById("syncSub").textContent = isConnected ? `Última sync: ${last}` : "Sin conectar";
}

function showTab(name){
  const tabs = document.querySelectorAll(".tab");
  tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  document.getElementById("view-dashboard").style.display = (name==="dashboard") ? "" : "none";
  document.getElementById("view-captura").style.display = (name==="captura") ? "" : "none";
  document.getElementById("view-cuentas").style.display = (name==="cuentas") ? "" : "none";
  document.getElementById("view-ajustes").style.display = (name==="ajustes") ? "" : "none";
}

function getOrCreateDay(data, dateStr){
  data.ledger = data.ledger || {days:[]};
  data.ledger.days = data.ledger.days || [];
  let day = data.ledger.days.find(d => d.date === dateStr);
  if (!day){
    day = {
      date: dateStr,
      updated_at: nowIso(),
      income: { cash:0, vouchers:0 },
      spend: { travel:0, shopping_cash:0, shopping_vouchers:0, other:0 },
      flex_fund_used: 0,
      debt_payments: [],
      notes: ""
    };
    data.ledger.days.push(day);
  }
  return day;
}

function fillCaptureFromDay(day){
  document.getElementById("incomeCash").value = (day?.income?.cash ?? 0);
  document.getElementById("incomeVouchers").value = (day?.income?.vouchers ?? 0);
  document.getElementById("spendTravel").value = (day?.spend?.travel ?? 0);
  document.getElementById("spendOther").value = (day?.spend?.other ?? 0);
  document.getElementById("spendShopCash").value = (day?.spend?.shopping_cash ?? 0);
  document.getElementById("spendShopVouchers").value = (day?.spend?.shopping_vouchers ?? 0);
  document.getElementById("flexUsed").value = (day?.flex_fund_used ?? 0);
  document.getElementById("notesInput").value = (day?.notes ?? "");
  updateLiveSummary();
  updateFlexRemaining();
}

function updateLiveSummary(){
  const cashIn = parseNum(document.getElementById("incomeCash").value);
  const vIn = parseNum(document.getElementById("incomeVouchers").value);
  const travel = parseNum(document.getElementById("spendTravel").value);
  const other = parseNum(document.getElementById("spendOther").value);
  const sc = parseNum(document.getElementById("spendShopCash").value);
  const sv = parseNum(document.getElementById("spendShopVouchers").value);
  const flex = parseNum(document.getElementById("flexUsed").value);

  const spendCash = travel + other + sc;
  const netCash = cashIn - spendCash;
  const netV = vIn - sv;
  const total = spendCash + sv + flex;

  document.getElementById("netCash").textContent = fmtMXN(netCash);
  document.getElementById("netVouchers").textContent = fmtMXN(netV);
  document.getElementById("totalSpend").textContent = fmtMXN(total);
}

function updateFlexRemaining(){
  const data = loadLocal() || ensureSkeleton();
  const ym = getCurrentMonth();
  const days = (data?.ledger?.days || []).filter(d => monthKey(d.date) === ym);
  const flexUsedMonth = days.reduce((a,d)=>a+parseNum(d.flex_fund_used),0);

  const flexToday = parseNum(document.getElementById("flexUsed").value);
  const dateStr = document.getElementById("dateInput").value;
  const todayStored = days.find(d => d.date === dateStr);
  const storedFlex = todayStored ? parseNum(todayStored.flex_fund_used) : 0;
  const flexUsedAdj = flexUsedMonth - storedFlex + flexToday;

  const flexPlan = parseNum(data?.plan?.savings_plan?.monthly_flexible) || 1000;
  const remaining = flexPlan - flexUsedAdj;
  document.getElementById("flexRemaining").textContent =
    remaining >= 0 ? `Flexible restante este mes: ${fmtMXN(remaining)}` : `Te pasaste del flexible por ${fmtMXN(Math.abs(remaining))}`;
}

async function syncNow(){
  const ds = loadDriveSettings();
  const fileId = ds.fileId || window.APP_CONFIG.FILE_ID;
  if (!fileId) throw new Error("FILE_ID vacío");
  if (!accessToken) throw new Error("Conecta Drive primero");

  setSyncBadge("warn", "Sincronizando…");

  let local = loadLocal();
  if (!local) local = ensureSkeleton();

  const { text } = await driveDownload(fileId);
  let remote = null;
  try{ remote = JSON.parse(text); } catch(e){ throw new Error("El archivo de Drive no es JSON válido"); }

  const merged = mergeByDate(local, remote);

  saveLocal(merged);
  merged.meta.updated_at = nowIso();
  const jsonText = JSON.stringify(merged, null, 2);
  await driveUpload(fileId, jsonText);

  ds.lastSyncAt = nowIso();
  ds.fileId = fileId;
  saveDriveSettings(ds);

  setSyncBadge("ok", "Sincronizado");
  renderDashboard(merged);
}

function initGoogle(){
  if (!window.APP_CONFIG?.CLIENT_ID || window.APP_CONFIG.CLIENT_ID.includes("PEGA_AQUI")){
    setSyncBadge("warn", "Falta CLIENT_ID en config.js");
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: window.APP_CONFIG.CLIENT_ID,

    // ✅ CAMBIO IMPORTANTE:
    // drive.file NO puede leer tu archivo existente por fileId.
    // drive SÍ permite leer/escribir tu finanzas.json existente.
    scope: "https://www.googleapis.com/auth/drive",

    callback: (resp) => {
      if (resp && resp.access_token){
        accessToken = resp.access_token;
        isConnected = true;
        setSyncBadge("warn", "Conectado — listo para sincronizar");
      }
    }
  });
}

function connectDrive(){
  if (!tokenClient){
    initGoogle();
  }
  if (!tokenClient){
    alert("Falta CLIENT_ID en config.js");
    return;
  }
  tokenClient.requestAccessToken({ prompt: "consent" });
}

function bindUI(){
  document.querySelectorAll(".tab").forEach(t => {
    t.addEventListener("click", () => showTab(t.dataset.tab));
  });

  document.getElementById("btnConnect").addEventListener("click", connectDrive);
  document.getElementById("btnSync").addEventListener("click", async () => {
    try{ await syncNow(); } catch(e){ setSyncBadge("bad", e.message); alert(e.message); }
  });

  const ds = loadDriveSettings();
  document.getElementById("fileIdInput").value = ds.fileId || window.APP_CONFIG.FILE_ID || "";
  document.getElementById("btnSaveConfig").addEventListener("click", () => {
    const v = document.getElementById("fileIdInput").value.trim();
    const ds2 = loadDriveSettings();
    ds2.fileId = v;
    saveDriveSettings(ds2);
    alert("FILE_ID guardado en este dispositivo.");
  });

  const d = new Date();
  const iso = d.toISOString().slice(0,10);
  document.getElementById("dateInput").value = iso;

  let data = loadLocal();
  if (!data){
    data = ensureSkeleton();
    saveLocal(data);
  }
  renderDashboard(data);

  const day = getOrCreateDay(data, iso);
  fillCaptureFromDay(day);

  ["incomeCash","incomeVouchers","spendTravel","spendOther","spendShopCash","spendShopVouchers","flexUsed"].forEach(id=>{
    document.getElementById(id).addEventListener("input", ()=>{
      updateLiveSummary();
      updateFlexRemaining();
    });
  });

  document.querySelectorAll(".pbtn").forEach(b=>{
    b.addEventListener("click", ()=>{
      const inc = b.dataset.inc;
      const amt = parseNum(b.dataset.amt);
      const map = {
        travel: "spendTravel",
        other: "spendOther",
        cash: "spendShopCash",
        vouchers: "spendShopVouchers",
        flex: "flexUsed"
      };
      const id = map[inc];
      if (!id) return;
      const el = document.getElementById(id);
      const cur = parseNum(el.value);
      el.value = clamp0(cur + amt);
      updateLiveSummary();
      updateFlexRemaining();
    });
  });

  document.getElementById("btnSaveDay").addEventListener("click", ()=>{
    const data = loadLocal() || ensureSkeleton();
    const dateStr = document.getElementById("dateInput").value;
    const day = getOrCreateDay(data, dateStr);

    day.income.cash = parseNum(document.getElementById("incomeCash").value);
    day.income.vouchers = parseNum(document.getElementById("incomeVouchers").value);
    day.spend.travel = parseNum(document.getElementById("spendTravel").value);
    day.spend.other = parseNum(document.getElementById("spendOther").value);
    day.spend.shopping_cash = parseNum(document.getElementById("spendShopCash").value);
    day.spend.shopping_vouchers = parseNum(document.getElementById("spendShopVouchers").value);
    day.flex_fund_used = parseNum(document.getElementById("flexUsed").value);
    day.notes = String(document.getElementById("notesInput").value || "");

    day.updated_at = nowIso();
    data.meta.updated_at = nowIso();

    saveLocal(data);
    setSyncBadge("warn", "Guardado local — pendiente de sync");
    renderDashboard(data);
    alert("Guardado.");
  });

  document.getElementById("btnDeleteDay").addEventListener("click", ()=>{
    const dateStr = document.getElementById("dateInput").value;
    if (!confirm("¿Borrar este día? Esto afectará reportes.")) return;
    const data = loadLocal() || ensureSkeleton();
    data.ledger.days = (data.ledger.days || []).filter(d => d.date !== dateStr);
    data.meta.updated_at = nowIso();
    saveLocal(data);
    setSyncBadge("warn", "Borrado local — pendiente de sync");
    renderDashboard(data);
    alert("Día borrado.");
  });
}

window.addEventListener("load", ()=>{
  initGoogle();
  bindUI();
});
