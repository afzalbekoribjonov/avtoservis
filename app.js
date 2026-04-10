// ================================================================
// MOYTRACK PRO v4.4  —  app.js
// Backend-markazli saqlash: cars · oils · sms_config · sms_logs · sms_queue
// ================================================================

// ── BACKEND API URL ──────────────────────────────────────────────
// Avtomatik aniqlash: agar localhost bo'lsa — 3001 port,
// aks holda — joriy sayt manzili (production deploy uchun).
const BACKEND_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? `http://${location.hostname}:3001`
  : `${location.protocol}//${location.host}`;

const API_DEFAULT_OPTIONS = { credentials: 'same-origin' };
let isAuthenticated = false;
let scheduledSmsItems = [];
let bootstrapLoading = false;
let activeMutations = 0;
let autoRefreshTimer = null;
let smsLogsLoading = false;
let smsLogRequestSeq = 0;
const AUTO_REFRESH_MS = 15000;

async function apiFetch(url, options = {}) {
  const finalOptions = { ...API_DEFAULT_OPTIONS, ...options, headers: { ...(options.headers || {}) } };
  const res = await fetch(url, finalOptions);
  if (res.status === 401) {
    lockApp();
    throw new Error('PIN talab qilinadi');
  }
  return res;
}
async function apiJson(url, options = {}) {
  const res = await apiFetch(url, options);
  return res.json().catch(() => ({}));
}
async function apiOk(url, options = {}) {
  const data = await apiJson(url, options);
  if (!data.ok) throw new Error(data.error || 'Amal bajarilmadi');
  return data;
}
function busyStart() { activeMutations += 1; }
function busyEnd() { activeMutations = Math.max(0, activeMutations - 1); }
function isBusy() { return activeMutations > 0; }
function loadingHtml(text = 'Yuklanmoqda...') {
  return `<div class="sms-log-empty">${text}</div>`;
}
function renderLoadingState() {
  if (!bootstrapLoading) return;
  const urgent = document.getElementById('urgent-list');
  const all = document.getElementById('all-cars-list');
  const grid = document.getElementById('cars-grid');
  const oils = document.getElementById('oils-list');
  const logs = document.getElementById('sms-log-list');
  const sched = document.getElementById('scheduled-sms-list');
  if (urgent) urgent.innerHTML = loadingHtml("Ma'lumotlar yangilanmoqda...");
  if (all) all.innerHTML = loadingHtml("Ro'yxat yangilanmoqda...");
  if (grid) grid.innerHTML = loadingHtml('Mashinalar yuklanmoqda...');
  if (oils) oils.innerHTML = loadingHtml('Moylar yuklanmoqda...');
  if (logs) logs.innerHTML = loadingHtml('Xabarlar tarixi yuklanmoqda...');
  if (sched) sched.innerHTML = loadingHtml('Rejalar yuklanmoqda...');
}
function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('998') && digits.length === 12) return digits;
  if (digits.length === 9) return '998' + digits;
  return digits;
}
function lockApp() {
  isAuthenticated = false;
  document.body.classList.add('app-locked');
  const overlay = document.getElementById('pin-overlay');
  if (overlay) overlay.classList.add('active');
}
function unlockApp() {
  isAuthenticated = true;
  document.body.classList.remove('app-locked');
  const overlay = document.getElementById('pin-overlay');
  if (overlay) overlay.classList.remove('active');
}
async function checkAuth() {
  try {
    const data = await apiJson(`${BACKEND_URL}/api/auth/me`);
    return !!data.ok;
  } catch { return false; }
}
async function doPinLogin() {
  const input = document.getElementById('pin-input');
  const status = document.getElementById('pin-status');
  const btn = document.getElementById('pin-submit');
  const pin = input?.value?.trim();
  if (!pin) {
    if (status) { status.textContent = 'PIN kiriting'; status.className = 'pin-status error'; }
    return;
  }
  btn.disabled = true;
  if (status) { status.textContent = 'Tekshirilmoqda...'; status.className = 'pin-status'; }
  try {
    const data = await apiJson(`${BACKEND_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    if (!data.ok) throw new Error(data.error || 'PIN xato');
    unlockApp();
    await loadFromBackend();
    if (status) { status.textContent = 'Muvaffaqiyatli'; status.className = 'pin-status success'; }
    input.value = '';
  } catch (e) {
    if (status) { status.textContent = e.message || 'PIN xato'; status.className = 'pin-status error'; }
    lockApp();
  } finally {
    btn.disabled = false;
  }
}
async function loadFromBackend(options = {}) {
  const silent = !!options.silent;
  const modalWasOpen = document.getElementById('car-modal')?.classList.contains('active');
  const activeModalTab = modalWasOpen ? getActiveModalTab() : 'info';
  try {
    if (!silent) {
      bootstrapLoading = true;
      renderLoadingState();
    }
    const data = await apiJson(`${BACKEND_URL}/api/bootstrap`);
    if (!data.ok) throw new Error(data.error || 'Yuklashda xato');
    allCars = Array.isArray(data.cars) ? data.cars : [];
    allOils = Array.isArray(data.oils) ? data.oils : allOils;
    smsConfig = { ...DEFAULT_SMS, ...smsConfig, ...(data.sms_config || {}) };
    cfg = { ...cfg, ...(data.cfg || {}) };
    scheduledSmsItems = Array.isArray(data.schedules) ? data.schedules : [];
    saveCars(); saveOils(); saveSms(); saveCfg();
    WPCT = cfg.warn_pct / 100;
    DPCT = cfg.danger_pct / 100;
    if (curCar) {
      curCar = allCars.find(c => String(c.id) === String(curCar.id)) || null;
      if (!curCar) {
        document.getElementById('car-modal')?.classList.remove('active');
      }
    }
    loadDashboard();
    loadCarsGrid();
    loadOilsPage();
    renderOilSel('oil-name');
    renderSmsLog(Array.isArray(data.logs) ? data.logs : DB.get(SMS_LOG_KEY, []));
    refreshScheduleList();
    if (curCar && modalWasOpen) openModal({ tab: activeModalTab });
    if (document.getElementById('sms')?.classList.contains('active')) loadSmsPage();
  } finally {
    bootstrapLoading = false;
  }
}

// ===== UI CACHE (avtoritativ emas) =====
const DB = {
  get(k, d = []) { try { const v = sessionStorage.getItem('mt_' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v)      { try { sessionStorage.setItem('mt_' + k, JSON.stringify(v)); } catch(e) { console.warn(e); } },
  nextId(k)      { const id = this.get('_id_' + k, 0) + 1; this.set('_id_' + k, id); return id; }
};

// ===== DEFAULT SMS =====
const DEFAULT_SMS = {
  enabled: true,
  test_phone: '',
  sms_sent_count: 0,
  service_done_message: `Hurmatli mijoz,
{car_name} ({car_number}) avtomobili bo'yicha quyidagi ma'lumot qayd etildi: "{service_name}"
Sana: {date}
Joriy probeg: {km} km`,
  service_due_message: `Hurmatli mijoz, {car_name} ({car_number}) avtomobili bo'yicha {service_name} tavsiya etiladi.
Sana: {date}.
Joriy probeg: {km} km.
Manzil: Avto Oil Beshariq, mo'ljal: tekstil yonida`,
};

// ===== STATE =====
let allCars = []; // authoritative source: backend
let allOils = [
  { id: 1, name: 'SAE 5W-30',  interval: 10000 },
  { id: 2, name: 'SAE 5W-40',  interval: 7000  },
  { id: 3, name: 'SAE 10W-40', interval: 8000  }
];
let smsConfig = {
  devsms_token: '', enabled: false, sms_sent_count: 0,
  ...DEFAULT_SMS
};
let cfg  = { warn_pct: 80, danger_pct: 100, theme: 'dark' };
let WPCT = cfg.warn_pct   / 100;
let DPCT = cfg.danger_pct / 100;
let curCar = null;

const saveCars = () => DB.set('cars_cache', allCars);
const saveOils = () => DB.set('oils_cache', allOils);
const saveSms  = () => DB.set('sms_cache',  { has_token: smsConfig.has_token, enabled: smsConfig.enabled, sms_sent_count: smsConfig.sms_sent_count, test_phone: smsConfig.test_phone });
const saveCfg  = () => DB.set('cfg_cache',  cfg);

// ===== SERVICE META =====
const SVC_META = {
  oil: { icon: '🛢️', label: 'Moy' },
  antifreeze: { icon: '🧊', label: 'Antifriz' },
  gearbox: { icon: '⚙️', label: 'Karobka moyi' },
  air_filter: { icon: '💨', label: 'Havo filtri' },
  cabin_filter: { icon: '🌬️', label: 'Salon filtri' },
  oil_filter: { icon: '🔩', label: 'Moy filtri' },
};

// ===== THEME =====
function applyTheme() {
  const l = cfg.theme === 'light';
  document.body.classList.toggle('light', l);
  document.getElementById('theme-btn').textContent = l ? '🌙' : '☀️';
  const tog = document.getElementById('dark-mode-toggle'); if (tog) tog.checked = l;
  const lbl = document.getElementById('theme-label');       if (lbl) lbl.textContent = l ? '☀️ Kunduzgi rejim' : '🌙 Tungi rejim';
}
function toggleTheme(l) { cfg.theme = l ? 'light' : 'dark'; saveCfg(); applyTheme(); }
document.getElementById('theme-btn').addEventListener('click', () => {
  cfg.theme = cfg.theme === 'dark' ? 'light' : 'dark'; saveCfg(); applyTheme();
});

// ===== HELPERS =====
function oilInt(name) { const o = allOils.find(o => o.name === name); return o ? o.interval : 10000; }
function formatDueDate(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return '';
  return date.toLocaleDateString('uz-UZ', { year: 'numeric', month: '2-digit', day: '2-digit' });
}
function getServiceForecast(car, serviceKey = '') {
  const key = String(serviceKey || '').trim();
  const totalKm = Number(car?.total_km || 0);
  const dailyKm = Number(car?.daily_km || 0);
  const configs = {
    oil: { label: 'Dvigatel moyi', interval: oilInt(car?.oil_name), lastKm: Number(car?.oil_change_km || totalKm) },
    antifreeze: { label: 'Antifriz', interval: Number(car?.antifreeze_interval || 30000), lastKm: Number(car?.antifreeze_km || totalKm) },
    gearbox: { label: 'Karobka moyi', interval: Number(car?.gearbox_interval || 50000), lastKm: Number(car?.gearbox_km || totalKm) },
    air_filter: { label: 'Havo filtri', interval: Number(car?.air_filter_interval || 15000), lastKm: Number(car?.air_filter_km || totalKm) },
    cabin_filter: { label: 'Salon filtri', interval: Number(car?.cabin_filter_interval || 15000), lastKm: Number(car?.cabin_filter_km || totalKm) },
    oil_filter: { label: 'Moy filtri', interval: Number(car?.oil_filter_interval || 10000), lastKm: Number(car?.oil_filter_km || totalKm) },
  };
  const cfg = configs[key];
  if (!cfg) return { label: 'Xizmat', interval: 0, used: 0, remainingKm: 0, isDue: false, daysUntilDue: Number.POSITIVE_INFINITY, dueText: '—', shortText: '—' };
  const interval = Math.max(0, Number(cfg.interval || 0));
  const used = Math.max(0, totalKm - Number(cfg.lastKm || 0));
  const remainingKm = Math.max(0, interval - used);
  const isDue = interval > 0 && used >= interval;
  let dueDate = null;
  let daysUntilDue = Number.POSITIVE_INFINITY;
  if (!isDue && remainingKm > 0 && dailyKm > 0) {
    daysUntilDue = Math.max(0, Math.ceil(remainingKm / dailyKm));
    dueDate = new Date(car?.updated_at || car?.added_at || Date.now());
    dueDate.setDate(dueDate.getDate() + daysUntilDue);
  } else if (isDue) {
    daysUntilDue = 0;
  }
  const dueText = isDue
    ? 'Muddat kelgan'
    : dailyKm > 0 && dueDate
      ? `Taxminiy muddat: ${formatDueDate(dueDate)} (${daysUntilDue} kun)`
      : 'Taxminiy muddat hisoblanmadi';
  const shortText = isDue
    ? `${cfg.label}: muddat kelgan`
    : dailyKm > 0 && dueDate
      ? `${cfg.label}: ${formatDueDate(dueDate)}`
      : `${cfg.label}: noma'lum`;
  return { ...cfg, interval, used, remainingKm, isDue, daysUntilDue, dueDate, dueText, shortText };
}
function getNearestDueSummary(car) {
  const forecasts = ['oil', 'gearbox', 'antifreeze', 'air_filter', 'cabin_filter', 'oil_filter'].map((key) => getServiceForecast(car, key));
  const dueNow = forecasts.find((item) => item.isDue);
  if (dueNow) return dueNow.shortText;
  const nearest = forecasts
    .filter((item) => Number.isFinite(item.daysUntilDue) && item.daysUntilDue >= 0)
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue)[0];
  return nearest ? nearest.shortText : "Taxminiy muddat yo'q";
}

function carSt(car) {
  const oU  = (car.total_km - car.oil_change_km) / oilInt(car.oil_name);
  const aU  = (car.total_km - car.antifreeze_km) / (car.antifreeze_interval || 30000);
  const gU  = (car.total_km - car.gearbox_km)    / (car.gearbox_interval    || 50000);
  const afU = (car.total_km - (car.air_filter_km   || car.total_km)) / (car.air_filter_interval   || 15000);
  const cfU = (car.total_km - (car.cabin_filter_km || car.total_km)) / (car.cabin_filter_interval || 15000);
  const ofU = (car.total_km - (car.oil_filter_km   || car.total_km)) / (car.oil_filter_interval   || 10000);
  const m   = Math.max(oU, aU, gU, afU, cfU, ofU);
  if (m >= DPCT) return { cls: 'su', dot: 'dug' };
  if (m >= WPCT) return { cls: 'sw', dot: 'dwn' };
  return { cls: '', dot: 'dok' };
}

function svcE(u) { return u >= DPCT ? '🔴' : u >= WPCT ? '🟡' : '🟢'; }
function badgeOf(u) {
  if (u >= DPCT) return { t: '🔴 HOZIR!', c: 'bdn', b: 'd' };
  if (u >= WPCT) return { t: '🟡 Tez!',   c: 'bwn', b: 'w' };
  return { t: '🟢 Yaxshi', c: 'bok', b: '' };
}
function nowDate() { return new Date().toLocaleDateString('uz-UZ', { year: 'numeric', month: '2-digit', day: '2-digit' }); }
function nowTime() { return new Date().toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' }); }

// ===== BACKEND — YUKLASH =====
// Barcha ma'lumotlarni backend orqali yuklaydi.
async function loadFromDatabase() {
  try {
    await loadFromBackend();
  } catch (e) {
    console.warn('Backend bootstrap xatosi:', e.message);
  }
}
async function reloadDataAfterChange(successMessage = '') {
  await loadFromBackend();
  if (successMessage) showToast(successMessage, 'success');
}
function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    if (!isAuthenticated || isBusy() || bootstrapLoading || document.hidden) return;
    loadFromBackend({ silent: true }).catch((e) => console.warn('Auto refresh xato:', e.message));
  }, AUTO_REFRESH_MS);
}

// ===== BACKEND — SAQLASH =====

async function fbCreateCar(car) {
  if (!isAuthenticated) throw new Error('Kirish talab qilinadi');
  return apiOk(`${BACKEND_URL}/api/cars`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(car) });
}

async function fbSaveCar(car) {
  if (!isAuthenticated) throw new Error('Kirish talab qilinadi');
  if (car?.id == null) return fbCreateCar(car);
  return apiOk(`${BACKEND_URL}/api/cars/${car.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(car) });
}

async function fbDeleteCar(carId) {
  if (!isAuthenticated) throw new Error('Kirish talab qilinadi');
  return apiOk(`${BACKEND_URL}/api/cars/${carId}`, { method: 'DELETE' });
}

async function fbSaveServiceLog(car, type, km) {
  return;
}

// ── OILS backendga saqlash ──
async function fbSaveOil(oil) {
  if (!isAuthenticated) throw new Error('Kirish talab qilinadi');
  return apiOk(`${BACKEND_URL}/api/oils`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(oil) });
}

async function fbDeleteOil(oilId) {
  if (!isAuthenticated) throw new Error('Kirish talab qilinadi');
  return apiOk(`${BACKEND_URL}/api/oils/${oilId}`, { method: 'DELETE' });
}

// ── SMS CONFIG backendga saqlash ──
async function fbSaveSmsConfig() {
  if (!isAuthenticated) return;
  const data = {
    enabled: smsConfig.enabled || false,
    test_phone: smsConfig.test_phone || '',
    service_done_message: smsConfig.service_done_message || DEFAULT_SMS.service_done_message,
    service_due_message: smsConfig.service_due_message || DEFAULT_SMS.service_due_message,
  };
  try {
    const res = await apiJson(`${BACKEND_URL}/api/sms-config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (res.ok && res.config) {
      smsConfig = { ...smsConfig, ...res.config };
      saveSms();
      const note = document.getElementById('saved-token-note');
      if (note) note.textContent = smsConfig.has_token ? 'Xabar xizmati tayyor' : 'Xabar xizmati tayyor emas';
    }
  } catch (e) { console.warn('sms config xato:', e.message); }
}

// ── STORAGE TEST ──
async function testDatabase() {
  const btn = document.getElementById('btn-test-database');
  const res = document.getElementById('database-test-result');
  btn.disabled = true;
  res.style.display = 'block';
  res.className = 'supa-result loading';
  res.innerHTML = '⏳ Tekshirilmoqda...';
  try {
    const result = await apiJson(`${BACKEND_URL}/api/storage/ping`);
    res.className = 'supa-result ok';
    res.innerHTML = `✅ Baza bilan aloqa yaxshi. Javob: ${result.ping_ms || 0} ms`;
  } catch (e) {
    res.className = 'supa-result fail';
    res.innerHTML = `❌ Tekshiruvda xato: ${e.message}`;
  } finally {
    btn.disabled = false;
    setTimeout(() => { res.style.display = 'none'; }, 5000);
  }
}

// Barcha joriy ma'lumotlarni backendga yuborish
async function syncAllToDatabase() {
  for (const car of allCars) await fbSaveCar(car);
  for (const oil of allOils) await fbSaveOil(oil);
  await fbSaveSmsConfig();
}

// ===== NAVIGATION =====
function navigateTo(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(page).classList.add('active');
  document.querySelectorAll('.nb').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  if      (page === 'home')    loadDashboard();
  else if (page === 'cars')    { loadCarsGrid(); document.getElementById('car-search').value = ''; }
  else if (page === 'add-car') resetAddCarForm();
  else if (page === 'oils')    loadOilsPage();
  else if (page === 'sms')     loadSmsPage();
}
document.querySelectorAll('.nb').forEach(b => b.addEventListener('click', () => navigateTo(b.dataset.page)));

// ===== DASHBOARD =====
function loadDashboard() {
  if (bootstrapLoading && !allCars.length) {
    const uel = document.getElementById('urgent-list');
    const ael = document.getElementById('all-cars-list');
    if (uel) uel.innerHTML = loadingHtml('Yaqin xizmatlar yuklanmoqda...');
    if (ael) ael.innerHTML = loadingHtml("Mashinalar ro'yxati yuklanmoqda...");
    return;
  }
  let u = 0, w = 0, g = 0, uc = [], wc = [];
  allCars.forEach(car => {
    const s = carSt(car);
    if      (s.cls === 'su') { u++; uc.push(car); }
    else if (s.cls === 'sw') { w++; wc.push(car); }
    else g++;
  });
  document.getElementById('total-stat').textContent   = allCars.length;
  document.getElementById('urgent-stat').textContent  = u;
  document.getElementById('warning-stat').textContent = w;
  document.getElementById('good-stat').textContent    = g;

  const uel = document.getElementById('urgent-list');
  uel.innerHTML = [...uc,...wc].length
    ? [...uc,...wc].map(ciHTML).join('')
    : '<div class="empty"><div class="ei">🎉</div><p>Hammasi yaxshi!</p></div>';
  addCIE(uel);

  const ael = document.getElementById('all-cars-list');
  ael.innerHTML = allCars.length
    ? allCars.map(ciHTML).join('')
    : '<div class="empty"><div class="ei">🚗</div><p>Hali mashina qo\'shilmagan</p></div>';
  addCIE(ael);
}

function ciHTML(car) {
  const s  = carSt(car), oi = oilInt(car.oil_name);
  const oU  = (car.total_km - car.oil_change_km) / oi;
  const aU  = (car.total_km - car.antifreeze_km) / (car.antifreeze_interval || 30000);
  const gU  = (car.total_km - car.gearbox_km)    / (car.gearbox_interval    || 50000);
  const afU = (car.total_km - (car.air_filter_km   || car.total_km)) / (car.air_filter_interval   || 15000);
  const cfU = (car.total_km - (car.cabin_filter_km || car.total_km)) / (car.cabin_filter_interval || 15000);
  const ofU = (car.total_km - (car.oil_filter_km   || car.total_km)) / (car.oil_filter_interval   || 10000);
  const dueSummary = getNearestDueSummary(car);
  return `<div class="ci ${s.cls}" data-id="${car.id}">
    <div class="cav">🚗</div>
    <div class="cinfo">
      <div class="cname">${car.car_name}</div>
      <div class="cmeta">${car.car_number} · ${car.total_km.toLocaleString()} km</div>
      <div class="cdue">📅 ${escHtml(dueSummary)}</div>
      <div class="cbadges">${svcE(oU)}${svcE(aU)}${svcE(gU)}${svcE(afU)}${svcE(cfU)}${svcE(ofU)}</div>
    </div>
  </div>`;
}

function addCIE(el) {
  el.querySelectorAll('.ci').forEach(e => {
    e.addEventListener('click', () => {
      curCar = allCars.find(c => String(c.id) === String(e.dataset.id));
      if (curCar) openModal();
    });
  });
}

// ===== CARS GRID =====
function loadCarsGrid(q = '') {
  if (bootstrapLoading && !allCars.length) {
    const grid = document.getElementById('cars-grid');
    if (grid) grid.innerHTML = loadingHtml('Mashinalar yuklanmoqda...');
    return;
  }
  const grid = document.getElementById('cars-grid');
  const f = q ? allCars.filter(c => c.car_number.toLowerCase().includes(q) || c.car_name.toLowerCase().includes(q)) : allCars;
  if (!f.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="ei">${allCars.length ? '🔍' : '🚗'}</div><p>${allCars.length ? 'Topilmadi' : 'Mashinalar yo\'q'}</p></div>`;
    return;
  }
  grid.innerHTML = f.map(car => {
    const s  = carSt(car), oi = oilInt(car.oil_name);
    const oU  = (car.total_km - car.oil_change_km) / oi;
    const aU  = (car.total_km - car.antifreeze_km) / (car.antifreeze_interval || 30000);
    const gU  = (car.total_km - car.gearbox_km)    / (car.gearbox_interval    || 50000);
    const afU = (car.total_km - (car.air_filter_km   || car.total_km)) / (car.air_filter_interval   || 15000);
    const cfU = (car.total_km - (car.cabin_filter_km || car.total_km)) / (car.cabin_filter_interval || 15000);
    const ofU = (car.total_km - (car.oil_filter_km   || car.total_km)) / (car.oil_filter_interval   || 10000);
    const dueSummary = getNearestDueSummary(car);
    return `<div class="cc" data-id="${car.id}">
      <div class="cc-top">🚗<div class="cdot ${s.dot}"></div></div>
      <div class="cc-body">
        <div class="cn">${car.car_name}</div>
        <div class="cnum">${car.car_number}</div>
        <div class="ckm">🏁 ${car.total_km.toLocaleString()} km</div>
        <div class="cdue">${escHtml(dueSummary)}</div>
        <div class="cst">${svcE(oU)}${svcE(aU)}${svcE(gU)}${svcE(afU)}${svcE(cfU)}${svcE(ofU)}</div>
      </div>
    </div>`;
  }).join('');
  grid.querySelectorAll('.cc').forEach(e => {
    e.addEventListener('click', () => {
      curCar = allCars.find(c => String(c.id) === String(e.dataset.id));
      if (curCar) openModal();
    });
  });
}
function filterGrid() { loadCarsGrid(document.getElementById('car-search').value.toLowerCase().trim()); }

// ===== OIL SELECT =====
function renderOilSel(id, val) {
  const sel = document.getElementById(id); if (!sel) return;
  const cur = val || sel.value;
  sel.innerHTML = '<option value="">Tanlang...</option>' +
    allOils.map(o => `<option value="${o.name}"${o.name === cur ? ' selected' : ''}>${o.name} (${o.interval.toLocaleString()} km)</option>`).join('');
}

// ===== CHECKBOX =====
function toggleCheck(el) { el.classList.toggle('checked'); }

// ===== PILL BUTTONS =====
function setPillStatus(svc, status, btn) {
  const km = parseFloat(document.getElementById('current-km')?.value) || 0;
  let interval, kmFieldId, hintId, pillHintId;
  if (svc === 'anti') {
    interval = parseFloat(document.getElementById('antifreeze-interval')?.value) || 30000;
    kmFieldId = 'antifreeze-km'; hintId = 'antifreeze-hint'; pillHintId = 'anti-pill-hint';
  } else {
    interval = parseFloat(document.getElementById('gearbox-interval')?.value) || 50000;
    kmFieldId = 'gearbox-km'; hintId = 'gearbox-hint'; pillHintId = 'gear-pill-hint';
  }
  btn.closest('.pill-group').querySelectorAll('.pill-btn').forEach(b => b.classList.remove('active-pill'));
  btn.classList.add('active-pill');
  const pct   = status === 'green' ? 0.2 : status === 'yellow' ? 0.8 : 1.05;
  const kmVal = Math.max(0, Math.round(km - interval * pct));
  document.getElementById(kmFieldId).value = kmVal;
  const labels = { green:['🟢','green','Yaxshi holat'], yellow:['🟡','yellow','Tez orada kerak'], red:['🔴','red','Hoziroq kerak!'] };
  const [icon, cls, text] = labels[status];
  setChip(pillHintId, cls, `${icon} ${text} · ${Math.max(0,km-kmVal).toLocaleString()} / ${interval.toLocaleString()} km`);
  calcChip(hintId, km, kmVal, interval);
}

// ===== HINT CHIPS =====
function setChip(id, cls, html) { const el = document.getElementById(id); if (!el) return; el.innerHTML = `<span class="sch ${cls}">${html}</span>`; }
function clearChip(id) { const el = document.getElementById(id); if (el) el.innerHTML = ''; }
function calcChip(hintId, totalKm, lastKm, interval) {
  if (!totalKm || !lastKm || !interval) { clearChip(hintId); return; }
  const u = (totalKm - lastKm) / interval, used = Math.max(0, totalKm - lastKm);
  if      (u >= DPCT) setChip(hintId, 'red',    `🔴 HOZIROQ — ${used.toLocaleString()} / ${interval.toLocaleString()} km`);
  else if (u >= WPCT) setChip(hintId, 'yellow', `🟡 Tez orada — ${used.toLocaleString()} / ${interval.toLocaleString()} km`);
  else                 setChip(hintId, 'green',  `🟢 Yaxshi — ${used.toLocaleString()} / ${interval.toLocaleString()} km`);
}

function setupHintListeners() {
  const pairs = [
    ['current-km','oil-change-km',   'oil-hint',          ()=>[parseFloat(document.getElementById('current-km')?.value)||0, parseFloat(document.getElementById('oil-change-km')?.value)||0, oilInt(document.getElementById('oil-name')?.value)]],
    ['current-km','antifreeze-km',   'antifreeze-hint',   ()=>[parseFloat(document.getElementById('current-km')?.value)||0, parseFloat(document.getElementById('antifreeze-km')?.value)||0, parseFloat(document.getElementById('antifreeze-interval')?.value)||30000]],
    ['current-km','gearbox-km',      'gearbox-hint',      ()=>[parseFloat(document.getElementById('current-km')?.value)||0, parseFloat(document.getElementById('gearbox-km')?.value)||0, parseFloat(document.getElementById('gearbox-interval')?.value)||50000]],
    ['current-km','air-filter-km',   'air-filter-hint',   ()=>[parseFloat(document.getElementById('current-km')?.value)||0, parseFloat(document.getElementById('air-filter-km')?.value)||0, parseFloat(document.getElementById('air-filter-interval')?.value)||15000]],
    ['current-km','cabin-filter-km', 'cabin-filter-hint', ()=>[parseFloat(document.getElementById('current-km')?.value)||0, parseFloat(document.getElementById('cabin-filter-km')?.value)||0, parseFloat(document.getElementById('cabin-filter-interval')?.value)||15000]],
    ['current-km','oil-filter-km',   'oil-filter-hint',   ()=>[parseFloat(document.getElementById('current-km')?.value)||0, parseFloat(document.getElementById('oil-filter-km')?.value)||0, parseFloat(document.getElementById('oil-filter-interval')?.value)||10000]],
  ];
  pairs.forEach(([id1, id2, hintId, getVals]) => {
    [id1, id2].forEach(id => {
      document.getElementById(id)?.addEventListener('input', () => { const [t,l,i] = getVals(); calcChip(hintId, t, l, i); });
    });
  });
  document.getElementById('oil-name')?.addEventListener('change', () => {
    calcChip('oil-hint', parseFloat(document.getElementById('current-km')?.value)||0, parseFloat(document.getElementById('oil-change-km')?.value)||0, oilInt(document.getElementById('oil-name')?.value));
  });
}
setupHintListeners();

function resetAddCarForm() {
  document.getElementById('add-car-form').reset();
  renderOilSel('oil-name');
  ['oil-hint','antifreeze-hint','gearbox-hint','air-filter-hint','cabin-filter-hint','oil-filter-hint','anti-pill-hint','gear-pill-hint'].forEach(clearChip);
  document.querySelectorAll('.pill-btn').forEach(b => b.classList.remove('active-pill'));
  document.querySelectorAll('.check-item').forEach(b => b.classList.remove('checked'));
}

// ===== SMS TEMPLATE =====
function fillTemplate(tmpl, car, serviceName = '') {
  if (!tmpl) return '';
  return tmpl
    .replace(/{car_name}/g, car.car_name || '')
    .replace(/{car_number}/g, car.car_number || '')
    .replace(/{km}/g, String(Number(car.total_km || 0)))
    .replace(/{date}/g, nowDate())
    .replace(/{service_name}/g, serviceName || 'Texnik xizmat');
}
function supportsSmsForService(serviceKey = '') {
  return ['oil', 'gearbox'].includes(String(serviceKey || '').trim());
}
function titleCaseWords(value = '') {
  return String(value || '').trim().split(/\s+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}
function getServicePhrase(serviceKey = '', mode = 'done', car = {}) {
  const key = String(serviceKey || '').trim();
  if (key === 'oil') {
    const oilName = titleCaseWords(car.oil_name || 'moy');
    return mode === 'due' ? `moy ${oilName} ni almashtirish` : `Moy ${oilName} almashtirildi`;
  }
  if (key === 'gearbox') {
    return mode === 'due' ? 'karobka moyini almashtirish' : 'Karobka moyi almashtirildi';
  }
  const meta = SVC_META[key] || {};
  return mode === 'due' ? (meta.label ? `${String(meta.label).toLowerCase()}ni almashtirish` : 'texnik xizmatni bajarish') : (meta.label ? `${meta.label} almashtirildi` : 'Texnik xizmat bajarildi');
}
function buildSaveSmsText(car, checkedKeys) {
  const smsKeys = checkedKeys.filter((key) => supportsSmsForService(key));
  if (!smsKeys.length) return '';
  return smsKeys.map((key) => fillTemplate(DEFAULT_SMS.service_done_message, car, getServicePhrase(key, 'done', car))).join('\n\n');
}

// ===== DEVSMS =====
async function sendSms(text, phone, scheduleAt = '') {
  const payload = { phone: normalizePhone(phone), message: text };
  if (scheduleAt) payload.schedule_at = scheduleAt;
  const data = await apiJson(`${BACKEND_URL}/api/sms/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (data.scheduled && data.item) {
    scheduledSmsItems.unshift(data.item);
    refreshScheduleList();
    addSmsLog({ ok: true, phone, message: text, via: 'Reja', time: new Date().toLocaleString('uz-UZ') });
    return { ok: true, scheduled: true, item: data.item };
  }
  addSmsLog({ ok: !!data.ok, phone, message: text, via: 'Tizim', error: data.error || '', time: new Date().toLocaleString('uz-UZ') });
  return { ok: !!data.ok, data: data.devsms || {}, error: data.error || '' };
}

// ===== SMS LOG TIZIMI =====
// Yuborilgan/xato SMS larni UI da ko'rsatish uchun
const SMS_LOG_KEY = 'sms_log';
const SMS_LOG_MAX = 50; // Maksimum 50 ta log saqlash
function smsLogSortTs(entry = {}) {
  const rawTs = Number(entry.ts);
  if (Number.isFinite(rawTs) && rawTs > 0) return rawTs;
  const parsed = new Date(entry.timestamp || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function setSmsLogLoading(message = 'Xabarlar tarixi yuklanmoqda...') {
  const el = document.getElementById('sms-log-list');
  if (el) el.innerHTML = loadingHtml(message);
}

function addSmsLog(entry) {
  // entry: { ok, phone, message, service, car_name, error, via }
  const log = DB.get(SMS_LOG_KEY, []);
  log.unshift({
    ...entry,
    time: new Date().toLocaleString('uz-UZ'),
    ts: Date.now(),
  });
  // Maksimum hajmni saqlash
  if (log.length > SMS_LOG_MAX) log.splice(SMS_LOG_MAX);
  DB.set(SMS_LOG_KEY, log);
  // Agar SMS log paneli ochiq bo'lsa — yangilash
  renderSmsLog();
}

function smsTypeLabel(type = '') {
  const map = {
    service_change: 'Xizmat bajarildi',
    car_saved: "Yangi avtomobil saqlandi",
    auto_check: 'Xizmat eslatmasi',
    scheduled: 'Rejalashtirilgan xabar',
    direct: 'Xabar',
    test: 'Sinov xabari',
    callback: 'Status yangilanishi',
  };
  return map[type] || type || 'Xabar';
}
function getSmsLogSearchTerm() {
  return String(document.getElementById('sms-log-search')?.value || '').trim().toLowerCase();
}
function smsLogMatches(entry = {}, searchTerm = '') {
  if (!searchTerm) return true;
  const haystack = [
    smsTypeLabel(entry.type || ''),
    entry.phone || '',
    entry.provider_status || '',
    entry.via || '',
    entry.car_name || '',
    entry.message || '',
    entry.error || '',
    entry.service || '',
    entry.queue_status || '',
  ].join(' ').toLowerCase();
  return haystack.includes(searchTerm);
}

function renderSmsLog(items = null) {
  const el = document.getElementById('sms-log-list');
  if (!el) return;
  if ((bootstrapLoading || smsLogsLoading) && (!items || !items.length)) {
    el.innerHTML = loadingHtml('Xabarlar tarixi yuklanmoqda...');
    return;
  }
  const log = (Array.isArray(items) ? items.filter(Boolean) : DB.get(SMS_LOG_KEY, []))
    .sort((a, b) => smsLogSortTs(b) - smsLogSortTs(a));
  if (Array.isArray(items)) DB.set(SMS_LOG_KEY, log.slice(0, SMS_LOG_MAX));
  const searchTerm = getSmsLogSearchTerm();
  const filtered = log.filter((entry) => smsLogMatches(entry, searchTerm));
  if (log.length === 0) {
    el.innerHTML = '<div class="sms-log-empty">Hozircha xabar yuborilmagan</div>';
    return;
  }
  if (!filtered.length) {
    el.innerHTML = '<div class="sms-log-empty">Mos xabar topilmadi</div>';
    return;
  }
  el.innerHTML = filtered.map(e => `
    <div class="sms-log-item ${e.ok ? 'sms-log-ok' : 'sms-log-fail'}">
      <div class="sms-log-header">
        <span class="sms-log-status">${smsTypeLabel(e.type)}</span>
        <span class="sms-log-phone">${e.phone || '—'}</span>
        <span class="sms-log-time">${e.time || e.timestamp || '—'}</span>
        ${e.provider_status ? `<span class="sms-log-via">${e.provider_status}</span>` : (e.via ? `<span class="sms-log-via">${e.via}</span>` : '')}
      </div>
      ${e.car_name ? `<div class="sms-log-car">${e.car_name}${e.service ? ' · ' + e.service : ''}</div>` : ''}
      <div class="sms-log-msg">${escHtml(e.message || '')}${e.error ? `\nXato: ${escHtml(e.error)}` : ''}</div>
    </div>
  `).join('');
}

async function refreshSmsLogsFromBackend(options = {}) {
  const showLoading = options.showLoading !== false;
  const requestId = ++smsLogRequestSeq;
  if (showLoading) {
    smsLogsLoading = true;
    setSmsLogLoading('Xabarlar tarixi yuklanmoqda...');
  }
  try {
    const logsResp = await apiJson(`${BACKEND_URL}/api/sms/logs?limit=80`);
    if (requestId !== smsLogRequestSeq) return;
    if (logsResp.ok && Array.isArray(logsResp.logs)) {
      renderSmsLog(logsResp.logs);
    } else {
      renderSmsLog([]);
    }
  } catch (e) {
    if (requestId !== smsLogRequestSeq) return;
    console.warn("SMS tarixini yuklashda xato:", e.message);
    renderSmsLog(DB.get(SMS_LOG_KEY, []));
  } finally {
    if (requestId === smsLogRequestSeq) smsLogsLoading = false;
  }
}


// ===== AVTOMATIK TEKSHIRUV =====
const AUTO_CHECK_INTERVAL = 60 * 1000;
const SENT_TODAY_KEY = 'auto_sms_sent';
function todayStr() { return new Date().toISOString().slice(0, 10); }
function wasSentToday(carId, type) { const log = DB.get(SENT_TODAY_KEY, {}); return log[carId + '_' + type] === todayStr(); }
function markSentToday(carId, type) {
  const log = DB.get(SENT_TODAY_KEY, {});
  log[carId + '_' + type] = todayStr();
  const week = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  Object.keys(log).forEach(k => { if (log[k] < week) delete log[k]; });
  DB.set(SENT_TODAY_KEY, log);
}
async function autoCheckAndSend() {
  if (!smsConfig.enabled || !smsConfig.has_token) return;
  const svcs = [
    { key: 'oil', getU: car => (car.total_km - car.oil_change_km) / oilInt(car.oil_name) },
    { key: 'gearbox', getU: car => (car.total_km - car.gearbox_km) / (car.gearbox_interval || 50000) },
  ];
  for (const car of allCars) {
    if (!car.phone_number) continue;
    for (const svc of svcs) {
      const u = svc.getU(car);
      if (u >= DPCT && !wasSentToday(car.id, svc.key)) {
        const svcLabel = getServicePhrase(svc.key, 'due', car);
        const tmpl = smsConfig.service_due_message || DEFAULT_SMS.service_due_message;
        const text = fillTemplate(tmpl, car, svcLabel);
        await sendSms(text, car.phone_number);
        markSentToday(car.id, svc.key);
        smsConfig.sms_sent_count = (smsConfig.sms_sent_count || 0) + 1;
        saveSms();
        await fbSaveSmsConfig();
      }
    }
  }
}
let autoCheckTimer = null;
function startAutoCheck() {
  if (autoCheckTimer) clearInterval(autoCheckTimer);
  autoCheckTimer = setInterval(autoCheckAndSend, AUTO_CHECK_INTERVAL);
}

// ===== ADD CAR =====
document.getElementById('add-car-form').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget;
  const submitBtn = form.querySelector('[type="submit"]');
  const km   = parseInt(document.getElementById('current-km').value) || 0;
  const name = document.getElementById('car-name').value.trim();
  const num  = document.getElementById('car-number').value.trim();
  const oil  = document.getElementById('oil-name').value;
  if (!name || !num || !oil) { showToast("❌ Barcha maydonlarni to'ldiring", 'error'); return; }

  const car = {
    car_name: name, car_number: num,
    daily_km:             parseInt(document.getElementById('daily-km').value) || 50,
    phone_number:         document.getElementById('phone-number').value.trim(),
    oil_name: oil, total_km: km,
    oil_change_km:        parseInt(document.getElementById('oil-change-km').value) || km,
    antifreeze_km:        parseInt(document.getElementById('antifreeze-km').value) || km,
    gearbox_km:           parseInt(document.getElementById('gearbox-km').value) || km,
    antifreeze_interval:  parseInt(document.getElementById('antifreeze-interval').value) || 30000,
    gearbox_interval:     parseInt(document.getElementById('gearbox-interval').value) || 50000,
    air_filter_km:        parseInt(document.getElementById('air-filter-km').value) || km,
    air_filter_interval:  parseInt(document.getElementById('air-filter-interval').value) || 15000,
    cabin_filter_km:      parseInt(document.getElementById('cabin-filter-km').value) || km,
    cabin_filter_interval:parseInt(document.getElementById('cabin-filter-interval').value) || 15000,
    oil_filter_km:        parseInt(document.getElementById('oil-filter-km').value) || km,
    oil_filter_interval:  parseInt(document.getElementById('oil-filter-interval').value) || 10000,
    history: [], added_at: new Date().toISOString()
  };

  const checkedKeys = [];
  document.querySelectorAll('.check-item.checked').forEach(el => {
    const key = el.dataset.key; checkedKeys.push(key);
    car.history.push({ type: key, km: car.total_km, oil_name: key === 'oil' ? oil : '', date: car.added_at });
    if (key === 'oil') car.oil_change_km = km;
    if (key === 'antifreeze') car.antifreeze_km = km;
    if (key === 'gearbox') car.gearbox_km = km;
    if (key === 'air_filter') car.air_filter_km = km;
    if (key === 'cabin_filter') car.cabin_filter_km = km;
    if (key === 'oil_filter') car.oil_filter_km = km;
  });

  busyStart();
  if (submitBtn) submitBtn.disabled = true;
  try {
    await fbCreateCar(car);
    let notice = "✅ Mashina qo'shildi!";
    const smsTypes = checkedKeys.filter((key) => supportsSmsForService(key));
    if (smsConfig.enabled && smsConfig.has_token && car.phone_number && smsTypes.length) {
      const smsResp = await apiJson(`${BACKEND_URL}/api/sms/car-saved`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ car, service_types: smsTypes })
      });
      if (smsResp.ok && Number(smsResp.sent_count || 0) > 0) notice += ' Xabar yuborildi.';
    }
    resetAddCarForm();
    navigateTo('cars');
    await reloadDataAfterChange(notice);
  } catch (err) {
    showToast(`❌ ${err.message || "Saqlashda xato"}`, 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    busyEnd();
  }
});

// ===== OILS PAGE =====
function loadOilsPage() {
  if (bootstrapLoading && !allOils.length) {
    const list = document.getElementById('oils-list');
    if (list) list.innerHTML = loadingHtml('Moylar yuklanmoqda...');
    return;
  }
  const list = document.getElementById('oils-list');
  list.innerHTML = allOils.length
    ? allOils.map(o => `<div class="oi">
        <div><div class="on">🛢️ ${o.name}</div><div class="oint">📍 ${o.interval.toLocaleString()} km</div></div>
        <button class="odel" onclick="deleteOil(${o.id})">🗑️</button>
      </div>`).join('')
    : '<div class="empty"><div class="ei">🛢️</div><p>Hech qanday moy yo\'q</p></div>';
}
document.getElementById('add-oil-form').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget;
  const submitBtn = form.querySelector('[type="submit"]');
  const name     = document.getElementById('oil-name-input').value.trim();
  const interval = parseInt(document.getElementById('oil-interval-input').value);
  if (!name || !interval) { showToast("❌ To'ldiring", 'error'); return; }
  const oil = { name, interval };
  busyStart();
  if (submitBtn) submitBtn.disabled = true;
  try {
    await fbSaveOil(oil);
    form.reset();
    await reloadDataAfterChange("✅ Moy turi qo'shildi!");
  } catch (e) {
    showToast(`❌ ${e.message || "Moyni saqlab bo'lmadi"}`, 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    busyEnd();
  }
});
async function deleteOil(id) {
  if (!confirm("Moy turini o'chirasizmi?")) return;
  busyStart();
  try {
    await fbDeleteOil(id);
    await reloadDataAfterChange("✅ O'chirildi!");
  } catch (e) {
    showToast(`❌ ${e.message || "Moyni o'chirib bo'lmadi"}`, 'error');
  } finally {
    busyEnd();
  }
}

// ===== SMS TAB TIZIMI =====
function switchSmsTab(tab, btn) {
  document.querySelectorAll('.sms-tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.sms-tab-content').forEach(c => c.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const el = document.getElementById('sms-tab-' + tab);
  if (el) el.classList.add('active');
  // Log tabiga o'tganda yangilash
  if (tab === 'logs') void refreshSmsLogsFromBackend({ showLoading: true });
}

// Token ko'rish/yashirish
function toggleTokenVisibility() {
  const inp = document.getElementById('devsms-token');
  const eye = document.getElementById('token-eye');
  if (!inp) return;
  inp.type = inp.type === 'password' ? 'text' : 'password';
  if (eye) eye.textContent = inp.type === 'password' ? '👁️' : '🙈';
}

// Token o'zgarganda eski natijani tozalaymiz
(function() {
  const tokenInp = document.getElementById('devsms-token');
  if (tokenInp) {
    tokenInp.addEventListener('input', () => {
      const resEl = document.getElementById('token-verify-result');
      if (resEl) resEl.style.display = 'none';
    });
  }
})();

// Backend va ma'lumotlar bazasi holatini tekshirish
async function checkBackendStatus() {
  const backendEl  = document.getElementById('sms-backend-status');
  const databaseEl = document.getElementById('sms-database-status');
  if (backendEl)  { backendEl.textContent  = '⏳...'; backendEl.style.color  = 'var(--text2)'; }
  if (databaseEl) { databaseEl.textContent = '⏳...'; databaseEl.style.color = 'var(--text2)'; }
  // Backend
  try {
    const r = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(4000) });
    const d = await r.json().catch(() => ({}));
    if (backendEl) {
      backendEl.textContent  = r.ok ? 'Tayyor' : 'Xato';
      backendEl.style.color  = r.ok ? 'var(--success)' : 'var(--danger)';
    }
  } catch(e) {
    if (backendEl) { backendEl.textContent = 'Ulanmagan'; backendEl.style.color = 'var(--danger)'; }
  }
  // Database
  try {
    const r = await apiJson(`${BACKEND_URL}/api/storage/ping`);
    if (databaseEl) {
      databaseEl.textContent = r.ok ? 'Tayyor' : 'Xato';
      databaseEl.style.color = r.ok ? 'var(--success)' : 'var(--danger)';
    }
  } catch(e) {
    if (databaseEl) { databaseEl.textContent = 'Xato'; databaseEl.style.color = 'var(--danger)'; }
  }
}

// Qo'lda telefon raqam orqali SMS yuborish olib tashlangan.

// SMS statistikasini yangilash
async function updateSmsStats() {
  const sentEl  = document.getElementById('sms-sent-count');
  const todayEl = document.getElementById('sms-stat-today');
  const failEl  = document.getElementById('sms-stat-fail');
  if (sentEl) sentEl.textContent = (smsConfig.sms_sent_count || 0).toLocaleString();
  try {
    const stats = await apiJson(`${BACKEND_URL}/api/sms/stats`);
    if (stats.ok) {
      smsConfig.sms_sent_count = Number(stats.total_sent || 0);
      saveSms();
      if (sentEl)  sentEl.textContent  = (smsConfig.sms_sent_count || 0).toLocaleString();
      if (todayEl) todayEl.textContent = Number(stats.today_count || 0).toLocaleString();
      if (failEl)  failEl.textContent  = Number(stats.fail_count || 0).toLocaleString();
      return;
    }
  } catch (e) {}
  const log = DB.get(SMS_LOG_KEY, []);
  const today = new Date().toDateString();
  const todayCount = log.filter(e => new Date(e.ts || 0).toDateString() === today).length;
  const failCount  = log.filter(e => !e.ok).length;
  if (todayEl) todayEl.textContent = todayCount;
  if (failEl)  failEl.textContent  = failCount;
}

// SMS page header status
function updateSmsHeaderStatus() {
  const el = document.getElementById('sms-header-status');
  if (!el) return;
  if (smsConfig.enabled && smsConfig.has_token) {
    el.textContent = 'Xabar yuborish tayyor — ' + (smsConfig.sms_sent_count || 0) + ' ta yuborilgan';
    el.style.color = 'var(--success)';
  } else if (!smsConfig.has_token) {
    el.textContent = 'Xabar yuborish tayyor emas';
    el.style.color = 'var(--warning)';
  } else {
    el.textContent = '❌ SMS o\'chirilgan';
    el.style.color = 'var(--danger)';
  }
}

// Token tekshirish
async function verifyToken() {
  const token  = document.getElementById('devsms-token')?.value?.trim();
  const resEl  = document.getElementById('token-verify-result');
  const btn    = document.querySelector('[onclick="verifyToken()"]');
  if (!token) { showTmplResult(resEl, 'fail', 'Tekshirish uchun ulanish kalitini kiriting'); return; }
  showTmplResult(resEl, 'loading', 'Ulanish tekshirilmoqda...');
  if (btn) setBtnState(btn, 'loading', 'Tekshirilmoqda...');

  function fmtBalance(balance) {
    if (balance === null || balance === undefined || balance === '') return '';
    return ` · Balans: ${Number(balance).toLocaleString()} so'm`;
  }

  function resetBtn() {
    if (btn) setBtnState(btn, '', 'Ulanishni tekshirish');
  }

  try {
    const r = await fetch(`${BACKEND_URL}/api/sms/verify-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(10000),
    });
    const d = await r.json().catch(() => ({}));
    resetBtn();
    console.log('[verifyToken] server javobi:', JSON.stringify(d));
    if (d.ok) {
      showTmplResult(resEl, 'ok', `Ulanish tayyor${fmtBalance(d.balance)}`);
    } else {
      // devsms raw javobini ko'rsatamiz — xato sababini bilish uchun
      const rawInfo = d.data?.message || d.data?.error || d.error || '';
      const hint = rawInfo ? `: ${rawInfo}` : (d.http_status ? ` (HTTP ${d.http_status})` : '');
      showTmplResult(resEl, 'fail', `Ulanishda xato${hint}`);
    }
  } catch(e) {
    resetBtn();
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      showTmplResult(resEl, 'fail', `Server javob bermadi`);
    } else {
      showTmplResult(resEl, "fail", `Server bilan bog'lanib bo'lmadi`);
    }
  }
}

// SMS PAGE =====
async function refreshSmsDataFromBackend() {
  try {
    const [logsResp, schedulesResp, statsResp] = await Promise.all([
      apiJson(`${BACKEND_URL}/api/sms/logs?limit=80`),
      apiJson(`${BACKEND_URL}/api/sms/schedules?limit=80`),
      apiJson(`${BACKEND_URL}/api/sms/stats`),
    ]);
    if (logsResp.ok && Array.isArray(logsResp.logs)) renderSmsLog(logsResp.logs);
    if (schedulesResp.ok && Array.isArray(schedulesResp.schedules)) {
      scheduledSmsItems = schedulesResp.schedules;
      refreshScheduleList();
    }
    if (statsResp.ok) {
      smsConfig.sms_sent_count = Number(statsResp.total_sent || 0);
      saveSms();
    }
  } catch (e) {
    console.warn("SMS ma'lumotlarini yangilashda xato:", e.message);
  }
}

function loadSmsPage() {
  const techSettings = document.getElementById('sms-tab-settings'); if (techSettings) techSettings.style.display = 'none';
  const tmplTab = document.getElementById('sms-tab-templates'); if (tmplTab) tmplTab.style.display = 'none';
  const editorModal = document.getElementById('editor-modal'); if (editorModal) editorModal.style.display = 'none';
  if (document.getElementById('devsms-token')) document.getElementById('devsms-token').value        = '';
  const smsTokenBox = document.getElementById('sms-token-box'); if (smsTokenBox) smsTokenBox.style.display = 'none';
  const savedTokenNote = document.getElementById('saved-token-note');
  if (savedTokenNote) savedTokenNote.textContent = smsConfig.has_token ? 'Xabar xizmati tayyor' : 'Xabar xizmati tayyor emas';
  if (document.getElementById('sms-enabled')) document.getElementById('sms-enabled').checked = !!smsConfig.enabled;
  if (document.getElementById('sms-service-done-message')) document.getElementById('sms-service-done-message').value = smsConfig.service_done_message || DEFAULT_SMS.service_done_message;
  if (document.getElementById('sms-service-due-message')) document.getElementById('sms-service-due-message').value = smsConfig.service_due_message || DEFAULT_SMS.service_due_message;
  if (document.getElementById('sms-sent-count')) document.getElementById('sms-sent-count').textContent = (smsConfig.sms_sent_count || 0).toLocaleString();

  // Test telefon raqamini yuklash
  const testPhoneVal = smsConfig.test_phone || '';
  const tpInput = document.getElementById('test-phone-input');
  if (tpInput) tpInput.value = testPhoneVal;
  const tpStatus = document.getElementById('test-phone-status');
  if (tpStatus) {
    tpStatus.textContent = testPhoneVal
      ? `${testPhoneVal} raqami sinov uchun tayyor`
      : 'Sinov uchun raqam kiritilmagan';
    tpStatus.style.color = testPhoneVal ? 'var(--success)' : 'var(--text2)';
  }

  const ae = document.getElementById('sms-api-status');
  if (ae) {
    ae.textContent = smsConfig.has_token ? 'Tayyor' : 'Tayyor emas';
    ae.style.color = smsConfig.has_token ? 'var(--success)' : 'var(--danger)';
  }

  const card = document.getElementById('sms-status-card');
  const el   = document.getElementById('sms-status');
  if (smsConfig.enabled && smsConfig.has_token) { el.textContent = '✅ SMS faol'; card.classList.add('on'); }
  else if (!smsConfig.has_token)                { el.textContent = '⚠️ Xabar xizmati tayyor emas'; card.classList.remove('on'); }
  else                                              { el.textContent = '❌ SMS o\'chirilgan'; card.classList.remove('on'); }

  updateSmsStats();
  updateSmsHeaderStatus();
  refreshSmsDataFromBackend().then(() => {
    updateSmsStats();
    updateSmsHeaderStatus();
  });
  // Backend va baza holatini asinxron tekshiramiz
  setTimeout(checkBackendStatus, 300);
}
const smsConfigForm = document.getElementById('sms-config-form');
if (smsConfigForm) smsConfigForm.addEventListener('submit', async e => {
  e.preventDefault();
  const saveBtn = e.target.querySelector('[type="submit"]');

  // ── Loading holati ──
  if (saveBtn) setBtnState(saveBtn, 'loading', '⏳ Saqlanmoqda...');

  smsConfig.enabled              = document.getElementById('sms-enabled').checked;
  smsConfig.service_done_message = document.getElementById('sms-service-done-message').value;
  smsConfig.service_due_message  = document.getElementById('sms-service-due-message').value;

  // ── Lokal saqlash ──
  saveSms();

  // ── Backendga saqlash ──
  try {
    await fbSaveSmsConfig();
  } catch(err) {
    console.warn('Backendga saqlashda xato:', err);
  }

  // startAutoCheck();

  // ── Token bo'lsa — balansni avtomatik tekshiramiz ──
  if (smsConfig.has_token) {
    const resEl = document.getElementById('token-verify-result');
    if (resEl) {
      showTmplResult(resEl, 'ok', 'Xabar xizmati tayyor');
    }
  }

  // ── Tugmani tiklash ──
  if (saveBtn) {
    setBtnState(saveBtn, 'ok', '✅ Saqlandi!');
    setTimeout(() => setBtnState(saveBtn, '', 'Saqlash'), 2500);
  }

  showToast('Xabar sozlamalari saqlandi', 'success');
  loadSmsPage();
});
async function resetSmsCount() {
  if (!confirm("Hisoblagichni nolga tiklaysizmi?")) return;
  busyStart();
  try {
    await apiOk(`${BACKEND_URL}/api/sms/reset-count`, { method: 'POST' });
    await reloadDataAfterChange('Hisoblagich tozalandi');
  } catch (e) {
    showToast(`❌ ${e.message || "Hisoblagichni tozalab bo'lmadi"}`, 'error');
  } finally {
    busyEnd();
  }
}

// ===== SHABLON: ALOHIDA SAQLASH =====
// Har bir shablon yonidagi "💾 Shablonni saqlash" tugmasi
// shu funksiyani chaqiradi. Backend ga saqlaydi → Database ga yozadi.
async function saveTemplate(templateKey, textareaId) {
  const btn = document.querySelector(`[onclick="saveTemplate('${templateKey}','${textareaId}')"]`);
  const resultEl = document.getElementById('tmpl-result-' + templateKey);
  const value = document.getElementById(textareaId)?.value?.trim();

  if (!value) {
    showTmplResult(resultEl, 'fail', "❌ Shablon bo'sh — matn kiriting");
    return;
  }

  // Tugmani loading holatiga o'tkaz
  setBtnState(btn, 'loading', '⏳ Saqlanmoqda...');
  showTmplResult(resultEl, 'loading', '⏳ Backend ga yuborilmoqda...');

  // Local state ga yoz
  smsConfig[templateKey] = value;
  saveSms();

  // Backend → Database ga saqlash
  let savedViaBackend = false;
  try {
    const payload = { ...smsConfig };
    payload[templateKey] = value;

    const r = await fetch(`${BACKEND_URL}/api/sms-config`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const data = await r.json();
      savedViaBackend = true;
      setBtnState(btn, 'ok', '✅ Saqlandi');
      showTmplResult(resultEl, 'ok',
        `✅ Shablon backend + Database ga saqlandi.
` +
        `<div class="preview">${escHtml(value)}</div>`
      );
    } else {
      throw new Error('Backend ' + r.status);
    }
  } catch(e) {
    setBtnState(btn, 'fail', '❌ Xato');
    showTmplResult(resultEl, 'fail', '❌ Saqlashda xato: ' + (e.message || "noma'lum"));
  }
  setTimeout(() => { setBtnState(btn, '', '💾 Shablonni saqlash'); }, 3000);
}

// ===== SHABLON: TEST SMS YUBORISH =====
// Har bir shablon yonidagi "📤 Test SMS" tugmasi
// backend dan joriy saqlangan shablonni olib, test uchun SMS yuboradi.
async function testTemplate(templateKey, textareaId) {
  const btn = document.querySelector(`[onclick="testTemplate('${templateKey}','${textareaId}')"]`);
  const resultEl = document.getElementById('tmpl-result-' + templateKey);

  // Token tekshir
  if (!smsConfig.has_token) {
    showTmplResult(resultEl, 'fail', "❌ Avval DevSMS token kiriting va saqlang");
    return;
  }

  // Test uchun telefon raqami — avval saqlangan test raqami, keyin birinchi mashina
  const testPhone = getTestPhone() || allCars.find(c => c.phone_number)?.phone_number;
  if (!testPhone) {
    showTmplResult(resultEl, 'fail', '❌ Test raqam yo\'q — SMS sahifasining tepasidan kiriting va saqlang');
    return;
  }

  // Textarea dagi joriy matnni avval saqlaymiz (saqlashdan so'ng test qilish)
  const currentText = document.getElementById(textareaId)?.value?.trim();
  if (!currentText) {
    showTmplResult(resultEl, 'fail', "❌ Shablon bo'sh — matn kiriting");
    return;
  }

  setBtnState(btn, 'loading', '⏳ Yuborilmoqda...');
  showTmplResult(resultEl, 'loading', `⏳ ${testPhone} raqamiga test SMS yuborilmoqda...`);

  // Backend orqali test
  try {
    const testCar = allCars.find(c => c.phone_number) || {
      car_name: 'Test Nexia', car_number: '01A 000AA',
      total_km: 85000, oil_name: 'SAE 5W-30', phone_number: testPhone
    };

    const r = await fetch(`${BACKEND_URL}/api/sms/test`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
                phone:        testPhone,
        template_key: templateKey,
        template_override: currentText,  // textarea dagi joriy matn
        car:          testCar,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json().catch(() => ({}));

    if (data.ok) {
      setBtnState(btn, 'ok', '✅ Yuborildi');
      showTmplResult(resultEl, 'ok',
        `✅ Test SMS yuborildi → ${testPhone}
` +
        `<div class="preview">${escHtml(data.text || currentText)}</div>`
      );
    } else {
      setBtnState(btn, 'fail', '❌ Xato');
      showTmplResult(resultEl, 'fail',
        `❌ SMS yuborilmadi: ${data.error || JSON.stringify(data.devsms || {})}`
      );
    }
  } catch(e) {
    // Fallback: to'g'ridan devsms
    const svcType  = templateKey.replace('_message','');
    const svcLabel = SVC_META[svcType]?.label || svcType;
    const text = currentText
      .replace(/{car_name}/g,      allCars[0]?.car_name   || 'Test Nexia')
      .replace(/{car_number}/g,    allCars[0]?.car_number || '01A 000AA')
      .replace(/{km}/g,            (allCars[0]?.total_km  || 85000).toLocaleString())
      .replace(/{date}/g,           nowDate())
      .replace(/{time}/g,           nowTime())
      .replace(/{oil_brand}/g,      allCars[0]?.oil_name  || 'SAE 5W-30')
      .replace(/{services}/g,       svcLabel)
      .replace(/{service_label}/g,  svcLabel);

    const smsR = await sendSms(text, testPhone);
    if (smsR && smsR.ok !== false) {
      setBtnState(btn, 'ok', '✅ Yuborildi');
      showTmplResult(resultEl, 'ok',
        `✅ Test SMS yuborildi (fallback) → ${testPhone}
<div class="preview">${escHtml(text)}</div>`
      );
    } else {
      setBtnState(btn, 'fail', '❌ Xato');
      showTmplResult(resultEl, 'fail', `❌ Xato: ${e.message || 'SMS yuborilmadi'}`);
    }
  }
  setTimeout(() => { setBtnState(btn, '', '📤 Test SMS'); }, 5000);
}

// ── Yordamchi: tugma holati ─────────────────────────────────────
function setBtnState(btn, cls, label) {
  if (!btn) return;
  btn.className = btn.className.replace(/\b(loading|ok|fail)\b/g, '').trim();
  if (cls) btn.classList.add(cls);
  btn.innerHTML = label;
  btn.disabled  = cls === 'loading';
}

// ── Yordamchi: natija paneli ────────────────────────────────────
function showTmplResult(el, cls, html) {
  if (!el) return;
  el.className   = 'tmpl-result ' + cls;
  el.innerHTML   = html;
  el.style.display = 'block';
  setTimeout(() => { if (cls !== 'loading') el.style.display = 'none'; }, 7000);
}

// ── Yordamchi: HTML escape ──────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ================================================================
// TEST TELEFON RAQAMI
// ================================================================

/** Saqlangan test raqamini qaytaradi */
function getTestPhone() {
  return smsConfig.test_phone || '';
}

/** Test raqamini saqlaydi — backend orqali */
async function saveTestPhone() {
  const input = document.getElementById('test-phone-input');
  const btn   = document.getElementById('btn-save-test-phone');
  const status = document.getElementById('test-phone-status');
  const phone = input?.value?.trim();

  if (!phone) {
    status.textContent = '❌ Raqam kiriting';
    status.style.color = 'var(--danger)';
    return;
  }

  btn.classList.add('loading');
  btn.textContent = '⏳...';

  smsConfig.test_phone = phone;
  saveSms();

  try {
    await fetch(`${BACKEND_URL}/api/sms-config`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(smsConfig),
      signal:  AbortSignal.timeout(4000),
    });
  } catch(e) {
    status.textContent = '❌ Saqlashda xato';
    status.style.color = 'var(--danger)';
    btn.classList.remove('loading');
    btn.textContent = '💾 Saqlash';
    return;
  }

  btn.classList.remove('loading');
  btn.classList.add('ok');
  btn.textContent = '✅ Saqlandi';
  status.textContent = `✅ Test SMS ${phone} raqamiga yuboriladi`;
  status.style.color = 'var(--success)';
  setTimeout(() => {
    btn.classList.remove('ok');
    btn.textContent = '💾 Saqlash';
  }, 3000);
}

// ================================================================
// SHABLON EDITOR MODAL
// ================================================================

let _editorKey  = '';   // faol template key
let _editorTaId = '';   // manbaa textarea id

/** Editorni ochadi */
function openEditor(templateKey, textareaId, title) {
  _editorKey  = templateKey;
  _editorTaId = textareaId;

  const sourceVal = document.getElementById(textareaId)?.value ||
                    smsConfig[templateKey] || DEFAULT_SMS[templateKey] || '';

  document.getElementById('emod-title').textContent    = title || 'Shablonni Tahrirlash';
  document.getElementById('emod-textarea').value       = sourceVal;
  document.getElementById('emod-result').style.display = 'none';

  updateEditorPreview();

  const modal = document.getElementById('editor-modal');
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  // Textarea ni kattalashtir va focuslash
  setTimeout(() => document.getElementById('emod-textarea')?.focus(), 80);
}

/** Editorni yopadi — o'zgarishlarni asosiy textareaga ko'chiradi */
function closeEditor() {
  const modal = document.getElementById('editor-modal');
  if (!modal) return;
  modal.style.display = 'none';
  document.body.style.overflow = '';

  // Asosiy textarea ga ko'chirish
  const edVal = document.getElementById('emod-textarea')?.value;
  if (_editorTaId && edVal !== undefined) {
    const ta = document.getElementById(_editorTaId);
    if (ta) ta.value = edVal;
  }
  _editorKey = _editorTaId = '';
}

/** Preview ni real vaqtda yangilab turadi */
function updateEditorPreview() {
  const tmpl = document.getElementById('emod-textarea')?.value || '';
  const car  = allCars[0] || {
    car_name: 'Nexia 3', car_number: '01A 123BC',
    total_km: 85000, oil_name: 'SAE 5W-30'
  };
  const svcType  = _editorKey.replace('_message', '');
  const svcLabel = SVC_META[svcType]?.label || svcType || 'Xizmat';
  const preview  = tmpl
    .replace(/{car_name}/g,     car.car_name)
    .replace(/{car_number}/g,   car.car_number)
    .replace(/{km}/g,           (car.total_km||0).toLocaleString())
    .replace(/{date}/g,          nowDate())
    .replace(/{time}/g,          nowTime())
    .replace(/{oil_brand}/g,     car.oil_name || 'SAE 5W-30')
    .replace(/{services}/g,      svcLabel)
    .replace(/{service_label}/g, svcLabel);
  const prev = document.getElementById('emod-preview');
  if (prev) prev.textContent = preview || '—';
}

// Editor textarea o'zgarganda preview yangilanadi
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('emod-textarea')?.addEventListener('input', updateEditorPreview);
});
// DOMContentLoaded kutmasdan ham ishlashi uchun (skript oxirida chaqiriladi)
(function setupEditorListener() {
  const ta = document.getElementById('emod-textarea');
  if (ta) ta.addEventListener('input', updateEditorPreview);
})();

/** O'zgaruvchini kursorga qo'yadi */
function insertVar(varStr) {
  const ta = document.getElementById('emod-textarea');
  if (!ta) return;
  const start = ta.selectionStart;
  const end   = ta.selectionEnd;
  const val   = ta.value;
  ta.value = val.slice(0, start) + varStr + val.slice(end);
  ta.selectionStart = ta.selectionEnd = start + varStr.length;
  ta.focus();
  updateEditorPreview();
}

/** Shablonni default ga qaytaradi */
function resetEditorToDefault() {
  if (!_editorKey) return;
  const def = DEFAULT_SMS[_editorKey] || '';
  document.getElementById('emod-textarea').value = def;
  updateEditorPreview();
}

/** Editordan saqlash */
async function editorSave() {
  const btn   = document.getElementById('emod-btn-save');
  const resEl = document.getElementById('emod-result');
  const value = document.getElementById('emod-textarea')?.value?.trim();

  if (!value) {
    showTmplResult(resEl, 'fail', '❌ Shablon bo\u02BCsh');
    return;
  }

  setBtnState(btn, 'loading', '⏳ Saqlanmoqda...');

  // Asosiy textarea ga ham yoz
  if (_editorTaId) {
    const ta = document.getElementById(_editorTaId);
    if (ta) ta.value = value;
  }

  // smsConfig ga yoz
  smsConfig[_editorKey] = value;
  saveSms();

  // Backend/Database ga saqlash
  let ok = false;
  try {
    const r = await fetch(`${BACKEND_URL}/api/sms-config`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(smsConfig),
      signal:  AbortSignal.timeout(5000),
    });
    ok = r.ok;
  } catch(e) {
  }

  if (ok) {
    setBtnState(btn, 'ok', '✅ Saqlandi');
    showTmplResult(resEl, 'ok', '✅ Shablon saqlandi');
    setTimeout(() => closeEditor(), 1200);
  } else {
    setBtnState(btn, 'fail', '❌ Xato');
    showTmplResult(resEl, 'fail', '❌ Saqlashda xato yuz berdi');
  }
  setTimeout(() => setBtnState(btn, '', '💾 Saqlash'), 3000);
}

/** Editordan Test SMS yuborish */
async function editorTestSms() {
  const btn   = document.getElementById('emod-btn-test');
  const resEl = document.getElementById('emod-result');

  if (!smsConfig.has_token) {
    showTmplResult(resEl, 'fail', '❌ DevSMS token kiritilmagan');
    return;
  }

  const testPhone = getTestPhone() || allCars.find(c => c.phone_number)?.phone_number;
  if (!testPhone) {
    showTmplResult(resEl, 'fail', '❌ Test raqam yo\u02BCq — tepadan kiriting va saqlang');
    return;
  }

  const currentText = document.getElementById('emod-textarea')?.value?.trim();
  if (!currentText) {
    showTmplResult(resEl, 'fail', '❌ Shablon bo\u02BCsh');
    return;
  }

  setBtnState(btn, 'loading', '⏳ Yuborilmoqda...');
  showTmplResult(resEl, 'loading', `⏳ ${testPhone} ga yuborilmoqda...`);

  try {
    const testCar = allCars.find(c => c.phone_number) || {
      car_name: 'Test Nexia', car_number: '01A 000AA',
      total_km: 85000, oil_name: 'SAE 5W-30'
    };

    const r = await fetch(`${BACKEND_URL}/api/sms/test`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
                phone:             testPhone,
        template_key:      _editorKey,
        template_override: currentText,
        car:               testCar,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json().catch(() => ({}));

    if (data.ok) {
      setBtnState(btn, 'ok', '✅ Yuborildi');
      showTmplResult(resEl, 'ok',
        `✅ Test SMS yuborildi → ${testPhone}\n` +
        `<div class="preview">${escHtml(data.text || currentText)}</div>`
      );
    } else {
      setBtnState(btn, 'fail', '❌ Xato');
      showTmplResult(resEl, 'fail',
        `❌ ${data.error || JSON.stringify(data.devsms || 'SMS yuborilmadi')}`
      );
    }
  } catch(e) {
    // Fallback
    const svcType  = _editorKey.replace('_message','');
    const svcLabel = SVC_META[svcType]?.label || svcType;
    const car = allCars[0] || { car_name:'Test', car_number:'01A', total_km:0, oil_name:'SAE' };
    const text = currentText
      .replace(/{car_name}/g,     car.car_name)
      .replace(/{car_number}/g,   car.car_number)
      .replace(/{km}/g,           (car.total_km||0).toLocaleString())
      .replace(/{date}/g,          nowDate())
      .replace(/{time}/g,          nowTime())
      .replace(/{oil_brand}/g,     car.oil_name)
      .replace(/{services}/g,      svcLabel)
      .replace(/{service_label}/g, svcLabel);
    const smsR = await sendSms(text, testPhone);
    if (smsR?.ok !== false) {
      setBtnState(btn, 'ok', '✅ Yuborildi');
      showTmplResult(resEl, 'ok',
        `✅ Yuborildi (fallback) → ${testPhone}\n<div class="preview">${escHtml(text)}</div>`
      );
    } else {
      setBtnState(btn, 'fail', '❌ Xato');
      showTmplResult(resEl, 'fail', `❌ ${e.message || 'SMS yuborilmadi'}`);
    }
  }
  setTimeout(() => setBtnState(btn, '', '📤 Test SMS'), 5000);
}

// ===== CAR MODAL =====
function openModal(options = {}) {
  if (!curCar) return;
  const targetTab = options.tab || 'info';
  const oi  = oilInt(curCar.oil_name);
  const oU  = (curCar.total_km - curCar.oil_change_km) / oi;
  const aU  = (curCar.total_km - curCar.antifreeze_km) / (curCar.antifreeze_interval || 30000);
  const gU  = (curCar.total_km - curCar.gearbox_km)    / (curCar.gearbox_interval    || 50000);
  const afU = (curCar.total_km - (curCar.air_filter_km   || curCar.total_km)) / (curCar.air_filter_interval   || 15000);
  const cfU = (curCar.total_km - (curCar.cabin_filter_km || curCar.total_km)) / (curCar.cabin_filter_interval || 15000);
  const ofU = (curCar.total_km - (curCar.oil_filter_km   || curCar.total_km)) / (curCar.oil_filter_interval   || 10000);

  document.getElementById('modal-car-info').innerHTML = `
    <h3>${curCar.car_name}</h3><p>${curCar.car_number}</p>
    <p style="margin-top:4px;font-size:12px;opacity:.85">🏁 Probeg: <strong>${curCar.total_km.toLocaleString()} km</strong></p>
    <p style="margin-top:4px;font-size:12px;opacity:.85">📅 Eng yaqin muddat: <strong>${escHtml(getNearestDueSummary(curCar))}</strong></p>`;

  const svcBlock = (u, label, used, interval, dueText) => {
    const b = badgeOf(u);
    return `<div class="svi"><h4>${label}</h4><span class="badge ${b.c}">${b.t}</span>
      <div class="pb"><div class="pf ${b.b}" style="width:${Math.min(u*100,100).toFixed(1)}%"></div></div>
      <div class="skm">${used.toLocaleString()} / ${interval.toLocaleString()} km</div>
      <div class="sdue">${escHtml(dueText)}</div></div>`;
  };
  const oilForecast = getServiceForecast(curCar, 'oil');
  const antifreezeForecast = getServiceForecast(curCar, 'antifreeze');
  const gearboxForecast = getServiceForecast(curCar, 'gearbox');
  const airFilterForecast = getServiceForecast(curCar, 'air_filter');
  const cabinFilterForecast = getServiceForecast(curCar, 'cabin_filter');
  const oilFilterForecast = getServiceForecast(curCar, 'oil_filter');
  document.getElementById('modal-services').innerHTML =
    svcBlock(oU,  `🛢️ Dvigatel Moyi — <em style="font-weight:400;font-size:11px">${curCar.oil_name}</em>`, curCar.total_km - curCar.oil_change_km, oi, oilForecast.dueText) +
    svcBlock(aU,  '🔵 Antifriz',    curCar.total_km - curCar.antifreeze_km,  curCar.antifreeze_interval  || 30000, antifreezeForecast.dueText) +
    svcBlock(gU,  '🟢 Karobka',     curCar.total_km - curCar.gearbox_km,     curCar.gearbox_interval     || 50000, gearboxForecast.dueText) +
    svcBlock(afU, '💨 Havo Filtr',  curCar.total_km - (curCar.air_filter_km   || curCar.total_km), curCar.air_filter_interval   || 15000, airFilterForecast.dueText) +
    svcBlock(cfU, '🌬️ Salon Filtr', curCar.total_km - (curCar.cabin_filter_km || curCar.total_km), curCar.cabin_filter_interval || 15000, cabinFilterForecast.dueText) +
    svcBlock(ofU, '🔩 Moy Filtr',   curCar.total_km - (curCar.oil_filter_km   || curCar.total_km), curCar.oil_filter_interval   || 10000, oilFilterForecast.dueText);

  document.getElementById('modal-km').value = curCar.total_km;
  document.getElementById('modal-daily-km').value = curCar.daily_km || '';
  renderOilSel('modal-oil-select', curCar.oil_name);
  const svcSel = document.getElementById('modal-svc-type');
  const oilWrap = document.getElementById('modal-oil-wrap');
  oilWrap.style.display = svcSel.value === 'oil' ? '' : 'none';
  svcSel.onchange = () => { oilWrap.style.display = svcSel.value === 'oil' ? '' : 'none'; };

  loadHistory();
  const hint = document.getElementById('sms-hint');
  if (smsConfig.enabled && smsConfig.has_token) {
    hint.innerHTML = '💬 SMS faqat moy va karobka moyi uchun yuboriladi';
    hint.style.display = 'block';
  } else hint.style.display = 'none';

  switchTab(targetTab);
  document.getElementById('car-modal').classList.add('active');
}

function loadHistory() {
  const hist = Array.isArray(curCar?.history) ? curCar.history.filter(Boolean) : [];
  const el = document.getElementById('modal-history');
  if (!el) return;
  if (!hist.length) { el.innerHTML = "<div class='empty'><div class='ei'>📭</div><p>Tarix yo'q</p></div>"; return; }
  const today = new Date().toDateString();
  el.innerHTML = [...hist].reverse().map((log) => {
    const d = new Date(log?.date || Date.now());
    const isT = d.toDateString() === today;
    const meta = SVC_META[String(log?.type || '').trim()] || {};
    const icon = meta.icon || '🔧';
    const baseLabel = meta.label || 'Xizmat';
    const label = log?.type === 'oil' ? 'Moy' : baseLabel;
    const oilPart = log?.oil_name ? ` — ${escHtml(log.oil_name)}` : '';
    const kmText = Number.isFinite(Number(log?.km)) ? `${Number(log.km).toLocaleString()} km` : `${Number(curCar?.total_km || 0).toLocaleString()} km`;
    const ds = isT ? '<span class="htlbl">Bugun</span>' : d.toLocaleDateString('uz-UZ', { year: 'numeric', month: '2-digit', day: '2-digit' });
    const ts = d.toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' });
    return `<div class="hi${isT ? ' htd' : ''}">
      <div class="hico">${icon}</div>
      <div>
        <div class="htype">${icon} ${label}${oilPart}</div>
        <div class="hkm">🏁 ${kmText}</div>
        <div class="hdate">${ds}${isT ? ' · ' + ts : ''}</div>
      </div>
    </div>`;
  }).join('');
}

function switchTab(name) {
  document.querySelectorAll('.tb').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tp').forEach(p => p.classList.toggle('active', p.id === name + '-tab'));
  if (name === 'history') loadHistory();
}
function getActiveModalTab() {
  return document.querySelector('.tb.active')?.dataset.tab || 'info';
}
document.querySelectorAll('.tb').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
document.getElementById('modal-close').addEventListener('click', () => document.getElementById('car-modal').classList.remove('active'));
document.querySelector('.mo').addEventListener('click', () => document.getElementById('car-modal').classList.remove('active'));

// ===== CAR ACTIONS =====
document.getElementById('btn-update-km').addEventListener('click', async () => {
  const km = parseInt(document.getElementById('modal-km').value);
  const dailyKm = parseInt(document.getElementById('modal-daily-km').value, 10);
  if (!km || km < 0) { showToast("❌ KM to'g'ri kiriting", 'error'); return; }
  if (!dailyKm || dailyKm < 1) { showToast("❌ Kunlik KM ni to'g'ri kiriting", 'error'); return; }
  busyStart();
  try {
    curCar.total_km = km;
    curCar.daily_km = dailyKm;
    await fbSaveCar(curCar);
    await loadFromBackend();
    curCar = allCars.find(c => String(c.id) === String(curCar.id)) || curCar;
    openModal({ tab: 'update' });
    loadDashboard();
    showToast('✅ Probeg yangilandi!', 'success');
  } catch (e) {
    showToast(`❌ ${e.message || "Probegni saqlab bo'lmadi"}`, 'error');
  } finally {
    busyEnd();
  }
});
document.getElementById('btn-update-daily-km').addEventListener('click', async () => {
  const dailyKm = parseInt(document.getElementById('modal-daily-km').value, 10);
  if (!dailyKm || dailyKm < 1) { showToast("❌ Kunlik KM ni to'g'ri kiriting", 'error'); return; }
  busyStart();
  try {
    curCar.daily_km = dailyKm;
    await fbSaveCar(curCar);
    await loadFromBackend();
    curCar = allCars.find(c => String(c.id) === String(curCar.id)) || curCar;
    openModal({ tab: 'update' });
    loadDashboard();
    showToast("✅ Kunlik KM saqlandi!", 'success');
  } catch (e) {
    showToast(`❌ ${e.message || "Kunlik KM ni saqlab bo'lmadi"}`, 'error');
  } finally {
    busyEnd();
  }
});

document.getElementById('btn-change-svc').addEventListener('click', async () => {
  const type = document.getElementById('modal-svc-type').value;
  const oilName = document.getElementById('modal-oil-select').value || curCar.oil_name;
  const km = parseInt(document.getElementById('modal-km').value) || curCar.total_km;
  const dailyKm = parseInt(document.getElementById('modal-daily-km').value, 10) || curCar.daily_km || 50;
  if (!dailyKm || dailyKm < 1) { showToast("❌ Kunlik KM ni to'g'ri kiriting", 'error'); return; }

  busyStart();
  try {
    curCar.total_km = km;
    curCar.daily_km = dailyKm;
    const field = { oil:'oil_change_km', antifreeze:'antifreeze_km', gearbox:'gearbox_km', air_filter:'air_filter_km', cabin_filter:'cabin_filter_km', oil_filter:'oil_filter_km' };
    if (field[type]) curCar[field[type]] = km;
    if (type === 'oil') curCar.oil_name = oilName;

    if (!curCar.history) curCar.history = [];
    curCar.history.push({ type, km, oil_name: type === 'oil' ? oilName : '', date: new Date().toISOString() });
    await fbSaveCar(curCar);

    let notice = "✅ Ma'lumot saqlandi";
    if (smsConfig.enabled && smsConfig.has_token && supportsSmsForService(type)) {
      const svcLabel = getServicePhrase(type, 'done', curCar);
      const r = await fetch(`${BACKEND_URL}/api/sms/service-change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ car: { ...curCar }, service_type: type }),
        signal: AbortSignal.timeout(12000),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.error || 'Xabar yuborilmadi');
      if (!data.skipped) notice = '✅ ' + svcLabel + ' · Xabar yuborildi!';
    }
    await loadFromBackend();
    curCar = allCars.find(c => String(c.id) === String(curCar.id)) || curCar;
    openModal({ tab: 'update' });
    showToast(notice, 'success');
  } catch (e) {
    showToast(`❌ ${e.message || "Saqlashda xato"}`, 'error');
  } finally {
    busyEnd();
  }
});

function openDeletePinModal() {
  if (!curCar) return;
  const modal = document.getElementById('delete-pin-modal');
  const title = document.getElementById('delete-pin-car-title');
  const text = document.getElementById('delete-pin-car-text');
  const input = document.getElementById('delete-pin-input');
  const status = document.getElementById('delete-pin-status');
  if (title) title.textContent = `${curCar.car_name || 'Mashina'} · ${curCar.car_number || ''}`.trim();
  if (text) text.textContent = "Ushbu mashina ma'lumotlar bazasidan butunlay o'chadi. O'chirish uchun kirish PIN kodini kiriting.";
  if (input) input.value = '';
  if (status) { status.textContent = ''; status.className = 'confirm-status'; }
  modal?.classList.add('active');
  setTimeout(() => input?.focus(), 30);
}
function closeDeletePinModal(options = {}) {
  const { clearInput = true, clearStatus = true } = options;
  const modal = document.getElementById('delete-pin-modal');
  const input = document.getElementById('delete-pin-input');
  const status = document.getElementById('delete-pin-status');
  const submit = document.getElementById('delete-pin-submit');
  const cancel = document.getElementById('delete-pin-cancel');
  modal?.classList.remove('active');
  if (clearInput && input) input.value = '';
  if (clearStatus && status) { status.textContent = ''; status.className = 'confirm-status'; }
  if (submit) submit.disabled = false;
  if (cancel) cancel.disabled = false;
}
async function submitDeletePin() {
  const input = document.getElementById('delete-pin-input');
  const status = document.getElementById('delete-pin-status');
  const submit = document.getElementById('delete-pin-submit');
  const cancel = document.getElementById('delete-pin-cancel');
  const pin = input?.value?.trim();
  const targetCarId = curCar?.id;
  if (!targetCarId) {
    closeDeletePinModal();
    showToast('❌ Mashina topilmadi', 'error');
    return;
  }
  if (!pin) {
    if (status) { status.textContent = 'PIN kodni kiriting'; status.className = 'confirm-status error'; }
    input?.focus();
    return;
  }
  if (submit) submit.disabled = true;
  if (cancel) cancel.disabled = true;
  if (status) { status.textContent = 'PIN tekshirilmoqda...'; status.className = 'confirm-status'; }
  busyStart();
  try {
    const verify = await apiJson(`${BACKEND_URL}/api/auth/verify-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    if (!verify.ok) throw new Error(verify.error || 'PIN xato');
    if (status) { status.textContent = "PIN to'g'ri. O'chirilmoqda..."; status.className = "confirm-status success"; }
    await fbDeleteCar(targetCarId);
    closeDeletePinModal();
    document.getElementById('car-modal')?.classList.remove('active');
    curCar = null;
    await reloadDataAfterChange("✅ Mashina o'chirildi!");
  } catch (e) {
    if (String(e?.message || '').includes('PIN talab qilinadi')) {
      closeDeletePinModal();
      showToast('❌ Sessiya yakunlangan. Qayta kiring.', 'error');
      return;
    }
    if (status) { status.textContent = e.message || 'PIN xato'; status.className = 'confirm-status error'; }
    if (submit) submit.disabled = false;
    if (cancel) cancel.disabled = false;
    input?.focus();
    input?.select?.();
  } finally {
    busyEnd();
  }
}
document.getElementById('btn-delete-car').addEventListener('click', () => {
  openDeletePinModal();
});
document.getElementById('delete-pin-cancel')?.addEventListener('click', () => closeDeletePinModal());
document.getElementById('delete-pin-close')?.addEventListener('click', () => closeDeletePinModal());
document.getElementById('delete-pin-overlay')?.addEventListener('click', () => closeDeletePinModal());
document.getElementById('delete-pin-submit')?.addEventListener('click', submitDeletePin);
document.getElementById('delete-pin-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitDeletePin();
  }
  if (e.key === 'Escape') closeDeletePinModal();
});

// ===== SETTINGS =====
document.getElementById('btn-settings').addEventListener('click', () => document.getElementById('settings-panel').classList.add('open'));
document.getElementById('close-settings').addEventListener('click', closeSettings);
document.getElementById('settings-overlay').addEventListener('click', closeSettings);
function closeSettings() { document.getElementById('settings-panel').classList.remove('open'); }

function removeAppSessionCache() {
  const keys = [];
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const key = sessionStorage.key(i);
    if (key && key.startsWith('mt_')) keys.push(key);
  }
  keys.forEach((key) => sessionStorage.removeItem(key));
}

async function saveThresholds() {
  const w = parseFloat(document.getElementById('setting-warn').value);
  const d = parseFloat(document.getElementById('setting-danger').value);
  WPCT = w/100; DPCT = d/100; cfg.warn_pct = w; cfg.danger_pct = d; saveCfg();
  busyStart();
  try {
    await apiOk(`${BACKEND_URL}/api/cfg`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
    await reloadDataAfterChange('✅ Saqlandi');
  } catch (e) {
    showToast(`❌ ${e.message || "Saqlashda xato"}`, 'error');
  } finally {
    busyEnd();
  }
}
function exportServiceReportRows(car) {
  const services = [
    { key: 'oil', label: 'Dvigatel moyi', icon: '🛢️', lastKm: car.oil_change_km, interval: oilInt(car.oil_name), extra: car.oil_name ? ` · ${car.oil_name}` : '' },
    { key: 'antifreeze', label: 'Antifriz', icon: '🧊', lastKm: car.antifreeze_km, interval: car.antifreeze_interval || 30000, extra: '' },
    { key: 'gearbox', label: 'Karobka moyi', icon: '⚙️', lastKm: car.gearbox_km, interval: car.gearbox_interval || 50000, extra: '' },
    { key: 'air_filter', label: 'Havo filtri', icon: '💨', lastKm: car.air_filter_km || car.total_km, interval: car.air_filter_interval || 15000, extra: '' },
    { key: 'cabin_filter', label: 'Salon filtri', icon: '🌬️', lastKm: car.cabin_filter_km || car.total_km, interval: car.cabin_filter_interval || 15000, extra: '' },
    { key: 'oil_filter', label: 'Moy filtri', icon: '🔩', lastKm: car.oil_filter_km || car.total_km, interval: car.oil_filter_interval || 10000, extra: '' },
  ];
  return services.map((svc) => {
    const used = Math.max(0, Number(car.total_km || 0) - Number(svc.lastKm || 0));
    const interval = Math.max(0, Number(svc.interval || 0));
    const remaining = Math.max(0, interval - used);
    const ratio = interval > 0 ? used / interval : 0;
    const state = ratio >= DPCT ? 'Muddat kelgan' : ratio >= WPCT ? 'Tez orada kerak' : 'Yaxshi';
    const stateClass = ratio >= DPCT ? 'danger' : ratio >= WPCT ? 'warn' : 'ok';
    return `
      <div class="service-row">
        <div class="service-main">
          <div class="service-name">${svc.icon} ${escHtml(svc.label)}${escHtml(svc.extra)}</div>
          <div class="service-meta">
            Oxirgi servis: ${Number(svc.lastKm || 0).toLocaleString('uz-UZ')} km
            <span>•</span>
            Interval: ${interval.toLocaleString('uz-UZ')} km
            <span>•</span>
            Sarflangan: ${used.toLocaleString('uz-UZ')} km
            <span>•</span>
            Qolgan: ${remaining.toLocaleString('uz-UZ')} km
          </div>
        </div>
        <div class="service-badge ${stateClass}">${state}</div>
      </div>`;
  }).join('');
}
function exportHistoryRows(car) {
  const history = Array.isArray(car.history) ? [...car.history].filter(Boolean) : [];
  history.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  if (!history.length) return '<div class="history-empty">Tarix yozuvlari hozircha yo‘q.</div>';
  return history.slice(0, 8).map((item) => {
    const meta = SVC_META[String(item.type || '').trim()] || {};
    const label = meta.label || 'Xizmat';
    const when = new Date(item.date || Date.now()).toLocaleString('uz-UZ');
    const oilPart = item.oil_name ? ` · ${escHtml(item.oil_name)}` : '';
    return `<div class="history-row">
      <strong>${meta.icon || '🔧'} ${escHtml(label)}${oilPart}</strong>
      <span>${Number(item.km || 0).toLocaleString('uz-UZ')} km · ${when}</span>
    </div>`;
  }).join('');
}
function buildExportHtml() {
  const createdAt = new Date().toLocaleString('uz-UZ');
  const counts = { urgent: 0, warning: 0, good: 0 };
  allCars.forEach((car) => {
    const state = carSt(car);
    if (state.cls === 'su') counts.urgent += 1;
    else if (state.cls === 'sw') counts.warning += 1;
    else counts.good += 1;
  });
  const carsHtml = allCars.length
    ? [...allCars]
      .sort((a, b) => String(a.car_name || '').localeCompare(String(b.car_name || ''), 'uz'))
      .map((car) => `
        <section class="car-card">
          <div class="car-head">
            <div>
              <h2>${escHtml(car.car_name || 'Nomsiz mashina')}</h2>
              <div class="car-sub">${escHtml(car.car_number || 'Raqam yo‘q')} · ${escHtml(car.phone_number || 'Telefon yo‘q')}</div>
            </div>
            <div class="car-km">${Number(car.total_km || 0).toLocaleString('uz-UZ')} km</div>
          </div>
          <div class="car-grid">
            <div class="info-box">
              <div class="ibox-title">Asosiy ma’lumot</div>
              <div class="kv"><span>Kunlik o‘rtacha yo‘l</span><strong>${Number(car.daily_km || 0).toLocaleString('uz-UZ')} km</strong></div>
              <div class="kv"><span>Moy turi</span><strong>${escHtml(car.oil_name || 'Kiritilmagan')}</strong></div>
              <div class="kv"><span>Qo‘shilgan sana</span><strong>${new Date(car.added_at || Date.now()).toLocaleString('uz-UZ')}</strong></div>
              <div class="kv"><span>Oxirgi yangilanish</span><strong>${new Date(car.updated_at || car.added_at || Date.now()).toLocaleString('uz-UZ')}</strong></div>
            </div>
            <div class="info-box">
              <div class="ibox-title">Servis holati</div>
              ${exportServiceReportRows(car)}
            </div>
          </div>
          <div class="history-box">
            <div class="ibox-title">Oxirgi tarix</div>
            ${exportHistoryRows(car)}
          </div>
        </section>`)
      .join('')
    : '<div class="empty-report">Hozircha mashina ma’lumotlari yo‘q.</div>';
  return `<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Avto Oil Beshariq Hisobot</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Segoe UI", Tahoma, sans-serif; background: #f4f1ea; color: #1f2937; }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 28px 18px 56px; }
    .hero { background: linear-gradient(135deg, #16324f, #295c7a); color: #fff; border-radius: 24px; padding: 28px; box-shadow: 0 18px 50px rgba(22, 50, 79, 0.18); }
    .hero h1 { margin: 0 0 10px; font-size: 32px; }
    .hero p { margin: 0; opacity: 0.92; line-height: 1.5; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin: 22px 0 26px; }
    .stat { background: #fff; border-radius: 18px; padding: 18px; box-shadow: 0 8px 24px rgba(31, 41, 55, 0.08); }
    .stat strong { display: block; font-size: 28px; margin-bottom: 6px; }
    .cars { display: grid; gap: 20px; }
    .car-card { background: #fff; border-radius: 22px; padding: 22px; box-shadow: 0 10px 28px rgba(31, 41, 55, 0.08); }
    .car-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 18px; }
    .car-head h2 { margin: 0 0 6px; font-size: 24px; }
    .car-sub { color: #5b6473; }
    .car-km { background: #eef6ff; color: #16324f; border-radius: 14px; padding: 10px 14px; font-weight: 700; white-space: nowrap; }
    .car-grid { display: grid; grid-template-columns: 1fr 1.4fr; gap: 18px; }
    .info-box, .history-box { background: #faf8f4; border: 1px solid #ebe5db; border-radius: 18px; padding: 16px; }
    .ibox-title { font-size: 15px; font-weight: 700; margin-bottom: 12px; color: #16324f; }
    .kv { display: flex; justify-content: space-between; gap: 14px; padding: 9px 0; border-bottom: 1px dashed #ddd4c8; }
    .kv:last-child { border-bottom: 0; }
    .kv span { color: #5b6473; }
    .service-row { display: flex; justify-content: space-between; gap: 14px; padding: 12px 0; border-bottom: 1px dashed #ddd4c8; }
    .service-row:last-child { border-bottom: 0; }
    .service-name { font-weight: 700; margin-bottom: 5px; }
    .service-meta { color: #5b6473; font-size: 13px; line-height: 1.5; }
    .service-meta span { margin: 0 6px; color: #b3aa9c; }
    .service-badge { align-self: flex-start; border-radius: 999px; padding: 7px 12px; font-size: 12px; font-weight: 700; }
    .service-badge.ok { background: #e7f7ed; color: #1f7a45; }
    .service-badge.warn { background: #fff2d9; color: #9a6700; }
    .service-badge.danger { background: #fde8e8; color: #b42318; }
    .history-row { display: flex; justify-content: space-between; gap: 14px; padding: 10px 0; border-bottom: 1px dashed #ddd4c8; }
    .history-row:last-child { border-bottom: 0; }
    .history-row span { color: #5b6473; text-align: right; }
    .history-empty, .empty-report { color: #6b7280; }
    @media (max-width: 820px) {
      .car-grid { grid-template-columns: 1fr; }
      .car-head, .history-row, .kv, .service-row { flex-direction: column; }
      .history-row span { text-align: left; }
      .car-km { white-space: normal; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <h1>Avto Oil Beshariq hisobot</h1>
      <p>Yaratilgan vaqt: ${escHtml(createdAt)}. Ushbu fayl mashinalar, ularning hozirgi probegi, servis holati va oxirgi tarix yozuvlarini oddiy ko‘rinishda ko‘rsatadi.</p>
    </section>
    <section class="stats">
      <div class="stat"><strong>${allCars.length}</strong>Jami mashina</div>
      <div class="stat"><strong>${counts.urgent}</strong>Shoshilinch e’tibor kerak</div>
      <div class="stat"><strong>${counts.warning}</strong>Tez orada servis kerak</div>
      <div class="stat"><strong>${counts.good}</strong>Holati yaxshi</div>
    </section>
    <section class="cars">${carsHtml}</section>
  </div>
</body>
</html>`;
}
function exportData() {
  const html = buildExportHtml();
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `moytrack-hisobot-${new Date().toISOString().slice(0, 10)}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  showToast('✅ Hisobot yuklab olindi', 'success');
}
async function logoutUser() {
  if (!confirm("Chiqishni tasdiqlaysizmi?")) return;
  busyStart();
  try {
    await apiOk(`${BACKEND_URL}/api/auth/logout`, { method: 'POST' });
    removeAppSessionCache();
    allCars = [];
    curCar = null;
    scheduledSmsItems = [];
    document.getElementById('car-modal')?.classList.remove('active');
    document.getElementById('pin-input').value = '';
    const status = document.getElementById('pin-status');
    if (status) { status.textContent = ''; status.className = 'pin-status'; }
    closeSettings();
    navigateTo('home');
    loadDashboard();
    loadCarsGrid();
    renderSmsLog([]);
    refreshScheduleList();
    lockApp();
    document.getElementById('pin-input')?.focus();
    showToast('✅ Chiqildi', 'success');
  } catch (e) {
    showToast(`❌ ${e.message || "Chiqib bo'lmadi"}`, 'error');
  } finally {
    busyEnd();
  }
}

// ===== TOAST =====
function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show ' + type;
  setTimeout(() => t.classList.remove('show'), 3000);
}


function refreshScheduleList() {
  const el = document.getElementById('scheduled-sms-list');
  if (!el) return;
  if (bootstrapLoading && !scheduledSmsItems.length) {
    el.innerHTML = loadingHtml('Rejalashtirilgan xabarlar yuklanmoqda...');
    return;
  }
  const items = [...scheduledSmsItems].sort((a, b) => new Date(b.scheduled_for || b.created_at || 0) - new Date(a.scheduled_for || a.created_at || 0));
  if (!items.length) {
    el.innerHTML = '<div class="sms-log-empty">⏰ Rejalashtirilgan SMS yo‘q</div>';
    return;
  }
  const statusMap = {
    pending: '🕒 Kutilmoqda',
    retry: '🔁 Qayta urinadi',
    processing: '⏳ Yuborilmoqda',
    sent: '✅ Yuborildi',
    delivered: '📬 Yetkazildi',
    failed: '❌ Xato',
    missed: '⚠️ O‘tkazib yuborildi',
    cancelled: '🚫 Bekor qilindi',
  };
  el.innerHTML = items.map(item => {
    const canCancel = ['pending', 'retry'].includes(item.status);
    const when = item.scheduled_for ? new Date(item.scheduled_for).toLocaleString('uz-UZ') : '—';
    const statusText = statusMap[item.status] || item.status || '—';
    const err = item.last_error ? `<div class="sched-sub">${escHtml(item.last_error)}</div>` : '';
    return `
      <div class="sched-item">
        <div>
          <div class="sched-title">📱 ${item.phone}</div>
          <div class="sched-sub">${when}</div>
          <div class="sched-sub">${statusText}</div>
          ${err}
        </div>
        ${canCancel ? `<button class="sched-del" onclick="cancelScheduledSms('${item.id}')">Bekor qilish</button>` : ''}
      </div>
    `;
  }).join('');
}
async function cancelScheduledSms(id) {
  try {
    await apiJson(`${BACKEND_URL}/api/sms/schedules/${id}`, { method: 'DELETE' });
    scheduledSmsItems = scheduledSmsItems.filter(item => item.id !== id);
    refreshScheduleList();
    showToast('✅ Reja bekor qilindi', 'success');
  } catch (e) {
    showToast('❌ Bekor qilib bo‘lmadi', 'error');
  }
}
document.getElementById('sms-log-search')?.addEventListener('input', () => renderSmsLog());

// ===== INIT =====
function init() {
  applyTheme();
  document.getElementById('setting-warn').value = cfg.warn_pct;
  document.getElementById('setting-danger').value = cfg.danger_pct;
  if (!DB.get('oils_init', false)) { saveOils(); DB.set('oils_init', true); }
  loadDashboard();
  renderOilSel('oil-name');
  const pinBtn = document.getElementById('pin-submit');
  const pinInput = document.getElementById('pin-input');
  pinBtn?.addEventListener('click', doPinLogin);
  pinInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doPinLogin(); });
  startAutoRefresh();
  checkAuth().then(async ok => {
    if (ok) { unlockApp(); await loadFromBackend(); }
    else { lockApp(); }
  });
}
init();
