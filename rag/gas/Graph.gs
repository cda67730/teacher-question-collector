/**
 * 知識圖譜：當架構用（內容靠上傳的文件）
 *  - 匯入：後台上傳 knowledge-graph.json → 節點、關係、來源三張表
 *  - 上傳文件時：AI 把每段對應到既有節點（掛接），現有節點不夠時提出「新節點候選」
 *  - 專家在後台審核候選：核可（新增節點）、合併到既有節點、略過
 *  - 覆蓋度：每個節點掛了幾段文件、幾段已核可、幾段是具體做法
 * 目前回答流程不讀圖譜（之後第 3 步才接）。
 */

const KG_FROM_IMPORT = '知識圖譜匯入', KG_FROM_PROPOSAL = '文件提案';
const KG_REL_TYPES = ['hasPart', 'appliedIn', 'correspondsTo', 'supports', 'hasStrategy', 'theoreticalBasisFor', 'influences', 'precedes', 'regulates', 'informs', 'relatedTo'];
const KG_REL_LABEL = { hasPart: '包含', appliedIn: '應用於', correspondsTo: '對應', supports: '支持', hasStrategy: '可用策略', theoreticalBasisFor: '理論基礎', influences: '影響', precedes: '後續為', regulates: '規範', informs: '提供資訊', relatedTo: '相關' };
const KG_NODE_TYPES = ['概念', '實務策略', '理論', '障礙與需求類別', '法規課綱', '課程取向', '子分類'];

function kgHasGraph_() { try { return sh_('kgNodes').getLastRow() > 1; } catch (e) { return false; } }
function kgNodes_(includeOff) { return rows_('kgNodes').filter(r => includeOff || String(r['狀態'] || '啟用') !== '停用'); }

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

// ---------- 匯入 ----------
/** 匯入 knowledge-graph.json；只取代「知識圖譜匯入」來的節點與關係，文件提案新增的節點保留 */
function adminImportKG(jsonText) {
  const me = requireAdmin_();
  let d; try { d = JSON.parse(String(jsonText || '').replace(/^﻿/, '')); } catch (e) { throw new Error('檔案不是有效的 JSON'); }
  if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) throw new Error('找不到 nodes 或 edges，請上傳 knowledge-graph.json');
  const ver = KG_FROM_IMPORT + ' v' + ((d.meta && d.meta.version) || '');
  const now = new Date();
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
  return { nodes: addNodes.length, kept: keepNodes.length, edges: addEdges.length, sources: addSrc.length, by: me };
}

// ---------- 上傳文件時：對應節點、提出新節點 ----------
function kgNodeList_() {
  return kgNodes_().map(r => String(r['節點ID']) + '｜' + r['名稱'] + (r['同義說法'] ? '（' + r['同義說法'] + '）' : '') + '｜' + String(r['路徑'] || '').split(' > ').slice(-1)[0]).join('\n');
}

/** chunks：[{id, text}]；回傳 {links:[[段落ID, 節點ID]], cands:[{name, definition, parent, type, relation, reason, chunkId}]} */
function kgMapChunks_(title, chunks) {
  const nodes = kgNodes_(); const valid = {}; nodes.forEach(r => valid[String(r['節點ID'])] = true);
  const list = kgNodeList_(); const links = [], cands = [];
  for (let i = 0; i < chunks.length; i += 12) {
    const group = chunks.slice(i, i + 12);
    try {
      const r = genJson_(cfg_('model_triage'), '你在替幼教知識文件做節點標註，只輸出 JSON。\n' +
        '下面是知識圖譜的節點清單（ID｜名稱｜所屬分類）。為每一段選出它「實際在談」的節點 1–4 個，只能用清單裡的 ID；只是順帶提到的不要選。\n' +
        '只有當某段的主要內容在清單裡找不到合適節點時，才在 new 提出新節點：name（簡短名稱）、definition（一句話）、parent（最適合的上層節點 ID）、' +
        'type（從 ' + JSON.stringify(KG_NODE_TYPES) + ' 選）、relation（與某個既有節點的關係，type 從 ' + JSON.stringify(KG_REL_TYPES) + ' 選，target 為節點 ID，可省略）、reason（為什麼現有節點不夠）。\n' +
        '格式：{"items":[{"chunk":1,"nodes":["id"],"new":[]}]}\n\n節點清單：\n' + list + '\n\n文件標題：' + title + '\n\n' +
        group.map((c, j) => '【段落' + (j + 1) + '】\n' + String(c.text).slice(0, 700)).join('\n\n'), { temperature: 0, noThink: true });
      (r.items || []).forEach(it => {
        const c = group[Number(it.chunk) - 1]; if (!c) return;
        Array.from(new Set(it.nodes || [])).filter(id => valid[id]).slice(0, 4).forEach(id => links.push([c.id, id]));
        (it.new || []).forEach(n => { if (n && n.name) cands.push(Object.assign({ chunkId: c.id }, n)); });
      });
    } catch (e) { console.warn('節點對應失敗', e); }
  }
  return { links: links, cands: cands };
}

/** 寫入掛接與候選；候選名稱和既有節點相同就直接掛上，和待審候選相同就累加次數 */
function kgSaveMapping_(docId, res) {
  const now = new Date();
  const nodes = kgNodes_(); const byName = {};
  nodes.forEach(r => { byName[String(r['名稱']).trim()] = String(r['節點ID']); String(r['同義說法'] || '').split(/[、,，]/).map(x => x.trim()).filter(Boolean).forEach(x => byName[x] = String(r['節點ID'])); });
  const valid = {}; nodes.forEach(r => valid[String(r['節點ID'])] = true);
  const links = res.links.slice();
  const cs = sh_('kgCands'); const head = cs.getRange(1, 1, 1, cs.getLastColumn()).getValues()[0]; const C = h => head.indexOf(h) + 1;
  const pending = rows_('kgCands').filter(r => r['狀態'] === '待審核');
  let added = 0, merged = 0;
  res.cands.forEach(n => {
    const name = String(n.name).trim().slice(0, 40);
    if (byName[name]) { links.push([n.chunkId, byName[name]]); return; }
    const p = pending.find(r => String(r['名稱']).trim() === name);
    if (p) {
      const ids = String(p['段落ID'] || '').split(';').filter(Boolean); if (ids.indexOf(n.chunkId) < 0) ids.push(n.chunkId);
      p['段落ID'] = ids.join(';'); p['次數'] = Number(p['次數'] || 1) + 1;
      cs.getRange(p._row, C('段落ID')).setValue(p['段落ID']); cs.getRange(p._row, C('次數')).setValue(p['次數']); merged++; return;
    }
    const rel = n.relation && KG_REL_TYPES.indexOf(n.relation.type) >= 0 && valid[n.relation.target] ? JSON.stringify({ type: n.relation.type, target: n.relation.target }) : '';
    const row = ['C' + Utilities.getUuid().slice(0, 8), name, String(n.definition || '').slice(0, 200), valid[n.parent] ? n.parent : '', KG_NODE_TYPES.indexOf(n.type) >= 0 ? n.type : '概念',
      rel, docId, n.chunkId, 1, String(n.reason || '').slice(0, 200), '待審核', '', '', ''];
    append_('kgCands', [row]);
    pending.push({ _row: cs.getLastRow(), '名稱': name, '段落ID': n.chunkId, '次數': 1, '狀態': '待審核' });
    added++;
  });
  const uniq = {}; const rows = [];
  links.forEach(l => { const k = l[0] + '|' + l[1]; if (!uniq[k]) { uniq[k] = 1; rows.push([l[0], l[1], 'AI', now]); } });
  if (rows.length) append_('kgLinks', rows);
  return { links: rows.length, candidates: added, candidateHits: merged };
}

/** 對應一份文件中還沒有掛接的段落 */
function kgMapDocument_(docId) {
  if (!kgHasGraph_()) return { skipped: '尚未匯入知識圖譜' };
  const done = {}; rows_('kgLinks').forEach(r => done[String(r['段落ID'])] = true);
  const doc = rows_('docs').find(r => String(r['文件ID']) === String(docId)) || {};
  const chunks = rows_('chunks').filter(r => String(r['文件ID']) === String(docId) && !done[String(r['段落ID'])]).map(r => ({ id: String(r['段落ID']), text: String(r['內容']) }));
  if (!chunks.length) return { links: 0, candidates: 0, candidateHits: 0 };
  return kgSaveMapping_(docId, kgMapChunks_(String(doc['標題'] || ''), chunks));
}
function adminMapDoc(docId) { requireAdmin_(); return kgMapDocument_(docId); }

// ---------- 後台：總覽、覆蓋度、候選 ----------
function adminGraphLoad() {
  requireAdmin_();
  if (!kgHasGraph_()) return { empty: true };
  const nodes = kgNodes_(true), edges = rows_('kgEdges'), links = rows_('kgLinks');
  const chunk = {}; rows_('chunks').forEach(r => chunk[String(r['段落ID'])] = { status: String(r['狀態']), type: String(r['類型'] || ''), docId: String(r['文件ID']), text: String(r['內容']) });
  const docs = {}; rows_('docs').forEach(r => docs[String(r['文件ID'])] = String(r['標題']));
  const cov = {};
  links.forEach(l => {
    const c = chunk[String(l['段落ID'])]; if (!c) return;
    const k = String(l['節點ID']); const o = cov[k] || (cov[k] = { all: 0, ok: 0, act: 0 });
    o.all++; if (c.status === '已核可') { o.ok++; if (ACTIONABLE.indexOf(c.type) >= 0) o.act++; }
  });
  const label = {}; nodes.forEach(r => label[String(r['節點ID'])] = String(r['名稱']));
  const list = nodes.map(r => { const k = String(r['節點ID']); const o = cov[k] || { all: 0, ok: 0, act: 0 };
    return { id: k, label: String(r['名稱']), type: String(r['類型']), path: String(r['路徑'] || ''), status: String(r['狀態'] || '啟用'), from: String(r['來源'] || ''), syn: String(r['同義說法'] || ''), all: o.all, ok: o.ok, act: o.act }; });
  const cands = rows_('kgCands').filter(r => r['狀態'] === '待審核').map(r => {
    const ids = String(r['段落ID'] || '').split(';').filter(Boolean); const c = chunk[ids[0]] || {};
    let rel = null; try { rel = r['建議關係'] ? JSON.parse(r['建議關係']) : null; } catch (e) {}
    return { id: String(r['候選ID']), name: String(r['名稱']), def: String(r['定義']), parent: String(r['建議上層'] || ''), parentLabel: label[String(r['建議上層'])] || '', type: String(r['類型'] || '概念'),
      rel: rel ? { type: rel.type, label: KG_REL_LABEL[rel.type] || rel.type, target: rel.target, targetLabel: label[rel.target] || rel.target } : null,
      doc: docs[String(r['文件ID'])] || String(r['文件ID']), count: Number(r['次數'] || 1), reason: String(r['理由'] || ''), snippet: String(c.text || '').slice(0, 160) };
  }).sort((a, b) => b.count - a.count);
  return {
    stats: { nodes: nodes.filter(r => String(r['狀態'] || '啟用') !== '停用').length, edges: edges.length, sources: Math.max(0, sh_('kgSources').getLastRow() - 1),
      links: links.length, covered: list.filter(n => n.ok > 0).length, pending: cands.length },
    nodes: list, cands: cands,
  };
}

/** action：approve（opts 可改 name/def/parent/type）、merge（opts.target）、skip */
function adminCandAction(candId, action, opts) {
  const me = requireAdmin_(); opts = opts || {};
  const r = rows_('kgCands').find(x => String(x['候選ID']) === String(candId));
  if (!r) throw new Error('找不到候選'); if (r['狀態'] !== '待審核') throw new Error('這個候選已處理過');
  const cs = sh_('kgCands'); const head = cs.getRange(1, 1, 1, cs.getLastColumn()).getValues()[0]; const C = h => head.indexOf(h) + 1;
  const now = new Date(); const chunkIds = String(r['段落ID'] || '').split(';').filter(Boolean);
  const nodes = kgNodes_(true); const byId = {}; nodes.forEach(n => byId[String(n['節點ID'])] = n);
  let result = '';
  if (action === 'approve') {
    const name = String(opts.name || r['名稱']).trim(); if (!name) throw new Error('請填名稱');
    const parent = byId[opts.parent || r['建議上層']] ? String(opts.parent || r['建議上層']) : '';
    const id = 'n_' + Utilities.getUuid().slice(0, 8);
    const pathTxt = parent ? [String(byId[parent]['路徑'] || ''), String(byId[parent]['名稱'])].filter(Boolean).join(' > ') : '';
    append_('kgNodes', [[id, name, opts.type || r['類型'] || '概念', parent, pathTxt, String(opts.def != null ? opts.def : r['定義']), '', '', '', '啟用', KG_FROM_PROPOSAL, now]]);
    const edges = [];
    if (parent) edges.push([parent, 'hasPart', id, '包含', KG_FROM_PROPOSAL]);
    try { const rel = r['建議關係'] ? JSON.parse(r['建議關係']) : null; if (rel && byId[rel.target]) edges.push([id, rel.type, rel.target, KG_REL_LABEL[rel.type] || '', KG_FROM_PROPOSAL]); } catch (e) {}
    if (edges.length) append_('kgEdges', edges);
    if (chunkIds.length) append_('kgLinks', chunkIds.map(c => [c, id, '候選核可', now]));
    result = id;
  } else if (action === 'merge') {
    const t = byId[opts.target]; if (!t) throw new Error('請選擇要合併到的節點');
    const syn = String(t['同義說法'] || '').split('、').filter(Boolean); if (syn.indexOf(r['名稱']) < 0) syn.push(String(r['名稱']));
    sh_('kgNodes').getRange(t._row, sh_('kgNodes').getRange(1, 1, 1, sh_('kgNodes').getLastColumn()).getValues()[0].indexOf('同義說法') + 1).setValue(syn.join('、'));
    if (chunkIds.length) append_('kgLinks', chunkIds.map(c => [c, String(opts.target), '候選合併', now]));
    result = String(opts.target);
  } else if (action !== 'skip') throw new Error('未知的操作');
  cs.getRange(r._row, C('狀態')).setValue(action === 'approve' ? '已核可' : action === 'merge' ? '已合併' : '略過');
  cs.getRange(r._row, C('處理結果')).setValue(result);
  cs.getRange(r._row, C('審核者')).setValue(me);
  cs.getRange(r._row, C('審核時間')).setValue(now);
  return { ok: true, result: result };
}
