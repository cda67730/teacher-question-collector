# 幼兒園現場問題收集（Teacher Question Collector）

學前融合教育 AI 教師支持系統第一階段：收集幼兒園老師在現場遇到的真實問題。
老師可以**錄音**或**打字**回答，錄音會轉成文字讓老師確認；情境不清楚時 AI 會追問一兩句；送出前自動去識別化，寫入 Google 試算表。

```
GitHub Pages（前端，免費）  ──POST──▶  Google Apps Script（後端，免費）  ──▶  Gemini（轉文字、追問、去識別化）
     web/                                   gas/Code.gs                         └─▶  Google 試算表（只存文字）
```

## 隱私設計

- 錄音只在後端記憶體中轉成文字，**不寫入任何儲存空間**。
- 寫入試算表前，孩子、家長、同事的名字會換成代稱（LLM 處理，失敗時用規則）。
- 不收集老師姓名或聯絡方式；背景資料只有縣市、地區、年資、園所類型、班級型態。
- 每所園所一組邀請碼，並限制每小時呼叫次數，避免被濫用或灌爆額度。
- **建議使用 Gemini API 付費方案**：免費方案的資料可能被用於改善 Google 產品。

## 部署步驟

### 1. 後端：Google Apps Script

1. 建立一個新的 Google 試算表（研究資料會存在這裡），選單「擴充功能 → Apps Script」。
2. 把 `gas/Code.gs` 的內容貼進編輯器；在「專案設定」勾選「在編輯器中顯示 appsscript.json」，再把 `gas/appsscript.json` 貼上。
3. 「專案設定 → 指令碼屬性」新增：
   | 屬性 | 值 |
   | --- | --- |
   | `GEMINI_API_KEY` | 你的 Gemini API 金鑰（到 Google AI Studio 申請） |
   | `GEMINI_MODEL` | 選填，預設 `gemini-2.5-flash`，可換成目前可用的 Flash 模型 |
   | `HOURLY_LIMIT` | 選填，每個邀請碼每小時上限，預設 300 |
4. 在編輯器選擇 `setup` 函式並執行，授權後會建立「回答」與「邀請碼」兩個工作表（含測試碼 `TEST-2026`）。
5. 右上角「部署 → 新增部署作業 → 網頁應用程式」：執行身分選「我」，存取權選「所有人」。複製以 `/exec` 結尾的網址。

### 2. 前端：GitHub Pages

1. 把網址貼到 `web/config.js` 的 `GAS_URL`，commit 並 push 到 `main`。
2. Repo 的「Settings → Pages → Build and deployment」選 **GitHub Actions**。
3. Push 後 Actions 會自動部署，網址會顯示在 Actions 的執行結果裡（`https://<帳號>.github.io/<repo>/`）。

> 私人 repo 要用 GitHub Pages 需要付費方案；若是免費帳號，可以把 repo 設為公開（程式碼裡沒有金鑰，金鑰只在 Apps Script 的指令碼屬性中）。

### 3. 測試

1. 用手機或電腦打開網址，輸入邀請碼 `TEST-2026`。
2. 每一題試一次錄音、一次打字，確認轉文字與追問正常。
3. 到試算表的「回答」工作表確認資料已寫入、名字已換成代稱。
4. 正式發送前，到「邀請碼」工作表把 `TEST-2026` 的啟用改成 `FALSE`，並為每所園所新增一組邀請碼。

## 修改題目

題目、提示文字、錄音長度上限都在 `web/config.js`，改完 push 即可，不需要動後端。

## 成本粗估

| 項目 | 費用 |
| --- | --- |
| GitHub Pages、Apps Script、試算表 | 免費 |
| Gemini（轉文字、追問、去識別化） | 300 位老師 × 3 題約幾美元以內（以官方最新價格為準） |

## 已知限制

- Apps Script 網頁應用程式每次呼叫約需 1–3 秒啟動，轉文字一段 3 分鐘的錄音約需 10–30 秒。
- Apps Script 每日 URL 呼叫配額有上限（一般帳號每日 2 萬次），本收集規模遠低於此。
- 音檔大小上限約 15 MB（3 分鐘錄音約 0.5–1 MB）。
