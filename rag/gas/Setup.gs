/** 第一次使用：建立工作表與預設內容（已有資料的工作表不會被覆蓋） */

const SYSTEM_PROMPT_DEFAULT = [
  '你是陪伴學前融合教育老師的助手，協助老師面對班上有特殊需求幼兒的日常困難。',
  '【核心原則】',
  '- 以孩子此刻的需要為出發點，不推測診斷，不使用標籤化用語',
  '- 只根據提供的知識給建議，每條建議標註知識編號（K1、K2…）',
  '- 知識不足以回答時，直接說明，並建議可以詢問的專業人員',
  '- 先理解情境再給建議；建議要少而可立即執行（2–3 個）',
  '【轉介原則】',
  '- 超出你可以負責回答的範圍時，依轉介等級引導老師找到對的專人',
  '【回答通則】',
  '- 使用台灣繁體中文與幼教現場用語，語氣溫暖、具體、不說教',
  '- 先回應老師的感受，再進入建議',
  '- 依載入的 Skill 決定流程與輸出內容',
].join('\n');

const SKILLS_DEFAULT = [
  ['S01', '理解孩子', '情緒行為, 幼兒發展與參與', false,
    '何時使用：老師描述幼兒的行為、情緒、參與或學習困難。\n回答框架：\n1. 看見：把老師的描述轉成可觀察的事件（何時、何地、做了什麼）\n2. 理解：推想行為背後未被滿足的需要\n3. 支持：優先調整環境與作息\n4. 教會：教孩子用替代的方式表達\n先追問（資訊不足時最多兩題）：\n- 通常在什麼時段或情境發生？\n- 發生前發生了什麼事？之後怎麼結束？\n輸出：2–3 個立即可用的策略，列出接下來的觀察重點。\n禁止：推測診斷（如「可能是過動」）、標籤化用語（如「問題兒童」）。'],
  ['S02', '親師溝通', '親師溝通', false,
    '何時使用：牽涉家長，或老師想知道怎麼跟家長說。\n輸出：一段老師可以直接傳給家長的訊息草稿（80–150 字）：先說孩子的優點與觀察到的事實，再說明園方正在做的支持，最後邀請合作或約時間。\n禁止：診斷詞語、要求家長「管教」、責怪語氣。'],
  ['S03', '教師支持', '教師自我照顧', false,
    '何時使用：老師提到壓力、疲憊、自責、班級難以兼顧。\n輸出：肯定老師已經做的事，給一兩個具體可行的自我照顧或求援做法。\n禁止：說教、要求老師更努力。'],
  ['S04', '轉介與找專人', '', true,
    '一律啟用。依分流結果的轉介等級回應：\n- 需要專人：給暫時的安全做法，並在 referral 欄位明確說明這不能取代專人、該找誰\n- 建議諮詢：正常回答，在 referral 欄位簡短附上可以找誰\n- 無：referral 為 null\n不要把一般玩耍碰撞視為疑似受虐。'],
];

const REFERRAL_DEFAULT = [
  ['兒少保護', '園長，並依法向縣市社政主管機關通報', '113 保護專線', '依兒少權法，知悉後應立即通報，至遲不超過 24 小時；告知園長，記錄看到與聽到的事實；不要自行追問孩子細節或質問家長'],
  ['健康與醫療', '醫療人員、園內護理人員與家長', '緊急時撥 119', '先確保孩子安全，依園內緊急處理流程通知家長'],
  ['發展與特教判斷', '特教巡迴輔導老師、特教資源中心或早療評估單位', '請園長協助申請', '整理近期的觀察紀錄，作為諮詢與評估的資料'],
  ['法律與行政', '園長或行政主管', '', '保留相關紀錄與溝通內容'],
  ['親師衝突升高', '園長或主任', '', '先暫停個別溝通，請主管一起處理'],
  ['老師自身狀態', '主管、員工協助方案或心理專業人員', '安心專線 1925', '若有傷害自己的念頭，請立即撥打 1925 或告訴身邊信任的人'],
  ['系統能力不足', '園長、協同老師或專案特教團隊', '', '把狀況整理成文字，和團隊一起討論'],
];

// ---------- 可在後台修改的文字（程式只負責格式與流程，內容都在這裡和「設定」工作表） ----------
const TEXT_DEFAULTS = {
  triage_rules: [
    '轉介等級：',
    '- 緊急：現在就要找人，例如孩子自述被大人傷害、老師有傷害自己的念頭、正在發生的醫療狀況',
    '- 需要專人：這幾天內要找人，例如策略試了很久都無效、家長衝突升高',
    '- 建議諮詢：AI 可以回答，專人能幫更多',
    '一般玩耍碰撞或跌倒的瘀青、有合理說明的小傷，不屬於兒少保護。',
    '服務範圍：要求醫療診斷或與幼教無關，算超出範圍。',
    '資訊足夠：至少知道行為「在什麼情境或時段發生」或「發生前後的經過」其中一項；非常籠統時算不足。',
  ].join('\n'),
  followup_prompt: '老師的描述資訊不足。請先用一句話同理老師，再依 Skill 的追問清單提出最多 2 個最關鍵、好回答的追問。',
  answer_rules: 'strategies 2–3 個；每個策略的 refs 只能用上面提供的 K 編號，至少一個；不得推測診斷或使用標籤化用語；保留「幼兒A」等代稱。',
  check_prompt: [
    '逐項檢查回答：',
    '(1) 依據：每個策略是否大致能從它引用的知識推得；合理的實務延伸（例如把原則轉成具體做法）不算編造，只有知識完全沒提到、或與知識矛盾才算問題。',
    '(2) 轉介：老師描述中有明確需要專人的訊號（安全、疑似受虐、老師身心危機、長期無效）而回答完全沒提。',
    '(3) 語氣：說教、責怪老師或家長、或替孩子下診斷。老師自己提到的診斷名稱不算違規，只要回答沒有推測或確認診斷即可。',
    '嚴重（會擋下回答）只用在：編造或違反知識、遺漏需要專人的訊號、替孩子下診斷。其他都算小問題。',
  ].join('\n'),
  msg_no_knowledge: '謝謝你說出這個狀況。目前知識庫裡沒有足夠、經過檢查的內容可以給你具體建議。建議先和{who}討論，也可以申請特教巡迴輔導老師協助。',
  msg_check_failed: '謝謝你說出這個狀況。我整理出的建議沒有通過依據檢查，為了避免給你不夠可靠的內容，這次先不提供具體做法。建議先和{who}討論，也可以申請特教巡迴輔導老師協助。',
  msg_out_of_scope: '這個問題超出幼兒園教保現場的範圍，建議洽詢相關專業人員。如果是班上孩子的狀況，歡迎描述你看到的情境。',
};
/** 讀文字設定；設定表沒有這一項時用預設值 */
function text_(key) {
  const v = cfg_(key);
  return v == null || String(v).trim() === '' ? (TEXT_DEFAULTS[key] || '') : String(v);
}

const SETTINGS_DEFAULT = [
    ['bot_name', '融合教育小幫手', '老師端顯示的名稱'],
    ['welcome', '你好，我是融合教育小幫手。說說班上遇到的狀況，我會先了解情境，再給你幾個馬上能用的做法。', '老師端的歡迎訊息'],
    ['system_prompt', SYSTEM_PROMPT_DEFAULT, '固定 system prompt（第 1 層）'],
    ['model_triage', 'gemini-2.5-flash', 'L4 分流用模型'],
    ['model_answer', 'gemini-2.5-flash', 'A1 對話 Agent 用模型（也用於 PDF 轉文字）'],
    ['model_check', 'gemini-2.5-flash', 'L5 檢查用模型'],
    ['model_embed', 'gemini-embedding-001', '向量模型（更換後要重新向量化所有文件）'],
    ['embed_dim', 768, '向量維度'],
    ['temperature', 0.3, '生成溫度'],
    ['top_k', 6, '每次檢索取幾段'],
    ['min_score', 0.45, '相似度門檻，低於此值不採用'],
    ['chunk_size', 500, '切段長度（字）'],
    ['chunk_overlap', 80, '段落重疊（字）'],
    ['max_followups', 1, '最多追問幾輪'],
    ['enable_llm_check', true, '是否啟用 L5 依據與轉介檢查'],
    ['default_skill', '理解孩子', '沒有對應主題時預設載入的 Skill'],
    ['hourly_limit', 300, '每個邀請碼每小時呼叫上限'],
    ['triage_rules', TEXT_DEFAULTS.triage_rules, 'L4 分流規則：轉介等級怎麼判斷、什麼不算、資訊足夠的標準'],
    ['followup_prompt', TEXT_DEFAULTS.followup_prompt, '資訊不足時，追問要怎麼問'],
    ['answer_rules', TEXT_DEFAULTS.answer_rules, '回答的硬性規則（策略數量、出處、用語）'],
    ['check_prompt', TEXT_DEFAULTS.check_prompt, 'L5 依據與轉介檢查標準：檢查什麼、什麼算嚴重（嚴重才會擋下回答）'],
    ['msg_no_knowledge', TEXT_DEFAULTS.msg_no_knowledge, '知識庫查不到資料時的回覆；{who} 會換成轉介資源「系統能力不足」的對象'],
    ['msg_check_failed', TEXT_DEFAULTS.msg_check_failed, '回答沒通過檢查時的回覆；{who} 同上'],
    ['msg_out_of_scope', TEXT_DEFAULTS.msg_out_of_scope, '超出服務範圍時的回覆'],
];

/** 設定表已存在時，只補上缺少的設定項，不動已修改的值 */
function addMissingSettings_() {
  const s = sh_('settings');
  const have = s.getRange(1, 1, s.getLastRow(), 1).getValues().map(r => r[0]);
  const add = SETTINGS_DEFAULT.filter(r => have.indexOf(r[0]) < 0);
  if (add.length) s.getRange(s.getLastRow() + 1, 1, add.length, 3).setValues(add);
}

function setup() {
  const ss = ss_();
  const make = (name, head, seed) => {
    let s = ss.getSheetByName(name);
    if (!s) s = ss.insertSheet(name);
    if (s.getLastRow() === 0) {
      s.appendRow(head); s.setFrozenRows(1); s.getRange(1, 1, 1, head.length).setFontWeight('bold');
      if (seed && seed.length) s.getRange(2, 1, seed.length, head.length).setValues(seed);
    } else {
      // 舊版工作表補上新欄位：對話紀錄是依位置寫入，直接換成新標題；其他表把缺的欄位加在最後
      const cur = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
      const missing = head.filter(h => cur.indexOf(h) < 0);
      if (missing.length) {
        if (name === SHEETS.logs) s.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
        else s.getRange(1, cur.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
      }
    }
    return s;
  };
  make(SHEETS.settings, ['設定', '值', '說明'], SETTINGS_DEFAULT);
  addMissingSettings_();
  make(SHEETS.skills, ['Skill ID', '名稱', '對應主題', '一律載入', '內容', '啟用', '版本', '更新者', '更新時間'],
    SKILLS_DEFAULT.map(s => [s[0], s[1], s[2], s[3], s[4], true, 1, 'setup', new Date()]));
  make(SHEETS.skillHist, ['Skill ID', '版本', '名稱', '對應主題', '一律載入', '內容', '更新者', '更新時間'],
    SKILLS_DEFAULT.map(s => [s[0], 1, s[1], s[2], s[3], s[4], 'setup', new Date()]));
  make(SHEETS.docs, ['文件ID', '標題', '出處', '證據等級', '原始檔名', '段落數', '狀態', '上傳者', '上傳時間', '審核者', '審核時間']);
  make(SHEETS.chunks, ['段落ID', '文件ID', '序號', '內容', '頁碼', '向量', '狀態']);
  make(SHEETS.synonyms, ['老師用語', '對應概念'], [['丟', '攻擊行為'], ['推', '攻擊行為'], ['咬', '攻擊行為'], ['暴衝', '攻擊行為'], ['收拾', '轉銜時段'], ['換活動', '轉銜時段'], ['搶', '表達需求'], ['崩潰', '情緒調節'], ['回嘴', '口語對抗'], ['頂嘴', '口語對抗']]);
  make(SHEETS.forbidden, ['詞或規則', '類型', '說明'], [['過動', '詞', '不推測診斷'], ['ADHD', '詞', '不推測診斷'], ['自閉症', '詞', '不推測診斷'], ['亞斯', '詞', '不推測診斷'], ['問題兒童', '詞', '標籤化用語'], ['壞孩子', '詞', '標籤化用語'], ['故意找麻煩', '詞', '標籤化用語'], ['處罰', '詞', '不建議懲罰性做法'], ['懲罰', '詞', '不建議懲罰性做法'], ['吃藥', '詞', '不給醫療建議']]);
  make(SHEETS.referral, ['類別', '該找誰', '聯絡方式', '現在要做的事'], REFERRAL_DEFAULT);
  make(SHEETS.codes, ['邀請碼', '園所代號', '啟用', '觀測'], [['TEST-2026', '測試園', true, true]]);
  const me = Session.getActiveUser().getEmail();
  make(SHEETS.admins, ['Email', '備註'], me ? [[me, '建立者']] : []);
  make(SHEETS.logs, ['時間', 'Session', '園所', '輪次', '老師訊息（去識別化）', '分流', '轉介', '回應類型', '回答', '引用', '檢查', '是否重寫', '耗時ms', '檢索段數', '最高相似度', '被引用段數', '載入Skill', '流程紀錄']);
  make(SHEETS.feedback, ['時間', 'Session', '輪次', '類型', '備註']);
  make(SHEETS.evalset, ['測試問題', '應命中文件ID', '備註', '結果', '名次', '最高分', '命中段落', '測試時間']);
  const def = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
  clearCfgCache_();
}
