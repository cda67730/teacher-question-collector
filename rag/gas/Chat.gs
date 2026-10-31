/**
 * 線上回答流程（P04 對話狀態機）
 * P03 去識別化 → [L4 分流 ‖ P06 檢索向量] → P04 判斷 → P05 載入 Skill → P07 組裝 → A1 生成
 * → [P08 規則 ‖ P09 出處 ‖ L5 依據與轉介] → P10 組合與降級 → P15 紀錄
 */

// ---------- P03 去識別化（程式，不用 LLM） ----------
const NAME_SKIP = ['小朋', '小孩', '小班', '小組', '小時', '小心', '小事', '小動', '小便', '小肌', '小聲', '小小', '小點', '小任', '小步', '小卡', '小物', '小玩', '小型', '小學', '小姐', '小兒', '小禮', '小貼', '小椅', '小桌', '小籃', '小手', '小部', '小片', '小塊', '小幫'];
function deid_(text, map) {
  map = Object.assign({}, map || {});
  const labels = 'ABCDEFGHIJ';
  const out = String(text).replace(/小[一-鿿]/g, m => {
    if (NAME_SKIP.indexOf(m) >= 0) return m;
    if (!map[m]) map[m] = '幼兒' + labels[Object.keys(map).length % labels.length];
    return map[m];
  }).replace(/09\d{2}[-\s]?\d{3}[-\s]?\d{3}/g, '（電話已刪除）');
  return { text: out, map: map };
}

// ---------- L4 分流 prompt ----------
const INTENTS = ['新個案', '補充同一個案', '要求特定協助', '與幼教無關'];
function triagePrompt_(prevTeacher, latest, topics, categories) {
  // 規則文字在「設定」的 triage_rules，這裡只放選項清單與輸出格式
  return '你是學前融合教育 AI 系統的分流器，只輸出 JSON。依下列規則判斷：\n' + text_('triage_rules') + '\n\n' +
    '欄位：\n' +
    '- intent：老師「這一則訊息」的意圖，從 ' + JSON.stringify(INTENTS) + ' 選一個。新個案＝換了一個孩子或完全不同的狀況；補充同一個案＝回答追問或補充細節、說試過的結果；要求特定協助＝要家長訊息、觀察記錄、其他策略、找專人等具體東西；與幼教無關＝閒聊、算數、與帶班無關\n' +
    '- referral.category：從 ' + JSON.stringify(categories) + ' 選一個，或 "none"\n' +
    '- referral.level："緊急"、"需要專人"、"建議諮詢" 或 "none"；referral.reason 一句話\n' +
    '- topics：從 ' + JSON.stringify(topics) + ' 選出相關的（可多選）\n' +
    '- in_scope：是否屬於服務範圍\n' +
    '- info_enough：整個個案的資訊是否足夠\n' +
    '- missing：缺少的關鍵資訊（最多 2 項）\n' +
    '格式：{"intent":"新個案","referral":{"category":"none","level":"none","reason":""},"topics":[],"in_scope":true,"info_enough":true,"missing":[]}\n\n' +
    (prevTeacher.length ? '老師先前說過（已去識別化）：\n' + prevTeacher.join('\n') + '\n\n' : '') +
    '老師這一則訊息：\n' + latest;
}

function runChat_(req, opts) {
  opts = opts || {};
  const t0 = Date.now(), trace = [];
  // kind 讓觀測面板知道怎麼呈現：triage、retrieval、checks、skills、prompt、json、text
  const T = (step, detail, kind) => trace.push({ step: step, kind: kind || (typeof detail === 'string' ? 'text' : 'json'), detail: detail, ms: Date.now() - t0 });
  const metrics = { retrieved: null, top: null, cited: null, skills: [] };
  const C = cfgAll_();
  const maxFu = Number(C.max_followups == null ? 1 : C.max_followups);

  // 1. P03 去識別化
  const d = deid_(req.message || '', req.nameMap);
  const history = (req.history || []).slice(-8);
  const prevTeacher = history.filter(h => h.role === 'teacher').map(h => h.text);
  const fullCase = prevTeacher.concat([d.text]).join('\n');
  T('P03 去識別化', Object.keys(d.map).length ? JSON.stringify(d.map) : '沒有偵測到幼兒名字');

  // 2. L4 分流 ‖ P06 查詢向量（fetchAll 並行）；向量同時算「整段個案」與「只有最新訊息」，分流後再選用
  const skills = skills_();
  const topics = Array.from(new Set([].concat.apply([], skills.filter(s => !s.always).map(s => s.tags))));
  const refTable = referral_();
  const expAll = expandQuery_(fullCase), expNew = expandQuery_(d.text);
  const [triRes, embRes] = UrlFetchApp.fetchAll([
    genReq_(C.model_triage, [{ text: triagePrompt_(prevTeacher, d.text, topics, Object.keys(refTable)) }], { json: true, temperature: 0, noThink: true }),
    embedReqs_([expAll.text, expNew.text], 'RETRIEVAL_QUERY')[0],
  ]);
  const tri = parseJson_(genText_(triRes));
  const vecs = embedParse_(embRes);
  const ref = tri.referral && tri.referral.category && tri.referral.category !== 'none' && tri.referral.level && tri.referral.level !== 'none' ? tri.referral : null;
  T('L4 分流', tri, 'triage');

  // 意圖：新個案就只看這一則，舊的對話不帶進來；其他意圖延續整段個案
  const intent = INTENTS.indexOf(tri.intent) >= 0 ? tri.intent : (prevTeacher.length ? '補充同一個案' : '新個案');
  const isNew = intent === '新個案' || !prevTeacher.length;
  const caseText = isNew ? d.text : fullCase;
  const ctxHistory = isNew ? [] : history;
  const exp = isNew ? expNew : expAll, qvec = isNew ? vecs[1] : vecs[0];
  const answered = isNew ? 0 : Number(req.answered || 0);     // 這個個案已經給過幾次完整回答
  const fuDone = isNew ? 0 : Number(req.followups || 0);
  T('P06 同義詞擴充', exp.concepts.length ? exp.words.join('、') + ' → ' + exp.concepts.join('、') : '無');

  const base = { nameMap: d.map, deidText: d.text, triage: tri, metrics: metrics, intent: intent, newCase: isNew, answered: answered };
  const finish = (out) => {
    const res = Object.assign(base, out, { ms: Date.now() - t0 });
    try { logTurn_(req, res, trace); } catch (e) { console.warn(e); }
    if (opts.trace) res.trace = trace;
    return res;
  };

  // 3. P04 判斷
  if (ref && ref.level === '緊急') {
    T('P04 狀態機', '緊急轉介：' + ref.category + ' → 不走一般回答');
    const r = refTable[ref.category] || {};
    return finish({ type: 'referral', referral: { category: ref.category, level: ref.level, reason: ref.reason, who: r.who, contact: r.contact, now: r.now } });
  }
  if (intent === '與幼教無關' || tri.in_scope === false) {
    T('P04 狀態機', '超出服務範圍（' + intent + '）');
    return finish({ type: 'out_of_scope', message: text_('msg_out_of_scope') });
  }
  const pick = skills.filter(s => s.always || s.tags.some(t => (tri.topics || []).indexOf(t) >= 0));
  if (!pick.some(s => !s.always)) { const def = skills.find(s => s.name === C.default_skill); if (def) pick.push(def); }
  const sysPrompt = String(C.system_prompt || '');
  const noTopic = !pick.some(s => !s.always);   // 沒有對應的主題 Skill，且 default_skill 留空
  const skillText = pick.map(s => '【' + s.name + '】\n' + s.content).join('\n\n') +
    (noTopic ? (pick.length ? '\n\n' : '') + '（這題沒有對應的主題 Skill：依老師的問題本身與檢索到的知識直接回答，不必套用特定框架。）' : '');
  metrics.skills = pick.map(s => s.name);

  if (intent !== '要求特定協助' && !tri.info_enough && fuDone < maxFu) {
    T('P04 狀態機', '資訊不足 → 追問');
    T('P05 Skill 載入', pick.map(s => ({ name: s.name, version: s.version, always: s.always })), 'skills');
    const fu = genJson_(C.model_answer, sysPrompt + '\n\n' + skillText + '\n\n' + text_('followup_prompt') + '\n目前缺少：' + ((tri.missing || []).join('、') || '情境細節') +
      '\n只輸出 JSON：{"empathy":"","questions":["",""]}\n\n老師的描述：\n' + caseText, { temperature: 0.4, noThink: true });
    T('A1 追問', fu);
    return finish({ type: 'followup', empathy: str_(fu.empathy), questions: (fu.questions || []).map(str_).slice(0, 2), followups: fuDone + 1 });
  }

  // 前幾輪給完整回答；之後（或老師點選特定協助）改成「延續回覆」：只回應新內容，並提供下一步選項
  const fullRounds = Number(C.full_answer_rounds == null || C.full_answer_rounds === '' ? 2 : C.full_answer_rounds);
  const mode = intent === '要求特定協助' && !isNew ? 'continue' : (answered >= fullRounds ? 'continue' : 'full');
  T('P04 狀態機', intent + '｜' + (tri.info_enough ? '資訊足夠' : '已追問過') + '｜已完整回答 ' + answered + ' 次 → ' +
    (mode === 'full' ? '完整回答' : '延續回覆') + (ref ? '（附轉介：' + ref.category + '・' + ref.level + '）' : ''));
  T('P05 Skill 載入', pick.map(s => ({ name: s.name, version: s.version, always: s.always })), 'skills');

  // 4. P06 檢索
  const sd = searchDetail_(qvec, caseText, exp.concepts);
  const hits = sd.hits;
  metrics.retrieved = hits.length; metrics.top = sd.cands.length ? sd.cands[0].score : 0;
  T('P06 檢索', { minScore: sd.minScore, topK: sd.topK, total: sd.total, cands: sd.cands }, 'retrieval');
  if (!hits.length && mode === 'full') {
    T('P10 降級', '沒有可用知識 → 保守回答');
    return finish({ type: 'conservative', message: conservativeMsg_(refTable), sources: [] });
  }

  // 5. P07 組裝 + A1 生成，最多重寫一次
  const refWho = ref ? ((refTable[ref.category] || {}).who || '') : '';
  const range = mode === 'full' ? [2, 3] : [0, 2];
  let ans, chk, rewritten = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = mode === 'full'
      ? assemble_(sysPrompt, skillText, tri, caseText, hits, ctxHistory, ref, refWho, attempt ? chk.reasons : null)
      : assembleContinue_(sysPrompt, skillText, tri, prevTeacher, d.text, hits, ctxHistory, ref, refWho, intent, attempt ? chk.reasons : null);
    if (attempt === 0) T('P07 Prompt 組裝', { summary: (mode === 'full' ? '完整回答' : '延續回覆') + '｜固定 system prompt ' + sysPrompt.length + ' 字｜Skill ' + skillText.length + ' 字｜知識 ' + hits.length + ' 段｜歷史 ' + ctxHistory.length + ' 則｜共 ' + prompt.length + ' 字', prompt: prompt }, 'prompt');
    ans = cleanAnswer_(genJson_(C.model_answer, prompt, { temperature: Number(C.temperature || 0.3) }));
    T(attempt ? 'A1 重寫' : 'A1 生成', '策略 ' + (ans.strategies || []).length + ' 個');
    chk = checks_(caseText, ans, hits, C, range);
    T('檢查', chk.items, 'checks');
    if (chk.pass) break;
    rewritten = true;
  }
  if (!chk.pass) {
    T('P10 降級', '重寫後仍未通過 → 保守回答：' + chk.reasons.join('；'));
    return finish({ type: 'conservative', message: conservativeMsg_(refTable, 'check'), sources: [], checks: chk.items });
  }
  T('P10 組合', '檢查全部通過' + (rewritten ? '（重寫一次後）' : ''));
  const used = {}; (ans.strategies || []).forEach(s => (s.refs || []).forEach(r => used[r] = true));
  metrics.cited = Object.keys(used).filter(r => hits.some(h => h.ref === r)).length;
  metrics.usedRefs = Object.keys(used);
  const sources = hits.filter(h => used[h.ref]).map(h => ({ ref: h.ref, title: h.title, source: h.source, page: h.page, evidence: h.evidence, snippet: h.text.slice(0, 280) }));
  const referral = ref ? { category: ref.category, level: ref.level, who: refWho, contact: (refTable[ref.category] || {}).contact || '' } : null;
  if (mode === 'continue') {
    ans.options = (ans.options && ans.options.length ? ans.options : continueOptions_()).map(str_).filter(Boolean).slice(0, 4);
    return finish({ type: 'continue', answer: ans, sources: sources, referral: referral, checks: chk.items, rewritten: rewritten, answered: answered + 1 });
  }
  return finish({ type: 'answer', answer: ans, sources: sources, referral: referral, checks: chk.items, rewritten: rewritten, answered: answered + 1 });
}

// ---------- 回答清理：欄位一律轉成文字，去掉模型自己寫進內文的 (K1) ----------
function str_(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(str_).filter(Boolean).join('；');
  if (typeof v === 'object') return Object.keys(v).map(k => str_(v[k])).filter(Boolean).join('；');
  return String(v);
}
function stripRefs_(t) {
  return str_(t).replace(/\s*[（(\[【]\s*K\d+(\s*[,，、]\s*K\d+)*\s*[)）\]】]/g, '').replace(/\s*K\d+(\s*[,，、]\s*K\d+)*\s*$/g, '').trim();
}
function cleanAnswer_(a) {
  a = a || {};
  ['empathy', 'understanding', 'parent_message', 'teacher_care', 'referral', 'reply'].forEach(k => {
    if (a[k] == null || a[k] === 'null') a[k] = null; else a[k] = stripRefs_(a[k]) || null;
  });
  a.strategies = (a.strategies || []).map(s => ({ title: stripRefs_(s.title), how: stripRefs_(s.how), refs: (s.refs || []).map(String) }));
  a.observe = (a.observe || []).map(stripRefs_).filter(Boolean);
  if (a.options) a.options = [].concat(a.options).map(str_).filter(Boolean);
  return a;
}
function continueOptions_() {
  return text_('continue_options').split(/\n+/).map(s => s.replace(/^[-・\d.、\s]+/, '').trim()).filter(Boolean);
}

/** 延續回覆：已經給過完整建議，這次只回應新的內容或老師要的那件事 */
function assembleContinue_(sys, skillText, tri, prevTeacher, latest, hits, history, ref, refWho, intent, feedback) {
  const forbiddenWords = forbidden_().filter(f => !f.regex).map(f => f.rule);
  const hist = history.map(h => (h.role === 'teacher' ? '老師：' : '助手：') + h.text).join('\n');
  const kn = hits.map(h => h.ref + '｜' + h.title + (h.page ? '（第' + h.page + '頁）' : '') + '\n' + h.text).join('\n\n');
  return [
    '【1 固定 system prompt】\n' + sys,
    '【2 主題 Skill】\n' + skillText,
    '【3 對話到目前為止】\n' + (hist || '（無）'),
    '【4 老師這次說的】（' + intent + '）\n' + latest,
    kn ? '【5 檢索到的知識（只能引用這些，編號 K1…）】\n' + kn : '【5 檢索到的知識】這次沒有找到新的相關知識，不要給新的策略。',
    '【延續回覆的做法】\n' + text_('continue_prompt') + '\n可提供的下一步選項（挑 2–4 個最適合的，可改寫成符合情境的說法）：\n' + continueOptions_().map(o => '- ' + o).join('\n'),
    feedback ? '【重寫指示】上一版沒有通過檢查：' + feedback.join('；') + '。請修正後重寫。' : '',
    '輸出格式（只輸出 JSON，沒有內容的欄位填 null 或空陣列）：{"reply":"直接回應老師這次說的話","strategies":[{"title":"","how":"","refs":["K1"]}],"parent_message":null,"observe":[],"referral":' +
      (ref ? '"依「' + ref.level + '」簡短說明該找誰（可找：' + refWho + '）"' : 'null') + ',"options":["下一步選項"]}\n' +
      '規則：strategies 0–2 個，只放之前沒給過的新做法，每個都要有 refs；不要重複之前回答過的內容；不得推測診斷；保留「幼兒A」等代稱；refs 編號不要寫進文字裡。' +
      (forbiddenWords.length ? '不得出現這些詞：' + forbiddenWords.join('、') + '。' : ''),
  ].filter(Boolean).join('\n\n');
}

function assemble_(sys, skillText, tri, caseText, hits, history, ref, refWho, feedback) {
  const forbiddenWords = forbidden_().filter(f => !f.regex).map(f => f.rule);
  const hist = history.map(h => (h.role === 'teacher' ? '老師：' : '助手：') + h.text).join('\n');
  const kn = hits.map(h => h.ref + '｜' + h.title + (h.page ? '（第' + h.page + '頁）' : '') + '\n' + h.text).join('\n\n');
  return [
    '【1 固定 system prompt】\n' + sys,
    '【2 主題 Skill】\n' + skillText,
    '【3 情境資訊】\n分流結果：' + JSON.stringify(tri) + '\n老師原話（已去識別化）：\n' + caseText,
    '【4 檢索到的知識（只能引用這些，編號 K1…）】\n' + kn,
    hist ? '【5 對話歷史】\n' + hist : '',
    feedback ? '【重寫指示】上一版沒有通過檢查：' + feedback.join('；') + '。請修正後重寫。' : '',
    '輸出格式（只輸出 JSON）：{"empathy":"先回應老師感受的一兩句","understanding":"看見與理解：把行為轉成可觀察事件，推想背後的需要（兩三句）","strategies":[{"title":"策略名稱","how":"具體怎麼做（一兩句）","refs":["K1"]}],"parent_message":"若牽涉家長，給家長的訊息草稿，否則 null","observe":["接下來的觀察重點"],"teacher_care":"若老師提到壓力，一兩句自我照顧建議，否則 null","referral":' +
      (ref ? '"依「' + ref.level + '」說明為什麼需要、該找誰（可找：' + refWho + '）"' : 'null') + '}\n' +
      '規則：' + text_('answer_rules') +
      (forbiddenWords.length ? '回答中不得出現這些詞（即使是否定句也不要寫）：' + forbiddenWords.join('、') + '。' : ''),
  ].filter(Boolean).join('\n\n');
}

// ---------- 檢查：P08 規則、P09 出處、L5 依據與轉介 ----------
function checks_(caseText, ans, hits, C, range) {
  range = range || [2, 3];
  const items = [], reasons = [];
  const s = JSON.stringify(ans);
  const bad = forbidden_().find(f => f.regex ? new RegExp(f.rule).test(s) : s.indexOf(f.rule) >= 0);
  items.push({ name: 'P08 規則檢查', pass: !bad, note: bad ? '出現禁止用語「' + bad.rule + '」' : '沒有禁止用語' });
  if (bad) reasons.push('不可使用「' + bad.rule + '」' + (bad.note ? '（' + bad.note + '）' : ''));
  const ok = {}; hits.forEach(h => ok[h.ref] = true);
  const st = ans.strategies || []; const p9 = [];
  if (st.length < range[0] || st.length > range[1]) p9.push('策略數量 ' + st.length + ' 個，應為 ' + range[0] + '–' + range[1] + ' 個');
  st.forEach(x => { if (!(x.refs || []).length) p9.push('「' + x.title + '」沒有出處'); (x.refs || []).forEach(r => { if (!ok[r]) p9.push(r + ' 不在檢索結果中'); }); });
  items.push({ name: 'P09 出處核對', pass: !p9.length, note: p9.join('；') || (st.length ? '每條建議都有出處' : '沒有新策略') });
  reasons.push.apply(reasons, p9);
  if (truthy_(C.enable_llm_check)) {
    try {
      const kn = hits.map(h => h.ref + '：' + h.text).join('\n');
      // 檢查標準在「設定」的 check_prompt，這裡只放輸出格式
      const l5 = genJson_(C.model_check, '你是學前融合教育 AI 回答的審查器，只輸出 JSON。\n' + text_('check_prompt') + '\n' +
        '每個問題的 severe：符合上面「嚴重」的定義為 true，其他為 false。\n' +
        '格式：{"issues":[{"type":"依據|轉介|語氣","severe":false,"note":"一句話說明問題"}]}，沒有問題就回 {"issues":[]}\n\n' +
        '老師描述：\n' + caseText + '\n\n知識：\n' + kn + '\n\n回答：\n' + s, { temperature: 0, noThink: true });
      // 模型可能回字串或物件，一律轉成「類型：說明」文字
      const issues = (l5.issues || []).map(x => typeof x === 'string' ? { type: '', severe: true, note: x }
        : { type: x.type || '', severe: x.severe !== false, note: x.note || x.issue || x.reason || x.description || JSON.stringify(x) });
      const severe = issues.filter(i => i.severe);
      const txt = i => (i.type ? i.type + '：' : '') + i.note;
      const pass = !severe.length;
      items.push({ name: 'L5 依據與轉介', pass: pass,
        note: !issues.length ? '有依據、無遺漏轉介' : (pass ? '小問題（不擋）：' : '') + issues.map(i => (i.severe ? '【嚴重】' : '') + txt(i)).join('；') });
      if (!pass) reasons.push.apply(reasons, severe.length ? severe.map(txt) : ['依據或轉介有問題']);
    } catch (e) { items.push({ name: 'L5 依據與轉介', pass: true, note: '檢查未完成（略過）：' + e.message }); }
  }
  return { pass: items.every(i => i.pass), items: items, reasons: reasons };
}

function conservativeMsg_(refTable, why) {
  const r = refTable['系統能力不足'] || {};
  return text_(why === 'check' ? 'msg_check_failed' : 'msg_no_knowledge').split('{who}').join(r.who || '園長或協同老師');
}

// ---------- P15 紀錄 ----------
function logTurn_(req, res, trace) {
  const m = res.metrics || {};
  // 紀錄不存完整 prompt（太長），段落只留前 300 字
  const tr = JSON.stringify(trace, (k, v) => k === 'prompt' ? undefined : v);
  const turn = req.turn || Math.floor((req.history || []).length / 2) + 1;
  append_('logs', [[new Date(), req.session || '', req.school || '', turn, res.deidText || '',
    JSON.stringify(res.triage || {}), res.referral ? res.referral.category + '・' + res.referral.level : '',
    res.type, JSON.stringify(res.answer || res.questions || res.message || ''), (res.sources || []).map(s => s.ref + ':' + s.title).join('｜'),
    JSON.stringify(res.checks || []), res.rewritten ? '是' : '否', res.ms || '',
    m.retrieved == null ? '' : m.retrieved, m.top == null ? '' : m.top, m.cited == null ? '' : m.cited, (m.skills || []).join('、'),
    tr.length > 48000 ? JSON.stringify(trace.map(t => ({ step: t.step, kind: 'text', detail: '（內容過長未保存）', ms: t.ms }))) : tr]]);
}
