/**
 * 幼兒園現場問題收集：後端（Google Apps Script 網頁應用程式）
 *
 * 指令碼屬性（專案設定 → 指令碼屬性）：
 *   GEMINI_API_KEY  必填，Gemini API 金鑰（建議使用付費方案，避免資料被用於訓練）
 *   GEMINI_MODEL    選填，預設 gemini-2.5-flash
 *   SHEET_ID        選填，資料寫入的試算表 ID；不填則使用綁定的試算表
 *   HOURLY_LIMIT    選填，每個邀請碼每小時可呼叫次數，預設 300
 *
 * 邀請碼放在試算表的「邀請碼」工作表：A 欄邀請碼、B 欄園所代號、C 欄是否啟用（TRUE/FALSE）
 * 第一次使用請在編輯器執行 setup()。
 */

const PROPS = PropertiesService.getScriptProperties();
const MODEL = () => PROPS.getProperty('GEMINI_MODEL') || 'gemini-2.5-flash';
const VOCAB = '教保員、教保服務人員、幼兒園、融合班、混齡班、轉銜、收拾時間、角落時間、團討、巡迴輔導、特教、鑑定、早療、個別化教育計畫、聯絡簿、情緒行為、親師溝通';

function doGet() {
  return json_({ ok: true, service: 'teacher-question-collector' });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const school = checkCode_(req.code);
    if (!school) return json_({ ok: false, error: '邀請碼不正確或已停用' });
    if (!rateOk_(req.code)) return json_({ ok: false, error: '使用次數過多，請稍後再試' });
    switch (req.action) {
      case 'check': return json_({ ok: true });
      case 'transcribe': return json_({ ok: true, text: transcribe_(req.audio, req.mimeType) });
      case 'followup': return json_(Object.assign({ ok: true }, followup_(req.question, req.answer, req.known)));
      case 'submit': return json_({ ok: true, id: submit_(school, req.background, req.answers) });
      default: return json_({ ok: false, error: '未知的操作' });
    }
  } catch (err) {
    console.error(err);
    // 回傳簡短錯誤原因方便除錯（不含金鑰）；正式上線後可改回通用訊息
    return json_({ ok: false, error: '伺服器發生錯誤（' + String(err && err.message || err).slice(0, 160) + '）' });
  }
}

// ---------- 邀請碼與頻率限制 ----------
function checkCode_(code) {
  if (!code) return null;
  const rows = sheet_('邀請碼').getDataRange().getValues().slice(1);
  const hit = rows.find(r => String(r[0]).trim() === String(code).trim() && String(r[2]).toUpperCase() !== 'FALSE');
  return hit ? String(hit[1] || hit[0]) : null;
}
function rateOk_(code) {
  const cache = CacheService.getScriptCache();
  const key = 'rate_' + code + '_' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMddHH');
  const n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), 3600);
  return n <= Number(PROPS.getProperty('HOURLY_LIMIT') || 300);
}

// ---------- Gemini ----------
function gemini_(parts, jsonMode) {
  const key = PROPS.getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY 未設定');
  const body = { contents: [{ role: 'user', parts: parts }], generationConfig: { temperature: 0.2 } };
  if (jsonMode) body.generationConfig.responseMimeType = 'application/json';
  const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + MODEL() + ':generateContent', {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(body),
    headers: { 'x-goog-api-key': key }, muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('Gemini ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  const data = JSON.parse(res.getContentText());
  const text = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  return text.map(p => p.text || '').join('').trim();
}

// 語音轉文字：音檔只在記憶體中處理，不寫入任何儲存空間
function transcribe_(b64, mimeType) {
  if (!b64) throw new Error('沒有音檔');
  if (b64.length > 15 * 1024 * 1024) throw new Error('音檔太大');
  const prompt = '請把這段錄音逐字轉錄成繁體中文（台灣用語）。說話者是幼兒園老師，內容與班級現場有關。' +
    '常見用語：' + VOCAB + '。只輸出轉錄文字，不要加說明、標題或時間碼；聽不清楚的地方用「（聽不清楚）」標示。';
  return gemini_([{ text: prompt }, { inline_data: { mime_type: mimeType || 'audio/webm', data: b64 } }], false);
}

// 追問：情境不清楚時，最多兩個追問
function followup_(question, answer, known) {
  if (!answer) return { need: false, questions: [] };
  const prompt = '你在協助收集幼兒園老師的現場問題。以下是題目與老師的回答。\n' +
    '判斷回答是否已經說明「在什麼情境或時段發生」以及「發生前後發生了什麼或老師怎麼處理」。' +
    '若兩者都清楚，或回答已經很具體，need 為 false。若不清楚，最多提出 2 個簡短、好回答的追問（繁體中文、語氣溫和、不要說教、不要給建議）。\n' +
    (known ? '老師已經另外填好這些資料，不要再問：' + String(known).slice(0, 500) + '\n追問請聚焦在孩子具體做了什麼、發生前後的經過。\n' : '') +
    '只輸出 JSON：{"need": true, "questions": ["..."]}\n\n題目：' + question + '\n回答：' + String(answer).slice(0, 4000);
  try {
    const r = JSON.parse(gemini_([{ text: prompt }], true));
    return { need: !!r.need, questions: (r.questions || []).slice(0, 2).map(String) };
  } catch (err) {
    console.warn(err);
    return { need: false, questions: [] };
  }
}

// 去識別化：先用 LLM 換掉人名與可識別資訊，失敗時用規則
function deidentify_(text) {
  if (!text) return '';
  const prompt = '把下面文字中的人名與可以認出身分的資訊換成代稱，其餘文字一字不改：' +
    '幼兒名字換成「幼兒A」「幼兒B」（同一人用同一代稱），家長換成「幼兒A家長」，同事換成「同事A」，園所名稱換成「本園」，電話、地址刪除。' +
    '只輸出改寫後的文字。\n\n' + text;
  try { return gemini_([{ text: prompt }], false) || ruleDeid_(text); }
  catch (err) { console.warn(err); return ruleDeid_(text); }
}
function ruleDeid_(text) {
  return String(text)
    .replace(/小[一-鿿](?![朋孩班組時心事學])/g, '幼兒')
    .replace(/09\d{2}[-\s]?\d{3}[-\s]?\d{3}/g, '（電話已刪除）');
}

// ---------- 寫入試算表 ----------
function submit_(school, bg, answers) {
  bg = bg || {}; answers = answers || [];
  const id = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd') + '-' + Utilities.getUuid().slice(0, 8);
  const now = new Date();
  const rows = answers.map(a => [
    now, id, school, bg.city || '', bg.area || '', bg.years || '', bg.type || '', bg.cls || '', bg.sen || '',
    a.qid || '', a.question || '', a.skipped ? '（跳過）' : deidentify_(a.answer || ''),
    a.source || '', a.edited ? '是' : '否',
    (a.followups || []).join('｜'), deidentify_(a.followupAnswer || ''),
  ].concat(slotCols_(a)));
  if (rows.length) {
    const sh = sheet_('回答');
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
  return id;
}

// 幼兒題的必填資料（填槽）：不是幼兒題的列標「不適用」
const SLOT_HEAD = ['幼兒月齡', '幼兒年齡', '語言狀態', '發生時段', '已試做法（去識別化）', '試做結果', '資料是否填齊'];
function slotCols_(a) {
  const s = a.child && a.slots;
  if (!s) return ['', '', '', '', '', '', a.skipped ? '' : '不適用'];
  return [s.ageMonths === '' ? '' : Number(s.ageMonths), s.ageLabel || '', s.language || '', s.situations || '',
    s.tried === '還沒試過' ? '還沒試過' : deidentify_(s.tried || ''), s.result || '', s.complete ? '是' : '否'];
}

// ---------- 工具 ----------
function sheet_(name) {
  const id = PROPS.getProperty('SHEET_ID');
  const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** 第一次使用請執行：建立工作表與標題列 */
function setup() {
  const a = sheet_('回答');
  if (a.getLastRow() === 0) a.appendRow(['時間', '回覆編號', '園所代號', '縣市', '地區', '年資', '園所類型', '班級型態', '有特殊需求幼兒',
    '題號', '題目', '回答（去識別化）', '來源', '老師是否修改轉錄', '追問', '追問回答（去識別化）']);
  // 已有資料的「回答」表：把新欄位補在最後，不動舊資料
  const head = a.getRange(1, 1, 1, a.getLastColumn()).getValues()[0];
  const add = SLOT_HEAD.filter(h => head.indexOf(h) < 0);
  if (add.length) a.getRange(1, head.length + 1, 1, add.length).setValues([add]);
  a.setFrozenRows(1);
  const c = sheet_('邀請碼');
  if (c.getLastRow() === 0) { c.appendRow(['邀請碼', '園所代號', '啟用']); c.appendRow(['TEST-2026', '測試園', true]); }
  c.setFrozenRows(1);
}
