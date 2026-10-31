(() => {
  const C = window.APP_CONFIG;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const DRAFT_KEY = "tqc-draft-v3";
  const ADD_TEXT = "還有其他想分享、希望有人一起想辦法的狀況嗎？";
  const ADD_HINT = "可以是任何帶班時遇到的事：孩子、家長、同事、環境都可以。";

  // items：每一題一筆；idx：目前那一題；returnToReview：從確認頁點「修改」進來的
  const state = { code: "", bg: null, items: [], idx: 0, returnToReview: false };

  const newItem = (q, extra) => ({
    qid: q.id, question: q.text, hint: q.hint || "", extra: !!extra,
    answer: "", transcript: "", voice: false, skipped: false,
    followups: [], fuAsked: false, followupAnswer: "",
    child: q.child === true ? true : q.child === "ask" ? "ask" : false,   // 這題是否要填孩子資料
    childOn: q.child === true,
    slots: { ageY: "", ageM: "", sits: [], tried: "", notTried: false, result: "" },
  });

  // ---------- 共用 ----------
  function show(id) {
    ["s-code", "s-q", "s-review", "s-done"].forEach((s) => ($(s).hidden = s !== id));
    const total = state.items.length + 2;
    const step = id === "s-code" ? 0 : id === "s-q" ? 1 + state.idx : id === "s-review" ? total - 1 : total;
    $("bar").style.width = Math.round((step / total) * 100) + "%";
    $("stepLabel").textContent =
      id === "s-code" ? "第 1 步：邀請碼與班級資料" :
      id === "s-q" ? `第 2 步：分享你的問題（${state.idx + 1}／${state.items.length}）` :
      id === "s-review" ? "第 3 步：確認後送出" : "";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  async function api(action, payload) {
    if (!C.GAS_URL || C.GAS_URL.includes("請替換")) throw new Error("尚未設定後端網址（config.js 的 GAS_URL）");
    const res = await fetch(C.GAS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // 避免 CORS 預檢
      body: JSON.stringify(Object.assign({ action, code: state.code }, payload || {})),
    });
    const data = await res.json().catch(() => ({ ok: false, error: "伺服器回應無法解析" }));
    if (!data.ok) throw new Error(data.error || "發生錯誤，請稍後再試");
    return data;
  }
  function saveDraft() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ code: state.code, items: state.items, idx: state.idx })); } catch (e) {}
  }
  function loadDraft() {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch (e) { return null; }
  }
  function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) {} }

  // ---------- 錄音工具 ----------
  function pickMime() {
    const list = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    return list.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
  }
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1]);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }
  // 瀏覽器錄的是 webm/mp4，轉成 16kHz 單聲道 WAV 再送出（3 分鐘約 5.8 MB）
  async function toWav(blob) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    ctx.close && ctx.close();
    const rate = 16000, len = Math.ceil(decoded.duration * rate);
    const off = new OfflineAudioContext(1, len, rate);
    const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
    const pcm = (await off.startRendering()).getChannelData(0);
    const buf = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, "data"); v.setUint32(40, pcm.length * 2, true);
    for (let i = 0, o = 44; i < pcm.length; i++, o += 2) { const s = Math.max(-1, Math.min(1, pcm[i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    return new Blob([buf], { type: "audio/wav" });
  }
  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  // ---------- 錄音覆蓋視窗：按下就開始錄，按停止 → 轉文字 → 填回欄位 → 關閉 ----------
  const Rec = (() => {
    let rec = null, stream = null, chunks = [], timer = null, secs = 0, actx = null, raf = 0;
    let target = null, onText = null, cancelled = false, busy = false, lastFocus = null;

    function ui(mode, msg) {
      // mode：rec 錄音中／busy 轉文字中／err 出錯
      $("rec-title").textContent = mode === "rec" ? "錄音中" : mode === "busy" ? "正在轉成文字…" : "沒有成功";
      $("rec-dot").className = "rec-dot " + (mode === "rec" ? "on" : mode === "busy" ? "busy" : "");
      $("rec-msg").textContent = msg;
      $("rec-stop").hidden = mode !== "rec";
      $("rec-cancel").textContent = mode === "err" ? "關閉" : "取消";
      $("rec-cancel").disabled = mode === "busy";
    }
    function cleanup() {
      clearInterval(timer); cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (actx && actx.close) actx.close();
      stream = null; actx = null;
      $("rec-level").style.width = "0";
    }
    function close() {
      cleanup(); busy = false;
      $("rec").hidden = true; document.body.style.overflow = "";
      lastFocus && lastFocus.focus();
    }
    function meter() {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        actx = new Ctx();
        const an = actx.createAnalyser(); an.fftSize = 512;
        actx.createMediaStreamSource(stream).connect(an);
        const data = new Uint8Array(an.fftSize);
        const tick = () => {
          an.getByteTimeDomainData(data);
          let peak = 0; for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128));
          $("rec-level").style.width = Math.min(100, peak * 1.6) + "%";
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) { /* 音量條只是輔助，失敗不影響錄音 */ }
    }
    async function open(opts) {
      target = opts.target; onText = opts.onText; cancelled = false; lastFocus = document.activeElement;
      $("rec-q").textContent = opts.label || "";
      $("rec-time").textContent = "0:00";
      $("rec-left").textContent = `最長 ${Math.round(C.MAX_RECORD_SECONDS / 60)} 分鐘`;
      $("rec").hidden = false; document.body.style.overflow = "hidden";
      if (!navigator.mediaDevices || !window.MediaRecorder) return ui("err", "這個瀏覽器不支援錄音，請直接打字。");
      ui("busy", "正在開啟麥克風…"); $("rec-title").textContent = "準備中";
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
      catch (e) { return ui("err", "無法使用麥克風。請確認瀏覽器已允許使用麥克風，或直接打字。"); }
      if (cancelled) return cleanup();
      const mimeType = pickMime();
      rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 24000 } : undefined);
      chunks = []; secs = 0;
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = onStop;
      rec.start(1000);
      meter();
      ui("rec", "說完請按「停止並轉文字」");
      $("rec-stop").focus();
      timer = setInterval(() => {
        secs++;
        const left = C.MAX_RECORD_SECONDS - secs;
        $("rec-time").textContent = fmt(secs);
        $("rec-left").textContent = left <= 30 ? `剩 ${left} 秒` : `最長 ${Math.round(C.MAX_RECORD_SECONDS / 60)} 分鐘`;
        if (left <= 0) stop();
      }, 1000);
    }
    function stop() { if (rec && rec.state === "recording") rec.stop(); }
    function cancel() {
      if (busy) return;
      cancelled = true;
      if (rec && rec.state === "recording") rec.stop(); else close();
    }
    async function onStop() {
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      cleanup();
      if (cancelled) return close();
      if (blob.size < 2000) return ui("err", "錄音太短，請再試一次。");
      busy = true; ui("busy", "請稍等，大約需要幾秒鐘。");
      try {
        let send = blob;
        try { send = await toWav(blob); } catch (e) { console.warn("WAV 轉換失敗，改送原始格式", e); }
        const data = await api("transcribe", { audio: await blobToBase64(send), mimeType: send.type.split(";")[0] });
        const text = (data.text || "").trim();
        busy = false;
        if (!text) return ui("err", "沒有辨識到內容，請再試一次或直接打字。");
        target.value = target.value.trim() ? target.value.trim() + "\n" + text : text;
        target.dispatchEvent(new Event("input"));
        onText && onText(text);
        close();
        target.focus();
      } catch (e) {
        busy = false;
        ui("err", "轉文字失敗：" + e.message + "。可以再試一次或直接打字。");
      }
    }
    $("rec-stop").addEventListener("click", stop);
    $("rec-cancel").addEventListener("click", cancel);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("rec").hidden) cancel(); });
    return { open };
  })();

  // ---------- 第 1 頁：邀請碼 ----------
  $("b-code").addEventListener("click", async () => {
    const code = $("code").value.trim();
    $("e-code").textContent = "";
    if (!code) return ($("e-code").textContent = "請輸入邀請碼。");
    const bg = { city: $("city").value, area: $("area").value, years: $("years").value, type: $("type").value, cls: $("cls").value, sen: $("sen").checked ? "是" : "否" };
    if (!bg.city || !bg.area || !bg.years || !bg.type || !bg.cls) return ($("e-code").textContent = "請把「關於你的班級」每一項都選好。");
    if (!$("agree").checked) return ($("e-code").textContent = "請先勾選同意。");
    state.bg = bg;
    $("b-code").disabled = true; $("e-code").textContent = "確認中…";
    try {
      state.code = code;
      await api("check");
      $("e-code").textContent = "";
      const d = loadDraft();
      if (d && d.code === code && Array.isArray(d.items) && d.items.length) {
        state.items = d.items; state.idx = Math.min(d.idx || 0, d.items.length - 1);
      } else {
        state.items = C.QUESTIONS.map((q) => newItem(q)); state.idx = 0;
      }
      renderQ(); show("s-q");
    } catch (e) { $("e-code").textContent = e.message; }
    finally { $("b-code").disabled = false; }
  });
  $("code").addEventListener("keydown", (e) => { if (e.key === "Enter") $("b-code").click(); });

  // ---------- 第 2 頁：一題一頁 ----------
  const cur = () => state.items[state.idx];

  // ---------- 幼兒題的必填資料 ----------
  const S = C.CHILD_SLOTS;
  $("ageM").innerHTML = '<option value="">個月</option>' + Array.from({ length: 12 }, (_, m) => `<option value="${m}">${m} 個月</option>`).join("");
  $("result").innerHTML = '<option value="">請選擇</option>' + S.RESULTS.map((x) => `<option>${esc(x)}</option>`).join("");
  $("sits").innerHTML = S.SITUATIONS.map((x, i) => `<label class="chip"><input type="checkbox" value="${esc(x)}" id="sit${i}"> ${esc(x)}</label>`).join("");
  const slotsOf = (it) => it.slots || (it.slots = { ageY: "", ageM: "", sits: [], tried: "", notTried: false, result: "" });
  function renderSlots(it) {
    const show = !!it.child;
    $("slots").hidden = !show;
    if (!show) return;
    $("childAskWrap").hidden = it.child !== "ask";
    $("childAsk").checked = !!it.childOn;
    $("slotFields").hidden = !it.childOn;
    const s = slotsOf(it);
    $("ageY").value = s.ageY; $("ageM").value = s.ageM;
    $("sits").querySelectorAll("input").forEach((x) => (x.checked = s.sits.indexOf(x.value) >= 0));
    $("tried").value = s.tried; $("notTried").checked = s.notTried; $("result").value = s.result;
    syncTried();
  }
  function syncTried() {
    const n = $("notTried").checked;
    $("tried").disabled = n; $("result").disabled = n;
    if (n) { $("tried").value = ""; $("result").value = ""; }
  }
  function keepSlots() {
    const it = cur(); if (!it.child) return;
    it.childOn = it.child === true || $("childAsk").checked;
    const s = slotsOf(it);
    Object.assign(s, { ageY: $("ageY").value, ageM: $("ageM").value,
      sits: [...$("sits").querySelectorAll("input:checked")].map((x) => x.value),
      tried: $("tried").value.trim(), notTried: $("notTried").checked, result: $("result").value });
  }
  /** 回傳缺少的欄位名稱；空陣列＝填齊 */
  function missingSlots(it) {
    if (!it.child || !it.childOn) return [];
    const s = slotsOf(it), miss = [];
    if (!s.ageY || (s.ageY !== "1" && s.ageM === "")) miss.push("年齡");
    if (!s.sits.length) miss.push("發生時段");
    if (!s.notTried && !s.tried) miss.push("已試過的做法（或勾「還沒試過」）");
    if (!s.notTried && s.tried && !s.result) miss.push("試過的結果");
    return miss;
  }
  function slotText(it) {   // 給追問用：告訴 AI 哪些已經知道
    if (!it.child || !it.childOn) return "";
    const s = slotsOf(it);
    return `孩子年齡：${ageLabel(s)}；發生時段：${s.sits.join("、")}；已試做法：${s.notTried ? "還沒試過" : s.tried + "（" + s.result + "）"}`;
  }
  function ageLabel(s) { return s.ageY === "1" ? "未滿 2 歲" : s.ageY ? `${s.ageY} 歲 ${s.ageM || 0} 個月` : ""; }
  function ageMonths(s) { return s.ageY === "1" ? "" : s.ageY ? Number(s.ageY) * 12 + Number(s.ageM || 0) : ""; }
  ["ageY", "ageM", "result"].forEach((id) => $(id).addEventListener("change", () => { keepSlots(); saveDraft(); }));
  $("sits").addEventListener("change", () => { keepSlots(); saveDraft(); });
  $("tried").addEventListener("change", () => { keepSlots(); saveDraft(); });
  $("notTried").addEventListener("change", () => { syncTried(); keepSlots(); saveDraft(); });
  $("childAsk").addEventListener("change", () => { keepSlots(); $("slotFields").hidden = !cur().childOn; saveDraft(); });

  function renderQ() {
    const it = cur();
    renderSlots(it);
    $("q-num").textContent = it.extra ? "加錄的問題" : `第 ${state.idx + 1} 題`;
    $("q-text").textContent = it.question; $("q-hint").textContent = it.hint;
    $("answer").value = it.answer; $("fu-answer").value = it.followupAnswer;
    $("fu-list").innerHTML = it.followups.map((x) => `<li>${esc(x)}</li>`).join("");
    $("fu").hidden = !it.followups.length;
    $("q-status").textContent = it.voice ? "已轉成文字，請檢查並修改不正確的地方。" : "";
    $("e-q").textContent = "";
    $("b-prev").hidden = state.returnToReview || state.idx === 0;
    $("b-skip").textContent = it.extra ? "刪除這題" : "跳過";
    const last = state.idx === state.items.length - 1;
    $("b-next").textContent = state.returnToReview ? "回到確認頁" : last ? "看我的回答" : "下一題";
  }
  function keep() {
    keepSlots();
    const it = cur();
    it.answer = $("answer").value.trim();
    it.followupAnswer = $("fu-answer").value.trim();
    saveDraft();
  }
  function goNext() {
    if (state.returnToReview || state.idx >= state.items.length - 1) { state.returnToReview = false; renderReview(); show("s-review"); return; }
    state.idx++; renderQ(); show("s-q");
  }

  $("b-mic").addEventListener("click", () => {
    Rec.open({ target: $("answer"), label: cur().question, onText: (t) => {
      const it = cur(); it.voice = true; it.transcript += (it.transcript ? "\n" : "") + t;
      $("q-status").textContent = "已轉成文字，請檢查並修改不正確的地方。"; keep();
    } });
  });
  $("b-mic2").addEventListener("click", () => {
    Rec.open({ target: $("fu-answer"), label: "補充回答", onText: () => { cur().voice = true; keep(); } });
  });
  $("answer").addEventListener("input", () => { const it = cur(); it.skipped = false; });
  $("answer").addEventListener("change", keep);
  $("fu-answer").addEventListener("change", keep);

  $("b-next").addEventListener("click", async () => {
    keep();
    const it = cur();
    $("e-q").textContent = "";
    const miss = missingSlots(it);
    if (miss.length) { $("slots").scrollIntoView({ behavior: "smooth", block: "start" }); return ($("e-q").textContent = "請先填好孩子的基本狀況：" + miss.join("、")); }
    if (!it.answer) return ($("e-q").textContent = it.extra ? "請錄音或打字，或按「刪除這題」。" : "請錄音或打字回答，或按「跳過」。");
    it.skipped = false;
    // 每題只追問一次；有需要才顯示，老師可以補充也可以直接往下
    if (!it.fuAsked) {
      it.fuAsked = true;
      const lock = (v) => ["b-next", "b-skip", "b-prev", "b-mic", "b-mic2"].forEach((id) => ($(id).disabled = v));
      lock(true); $("e-q").textContent = "稍等一下…";
      try {
        const r = await api("followup", { question: it.question, answer: it.answer, known: slotText(it) });
        $("e-q").textContent = "";
        if (r.need && r.questions && r.questions.length) {
          it.followups = r.questions.slice(0, 2); saveDraft();
          $("fu-list").innerHTML = it.followups.map((x) => `<li>${esc(x)}</li>`).join("");
          $("fu").hidden = false;
          $("fu").scrollIntoView({ behavior: "smooth", block: "center" });
          $("e-q").textContent = "可以補充，也可以直接按下方按鈕繼續。";
          return;
        }
      } catch (e) { $("e-q").textContent = ""; } // 追問失敗就直接往下
      finally { lock(false); }
    }
    goNext();
  });
  $("b-skip").addEventListener("click", () => {
    const it = cur();
    if (it.extra) {
      state.items.splice(state.idx, 1); state.idx = Math.max(0, state.idx - 1);
      state.returnToReview = false; saveDraft(); renderReview(); show("s-review"); return;
    }
    keep(); it.skipped = true; saveDraft(); goNext();
  });
  $("b-prev").addEventListener("click", () => { keep(); state.idx--; renderQ(); show("s-q"); });

  // ---------- 確認頁 ----------
  function renderReview() {
    $("reviewList").innerHTML = state.items.map((it, i) => {
      const empty = it.skipped || !it.answer;
      const badge = empty ? "跳過" : it.voice ? "語音" : "文字";
      const fu = (it.child && it.childOn && !empty ? `<div class="rv-fu">${esc(slotText(it))}</div>` : "") +
        (it.followupAnswer ? `<div class="rv-fu">補充：${esc(it.followupAnswer)}</div>` : "");
      return `<div class="rv">
        <div class="rv-head"><span class="rv-q">${it.extra ? "加錄" : "第 " + (i + 1) + " 題"}｜${esc(it.question)}</span><span class="badge">${badge}</span></div>
        <p class="rv-a ${empty ? "muted" : ""}">${empty ? "（沒有回答）" : esc(it.answer)}</p>${fu}
        <div class="rv-actions"><button type="button" class="ghost" data-edit="${i}">${empty ? "回答這題" : "修改"}</button>
        ${it.extra ? `<button type="button" class="ghost" data-del="${i}">刪除</button>` : ""}</div>
      </div>`;
    }).join("");
    $("e-review").textContent = "";
  }
  $("reviewList").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.edit != null) { state.idx = Number(b.dataset.edit); state.returnToReview = true; renderQ(); show("s-q"); }
    if (b.dataset.del != null) { state.items.splice(Number(b.dataset.del), 1); saveDraft(); renderReview(); }
  });
  $("b-add").addEventListener("click", () => {
    const n = state.items.filter((x) => x.extra).length + 1;
    state.items.push(newItem({ id: "ADD" + n, text: ADD_TEXT, hint: ADD_HINT, child: C.ADD_CHILD || false }, true));
    state.idx = state.items.length - 1; state.returnToReview = true; saveDraft();
    renderQ(); show("s-q");
    Rec.open({ target: $("answer"), label: ADD_TEXT, onText: (t) => {
      const it = cur(); it.voice = true; it.transcript += (it.transcript ? "\n" : "") + t;
      $("q-status").textContent = "已轉成文字，請檢查並修改不正確的地方。"; keep();
    } });
  });

  $("city").innerHTML = '<option value="">請選擇</option>' + C.CITIES.map((c) => `<option>${esc(c)}</option>`).join("");

  $("b-submit").addEventListener("click", async () => {
    $("e-review").textContent = "";
    if (!state.items.some((it) => it.answer && !it.skipped)) return ($("e-review").textContent = "至少要回答一題才能送出。");
    // 沿用後端原本的格式；加錄的題目 qid 為 ADD1、ADD2…
    const answers = state.items.map((it) => {
      const skipped = it.skipped || !it.answer;
      return {
        qid: it.qid, question: it.question, answer: skipped ? "" : it.answer, skipped,
        source: it.voice ? "語音" : "文字",
        edited: it.voice ? it.answer !== it.transcript.trim() : false,
        followups: it.followups, followupAnswer: it.followupAnswer,
        child: !!(it.child && it.childOn),
        slots: it.child && it.childOn ? (() => { const s = slotsOf(it); return {
          ageMonths: ageMonths(s), ageLabel: ageLabel(s), situations: s.sits.join("、"),
          tried: s.notTried ? "還沒試過" : s.tried, result: s.notTried ? "" : s.result, complete: missingSlots(it).length === 0 }; })() : null,
      };
    }).filter((a) => !(a.skipped && /^ADD/.test(a.qid)));
    $("b-submit").disabled = true; $("e-review").textContent = "送出中…";
    try {
      const r = await api("submit", { background: state.bg, answers });
      clearDraft();
      $("done-id").textContent = "回覆編號：" + r.id; show("s-done");
    } catch (e) {
      $("e-review").textContent = "送出失敗：" + e.message + "。你的回答還在，請再按一次送出。";
    } finally { $("b-submit").disabled = false; }
  });

  show("s-code");
})();
