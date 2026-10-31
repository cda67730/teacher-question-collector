/** 後台：從試算表選單開啟，只有「管理員」工作表裡的 email 可以使用 */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('AI 助手後台')
    .addItem('開啟後台', 'openAdmin')
    .addSeparator()
    .addItem('初始化工作表（setup）', 'setup')
    .addToUi();
}

function openAdmin() {
  const html = HtmlService.createTemplateFromFile('AdminUI').evaluate().setWidth(1280).setHeight(820);
  SpreadsheetApp.getUi().showModalDialog(html, 'AI 助手後台');
}

function include(name) { return HtmlService.createHtmlOutputFromFile(name).getContent(); }

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
  req.session = req.session || 'admin-test'; req.school = '後台測試';
  return runChat_(req, { trace: true });
}

// ---------- 對話紀錄觀測 ----------
const LOG_TYPE_NAME = { answer: '回答', followup: '追問', referral: '緊急轉介', conservative: '保守回答', out_of_scope: '超出範圍' };
function jsonOr_(s, d) { try { return JSON.parse(s); } catch (e) { return d; } }
function feedbackMap_() {
  const fb = {};
  rows_('feedback').forEach(r => {
    const k = r['Session'] + '|' + r['輪次'];
    (fb[k] = fb[k] || []).push(String(r['類型']));
  });
  return fb;
}

/**
 * 讀對話紀錄並計算指標。opts：days（0 = 全部）、school、type、q（關鍵字）、includeTest
 * 命中率的定義：
 *  - 檢索命中率：走到檢索的回合中，至少有 1 段超過門檻的比例
 *  - 引用率：檢索到的段落中，被回答實際引用的比例（越高代表檢索越準）
 *  - 平均最高相似度：每回合第一名段落的分數平均
 */
function adminLogs(opts) {
  requireAdmin_();
  opts = opts || {};
  const since = opts.days ? Date.now() - opts.days * 86400000 : 0;
  const fb = feedbackMap_();
  const all = rows_('logs').filter(r => {
    const t = r['時間'] instanceof Date ? r['時間'].getTime() : 0;
    if (since && t < since) return false;
    if (!opts.includeTest && String(r['Session']).indexOf('admin-test') === 0) return false;
    if (opts.school && String(r['園所']) !== opts.school) return false;
    if (opts.type && String(r['回應類型']) !== opts.type) return false;
    if (opts.q && String(r['老師訊息（去識別化）']).indexOf(opts.q) < 0) return false;
    return true;
  });
  const num = v => v === '' || v == null ? null : Number(v);
  const rows = all.map(r => {
    const f = fb[r['Session'] + '|' + r['輪次']] || [];
    return {
      row: r._row, time: fmt_(r['時間']), session: String(r['Session']), school: String(r['園所']), turn: r['輪次'],
      msg: String(r['老師訊息（去識別化）']).slice(0, 120), type: String(r['回應類型']), referral: String(r['轉介'] || ''),
      retrieved: num(r['檢索段數']), top: num(r['最高相似度']), cited: num(r['被引用段數']), skills: String(r['載入Skill'] || ''),
      rewritten: r['是否重寫'] === '是', ms: num(r['耗時ms']),
      fb: f.indexOf('有幫助') >= 0 ? 'up' : f.indexOf('沒幫助') >= 0 ? 'down' : '', copied: f.indexOf('複製家長訊息') >= 0,
    };
  });
  const ret = rows.filter(r => r.retrieved != null);
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : null;
  const byType = {}; rows.forEach(r => byType[r.type] = (byType[r.type] || 0) + 1);
  const ups = rows.filter(r => r.fb === 'up').length, downs = rows.filter(r => r.fb === 'down').length;
  const answered = rows.filter(r => r.type === 'answer');
  const stats = {
    turns: rows.length,
    sessions: new Set(rows.map(r => r.session)).size,
    byType: byType,
    retrievalTurns: ret.length,
    hitRate: pct(ret.filter(r => r.retrieved > 0).length, ret.length),
    citeRate: pct(sum(answered, r => r.cited || 0), sum(answered, r => r.retrieved || 0)),
    avgTop: ret.length ? Math.round(sum(ret, r => r.top || 0) / ret.length * 1000) / 1000 : null,
    rewriteRate: pct(answered.filter(r => r.rewritten).length, answered.length),
    upRate: pct(ups, ups + downs), ups: ups, downs: downs,
    copied: rows.filter(r => r.copied).length,
    avgMs: rows.length ? Math.round(sum(rows, r => r.ms || 0) / rows.length) : null,
  };
  // 知識缺口：走到檢索卻沒有命中，或最後只能保守回答的問題 → 交給專家補資料
  const gaps = rows.filter(r => r.retrieved === 0 || r.type === 'conservative').slice(-30).reverse()
    .map(r => ({ row: r.row, time: r.time, msg: r.msg, top: r.top }));
  // 常被引用的文件
  const docCount = {};
  all.forEach(r => String(r['引用'] || '').split('｜').filter(Boolean).forEach(x => { const t = x.replace(/^K\d+:/, ''); docCount[t] = (docCount[t] || 0) + 1; }));
  const topDocs = Object.keys(docCount).map(k => ({ title: k, n: docCount[k] })).sort((a, b) => b.n - a.n).slice(0, 10);
  const schools = Array.from(new Set(rows_('logs').map(r => String(r['園所'])).filter(Boolean)));
  return { stats: stats, rows: rows.slice(-300).reverse(), gaps: gaps, topDocs: topDocs, schools: schools, typeNames: LOG_TYPE_NAME };
}

/** 單一回合明細：同一個 Session 的完整對話 + 這一回合的流程紀錄 */
function adminLogDetail(row) {
  requireAdmin_();
  const s = sh_('logs');
  const head = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
  const v = s.getRange(row, 1, 1, head.length).getValues()[0];
  const o = {}; head.forEach((h, i) => o[h] = v[i]);
  const fb = feedbackMap_();
  const session = String(o['Session']);
  const turns = rows_('logs').filter(r => String(r['Session']) === session).map(r => ({
    row: r._row, turn: r['輪次'], time: fmt_(r['時間']), msg: String(r['老師訊息（去識別化）']), type: String(r['回應類型']),
    reply: jsonOr_(r['回答'], r['回答']), fb: (fb[session + '|' + r['輪次']] || []).join('、'),
  }));
  return {
    row: row, time: fmt_(o['時間']), session: session, school: String(o['園所']), turn: o['輪次'], type: String(o['回應類型']),
    msg: String(o['老師訊息（去識別化）']), triage: jsonOr_(o['分流'], {}), reply: jsonOr_(o['回答'], o['回答']),
    sources: String(o['引用'] || ''), checks: jsonOr_(o['檢查'], []), rewritten: o['是否重寫'] === '是', ms: o['耗時ms'],
    metrics: { retrieved: o['檢索段數'] === '' ? null : o['檢索段數'], top: o['最高相似度'] === '' ? null : o['最高相似度'], cited: o['被引用段數'] === '' ? null : o['被引用段數'], skills: String(o['載入Skill'] || '').split('、').filter(Boolean) },
    trace: jsonOr_(o['流程紀錄'], []), turns: turns,
  };
}

// ---------- 命中率測試（P17 回歸測試的檢索部分） ----------
/**
 * 「檢索測試」工作表：每列一個老師可能會問的問題 + 專家認為應該找到的文件 ID（可多個，逗號分隔）。
 * 對每題做一次檢索，看應命中的文件有沒有出現在最後採用的段落中：
 *  - Hit@K：有出現的題目比例
 *  - MRR：應命中文件第一次出現的名次倒數的平均（1 = 每題都排第一）
 */
function adminEvalList() {
  requireAdmin_();
  return rows_('evalset').map(r => ({ row: r._row, q: String(r['測試問題']), expect: String(r['應命中文件ID']), note: String(r['備註'] || ''), result: String(r['結果'] || ''), rank: r['名次'], top: r['最高分'], hit: String(r['命中段落'] || ''), at: fmt_(r['測試時間']) }));
}
function adminAddEval(q, expect, note) {
  requireAdmin_();
  if (!String(q || '').trim() || !String(expect || '').trim()) throw new Error('請填寫測試問題與應命中文件');
  append_('evalset', [[String(q).trim(), String(expect).trim(), note || '', '', '', '', '', '']]);
  return adminEvalList();
}
function adminDeleteEval(row) {
  requireAdmin_();
  sh_('evalset').deleteRow(row);
  return adminEvalList();
}
function adminRunEval() {
  requireAdmin_();
  const list = rows_('evalset').filter(r => String(r['測試問題']).trim());
  if (!list.length) throw new Error('「檢索測試」還沒有題目');
  const exps = list.map(r => expandQuery_(String(r['測試問題'])));
  const vecs = embedTexts_(exps.map(e => e.text), 'RETRIEVAL_QUERY');
  const s = sh_('evalset'); const now = new Date();
  let hitN = 0, rr = 0, topSum = 0;
  const results = list.map((r, i) => {
    const expect = String(r['應命中文件ID']).split(/[,，、\s]+/).filter(Boolean);
    const sd = searchDetail_(vecs[i], String(r['測試問題']), exps[i].concepts);
    const candRank = sd.cands.findIndex(c => expect.indexOf(c.docId) >= 0) + 1;     // 前 10 名中的名次（不論門檻）
    const hit = sd.hits.find(h => expect.indexOf(h.docId) >= 0);
    const hitRank = hit ? sd.hits.indexOf(hit) + 1 : 0;
    if (hit) { hitN++; rr += 1 / hitRank; }
    const top = sd.cands.length ? sd.cands[0].score : 0; topSum += top;
    const result = hit ? '命中' : candRank ? '未達門檻' : '沒找到';
    const hitTxt = hit ? hit.title + (hit.page ? ' p.' + hit.page : '') + '（' + hit.score + '）' : candRank ? '第 ' + candRank + ' 名但分數 ' + sd.cands[candRank - 1].score + ' 低於門檻 ' + sd.minScore : '';
    s.getRange(r._row, 4, 1, 5).setValues([[result, hitRank || (candRank ? '>' + sd.topK : ''), top, hitTxt, now]]);
    return { row: r._row, q: String(r['測試問題']), expect: expect.join(', '), result: result, rank: hitRank, candRank: candRank, top: top, hit: hitTxt,
      cands: sd.cands.slice(0, 5).map(c => ({ docId: c.docId, title: c.title, page: c.page, score: c.score, pass: c.pass, ok: expect.indexOf(c.docId) >= 0 })) };
  });
  const n = list.length;
  return { n: n, hitRate: Math.round(hitN / n * 1000) / 10, mrr: Math.round(rr / n * 1000) / 1000, avgTop: Math.round(topSum / n * 1000) / 1000,
    minScore: Number(cfg_('min_score') || 0.45), topK: Number(cfg_('top_k') || 6), results: results };
}
