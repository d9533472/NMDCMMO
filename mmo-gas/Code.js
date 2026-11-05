// ============================================================
// NMDC MMO — 鯨豚觀察作業系統 · Google Apps Script backend
// 前端 https://d9533472.github.io/NMDCMMO/ ；原始碼 E:\NMDCMMO\mmo-gas\Code.js（clasp push + deploy -i <prod id>）
// 依「台灣鯨豚觀察員制度作業指引（第四版）」：預觀測 → 施工 → 目擊／停工／復工 → 結束，紙本表單掃描上傳。
//
// 協定：POST text/plain JSON {action, token, payload} → {ok:true, data, state?} / {ok:false, error, code}
//       GET ?action=ping 僅供健康檢查（GET 不做任何寫入）
// 資料：Drive 資料夾 ROOT_FOLDER_ID 內的試算表「MMO 鯨豚觀察總表」（setup() 建立，id 存 Script Properties ss_id）
//       上傳檔案：ROOT/<日期>_<班次>_<施工船>/<MMO 船>/<上傳項目>/檔案
// 角色：admin（全部＋後台）、mmo（建立／填報班次、上傳）、viewer（唯讀）
// ============================================================

const VERSION = '1.0';
const ROOT_FOLDER_ID = '1uVkbv4tndRVERhrHmHUzaTvPlHaFV4em';
const SS_NAME = 'MMO 鯨豚觀察總表';
const TZ = 'Asia/Taipei';

const SCHEMAS = {
  Users: ['id','username','name','email','role','password_salt','password_hash','active','must_change','last_login','created_at','updated_at'],
  Sessions: ['token','user_id','expires_at','created_at'],
  Settings: ['key','value'],
  Vessels: ['id','name','kind','mmsi','imo','type','operator','remark','active','sort','created_at','updated_at'],
  Observers: ['id','name','role','company','phone','cert_no','remark','active','created_at','updated_at'],
  UploadItems: ['id','kind','name_zh','name_en','required','cond','active','sort','note'],
  Shifts: ['id','shift_no','date','site','scope','construction_vessel_id','construction_vessel','status','remark','folder_id',
    'created_by','created_at','updated_by','updated_at','closed_by','closed_at'],
  ShiftVessels: ['id','shift_id','vessel_id','vessel_name','mmsi','sort','crew','pre_start','pre_end','work_start','work_end',
    'lat','lon','pos_time','pos_source','weather','sea_state','remark','folder_id','updated_by','updated_at'],
  Pauses: ['id','shift_id','sv_id','start','end','reason','sighting_id','remark','created_by','created_at','updated_at'],
  Sightings: ['id','shift_id','sv_id','time','species','count','detection','min_distance_m','in_alert_zone','action','left_time',
    'lat','lon','behavior','remark','created_by','created_at','updated_at'],
  Files: ['id','shift_id','sv_id','item_id','item_name','kind','drive_id','name','mime','size','thumb','uploaded_by','uploaded_at'],
  AuditLog: ['time','user','role','action','target','detail','ok','error']
};

const DEFAULT_SETTINGS = {
  project_name: 'NMDC 鯨豚觀察作業系統',
  pre_watch_min: '30',          // 預觀測時間（分）
  alert_zone_m: '750',          // 警戒區半徑（m）
  watch_zone_m: '1500',         // 觀察區半徑（m）
  clear_min: '30',              // 鯨豚離開警戒區後須再觀察幾分鐘才可復工
  crew_slots: 'TCO1\nTCO2\nTCO3\nTCO4\nPAMO',
  sites: '通霄 Tongxiao, 24.47, 120.55',
  scopes: '打樁 Piling\n套管安裝 Jacket installation\n海纜敷設 Cable laying\n調查 Survey\n其他 Other',
  species: '台灣白海豚 Taiwanese humpback dolphin\n印太瓶鼻海豚 Indo-Pacific bottlenose dolphin\n瓶鼻海豚 Common bottlenose dolphin\n印太露脊鼠海豚 Indo-Pacific finless porpoise\n熱帶斑海豚 Pantropical spotted dolphin\n飛旋海豚 Spinner dolphin\n糙齒海豚 Rough-toothed dolphin\n未知鯨豚 Unidentified cetacean',
  pause_reasons: '目擊鯨豚進入警戒區 Cetacean in alert zone\nPAM 偵測到鯨豚 PAM detection\n天氣／能見度不佳 Poor weather / visibility\n設備故障 Equipment failure\n其他 Other',
  ais_api_url: '',              // 之後接付費船位 API（伺服器端呼叫，金鑰不給前端）
  ais_api_key: ''
};
const SECRET_SETTINGS = { ais_api_key: 1 };

const ITEM_SEED = [
  ['doc', 'MMO 自檢表', 'MMO self-check form', 'always'],
  ['doc', 'PAM 自檢表', 'PAM self-check form', 'always'],
  ['doc', 'PAM 偵測紀錄表', 'PAM detection record', 'always'],
  ['doc', '工具箱紀錄', 'Toolbox talk record', 'always'],
  ['doc', '目擊紀錄表', 'Sighting record', 'sighting'],
  ['doc', '作業紀錄表', 'Operation log', 'always'],
  ['doc', '施工紀錄表', 'Construction log', 'always'],
  ['photo', '鯨豚觀察員監測照片', 'MMO monitoring photos', 'always'],
  ['photo', '被動聲學監測照片', 'PAM monitoring photos', 'always']
];

const ROLES = ['admin', 'mmo', 'viewer'];
const VIEWER_OK = { 'data.load': 1, 'data.rev': 1, 'file.get': 1, 'shift.files': 1, 'auth.logout': 1 };
const SESSION_DAYS = 14;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_THUMB_CHARS = 40000;

// ============ HTTP ============
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  if (action === 'ping') return json_({ ok: true, data: { service: 'NMDC MMO API', version: VERSION, time: nowIso_() } });
  return json_({ ok: false, error: 'Use POST', code: 'RETRY' });
}
function doPost(e) {
  let req = {};
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, error: 'Bad JSON' }); }
  return json_(handle_(req));
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

const PUBLIC = { 'ping': 1, 'auth.status': 1, 'auth.setup': 1, 'auth.login': 1, 'data.rev': 1 };
const NO_REV = { 'ping': 1, 'auth.status': 1, 'auth.login': 1, 'auth.logout': 1, 'auth.changePassword': 1, 'data.load': 1, 'data.rev': 1,
  'audit.list': 1, 'file.get': 1, 'shift.files': 1, 'pos.fetch': 1 };
const AUDIT_SKIP = { 'ping': 1, 'auth.status': 1, 'data.load': 1, 'data.rev': 1, 'audit.list': 1, 'file.get': 1, 'shift.files': 1 };
// 這些寫入會改到班次資料 → 重建試算表「總表」
const SUMMARY_ACTIONS = /^(shift|sv|pause|sighting|file)\.(save|delete|close|reopen|upload)$/;

function handle_(req) {
  const action = String(req.action || '');
  const fn = ROUTES[action];
  if (!fn) return { ok: false, error: 'Unknown action: ' + action };
  const payload = req.payload || {};
  let user = null;
  try {
    ensureSchema_();
    if (!PUBLIC[action]) user = verifySession_(req.token);
    if (user && user.role === 'viewer' && !VIEWER_OK[action]) fail_('Guest account is read-only', 'FORBIDDEN');
    const data = fn(user, payload);
    if (!NO_REV[action]) bumpRev_();
    if (SUMMARY_ACTIONS.test(action)) { try { rebuildSummary_(); } catch (e) { console.warn('summary: ' + e.message); } }
    audit_(action, user, payload, data, true, '');
    const out = { ok: true, data: data === undefined ? null : data };
    // 寫入後順便回傳最新全部資料，前端不用再多打一次 data.load
    if (req.reload && user) { Repo.flush(); out.state = loadData_(user); }
    return out;
  } catch (err) {
    if (!(err && err.code === 'AUTH')) audit_(action, user, payload, null, false, err && err.message);
    if (err && err.code) return { ok: false, error: err.message, code: err.code };
    console.error(action + ': ' + err.message + '\n' + err.stack);
    return { ok: false, error: 'Server error: ' + err.message };
  }
}

const ROUTES = {
  'ping': () => ({ version: VERSION, time: nowIso_() }),
  'auth.status': () => ({ needsSetup: Repo.all('Users').length === 0, project: settings_().project_name }),
  'auth.setup': (u, p) => authSetup_(p),
  'auth.login': (u, p) => authLogin_(p),
  'auth.logout': (u) => authLogout_(u),
  'auth.changePassword': (u, p) => changePassword_(u, p),
  'data.load': (u) => loadData_(u),
  'data.rev': () => ({ rev: dataRev_() }),

  'shift.save': (u, p) => saveShift_(u, p),
  'shift.close': (u, p) => setShiftStatus_(u, p.id, 'closed'),
  'shift.reopen': (u, p) => { requireRole_(u, ['admin']); return setShiftStatus_(u, p.id, 'open'); },
  'shift.delete': (u, p) => { requireRole_(u, ['admin']); return deleteShift_(p.id); },
  'shift.files': (u, p) => ({ files: Repo.all('Files').filter(f => f.shift_id === p.id) }),
  'sv.save': (u, p) => saveShiftVessel_(u, p),
  'pause.save': (u, p) => saveChild_(u, 'Pauses', p, ['start','end','reason','sighting_id','remark'], ['start']),
  'pause.delete': (u, p) => deleteChild_(u, 'Pauses', p.id),
  'sighting.save': (u, p) => saveSighting_(u, p),
  'sighting.delete': (u, p) => deleteChild_(u, 'Sightings', p.id),
  'file.upload': (u, p) => uploadFile_(u, p),
  'file.delete': (u, p) => deleteFile_(u, p.id),
  'file.get': (u, p) => getFile_(p.id),
  'pos.fetch': (u, p) => fetchPosition_(p),

  'vessel.save': (u, p) => { requireRole_(u, ['admin']); return saveMaster_('Vessels', p, ['name','kind','mmsi','imo','type','operator','remark','active','sort'], ['name','kind']); },
  'vessel.delete': (u, p) => { requireRole_(u, ['admin']); return deleteMaster_('Vessels', p.id); },
  'observer.save': (u, p) => { requireRole_(u, ['admin']); return saveMaster_('Observers', p, ['name','role','company','phone','cert_no','remark','active'], ['name']); },
  'observer.delete': (u, p) => { requireRole_(u, ['admin']); return deleteMaster_('Observers', p.id); },
  'item.save': (u, p) => { requireRole_(u, ['admin']); return saveMaster_('UploadItems', p, ['kind','name_zh','name_en','required','cond','active','sort','note'], ['kind','name_zh']); },
  'item.delete': (u, p) => { requireRole_(u, ['admin']); return deleteItem_(p.id); },
  'settings.save': (u, p) => { requireRole_(u, ['admin']); return saveSettings_(p); },
  'user.save': (u, p) => { requireRole_(u, ['admin']); return saveUser_(u, p); },
  'user.delete': (u, p) => { requireRole_(u, ['admin']); return deleteUser_(u, p.id); },
  'audit.list': (u, p) => { requireRole_(u, ['admin']); return auditList_(p); },
  'summary.rebuild': (u) => { requireRole_(u, ['admin']); rebuildSummary_(); return { url: ss_().getUrl() }; }
};

// ============ Spreadsheet / Repo ============
function ss_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('ss_id');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) { console.warn('ss_id invalid: ' + e.message); } }
  const ss = SpreadsheetApp.create(SS_NAME);
  DriveApp.getFileById(ss.getId()).moveTo(DriveApp.getFolderById(ROOT_FOLDER_ID));
  props.setProperty('ss_id', ss.getId());
  return ss;
}

const Repo = (function () {
  const cache = {};
  let ssCache = null;
  function sheet_(name) {
    const ss = ssCache || (ssCache = ss_());
    return ss.getSheetByName(name) || ss.insertSheet(name);
  }
  function cell_(v) {
    if (v instanceof Date) return Utilities.formatDate(v, TZ, "yyyy-MM-dd'T'HH:mm:ss");
    if (v === null || v === undefined) return '';
    return String(v);
  }
  function load_(name) {
    if (cache[name]) return cache[name];
    const sh = sheet_(name);
    const values = sh.getDataRange().getValues();
    const headers = (values[0] || []).map(String);
    const rows = [];
    for (let i = 1; i < values.length; i++) {
      const o = {};
      headers.forEach((h, j) => { if (h) o[h] = cell_(values[i][j]); });
      o.__row = i + 1;
      rows.push(o);
    }
    cache[name] = { sh: sh, headers: headers, rows: rows };
    return cache[name];
  }
  function key_(name) { return name === 'Sessions' ? 'token' : (name === 'Settings' ? 'key' : 'id'); }
  function clean_(o) { const c = {}; Object.keys(o).forEach(k => { if (k !== '__row') c[k] = o[k]; }); return c; }
  function rowOf_(t, obj) { return t.headers.map(h => (h && obj[h] !== undefined && obj[h] !== null) ? String(obj[h]) : ''); }
  return {
    sheet: sheet_,
    all: function (name) { return load_(name).rows.filter(r => r[key_(name)]).map(clean_); },
    get: function (name, id) {
      const k = key_(name);
      const r = load_(name).rows.find(x => String(x[k]) === String(id));
      return r ? clean_(r) : null;
    },
    insert: function (name, obj) {
      const t = load_(name);
      const row = rowOf_(t, obj);
      t.sh.getRange(t.sh.getLastRow() + 1, 1, 1, row.length).setNumberFormat('@').setValues([row]);
      delete cache[name];
      return obj;
    },
    append: function (name, obj) {
      const sh = sheet_(name);
      const headers = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String);
      sh.appendRow(headers.map(h => { const v = obj[h] === undefined || obj[h] === null ? '' : String(obj[h]); return /^[=+\-@]/.test(v) ? "'" + v : v; }));
      delete cache[name];
    },
    insertMany: function (name, objs) {
      if (!objs.length) return;
      const t = load_(name);
      const rows = objs.map(o => rowOf_(t, o));
      t.sh.getRange(t.sh.getLastRow() + 1, 1, rows.length, rows[0].length).setNumberFormat('@').setValues(rows);
      delete cache[name];
    },
    update: function (name, id, patch) {
      const t = load_(name);
      const k = key_(name);
      const r = t.rows.find(x => String(x[k]) === String(id));
      if (!r) fail_('Record not found', 'NOT_FOUND');
      const merged = Object.assign({}, clean_(r), patch);
      const row = rowOf_(t, merged);
      t.sh.getRange(r.__row, 1, 1, row.length).setNumberFormat('@').setValues([row]);
      delete cache[name];
      return merged;
    },
    remove: function (name, id) {
      const t = load_(name);
      const k = key_(name);
      const r = t.rows.find(x => String(x[k]) === String(id));
      if (!r) return false;
      t.sh.deleteRow(r.__row);
      delete cache[name];
      return true;
    },
    removeWhere: function (name, pred) {
      const t = load_(name);
      const rows = t.rows.filter(r => r[key_(name)] && pred(clean_(r))).map(r => r.__row).sort((a, b) => b - a);
      rows.forEach(n => t.sh.deleteRow(n));
      delete cache[name];
      return rows.length;
    },
    flush: function () { Object.keys(cache).forEach(k => delete cache[k]); }
  };
})();

function ensureSchema_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('schema_version') === VERSION) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (props.getProperty('schema_version') === VERSION) return;
    const ss = ss_();
    Object.keys(SCHEMAS).forEach(name => {
      const sh = ss.getSheetByName(name) || ss.insertSheet(name);
      const lastCol = sh.getLastColumn();
      const existing = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
      const missing = SCHEMAS[name].filter(h => existing.indexOf(h) < 0);
      if (missing.length) sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
      sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold');
      sh.setFrozenRows(1);
    });
    const blank = ss.getSheetByName('Sheet1') || ss.getSheetByName('工作表1');
    if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);
    Repo.flush();
    if (!Repo.all('UploadItems').length) {
      Repo.insertMany('UploadItems', ITEM_SEED.map((c, i) => ({ id: genId_(), kind: c[0], name_zh: c[1], name_en: c[2], required: 'TRUE',
        cond: c[3], active: 'TRUE', sort: String(i + 1), note: '' })));
    }
    const st = Repo.all('Settings');
    Object.keys(DEFAULT_SETTINGS).forEach(k => { if (!st.find(s => s.key === k)) Repo.insert('Settings', { key: k, value: DEFAULT_SETTINGS[k] }); });
    props.setProperty('schema_version', VERSION);
  } finally { lock.releaseLock(); }
}

/** 在 GAS 編輯器手動執行一次：授權 Drive／試算表、建立總表 */
function setup() {
  PropertiesService.getScriptProperties().deleteProperty('schema_version');
  ensureSchema_();
  rebuildSummary_();
  Logger.log('OK — 總表: ' + ss_().getUrl() + ' · root folder: ' + DriveApp.getFolderById(ROOT_FOLDER_ID).getName());
}

// ============ Utility ============
function genId_() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function nowIso_() { return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ss"); }
function bool_(v) { return v === true || v === 'TRUE' || v === 'true' || v === 1 || v === '1'; }
function str_(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function fail_(msg, code) { const e = new Error(msg); e.code = code || 'ERROR'; throw e; }
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function settings_() {
  const o = Object.assign({}, DEFAULT_SETTINGS);
  Repo.all('Settings').forEach(s => { o[s.key] = s.value; });
  return o;
}
function lines_(v) { return String(v || '').split('\n').map(x => x.trim()).filter(Boolean); }
function requireRole_(u, roles) { if (!u || roles.indexOf(u.role) < 0) fail_('Permission denied', 'FORBIDDEN'); }
function parseJson_(v, def) { try { return v ? JSON.parse(v) : def; } catch (e) { return def; } }
/** 'yyyy-MM-ddTHH:mm' 台北時間 → 毫秒 */
function tms_(s) {
  s = str_(s);
  if (!s) return NaN;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5]);
}
function mins_(a, b) { const x = tms_(a), y = tms_(b); return isNaN(x) || isNaN(y) ? NaN : Math.round((y - x) / 60000); }
function dt_(v) {
  v = str_(v);
  if (!v) return '';
  const m = v.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  if (!m) fail_('Invalid date/time: ' + v);
  return m[1] + 'T' + m[2];
}

// ============ Data rev（前端輪詢用） ============
function dataRev_() {
  const cache = CacheService.getScriptCache();
  let r = cache.get('data_rev');
  if (!r) { r = PropertiesService.getScriptProperties().getProperty('data_rev') || '0'; cache.put('data_rev', r, 21600); }
  return r;
}
function bumpRev_() {
  try {
    const r = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    CacheService.getScriptCache().put('data_rev', r, 21600);
    PropertiesService.getScriptProperties().setProperty('data_rev', r);
  } catch (e) { console.warn('rev bump failed: ' + e.message); }
}

// ============ Auth ============
function hash_(password, salt) {
  let h = salt + '|' + password;
  for (let i = 0; i < 500; i++) h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt, Utilities.Charset.UTF_8));
  return h;
}
function publicUser_(u) {
  return { id: u.id, username: u.username, name: u.name, email: u.email, role: u.role, active: bool_(u.active),
    must_change: u.role !== 'viewer' && bool_(u.must_change), last_login: u.last_login };
}
function checkPassword_(pw) { if (str_(pw).length < 6) fail_('Password must be at least 6 characters', 'WEAK_PASSWORD'); }
function newSession_(user) {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  Repo.insert('Sessions', { token: token, user_id: user.id, expires_at: exp, created_at: nowIso_() });
  CacheService.getScriptCache().put('s_' + token, user.id + '|' + exp, 21600);
  return token;
}
function verifySession_(token) {
  token = str_(token);
  if (!token) fail_('Please log in', 'AUTH');
  const cache = CacheService.getScriptCache();
  let userId = '', exp = '';
  const c = cache.get('s_' + token);
  if (c) { const parts = c.split('|'); userId = parts[0]; exp = parts[1]; }
  else {
    const s = Repo.get('Sessions', token);
    if (!s) fail_('Session expired, please log in again', 'AUTH');
    userId = s.user_id; exp = s.expires_at;
    cache.put('s_' + token, userId + '|' + exp, 21600);
  }
  if (exp < new Date().toISOString()) fail_('Session expired, please log in again', 'AUTH');
  const u = Repo.get('Users', userId);
  if (!u || !bool_(u.active)) fail_('Account disabled', 'AUTH');
  u.token = token;
  return u;
}
function killSessions_(userId) {
  const tokens = Repo.all('Sessions').filter(x => x.user_id === userId).map(x => 's_' + x.token);
  if (tokens.length) CacheService.getScriptCache().removeAll(tokens);
  Repo.removeWhere('Sessions', x => x.user_id === userId);
}
function authSetup_(p) {
  return withLock_(() => {
    if (Repo.all('Users').length) fail_('System already set up', 'FORBIDDEN');
    const username = str_(p.username).toLowerCase();
    if (!username) fail_('Username required');
    checkPassword_(p.password);
    const salt = Utilities.getUuid();
    const u = { id: genId_(), username: username, name: str_(p.name) || username, email: str_(p.email), role: 'admin',
      password_salt: salt, password_hash: hash_(p.password, salt), active: 'TRUE', must_change: 'FALSE',
      last_login: nowIso_(), created_at: nowIso_(), updated_at: nowIso_() };
    Repo.insert('Users', u);
    return { token: newSession_(u), user: publicUser_(u), data: loadData_(u) };
  });
}
function authLogin_(p) {
  const username = str_(p.username).toLowerCase();
  const u = Repo.all('Users').find(x => str_(x.username).toLowerCase() === username || (x.email && str_(x.email).toLowerCase() === username));
  if (!u || !bool_(u.active) || hash_(str_(p.password), u.password_salt) !== u.password_hash) fail_('Wrong username or password', 'LOGIN');
  Repo.update('Users', u.id, { last_login: nowIso_() });
  const pu = publicUser_(u);
  return { token: newSession_(u), user: pu, data: pu.must_change ? null : loadData_(u) };
}
function authLogout_(u) {
  CacheService.getScriptCache().remove('s_' + u.token);
  Repo.remove('Sessions', u.token);
  return true;
}
function changePassword_(u, p) {
  if (u.role === 'viewer') fail_('Guest account is read-only', 'FORBIDDEN');
  if (hash_(str_(p.oldPassword), u.password_salt) !== u.password_hash) fail_('Current password is wrong', 'LOGIN');
  checkPassword_(p.newPassword);
  const salt = Utilities.getUuid();
  Repo.update('Users', u.id, { password_salt: salt, password_hash: hash_(p.newPassword, salt), must_change: 'FALSE', updated_at: nowIso_() });
  return true;
}
function saveUser_(u, p) {
  return withLock_(() => {
    const username = str_(p.username).toLowerCase();
    if (!username) fail_('Username required');
    const role = ROLES.indexOf(p.role) >= 0 ? p.role : 'mmo';
    if (Repo.all('Users').find(x => str_(x.username).toLowerCase() === username && x.id !== p.id)) fail_('Username already exists');
    const patch = { username: username, name: str_(p.name), email: str_(p.email), role: role, active: bool_(p.active) ? 'TRUE' : 'FALSE', updated_at: nowIso_() };
    if (p.id) {
      if (p.id === u.id && (role !== 'admin' || patch.active !== 'TRUE')) fail_('You cannot demote or disable your own account');
      if (p.password) {
        checkPassword_(p.password);
        patch.password_salt = Utilities.getUuid();
        patch.password_hash = hash_(p.password, patch.password_salt);
        patch.must_change = 'TRUE';
      }
      const saved = Repo.update('Users', p.id, patch);
      if (patch.active !== 'TRUE' || p.password) killSessions_(p.id);
      return publicUser_(saved);
    }
    checkPassword_(p.password);
    const salt = Utilities.getUuid();
    const rec = Object.assign({ id: genId_(), password_salt: salt, password_hash: hash_(p.password, salt), must_change: 'TRUE',
      last_login: '', created_at: nowIso_() }, patch);
    Repo.insert('Users', rec);
    return publicUser_(rec);
  });
}
function deleteUser_(u, id) {
  if (id === u.id) fail_('You cannot delete your own account');
  return withLock_(() => { killSessions_(id); Repo.remove('Users', id); return { id: id }; });
}

// ============ Audit ============
const AUDIT_SECRET = { password: 1, oldPassword: 1, newPassword: 1, data: 1, thumb: 1, ais_api_key: 1 };
function audit_(action, user, payload, data, ok, err) {
  if (AUDIT_SKIP[action]) return;
  try {
    const d = {};
    Object.keys(payload || {}).forEach(k => {
      let v = payload[k];
      if (AUDIT_SECRET[k]) v = '***';
      else if (v && typeof v === 'object') v = k === 'file' ? { name: v.name, size: v.data ? Math.round(String(v.data).length * 0.75) : 0 } : v;
      d[k] = v;
    });
    const target = (data && (data.id || data.name)) || payload.id || payload.username || '';
    Repo.append('AuditLog', { time: nowIso_(), user: user ? user.username : (payload.username || ''), role: user ? user.role : '',
      action: action, target: String(target), detail: JSON.stringify(d).slice(0, 2000), ok: ok ? 'TRUE' : 'FALSE', error: err || '' });
  } catch (e) { console.warn('audit failed: ' + e.message); }
}
function auditList_(p) {
  const sh = Repo.sheet('AuditLog');
  const last = sh.getLastRow();
  if (last < 2) return { rows: [] };
  const n = Math.min(last - 1, Math.max(50, Math.min(2000, Number(p.limit) || 500)));
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const vals = sh.getRange(last - n + 1, 1, n, headers.length).getValues();
  const rows = vals.map(r => { const o = {}; headers.forEach((h, i) => { o[h] = r[i] instanceof Date ? Utilities.formatDate(r[i], TZ, "yyyy-MM-dd'T'HH:mm:ss") : String(r[i]); }); return o; });
  return { rows: rows.reverse() };
}

// ============ Load ============
function loadData_(u) {
  const st = settings_();
  const pub = {};
  Object.keys(st).forEach(k => { pub[k] = SECRET_SETTINGS[k] ? (st[k] ? '••••' : '') : st[k]; });
  const shifts = Repo.all('Shifts');
  const svs = Repo.all('ShiftVessels');
  const pauses = Repo.all('Pauses');
  const sightings = Repo.all('Sightings');
  const files = Repo.all('Files').map(f => { const c = Object.assign({}, f); delete c.thumb; return c; });
  const items = Repo.all('UploadItems');
  svs.forEach(sv => { sv.checks = checks_(sv, pauses, sightings, files, items, st); });
  const out = {
    user: publicUser_(u), version: VERSION, settings: pub, rev: dataRev_(),
    vessels: Repo.all('Vessels'), observers: Repo.all('Observers'), items: items,
    shifts: shifts, svs: svs, pauses: pauses, sightings: sightings, files: files,
    sheetUrl: 'https://docs.google.com/spreadsheets/d/' + PropertiesService.getScriptProperties().getProperty('ss_id'),
    rootUrl: 'https://drive.google.com/drive/folders/' + ROOT_FOLDER_ID
  };
  if (u.role === 'admin') out.users = Repo.all('Users').map(publicUser_);
  return out;
}

// ============ 規則檢核（依作業指引） ============
/** 回傳 { status, warnings:[{code,en,zh}], missing:[{item_id,en,zh}], docs:[have,need], photos:[have,need] } */
function checks_(sv, pauses, sightings, files, items, st) {
  const W = [];
  const add = (code, en, zh) => W.push({ code: code, en: en, zh: zh });
  const preMin = Number(st.pre_watch_min) || 30, alertM = Number(st.alert_zone_m) || 750, clearMin = Number(st.clear_min) || 30;
  const ps = pauses.filter(p => p.sv_id === sv.id);
  const ss = sightings.filter(s => s.sv_id === sv.id);
  const openPause = ps.find(p => !p.end);
  let status = 'idle';
  if (sv.pre_start) status = 'pre';
  if (sv.pre_end) status = 'preDone';
  if (sv.work_start) status = openPause ? 'paused' : 'work';
  if (sv.work_end) status = 'done';

  if (sv.pre_start && sv.pre_end) {
    const d = mins_(sv.pre_start, sv.pre_end);
    if (d < 0) add('pre_order', 'Pre-watch end is before its start', '預觀測結束早於開始');
    else if (d < preMin) add('pre_short', 'Pre-watch only ' + d + ' min (< ' + preMin + ')', '預觀測僅 ' + d + ' 分鐘（未滿 ' + preMin + ' 分）');
  }
  if (sv.work_start && !sv.pre_end) add('no_pre', 'Work started without a completed pre-watch', '未完成預觀測即開始施工');
  if (sv.work_start && sv.pre_end && mins_(sv.pre_end, sv.work_start) < 0) add('work_early', 'Work started before pre-watch ended', '施工開始早於預觀測結束');
  if (sv.work_start && sv.work_end && mins_(sv.work_start, sv.work_end) < 0) add('work_order', 'Work end is before work start', '施工結束早於施工開始');
  if (sv.work_end && openPause) add('pause_open', 'A pause has no resume time', '有停工未記錄復工時間');
  ps.forEach(p => {
    if (p.end && mins_(p.start, p.end) < 0) add('pause_order', 'Resume time is before pause time', '復工時間早於停工時間');
    const s = p.sighting_id && ss.find(x => x.id === p.sighting_id);
    if (s && s.left_time && p.end) {
      const g = mins_(s.left_time, p.end);
      if (g < clearMin) add('resume_early', 'Resumed ' + g + ' min after the animals left the alert zone (< ' + clearMin + ')',
        '鯨豚離開警戒區後 ' + g + ' 分鐘即復工（未滿 ' + clearMin + ' 分）');
    }
  });
  ss.forEach(s => {
    const inZone = bool_(s.in_alert_zone) || (s.min_distance_m !== '' && Number(s.min_distance_m) <= alertM);
    if (!inZone || !sv.work_start) return;
    const t = tms_(s.time);
    const during = t >= tms_(sv.work_start) && (!sv.work_end || t <= tms_(sv.work_end));
    if (!during) return;
    const covered = ps.some(p => p.sighting_id === s.id || (tms_(p.start) >= t - 5 * 60000 && tms_(p.start) <= t + 15 * 60000));
    if (!covered) add('no_pause', 'Sighting in the alert zone at ' + s.time.slice(11, 16) + ' during work with no pause recorded',
      s.time.slice(11, 16) + ' 施工中於警戒區內目擊，但無停工紀錄');
  });

  const hasSighting = ss.length > 0, hasPause = ps.length > 0;
  const missing = [];
  const cnt = { doc: [0, 0], photo: [0, 0] };
  items.filter(i => bool_(i.active) && bool_(i.required)).forEach(i => {
    if (i.cond === 'sighting' && !hasSighting) return;
    if (i.cond === 'pause' && !hasPause) return;
    const k = i.kind === 'photo' ? 'photo' : 'doc';
    cnt[k][1]++;
    if (files.some(f => f.sv_id === sv.id && f.item_id === i.id)) cnt[k][0]++;
    else missing.push({ item_id: i.id, en: i.name_en || i.name_zh, zh: i.name_zh });
  });
  return { status: status, warnings: W, missing: missing, docs: cnt.doc, photos: cnt.photo };
}

// ============ Shifts ============
function shiftEditable_(u, shiftId) {
  const s = Repo.get('Shifts', shiftId);
  if (!s) fail_('Shift not found', 'NOT_FOUND');
  if (s.status === 'closed' && u.role !== 'admin') fail_('This shift is closed — ask an Admin to reopen it', 'FORBIDDEN');
  return s;
}
function saveShift_(u, p) {
  const s = withLock_(() => {
    const vesselIds = (Array.isArray(p.vessel_ids) ? p.vessel_ids : []).map(String).filter(Boolean);
    const date = str_(p.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail_('Date is required');
    if (!vesselIds.length) fail_('Select at least one MMO vessel');
    const vessels = Repo.all('Vessels');
    const cv = vessels.find(v => v.id === str_(p.construction_vessel_id));
    const shiftNo = str_(p.shift_no) || String(Repo.all('Shifts').reduce((m, x) => Math.max(m, parseInt(x.shift_no, 10) || 0), 0) + 1);
    if (Repo.all('Shifts').find(x => x.shift_no === shiftNo && x.id !== p.id)) fail_('Shift number ' + shiftNo + ' already exists');
    const patch = { shift_no: shiftNo, date: date, site: str_(p.site), scope: str_(p.scope),
      construction_vessel_id: cv ? cv.id : '', construction_vessel: cv ? cv.name : str_(p.construction_vessel),
      remark: str_(p.remark), updated_by: u.username, updated_at: nowIso_() };
    let shift;
    if (p.id) {
      const old = shiftEditable_(u, p.id);
      shift = Repo.update('Shifts', p.id, patch);
      if (old.folder_id && (old.date !== shift.date || old.shift_no !== shift.shift_no || old.construction_vessel !== shift.construction_vessel)) {
        try { DriveApp.getFolderById(old.folder_id).setName(shiftFolderName_(shift)); } catch (e) {}
      }
    } else {
      shift = Object.assign({ id: genId_(), status: 'open', folder_id: '', created_by: u.username, created_at: nowIso_() }, patch);
      Repo.insert('Shifts', shift);
    }
    // 同步 MMO 船清單：新增的建立紀錄；移除的若已有資料就拒絕
    const existing = Repo.all('ShiftVessels').filter(x => x.shift_id === shift.id);
    existing.filter(x => vesselIds.indexOf(x.vessel_id) < 0).forEach(x => {
      const used = x.pre_start || x.work_start || Repo.all('Files').some(f => f.sv_id === x.id) ||
        Repo.all('Sightings').some(f => f.sv_id === x.id) || Repo.all('Pauses').some(f => f.sv_id === x.id);
      if (used) fail_(x.vessel_name + ' already has records in this shift and cannot be removed');
      Repo.remove('ShiftVessels', x.id);
    });
    const crewDefault = p.crew && typeof p.crew === 'object' ? p.crew : {};
    vesselIds.forEach((vid, i) => {
      const v = vessels.find(x => x.id === vid);
      if (!v) fail_('Vessel not found');
      const sv = existing.find(x => x.vessel_id === vid);
      if (sv) { Repo.update('ShiftVessels', sv.id, { sort: String(i + 1), vessel_name: v.name, mmsi: v.mmsi }); return; }
      Repo.insert('ShiftVessels', { id: genId_(), shift_id: shift.id, vessel_id: vid, vessel_name: v.name, mmsi: v.mmsi, sort: String(i + 1),
        crew: JSON.stringify(crewDefault[vid] || {}), updated_by: u.username, updated_at: nowIso_() });
    });
    return shift;
  });
  try { shiftFolder_(s); } catch (e) { console.warn('folder: ' + e.message); }
  return s;
}
function setShiftStatus_(u, id, status) {
  return withLock_(() => {
    const s = shiftEditable_(u, id);
    const patch = { status: status, updated_by: u.username, updated_at: nowIso_() };
    if (status === 'closed') { patch.closed_by = u.username; patch.closed_at = nowIso_(); }
    return Repo.update('Shifts', s.id, patch);
  });
}
function deleteShift_(id) {
  return withLock_(() => {
    const s = Repo.get('Shifts', id);
    if (!s) fail_('Shift not found', 'NOT_FOUND');
    if (s.folder_id) { try { DriveApp.getFolderById(s.folder_id).setTrashed(true); } catch (e) {} }
    ['ShiftVessels', 'Pauses', 'Sightings', 'Files'].forEach(t => Repo.removeWhere(t, x => x.shift_id === id));
    Repo.remove('Shifts', id);
    return { id: id, name: s.date + ' #' + s.shift_no };
  });
}
const CREW_FIELDS = ['crew'];
const SV_FIELDS = ['pre_start','pre_end','work_start','work_end','lat','lon','pos_time','pos_source','weather','sea_state','remark'];
const SV_TIME_FIELDS = { pre_start: 1, pre_end: 1, work_start: 1, work_end: 1, pos_time: 1 };
function saveShiftVessel_(u, p) {
  return withLock_(() => {
    const sv = Repo.get('ShiftVessels', p.id);
    if (!sv) fail_('Record not found', 'NOT_FOUND');
    shiftEditable_(u, sv.shift_id);
    const patch = { updated_by: u.username, updated_at: nowIso_() };
    SV_FIELDS.concat(CREW_FIELDS).forEach(k => {
      if (p[k] === undefined) return;
      let v = p[k];
      if (k === 'crew' || k === 'weather') v = typeof v === 'string' ? v : JSON.stringify(v || {});
      else if (SV_TIME_FIELDS[k]) v = dt_(v);
      else if (k === 'lat' || k === 'lon') { v = str_(v); if (v && !isFinite(Number(v))) fail_('Invalid coordinate'); }
      else v = str_(v);
      patch[k] = v;
    });
    return Repo.update('ShiftVessels', sv.id, patch);
  });
}
function saveChild_(u, sheet, p, fields, required) {
  return withLock_(() => {
    const svId = p.id ? (Repo.get(sheet, p.id) || fail_('Record not found', 'NOT_FOUND')).sv_id : str_(p.sv_id);
    const sv = Repo.get('ShiftVessels', svId);
    if (!sv) fail_('Vessel record not found', 'NOT_FOUND');
    shiftEditable_(u, sv.shift_id);
    const patch = { updated_at: nowIso_() };
    fields.forEach(k => {
      if (p[k] === undefined) return;
      patch[k] = /^(start|end|time|left_time)$/.test(k) ? dt_(p[k]) : (k === 'in_alert_zone' ? (bool_(p[k]) ? 'TRUE' : 'FALSE') : str_(p[k]));
    });
    required.forEach(k => { if (!p.id && !patch[k]) fail_('Missing field: ' + k); });
    if (p.id) return Repo.update(sheet, p.id, patch);
    const rec = Object.assign({ id: genId_(), shift_id: sv.shift_id, sv_id: sv.id, created_by: u.username, created_at: nowIso_() }, patch);
    Repo.insert(sheet, rec);
    return rec;
  });
}
function saveSighting_(u, p) {
  const st = settings_();
  if (p.min_distance_m !== undefined && str_(p.min_distance_m) !== '' && !isFinite(Number(p.min_distance_m))) fail_('Distance must be a number');
  if (p.in_alert_zone === undefined || p.in_alert_zone === '') p.in_alert_zone = str_(p.min_distance_m) !== '' && Number(p.min_distance_m) <= (Number(st.alert_zone_m) || 750);
  const rec = saveChild_(u, 'Sightings', p, ['time','species','count','detection','min_distance_m','in_alert_zone','action','left_time','lat','lon','behavior','remark'], ['time']);
  // 選擇「停工」且尚無對應停工紀錄 → 自動建立一筆停工（復工時間之後補）
  if (p.auto_pause && !p.id && rec.time) {
    saveChild_(u, 'Pauses', { sv_id: rec.sv_id, start: rec.time, reason: lines_(st.pause_reasons)[0] || 'Cetacean in alert zone', sighting_id: rec.id, remark: '' },
      ['start','end','reason','sighting_id','remark'], ['start']);
  }
  return rec;
}
function deleteChild_(u, sheet, id) {
  return withLock_(() => {
    const r = Repo.get(sheet, id);
    if (!r) fail_('Record not found', 'NOT_FOUND');
    shiftEditable_(u, r.shift_id);
    Repo.remove(sheet, id);
    if (sheet === 'Sightings') Repo.all('Pauses').filter(p => p.sighting_id === id).forEach(p => Repo.update('Pauses', p.id, { sighting_id: '' }));
    return { id: id };
  });
}

// ============ Drive ============
function safeName_(s) { return str_(s).replace(/[\\/:*?"<>|#%]+/g, '_').slice(0, 80) || '_'; }
function shiftFolderName_(s) { return safeName_(s.date + '_班次' + s.shift_no + (s.construction_vessel ? '_' + s.construction_vessel : '')); }
function childFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
function shiftFolder_(s) {
  if (s.folder_id) { try { const f = DriveApp.getFolderById(s.folder_id); if (!f.isTrashed()) return f; } catch (e) {} }
  const f = DriveApp.getFolderById(ROOT_FOLDER_ID).createFolder(shiftFolderName_(s));
  Repo.update('Shifts', s.id, { folder_id: f.getId() });
  return f;
}
function svFolder_(shift, sv) {
  if (sv.folder_id) { try { const f = DriveApp.getFolderById(sv.folder_id); if (!f.isTrashed()) return f; } catch (e) {} }
  const f = childFolder_(shiftFolder_(shift), safeName_(sv.vessel_name));
  Repo.update('ShiftVessels', sv.id, { folder_id: f.getId() });
  return f;
}
function uploadFile_(u, p) {
  const file = p.file || {};
  if (!file.data) fail_('No file');
  const bytes = Utilities.base64Decode(String(file.data));
  if (bytes.length > MAX_FILE_BYTES) fail_('File is larger than 20 MB');
  const sv = Repo.get('ShiftVessels', p.sv_id);
  if (!sv) fail_('Vessel record not found', 'NOT_FOUND');
  const shift = shiftEditable_(u, sv.shift_id);
  const item = Repo.get('UploadItems', p.item_id);
  if (!item) fail_('Upload item not found', 'NOT_FOUND');
  const folder = withLock_(() => childFolder_(svFolder_(shift, sv), safeName_(item.name_zh)));
  const orig = safeName_(file.name || 'file');
  const name = safeName_(shift.date + '_' + sv.vessel_name + '_' + item.name_zh) + '_' + orig;
  const f = folder.createFile(Utilities.newBlob(bytes, str_(file.mime) || 'application/octet-stream', name));
  const thumb = str_(p.thumb);
  const rec = { id: genId_(), shift_id: shift.id, sv_id: sv.id, item_id: item.id, item_name: item.name_zh, kind: item.kind, drive_id: f.getId(),
    name: orig, mime: str_(file.mime), size: String(bytes.length), thumb: thumb.length <= MAX_THUMB_CHARS ? thumb : '',
    uploaded_by: u.username, uploaded_at: nowIso_() };
  withLock_(() => Repo.insert('Files', rec));
  const out = Object.assign({}, rec); delete out.thumb;
  return out;
}
function deleteFile_(u, id) {
  return withLock_(() => {
    const r = Repo.get('Files', id);
    if (!r) fail_('File not found', 'NOT_FOUND');
    shiftEditable_(u, r.shift_id);
    try { DriveApp.getFileById(r.drive_id).setTrashed(true); } catch (e) {}
    Repo.remove('Files', id);
    return { id: id, name: r.name };
  });
}
function getFile_(id) {
  const r = Repo.get('Files', id);
  if (!r) fail_('File not found', 'NOT_FOUND');
  const blob = DriveApp.getFileById(r.drive_id).getBlob();
  if (blob.getBytes().length > 25 * 1024 * 1024) fail_('File too large to preview — open it in Drive');
  return { name: r.name, mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}

// ============ 船位（之後接付費 API） ============
function fetchPosition_(p) {
  const st = settings_();
  if (!st.ais_api_url) fail_('Vessel position API is not configured yet', 'NOT_CONFIGURED');
  const mmsi = str_(p.mmsi);
  if (!mmsi) fail_('This vessel has no MMSI');
  const url = st.ais_api_url.replace('{mmsi}', encodeURIComponent(mmsi)).replace('{key}', encodeURIComponent(st.ais_api_key || ''));
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) fail_('Position API returned HTTP ' + res.getResponseCode());
  const j = JSON.parse(res.getContentText());
  // 通用解析：找第一個有 lat/lon（或 latitude/longitude）的物件；接上實際 API 時再依格式調整
  const found = (function walk(o) {
    if (!o || typeof o !== 'object') return null;
    const lat = o.lat !== undefined ? o.lat : (o.latitude !== undefined ? o.latitude : o.LAT);
    const lon = o.lon !== undefined ? o.lon : (o.lng !== undefined ? o.lng : (o.longitude !== undefined ? o.longitude : o.LON));
    if (lat !== undefined && lon !== undefined && isFinite(Number(lat)) && isFinite(Number(lon))) return { lat: Number(lat), lon: Number(lon), time: o.timestamp || o.time || o.TIMESTAMP || '' };
    for (const k in o) { const r = walk(o[k]); if (r) return r; }
    return null;
  })(j);
  if (!found) fail_('Could not find a position in the API response');
  return found;
}

// ============ Master data ============
function saveMaster_(sheet, p, fields, required) {
  return withLock_(() => {
    const patch = { };
    fields.forEach(k => { if (p[k] !== undefined) patch[k] = (k === 'active' || k === 'required') ? (bool_(p[k]) ? 'TRUE' : 'FALSE') : str_(p[k]); });
    required.forEach(k => { if (!p.id && !patch[k]) fail_('Missing field: ' + k); });
    if (SCHEMAS[sheet].indexOf('updated_at') >= 0) patch.updated_at = nowIso_();
    if (p.id) return Repo.update(sheet, p.id, patch);
    const rec = Object.assign({ id: genId_(), active: 'TRUE' }, patch);
    if (SCHEMAS[sheet].indexOf('created_at') >= 0) rec.created_at = nowIso_();
    Repo.insert(sheet, rec);
    return rec;
  });
}
function deleteMaster_(sheet, id) {
  return withLock_(() => {
    if (sheet === 'Vessels' && (Repo.all('ShiftVessels').some(x => x.vessel_id === id) || Repo.all('Shifts').some(x => x.construction_vessel_id === id)))
      fail_('This vessel is used in shifts — set it inactive instead');
    const r = Repo.get(sheet, id);
    Repo.remove(sheet, id);
    return { id: id, name: r && r.name };
  });
}
function deleteItem_(id) {
  return withLock_(() => {
    if (Repo.all('Files').some(f => f.item_id === id)) fail_('Files were uploaded under this item — set it inactive instead');
    Repo.remove('UploadItems', id);
    return { id: id };
  });
}
function saveSettings_(p) {
  return withLock_(() => {
    Object.keys(DEFAULT_SETTINGS).forEach(k => {
      if (p[k] === undefined) return;
      if (SECRET_SETTINGS[k] && p[k] === '••••') return;
      const v = String(p[k]);
      if (Repo.get('Settings', k)) Repo.update('Settings', k, { value: v }); else Repo.insert('Settings', { key: k, value: v });
    });
    return true;
  });
}

// ============ 總表（每次班次資料異動後重建） ============
function rebuildSummary_() {
  Repo.flush();
  const st = settings_();
  const slots = lines_(st.crew_slots);
  const shifts = Repo.all('Shifts').sort((a, b) => (b.date + b.shift_no).localeCompare(a.date + a.shift_no, undefined, { numeric: true }));
  const svs = Repo.all('ShiftVessels'), pauses = Repo.all('Pauses'), sightings = Repo.all('Sightings'), files = Repo.all('Files'), items = Repo.all('UploadItems');
  const STATUS = { idle: '未開始', pre: '預觀測中', preDone: '預觀測完成', work: '施工中', paused: '停工中', done: '已完工' };
  const head = ['日期', '班次', '工區', '工作範疇', '施工船', 'MMO 船'].concat(slots).concat(['預觀測開始', '預觀測結束', '預觀測(分)',
    '施工開始', '施工結束', '施工時長(分)', '停工次數', '停工總計(分)', '目擊次數', '物種', '警戒區內目擊', '緯度', '經度', '風速(kn)', '浪高(m)',
    '文件', '照片', '缺件', '規則提醒', '狀態', '班次結案', 'Drive 資料夾']);
  const rows = [];
  shifts.forEach(s => {
    svs.filter(x => x.shift_id === s.id).sort((a, b) => Number(a.sort) - Number(b.sort)).forEach(sv => {
      const ck = checks_(sv, pauses, sightings, files, items, st);
      const crew = parseJson_(sv.crew, {});
      const ps = pauses.filter(p => p.sv_id === sv.id);
      const ss = sightings.filter(x => x.sv_id === sv.id);
      const wx = parseJson_(sv.weather, {});
      const pauseMin = ps.reduce((m, p) => m + (p.end ? Math.max(0, mins_(p.start, p.end)) : 0), 0);
      const n = v => (isNaN(v) ? '' : v);
      const alertM = Number(st.alert_zone_m) || 750;
      const folder = sv.folder_id || s.folder_id;
      rows.push([s.date, s.shift_no, s.site, s.scope, s.construction_vessel, sv.vessel_name]
        .concat(slots.map(k => (crew[k] && crew[k].name) || ''))
        .concat([t_(sv.pre_start), t_(sv.pre_end), n(mins_(sv.pre_start, sv.pre_end)), t_(sv.work_start), t_(sv.work_end), n(mins_(sv.work_start, sv.work_end)),
          ps.length, pauseMin, ss.length, Array.from(new Set(ss.map(x => x.species).filter(Boolean))).join('、'),
          ss.filter(x => bool_(x.in_alert_zone) || (x.min_distance_m !== '' && Number(x.min_distance_m) <= alertM)).length,
          sv.lat, sv.lon, wx.wind !== undefined ? wx.wind : '', wx.wave !== undefined ? wx.wave : '',
          ck.docs[0] + '/' + ck.docs[1], ck.photos[0] + '/' + ck.photos[1], ck.missing.map(m => m.zh).join('、'),
          ck.warnings.map(w => w.zh).join('；'), STATUS[ck.status], s.status === 'closed' ? '已結案' : '',
          folder ? '=HYPERLINK("https://drive.google.com/drive/folders/' + folder + '","開啟")' : '']));
    });
  });
  writeTable_('總表', head, rows, 0);

  const sHead = ['日期', '班次', '工區', '施工船', 'MMO 船', '目擊時間', '物種', '數量', '偵測方式', '最近距離(m)', '進入警戒區', '處置', '離開警戒區時間', '緯度', '經度', '行為', '備註', '登錄者'];
  const sRows = [];
  sightings.slice().sort((a, b) => b.time.localeCompare(a.time)).forEach(x => {
    const s = shifts.find(z => z.id === x.shift_id) || {};
    const sv = svs.find(z => z.id === x.sv_id) || {};
    sRows.push([s.date || '', s.shift_no || '', s.site || '', s.construction_vessel || '', sv.vessel_name || '', t_(x.time), x.species, x.count, x.detection,
      x.min_distance_m, bool_(x.in_alert_zone) ? '是' : '否', x.action, t_(x.left_time), x.lat, x.lon, x.behavior, x.remark, x.created_by]);
  });
  writeTable_('目擊總表', sHead, sRows, 1);
}
function t_(s) { return s ? String(s).replace('T', ' ').slice(0, 16) : ''; }
function writeTable_(name, head, rows, pos) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name, pos); }
  sh.clear();
  const all = [head].concat(rows);
  sh.getRange(1, 1, all.length, head.length).setValues(all);
  sh.getRange(1, 1, 1, head.length).setFontWeight('bold').setBackground('#002038').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  if (rows.length) sh.getRange(2, 1, rows.length, head.length).setVerticalAlignment('top');
}
