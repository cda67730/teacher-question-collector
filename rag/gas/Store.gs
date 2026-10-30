/** 試算表存取：設定、Skill、文件、段落、對照表 */

const SHEETS = {
  settings: '設定', skills: 'Skill', skillHist: 'Skill版本', docs: '文件', chunks: '知識段落',
  synonyms: '同義詞', forbidden: '禁止用語', referral: '轉介資源', codes: '邀請碼',
  admins: '管理員', logs: '對話紀錄', feedback: '回饋',
};

function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}
function sh_(key) {
  const name = SHEETS[key] || key;
  const s = ss_().getSheetByName(name);
  if (!s) throw new Error('找不到工作表「' + name + '」，請先執行 setup()');
  return s;
}
/** 讀成物件陣列（第一列為標題） */
function rows_(key) {
  const v = sh_(key).getDataRange().getValues();
  const head = v.shift() || [];
  return v.filter(r => r.some(c => c !== '')).map((r, i) => { const o = { _row: i + 2 }; head.forEach((h, j) => o[h] = r[j]); return o; });
}
function append_(key, arr) { const s = sh_(key); s.getRange(s.getLastRow() + 1, 1, arr.length, arr[0].length).setValues(arr); }
function truthy_(v) { return v === true || String(v).toUpperCase() === 'TRUE' || v === '是'; }

// ---------- 設定（快取 60 秒） ----------
let CFG_ = null;
function cfgAll_() {
  if (CFG_) return CFG_;
  const cache = CacheService.getScriptCache();
  const c = cache.get('cfg');
  if (c) return (CFG_ = JSON.parse(c));
  const o = {};
  rows_('settings').forEach(r => o[r['設定']] = r['值']);
  try { cache.put('cfg', JSON.stringify(o), 60); } catch (e) {}
  return (CFG_ = o);
}
function cfg_(k) { return cfgAll_()[k]; }
function clearCfgCache_() { CFG_ = null; CacheService.getScriptCache().remove('cfg'); CacheService.getScriptCache().remove('index'); }

// ---------- Skill ----------
function skills_() {
  return rows_('skills').filter(r => truthy_(r['啟用'])).map(r => ({
    id: String(r['Skill ID']), name: String(r['名稱']), tags: String(r['對應主題'] || '').split(/[,，、]/).map(s => s.trim()).filter(Boolean),
    always: truthy_(r['一律載入']), content: String(r['內容'] || ''), version: r['版本'],
  }));
}

// ---------- 對照表 ----------
function synonyms_() { return rows_('synonyms').map(r => ({ word: String(r['老師用語']).trim(), concept: String(r['對應概念']).trim() })).filter(x => x.word); }
function forbidden_() { return rows_('forbidden').map(r => ({ rule: String(r['詞或規則']).trim(), regex: String(r['類型']) === '正規式', note: String(r['說明'] || '') })).filter(x => x.rule); }
function referral_() {
  const o = {};
  rows_('referral').forEach(r => o[String(r['類別'])] = { who: String(r['該找誰'] || ''), contact: String(r['聯絡方式'] || ''), now: String(r['現在要做的事'] || '') });
  return o;
}

// ---------- 邀請碼與頻率 ----------
function checkCode_(code) {
  if (!code) return null;
  const c = String(code).trim().toUpperCase();
  const hit = rows_('codes').find(r => String(r['邀請碼']).trim().toUpperCase() === c && String(r['啟用']).toUpperCase() !== 'FALSE');
  return hit ? String(hit['園所代號'] || hit['邀請碼']) : null;
}
function rateOk_(code) {
  const cache = CacheService.getScriptCache();
  const key = 'rate_' + code + '_' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMddHH');
  const n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), 3600);
  return n <= Number(cfg_('hourly_limit') || 300);
}
