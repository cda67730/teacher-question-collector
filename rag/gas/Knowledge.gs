/** 知識庫：文件轉文字、切段、向量化、檢索（P06、P11） */

// ---------- 文件轉文字 ----------
function extractText_(name, mimeType, b64) {
  const lower = String(name || '').toLowerCase();
  const bytes = Utilities.base64Decode(b64);
  if (/\.(txt|md|csv)$/.test(lower) || /^text\//.test(mimeType || '')) {
    return Utilities.newBlob(bytes).getDataAsString('UTF-8');
  }
  if (/\.pdf$/.test(lower) || mimeType === 'application/pdf') {
    const prompt = '請把這份 PDF 的文字完整轉錄出來，保留標題與段落，不要摘要、不要改寫。每一頁開頭加上一行「[[第N頁]]」。表格用文字逐列轉錄。只輸出轉錄內容。';
    const a = reqArgs_(genReq_(cfg_('model_answer'), [{ text: prompt }, { inline_data: { mime_type: 'application/pdf', data: b64 } }], { temperature: 0, maxTokens: 65536 }));
    return genText_(UrlFetchApp.fetch(a[0], a[1]));
  }
  if (/\.docx?$/.test(lower)) {
    // 需要在 Apps Script 開啟「Drive API」進階服務（v3）
    const blob = Utilities.newBlob(bytes, mimeType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name);
    const file = Drive.Files.create({ name: 'tmp-' + name, mimeType: 'application/vnd.google-apps.document' }, blob);
    try { return DocumentApp.openById(file.id).getBody().getText(); }
    finally { DriveApp.getFileById(file.id).setTrashed(true); }
  }
  throw new Error('不支援的檔案格式，請上傳 PDF、Word（.docx）、TXT 或 Markdown');
}

// ---------- 切段：依段落累積到約 size 字，保留頁碼 ----------
function chunkText_(text, size, overlap) {
  size = size || Number(cfg_('chunk_size') || 500);
  overlap = overlap || Number(cfg_('chunk_overlap') || 80);
  const paras = String(text).replace(/\r/g, '').split(/\n\s*\n|\n(?=\[\[第\d+頁\]\])/).map(s => s.trim()).filter(Boolean);
  const out = []; let buf = '', page = '', bufPage = '';
  const flush = () => { if (buf.trim()) out.push({ text: buf.trim(), page: bufPage || page }); };
  paras.forEach(p => {
    const m = p.match(/^\[\[第(\d+)頁\]\]\s*/);
    if (m) { page = m[1]; p = p.slice(m[0].length).trim(); if (!p) return; }
    if (!buf) bufPage = page;
    if ((buf + '\n' + p).length > size && buf) {
      flush();
      buf = buf.slice(-overlap) + '\n' + p; bufPage = page;
    } else buf = buf ? buf + '\n' + p : p;
    while (buf.length > size * 1.6) { out.push({ text: buf.slice(0, size), page: bufPage || page }); buf = buf.slice(size - overlap); }
  });
  flush();
  return out;
}

// ---------- 新增文件：轉文字 → 切段 → 向量 → 寫入（狀態：待審核） ----------
function addDocument_(meta, text, user) {
  if (!String(text || '').trim()) throw new Error('沒有讀到任何文字');
  const docId = 'D' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyMMddHHmmss');
  const chunks = chunkText_(text);
  const vecs = embedTexts_(chunks.map(c => (meta.title ? meta.title + '\n' : '') + c.text), 'RETRIEVAL_DOCUMENT');
  const now = new Date();
  append_('chunks', chunks.map((c, i) => [docId + '-' + String(i + 1).padStart(3, '0'), docId, i + 1, c.text, c.page || '', quant_(vecs[i]), '待審核']));
  append_('docs', [[docId, meta.title || '', meta.source || '', meta.evidence || '', meta.fileName || '', chunks.length, '待審核', user || '', now, '', '']]);
  return { docId: docId, chunks: chunks.length };
}

function setDocStatus_(docId, status, user) {
  const docs = rows_('docs');
  const d = docs.find(r => String(r['文件ID']) === docId);
  if (!d) throw new Error('找不到文件');
  const s = sh_('docs');
  const head = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
  s.getRange(d._row, head.indexOf('狀態') + 1).setValue(status);
  s.getRange(d._row, head.indexOf('審核者') + 1).setValue(user || '');
  s.getRange(d._row, head.indexOf('審核時間') + 1).setValue(new Date());
  // 同步段落狀態
  const cs = sh_('chunks'); const v = cs.getDataRange().getValues(); const ch = v[0];
  const di = ch.indexOf('文件ID'), si = ch.indexOf('狀態');
  for (let r = 1; r < v.length; r++) if (String(v[r][di]) === docId) v[r][si] = status;
  cs.getRange(2, si + 1, v.length - 1, 1).setValues(v.slice(1).map(r => [r[si]]));
}

// ---------- 檢索（P06）：同義詞擴充 + 向量相似度 + 關鍵字加分 ----------
function expandQuery_(text) {
  const hits = synonyms_().filter(s => text.indexOf(s.word) >= 0);
  const concepts = Array.from(new Set(hits.map(h => h.concept)));
  return { text: concepts.length ? text + '\n相關概念：' + concepts.join('、') : text, concepts: concepts, words: hits.map(h => h.word) };
}

function loadIndex_() {
  const docs = {};
  rows_('docs').forEach(r => docs[String(r['文件ID'])] = { title: String(r['標題']), source: String(r['出處']), evidence: String(r['證據等級']) });
  const v = sh_('chunks').getDataRange().getValues(); const h = v.shift();
  const I = n => h.indexOf(n);
  return v.filter(r => r[I('狀態')] === '已核可' && r[I('向量')]).map(r => ({
    id: String(r[I('段落ID')]), docId: String(r[I('文件ID')]), text: String(r[I('內容')]), page: String(r[I('頁碼')] || ''),
    vec: dequant_(String(r[I('向量')])), doc: docs[String(r[I('文件ID')])] || {},
  }));
}

/** qvec 為查詢向量（未壓縮）；回傳前 k 段 */
function search_(qvec, rawText, concepts, k) {
  const q = normVec_(qvec).map(x => Math.round(x * 127));
  const keys = Array.from(new Set((concepts || []).concat(String(rawText).match(/[一-鿿]{2,4}/g) || []))).slice(0, 30);
  const minScore = Number(cfg_('min_score') || 0.45);
  return loadIndex_().map(c => {
    let dot = 0; const v = c.vec;
    for (let i = 0; i < q.length && i < v.length; i++) dot += q[i] * v[i];
    let kw = 0; keys.forEach(w => { if (c.text.indexOf(w) >= 0) kw++; });
    return { c: c, score: dot / (127 * 127) + Math.min(kw, 5) * 0.01 };
  }).filter(x => x.score >= minScore).sort((a, b) => b.score - a.score).slice(0, k || Number(cfg_('top_k') || 6))
    .map((x, i) => ({ ref: 'K' + (i + 1), id: x.c.id, title: x.c.doc.title, source: x.c.doc.source, evidence: x.c.doc.evidence, page: x.c.page, text: x.c.text, score: Math.round(x.score * 1000) / 1000 }));
}
