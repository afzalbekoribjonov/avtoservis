require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT || 3001);
const FIREBASE_URL = String(process.env.FIREBASE_URL || 'https://gilamuz-8308f-default-rtdb.firebaseio.com').replace(/\/+$/, '');
const ALLOW_FIREBASE_REST_FALLBACK = String(process.env.ALLOW_FIREBASE_REST_FALLBACK || 'false').toLowerCase() === 'true';
const TZ = process.env.TZ || 'Asia/Tashkent';
const APP_PIN = String(process.env.APP_PIN || '7070');
const SESSION_SECRET = String(process.env.SESSION_SECRET || 'change-this-secret');
const COOKIE_NAME = 'mt_session';
const COOKIE_MAX_AGE_SEC = Number(process.env.SESSION_MAX_AGE_SEC || 60 * 60 * 12);
const AUTH_WINDOW_MS = Number(process.env.AUTH_WINDOW_MS || 10 * 60 * 1000);
const AUTH_MAX_ATTEMPTS = Number(process.env.AUTH_MAX_ATTEMPTS || 8);
const DEVSMS_BASE = 'https://devsms.uz/api';
const DEVSMS_TOKEN = String(process.env.DEVSMS_TOKEN || '').trim();
const AUTO_CHECK_MINUTES = Math.max(5, Number(process.env.AUTO_CHECK_MINUTES || 30));
const SCHEDULER_POLL_SECONDS = Math.max(15, Number(process.env.SCHEDULER_POLL_SECONDS || 30));
const QUEUE_PROCESSING_TIMEOUT_SEC = Math.max(60, Number(process.env.QUEUE_PROCESSING_TIMEOUT_SEC || 300));
const MAX_SEND_RETRIES = Math.max(0, Number(process.env.MAX_SEND_RETRIES || 3));
const RETRY_BASE_SECONDS = Math.max(15, Number(process.env.RETRY_BASE_SECONDS || 60));
const MAX_SCHEDULE_LAG_MINUTES = Math.max(0, Number(process.env.MAX_SCHEDULE_LAG_MINUTES || 1440));
const STATUS_SYNC_BATCH = Math.max(1, Math.min(20, Number(process.env.STATUS_SYNC_BATCH || 12)));
const STATUS_SYNC_SECONDS = Math.max(60, Number(process.env.STATUS_SYNC_SECONDS || 180));

let adminDb = null;
let adminReady = false;
function readServiceAccountValue() {
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  const fileEnv = String(process.env.FIREBASE_SERVICE_ACCOUNT_FILE || process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '').trim();
  const candidate = fileEnv || raw;
  if (!candidate) throw new Error('Firebase service account topilmadi');

  const looksLikePath = !!fileEnv || candidate.startsWith('./') || candidate.startsWith('../') || candidate.startsWith('/') || candidate.toLowerCase().endsWith('.json');
  if (looksLikePath) {
    const fullPath = path.isAbsolute(candidate) ? candidate : path.join(__dirname, candidate);
    if (!fs.existsSync(fullPath)) throw new Error(`Firebase fayli topilmadi: ${fullPath}`);
    return fs.readFileSync(fullPath, 'utf8');
  }
  return candidate;
}
function initFirebaseAdmin() {
  if (adminReady) return adminDb;
  adminReady = true;
  try {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      const rawValue = readServiceAccountValue();
      const serviceAccount = JSON.parse(rawValue);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: FIREBASE_URL,
      });
    }
    adminDb = require('firebase-admin/database').getDatabase();
  } catch (e) {
    adminDb = null;
    if (ALLOW_FIREBASE_REST_FALLBACK) {
      console.warn('[firebase] Admin SDK ishga tushmadi, vaqtinchalik REST fallback ishlatiladi:', e.message);
    } else {
      console.error('[firebase] Admin SDK ishga tushmadi. Production uchun FIREBASE_SERVICE_ACCOUNT_JSON yoki FIREBASE_SERVICE_ACCOUNT_FILE majburiy:', e.message);
    }
  }
  return adminDb;
}
initFirebaseAdmin();

const APPROVED_TEMPLATES = {
  service_done: `Hurmatli mijoz,
{car_name} ({car_number}) avtomobili bo'yicha quyidagi ma'lumot qayd etildi: "{service_name}"
Sana: {date}
Joriy probeg: {km} km`,
  service_reminder: `Hurmatli mijoz, {car_name} ({car_number}) avtomobili bo'yicha {service_name} tavsiya etiladi.
Sana: {date}.
Joriy probeg: {km} km.
Manzil: Avto Oil Beshariq, mo'ljal: tekstil yonida`,
};
const DEFAULT_SMS = {
  enabled: true,
  test_phone: '',
  sms_sent_count: 0,
  service_done_message: APPROVED_TEMPLATES.service_done,
  service_due_message: APPROVED_TEMPLATES.service_reminder,
};
const DEFAULT_CFG = { warn_pct: 80, danger_pct: 100, theme: 'dark' };
const DEFAULT_OILS = [
  { id: 1, name: 'SAE 5W-30', interval: 10000 },
  { id: 2, name: 'SAE 5W-40', interval: 7000 },
  { id: 3, name: 'SAE 10W-40', interval: 8000 },
];
const SVC_META = {
  oil: { icon: '🛢️', label: 'Moy' },
  antifreeze: { icon: '🧊', label: 'Antifriz' },
  gearbox: { icon: '⚙️', label: 'Karobka moyi' },
  air_filter: { icon: '💨', label: 'Havo filtri' },
  cabin_filter: { icon: '🌬️', label: 'Salon filtri' },
  oil_filter: { icon: '🔩', label: 'Moy filtri' },
};

const authAttempts = new Map();
const workerState = { queueRunning: false, autoRunning: false, statusRunning: false, lastKickAt: 0 };

function dtf(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date).replace(' ', 'T');
}
function nowDate() { return dtf().slice(0, 10).split('-').reverse().join('.'); }
function nowTime() { return dtf().slice(11, 16); }
function nowIso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function parseMaybeNumber(v, fallback = 0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function cleanPhone(phone = '') { return String(phone).replace(/\D/g, ''); }
function normalizeUzPhone(phone = '') {
  const p = cleanPhone(phone);
  if (p.startsWith('998') && p.length === 12) return p;
  if (p.length === 9) return '998' + p;
  return p;
}
function maskedToken(token = '') {
  if (!token) return '';
  if (token.length <= 8) return '••••••••';
  return `${token.slice(0, 4)}••••${token.slice(-4)}`;
}

function getValidCallbackUrl() {
  const raw = String(process.env.SMS_CALLBACK_URL || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const host = String(u.hostname || '').toLowerCase();
    if (!['http:', 'https:'].includes(u.protocol)) return '';
    if (!host || host === 'example.com' || host.endsWith('.example.com') || host.includes('your-domain')) return '';
    if (host === 'localhost' || host.startsWith('127.') || host.endsWith('.local')) return '';
    return u.toString();
  } catch {
    return '';
  }
}
function objectValuesSorted(data) {
  if (!data || typeof data !== 'object') return [];
  return Object.values(data).filter(Boolean);
}
function stableId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}
function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}
function makeSessionCookie() {
  const issued = Date.now();
  const exp = issued + (COOKIE_MAX_AGE_SEC * 1000);
  const nonce = crypto.randomBytes(12).toString('hex');
  const payload = `${issued}.${exp}.${nonce}`;
  return `${payload}.${sign(payload)}`;
}
function verifySessionCookie(raw = '') {
  const parts = String(raw).split('.');
  if (parts.length < 4) return false;
  const payload = `${parts[0]}.${parts[1]}.${parts[2]}`;
  if (sign(payload) !== parts[3]) return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  return true;
}
function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
function setCookie(res, name, value, maxAgeSec = COOKIE_MAX_AGE_SEC) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
function getRequesterIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return String(Array.isArray(xf) ? xf[0] : (xf || req.ip || req.socket?.remoteAddress || 'unknown')).split(',')[0].trim();
}
function isTransientStatus(status) { return status === 408 || status === 425 || status === 429 || status >= 500; }
function isTransientError(err = '') {
  const s = String(err || '').toLowerCase();
  return s.includes('timeout') || s.includes('tempor') || s.includes('network') || s.includes('fetch') || s.includes('econn') || s.includes('429');
}
function normalizeProviderStatus(status = '') {
  const raw = String(status || '').trim();
  const s = raw.toLowerCase();
  if (!s) return '';
  if (['accepted', 'sent'].includes(s)) return 'sent';
  if (['delivered'].includes(s)) return 'delivered';
  if (['rejected', 'undeliverable', 'failed', 'error'].includes(s)) return 'failed';
  if (['waiting', 'pending', 'queued', 'processing'].includes(s)) return 'waiting';
  return s;
}
function queueRetryDelayMs(attempt) {
  const clamped = Math.max(0, attempt - 1);
  return RETRY_BASE_SECONDS * 1000 * Math.min(16, 2 ** clamped);
}
function requireAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie || '');
  if (!verifySessionCookie(cookies[COOKIE_NAME])) {
    return res.status(401).json({ ok: false, error: 'PIN talab qilinadi' });
  }
  next();
}
function scheduleWorkerKick() {
  const now = Date.now();
  if (now - workerState.lastKickAt < 2000) return;
  workerState.lastKickAt = now;
  setTimeout(() => { processScheduledQueue().catch(console.error); }, 25);
  setTimeout(() => { syncRecentStatuses().catch(console.error); }, 50);
}

async function fbGet(p) {
  const db = initFirebaseAdmin();
  if (db) {
    try {
      const snap = await db.ref(p).get();
      return { ok: true, status: 200, data: snap.exists() ? snap.val() : null };
    } catch (e) { return { ok: false, status: 0, error: e.message, data: null }; }
  }
  if (!ALLOW_FIREBASE_REST_FALLBACK) return { ok: false, status: 0, error: 'Firebase Admin SDK ulanmagan', data: null };
  try {
    const r = await fetch(`${FIREBASE_URL}/${p}.json`);
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data };
  } catch (e) { return { ok: false, status: 0, error: e.message, data: null }; }
}
async function fbPut(p, body) {
  const db = initFirebaseAdmin();
  if (db) {
    try {
      await db.ref(p).set(body);
      return { ok: true, status: 200, data: body };
    } catch (e) { return { ok: false, status: 0, error: e.message, data: null }; }
  }
  if (!ALLOW_FIREBASE_REST_FALLBACK) return { ok: false, status: 0, error: 'Firebase Admin SDK ulanmagan', data: null };
  try {
    const r = await fetch(`${FIREBASE_URL}/${p}.json`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data };
  } catch (e) { return { ok: false, status: 0, error: e.message, data: null }; }
}
async function fbPatch(p, body) {
  const db = initFirebaseAdmin();
  if (db) {
    try {
      await db.ref(p).update(body);
      return { ok: true, status: 200, data: body };
    } catch (e) { return { ok: false, status: 0, error: e.message, data: null }; }
  }
  if (!ALLOW_FIREBASE_REST_FALLBACK) return { ok: false, status: 0, error: 'Firebase Admin SDK ulanmagan', data: null };
  try {
    const r = await fetch(`${FIREBASE_URL}/${p}.json`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data };
  } catch (e) { return { ok: false, status: 0, error: e.message, data: null }; }
}
async function fbDelete(p) {
  const db = initFirebaseAdmin();
  if (db) {
    try {
      await db.ref(p).remove();
      return { ok: true, status: 200 };
    } catch (e) { return { ok: false, status: 0, error: e.message }; }
  }
  if (!ALLOW_FIREBASE_REST_FALLBACK) return { ok: false, status: 0, error: 'Firebase Admin SDK ulanmagan', data: null };
  try {
    const r = await fetch(`${FIREBASE_URL}/${p}.json`, { method: 'DELETE' });
    return { ok: r.ok, status: r.status };
  } catch (e) { return { ok: false, status: 0, error: e.message }; }
}



function normalizeHistoryItems(history = [], fallbackKm = 0, fallbackDate = '') {
  return Array.isArray(history)
    ? history.map((h) => ({
        type: String(h?.type || '').trim(),
        km: parseMaybeNumber(h?.km, fallbackKm),
        oil_name: h?.oil_name ? String(h.oil_name).trim() : '',
        date: h?.date || fallbackDate || nowIso(),
      })).filter((h) => h.type)
    : [];
}
function normalizeLoadedCar(body = {}) {
  const total_km = parseMaybeNumber(body.total_km, 0);
  return {
    ...body,
    id: body.id ?? Date.now(),
    car_name: String(body.car_name || '').trim(),
    car_number: String(body.car_number || '').trim().toUpperCase(),
    phone_number: normalizeUzPhone(body.phone_number || ''),
    total_km,
    oil_name: String(body.oil_name || '').trim(),
    daily_km: parseMaybeNumber(body.daily_km, 50),
    oil_change_km: parseMaybeNumber(body.oil_change_km, total_km),
    antifreeze_km: parseMaybeNumber(body.antifreeze_km, total_km),
    antifreeze_interval: parseMaybeNumber(body.antifreeze_interval, 30000),
    gearbox_km: parseMaybeNumber(body.gearbox_km, total_km),
    gearbox_interval: parseMaybeNumber(body.gearbox_interval, 50000),
    air_filter_km: parseMaybeNumber(body.air_filter_km, total_km),
    air_filter_interval: parseMaybeNumber(body.air_filter_interval, 15000),
    cabin_filter_km: parseMaybeNumber(body.cabin_filter_km, total_km),
    cabin_filter_interval: parseMaybeNumber(body.cabin_filter_interval, 15000),
    oil_filter_km: parseMaybeNumber(body.oil_filter_km, total_km),
    oil_filter_interval: parseMaybeNumber(body.oil_filter_interval, 10000),
    history: normalizeHistoryItems(body.history, total_km, body.added_at || body.updated_at || nowIso()),
    added_at: body.added_at || nowIso(),
    updated_at: body.updated_at || body.added_at || nowIso(),
  };
}

function assertStorageResult(result, action = 'Saqlash') {
  if (!result || result.ok !== true) {
    const err = new Error(result?.error || `${action} amalga oshmadi`);
    err.status = result?.status || 500;
    throw err;
  }
  return result;
}

async function getCars() {
  const r = await fbGet('cars');
  const cars = objectValuesSorted(r.data).map((c) => normalizeLoadedCar(c));
  return { ok: r.ok, cars };
}
async function getOils() {
  const r = await fbGet('oils');
  let oils = objectValuesSorted(r.data).map((o) => ({ ...o, id: parseMaybeNumber(o.id, o.id), interval: parseMaybeNumber(o.interval, 10000) }));
  if (!oils.length) {
    await Promise.all(DEFAULT_OILS.map((o) => fbPut(`oils/oil_${o.id}`, o)));
    oils = [...DEFAULT_OILS];
  }
  return { ok: true, oils };
}
async function getSmsConfig() {
  const r = await fbGet('sms_config');
  const legacy = r.data || {};
  const config = {
    ...DEFAULT_SMS,
    ...legacy,
    devsms_token: String(DEVSMS_TOKEN || legacy.devsms_token || '').trim(),
  };
  config.service_done_message = APPROVED_TEMPLATES.service_done;
  config.service_due_message = APPROVED_TEMPLATES.service_reminder;
  return { ok: true, config };
}
async function getCfg() {
  const r = await fbGet('cfg');
  return { ok: true, cfg: { ...DEFAULT_CFG, ...(r.data || {}) } };
}
function resolveDevSmsToken(config = {}) {
  return String(DEVSMS_TOKEN || config.devsms_token || '').trim();
}
function publicSmsConfig(config) {
  return {
    ...config,
    devsms_token: '',
    has_token: !!resolveDevSmsToken(config),
    masked_token: resolveDevSmsToken(config) ? maskedToken(resolveDevSmsToken(config)) : '',
  };
}
function sanitizeCar(body = {}) {
  const total_km = parseMaybeNumber(body.total_km, 0);
  return {
    id: body.id ?? Date.now(),
    car_name: String(body.car_name || '').trim(),
    car_number: String(body.car_number || '').trim().toUpperCase(),
    phone_number: normalizeUzPhone(body.phone_number || ''),
    total_km,
    oil_name: String(body.oil_name || '').trim(),
    daily_km: parseMaybeNumber(body.daily_km, 50),
    oil_change_km: parseMaybeNumber(body.oil_change_km, total_km),
    antifreeze_km: parseMaybeNumber(body.antifreeze_km, total_km),
    antifreeze_interval: parseMaybeNumber(body.antifreeze_interval, 30000),
    gearbox_km: parseMaybeNumber(body.gearbox_km, total_km),
    gearbox_interval: parseMaybeNumber(body.gearbox_interval, 50000),
    air_filter_km: parseMaybeNumber(body.air_filter_km, total_km),
    air_filter_interval: parseMaybeNumber(body.air_filter_interval, 15000),
    cabin_filter_km: parseMaybeNumber(body.cabin_filter_km, total_km),
    cabin_filter_interval: parseMaybeNumber(body.cabin_filter_interval, 15000),
    oil_filter_km: parseMaybeNumber(body.oil_filter_km, total_km),
    oil_filter_interval: parseMaybeNumber(body.oil_filter_interval, 10000),
    history: normalizeHistoryItems(body.history, total_km, body.added_at || nowIso()),
    added_at: body.added_at || nowIso(),
    updated_at: nowIso(),
  };
}
function sanitizeOil(body = {}) {
  return { id: body.id ?? Date.now(), name: String(body.name || '').trim(), interval: parseMaybeNumber(body.interval, 10000) };
}
function replaceCommonPlaceholders(tmpl, car, serviceName = '') {
  return String(tmpl || '')
    .replace(/{car_name}/g, car.car_name || '')
    .replace(/{car_number}/g, car.car_number || '')
    .replace(/{km}/g, String(parseMaybeNumber(car.total_km, 0)))
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
function buildApprovedServiceDoneMessage(car, serviceName) {
  return replaceCommonPlaceholders(APPROVED_TEMPLATES.service_done, car, serviceName).trim();
}
function buildApprovedServiceReminderMessage(car, serviceName) {
  return replaceCommonPlaceholders(APPROVED_TEMPLATES.service_reminder, car, serviceName).trim();
}

function estimateDaysUntilDue(remainingKm, dailyKm) {
  const d = parseMaybeNumber(dailyKm, 0);
  if (!(remainingKm > 0)) return 0;
  if (!(d > 0)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.ceil(remainingKm / d));
}
function addDaysIso(dateIso, days) {
  const d = new Date(dateIso || Date.now());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}
function getAutoDueState(car, svc, oils) {
  const interval = svc.key === 'oil' ? oilIntervalByName(oils, car.oil_name) : svc.interval;
  const used = parseMaybeNumber(svc.used, 0);
  const remainingKm = Math.max(0, parseMaybeNumber(interval, 0) - used);
  const daysUntilDue = estimateDaysUntilDue(remainingKm, car.daily_km);
  const baseDate = car.updated_at || car.added_at || nowIso();
  const estimated_due_at = Number.isFinite(daysUntilDue) ? addDaysIso(baseDate, daysUntilDue) : '';
  const estimatedTs = estimated_due_at ? new Date(estimated_due_at).getTime() : NaN;
  return {
    interval,
    used,
    remainingKm,
    daysUntilDue,
    estimated_due_at,
    due_by_km: interval > 0 && used / interval >= 1,
    due_by_estimate: Number.isFinite(estimatedTs) && estimatedTs <= Date.now(),
  };
}
function sanitizeQueueItem(item = {}) {
  return {
    ...item,
    phone: normalizeUzPhone(item.phone || ''),
    message: String(item.message || '').trim(),
    status: String(item.status || 'pending'),
    attempt_count: parseMaybeNumber(item.attempt_count, 0),
    scheduled_for: item.scheduled_for || nowIso(),
    created_at: item.created_at || nowIso(),
    next_attempt_at: item.next_attempt_at || item.scheduled_for || nowIso(),
    request_id: item.request_id || '',
    sms_id: item.sms_id || '',
    last_error: item.last_error || '',
  };
}
async function getQueue() {
  const r = await fbGet('sms_queue');
  const items = objectValuesSorted(r.data).map(sanitizeQueueItem);
  items.sort((a, b) => new Date(a.next_attempt_at || a.scheduled_for || 0) - new Date(b.next_attempt_at || b.scheduled_for || 0));
  return items;
}
async function upsertQueue(item) {
  const normalized = sanitizeQueueItem(item);
  await fbPut(`sms_queue/${normalized.id}`, normalized);
  return normalized;
}
async function saveSmsLog(entry, explicitId = '') {
  const id = explicitId || stableId('sms');
  const payload = {
    id,
    provider_status: entry.provider_status || '',
    queue_status: entry.queue_status || '',
    type: entry.type || 'direct',
    phone: normalizeUzPhone(entry.phone || ''),
    message: String(entry.message || '').trim(),
    ok: entry.ok !== false,
    error: entry.error || '',
    request_id: entry.request_id || '',
    sms_id: entry.sms_id || '',
    status_checked_at: entry.status_checked_at || '',
    car_name: entry.car_name || '',
    service_key: entry.service_key || '',
    service_type: entry.service_type || '',
    queue_id: entry.queue_id || '',
    callback_status: entry.callback_status || '',
    callback_payload: entry.callback_payload || null,
    devsms_response: entry.devsms_response || null,
    timestamp: entry.timestamp || nowIso(),
    date: entry.date || nowDate(),
    time: entry.time || nowTime(),
  };
  await fbPut(`sms_logs/${id}`, payload);
  if (payload.request_id || payload.sms_id) {
    await saveProviderIndex(payload, id);
  }
  return payload;
}
async function patchSmsLog(id, patch = {}) {
  if (!id) return null;
  const current = await fbGet(`sms_logs/${id}`);
  const next = { ...(current.data || {}), ...patch, id };
  await fbPut(`sms_logs/${id}`, next);
  if (next.request_id || next.sms_id) await saveProviderIndex(next, id);
  return next;
}
async function saveProviderIndex(log, logId) {
  const queueId = log.queue_id || '';
  if (log.request_id) await fbPut(`sms_provider_index/request_${log.request_id}`, { log_id: logId, queue_id: queueId, updated_at: nowIso() });
  if (log.sms_id) await fbPut(`sms_provider_index/sms_${log.sms_id}`, { log_id: logId, queue_id: queueId, updated_at: nowIso() });
}
async function findProviderIndex({ request_id = '', sms_id = '' }) {
  if (request_id) {
    const a = await fbGet(`sms_provider_index/request_${request_id}`);
    if (a.data) return a.data;
  }
  if (sms_id) {
    const b = await fbGet(`sms_provider_index/sms_${sms_id}`);
    if (b.data) return b.data;
  }
  return null;
}
async function incrementSmsCount(add = 1) {
  const { config } = await getSmsConfig();
  const next = parseMaybeNumber(config.sms_sent_count, 0) + add;
  await fbPatch('sms_config', { sms_sent_count: next, updated_at: nowIso() });
  return next;
}
async function updateQueueStatus(queueId, patch = {}) {
  if (!queueId) return null;
  const current = await fbGet(`sms_queue/${queueId}`);
  if (!current.data) return null;
  const merged = { ...current.data, ...patch, id: queueId, updated_at: nowIso() };
  await fbPut(`sms_queue/${queueId}`, merged);
  return merged;
}

async function sendDevSms({ phone, message, from, callback_url, type }, token) {
  if (!token) return { ok: false, error: 'DevSMS token kiritilmagan', status: 0, data: null };
  const payload = { phone: normalizeUzPhone(phone), message: String(message || '').trim() };
  if (from) payload.from = from;
  if (callback_url) payload.callback_url = callback_url;
  if (type) payload.type = type;
  try {
    const r = await fetch(`${DEVSMS_BASE}/send_sms.php`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    const ok = !!(r.ok && data.success !== false);
    return {
      ok,
      status: r.status,
      data,
      provider_status: normalizeProviderStatus(data?.data?.status || data?.status || ''),
      request_id: data?.data?.request_id || data?.request_id || '',
      sms_id: String(data?.data?.sms_id || data?.data?.id || data?.sms_id || data?.id || ''),
      error: ok ? '' : (data.error || data.message || `HTTP ${r.status}`),
    };
  } catch (e) {
    return { ok: false, status: 0, data: null, provider_status: '', request_id: '', sms_id: '', error: e.message };
  }
}
async function verifyDevSmsToken(token) {
  try {
    const r = await fetch(`${DEVSMS_BASE}/get_balance.php`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await r.json().catch(() => ({}));
    const ok = !!(r.ok && data.success !== false);
    const balance = data?.data?.balance ?? data?.balance ?? data?.data?.amount ?? data?.amount ?? null;
    return { ok, status: r.status, balance, data };
  } catch (e) {
    return { ok: false, status: 0, error: e.message, data: null, balance: null };
  }
}
async function getDevSmsStatus({ request_id = '', sms_id = '' }, token) {
  if (!token) return { ok: false, error: 'DevSMS token kiritilmagan' };
  const query = request_id ? `request_id=${encodeURIComponent(request_id)}` : `sms_id=${encodeURIComponent(sms_id)}`;
  try {
    const r = await fetch(`${DEVSMS_BASE}/get_status.php?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await r.json().catch(() => ({}));
    const ok = !!(r.ok && data.success !== false);
    return {
      ok,
      status: r.status,
      data,
      provider_status: normalizeProviderStatus(data?.data?.status || data?.status || ''),
      error: ok ? '' : (data.error || data.message || `HTTP ${r.status}`),
      request_id: data?.data?.eskiz_request_id || data?.data?.request_id || request_id || '',
      sms_id: String(data?.data?.id || data?.data?.sms_id || sms_id || ''),
    };
  } catch (e) {
    return { ok: false, status: 0, data: null, provider_status: '', error: e.message, request_id, sms_id };
  }
}
async function sendMessageWithConfig({ phone, message, type = 'direct', meta = {} }) {
  const { config } = await getSmsConfig();
  const activeToken = resolveDevSmsToken(config);
  if (!config.enabled) return { ok: false, error: 'SMS o‘chirilgan', status: 0, data: null };
  if (!activeToken) return { ok: false, error: 'SMS xizmati sozlanmagan', status: 0, data: null };
  const callbackUrl = getValidCallbackUrl();
  const sent = await sendDevSms({ phone, message, callback_url: callbackUrl || undefined }, activeToken);
  const log = await saveSmsLog({
    type,
    phone,
    message,
    ok: sent.ok,
    error: sent.error || '',
    request_id: sent.request_id,
    sms_id: sent.sms_id,
    provider_status: sent.provider_status || (sent.ok ? 'sent' : ''),
    devsms_response: sent.data || null,
    ...meta,
  });
  if (sent.ok) await incrementSmsCount(1);
  return { ...sent, log_id: log.id };
}

function oilIntervalByName(oils, name) {
  return objectValuesSorted(oils).find((o) => o.name === name)?.interval || 10000;
}
async function processAutoReminders() {
  if (workerState.autoRunning) return;
  workerState.autoRunning = true;
  try {
    const { config } = await getSmsConfig();
    const activeToken = resolveDevSmsToken(config);
    if (!config.enabled || !activeToken) return;
    const cars = (await getCars()).cars;
    const oils = (await getOils()).oils;
    const dateKey = nowDate();
    for (const car of cars) {
      if (!car.phone_number) continue;
      const checks = [
        { key: 'oil', used: (car.total_km - car.oil_change_km), interval: oilIntervalByName(oils, car.oil_name) },
        { key: 'gearbox', used: (car.total_km - car.gearbox_km), interval: car.gearbox_interval || 50000 },
      ];
      for (const svc of checks) {
        const dueState = getAutoDueState(car, svc, oils);
        if (!(dueState.due_by_km || dueState.due_by_estimate)) continue;
        const reminderKey = `${dateKey}_${car.id}_${svc.key}`;
        const exists = await fbGet(`auto_sms_sent/${reminderKey}`);
        if (exists.ok && exists.data) continue;
        const serviceName = getServicePhrase(svc.key, 'due', car);
        const text = buildApprovedServiceReminderMessage(car, serviceName);
        const sent = await sendMessageWithConfig({ phone: car.phone_number, message: text, type: 'auto_check', meta: { service_key: svc.key, car_name: car.car_name, estimated_due_at: dueState.estimated_due_at, remaining_km: dueState.remainingKm } });
        if (sent.ok) await fbPut(`auto_sms_sent/${reminderKey}`, { id: reminderKey, car_id: car.id, service_key: svc.key, created_at: nowIso() });
        await sleep(250);
      }
    }
  } finally {
    workerState.autoRunning = false;
  }
}
async function processScheduledQueue() {
  if (workerState.queueRunning) return;
  workerState.queueRunning = true;
  try {
    const items = await getQueue();
    const now = Date.now();
    const staleBefore = now - (QUEUE_PROCESSING_TIMEOUT_SEC * 1000);
    for (const item of items) {
      if (!['pending', 'retry', 'processing'].includes(item.status)) continue;
      const scheduledTs = new Date(item.scheduled_for || 0).getTime();
      const nextAttemptTs = new Date(item.next_attempt_at || item.scheduled_for || 0).getTime();
      const pickedTs = new Date(item.picked_at || 0).getTime();

      if (item.status === 'processing' && pickedTs && pickedTs > staleBefore) continue;
      if (!Number.isFinite(scheduledTs)) continue;
      if (now < nextAttemptTs) continue;
      if (now < scheduledTs) continue;

      const lagMinutes = (now - scheduledTs) / 60000;
      if (MAX_SCHEDULE_LAG_MINUTES > 0 && lagMinutes > MAX_SCHEDULE_LAG_MINUTES) {
        await upsertQueue({ ...item, status: 'missed', processed_at: nowIso(), last_error: 'Backend uzoq vaqt uxlagani uchun yuborilmadi' });
        await saveSmsLog({ type: 'scheduled', phone: item.phone, message: item.message, ok: false, error: 'Schedule muddati o‘tib ketgan', provider_status: 'missed', queue_status: 'missed', queue_id: item.id, car_name: item.car_name || '' });
        continue;
      }

      const locked = await upsertQueue({
        ...item,
        status: 'processing',
        picked_at: nowIso(),
        attempt_count: parseMaybeNumber(item.attempt_count, 0) + 1,
        queue_status: 'processing',
      });

      const sent = await sendMessageWithConfig({ phone: item.phone, message: item.message, type: 'scheduled', meta: { queue_id: item.id, car_name: item.car_name || '', queue_status: 'processing' } });
      if (sent.ok) {
        await upsertQueue({
          ...locked,
          status: 'sent',
          processed_at: nowIso(),
          request_id: sent.request_id,
          sms_id: sent.sms_id,
          last_error: '',
          last_log_id: sent.log_id,
          provider_status: sent.provider_status || 'sent',
          queue_status: 'sent',
        });
        if (sent.log_id) await patchSmsLog(sent.log_id, { queue_status: 'sent', provider_status: sent.provider_status || 'sent', queue_id: item.id, error: '' });
      } else {
        const shouldRetry = (locked.attempt_count <= MAX_SEND_RETRIES) && (isTransientStatus(sent.status || 0) || isTransientError(sent.error || ''));
        const nextStatus = shouldRetry ? 'retry' : 'failed';
        const nextAttempt = shouldRetry ? new Date(Date.now() + queueRetryDelayMs(locked.attempt_count)).toISOString() : '';
        await upsertQueue({
          ...locked,
          status: nextStatus,
          processed_at: nowIso(),
          next_attempt_at: nextAttempt || locked.next_attempt_at,
          last_error: sent.error || 'SMS yuborilmadi',
          last_log_id: sent.log_id || locked.last_log_id || '',
          provider_status: sent.provider_status || '',
          queue_status: nextStatus,
        });
        if (sent.log_id) await patchSmsLog(sent.log_id, { queue_status: nextStatus, provider_status: sent.provider_status || '', queue_id: item.id });
      }
      await sleep(250);
    }
  } finally {
    workerState.queueRunning = false;
  }
}
async function syncRecentStatuses() {
  if (workerState.statusRunning) return;
  workerState.statusRunning = true;
  try {
    const { config } = await getSmsConfig();
    const activeToken = resolveDevSmsToken(config);
    if (!config.enabled || !activeToken) return;
    const logSnap = await fbGet('sms_logs');
    const logs = objectValuesSorted(logSnap.data)
      .filter((l) => (l.request_id || l.sms_id) && !['delivered', 'failed'].includes(l.provider_status || l.callback_status || ''))
      .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
      .slice(0, STATUS_SYNC_BATCH);
    for (const log of logs) {
      const checkedTs = new Date(log.status_checked_at || 0).getTime();
      if (checkedTs && (Date.now() - checkedTs) < STATUS_SYNC_SECONDS * 1000) continue;
      const status = await getDevSmsStatus({ request_id: log.request_id, sms_id: log.sms_id }, activeToken);
      if (status.ok && status.provider_status) {
        await patchSmsLog(log.id, {
          provider_status: status.provider_status,
          status_checked_at: nowIso(),
          error: status.provider_status === 'failed' ? 'Yetkazilmadi' : '',
        });
        if (log.queue_id) {
          const queueStatus = ['delivered', 'failed'].includes(status.provider_status) ? status.provider_status : 'sent';
          await updateQueueStatus(log.queue_id, {
            provider_status: status.provider_status,
            queue_status: queueStatus,
            delivered_at: status.data?.data?.delivered_at || '',
            failed_at: status.data?.data?.failed_at || '',
            status_checked_at: nowIso(),
          });
        }
      } else {
        await patchSmsLog(log.id, { status_checked_at: nowIso() });
      }
      await sleep(200);
    }
  } finally {
    workerState.statusRunning = false;
  }
}

app.get('/health', async (req, res) => {
  const auth = verifySessionCookie(parseCookies(req.headers.cookie || '')[COOKIE_NAME]);
  const queue = await getQueue().catch(() => []);
  const queuePending = queue.filter((q) => ['pending', 'retry', 'processing'].includes(q.status)).length;
  res.json({
    ok: true,
    service: 'MoyTrack Backend',
    version: '8.0',
    time: nowIso(),
    timezone: TZ,
    authenticated: auth,
    render_hint: 'Free sleep bo‘lsa schedule uyg‘onganda davom etadi',
    scheduler: {
      poll_seconds: SCHEDULER_POLL_SECONDS,
      auto_check_minutes: AUTO_CHECK_MINUTES,
      queue_pending: queuePending,
      queue_running: workerState.queueRunning,
      auto_running: workerState.autoRunning,
      status_running: workerState.statusRunning,
    },
  });
});

app.post('/api/auth/login', (req, res) => {
  const ip = getRequesterIp(req);
  const attempts = authAttempts.get(ip) || [];
  const fresh = attempts.filter((ts) => (Date.now() - ts) < AUTH_WINDOW_MS);
  if (fresh.length >= AUTH_MAX_ATTEMPTS) {
    return res.status(429).json({ ok: false, error: 'Juda ko‘p urinish. Birozdan keyin qayta urinib ko‘ring.' });
  }
  const pin = String(req.body?.pin || '').trim();
  if (pin !== APP_PIN) {
    fresh.push(Date.now());
    authAttempts.set(ip, fresh);
    return res.status(401).json({ ok: false, error: 'PIN xato' });
  }
  authAttempts.delete(ip);
  setCookie(res, COOKIE_NAME, makeSessionCookie());
  res.json({ ok: true });
});
app.get('/api/auth/me', (req, res) => {
  const cookies = parseCookies(req.headers.cookie || '');
  res.json({ ok: verifySessionCookie(cookies[COOKIE_NAME]) });
});
app.post('/api/auth/logout', (req, res) => {
  clearCookie(res, COOKIE_NAME);
  res.json({ ok: true });
});

app.post('/api/sms/callback', async (req, res) => {
  const payload = req.body || {};
  const status = normalizeProviderStatus(payload.status || '');
  const request_id = String(payload.request_id || '');
  const sms_id = String(payload.sms_id || '');
  const found = await findProviderIndex({ request_id, sms_id });
  if (found?.log_id) {
    await patchSmsLog(found.log_id, {
      provider_status: status,
      callback_status: status,
      callback_payload: payload,
      ok: status !== 'failed',
      error: status === 'failed' ? 'SMS yetkazilmadi' : '',
      status_checked_at: nowIso(),
    });
  } else {
    await saveSmsLog({ type: 'callback', phone: normalizeUzPhone(payload.phone || ''), message: `status=${status || ''}`, ok: status !== 'failed', callback_status: status, request_id, sms_id, callback_payload: payload, provider_status: status });
  }
  if (found?.queue_id) {
    await updateQueueStatus(found.queue_id, {
      provider_status: status,
      queue_status: ['delivered', 'failed'].includes(status) ? status : 'sent',
      callback_at: nowIso(),
      delivered_at: payload.delivered_at || '',
      failed_at: payload.failed_at || '',
      sent_at: payload.sent_at || '',
    });
  }
  res.json({ ok: true });
});

app.use('/api', requireAuth, (req, res, next) => { scheduleWorkerKick(); next(); });

app.get('/api/bootstrap', async (req, res) => {
  const [carsRes, oilsRes, smsRes, cfgRes, logsRes, queue] = await Promise.all([getCars(), getOils(), getSmsConfig(), getCfg(), fbGet('sms_logs'), getQueue()]);
  const logs = objectValuesSorted(logsRes.data).sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0)).slice(0, 80);
  const schedules = queue.filter((q) => ['pending', 'retry', 'processing', 'sent', 'failed', 'delivered', 'missed'].includes(q.status)).slice(0, 80);
  res.json({ ok: true, cars: carsRes.cars, oils: oilsRes.oils, sms_config: publicSmsConfig(smsRes.config), cfg: cfgRes.cfg, logs, schedules });
});
app.get('/api/storage/ping', async (req, res) => {
  const started = Date.now();
  const result = await fbGet('_ping');
  res.json({ ok: result.ok, ping_ms: Date.now() - started, storage_status: result.status || 0, storage_type: 'Firebase Realtime Database' });
});
app.get('/api/firebase/ping', async (req, res) => {
  const started = Date.now();
  const result = await fbGet('_ping');
  res.json({ ok: result.ok, ping_ms: Date.now() - started, firebase_status: result.status || 0, storage_type: 'Firebase Realtime Database' });
});
app.get('/api/system/info', async (req, res) => {
  res.json({ ok: true, storage: { type: 'Firebase Realtime Database', mode: 'backend-only', direct_client_access: false }, sms_provider: 'DevSMS', auth_mode: 'PIN session' });
});
app.post('/api/cars', async (req, res) => {
  const car = sanitizeCar(req.body || {});
  if (!car.car_name || !car.car_number) return res.status(400).json({ ok: false, error: 'Mashina nomi va raqami kerak' });
  try {
    assertStorageResult(await fbPut(`cars/car_${car.id}`, car), "Mashina saqlash");
    res.json({ ok: true, car });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message || "Mashinani saqlab bo'lmadi" });
  }
});
app.delete('/api/cars/:id', async (req, res) => {
  try {
    assertStorageResult(await fbDelete(`cars/car_${req.params.id}`), "Mashina o'chirish");
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message || "Mashinani o'chirib bo'lmadi" });
  }
});
app.post('/api/oils', async (req, res) => {
  const oil = sanitizeOil(req.body || {});
  if (!oil.name) return res.status(400).json({ ok: false, error: 'Moy nomi kerak' });
  try {
    assertStorageResult(await fbPut(`oils/oil_${oil.id}`, oil), "Moy saqlash");
    res.json({ ok: true, oil });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message || "Moyni saqlab bo'lmadi" });
  }
});
app.delete('/api/oils/:id', async (req, res) => {
  try {
    assertStorageResult(await fbDelete(`oils/oil_${req.params.id}`), "Moyni o'chirish");
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message || "Moyni o'chirib bo'lmadi" });
  }
});
app.post('/api/cfg', async (req, res) => {
  const next = { ...DEFAULT_CFG, ...(req.body || {}), updated_at: nowIso() };
  try {
    assertStorageResult(await fbPut('cfg', next), "Sozlamalarni saqlash");
    res.json({ ok: true, cfg: next });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message || "Sozlamalarni saqlab bo'lmadi" });
  }
});
app.get('/api/sms-config', async (req, res) => {
  const { config } = await getSmsConfig();
  res.json({ ok: true, config: publicSmsConfig(config) });
});
app.post('/api/sms-config', async (req, res) => {
  const current = (await getSmsConfig()).config;
  const body = req.body || {};
  const activeToken = resolveDevSmsToken(current);
  const next = {
    ...current,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : !!activeToken,
    test_phone: normalizeUzPhone(body.test_phone || current.test_phone || ''),
    service_done_message: APPROVED_TEMPLATES.service_done,
    service_due_message: APPROVED_TEMPLATES.service_reminder,
    updated_at: nowIso(),
  };
  next.devsms_token = activeToken;
  try {
    assertStorageResult(await fbPut('sms_config', next), "Xabar sozlamalarini saqlash");
    res.json({ ok: true, config: publicSmsConfig(next) });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message || "Xabar sozlamalarini saqlab bo'lmadi" });
  }
});
app.post('/api/admin/clear-data', async (req, res) => {
  try {
    const smsCfg = {
      ...DEFAULT_SMS,
      devsms_token: DEVSMS_TOKEN,
      enabled: !!DEVSMS_TOKEN,
      test_phone: '',
      sms_sent_count: 0,
      updated_at: nowIso(),
    };
    const writes = [
      fbPut('cars', null),
      fbPut('sms_logs', null),
      fbPut('sms_provider_index', null),
      fbPut('sms_queue', null),
      fbPut('auto_sms_sent', null),
      fbPut('cfg', { ...DEFAULT_CFG, updated_at: nowIso() }),
      fbPut('sms_config', smsCfg),
      fbPut('oils', null),
    ];
    const results = await Promise.all(writes);
    results.forEach((r, idx) => assertStorageResult(r, `Tozalash #${idx + 1}`));
    await Promise.all(DEFAULT_OILS.map((o) => fbPut(`oils/oil_${o.id}`, o)));
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message || "Ma'lumotlarni tozalab bo'lmadi" });
  }
});
app.post('/api/sms/verify-token', async (req, res) => {
  const token = String(req.body?.token || resolveDevSmsToken((await getSmsConfig()).config) || '').trim();
  if (!token) return res.status(400).json({ ok: false, error: 'Ulanish kaliti kerak' });
  const checked = await verifyDevSmsToken(token);
  res.status(checked.ok ? 200 : 400).json({ ok: checked.ok, balance: checked.balance, http_status: checked.status || 0, data: checked.data, error: checked.error || '' });
});
app.post('/api/sms/send', async (req, res) => {
  const phone = normalizeUzPhone(req.body?.phone || '');
  const message = String(req.body?.message || '').trim();
  if (!phone || !message) return res.status(400).json({ ok: false, error: 'Telefon va xabar kerak' });
  const scheduleAt = req.body?.schedule_at ? new Date(req.body.schedule_at) : null;
  if (scheduleAt && !Number.isNaN(scheduleAt.getTime()) && scheduleAt.getTime() > Date.now() + 10000) {
    const item = sanitizeQueueItem({
      id: stableId('q'),
      phone,
      message,
      schedule_label: req.body?.schedule_label || '',
      car_name: req.body?.car_name || '',
      scheduled_for: scheduleAt.toISOString(),
      next_attempt_at: scheduleAt.toISOString(),
      status: 'pending',
      created_at: nowIso(),
      queue_status: 'pending',
    });
    await upsertQueue(item);
    scheduleWorkerKick();
    return res.json({ ok: true, scheduled: true, item });
  }
  const sent = await sendMessageWithConfig({ phone, message, type: 'direct', meta: { queue_status: '' } });
  res.json({ ok: sent.ok, scheduled: false, error: sent.error || '', devsms: sent.data || {}, request_id: sent.request_id || '', sms_id: sent.sms_id || '' });
});
app.get('/api/sms/schedules', async (req, res) => {
  const items = await getQueue();
  res.json({ ok: true, schedules: items.slice(0, Number(req.query.limit || 150)) });
});
app.delete('/api/sms/schedules/:id', async (req, res) => {
  const current = await fbGet(`sms_queue/${req.params.id}`);
  if (!current.data) return res.json({ ok: true });
  await fbPut(`sms_queue/${req.params.id}`, { ...current.data, status: 'cancelled', queue_status: 'cancelled', cancelled_at: nowIso() });
  res.json({ ok: true });
});
app.post('/api/sms/test', async (req, res) => {
  const { config } = await getSmsConfig();
  const phone = normalizeUzPhone(req.body?.phone || config.test_phone || '');
  if (!phone) return res.status(400).json({ ok: false, error: 'Test raqam topilmadi' });
  const text = String(req.body?.message || 'Test SMS').trim();
  const sent = await sendMessageWithConfig({ phone, message: text, type: 'test' });
  res.json({ ok: sent.ok, text, error: sent.error, devsms: sent.data, request_id: sent.request_id || '', sms_id: sent.sms_id || '' });
});
app.post('/api/sms/service-change', async (req, res) => {
  const car = sanitizeCar(req.body?.car || {});
  const type = String(req.body?.service_type || '').trim();
  if (!car.phone_number || !type) return res.status(400).json({ ok: false, error: 'Telefon va xizmat turi kerak' });
  if (!supportsSmsForService(type)) return res.json({ ok: true, skipped: true, reason: 'Bu xizmat uchun SMS yuborilmaydi' });
  const serviceName = getServicePhrase(type, 'done', car);
  const text = buildApprovedServiceDoneMessage(car, serviceName);
  const sent = await sendMessageWithConfig({ phone: car.phone_number, message: text, type: 'service_change', meta: { service_type: type, car_name: car.car_name } });
  res.json({ ok: sent.ok, text, error: sent.error, devsms: sent.data, skipped: false });
});
app.post('/api/sms/car-saved', async (req, res) => {
  const car = sanitizeCar(req.body?.car || {});
  const rawTypes = Array.isArray(req.body?.service_types) ? req.body.service_types : [];
  const serviceTypes = rawTypes.map((v) => String(v || '').trim()).filter((v) => supportsSmsForService(v));
  if (!car.phone_number || !serviceTypes.length) return res.json({ ok: true, skipped: true, sent_count: 0, results: [] });
  const results = [];
  for (const type of serviceTypes) {
    const serviceName = getServicePhrase(type, 'done', car);
    const text = buildApprovedServiceDoneMessage(car, serviceName);
    const sent = await sendMessageWithConfig({ phone: car.phone_number, message: text, type: 'car_saved', meta: { service_type: type, car_name: car.car_name } });
    results.push({ type, ok: sent.ok, error: sent.error || '', text });
    await sleep(200);
  }
  res.json({ ok: results.some((r) => r.ok), skipped: false, sent_count: results.filter((r) => r.ok).length, results });
});
app.post('/api/sms/reset-count', async (req, res) => {
  const current = (await getSmsConfig()).config;
  try {
    assertStorageResult(await fbPut('sms_config', { ...current, sms_sent_count: 0, updated_at: nowIso() }), "Hisoblagichni tozalash");
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message || "Hisoblagichni tozalab bo'lmadi" });
  }
});
app.get('/api/sms/logs', async (req, res) => {
  const logsRes = await fbGet('sms_logs');
  const logs = objectValuesSorted(logsRes.data).sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0)).slice(0, Number(req.query.limit || 150));
  res.json({ ok: true, logs });
});
app.delete('/api/sms/logs', async (req, res) => {
  try {
    assertStorageResult(await fbPut('sms_logs', null), "Tarixni tozalash");
    assertStorageResult(await fbPut('sms_provider_index', null), "Tarix indeksini tozalash");
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message || "Tarixni tozalab bo'lmadi" });
  }
});
app.get('/api/sms/stats', async (req, res) => {
  const { config } = await getSmsConfig();
  const logs = objectValuesSorted((await fbGet('sms_logs')).data);
  const today = nowDate();
  const queue = await getQueue();
  res.json({
    ok: true,
    total_sent: parseMaybeNumber(config.sms_sent_count, 0),
    today_count: logs.filter((l) => l.date === today).length,
    fail_count: logs.filter((l) => l.ok === false || l.provider_status === 'failed').length,
    success_count: logs.filter((l) => l.ok === true).length,
    delivered_count: logs.filter((l) => l.provider_status === 'delivered').length,
    pending_queue: queue.filter((q) => ['pending', 'retry', 'processing'].includes(q.status)).length,
    has_token: !!resolveDevSmsToken(config),
    sms_enabled: !!config.enabled,
  });
});
app.post('/api/sms/refresh-statuses', async (req, res) => {
  await syncRecentStatuses();
  const logsRes = await fbGet('sms_logs');
  const logs = objectValuesSorted(logsRes.data).sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0)).slice(0, 80);
  res.json({ ok: true, logs });
});
app.post('/api/sms/run-auto-check', async (req, res) => {
  await processAutoReminders();
  res.json({ ok: true });
});
app.post('/api/sms/run-queue', async (req, res) => {
  await processScheduledQueue();
  await syncRecentStatuses();
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ ok: false, error: 'Server xatosi', detail: err.message });
});

setInterval(() => { processScheduledQueue().catch(console.error); }, SCHEDULER_POLL_SECONDS * 1000);
setInterval(() => { processAutoReminders().catch(console.error); }, AUTO_CHECK_MINUTES * 60 * 1000);
setInterval(() => { syncRecentStatuses().catch(console.error); }, STATUS_SYNC_SECONDS * 1000);

app.listen(PORT, () => {
  console.log(`MoyTrack backend running on http://localhost:${PORT}`);
  processScheduledQueue().catch(console.error);
  processAutoReminders().catch(console.error);
  syncRecentStatuses().catch(console.error);
});
