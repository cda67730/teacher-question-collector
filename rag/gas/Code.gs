/**
 * 學前融合教育 AI 教師支持系統：RAG 回答後端（示範版）
 *
 * 指令碼屬性：GEMINI_API_KEY（必填）、SHEET_ID（選填，不填用綁定的試算表）
 * 其他設定（模型、system prompt、檢索參數）都在「設定」工作表或後台修改。
 * 第一次使用請執行 setup()；後台從試算表選單「AI 助手後台」開啟。
 */

function doGet() { return json_({ ok: true, service: 'inclusive-ed-rag' }); }

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const info = codeInfo_(req.code);
    if (!info) return json_({ ok: false, error: '邀請碼不正確或已停用' });
    const school = info.school;
    if (!rateOk_(req.code)) return json_({ ok: false, error: '使用次數過多，請稍後再試' });
    req.school = school;
    switch (req.action) {
      case 'check': return json_({ ok: true, botName: cfg_('bot_name') || '融合教育小幫手', welcome: cfg_('welcome') || '', trace: info.trace });
      case 'chat':
        if (!String(req.message || '').trim()) return json_({ ok: false, error: '請輸入內容' });
        return json_(Object.assign({ ok: true }, runChat_(req, { trace: info.trace })));
      case 'feedback':
        append_('feedback', [[new Date(), req.session || '', req.turn || '', req.kind || '', String(req.note || '').slice(0, 500)]]);
        return json_({ ok: true });
      default: return json_({ ok: false, error: '未知的操作' });
    }
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: '伺服器發生錯誤（' + String(err && err.message || err).slice(0, 160) + '）' });
  }
}

function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
