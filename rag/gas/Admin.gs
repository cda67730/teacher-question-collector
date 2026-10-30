/** 後台：從試算表選單開啟，只有「管理員」工作表裡的 email 可以使用 */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('AI 助手後台')
    .addItem('開啟後台', 'openAdmin')
    .addSeparator()
    .addItem('初始化工作表（setup）', 'setup')
    .addToUi();
}

function openAdmin() {
  const html = HtmlService.createHtmlOutputFromFile('Admin').setWidth(1180).setHeight(780);
  SpreadsheetApp.getUi().showModalDialog(html, 'AI 助手後台');
}

function requireAdmin_() {
  const email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  const ok = email && rows_('admins').some(r => String(r['Email']).trim().toLowerCase() === email);
  if (!ok) throw new Error('你的帳號（' + (email || '無法取得 email') + '）不在「管理員」名單中');
  return email;
}

// ---------- 讀取 ----------
function adminLoad() {
  const me = requireAdmin_();
  const settings = rows_('settings').map(r => ({ key: r['設定'], value: r['值'], note: r['說明'] }));
  const skills = rows_('skills').map(r => ({ id: r['Skill ID'], name: r['名稱'], tags: r['對應主題'], always: truthy_(r['一律載入']), content: r['內容'], enabled: truthy_(r['啟用']), version: r['版本'], by: r['更新者'], at: fmt_(r['更新時間']) }));
  const docs = rows_('docs').map(r => ({ id: r['文件ID'], title: r['標題'], source: r['出處'], evidence: r['證據等級'], file: r['原始檔名'], chunks: r['段落數'], status: r['狀態'], by: r['上傳者'], at: fmt_(r['上傳時間']), reviewer: r['審核者'] })).reverse();
  const topics = Array.from(new Set([].concat.apply([], skills.map(s => String(s.tags || '').split(/[,，、]/).map(x => x.trim()).filter(Boolean)))));
  return { me: me, settings: settings, skills: skills, docs: docs, topics: topics, sheetUrl: ss_().getUrl() };
}
function fmt_(d) { return d instanceof Date ? Utilities.formatDate(d, 'Asia/Taipei', 'yyyy-MM-dd HH:mm') : String(d || ''); }

// ---------- 機器人設定 ----------
function adminSaveSettings(list) {
  requireAdmin_();
  const s = sh_('settings'); const v = s.getDataRange().getValues();
  list.forEach(item => {
    const i = v.findIndex((r, idx) => idx > 0 && r[0] === item.key);
    if (i > 0) s.getRange(i + 1, 2).setValue(item.value);
  });
  clearCfgCache_();
  return true;
}

// ---------- Skill ----------
function adminSaveSkill(sk) {
  const me = requireAdmin_();
  if (!String(sk.name || '').trim()) throw new Error('請填寫 Skill 名稱');
  const s = sh_('skills'); const all = rows_('skills');
  const now = new Date();
  let row = all.find(r => String(r['Skill ID']) === String(sk.id));
  let version = 1, id = sk.id;
  if (row) {
    version = Number(row['版本'] || 1) + 1;
    s.getRange(row._row, 1, 1, 9).setValues([[id, sk.name, sk.tags || '', !!sk.always, sk.content || '', !!sk.enabled, version, me, now]]);
  } else {
    id = 'S' + String(all.length + 1).padStart(2, '0') + '-' + Utilities.getUuid().slice(0, 4);
    append_('skills', [[id, sk.name, sk.tags || '', !!sk.always, sk.content || '', sk.enabled !== false, 1, me, now]]);
  }
  append_('skillHist', [[id, version, sk.name, sk.tags || '', !!sk.always, sk.content || '', me, now]]);
  return { id: id, version: version };
}
function adminSkillHistory(id) {
  requireAdmin_();
  return rows_('skillHist').filter(r => String(r['Skill ID']) === String(id)).map(r => ({ version: r['版本'], name: r['名稱'], tags: r['對應主題'], always: truthy_(r['一律載入']), content: r['內容'], by: r['更新者'], at: fmt_(r['更新時間']) })).reverse();
}

// ---------- 知識庫文件 ----------
function adminUploadDoc(p) {
  const me = requireAdmin_();
  const text = p.text ? String(p.text) : extractText_(p.fileName, p.mimeType, p.base64);
  return addDocument_({ title: p.title, source: p.source, evidence: p.evidence, fileName: p.fileName || '（貼上文字）' }, text, me);
}
function adminDocChunks(docId) {
  requireAdmin_();
  return rows_('chunks').filter(r => String(r['文件ID']) === String(docId)).map(r => ({ id: r['段落ID'], n: r['序號'], page: r['頁碼'], text: r['內容'], status: r['狀態'] }));
}
function adminSetDocStatus(docId, status) {
  const me = requireAdmin_();
  if (['已核可', '待審核', '停用'].indexOf(status) < 0) throw new Error('狀態不正確');
  setDocStatus_(docId, status, me);
  return true;
}

// ---------- 測試對話（不需邀請碼，回傳完整流程紀錄） ----------
function adminTestChat(req) {
  requireAdmin_();
  req.session = 'admin-test'; req.school = '後台測試';
  return runChat_(req, { trace: true });
}
