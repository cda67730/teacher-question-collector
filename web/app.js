(() => {
  const C = window.APP_CONFIG;
  const $ = (id) => document.getElementById(id);
  const state = { code: "", bg: null, idx: 0, answers: [], cur: null };
  const DRAFT_KEY = "tqc-draft-v1";

  // ---------- 共用 ----------
  function show(id) {
    ["s-consent", "s-bg", "s-q", "s-done"].forEach((s) => ($(s).hidden = s !== id));
    const total = C.QUESTIONS.length + 2;
    const step = id === "s-consent" ? 0 : id === "s-bg" ? 1 : id === "s-q" ? 2 + state.idx : total;
    $("bar").style.width = Math.round((step / total) * 100) + "%";
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
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ code: state.code, bg: state.bg, idx: state.idx, answers: state.answers })); } catch (e) {}
  }
  function loadDraft() {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch (e) { return null; }
  }
  function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) {} }

  // ---------- 錄音 ----------
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
  function makeRecorder(btn, timeEl, target, onTranscribed) {
    let rec = null, chunks = [], timer = null, secs = 0, stream = null;
    const label = btn.textContent;
    const reset = () => { btn.textContent = label; btn.setAttribute("aria-pressed", "false"); clearInterval(timer); };
    async function start() {
      if (!navigator.mediaDevices || !window.MediaRecorder) { $("rec-status").textContent = "這個瀏覽器不支援錄音，請直接打字。"; return; }
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
      catch (e) { $("rec-status").textContent = "無法使用麥克風，請確認已允許瀏覽器使用麥克風，或直接打字。"; return; }
      const mimeType = pickMime();
      rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 24000 } : undefined);
      chunks = []; secs = 0;
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        reset();
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        if (blob.size < 2000) { $("rec-status").textContent = "錄音太短，請再試一次。"; return; }
        $("rec-status").textContent = "正在轉成文字…";
        btn.disabled = true;
        try {
          const data = await api("transcribe", { audio: await blobToBase64(blob), mimeType: blob.type.split(";")[0] });
          const text = (data.text || "").trim();
          target.value = target.value.trim() ? target.value.trim() + "\n" + text : text;
          onTranscribed && onTranscribed(text);
          $("rec-status").textContent = text ? "已轉成文字，請檢查並修改不正確的地方。" : "沒有辨識到內容，請再試一次或直接打字。";
        } catch (e) {
          $("rec-status").textContent = "轉文字失敗：" + e.message + "。可以再試一次或直接打字。";
        } finally { btn.disabled = false; }
      };
      rec.start(1000);
      btn.textContent = "■ 停止錄音"; btn.setAttribute("aria-pressed", "true");
      $("rec-status").textContent = "錄音中…說完請按停止。";
      timer = setInterval(() => {
        secs++;
        const left = C.MAX_RECORD_SECONDS - secs;
        timeEl.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}（剩 ${left} 秒）`;
        if (left <= 0) rec.stop();
      }, 1000);
    }
    btn.addEventListener("click", () => (rec && rec.state === "recording" ? rec.stop() : start()));
    return { stop: () => rec && rec.state === "recording" && rec.stop() };
  }

  // ---------- 1. 同意 ----------
  $("b-consent").addEventListener("click", async () => {
    const code = $("code").value.trim();
    $("e-consent").textContent = "";
    if (!code) return ($("e-consent").textContent = "請輸入邀請碼。");
    if (!$("agree").checked) return ($("e-consent").textContent = "請先勾選同意。");
    $("b-consent").disabled = true;
    try {
      state.code = code;
      await api("check");
      const d = loadDraft();
      if (d && d.code === code && d.bg) { Object.assign(state, { bg: d.bg, idx: d.idx, answers: d.answers }); renderQ(); show("s-q"); }
      else show("s-bg");
    } catch (e) { $("e-consent").textContent = e.message; }
    finally { $("b-consent").disabled = false; }
  });

  // ---------- 2. 背景 ----------
  $("city").innerHTML = '<option value="">請選擇</option>' + C.CITIES.map((c) => `<option>${c}</option>`).join("");
  $("b-bg").addEventListener("click", () => {
    const bg = { city: $("city").value, area: $("area").value, years: $("years").value, type: $("type").value, cls: $("cls").value, sen: $("sen").checked ? "是" : "否" };
    if (!bg.city || !bg.area || !bg.years || !bg.type || !bg.cls) return ($("e-bg").textContent = "請把每一題都選好。");
    $("e-bg").textContent = "";
    state.bg = bg; state.idx = 0; state.answers = [];
    saveDraft(); renderQ(); show("s-q");
  });

  // ---------- 3. 題目 ----------
  const rec1 = makeRecorder($("b-rec"), $("rec-time"), $("answer"), (t) => { state.cur.voice = true; state.cur.transcript += (state.cur.transcript ? "\n" : "") + t; });
  const rec2 = makeRecorder($("b-rec2"), $("rec-time2"), $("fu-answer"), () => { state.cur.voice = true; });

  function renderQ() {
    const q = C.QUESTIONS[state.idx];
    state.cur = { voice: false, transcript: "", followups: [], fuShown: false };
    $("q-num").textContent = `第 ${state.idx + 1} 題，共 ${C.QUESTIONS.length} 題`;
    $("q-text").textContent = q.text; $("q-hint").textContent = q.hint;
    $("answer").value = ""; $("fu-answer").value = ""; $("fu").hidden = true; $("fu-list").innerHTML = "";
    $("rec-status").textContent = ""; $("rec-time").textContent = "最長 3 分鐘"; $("rec-time2").textContent = ""; $("e-q").textContent = "";
    $("b-next").textContent = state.idx === C.QUESTIONS.length - 1 ? "送出" : "下一步";
  }

  async function finishQuestion(skipped) {
    const q = C.QUESTIONS[state.idx];
    const ans = $("answer").value.trim();
    state.answers.push({
      qid: q.id, question: q.text, answer: skipped ? "" : ans, skipped: !!skipped,
      source: state.cur.voice ? "語音" : "文字",
      edited: state.cur.voice ? ans !== state.cur.transcript.trim() : false,
      followups: state.cur.followups, followupAnswer: $("fu-answer").value.trim(),
    });
    state.idx++; saveDraft();
    if (state.idx < C.QUESTIONS.length) { renderQ(); show("s-q"); return; }
    $("b-next").disabled = true; $("b-skip").disabled = true;
    $("e-q").textContent = "送出中…";
    try {
      const r = await api("submit", { background: state.bg, answers: state.answers });
      clearDraft();
      $("done-id").textContent = "回覆編號：" + r.id; show("s-done");
    } catch (e) {
      state.idx--; state.answers.pop(); // 讓使用者可以再按一次送出
      $("e-q").textContent = "送出失敗：" + e.message + "。你的回答還在，請再按一次送出。";
    } finally { $("b-next").disabled = false; $("b-skip").disabled = false; }
  }

  $("b-next").addEventListener("click", async () => {
    rec1.stop(); rec2.stop();
    const ans = $("answer").value.trim();
    $("e-q").textContent = "";
    if (!ans) return ($("e-q").textContent = "請錄音或打字回答，或按「跳過這題」。");
    if (!state.cur.fuShown) {
      $("b-next").disabled = true; $("e-q").textContent = "稍等一下…";
      try {
        const r = await api("followup", { question: C.QUESTIONS[state.idx].text, answer: ans });
        $("e-q").textContent = "";
        if (r.need && r.questions && r.questions.length) {
          state.cur.fuShown = true; state.cur.followups = r.questions.slice(0, 2);
          $("fu-list").innerHTML = state.cur.followups.map((x) => `<li>${x.replace(/[<>&]/g, "")}</li>`).join("");
          $("fu").hidden = false; $("fu-answer").focus();
          $("b-next").textContent = "繼續";
          return;
        }
      } catch (e) { $("e-q").textContent = ""; } // 追問失敗就直接往下
      finally { $("b-next").disabled = false; }
    }
    finishQuestion(false);
  });
  $("b-skip").addEventListener("click", () => { rec1.stop(); rec2.stop(); finishQuestion(true); });

  show("s-consent");
})();
