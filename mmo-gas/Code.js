// ============================================================
// NMDC MMO — 鯨豚觀察及離岸環保統計系統 · Google Apps Script backend
// 前端 https://d9533472.github.io/NMDCMMO/ ；原始碼 E:\NMDCMMO\mmo-gas\Code.js（clasp push + deploy -i <prod id>）
// 依「台灣鯨豚觀察員制度作業指引（第四版）」：預觀測 → 施工 → 目擊／暫停施工／回復施工 → 結束，紙本表單掃描上傳。
//
// 協定：POST text/plain JSON {action, token, payload} → {ok:true, data, state?} / {ok:false, error, code}
//       GET ?action=ping 僅供健康檢查（GET 不做任何寫入）
// 資料：Drive 資料夾 ROOT_FOLDER_ID 內的試算表「MMO 鯨豚觀察總表」（setup() 建立，id 存 Script Properties ss_id）
//       上傳檔案：ROOT/<日期>_<批次>_<施工船>/軌跡/、<MMO 船>/紙本紀錄/、<MMO 船>/照片/<MM-DD_00-12>/
// 角色：admin（全部＋後台）、mmo（建立／填報批次、上傳）、viewer（唯讀）
// ============================================================

const VERSION = '1.7.0';
const ROOT_FOLDER_ID = '1uVkbv4tndRVERhrHmHUzaTvPlHaFV4em';
const SS_NAME = 'MMO 鯨豚觀察總表';
const TZ = 'Asia/Taipei';

const SCHEMAS = {
  Users: ['id','username','name','email','role','password_salt','password_hash','active','must_change','last_login','created_at','updated_at'],
  Sessions: ['token','user_id','expires_at','created_at'],
  Settings: ['key','value'],
  Vessels: ['id','name','kind','mmsi','imo','type','operator','remark','active','sort','created_at','updated_at',
    'last_lat','last_lon','last_fix','last_speed','last_course','last_fetch','last_error','tracking','track_id',
    'charter_start','charter_end','fuel_type','env_report'],
  Tracks: ['id','vessel_id','vessel_name','mmsi','start','end','interval_min','started_by','stopped_by','remark'],
  Observers: ['id','name','role','company','phone','cert_no','remark','active','created_at','updated_at'],
  UploadItems: ['id','kind','name_zh','name_en','required','cond','active','sort','note'],
  Shifts: ['id','shift_no','date','site','scope','turbine_no','construction_vessel_id','construction_vessel','status','remark','folder_id',
    'created_by','created_at','updated_by','updated_at','closed_by','closed_at'],
  ShiftVessels: ['id','shift_id','vessel_id','vessel_name','mmsi','sort','crew','pre_start','pre_end','work_start','full_start','work_end',
    'lat','lon','pos_time','pos_source','weather','sea_state','remark','folder_id','updated_by','updated_at'],
  Pauses: ['id','shift_id','sv_id','start','end','reason','sighting_id','monitoring','restart','remark','created_by','created_at','updated_at','pre_start','pre_end'],
  Sightings: ['id','shift_id','sv_id','time','species','count','detection','min_distance_m','in_alert_zone','action','left_time',
    'lat','lon','behavior','remark','bearing','direction','deck','vessel_dist_m','piling_status','mother_calf','image',
    'call_type','freq_khz','hydrophone_m','created_by','created_at','updated_at'],
  Files: ['id','shift_id','sv_id','item_id','item_name','kind','drive_id','name','mime','size','thumb','uploaded_by','uploaded_at','slot'],
  AuditLog: ['time','user','role','action','target','detail','ok','error'],
  // 離岸環保統計（只有管理員看得到，不放進共用快取）
  EnvDaily: ['id','vessel_id','vessel_name','date','pob','fuel_used_m3','water_used_m3','remark',
    'updated_by','updated_at'],
  EnvWaste: ['id','vessel_id','vessel_name','date','method','receiver','port','receipt_no','items','total_kg','drive_id','file_name','file_mime','remark',
    'created_by','created_at','updated_by','updated_at'],
  EnvIncidents: ['id','vessel_id','vessel_name','time','type','severity','substance','quantity','lat','lon','description','action','reported_to','status','closed_at',
    'created_by','created_at','updated_by','updated_at']
};

const DEFAULT_SETTINGS = {
  project_name: 'NMDC 鯨豚觀察及離岸環保統計系統',
  pre_watch_min: '30',          // 預觀測時間（分）
  alert_zone_m: '750',          // 警戒區半徑（m）
  watch_zone_m: '1500',         // 觀察區半徑（m）
  response_min: '10',           // 警戒區內目擊後幾分鐘內須啟動應變（暫停施工）
  repre_pause_min: '60',        // 暫停施工超過幾分鐘須重新預觀測
  mmo_dist_tol_m: '150',        // 船距判定：警戒區半徑 ± 此值視為「在附近」
  crew_slots: 'TCO\nPAMO',
  sites: '通霄 Tongxiao, 24.47, 120.55',
  scopes: '海管鋪設 Pipelay\n拋石作業 Rock placement\n後噴埋 Post-lay jetting\n回填作業 Backfilling\n超長段作業 Extra-long section',
  species: '台灣白海豚 Taiwanese humpback dolphin\n印太瓶鼻海豚 Indo-Pacific bottlenose dolphin\n瓶鼻海豚 Common bottlenose dolphin\n印太露脊鼠海豚 Indo-Pacific finless porpoise\n熱帶斑海豚 Pantropical spotted dolphin\n飛旋海豚 Spinner dolphin\n糙齒海豚 Rough-toothed dolphin\n未知鯨豚 Unidentified cetacean',
  pause_reasons: '目擊鯨豚進入警戒區 Cetacean in alert zone\nPAM 偵測到鯨豚 PAM detection\n天氣／能見度不佳 Poor weather / visibility\n設備故障 Equipment failure\n其他 Other',
  ais_api_url: '',              // 之後接付費船位 API（伺服器端呼叫，金鑰不給前端）
  ais_api_key: '',
  pos_interval_min: '60',       // 儀表板自動更新船位（分鐘；0＝關閉），所有啟用且有 MMSI 的船
  track_interval_min: '10',     // 記錄軌跡中的船：每幾分鐘抓一次
  weather_name: '',             // 儀表板海象地圖標題
  weather_points: '',           // 海象預報點：每行「名稱, 緯度, 經度」（空白＝用工區座標）
  weather_wave_limit: '1.5',
  weather_wind_limit: '25',
  // 環保：燃料每行「名稱, 密度 kg/L, CO₂ 排放係數 t/t 燃料」（係數依 IMO MEPC.308(73)）
  env_fuels: 'MGO, 0.85, 3.206\nMDO, 0.89, 3.206\nVLSFO, 0.94, 3.151\nHFO, 0.98, 3.114',
  env_waste_cats: '塑膠 Plastics\n食物廢棄物 Food waste\n生活廢棄物 Domestic waste\n廢食用油 Cooking oil\n焚化爐灰燼 Incinerator ash\n作業廢棄物 Operational waste\n電子廢棄物 E-waste\n有害廢棄物 Hazardous waste\n油泥 Oil sludge\n艙底油水 Oily bilge water\n污水 Sewage\n資源回收 Recyclables',
  env_waste_methods: '上岸交運 Landed ashore\n船上焚化 Incinerated on board\n依 MARPOL 排放 Discharged per MARPOL\n資源回收 Recycled',
  env_incident_types: '漏油／溢油 Oil spill\n化學品洩漏 Chemical spill\n物品落海 Object overboard\n廢棄物不當排放 Improper discharge\n其他 Other',
  env_zero_start: '2025-01-02'   // 連續零事件天數起算日（之後若有事件就從最近一次事件算）
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
  ['photo', '被動聲學監測照片', 'PAM monitoring photos', 'always'],
  ['photo', 'AIS 照片', 'AIS photos', 'always']
];

const ROLES = ['admin', 'mmo', 'viewer'];
const VIEWER_OK = { 'data.load': 1, 'data.rev': 1, 'file.get': 1, 'shift.files': 1, 'pos.list': 1, 'auth.logout': 1 };
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
const NO_REV = { 'env.file': 1, 'ping': 1, 'auth.status': 1, 'auth.login': 1, 'auth.logout': 1, 'auth.changePassword': 1, 'data.load': 1, 'data.rev': 1,
  'audit.list': 1, 'file.get': 1, 'shift.files': 1, 'pos.fetch': 1, 'pos.test': 1, 'pos.list': 1, 'reset.request': 1 };
const AUDIT_SKIP = { 'env.file': 1, 'ping': 1, 'auth.status': 1, 'data.load': 1, 'data.rev': 1, 'audit.list': 1, 'file.get': 1, 'shift.files': 1, 'pos.list': 1 };
// 這些寫入會改到批次資料 → 重建試算表「總表」
const SUMMARY_ACTIONS = /^((shift|sv|pause|sighting|file)\.(save|delete|close|reopen|upload)|reset\.confirm)$/;

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
    // 重建總表要好幾秒，不拖慢存檔：先記下來，由 positionTick 排程補做
    if (SUMMARY_ACTIONS.test(action)) PropertiesService.getScriptProperties().setProperty('summary_dirty', '1');
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
  'shift.delete': (u, p) => { requireRole_(u, ['admin']); const ids = shiftVesselIds_(p.id), r = deleteShift_(p.id); syncAutoTrack_(u, ids); return r; },
  'shift.files': (u, p) => ({ files: Repo.all('Files').filter(f => f.shift_id === p.id) }),
  'sv.save': (u, p) => saveShiftVessel_(u, p),
  'pause.save': (u, p) => savePause_(u, p),
  'pause.delete': (u, p) => deleteChild_(u, 'Pauses', p.id),
  'sighting.save': (u, p) => saveSighting_(u, p),
  'sighting.delete': (u, p) => deleteChild_(u, 'Sightings', p.id),
  'file.upload': (u, p) => uploadFile_(u, p),
  'file.delete': (u, p) => deleteFile_(u, p.id),
  'file.get': (u, p) => getFile_(p.id),
  'pos.fetch': (u, p) => fetchPosition_(p),
  'pos.test': (u) => { requireRole_(u, ['admin']); return testPositionApi_(); },
  'pos.refresh': (u, p) => refreshPositions_(p.vessel_id ? [p.vessel_id] : null, true),
  'pos.list': (u, p) => listPositions_(p),
  'track.start': (u, p) => startTrack_(u, p),
  'track.stop': (u, p) => stopTrack_(u, p),

  'vessel.save': (u, p) => { requireRole_(u, ['admin']); return saveMaster_('Vessels', p, ['name','kind','mmsi','imo','type','operator','remark','active','sort',
    'charter_start','charter_end','fuel_type','env_report'], ['name','kind']); },
  'vessel.delete': (u, p) => { requireRole_(u, ['admin']); return deleteMaster_('Vessels', p.id); },
  'observer.save': (u, p) => { requireRole_(u, ['admin']); return saveMaster_('Observers', p, ['name','role','company','phone','cert_no','remark','active'], ['name']); },
  'observer.delete': (u, p) => { requireRole_(u, ['admin']); return deleteMaster_('Observers', p.id); },
  'item.save': (u, p) => { requireRole_(u, ['admin']); return saveMaster_('UploadItems', p, ['kind','name_zh','name_en','required','cond','active','sort','note'], ['kind','name_zh']); },
  'item.delete': (u, p) => { requireRole_(u, ['admin']); return deleteItem_(p.id); },
  'settings.save': (u, p) => { requireRole_(u, ['admin']); return saveSettings_(p); },
  'user.save': (u, p) => { requireRole_(u, ['admin']); return saveUser_(u, p); },
  'user.delete': (u, p) => { requireRole_(u, ['admin']); return deleteUser_(u, p.id); },
  'audit.list': (u, p) => { requireRole_(u, ['admin']); return auditList_(p); },
  'reset.request': (u, p) => { requireRole_(u, ['admin']); return resetRequest_(u, p); },
  'reset.confirm': (u, p) => { requireRole_(u, ['admin']); return resetConfirm_(u, p); },
  'env.daily.save': (u, p) => { requireRole_(u, ['admin']); return envDailySave_(u, p); },
  'env.daily.delete': (u, p) => { requireRole_(u, ['admin']); return withLock_(() => ({ id: p.id, ok: Repo.remove('EnvDaily', p.id) })); },
  'env.waste.save': (u, p) => { requireRole_(u, ['admin']); return envWasteSave_(u, p); },
  'env.waste.delete': (u, p) => { requireRole_(u, ['admin']); return envWasteDelete_(p.id); },
  'env.file': (u, p) => { requireRole_(u, ['admin']); return envFile_(p.id); },
  'env.incident.save': (u, p) => { requireRole_(u, ['admin']); return envIncidentSave_(u, p); },
  'env.incident.delete': (u, p) => { requireRole_(u, ['admin']); return withLock_(() => ({ id: p.id, ok: Repo.remove('EnvIncidents', p.id) })); },
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
    /** 清空資料列、保留標題列（Sheets 不允許刪掉所有未凍結列，所以用清除內容） */
    clear: function (name) {
      const t = load_(name), last = t.sh.getLastRow();
      const n = t.rows.filter(r => r[key_(name)]).length;
      if (last > 1) t.sh.getRange(2, 1, last - 1, t.sh.getLastColumn()).clearContent();
      delete cache[name];
      return n;
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
    // v1.5：職位 TCO1–4 併成 TCO，可勾多人；舊紀錄同步合併（後台自訂過職位的不動）
    if (!props.getProperty('v15_crew')) {
      const cur = Repo.all('Settings').find(x => x.key === 'crew_slots');
      if (cur && /^TCO1\s+TCO2\s+TCO3\s+TCO4\s+PAMO\s*$/.test(cur.value)) {
        Repo.update('Settings', 'crew_slots', { value: DEFAULT_SETTINGS.crew_slots });
        Repo.all('ShiftVessels').forEach(sv => {
          const old = parseJson_(sv.crew, {}), merged = {};
          Object.keys(old).forEach(k => {
            if (!old[k] || !old[k].name) return;
            const m = merged[k.replace(/\d+$/, '')] = merged[k.replace(/\d+$/, '')] || { ids: [], names: [] };
            if (m.names.indexOf(old[k].name) < 0) { m.names.push(old[k].name); if (old[k].id) m.ids.push(old[k].id); }
          });
          const out = {};
          Object.keys(merged).forEach(k => { out[k] = { id: merged[k].ids.join(','), name: merged[k].names.join('、') }; });
          Repo.update('ShiftVessels', sv.id, { crew: JSON.stringify(out) });
        });
      }
      props.setProperty('v15_crew', '1');
      bumpRev_();
    }
    // v1.6.3：用油改用 m³；v1.6 存的公升欄位換算後清空（舊欄位留在表上不再使用）
    if (!props.getProperty('v163_fuel_m3')) {
      Repo.all('EnvDaily').forEach(r => {
        const patch = {};
        ['used', 'bunkered', 'rob'].forEach(k => {
          const l = r['fuel_' + k + '_l'];
          if (l !== undefined && l !== '') { if (r['fuel_' + k + '_m3'] === '') patch['fuel_' + k + '_m3'] = String(Number(l) / 1000); patch['fuel_' + k + '_l'] = ''; }
        });
        if (Object.keys(patch).length) Repo.update('EnvDaily', r.id, patch);
      });
      props.setProperty('v163_fuel_m3', '1');
      bumpRev_();
    }
    // v1.6.2：系統名稱加上離岸環保統計（後台自訂過的名稱不動）
    if (!props.getProperty('v162_name')) {
      const cur = Repo.all('Settings').find(x => x.key === 'project_name');
      if (cur && /鯨豚觀察作業系統/.test(cur.value) && !/環保/.test(cur.value)) Repo.update('Settings', 'project_name', { value: DEFAULT_SETTINGS.project_name });
      props.setProperty('v162_name', '1');
      bumpRev_();
    }
    // v1.4：資料夾改用批次名稱、照片多一項 AIS 照片
    if (!props.getProperty('v14_batch')) {
      Repo.all('Shifts').forEach(s => { if (s.folder_id) { try { DriveApp.getFolderById(s.folder_id).setName(shiftFolderName_(s)); } catch (e) {} } });
      const list = Repo.all('UploadItems');
      if (!list.find(i => i.name_zh === 'AIS 照片')) {
        const c = ITEM_SEED[ITEM_SEED.length - 1];
        Repo.insert('UploadItems', { id: genId_(), kind: c[0], name_zh: c[1], name_en: c[2], required: 'TRUE', cond: c[3], active: 'TRUE', sort: String(list.length + 1), note: '' });
      }
      props.setProperty('v14_batch', '1');
      bumpRev_();
    }
    // 只換一次工項清單：之後後台自己改的內容不會被蓋掉；舊批次的工項值保留不動
    if (!props.getProperty('scopes_pipeline')) {
      Repo.update('Settings', 'scopes', { value: DEFAULT_SETTINGS.scopes });
      props.setProperty('scopes_pipeline', '1');
      bumpRev_();
    }
    props.setProperty('schema_version', VERSION);
  } finally { lock.releaseLock(); }
}

/** 在 GAS 編輯器手動執行一次：授權 Drive／試算表、建立總表 */
function setup() {
  MailApp.getRemainingDailyQuota();   // 清空資料要寄驗證碼：實際呼叫 MailApp，授權畫面才會要求寄信權限
  PropertiesService.getScriptProperties().deleteProperty('schema_version');
  ensureSchema_();
  rebuildSummary_();
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'positionTick').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('positionTick').timeBased().everyMinutes(5).create();
  Logger.log('OK — 總表: ' + ss_().getUrl() + ' · root folder: ' + DriveApp.getFolderById(ROOT_FOLDER_ID).getName() + ' · positionTick every 5 min');
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
const AUDIT_SECRET = { password: 1, oldPassword: 1, newPassword: 1, data: 1, thumb: 1, ais_api_key: 1, code: 1 };
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
// 共用資料（跟使用者無關的部分）依資料版本 rev 快取在 CacheService：同一版本只讀一次試算表。
// 單一快取值上限 100 KB，所以切成 90 KB 一段存；最多存 1 小時（近 24 小時船位會隨時間變動）。
function loadData_(u) {
  const out = Object.assign({}, sharedState_());
  out.user = publicUser_(u);
  out.posTick = PropertiesService.getScriptProperties().getProperty('pos_tick') || '';
  if (u.role === 'admin') {
    out.users = Repo.all('Users').map(publicUser_);
    out.env = { daily: Repo.all('EnvDaily'), waste: Repo.all('EnvWaste'), incidents: Repo.all('EnvIncidents') };
  }
  return out;
}
function sharedState_() {
  const rev = dataRev_(), cache = CacheService.getScriptCache(), key = 'st_' + rev;
  try {
    const n = Number(cache.get(key + '_n'));
    if (n > 0) {
      const parts = cache.getAll(Array.from({ length: n }, (x, i) => key + '_' + i));
      const txt = Array.from({ length: n }, (x, i) => parts[key + '_' + i]);
      if (txt.every(t => typeof t === 'string')) return JSON.parse(txt.join(''));
    }
  } catch (e) { console.warn('state cache read: ' + e.message); }
  const st = buildState_(rev);
  try {
    const txt = JSON.stringify(st), size = 90000, put = {};
    let i = 0;
    for (; i * size < txt.length; i++) put[key + '_' + i] = txt.slice(i * size, (i + 1) * size);
    if (i <= 50) { put[key + '_n'] = String(i); cache.putAll(put, 3600); }
  } catch (e) { console.warn('state cache write: ' + e.message); }
  return st;
}
function buildState_(rev) {
  const st = settings_();
  const pub = {};
  Object.keys(st).forEach(k => { pub[k] = SECRET_SETTINGS[k] ? (st[k] ? '••••' : '') : st[k]; });
  const shifts = Repo.all('Shifts');
  const svs = Repo.all('ShiftVessels');
  const pauses = Repo.all('Pauses');
  const sightings = Repo.all('Sightings');
  const files = Repo.all('Files').map(f => { const c = Object.assign({}, f); delete c.thumb; return c; });
  const items = Repo.all('UploadItems');
  svs.forEach(sv => { sv.checks = checks_(sv, pauses, sightings, files, items, st, posFor_(sv, shifts.find(x => x.id === sv.shift_id), st), svs); });
  const out = {
    version: VERSION, settings: pub, rev: rev,
    vessels: Repo.all('Vessels'), observers: Repo.all('Observers'), items: items,
    shifts: shifts, svs: svs, pauses: pauses, sightings: sightings, files: files,
    sheetUrl: 'https://docs.google.com/spreadsheets/d/' + PropertiesService.getScriptProperties().getProperty('ss_id'),
    rootUrl: 'https://drive.google.com/drive/folders/' + ROOT_FOLDER_ID
  };
  out.tracks = tracksWithPoints_();
  out.positions = recentPositions_(24);
  return out;
}

// ============ 日出日落（NOAA 近似公式，誤差數分鐘；回傳台北時間「當日分鐘數」） ============
function sunTimes_(date, lat, lon) {
  const m = String(date).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const n = Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(+m[1], 0, 1)) / 864e5) + 1;
  const g = 2 * Math.PI / 365 * (n - 1);
  const eot = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const phi = lat * Math.PI / 180;
  const c = (Math.cos(90.833 * Math.PI / 180) / (Math.cos(phi) * Math.cos(decl))) - Math.tan(phi) * Math.tan(decl);
  if (c < -1 || c > 1) return null;
  const ha = Math.acos(c) * 180 / Math.PI;
  const noon = 720 - 4 * lon - eot + 480;   // UTC+8
  return { rise: Math.round(noon - 4 * ha), set: Math.round(noon + 4 * ha) };
}
function hm_(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
/** 檢核用的座標：船位優先，否則工區座標 */
function posFor_(sv, shift, st) {
  if (sv.lat && sv.lon && isFinite(Number(sv.lat)) && isFinite(Number(sv.lon))) return { lat: Number(sv.lat), lon: Number(sv.lon) };
  const site = lines_(st.sites).map(l => l.split(',').map(x => x.trim())).find(a => shift && a[0] === shift.site) || lines_(st.sites).map(l => l.split(',').map(x => x.trim()))[0];
  return site && isFinite(parseFloat(site[1])) && isFinite(parseFloat(site[2])) ? { lat: parseFloat(site[1]), lon: parseFloat(site[2]) } : null;
}

// ============ 規則檢核（依作業指引） ============
/** 12 小時時段（00–12、12–24）：預觀測開始到實際觀測結束，進行中算到現在；結束剛好在 12:00 不算下一段。前端 svSlots 同規則 */
function slotsOf_(from, to) {
  if (!from) return [];
  const abs = t => Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1, Number(t.slice(8, 10)), Number(t.slice(11, 13)), Number(t.slice(14, 16)));
  const H12 = 12 * 3600000, a = abs(from), b = Math.max(abs(to || nowIso_()) - 60000, a), out = [];
  for (let t = Math.floor(a / H12) * H12; t <= b; t += H12) out.push(new Date(t).toISOString().slice(0, 13).replace('T', '_'));
  return out;
}
/** 同批次各船時段同步：自最早的預觀測開始到最晚的實際觀測結束（有船仍進行中就算到現在）；此船尚未開始則無時段。前端 svSlots 同規則 */
function shiftSlots_(sv, svs) {
  if (!sv.pre_start) return [];
  const sib = svs.filter(x => x.shift_id === sv.shift_id && x.pre_start);
  const from = sib.reduce((m, x) => x.pre_start < m ? x.pre_start : m, sv.pre_start);
  const to = sib.some(x => !x.work_end) ? '' : sib.reduce((m, x) => x.work_end > m ? x.work_end : m, '');
  return slotsOf_(from, to);
}
function slotLabel_(k) { return k.slice(5, 10) + ' ' + k.slice(11, 13) + ':00–' + (k.slice(11, 13) === '00' ? '12' : '24') + ':00'; }
function slotLabelZh_(k) { return Number(k.slice(5, 7)) + '月' + Number(k.slice(8, 10)) + '日 ' + k.slice(11, 13) + '時~' + (k.slice(11, 13) === '00' ? '12' : '24') + '時'; }
function slotFolder_(k) { return k.slice(5, 10) + '_' + k.slice(11, 13) + '-' + (k.slice(11, 13) === '00' ? '12' : '24'); }
/** 回傳 { status, warnings:[{code,en,zh}], missing:[{item_id,en,zh}], docs:[have,need], photos:[have,need] } */
function checks_(sv, pauses, sightings, files, items, st, pos, svs) {
  const W = [];
  const add = (code, en, zh, pauseId) => W.push({ code: code, en: en, zh: zh, pause_id: pauseId || '' });
  const preMin = Number(st.pre_watch_min) || 30, alertM = Number(st.alert_zone_m) || 750;
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
  if (sv.work_start && !sv.pre_end) add('no_pre', 'Observation started without a completed pre-watch', '未完成預觀測即開始實際觀測');
  if (sv.work_start && sv.pre_end && mins_(sv.pre_end, sv.work_start) < 0) add('work_early', 'Observation started before pre-watch ended', '實際觀測開始早於預觀測結束');
  if (sv.work_start && sv.work_end && mins_(sv.work_start, sv.work_end) < 0) add('work_order', 'Observation end is before its start', '實際觀測結束早於開始');
  if (sv.work_end && openPause) add('pause_open', 'A pause has no resume time', '有暫停施工未記錄回復施工時間');
  const respMin = Number(st.response_min) || 10, repreMin = Number(st.repre_pause_min) || 60;
  const inZone = s => bool_(s.in_alert_zone) || (s.min_distance_m !== '' && Number(s.min_distance_m) <= alertM);
  // 預觀測與實際觀測開始應於白天（日落前）且視線良好（非大雨、大霧）
  if (pos && isFinite(pos.lat) && isFinite(pos.lon)) {
    [['pre_start', 'Pre-watch', '預觀測'], ['work_start', 'Observation', '實際觀測']].forEach(f => {
      const v = sv[f[0]];
      if (!v) return;
      const sun = sunTimes_(v.slice(0, 10), pos.lat, pos.lon);
      const m = Number(v.slice(11, 13)) * 60 + Number(v.slice(14, 16));
      if (sun && (m > sun.set || m < sun.rise)) add('night_' + f[0], f[1] + ' started outside daylight (sunrise ' + hm_(sun.rise) + ', sunset ' + hm_(sun.set) + ')',
        f[2] + '開始時間不在白天（日出 ' + hm_(sun.rise) + '、日落 ' + hm_(sun.set) + '）');
    });
  }
  const wx = parseJson_(sv.weather, {});
  if (wx && wx.vis !== undefined && wx.vis !== null && wx.vis !== '' && Number(wx.vis) < 1) add('low_vis', 'Visibility under 1 km at pre-watch (' + wx.vis + ' km)', '預觀測時能見度低於 1 公里（' + wx.vis + ' km）');
  ps.forEach(p => {
    if (p.end && mins_(p.start, p.end) < 0) add('pause_order', 'Resume time is before pause time', '回復施工時間早於暫停施工時間');
    // 暫停施工超過門檻，或鯨豚進入警戒區（離開後）→ 回復施工前須重新預觀測
    if (!p.end || (sv.work_end && tms_(p.end) >= tms_(sv.work_end)) || p.restart === 'prewatch') return;
    const hh = p.start.slice(11, 16), end = tms_(p.end);
    const zs = ss.filter(s => inZone(s) && (s.id === p.sighting_id || (tms_(s.time) <= end && (s.left_time ? tms_(s.left_time) > tms_(p.start) : tms_(s.time) >= tms_(p.start)))));
    if (!zs.length && mins_(p.start, p.end) <= repreMin) return;
    const last = zs.reduce((m, s) => Math.max(m, tms_(s.left_time || s.time)), 0);
    if (!p.pre_start || !p.pre_end) add('repre_missing', 'Resumed after the pause at ' + hh + ' without a new pre-watch', hh + ' 暫停施工後未重新預觀測即回復施工', p.id);
    else if (tms_(p.pre_start) < last) add('repre_early', 'New pre-watch after the pause at ' + hh + ' started before the cetaceans left', hh + ' 暫停施工的重新預觀測，開始時間早於鯨豚離開時間', p.id);
    else if (mins_(p.pre_start, p.pre_end) < preMin) add('repre_short', 'New pre-watch after the pause at ' + hh + ' only ' + mins_(p.pre_start, p.pre_end) + ' min (< ' + preMin + ')',
      hh + ' 暫停施工的重新預觀測僅 ' + mins_(p.pre_start, p.pre_end) + ' 分鐘（未滿 ' + preMin + ' 分）', p.id);
    else if (tms_(p.pre_end) > end) add('repre_order', 'Work resumed before the new pre-watch ended (pause at ' + hh + ')', hh + ' 暫停施工在重新預觀測結束前就回復施工', p.id);
  });
  ss.forEach(s => {
    if (!inZone(s)) return;
    const t = tms_(s.time), hh = s.time.slice(11, 16);
    // 實際觀測開始前的警戒區內目擊 → 鯨豚離開後須重新預觀測（預觀測開始要晚於離開時間）
    if (sv.work_start && t < tms_(sv.work_start)) {
      if (sv.pre_start && tms_(s.left_time || s.time) > tms_(sv.pre_start)) add('pre_redo', 'Pre-watch was not restarted after the sighting at ' + hh, hh + ' 目擊鯨豚後未重新開始預觀測');
      return;
    }
    if (!sv.work_start) return;
    const during = t >= tms_(sv.work_start) && (!sv.work_end || t <= tms_(sv.work_end));
    if (!during) return;
    const p = ps.find(x => x.sighting_id === s.id) || ps.find(x => tms_(x.start) >= t - 5 * 60000 && tms_(x.start) <= t + 30 * 60000);
    if (!p) add('no_pause', 'Sighting in the alert zone at ' + hh + ' during observation with no pause recorded', hh + ' 實際觀測中於警戒區內目擊，但無暫停施工紀錄');
    else if (mins_(s.time, p.start) > respMin) add('slow_response', 'Work paused ' + mins_(s.time, p.start) + ' min after the sighting at ' + hh + ' (> ' + respMin + ')',
      hh + ' 目擊後 ' + mins_(s.time, p.start) + ' 分鐘才暫停施工（應於 ' + respMin + ' 分鐘內啟動應變）');
  });

  const hasSighting = ss.length > 0, hasPause = ps.length > 0;
  const missing = [];
  const cnt = { doc: [0, 0], photo: [0, 0] }, slots = shiftSlots_(sv, svs || [sv]);
  items.filter(i => bool_(i.active) && bool_(i.required)).forEach(i => {
    if (i.cond === 'sighting' && !hasSighting) return;
    if (i.cond === 'pause' && !hasPause) return;
    const k = i.kind === 'photo' ? 'photo' : 'doc';
    if (k === 'photo') {   // 照片每 12 小時時段各一組
      slots.forEach(t => {
        cnt.photo[1]++;
        if (files.some(f => f.sv_id === sv.id && f.item_id === i.id && f.slot === t)) cnt.photo[0]++;
        else missing.push({ item_id: i.id, en: (i.name_en || i.name_zh) + ' ' + slotLabel_(t), zh: i.name_zh + ' ' + slotLabelZh_(t) });
      });
      return;
    }
    cnt[k][1]++;
    if (files.some(f => f.sv_id === sv.id && f.item_id === i.id)) cnt[k][0]++;
    else missing.push({ item_id: i.id, en: i.name_en || i.name_zh, zh: i.name_zh });
  });
  return { status: status, warnings: W, missing: missing, docs: cnt.doc, photos: cnt.photo };
}

// ============ Shifts ============
function shiftEditable_(u, shiftId) {
  const s = Repo.get('Shifts', shiftId);
  if (!s) fail_('Batch not found', 'NOT_FOUND');
  if (s.status === 'closed' && u.role !== 'admin') fail_('This batch is closed — ask an Admin to reopen it', 'FORBIDDEN');
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
    if (Repo.all('Shifts').find(x => x.shift_no === shiftNo && x.id !== p.id)) fail_('Batch number ' + shiftNo + ' already exists');
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
      if (used) fail_(x.vessel_name + ' already has records in this batch and cannot be removed');
      Repo.remove('ShiftVessels', x.id);
    });
    const crewDefault = p.crew && typeof p.crew === 'object' ? p.crew : {};
    if (!p.id) crewUnique_(vesselIds.map(vid => crewIds_(crewDefault[vid])));   // 編輯批次不重檢，避免舊資料卡住；改人員時在 sv.save 檢查
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
  const rec = withLock_(() => {
    const s = shiftEditable_(u, id);
    const patch = { status: status, updated_by: u.username, updated_at: nowIso_() };
    if (status === 'closed') { patch.closed_by = u.username; patch.closed_at = nowIso_(); }
    return Repo.update('Shifts', s.id, patch);
  });
  syncAutoTrack_(u, shiftVesselIds_(id));
  return rec;
}
// ============ 清空資料（驗證碼寄到固定信箱；帳號、規則設定、上傳項目、操作紀錄一律保留） ============
const RESET_EMAIL = 'paul.tong@nmdc-group.com';
const RESET_GROUPS = {
  shifts: ['Shifts', 'ShiftVessels', 'Pauses', 'Sightings', 'Files'],
  tracks: ['Tracks'],
  vessels: ['Vessels'],
  observers: ['Observers'],
  env: ['EnvDaily', 'EnvWaste', 'EnvIncidents']
};
function resetRequest_(u, p) {
  const groups = (Array.isArray(p.groups) ? p.groups : []).filter(k => RESET_GROUPS[k]);
  if (!groups.length) fail_('Tick at least one item to clear');
  if (groups.indexOf('vessels') >= 0 && groups.indexOf('tracks') < 0) groups.push('tracks');   // 軌跡依附船舶
  if (groups.indexOf('vessels') >= 0 && groups.indexOf('env') < 0) groups.push('env');         // 環保紀錄也依附船舶
  const code = String(parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 8), 16) % 900000 + 100000);
  const state = { hash: hash_(code, 'reset'), groups: groups, by: u.id, tries: 0, exp: Date.now() + 10 * 60000 };
  PropertiesService.getScriptProperties().setProperty('reset_pending', JSON.stringify(state));
  try {
    MailApp.sendEmail({ to: RESET_EMAIL, name: 'NMDC MMO', subject: '[MMO] Data reset verification code｜清空資料驗證碼：' + code,
      body: '有人申請清空 NMDC MMO 鯨豚觀察系統的資料，請把驗證碼輸入系統以確認。\n\n驗證碼 Code：' + code + '\n申請人 Requested by：' + (u.name || u.username) + ' (' + u.username + ')\n將刪除 Data to delete：' + groups.join(', ') +
        '\n有效時間 Valid for：10 分鐘 (10 minutes)\n\n若非本人申請，請忽略此信，資料不會被刪除。 If you did not request this, ignore this email.' });
  } catch (e) { PropertiesService.getScriptProperties().deleteProperty('reset_pending'); fail_('Could not send email: ' + e.message + ' — run setup() once in the Apps Script editor to authorise sending mail'); }
  return { to: RESET_EMAIL.replace(/^(.).*(@.*)$/, '$1***$2'), groups: groups };
}
function resetConfirm_(u, p) {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty('reset_pending');
  if (!raw) fail_('No reset request — send a new verification code');
  const st = JSON.parse(raw);
  if (st.by !== u.id) fail_('This code was requested by another administrator');
  if (Date.now() > st.exp) { props.deleteProperty('reset_pending'); fail_('Verification code expired — send a new one'); }
  if (hash_(str_(p.code), 'reset') !== st.hash) {
    st.tries++;
    if (st.tries >= 5) { props.deleteProperty('reset_pending'); fail_('Too many wrong codes — send a new one'); }
    props.setProperty('reset_pending', JSON.stringify(st));
    fail_('Wrong verification code (' + (5 - st.tries) + ' tries left)');
  }
  props.deleteProperty('reset_pending');
  return withLock_(() => {
    // 先備份整份試算表到同一資料夾：清掉的資料列無法從垃圾桶救回，備份失敗就不刪
    const stamp = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HHmm');
    const backup = DriveApp.getFileById(ss_().getId()).makeCopy(SS_NAME + ' 清空前備份 ' + stamp, DriveApp.getFolderById(ROOT_FOLDER_ID));
    const g = st.groups;
    let rows = 0, folders = 0;
    if (g.indexOf('env') >= 0) Repo.all('EnvWaste').forEach(w => { if (w.drive_id) { try { DriveApp.getFileById(w.drive_id).setTrashed(true); } catch (e) {} } });
    if (g.indexOf('shifts') >= 0) Repo.all('Shifts').forEach(s => { if (s.folder_id) { try { DriveApp.getFolderById(s.folder_id).setTrashed(true); folders++; } catch (e) { console.warn('trash folder: ' + e.message); } } });
    if (g.indexOf('tracks') >= 0) {
      if (g.indexOf('vessels') < 0) Repo.all('Vessels').filter(v => bool_(v.tracking) || v.track_id).forEach(v => Repo.update('Vessels', v.id, { tracking: 'FALSE', track_id: '' }));
      const sh = posSheet_(), last = sh.getLastRow();
      if (last > 1) { rows += last - 1; sh.getRange(2, 1, last - 1, sh.getLastColumn()).clearContent(); }
    }
    g.forEach(k => RESET_GROUPS[k].forEach(t => { rows += Repo.clear(t); }));
    console.log('RESET by ' + u.username + ': ' + g.join(',') + ' rows=' + rows + ' folders=' + folders + ' backup=' + backup.getId());
    return { rows: rows, folders: folders, groups: g, backup: backup.getName() };
  });
}
function deleteShift_(id) {
  return withLock_(() => {
    const s = Repo.get('Shifts', id);
    if (!s) fail_('Batch not found', 'NOT_FOUND');
    if (s.folder_id) { try { DriveApp.getFolderById(s.folder_id).setTrashed(true); } catch (e) {} }
    ['ShiftVessels', 'Pauses', 'Sightings', 'Files'].forEach(t => Repo.removeWhere(t, x => x.shift_id === id));
    Repo.remove('Shifts', id);
    return { id: id, name: s.date + ' #' + s.shift_no };
  });
}
const CREW_FIELDS = ['crew'];
const PAUSE_FIELDS = ['start','end','reason','sighting_id','monitoring','restart','remark','pre_start','pre_end'];
const SV_FIELDS = ['pre_start','pre_end','work_start','full_start','work_end','lat','lon','pos_time','pos_source','weather','sea_state','remark'];
const SV_TIME_FIELDS = { pre_start: 1, pre_end: 1, work_start: 1, full_start: 1, work_end: 1, pos_time: 1 };
// 一個批次＝預觀測開始到施工船宣布停工（實際觀測結束）：這段期間 MMO 船與施工船自動記錄軌跡，暫停施工不中斷
const AUTO_TRACK = '批次自動記錄';
function activeSv_(sv) { return !!sv.pre_start && !sv.work_end; }
/** 依目前進行中的批次，開始或停止指定船舶的軌跡；手動開始的軌跡不會被自動停止。失敗不影響原本的儲存 */
function syncAutoTrack_(u, ids) {
  const st = settings_();
  if (!st.ais_api_url || !st.ais_api_key) return;
  const open = {};
  Repo.all('Shifts').forEach(s => { if (s.status !== 'closed') open[s.id] = s; });
  const needed = {};
  Repo.all('ShiftVessels').forEach(x => {
    if (!open[x.shift_id] || !activeSv_(x)) return;
    needed[x.vessel_id] = 1;
    if (open[x.shift_id].construction_vessel_id) needed[open[x.shift_id].construction_vessel_id] = 1;
  });
  ids.filter((id, i) => id && ids.indexOf(id) === i).forEach(id => {
    try {
      const v = Repo.get('Vessels', id);
      if (!v) return;
      if (needed[id]) { if (!bool_(v.tracking) && bool_(v.active) && v.mmsi) startTrack_(u, { vessel_id: id, remark: AUTO_TRACK }); return; }
      const t = bool_(v.tracking) && v.track_id && Repo.get('Tracks', v.track_id);
      if (t && t.remark === AUTO_TRACK) stopTrack_(u, { vessel_id: id });
    } catch (e) { console.warn('auto track ' + id + ': ' + e.message); }
  });
}
function shiftVesselIds_(shiftId) {
  const s = Repo.get('Shifts', shiftId);
  return (s ? [s.construction_vessel_id] : []).concat(Repo.all('ShiftVessels').filter(x => x.shift_id === shiftId).map(x => x.vessel_id));
}
/** crew（JSON 或物件）裡所有觀察人員 id */
function crewIds_(crew) {
  const c = typeof crew === 'string' ? parseJson_(crew, {}) : (crew || {});
  return Object.keys(c).reduce((a, k) => a.concat(String((c[k] && c[k].id) || '').split(',').filter(Boolean)), []);
}
/** 同一批次中，一位觀察人員只能在一艘 MMO 船 */
function crewUnique_(lists) {
  const seen = {};
  lists.forEach(ids => ids.filter((x, i) => ids.indexOf(x) === i).forEach(id => {
    if (seen[id]) fail_('An observer can only be on one MMO vessel in a batch');
    seen[id] = true;
  }));
}
function saveShiftVessel_(u, p) {
  const before = Repo.get('ShiftVessels', p.id);
  const rec = saveShiftVesselRow_(u, p);
  if (before && activeSv_(before) !== activeSv_(rec)) syncAutoTrack_(u, shiftVesselIds_(rec.shift_id));
  return rec;
}
function saveShiftVesselRow_(u, p) {
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
    if (patch.crew !== undefined) crewUnique_([crewIds_(patch.crew)].concat(Repo.all('ShiftVessels').filter(x => x.shift_id === sv.shift_id && x.id !== sv.id).map(x => crewIds_(x.crew))));
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
      patch[k] = /^(start|end|time|left_time|pre_start|pre_end)$/.test(k) ? dt_(p[k]) : ((k === 'in_alert_zone' || k === 'monitoring') ? (bool_(p[k]) ? 'TRUE' : 'FALSE') : str_(p[k]));
    });
    required.forEach(k => { if (!p.id && !patch[k]) fail_('Missing field: ' + k); });
    if (p.id) return Repo.update(sheet, p.id, patch);
    const rec = Object.assign({ id: genId_(), shift_id: sv.shift_id, sv_id: sv.id, created_by: u.username, created_at: nowIso_() }, patch);
    Repo.insert(sheet, rec);
    return rec;
  });
}
/** p.sighting：同一請求先存目擊再連到這筆暫停，前端不用打兩次 */
function savePause_(u, p) {
  const q = Object.assign({}, p);
  delete q.sighting;
  if (!q.id && !q.start) fail_('Missing field: start');
  if (p.sighting) q.sighting_id = saveSighting_(u, Object.assign({}, p.sighting, { auto_pause: false })).id;
  return saveChild_(u, 'Pauses', q, PAUSE_FIELDS, ['start']);
}
function saveSighting_(u, p) {
  const st = settings_();
  if (p.min_distance_m !== undefined && str_(p.min_distance_m) !== '' && !isFinite(Number(p.min_distance_m))) fail_('Distance must be a number');
  if (p.in_alert_zone === undefined || p.in_alert_zone === '') p.in_alert_zone = str_(p.min_distance_m) !== '' && Number(p.min_distance_m) <= (Number(st.alert_zone_m) || 750);
  const rec = saveChild_(u, 'Sightings', p, ['time','species','count','detection','min_distance_m','in_alert_zone','action','left_time','lat','lon','behavior','remark',
    'bearing','direction','deck','vessel_dist_m','piling_status','mother_calf','image','call_type','freq_khz','hydrophone_m'], ['time']);
  // 選擇「暫停施工」且尚無對應暫停施工紀錄 → 自動建立一筆暫停施工（回復施工時間之後補）
  if (p.auto_pause && !p.id && rec.time) {
    saveChild_(u, 'Pauses', { sv_id: rec.sv_id, start: rec.time, reason: lines_(st.pause_reasons)[0] || 'Cetacean in alert zone', sighting_id: rec.id, monitoring: true, remark: '' },
      PAUSE_FIELDS, ['start']);
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
function shiftFolderName_(s) { return safeName_(s.date + '_批次' + s.shift_no + (s.construction_vessel ? '_' + s.construction_vessel : '')); }
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
  if (p.track) return saveTrackImage_(u, shift, sv, bytes, file);
  const item = Repo.get('UploadItems', p.item_id);
  if (!item) fail_('Upload item not found', 'NOT_FOUND');
  const slot = item.kind === 'photo' ? str_(p.slot) : '';
  if (item.kind === 'photo' && !/^\d{4}-\d{2}-\d{2}_(00|12)$/.test(slot)) fail_('Select a 12-hour period for this photo');
  const folder = withLock_(() => {
    const base = svFolder_(shift, sv);
    return slot ? childFolder_(childFolder_(base, '照片'), slotFolder_(slot)) : childFolder_(base, '紙本紀錄');
  });
  const orig = safeName_(file.name || 'file');
  // Drive 檔名不帶原檔名（原檔名只存在 Files.name 給系統顯示）；同一項第二份起加序號
  const ext = (orig.match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0];
  const seq = Repo.all('Files').filter(x => x.sv_id === sv.id && x.item_id === item.id && str_(x.slot) === slot).length;
  const name = safeName_(shift.date + (slot ? '' : '_批次' + shift.shift_no) + '_' + sv.vessel_name + '_' + item.name_zh) + (seq ? '_' + (seq + 1) : '') + ext;
  const f = folder.createFile(Utilities.newBlob(bytes, str_(file.mime) || 'application/octet-stream', name));
  const thumb = str_(p.thumb);
  const rec = { id: genId_(), shift_id: shift.id, sv_id: sv.id, item_id: item.id, item_name: item.name_zh, kind: item.kind, drive_id: f.getId(),
    name: orig, mime: str_(file.mime), size: String(bytes.length), thumb: thumb.length <= MAX_THUMB_CHARS ? thumb : '',
    uploaded_by: u.username, uploaded_at: nowIso_(), slot: slot };
  withLock_(() => Repo.insert('Files', rec));
  const out = Object.assign({}, rec); delete out.thumb;
  return out;
}
/** 軌跡圖存在批次層的「軌跡」資料夾；同一艘 MMO 船重新產生時蓋掉舊圖 */
function saveTrackImage_(u, shift, sv, bytes, file) {
  const name = safeName_(file.name || sv.vessel_name + '_軌跡.png');
  return withLock_(() => {
    Repo.all('Files').filter(f => f.sv_id === sv.id && f.kind === 'track').forEach(f => {
      try { DriveApp.getFileById(f.drive_id).setTrashed(true); } catch (e) {}
      Repo.remove('Files', f.id);
    });
    const f = childFolder_(shiftFolder_(shift), '軌跡').createFile(Utilities.newBlob(bytes, 'image/png', name));
    const rec = { id: genId_(), shift_id: shift.id, sv_id: sv.id, item_id: '', item_name: '軌跡圖', kind: 'track', drive_id: f.getId(),
      name: name, mime: 'image/png', size: String(bytes.length), thumb: '', uploaded_by: u.username, uploaded_at: nowIso_(), slot: '' };
    Repo.insert('Files', rec);
    return rec;
  });
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

// ============ 船位（Datalastic；網址沒有 {key} 時金鑰改走 x-api-key 標頭，官方建議做法） ============
function aisFetch_(url, st) {
  const opt = { muteHttpExceptions: true };
  if (url.indexOf('{key}') >= 0) url = url.replace('{key}', encodeURIComponent(st.ais_api_key || ''));
  else if (st.ais_api_key) opt.headers = { 'x-api-key': st.ais_api_key };
  const res = UrlFetchApp.fetch(url, opt);
  const code = res.getResponseCode();
  if (code === 401 || code === 403) fail_('Position API rejected the key (HTTP ' + code + ') — check the API key in Back office');
  if (code === 404) fail_('Vessel not found by the position API (HTTP 404) — check the MMSI');
  if (code !== 200) fail_('Position API returned HTTP ' + code);
  return res;
}
function testPositionApi_() {
  const st = settings_();
  if (!st.ais_api_key) fail_('Enter the API key first');
  const base = (String(st.ais_api_url).match(/^https?:\/\/[^/]+\/api\/v0\//) || ['https://api.datalastic.com/api/v0/'])[0];
  const j = JSON.parse(aisFetch_(base + 'stat', st).getContentText());
  return j.data || j;
}
// ============ 船位排程（positionTick 每 5 分鐘）與軌跡 ============
const POS_SHEET = 'Positions';
const POS_HEAD = ['time','vessel_id','vessel_name','mmsi','lat','lon','speed','course','track_id','source','fetched_at'];
function posSheet_() {
  const sh = Repo.sheet(POS_SHEET);
  if (sh.getLastRow() === 0) { sh.getRange(1, 1, 1, POS_HEAD.length).setValues([POS_HEAD]).setFontWeight('bold'); sh.setFrozenRows(1); }
  return sh;
}
/** 每段軌跡實際記到幾筆（只讀 Positions 的 track_id 一欄） */
function tracksWithPoints_() {
  const sh = posSheet_(), last = sh.getLastRow(), n = {};
  if (last > 1) sh.getRange(2, POS_HEAD.indexOf('track_id') + 1, last - 1, 1).getValues().forEach(r => { if (r[0]) n[r[0]] = (n[r[0]] || 0) + 1; });
  return Repo.all('Tracks').map(t => Object.assign({}, t, { points: n[t.id] || 0 }));
}
function posRows_(sh, first, n) {
  if (n <= 0) return [];
  return sh.getRange(first, 1, n, POS_HEAD.length).getValues().map(r => {
    const o = {};
    POS_HEAD.forEach((h, i) => { o[h] = r[i] instanceof Date ? Utilities.formatDate(r[i], TZ, "yyyy-MM-dd'T'HH:mm:ss") : String(r[i]); });
    return o;
  });
}
/** 近 N 小時的船位（只讀表尾，表再大也很快） */
function recentPositions_(hours) {
  const sh = posSheet_(), last = sh.getLastRow();
  if (last < 2) return [];
  const n = Math.min(last - 1, 3000);
  const since = Utilities.formatDate(new Date(Date.now() - hours * 3600e3), TZ, "yyyy-MM-dd'T'HH:mm:ss");
  return posRows_(sh, last - n + 1, n).filter(p => p.time >= since);
}
function listPositions_(p) {
  const from = dt_(p.from), to = dt_(p.to);
  if (!from || !to) fail_('Select a start and end time');
  const ids = Array.isArray(p.vessel_ids) ? p.vessel_ids.map(String) : [];
  const sh = posSheet_(), last = sh.getLastRow();
  const rows = last < 2 ? [] : posRows_(sh, 2, last - 1);
  const out = rows.filter(x => x.time >= from && x.time <= to + ':59' && (!ids.length || ids.indexOf(x.vessel_id) >= 0));
  out.sort((a, b) => a.time.localeCompare(b.time));
  return { positions: out };
}
/** 抓一艘船並寫入：更新 Vessels.last_*；AIS 定位時間跟上一筆不同才新增到 Positions（避免重複點） */
function recordPosition_(v, st) {
  const now = nowIso_();
  let f;
  try { f = fetchPosition_({ mmsi: v.mmsi }); }
  catch (e) { Repo.update('Vessels', v.id, { last_fetch: now, last_error: String(e.message).slice(0, 200) }); return { id: v.id, error: e.message }; }
  const fix = f.time ? f.time + (f.time.length === 16 ? ':00' : '') : now;
  const isNew = fix !== v.last_fix;
  Repo.update('Vessels', v.id, { last_lat: String(f.lat), last_lon: String(f.lon), last_fix: fix, last_speed: String(f.speed), last_course: String(f.course),
    last_fetch: now, last_error: '' });
  if (isNew) {
    posSheet_().appendRow([fix, v.id, v.name, v.mmsi, f.lat, f.lon, f.speed, f.course, bool_(v.tracking) ? v.track_id : '', 'AIS', now]);
  }
  return { id: v.id, lat: f.lat, lon: f.lon, time: fix, isNew: isNew };
}
/** ids＝null 代表全部到期的船；force＝不管間隔，立即抓 */
function refreshPositions_(ids, force) {
  const st = settings_();
  if (!st.ais_api_url || !st.ais_api_key) { if (force) fail_('Vessel position API is not configured yet', 'NOT_CONFIGURED'); return { done: [] }; }
  const posInt = Number(st.pos_interval_min), trkInt = Number(st.track_interval_min) || 10;
  const nowMs = Date.now();
  const due = v => {
    if (force) return true;
    const iv = bool_(v.tracking) ? trkInt : posInt;
    if (!iv || iv <= 0) return false;
    const last = v.last_fetch ? tms_(v.last_fetch) : 0;
    return !last || nowMs - last >= (iv - 2) * 60000;
  };
  return withLock_(() => {
    const list = Repo.all('Vessels').filter(v => bool_(v.active) && v.mmsi && (!ids || ids.indexOf(v.id) >= 0) && due(v));
    const done = list.map(v => recordPosition_(v, st));
    return { done: done };
  });
}
/** 時間觸發（setup 建立）：每 5 分鐘檢查哪些船到期要更新 */
function positionTick() {
  try {
    ensureSchema_();
    const r = refreshPositions_(null, false);
    PropertiesService.getScriptProperties().setProperty('pos_tick', nowIso_());
    if (r.done.length) bumpRev_();
  } catch (e) { console.warn('positionTick: ' + e.message); }
  flushSummary_();
}
function flushSummary_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('summary_dirty') !== '1') return;
  props.deleteProperty('summary_dirty');
  try { rebuildSummary_(); }
  catch (e) { props.setProperty('summary_dirty', '1'); console.warn('summary: ' + e.message); }
}
function startTrack_(u, p) {
  const v = Repo.get('Vessels', p.vessel_id);
  if (!v) fail_('Vessel not found', 'NOT_FOUND');
  if (!v.mmsi) fail_('This vessel has no MMSI');
  const st = settings_();
  if (!st.ais_api_url || !st.ais_api_key) fail_('Vessel position API is not configured yet', 'NOT_CONFIGURED');
  const t = withLock_(() => {
    if (bool_(v.tracking)) fail_('This vessel is already recording a track');
    const rec = { id: genId_(), vessel_id: v.id, vessel_name: v.name, mmsi: v.mmsi, start: nowIso_(), end: '', interval_min: String(Number(st.track_interval_min) || 10),
      started_by: u.username, stopped_by: '', remark: str_(p.remark) };
    Repo.insert('Tracks', rec);
    Repo.update('Vessels', v.id, { tracking: 'TRUE', track_id: rec.id });
    return rec;
  });
  try { refreshPositions_([v.id], true); } catch (e) {}
  return t;
}
function stopTrack_(u, p) {
  return withLock_(() => {
    const v = Repo.get('Vessels', p.vessel_id);
    if (!v || !bool_(v.tracking)) fail_('This vessel is not recording a track');
    const t = v.track_id && Repo.get('Tracks', v.track_id);
    if (t) Repo.update('Tracks', t.id, { end: nowIso_(), stopped_by: u.username });
    Repo.update('Vessels', v.id, { tracking: 'FALSE', track_id: '' });
    return { id: t ? t.id : '', name: v.name };
  });
}
function fetchPosition_(p) {
  const st = settings_();
  if (!st.ais_api_url) fail_('Vessel position API is not configured yet', 'NOT_CONFIGURED');
  const mmsi = str_(p.mmsi);
  if (!mmsi) fail_('This vessel has no MMSI');
  const res = aisFetch_(st.ais_api_url.replace('{mmsi}', encodeURIComponent(mmsi)), st);
  const j = JSON.parse(res.getContentText());
  // 通用解析：找第一個有 lat/lon（或 latitude/longitude）的物件；接上實際 API 時再依格式調整
  const found = (function walk(o) {
    if (!o || typeof o !== 'object') return null;
    const lat = o.lat !== undefined ? o.lat : (o.latitude !== undefined ? o.latitude : o.LAT);
    const lon = o.lon !== undefined ? o.lon : (o.lng !== undefined ? o.lng : (o.longitude !== undefined ? o.longitude : o.LON));
    if (lat !== undefined && lon !== undefined && lat !== null && lon !== null && isFinite(Number(lat)) && isFinite(Number(lon))) {
      // Datalastic：last_position_epoch（秒）／last_position_UTC；其他供應商：timestamp／time
      const ep = Number(o.last_position_epoch);
      const raw = o.last_position_UTC || o.timestamp || o.time || o.TIMESTAMP || '';
      const d = ep > 0 ? new Date(ep * 1000) : (raw ? new Date(raw) : null);
      return { lat: Number(lat), lon: Number(lon), speed: o.speed !== undefined ? o.speed : '', course: o.course !== undefined ? o.course : '',
        time: d && !isNaN(d.getTime()) ? Utilities.formatDate(d, TZ, "yyyy-MM-dd'T'HH:mm") : '' };
    }
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
    fields.forEach(k => { if (p[k] !== undefined) patch[k] = (k === 'active' || k === 'required' || k === 'env_report') ? (bool_(p[k]) ? 'TRUE' : 'FALSE') : str_(p[k]); });
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
      fail_('This vessel is used in batches — set it inactive instead');
    if (sheet === 'Vessels' && ['EnvDaily', 'EnvWaste', 'EnvIncidents'].some(t => Repo.all(t).some(x => x.vessel_id === id)))
      fail_('This vessel has environmental records — set it inactive instead');
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

// ============ 離岸環保統計（管理員輸入） ============
/** 數量欄：空白可；其他必須是 ≥ 0 的數字 */
function envNum_(v, label) {
  const t = str_(v).replace(/,/g, '');
  if (t === '') return '';
  const n = Number(t);
  if (!isFinite(n) || n < 0) fail_('Invalid number: ' + label);
  return String(n);
}
function envVessel_(id) {
  const v = Repo.get('Vessels', id);
  if (!v) fail_('Vessel not found', 'NOT_FOUND');
  return v;
}
function envDate_(d) { d = str_(d); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) fail_('Date is required'); return d; }
const ENV_DAILY_NUM = ['pob','fuel_used_m3','water_used_m3'];
/** 每日填報：一次存多艘船；同船同日已有就更新，整列清空就刪除 */
function envDailySave_(u, p) {
  const rows = Array.isArray(p.rows) ? p.rows : [p];
  return withLock_(() => {
    const all = Repo.all('EnvDaily');
    let saved = 0, removed = 0;
    rows.forEach(r => {
      const v = envVessel_(r.vessel_id), date = envDate_(r.date);
      const rec = { vessel_id: v.id, vessel_name: v.name, date: date, remark: str_(r.remark), updated_by: u.username, updated_at: nowIso_() };
      ENV_DAILY_NUM.forEach(k => { rec[k] = envNum_(r[k], k); });
      const old = all.find(x => x.vessel_id === v.id && x.date === date);
      if (ENV_DAILY_NUM.every(k => rec[k] === '') && !rec.remark) { if (old) { Repo.remove('EnvDaily', old.id); removed++; } return; }
      if (old) Repo.update('EnvDaily', old.id, rec); else Repo.insert('EnvDaily', Object.assign({ id: genId_() }, rec));
      saved++;
    });
    return { saved: saved, removed: removed };
  });
}
/** 廢棄物：每次交運一筆，items＝{類別: kg}；聯單存 Drive「環保/<船名>/廢棄物聯單」 */
function envWasteSave_(u, p) {
  const v = envVessel_(p.vessel_id), date = envDate_(p.date);
  const items = {};
  let total = 0;
  Object.keys(p.items || {}).forEach(k => {
    const n = envNum_(p.items[k], k);
    if (n !== '' && Number(n) > 0) { items[str_(k)] = Number(n); total += Number(n); }
  });
  if (!total) fail_('Enter the weight of at least one waste category');
  const rec = { vessel_id: v.id, vessel_name: v.name, date: date, method: str_(p.method), receiver: str_(p.receiver), port: str_(p.port),
    receipt_no: str_(p.receipt_no), items: JSON.stringify(items), total_kg: String(Math.round(total * 1000) / 1000), remark: str_(p.remark),
    updated_by: u.username, updated_at: nowIso_() };
  const file = p.file && p.file.data ? p.file : null;
  const bytes = file ? Utilities.base64Decode(String(file.data)) : null;
  if (bytes && bytes.length > MAX_FILE_BYTES) fail_('File is larger than 20 MB');
  return withLock_(() => {
    const old = p.id ? Repo.get('EnvWaste', p.id) : null;
    if (p.id && !old) fail_('Record not found', 'NOT_FOUND');
    if (file) {
      const folder = childFolder_(childFolder_(childFolder_(DriveApp.getFolderById(ROOT_FOLDER_ID), '環保'), safeName_(v.name)), '廢棄物聯單');
      const orig = safeName_(file.name || 'file'), ext = (orig.match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0];
      const f = folder.createFile(Utilities.newBlob(bytes, str_(file.mime) || 'application/octet-stream',
        safeName_(date + '_' + v.name + '_廢棄物聯單' + (rec.receipt_no ? '_' + rec.receipt_no : '')) + ext));
      if (old && old.drive_id) { try { DriveApp.getFileById(old.drive_id).setTrashed(true); } catch (e) {} }
      rec.drive_id = f.getId(); rec.file_name = orig; rec.file_mime = str_(file.mime);
    }
    if (old) return Repo.update('EnvWaste', old.id, rec);
    const out = Object.assign({ id: genId_(), created_by: u.username, created_at: nowIso_() }, rec);
    Repo.insert('EnvWaste', out);
    return out;
  });
}
function envWasteDelete_(id) {
  return withLock_(() => {
    const r = Repo.get('EnvWaste', id);
    if (!r) fail_('Record not found', 'NOT_FOUND');
    if (r.drive_id) { try { DriveApp.getFileById(r.drive_id).setTrashed(true); } catch (e) {} }
    Repo.remove('EnvWaste', id);
    return { id: id };
  });
}
function envFile_(id) {
  const r = Repo.get('EnvWaste', id);
  if (!r || !r.drive_id) fail_('File not found', 'NOT_FOUND');
  const blob = DriveApp.getFileById(r.drive_id).getBlob();
  if (blob.getBytes().length > 25 * 1024 * 1024) fail_('File too large to preview — open it in Drive');
  return { name: r.file_name, mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}
const ENV_INC_FIELDS = ['type','severity','substance','quantity','lat','lon','description','action','reported_to','status'];
function envIncidentSave_(u, p) {
  const v = envVessel_(p.vessel_id), time = str_(p.time);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(time)) fail_('Time is required');
  const rec = { vessel_id: v.id, vessel_name: v.name, time: time, updated_by: u.username, updated_at: nowIso_() };
  ENV_INC_FIELDS.forEach(k => { rec[k] = str_(p[k]); });
  if (!rec.type) fail_('Incident type is required');
  if (['near_miss', 'minor', 'major'].indexOf(rec.severity) < 0) rec.severity = 'minor';
  if (rec.status !== 'closed') rec.status = 'open';
  return withLock_(() => {
    const old = p.id ? Repo.get('EnvIncidents', p.id) : null;
    if (p.id && !old) fail_('Record not found', 'NOT_FOUND');
    rec.closed_at = rec.status === 'closed' ? ((old && old.closed_at) || nowIso_()) : '';
    if (old) return Repo.update('EnvIncidents', old.id, rec);
    const out = Object.assign({ id: genId_(), created_by: u.username, created_at: nowIso_() }, rec);
    Repo.insert('EnvIncidents', out);
    return out;
  });
}

// ============ 總表（每次批次資料異動後重建） ============
function rebuildSummary_() {
  Repo.flush();
  const st = settings_();
  const slots = lines_(st.crew_slots);
  const shifts = Repo.all('Shifts').sort((a, b) => (b.date + b.shift_no).localeCompare(a.date + a.shift_no, undefined, { numeric: true }));
  const svs = Repo.all('ShiftVessels'), pauses = Repo.all('Pauses'), sightings = Repo.all('Sightings'), files = Repo.all('Files'), items = Repo.all('UploadItems');
  const STATUS = { idle: '未開始', pre: '預觀測中', preDone: '預觀測完成', work: '實際觀測中', paused: '暫停施工中', done: '已完成' };
  const head = ['日期', '批次', '工區', '工作範疇', '施工船', 'MMO 船'].concat(slots).concat(['預觀測開始', '預觀測結束', '預觀測(分)',
    '實際觀測開始', '實際觀測結束', '實際觀測時長(分)', '暫停施工次數', '暫停施工總計(分)', '目擊次數', '物種', '警戒區內目擊', '緯度', '經度', '風速(kn)', '浪高(m)',
    '文件', '照片', '缺件', '規則提醒', '狀態', '批次結案', 'Drive 資料夾']);
  const rows = [];
  shifts.forEach(s => {
    svs.filter(x => x.shift_id === s.id).sort((a, b) => Number(a.sort) - Number(b.sort)).forEach(sv => {
      const ck = checks_(sv, pauses, sightings, files, items, st, posFor_(sv, s, st), svs);
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

  const sHead = ['日期', '批次', '工區', '施工船', 'MMO 船', '目擊時間', '物種', '數量', '母子對', '偵測方式', '觀察方位(°)', '游行方向', '觀察位置', '與船距離(m)', '與施工點距離(m)', '進入警戒區',
    '施工狀態', '處置', '最後目擊/離開警戒區', '聲音類型', '頻率(kHz)', '與水下麥克風距離(m)', '影像', '緯度', '經度', '行為', '備註', '登錄者'];
  const sRows = [];
  sightings.slice().sort((a, b) => b.time.localeCompare(a.time)).forEach(x => {
    const s = shifts.find(z => z.id === x.shift_id) || {};
    const sv = svs.find(z => z.id === x.sv_id) || {};
    sRows.push([s.date || '', s.shift_no || '', s.site || '', s.construction_vessel || '', sv.vessel_name || '', t_(x.time), x.species, x.count,
      x.mother_calf, x.detection, x.bearing, x.direction, x.deck, x.vessel_dist_m, x.min_distance_m, bool_(x.in_alert_zone) ? '是' : '否', x.piling_status,
      x.action, t_(x.left_time), x.call_type, x.freq_khz, x.hydrophone_m, x.image, x.lat, x.lon, x.behavior, x.remark, x.created_by]);
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
