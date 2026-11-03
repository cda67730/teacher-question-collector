/**
 * 知識圖譜：當架構用（內容靠上傳的文件）
 *  - 匯入：後台上傳 knowledge-graph.json → 節點、關係、來源、圖譜定義（節點類型與關係的定義）
 *  - 上傳文件時：照 ontology 的「文章標註」規格標每一段
 *      主要標籤＝這段直接討論的節點；次要標籤＝這段隱含的理論、策略或解釋
 *      讀者對象、適用年齡、情境：段落有明講才標，沒標＝不限
 *      現有節點不夠時提出「新節點候選」（ontology 的 proposedNode）
 *  - 專家在後台審核候選：核可（新增節點）、合併到既有節點、略過
 *  - 關係檢查：ontology 沒有限制哪種節點能接哪種關係，所以用圖譜現有關係歸納出常見接法，少見的接法只提醒、不擋
 *  - 覆蓋度：每個節點有幾段文件以它為主要標籤、幾段已核可、幾段是具體做法
 * 目前回答流程不讀圖譜（之後第 3 步才接）。
 */

const KG_FROM_IMPORT = '知識圖譜匯入', KG_FROM_PROPOSAL = '文件提案';
const KG_TAG_MAIN = '主要', KG_TAG_SUB = '次要';
const KG_AUDIENCES = ['家長', '教保服務人員', '專業人員'];
// 匯入前的預設值（與 knowledge-graph.json 1.0.0 相同）；匯入後以「圖譜定義」表為準
const KG_DEFS_DEFAULT = {
  types: [['hub', '主軸', '知識圖譜的五大主軸。'], ['sub', '子分類', '主軸底下的主題分類。'], ['policy', '法規課綱', '法律、行政規則、課程大綱及其構成要素。'],
    ['approach', '課程取向', '幼兒園課程設計與教學模式。'], ['concept', '概念', '發展、心理或教育上的概念與現象。'],
    ['practice', '實務策略', '教保服務人員或專業人員可採取的做法、工具或服務。'], ['theory', '理論', '心理學或教育學理論、模型與經典研究。'],
    ['category', '障礙與需求類別', '特殊教育鑑定類別與學前常見的特殊需求。']],
  rels: [['hasPart', '包含', '上層分類包含下層項目（樹狀階層）。'], ['regulates', '規範', '法規或制度對某項實務、對象或程序的規範、授權或保障。'],
    ['theoreticalBasisFor', '理論基礎', '理論、研究或概念為某項實務或概念提供理論依據。'], ['appliedIn', '應用於', '概念、能力或策略在某情境、區域或作息中被應用或練習。'],
    ['hasStrategy', '可用策略', '某項需求、行為或目標可搭配的策略或調整方式。'], ['supports', '支持', '專業人員、資源或環境對某對象或能力的支持、評估或服務。'],
    ['correspondsTo', '對應', '兩者在內容上相互對應、屬於或呼應。'], ['influences', '影響', '一方會促進、阻礙、預測或觸發另一方。'],
    ['precedes', '後續為', '發展階段、流程步驟或演變上的先後關係。'], ['informs', '提供資訊', '評量、觀察或資料為另一項工作提供依據或材料。'],
    ['relatedTo', '相關', '無法歸入上述類型的一般關聯。']],
};
const KG_TOP_TYPE = '主軸'; // 主軸只有圖譜本身的五個，不接受新增

function kgHasGraph_() { try { return sh_('kgNodes').getLastRow() > 1; } catch (e) { return false; } }
function kgNodes_(includeOff) { return rows_('kgNodes').filter(r => includeOff || String(r['狀態'] || '啟用') !== '停用'); }

/** 節點類型與關係的定義：{types:[{id,label,def}], rels:[{id,label,def}]} */
function kgDefs_() {
  let rs = [];
  try { rs = rows_('kgDefs'); } catch (e) {}
  const pick = (kind, dflt) => {
    const a = rs.filter(r => r['種類'] === kind).map(r => ({ id: String(r['ID']), label: String(r['名稱']), def: String(r['定義'] || '') }));
    return a.length ? a : dflt.map(x => ({ id: x[0], label: x[1], def: x[2] }));
  };
  return { types: pick('節點類型', KG_DEFS_DEFAULT.types), rels: pick('關係', KG_DEFS_DEFAULT.rels) };
}
function kgRelIds_(defs) { return defs.rels.map(r => r.id); }
function kgRelLabel_(defs, id) { const r = defs.rels.find(x => x.id === id); return r ? r.label : id; }
function kgNewTypes_(defs) { return defs.types.map(t => t.label).filter(l => l !== KG_TOP_TYPE); }

/** 整張表重寫：保留 keep 的列，加上 add 的列 */
function kgRewrite_(key, keep, add) {
  const s = sh_(key), width = s.getLastColumn();
  if (s.getLastRow() > 1) s.getRange(2, 1, s.getLastRow() - 1, width).clearContent();
  const all = keep.concat(add);
  if (all.length) s.getRange(2, 1, all.length, width).setValues(all.map(r => r.concat(Array(Math.max(0, width - r.length)).fill('')).slice(0, width)));
}
function kgRowArr_(key, r) {
  const s = sh_(key); const head = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
  return head.map(h => r[h] == null ? '' : r[h]);
}
function kgHead_(key) { const s = sh_(key); return s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0]; }

// ---------- 匯入 ----------
/** 匯入 knowledge-graph.json；只取代「知識圖譜匯入」來的節點與關係，文件提案新增的節點保留 */
function adminImportKG(jsonText) {
  const me = requireAdmin_();
  let d; try { d = JSON.parse(String(jsonText || '').replace(/^﻿/, '')); } catch (e) { throw new Error('檔案不是有效的 JSON'); }
  if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) throw new Error('找不到 nodes 或 edges，請上傳 knowledge-graph.json');
  const ver = KG_FROM_IMPORT + ' v' + ((d.meta && d.meta.version) || '');
  const now = new Date();
  // 圖譜定義：節點類型與關係（含定義），給 AI 標註時參考
  const defRows = [];
  (d.nodeTypes || []).forEach(t => t && t.label && defRows.push(['節點類型', t.id || '', t.label, t.definition || '']));
  (d.relations || []).forEach(r => r && r.id && defRows.push(['關係', r.id, r.label || r.id, r.definition || '']));
  if (defRows.length) kgRewrite_('kgDefs', [], defRows);
  const old = {}; kgNodes_(true).forEach(r => old[String(r['節點ID'])] = r);
  const keepNodes = kgNodes_(true).filter(r => String(r['來源']).indexOf(KG_FROM_IMPORT) !== 0).map(r => kgRowArr_('kgNodes', r));
  const addNodes = d.nodes.filter(n => n && n.id).map(n => {
    const o = old[String(n.id)] || {};
    return [String(n.id), n.label || '', n.typeLabel || n.type || '', n.parent || '', [].concat(n.path || []).join(' > '), n.definition || '',
      [].concat(n.practiceTips || []).join(' | '), [].concat(n.sources || []).join(';'), o['同義說法'] || '', o['狀態'] || '啟用', ver, now];
  });
  const ids = {}; addNodes.forEach(r => ids[r[0]] = true); keepNodes.forEach(r => ids[r[0]] = true);
  kgRewrite_('kgNodes', keepNodes, addNodes);
  const keepEdges = rows_('kgEdges').filter(r => String(r['來源']).indexOf(KG_FROM_IMPORT) !== 0).map(r => kgRowArr_('kgEdges', r));
  const addEdges = d.edges.filter(e => e && ids[e.source] && ids[e.target]).map(e => [String(e.source), e.relation || 'relatedTo', String(e.target), e.label || '', ver]);
  kgRewrite_('kgEdges', keepEdges, addEdges);
  const addSrc = (d.sources || []).filter(s => s && s.id).map(s => [String(s.id), s.title || '', s.publisher || '', s.url || '', s.scope || '']);
  kgRewrite_('kgSources', [], addSrc);
  return { nodes: addNodes.length, kept: keepNodes.length, edges: addEdges.length, sources: addSrc.length, defs: defRows.length, by: me };
}

// ---------- 關係接法：從現有關係歸納（ontology 本身沒有限制） ----------
/** 回傳 {relId: {'來源類型>目標類型': 次數}} */
function kgPairs_(nodes, edges) {
  const type = {}; nodes.forEach(r => type[String(r['節點ID'])] = String(r['類型']));
  const p = {};
  edges.forEach(e => {
    const a = type[String(e['主詞'])], b = type[String(e['受詞'])]; if (!a || !b) return;
    const m = p[e['關係']] || (p[e['關係']] = {}); const k = a + '>' + b; m[k] = (m[k] || 0) + 1;
  });
  return p;
}
/** 少見接法的提醒文字；沒問題回傳空字串 */
function kgRelWarn_(pairs, defs, rel, srcType, tgtType) {
  if (rel === 'relatedTo') return ''; // 「相關」是一般關聯，不檢查
  const m = pairs[rel] || {}; const n = m[srcType + '>' + tgtType] || 0;
  if (n > 0) return '';
  const common = Object.keys(m).sort((a, b) => m[b] - m[a]).slice(0, 3).map(k => k.replace('>', '→')).join('、');
  return '圖譜裡沒有「' + srcType + ' →' + kgRelLabel_(defs, rel) + '→ ' + tgtType + '」這種接法' + (common ? '（常見：' + common + '）' : '') + '，請確認';
}

// ---------- 上傳文件時：照 ontology 的文章標註規格標段落 ----------
function kgNodeList_() {
  return kgNodes_().map(r => String(r['節點ID']) + '｜' + r['名稱'] + (r['同義說法'] ? '（' + r['同義說法'] + '）' : '') + '｜' + r['類型'] + '｜' + String(r['路徑'] || '').split(' > ').slice(-1)[0]).join('\n');
}

function kgMapPrompt_(defs, list, title, group) {
  const types = kgNewTypes_(defs);
  return '你在替幼教知識文件做標註，只輸出 JSON。\n\n' +
    '【標註規格】\n' +
    '- main（主要標籤）：這段「直接討論」的節點，1–3 個。\n' +
    '- sub（次要標籤）：這段沒有直接點名、但隱含運用的理論、策略或解釋，0–3 個。只是順帶提到的不要標。\n' +
    '- 標籤只能用節點清單裡的 ID。\n' +
    '- audience（讀者對象）：這段是寫給誰看的，從 ' + JSON.stringify(KG_AUDIENCES) + ' 選，可多選；看不出來就給空陣列。\n' +
    '- age（適用年齡）：段落「明講」的年齡範圍，例如「3–4歲」；沒明講就給空字串（代表不限年齡，不要自己推測）。\n' +
    '- context（情境）：段落明講的發生情境，例如「入園適應」「轉銜」「用餐」；沒有就給空陣列。\n' +
    '- new（建議新增節點）：只有當這段的主要內容在清單裡找不到合適節點時才提出。欄位：name（簡短名稱）、definition（一句話）、' +
    'parent（最適合的上層節點 ID）、type（節點類型名稱）、relation（與某個既有節點的關係，可省略：{"type":關係ID,"target":節點ID}，方向為「新節點 → 目標」）、reason（為什麼現有節點不夠）。\n\n' +
    '【節點類型】（新節點的 type 只能從這些選）\n' + defs.types.filter(t => types.indexOf(t.label) >= 0).map(t => '- ' + t.label + '：' + t.def).join('\n') + '\n\n' +
    '【關係類型】（relation.type 用 ID）\n' + defs.rels.map(r => '- ' + r.id + '（' + r.label + '）：' + r.def).join('\n') + '\n\n' +
    '【節點清單】（ID｜名稱（同義說法）｜類型｜所屬分類）\n' + list + '\n\n' +
    '格式：{"items":[{"chunk":1,"main":["id"],"sub":[],"audience":[],"age":"","context":[],"new":[]}]}\n\n' +
    '文件標題：' + title + '\n\n' +
    group.map((c, j) => '【段落' + (j + 1) + '】\n' + String(c.text).slice(0, 1500)).join('\n\n');
}

/** chunks：[{id, text}]；回傳 {links:[[段落ID, 節點ID, 標籤]], meta:{段落ID:{audience,age,context}}, cands:[...]} */
function kgMapChunks_(title, chunks) {
  const defs = kgDefs_();
  const nodes = kgNodes_(); const valid = {}; nodes.forEach(r => valid[String(r['節點ID'])] = true);
  const list = kgNodeList_(); const links = [], cands = [], meta = {};
  for (let i = 0; i < chunks.length; i += 12) {
    const group = chunks.slice(i, i + 12);
    try {
      const r = genJson_(cfg_('model_triage'), kgMapPrompt_(defs, list, title, group), { temperature: 0, noThink: true });
      (r.items || []).forEach(it => {
        const c = group[Number(it.chunk) - 1]; if (!c) return;
        const main = Array.from(new Set(it.main || it.nodes || [])).filter(id => valid[id]).slice(0, 3);
        const sub = Array.from(new Set(it.sub || [])).filter(id => valid[id] && main.indexOf(id) < 0).slice(0, 3);
        main.forEach(id => links.push([c.id, id, KG_TAG_MAIN]));
        sub.forEach(id => links.push([c.id, id, KG_TAG_SUB]));
        meta[c.id] = {
          audience: [].concat(it.audience || []).filter(a => KG_AUDIENCES.indexOf(a) >= 0).join('、'),
          age: String(it.age || '').trim().slice(0, 30),
          context: [].concat(it.context || []).map(x => String(x).trim()).filter(Boolean).slice(0, 4).join('、'),
        };
        (it.new || []).forEach(n => { if (n && n.name) cands.push(Object.assign({ chunkId: c.id }, n)); });
      });
    } catch (e) { console.warn('節點標註失敗', e); }
  }
  return { links: links, cands: cands, meta: meta };
}

/** 寫入標註與候選；候選名稱和既有節點（含同義說法）相同就直接掛上，和待審候選相同就累加次數 */
function kgSaveMapping_(docId, res) {
  const now = new Date(); const defs = kgDefs_(); const relIds = kgRelIds_(defs); const types = kgNewTypes_(defs);
  const nodes = kgNodes_(); const byName = {};
  nodes.forEach(r => { byName[String(r['名稱']).trim()] = String(r['節點ID']); String(r['同義說法'] || '').split(/[、,，]/).map(x => x.trim()).filter(Boolean).forEach(x => byName[x] = String(r['節點ID'])); });
  const valid = {}; nodes.forEach(r => valid[String(r['節點ID'])] = true);
  const links = res.links.slice();
  const cs = sh_('kgCands'); const head = kgHead_('kgCands'); const C = h => head.indexOf(h) + 1;
  const pending = rows_('kgCands').filter(r => r['狀態'] === '待審核');
  let added = 0, merged = 0;
  res.cands.forEach(n => {
    const name = String(n.name).trim().slice(0, 40);
    if (byName[name]) { links.push([n.chunkId, byName[name], KG_TAG_MAIN]); return; }
    const p = pending.find(r => String(r['名稱']).trim() === name);
    if (p) {
      const ids = String(p['段落ID'] || '').split(';').filter(Boolean); if (ids.indexOf(n.chunkId) < 0) ids.push(n.chunkId);
      p['段落ID'] = ids.join(';'); p['次數'] = Number(p['次數'] || 1) + 1;
      cs.getRange(p._row, C('段落ID')).setValue(p['段落ID']); cs.getRange(p._row, C('次數')).setValue(p['次數']); merged++; return;
    }
    const rel = n.relation && relIds.indexOf(n.relation.type) >= 0 && n.relation.type !== 'hasPart' && valid[n.relation.target] ? JSON.stringify({ type: n.relation.type, target: n.relation.target }) : '';
    const row = ['C' + Utilities.getUuid().slice(0, 8), name, String(n.definition || '').slice(0, 200), valid[n.parent] ? n.parent : '', types.indexOf(n.type) >= 0 ? n.type : '概念',
      rel, docId, n.chunkId, 1, String(n.reason || '').slice(0, 200), '待審核', '', '', ''];
    append_('kgCands', [row]);
    pending.push({ _row: cs.getLastRow(), '名稱': name, '段落ID': n.chunkId, '次數': 1, '狀態': '待審核' });
    added++;
  });
  // 同一段同一節點只留一筆；同時被標主要與次要時以主要為準
  const best = {};
  links.forEach(l => { const k = l[0] + '|' + l[1]; if (!best[k] || l[2] === KG_TAG_MAIN) best[k] = l; });
  const lh = kgHead_('kgLinks');
  const rows = Object.keys(best).map(k => { const l = best[k]; const o = { '段落ID': l[0], '節點ID': l[1], '方式': 'AI', '時間': now, '標籤': l[2] }; return lh.map(h => o[h] == null ? '' : o[h]); });
  if (rows.length) append_('kgLinks', rows);
  // 讀者對象、適用年齡、情境寫回段落
  const meta = res.meta || {};
  if (Object.keys(meta).length) {
    const s = sh_('chunks'); const ch = kgHead_('chunks');
    const ai = ch.indexOf('讀者對象'), gi = ch.indexOf('適用年齡'), xi = ch.indexOf('情境');
    if (ai >= 0 && gi >= 0 && xi >= 0) rows_('chunks').forEach(r => {
      const m = meta[String(r['段落ID'])]; if (!m) return;
      s.getRange(r._row, ai + 1).setValue(m.audience); s.getRange(r._row, gi + 1).setValue(m.age); s.getRange(r._row, xi + 1).setValue(m.context);
    });
  }
  return { links: rows.length, main: rows.filter(r => r[lh.indexOf('標籤')] === KG_TAG_MAIN).length, candidates: added, candidateHits: merged };
}

/** 標註一份文件中還沒有標過的段落 */
function kgMapDocument_(docId) {
  if (!kgHasGraph_()) return { skipped: '尚未匯入知識圖譜' };
  const done = {}; rows_('kgLinks').forEach(r => done[String(r['段落ID'])] = true);
  const doc = rows_('docs').find(r => String(r['文件ID']) === String(docId)) || {};
  const chunks = rows_('chunks').filter(r => String(r['文件ID']) === String(docId) && !done[String(r['段落ID'])]).map(r => ({ id: String(r['段落ID']), text: String(r['內容']) }));
  if (!chunks.length) return { links: 0, main: 0, candidates: 0, candidateHits: 0 };
  return kgSaveMapping_(docId, kgMapChunks_(String(doc['標題'] || ''), chunks));
}
function adminMapDoc(docId) { requireAdmin_(); return kgMapDocument_(docId); }

// ---------- 後台：總覽、覆蓋度、候選 ----------
function adminGraphLoad() {
  requireAdmin_();
  if (!kgHasGraph_()) return { empty: true };
  const defs = kgDefs_();
  const nodes = kgNodes_(true), edges = rows_('kgEdges'), links = rows_('kgLinks');
  const chunk = {}; rows_('chunks').forEach(r => chunk[String(r['段落ID'])] = { status: String(r['狀態']), type: String(r['類型'] || ''), docId: String(r['文件ID']), text: String(r['內容']) });
  const docs = {}; rows_('docs').forEach(r => docs[String(r['文件ID'])] = String(r['標題']));
  const cov = {};
  links.forEach(l => {
    const c = chunk[String(l['段落ID'])]; if (!c) return;
    const k = String(l['節點ID']); const o = cov[k] || (cov[k] = { all: 0, sub: 0, ok: 0, act: 0 });
    // 舊資料沒有「標籤」欄，視為主要
    if (String(l['標籤'] || KG_TAG_MAIN) !== KG_TAG_MAIN) { o.sub++; return; }
    o.all++; if (c.status === '已核可') { o.ok++; if (ACTIONABLE.indexOf(c.type) >= 0) o.act++; }
  });
  const byId = {}; nodes.forEach(r => byId[String(r['節點ID'])] = r);
  const label = id => byId[id] ? String(byId[id]['名稱']) : '';
  const list = nodes.map(r => { const k = String(r['節點ID']); const o = cov[k] || { all: 0, sub: 0, ok: 0, act: 0 };
    return { id: k, label: String(r['名稱']), type: String(r['類型']), path: String(r['路徑'] || ''), status: String(r['狀態'] || '啟用'), from: String(r['來源'] || ''), syn: String(r['同義說法'] || ''), all: o.all, sub: o.sub, ok: o.ok, act: o.act }; });
  const pairs = kgPairs_(nodes, edges);
  const cands = rows_('kgCands').filter(r => r['狀態'] === '待審核').map(r => {
    const ids = String(r['段落ID'] || '').split(';').filter(Boolean); const c = chunk[ids[0]] || {};
    let rel = null; try { rel = r['建議關係'] ? JSON.parse(r['建議關係']) : null; } catch (e) {}
    const type = String(r['類型'] || '概念'); const parent = String(r['建議上層'] || '');
    const warns = [];
    if (parent && byId[parent]) { const w = kgRelWarn_(pairs, defs, 'hasPart', String(byId[parent]['類型']), type); if (w) warns.push('上層：' + w); }
    if (rel && byId[rel.target]) { const w = kgRelWarn_(pairs, defs, rel.type, type, String(byId[rel.target]['類型'])); if (w) warns.push('建議關係：' + w); }
    return { id: String(r['候選ID']), name: String(r['名稱']), def: String(r['定義']), parent: parent, parentLabel: label(parent), type: type,
      rel: rel ? { type: rel.type, label: kgRelLabel_(defs, rel.type), target: rel.target, targetLabel: label(rel.target) || rel.target } : null,
      warns: warns, doc: docs[String(r['文件ID'])] || String(r['文件ID']), count: Number(r['次數'] || 1), reason: String(r['理由'] || ''), snippet: String(c.text || '').slice(0, 160) };
  }).sort((a, b) => b.count - a.count);
  const nodeTypes = {}; nodes.forEach(r => nodeTypes[String(r['節點ID'])] = String(r['類型']));
  return {
    stats: { nodes: nodes.filter(r => String(r['狀態'] || '啟用') !== '停用').length, edges: edges.length, sources: Math.max(0, sh_('kgSources').getLastRow() - 1),
      links: links.length, covered: list.filter(n => n.ok > 0).length, pending: cands.length },
    nodes: list, cands: cands, types: kgNewTypes_(defs), pairs: pairs, nodeTypes: nodeTypes,
  };
}

/** action：approve（opts 可改 name/def/parent/type）、merge（opts.target）、skip */
function adminCandAction(candId, action, opts) {
  const me = requireAdmin_(); opts = opts || {};
  const defs = kgDefs_();
  const r = rows_('kgCands').find(x => String(x['候選ID']) === String(candId));
  if (!r) throw new Error('找不到候選'); if (r['狀態'] !== '待審核') throw new Error('這個候選已處理過');
  const cs = sh_('kgCands'); const head = kgHead_('kgCands'); const C = h => head.indexOf(h) + 1;
  const now = new Date(); const chunkIds = String(r['段落ID'] || '').split(';').filter(Boolean);
  const nodes = kgNodes_(true); const byId = {}; nodes.forEach(n => byId[String(n['節點ID'])] = n);
  const lh = kgHead_('kgLinks'); const linkRow = (c, id, how) => { const o = { '段落ID': c, '節點ID': id, '方式': how, '時間': now, '標籤': KG_TAG_MAIN }; return lh.map(h => o[h] == null ? '' : o[h]); };
  let result = '';
  if (action === 'approve') {
    const name = String(opts.name || r['名稱']).trim(); if (!name) throw new Error('請填名稱');
    const type = String(opts.type || r['類型'] || '概念');
    if (kgNewTypes_(defs).indexOf(type) < 0) throw new Error('節點類型不正確（主軸不接受新增）');
    const parent = byId[opts.parent || r['建議上層']] ? String(opts.parent || r['建議上層']) : '';
    const id = 'n_' + Utilities.getUuid().slice(0, 8);
    const pathTxt = parent ? [String(byId[parent]['路徑'] || ''), String(byId[parent]['名稱'])].filter(Boolean).join(' > ') : '';
    append_('kgNodes', [[id, name, type, parent, pathTxt, String(opts.def != null ? opts.def : r['定義']), '', '', '', '啟用', KG_FROM_PROPOSAL, now]]);
    const edges = [];
    if (parent) edges.push([parent, 'hasPart', id, kgRelLabel_(defs, 'hasPart'), KG_FROM_PROPOSAL]);
    try { const rel = r['建議關係'] ? JSON.parse(r['建議關係']) : null; if (rel && byId[rel.target]) edges.push([id, rel.type, rel.target, kgRelLabel_(defs, rel.type), KG_FROM_PROPOSAL]); } catch (e) {}
    if (edges.length) append_('kgEdges', edges);
    if (chunkIds.length) append_('kgLinks', chunkIds.map(c => linkRow(c, id, '候選核可')));
    result = id;
  } else if (action === 'merge') {
    const t = byId[opts.target]; if (!t) throw new Error('請選擇要合併到的節點');
    const syn = String(t['同義說法'] || '').split('、').filter(Boolean); if (syn.indexOf(r['名稱']) < 0) syn.push(String(r['名稱']));
    sh_('kgNodes').getRange(t._row, kgHead_('kgNodes').indexOf('同義說法') + 1).setValue(syn.join('、'));
    if (chunkIds.length) append_('kgLinks', chunkIds.map(c => linkRow(c, String(opts.target), '候選合併')));
    result = String(opts.target);
  } else if (action !== 'skip') throw new Error('未知的操作');
  cs.getRange(r._row, C('狀態')).setValue(action === 'approve' ? '已核可' : action === 'merge' ? '已合併' : '略過');
  cs.getRange(r._row, C('處理結果')).setValue(result);
  cs.getRange(r._row, C('審核者')).setValue(me);
  cs.getRange(r._row, C('審核時間')).setValue(now);
  return { ok: true, result: result };
}
