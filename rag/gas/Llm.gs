/** Gemini 呼叫工具：產生、JSON、向量；fetchAll 用來並行執行 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

function apiKey_() {
  const k = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!k) throw new Error('GEMINI_API_KEY 未設定');
  return k;
}

/** 建立一個 generateContent 請求（可放進 fetchAll） */
function genReq_(model, parts, opts) {
  opts = opts || {};
  const body = { contents: [{ role: 'user', parts: parts }], generationConfig: { temperature: opts.temperature == null ? 0.3 : opts.temperature } };
  if (opts.json) body.generationConfig.responseMimeType = 'application/json';
  if (opts.maxTokens) body.generationConfig.maxOutputTokens = opts.maxTokens;
  // 分流、檢查這類單一任務不需要模型「思考」，關掉可省下數秒（只對支援的 2.5 系列模型設定）
  if (opts.noThink && /2\.5-flash/.test(model)) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  return {
    url: GEMINI_BASE + model + ':generateContent', method: 'post', contentType: 'application/json',
    payload: JSON.stringify(body), headers: { 'x-goog-api-key': apiKey_() }, muteHttpExceptions: true,
  };
}

function genText_(res) {
  if (res.getResponseCode() !== 200) throw new Error('Gemini ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  const d = JSON.parse(res.getContentText());
  const parts = (((d.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map(p => p.text || '').join('').trim();
}

function parseJson_(text) {
  try { return JSON.parse(text); } catch (e) {}
  const m = String(text).match(/[\[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  throw new Error('模型回覆不是有效的 JSON');
}

function gen_(model, prompt, opts) {
  const a = reqArgs_(genReq_(model, [{ text: prompt }], opts));
  return genText_(UrlFetchApp.fetch(a[0], a[1]));
}
function genJson_(model, prompt, opts) {
  return parseJson_(gen_(model, prompt, Object.assign({ json: true }, opts || {})));
}
function reqArgs_(r) { const u = r.url; const o = Object.assign({}, r); delete o.url; return [u, o]; }

/** 向量：每批最多 100 筆 */
function embedReqs_(texts, taskType) {
  const model = cfg_('model_embed');
  const dim = Number(cfg_('embed_dim') || 768);
  const reqs = [];
  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100).map(t => ({
      model: 'models/' + model, content: { parts: [{ text: String(t).slice(0, 8000) }] }, taskType: taskType, outputDimensionality: dim,
    }));
    reqs.push({
      url: GEMINI_BASE + model + ':batchEmbedContents', method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ requests: batch }), headers: { 'x-goog-api-key': apiKey_() }, muteHttpExceptions: true,
    });
  }
  return reqs;
}
function embedParse_(res) {
  if (res.getResponseCode() !== 200) throw new Error('Embedding ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText()).embeddings.map(e => e.values);
}
function embedTexts_(texts, taskType) {
  if (!texts.length) return [];
  const reqs = embedReqs_(texts, taskType), out = [];
  for (let i = 0; i < reqs.length; i += 3) {           // 一次最多 3 批，避免觸發頻率限制
    const group = reqs.slice(i, i + 3);
    let res = UrlFetchApp.fetchAll(group);
    if (res.some(r => r.getResponseCode() === 429)) { Utilities.sleep(8000); res = UrlFetchApp.fetchAll(group); }
    res.forEach(r => embedParse_(r).forEach(v => out.push(v)));
  }
  return out;
}

/** 向量壓縮：正規化後轉 int8，再轉 base64 存進儲存格 */
function quant_(vec) {
  let n = 0; vec.forEach(x => n += x * x); n = Math.sqrt(n) || 1;
  const bytes = vec.map(x => Math.max(-127, Math.min(127, Math.round((x / n) * 127))));
  return Utilities.base64Encode(bytes);
}
function dequant_(b64) { return Utilities.base64Decode(b64); }
function normVec_(vec) { let n = 0; vec.forEach(x => n += x * x); n = Math.sqrt(n) || 1; return vec.map(x => x / n); }
