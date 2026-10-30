(() => {
  const C = window.CHAT_CONFIG;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const newSession = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  let S = { code: "", session: newSession(), history: [], nameMap: {}, followups: 0, turn: 0, welcome: "" };

  async function api(action, payload) {
    if (!C.GAS_URL || C.GAS_URL.includes("請替換")) throw new Error("尚未設定後端網址（chat/config.js）");
    const res = await fetch(C.GAS_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(Object.assign({ action, code: S.code, session: S.session }, payload || {})) });
    const d = await res.json().catch(() => ({ ok: false, error: "伺服器回應無法解析" }));
    if (!d.ok) throw new Error(d.error || "發生錯誤，請稍後再試");
    return d;
  }
  const restore = (s) => { let o = String(s == null ? "" : s); Object.entries(S.nameMap).forEach(([n, l]) => (o = o.split(l).join(n))); return o; };
  const R = (s) => esc(restore(s));

  function bubble(cls, html) {
    const d = document.createElement("div");
    d.className = "bubble " + cls; d.innerHTML = html;
    $("chat").appendChild(d); d.scrollIntoView({ behavior: "smooth", block: "end" });
    return d;
  }

  function render(r) {
    if (r.type === "followup") return `<p>${R(r.empathy)}</p><ol>${r.questions.map((q) => `<li>${R(q)}</li>`).join("")}</ol>`;
    if (r.type === "referral") {
      const f = r.referral;
      return `<h3>這個情況需要馬上找專人（${esc(f.category)}）</h3><p>${R(f.reason)}</p><h3>該找誰</h3><p>${esc(f.who)}${f.contact ? "｜" + esc(f.contact) : ""}</p>${f.now ? `<h3>現在要做的事</h3><p>${esc(f.now)}</p>` : ""}<p class="muted small">是否通報或轉介，由你和園長決定。</p>`;
    }
    if (r.type !== "answer") return `<p>${esc(r.message)}</p>`;
    const a = r.answer, src = {};
    (r.sources || []).forEach((s) => (src[s.ref] = s));
    let h = `<p>${R(a.empathy)}</p>`;
    if (a.understanding) h += `<h3>看見與理解</h3><p>${R(a.understanding)}</p>`;
    h += `<h3>現在可以試試</h3><ol>${(a.strategies || []).map((s) => `<li><b>${R(s.title)}</b>：${R(s.how)}${(s.refs || []).filter((x) => src[x]).map((x) => `<button type="button" class="ref" data-ref="${esc(x)}">${esc(x)}</button>`).join("")}</li>`).join("")}</ol>`;
    if (a.parent_message) h += `<h3>給家長的訊息草稿</h3><div class="pm">${R(a.parent_message)}</div><div class="actions"><button type="button" data-copy="1">複製訊息</button></div>`;
    if ((a.observe || []).length) h += `<h3>接下來觀察記錄</h3><ul>${a.observe.map((o) => `<li>${R(o)}</li>`).join("")}</ul>`;
    if (a.teacher_care) h += `<h3>也照顧你自己</h3><p>${R(a.teacher_care)}</p>`;
    if (a.referral) h += `<h3>需要時找專人</h3><p>${R(a.referral)}</p>`;
    return h;
  }

  function attach(el, r, turn) {
    const src = {}; (r.sources || []).forEach((s) => (src[s.ref] = s));
    el.addEventListener("click", (e) => {
      const b = e.target.closest(".ref");
      if (b) {
        const li = b.closest("li"); const old = li.querySelector(`.src[data-for="${b.dataset.ref}"]`);
        if (old) return old.remove();
        const s = src[b.dataset.ref];
        const box = document.createElement("div"); box.className = "src"; box.dataset.for = b.dataset.ref;
        box.innerHTML = `<b>${esc(s.title)}</b>${s.page ? "｜第" + esc(s.page) + "頁" : ""}${s.evidence ? "｜" + esc(s.evidence) : ""}\n${esc(s.source || "")}\n「${esc(s.snippet)}…」`;
        li.appendChild(box); return;
      }
      const c = e.target.closest("[data-copy]");
      if (c) {
        const t = el.querySelector(".pm").textContent;
        navigator.clipboard?.writeText(t).then(() => (c.textContent = "已複製"), () => (c.textContent = "請手動選取複製"));
        api("feedback", { turn, kind: "複製家長訊息" }).catch(() => {});
      }
      const f = e.target.closest("[data-fb]");
      if (f && !f.classList.contains("on")) {
        f.parentElement.querySelectorAll("[data-fb]").forEach((x) => x.classList.remove("on")); f.classList.add("on");
        api("feedback", { turn, kind: f.dataset.fb }).catch(() => {});
      }
    });
    if (r.type === "answer" || r.type === "referral" || r.type === "conservative") {
      const a = document.createElement("div"); a.className = "actions";
      a.innerHTML = `<button type="button" data-fb="有幫助">👍 有幫助</button><button type="button" data-fb="沒幫助">👎 沒幫助</button>`;
      el.appendChild(a);
    }
  }

  async function send(text) {
    bubble("me", esc(text));
    const wait = bubble("bot typing", "正在了解狀況、查找資料…");
    $("send").disabled = true; S.turn++;
    try {
      const r = await api("chat", { message: text, history: S.history, nameMap: S.nameMap, followups: S.followups });
      S.nameMap = r.nameMap || S.nameMap;
      S.history.push({ role: "teacher", text: r.deidText });
      if (r.type === "followup") S.followups++;
      S.history.push({ role: "bot", text: r.type === "answer" ? [r.answer.empathy, (r.answer.strategies || []).map((s) => s.title).join("、")].join(" ") : r.type === "followup" ? r.questions.join(" ") : r.message || "" });
      wait.remove();
      const el = bubble("bot" + (r.type === "referral" ? " flag" : ""), render(r));
      attach(el, r, S.turn);
    } catch (e) {
      wait.remove(); bubble("bot", `<p class="err">${esc(e.message)}</p>`);
    } finally { $("send").disabled = false; $("msg").focus(); }
  }

  function start() {
    $("chat").innerHTML = "";
    S = Object.assign(S, { session: newSession(), history: [], nameMap: {}, followups: 0, turn: 0 });
    if (S.welcome) bubble("bot", `<p>${esc(S.welcome)}</p>`);
  }

  $("enter").addEventListener("click", async () => {
    const code = $("code").value.trim(); $("gateErr").textContent = "";
    if (!code) return ($("gateErr").textContent = "請輸入邀請碼。");
    $("enter").disabled = true; S.code = code;
    try {
      const r = await api("check");
      S.welcome = r.welcome || ""; $("botName").textContent = r.botName || $("botName").textContent; document.title = $("botName").textContent;
      try { sessionStorage.setItem("chat-code", code); } catch (e) {}
      $("gate").hidden = true; $("chat").hidden = false; $("composer").hidden = false; $("reset").hidden = false;
      start(); $("msg").focus();
    } catch (e) { $("gateErr").textContent = e.message; } finally { $("enter").disabled = false; }
  });
  $("composer").addEventListener("submit", (e) => { e.preventDefault(); const t = $("msg").value.trim(); if (!t || $("send").disabled) return; $("msg").value = ""; send(t); });
  $("msg").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("composer").requestSubmit(); } });
  $("reset").addEventListener("click", start);
  try { const c = sessionStorage.getItem("chat-code"); if (c) $("code").value = c; } catch (e) {}
})();
