import { Chess } from "./vendor/chess.js";
import { lineWords } from "./vendor/facts.js";
import { describeMove } from "./words.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const CLS = {
  brilliant: { label: "Brilliant", sym: "!!" },
  great: { label: "Great", sym: "!" },
  best: { label: "Best", sym: "★" },
  excellent: { label: "Excellent", sym: "✓" },
  good: { label: "Good", sym: "○" },
  book: { label: "Book", sym: "≡" },
  inaccuracy: { label: "Inaccuracy", sym: "?!" },
  mistake: { label: "Mistake", sym: "?" },
  miss: { label: "Miss", sym: "×" },
  blunder: { label: "Blunder", sym: "??" },
};
const CLS_COLOR = (c) => getComputedStyle(document.documentElement).getPropertyValue(`--${c}`).trim();
const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const FALLBACK = {
  book: "Opening theory.",
  brilliant: "A sacrifice the engine fully approves of.",
  great: "The one move that keeps things on track.",
  best: "The engine's top choice.",
  excellent: "Very nearly the engine's top choice.",
  good: "A solid move, just short of the best.",
  inaccuracy: "A small slip.",
  mistake: "This gives away a real chunk of the position.",
  miss: "The opponent slipped and this lets them off the hook.",
  blunder: "This changes the course of the game.",
};

const state = { images: [], color: "w", meta: {}, game: null, cur: 0, showBest: false, explore: null, sel: null, knownPatterns: [], settings: null, models: [] };

const api = async (url, opts) => {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
};

// ------------------------------------------------------------------ routing

function show(view) {
  for (const v of ["home", "review", "profile"]) $(`#${v}`).hidden = v !== view;
  window.scrollTo(0, 0);
}

async function route() {
  const h = location.hash.slice(1);
  if (h.startsWith("game/")) {
    // #game/<id> or #game/<id>/<ply> (optionally ?tab=overview|patterns in the URL)
    const [id, ply] = h.slice(5).split("/");
    if (state.game?.id !== id) {
      try {
        await openGame(await api(`/api/games/${id}`));
      } catch {
        location.hash = "";
        return;
      }
    } else show("review");
    if (ply) go(Number(ply) || 0);
    const tab = new URLSearchParams(location.search).get("tab");
    if (["overview", "patterns"].includes(tab)) selectTab(tab);
  } else if (h === "profile") {
    show("profile");
    renderProfile();
  } else {
    show("home");
    renderHistory();
  }
}
window.addEventListener("hashchange", route);
$("#homeLink").onclick = $("#navNew").onclick = (e) => {
  e.preventDefault();
  location.hash = "";
};

// ------------------------------------------------------------------ model picker

const currentProvider = () => state.settings?.providers.find((p) => p.id === state.settings.provider);
const chosen = (role) => state.settings?.models[state.settings.provider]?.[role] || "";
const canUse = (role) => !!(currentProvider()?.hasKey && chosen(role));

function modelOptions(models) {
  return models
    .map((m) => `<option value="${esc(m.id)}">${esc(m.name)}${m.price ? ` — $${m.price.in}/$${m.price.out} per M` : ""}</option>`)
    .join("");
}

function renderModelHint() {
  const p = currentProvider();
  const el = $("#modelHint");
  if (!p) return;
  const parts = [];
  if (!p.hasKey) parts.push(`<span class="warn">No ${esc(p.name)} key found. Add ${esc(p.env)} to the .env file in the project folder and restart.</span> Reviews still work without it, just without the written explanations.`);
  else if (state.modelError) parts.push(`<span class="warn">${esc(state.modelError)}</span>`);
  else {
    for (const [role, label] of [["coach", "Coach"], ["vision", "Screenshot reader"]]) {
      const id = chosen(role);
      const m = state.models.find((x) => x.id === id);
      $(`#${role}Model`).classList.toggle("bad", !!id && state.models.length > 0 && !m);
      if (!id) parts.push(`<span class="warn">Pick a ${label.toLowerCase()} model.</span>`);
      else if (!m) parts.push(`<span class="warn">${label}: "${esc(id)}" isn't in ${esc(p.name)}'s model list.</span>`);
      else if (role === "vision" && m.vision === false) parts.push(`<span class="warn">${esc(m.name)} can't read images, so it can't read screenshots.</span>`);
      else if (m.price) parts.push(`${label}: $${m.price.in} in / $${m.price.out} out per million tokens`);
    }
  }
  el.innerHTML = parts.join(" · ");
}

async function loadModels() {
  const provider = state.settings.provider;
  state.models = [];
  state.modelError = null;
  $("#coachList").innerHTML = $("#visionList").innerHTML = "";
  try {
    const models = await api(`/api/models?provider=${provider}`);
    if (provider !== state.settings.provider) return; // switched again while loading
    state.models = models;
    $("#coachList").innerHTML = modelOptions(models);
    $("#visionList").innerHTML = modelOptions(models.filter((m) => m.vision !== false));
  } catch (err) {
    state.modelError = `Couldn't load the model list (${err.message}) You can still type a model id.`;
  }
  renderModelHint();
}

function renderSettings() {
  const s = state.settings;
  $("#provider").innerHTML = s.providers.map((p) => `<option value="${p.id}" ${p.id === s.provider ? "selected" : ""}>${esc(p.name)}${p.hasKey ? "" : " (no key)"}</option>`).join("");
  $("#coachModel").value = chosen("coach");
  $("#visionModel").value = chosen("vision");
  renderModelHint();
  refreshButtons();
}

async function saveSettings(patch) {
  const s = state.settings;
  const body = { provider: s.provider, coach: chosen("coach"), vision: chosen("vision"), ...patch };
  state.settings = await api("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  renderSettings();
}

$("#provider").onchange = async (e) => {
  // Switching provider restores whatever models were last used with it.
  const prev = state.settings.models[e.target.value] ?? {};
  await saveSettings({ provider: e.target.value, coach: prev.coach ?? "", vision: prev.vision ?? "" });
  loadModels();
};
$("#coachModel").onchange = (e) => {
  const patch = { coach: e.target.value.trim() };
  // Convenience: a vision-capable coach model also reads screenshots unless one was picked already.
  const m = state.models.find((x) => x.id === patch.coach);
  if (!chosen("vision") && m && m.vision !== false) patch.vision = patch.coach;
  saveSettings(patch);
};
$("#visionModel").onchange = (e) => saveSettings({ vision: e.target.value.trim() });

// ------------------------------------------------------------------ home / upload

function setStatus(msg, kind = "") {
  const el = $("#status");
  el.hidden = !msg;
  el.className = `status ${kind}`;
  el.textContent = msg ?? "";
}

function refreshButtons() {
  $("#readBtn").disabled = !state.images.length || !canUse("vision") || state.busy;
  $("#analyzeBtn").disabled = !$("#moves").value.trim() || state.busy;
}

function renderThumbs() {
  $("#thumbs").innerHTML = state.images.map((img, i) => `<div class="thumb"><img src="${img.url}" alt="screenshot ${i + 1}"><button data-i="${i}" title="Remove">×</button></div>`).join("");
  refreshButtons();
}

async function toImage(file) {
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  // Keep each image comfortably under the API's size limit.
  if (file.size < 3.5e6 && /image\/(png|jpeg|webp|gif)/.test(file.type)) return { url: dataUrl, mediaType: file.type, data: dataUrl.split(",")[1] };
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = rej;
    img.src = dataUrl;
  });
  const scale = Math.min(1, 2400 / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL("image/jpeg", 0.92);
  return { url, mediaType: "image/jpeg", data: url.split(",")[1] };
}

async function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    try {
      state.images.push(await toImage(f));
    } catch {
      setStatus(`Couldn't read ${f.name || "that image"}.`, "err");
    }
  }
  renderThumbs();
}

const drop = $("#drop");
drop.onclick = (e) => {
  if (e.target.closest(".thumb button")) {
    state.images.splice(Number(e.target.dataset.i), 1);
    renderThumbs();
  } else $("#file").click();
};
drop.onkeydown = (e) => (e.key === "Enter" || e.key === " ") && $("#file").click();
$("#file").onchange = (e) => {
  addFiles(e.target.files);
  e.target.value = "";
};
drop.ondragover = (e) => {
  e.preventDefault();
  drop.classList.add("over");
};
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  addFiles(e.dataTransfer.files);
};
document.addEventListener("paste", (e) => {
  if ($("#home").hidden) return;
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});

$("#colorSeg").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.color = b.dataset.color;
  for (const x of $("#colorSeg").children) x.classList.toggle("on", x === b);
};
$("#moves").oninput = refreshButtons;

$("#readBtn").onclick = async () => {
  state.busy = true;
  refreshButtons();
  setStatus("Reading the moves off your screenshot…");
  try {
    const out = await api("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images: state.images.map(({ mediaType, data }) => ({ mediaType, data })) }),
    });
    $("#moves").value = out.movesText;
    state.meta = { white: out.white, black: out.black, result: out.result };
    state.busy = false;
    if (out.error) {
      setStatus(`${out.error} Fix it in the box below (or add a clearer screenshot), then hit Analyse.`, "err");
    } else if (out.problems) {
      setStatus(`Read ${Math.ceil(out.count / 2)} moves, but: ${out.problems} Check the list below, then hit Analyse.`, "ok");
    } else {
      setStatus(`Read ${Math.ceil(out.count / 2)} moves — every one is legal. Analysing…`, "ok");
      return analyze();
    }
  } catch (err) {
    setStatus(err.message, "err");
  }
  state.busy = false;
  refreshButtons();
};

// Run one review on the server and report its events. Throws if the engine analysis fails.
async function streamReview(payload, on) {
  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Analysis failed.");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const ev = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (ev.type === "progress") on.progress?.(ev.done, ev.total);
      else if (ev.type === "game") await on.game?.(ev.game);
      else if (ev.type === "coach") await on.coach?.(ev.coach);
      else if (ev.type === "error") throw new Error(ev.error);
    }
  }
}

function setProgress(frac, text) {
  const prog = $("#progress");
  prog.hidden = frac == null;
  if (frac == null) return;
  prog.querySelector("i").style.width = `${frac * 100}%`;
  prog.querySelector("span").textContent = text;
}

// Review one game and open it. payload defaults to the manual form (pasted moves / screenshot).
async function analyze(payload) {
  payload ??= { movesText: $("#moves").value, color: state.color, ...state.meta };
  state.busy = true;
  refreshButtons();
  renderCcBar();
  setProgress(0, "Starting the engine…");
  let opened = null;
  try {
    await streamReview(payload, {
      progress: (done, total) => setProgress(done / total, `Engine: position ${done} of ${total}`),
      game: (game) => {
        opened = game;
        openGame(game, true);
        history.pushState(null, "", `#game/${game.id}`);
        resetHome();
        if (game.source) reviewedBySource[game.source] = game.id;
        renderCcGames();
      },
      coach: async (coach) => {
        opened.coach = coach;
        if (state.game === opened) {
          await loadKnownPatterns();
          renderReview();
        }
      },
    });
  } catch (err) {
    setStatus(err.message, "err");
    if (opened && !opened.coach) {
      opened.coach = { moves: [], turning_points: [], patterns: [], takeaways: [], notice: err.message };
      if (state.game === opened) renderReview();
    }
  }
  state.busy = false;
  setProgress(null);
  refreshButtons();
  renderCcBar();
}

// ---- chess.com import
const TIME_ICON = { bullet: "Bullet", blitz: "Blitz", rapid: "Rapid", daily: "Daily" };
let ccGames = [];
let reviewedBySource = {};
const selected = new Set(); // chess.com game urls ticked for a batch review
const batch = { running: false, stop: false, status: {} }; // status[url] = { state, text }

const ccPayload = (g) => ({ movesText: g.pgn, color: g.color, white: g.white, black: g.black, result: g.result, whiteRating: g.whiteRating, blackRating: g.blackRating, source: g.url, playedAt: g.endTime });

function rowStatus(g) {
  const st = batch.status[g.url];
  if (st?.state === "failed") return `<span class="tagfail" title="${esc(st.text)}">Failed</span>`;
  if (st && st.state !== "done") return `<span class="tagrun">${esc(st.text)}</span>`;
  if (reviewedBySource[g.url]) return `<span class="tagdone">${st?.text ? esc(st.text) : "Reviewed"}</span>`;
  return `<span class="chip">Review</span>`;
}

function renderCcGames() {
  $("#ccGames").innerHTML = ccGames
    .map((g, i) => {
      const oppName = g.color === "w" ? g.black : g.white;
      const oppRating = g.color === "w" ? g.blackRating : g.whiteRating;
      const r = g.outcome === "win" ? "W" : g.outcome === "loss" ? "L" : "D";
      const done = !!reviewedBySource[g.url];
      return `<div class="game" data-i="${i}">
        <input type="checkbox" class="pick" title="Add to batch" ${selected.has(g.url) ? "checked" : ""} ${done || batch.running ? "disabled" : ""} ${done ? 'style="visibility:hidden"' : ""}>
        <div class="res ${g.outcome}">${r}</div>
        <div><div class="t">vs ${esc(oppName)}${oppRating ? ` <span class="muted">(${oppRating})</span>` : ""}</div>
          <div class="s">${g.color === "w" ? "White" : "Black"} · ${esc(TIME_ICON[g.timeClass] ?? g.timeClass ?? "")} · ${g.moves} moves${g.opening ? ` · ${esc(g.opening)}` : ""} · ${new Date(g.endTime).toLocaleDateString()}</div></div>
        <div class="st">${rowStatus(g)}</div>
      </div>`;
    })
    .join("");
  renderCcBar();
}

function renderCcBar() {
  const bar = $("#ccBar");
  bar.hidden = !ccGames.length;
  if (!ccGames.length) return;
  for (const url of [...selected]) if (reviewedBySource[url]) selected.delete(url);
  const open = ccGames.filter((g) => !reviewedBySource[g.url]).length;
  if (batch.running) {
    bar.innerHTML = `<span class="muted">${batch.stop ? "Stopping after the current game…" : "Batch review running. You can open finished reviews while it works; keep this tab open."}</span>
      <button class="btn" data-act="stop" ${batch.stop ? "disabled" : ""}>Stop after this game</button>`;
  } else {
    bar.innerHTML = `<span><a href="#" data-act="all">Select all unreviewed (${open})</a>${selected.size ? ` · <a href="#" data-act="none">Clear</a>` : ""}</span>
      <button class="btn primary" data-act="run" ${selected.size && !state.busy ? "" : "disabled"}>Review ${selected.size || ""} selected</button>`;
  }
}

function setRow(g, stateName, text) {
  batch.status[g.url] = { state: stateName, text };
  const cell = $(`#ccGames .game[data-i="${ccGames.indexOf(g)}"] .st`);
  if (cell) cell.innerHTML = rowStatus(g);
}

async function runBatch() {
  // Oldest first, so each review can build on the patterns found in the games before it.
  const queue = ccGames.filter((g) => selected.has(g.url) && !reviewedBySource[g.url]).sort((a, b) => a.endTime - b.endTime);
  if (!queue.length || state.busy) return;
  state.busy = batch.running = true;
  batch.stop = false;
  refreshButtons();
  setStatus(null);
  for (const g of queue) setRow(g, "queued", "Queued");
  renderCcGames();
  let ok = 0, engineOnly = 0, failed = 0, firstNotice = null;
  for (const [n, g] of queue.entries()) {
    if (batch.stop) {
      delete batch.status[g.url];
      continue;
    }
    const label = `Game ${n + 1} of ${queue.length}`;
    setProgress(n / queue.length, `${label}: starting the engine…`);
    setRow(g, "engine", "Engine 0%");
    try {
      let coach = null;
      await streamReview(ccPayload(g), {
        progress: (done, total) => {
          setRow(g, "engine", `Engine ${Math.round((done / total) * 100)}%`);
          setProgress((n + (done / total) * 0.5) / queue.length, `${label}: engine, position ${done} of ${total}`);
        },
        game: (game) => {
          reviewedBySource[g.url] = game.id;
          batch.status[g.url] = { state: "coach", text: "Coach writing…" };
          const cell = $(`#ccGames .game[data-i="${ccGames.indexOf(g)}"] .st`);
          if (cell) cell.innerHTML = `<span class="tagrun">Coach writing…</span>`;
          setProgress((n + 0.5) / queue.length, `${label}: the coach is writing it up…`);
        },
        coach: (c) => (coach = c),
      });
      if (!reviewedBySource[g.url]) throw new Error("The review didn't finish.");
      if (coach && !coach.notice && !coach.basic) ok++;
      else {
        engineOnly++;
        firstNotice ??= coach?.notice;
      }
      selected.delete(g.url);
      setRow(g, "done", coach && !coach.notice && !coach.basic ? "Reviewed" : "Engine only");
    } catch (err) {
      failed++;
      setRow(g, "failed", err.message);
    }
  }
  state.busy = batch.running = false;
  setProgress(null);
  const parts = [];
  if (ok) parts.push(`${ok} game${ok === 1 ? "" : "s"} reviewed`);
  if (engineOnly) parts.push(`${engineOnly} with the engine review only (${firstNotice ?? "the coach didn't finish"} Open the game to write the coaching.)`);
  if (failed) parts.push(`${failed} failed (hover the Failed tag for why)`);
  if (batch.stop) parts.push("stopped early");
  setStatus(parts.length ? `Batch done: ${parts.join(" · ")}.` : null, failed || engineOnly ? "" : "ok");
  refreshButtons();
  renderCcGames();
  renderHistory();
}

$("#ccBar").onclick = (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  e.preventDefault();
  if (act === "all") for (const g of ccGames) if (!reviewedBySource[g.url]) selected.add(g.url);
  if (act === "none") selected.clear();
  if (act === "stop") batch.stop = true;
  if (act === "run") return runBatch();
  renderCcGames();
};

async function loadCcGames() {
  const user = $("#ccUser").value.trim();
  if (!user || batch.running) return;
  $("#ccBtn").disabled = true;
  setStatus("Loading your games from chess.com…");
  try {
    const [games, reviewed] = await Promise.all([api(`/api/chesscom/${encodeURIComponent(user)}`), api("/api/games").catch(() => [])]);
    ccGames = games;
    selected.clear();
    batch.status = {};
    reviewedBySource = Object.fromEntries(reviewed.filter((g) => g.source).map((g) => [g.source, g.id]));
    try {
      localStorage.setItem("ccUser", user);
    } catch {}
    setStatus(games.length ? null : "No standard games found for that account in the last few months.");
    renderCcGames();
  } catch (err) {
    ccGames = [];
    renderCcGames();
    setStatus(err.message, "err");
  }
  $("#ccBtn").disabled = false;
}
$("#ccForm").onsubmit = (e) => {
  e.preventDefault();
  loadCcGames();
};
$("#ccGames").onclick = (e) => {
  const row = e.target.closest(".game");
  if (!row) return;
  const g = ccGames[Number(row.dataset.i)];
  if (e.target.classList.contains("pick")) {
    e.target.checked ? selected.add(g.url) : selected.delete(g.url);
    return renderCcBar();
  }
  // Finished reviews can be opened any time, even while a batch is running.
  if (reviewedBySource[g.url] && batch.status[g.url]?.state !== "coach") return (location.hash = `game/${reviewedBySource[g.url]}`);
  if (state.busy) return;
  row.classList.add("busy");
  setStatus(null);
  analyze(ccPayload(g)).then(() => row.classList.remove("busy"));
};

$("#analyzeBtn").onclick = () => {
  setStatus(null);
  analyze();
};

function resetHome() {
  state.images = [];
  state.meta = {};
  $("#moves").value = "";
  renderThumbs();
  setStatus(null);
}

async function renderHistory() {
  const games = await api("/api/games").catch(() => []);
  const el = $("#history");
  if (!games.length) return (el.innerHTML = `<p class="muted">No games reviewed yet.</p>`);
  el.innerHTML = games
    .map((g) => {
      const r = g.outcome === "win" ? "W" : g.outcome === "loss" ? "L" : g.outcome === "draw" ? "D" : "–";
      return `<div class="game" data-id="${esc(g.id)}">
        <div class="res ${esc(g.outcome ?? "")}">${r}</div>
        <div><div class="t">${esc(g.headline ?? g.opening)}</div>
          <div class="s">${esc(g.opening)} · ${g.color === "w" ? "White" : "Black"}${g.opponent ? ` vs ${esc(g.opponent)}` : ""} · ${g.moves} moves${g.playedAt ? ` · played ${shortDate(g.playedAt)}` : ""}</div></div>
        <div class="num"><div class="t">~${g.rating}</div><div class="s">${g.accuracy}%</div></div>
        <button class="del" title="Delete review">🗑&#xFE0E;</button>
      </div>`;
    })
    .join("");
}
$("#history").onclick = async (e) => {
  const row = e.target.closest(".game");
  if (!row) return;
  if (e.target.closest(".del")) {
    if (!confirm("Delete this review? Its patterns are removed from your record too.")) return;
    await api(`/api/games/${row.dataset.id}`, { method: "DELETE" });
    renderHistory();
  } else location.hash = `game/${row.dataset.id}`;
};

// ------------------------------------------------------------------ review

const fmtEval = (pos) => {
  if (pos.mate != null) return pos.mate === 0 ? (pos.winner === "w" ? "1-0" : "0-1") : `${pos.mate > 0 ? "+" : "−"}M${Math.abs(pos.mate)}`;
  const v = pos.cp / 100;
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}`;
};
const moveName = (p) => `${p.moveNumber}${p.color === "w" ? "." : "…"} ${describeMove(p.san)}`;
const dot = (cls, sm) => `<span class="dot ${sm ? "sm" : ""} c-${cls}">${CLS[cls].sym}</span>`;

async function loadKnownPatterns() {
  state.knownPatterns = (await api("/api/profile").catch(() => ({ patterns: [] }))).patterns;
}

async function openGame(game, pending = false) {
  state.game = game;
  state.cur = 0;
  state.showBest = false;
  state.explore = null;
  state.sel = null;
  if (!pending && !game.coach) game.coach = { moves: [], turning_points: [], patterns: [], takeaways: [], notice: "The written review didn't finish for this game." };
  show("review");
  selectTab("walk");
  buildMoveList();
  drawGraph();
  renderReview();
  await loadKnownPatterns();
  renderReview();
}

function selectTab(name) {
  for (const b of $("#tabs").children) b.classList.toggle("on", b.dataset.tab === name);
  for (const t of ["walk", "overview", "patterns"]) $(`#tab-${t}`).hidden = t !== name;
}
$("#tabs").onclick = (e) => e.target.dataset.tab && selectTab(e.target.dataset.tab);

function go(k) {
  const n = state.game.analysis.plies.length;
  state.cur = Math.max(0, Math.min(n, k));
  state.showBest = false;
  state.explore = null;
  state.sel = null;
  renderPosition();
}
function jumpTo(ply) {
  selectTab("walk");
  go(ply);
}

document.querySelector(".controls").onclick = (e) => {
  const nav = e.target.dataset.nav;
  if (nav === "prev" && state.explore) return undoExplore();
  if (nav) go({ start: 0, prev: state.cur - 1, next: state.cur + 1, end: Infinity }[nav]);
};
$("#bestBtn").onclick = () => toggleBest();
function toggleBest() {
  if (state.explore) return exitExplore();
  state.sel = null;
  const p = state.game?.analysis.plies[state.cur - 1];
  if (!p || !p.bestUci) return;
  state.showBest = !state.showBest;
  renderPosition();
}
document.addEventListener("keydown", (e) => {
  if ($("#review").hidden || e.target.matches("textarea, input")) return;
  if (state.explore && e.key === "ArrowLeft") undoExplore();
  else if (state.explore && e.key === "ArrowRight") playBestExplore();
  else if (state.explore && e.key === "Escape") exitExplore();
  else if (e.key === "ArrowLeft") go(state.cur - 1);
  else if (e.key === "ArrowRight") go(state.cur + 1);
  else if (e.key === "ArrowUp" || e.key === "Home") go(0);
  else if (e.key === "ArrowDown" || e.key === "End") go(Infinity);
  else if (e.key.toLowerCase() === "b") toggleBest();
  else return;
  e.preventDefault();
});

function drawBoard(fen, { last, cls, arrows = [] } = {}) {
  const targets = state.sel ? new Chess(fen).moves({ square: state.sel, verbose: true }) : [];
  const flip = state.game.color === "b";
  const rows = fen.split(" ")[0].split("/");
  const at = {};
  rows.forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) f += Number(ch);
      else at["abcdefgh"[f++] + (8 - r)] = ch;
    }
  });
  const xy = (sq) => {
    const f = sq.charCodeAt(0) - 97;
    const rank = Number(sq[1]);
    return [flip ? 7 - f : f, flip ? rank - 1 : 8 - rank];
  };
  let html = "";
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const f = flip ? 7 - c : c;
      const rank = flip ? r + 1 : 8 - r;
      const sq = "abcdefgh"[f] + rank;
      const pc = at[sq];
      const hl = last && (sq === last.from || sq === last.to);
      const tgt = targets.find((m) => m.to === sq);
      html += `<div data-sq="${sq}" class="sq ${(f + rank) % 2 ? "dark" : ""} ${hl ? "hl" : ""} ${sq === state.sel ? "sel" : ""}" ${hl && cls ? `style="--hl:${CLS_COLOR(cls)}"` : ""}>
        ${c === 0 ? `<span class="coord rank">${rank}</span>` : ""}${r === 7 ? `<span class="coord file">${"abcdefgh"[f]}</span>` : ""}
        ${pc ? `<span class="pc ${pc === pc.toUpperCase() ? "w" : "b"}">${GLYPH[pc.toLowerCase()]}&#xFE0E;</span>` : ""}
        ${tgt ? `<span class="tgt ${tgt.captured ? "cap" : ""}"></span>` : ""}
        ${last && cls && sq === last.to ? `<span class="badge c-${cls}">${CLS[cls].sym}</span>` : ""}
      </div>`;
    }
  }
  if (arrows.length) {
    html += `<svg viewBox="0 0 8 8"><defs>${arrows.map((ar, i) => `<marker id="ah${i}" markerWidth="4" markerHeight="4" refX="2" refY="2" orient="auto"><path d="M0,0 L4,2 L0,4 z" fill="${ar.color}"/></marker>`).join("")}</defs>`;
    arrows.forEach((ar, i) => {
      const [x1, y1] = xy(ar.from).map((v) => v + 0.5);
      const [x2, y2] = xy(ar.to).map((v) => v + 0.5);
      const len = Math.hypot(x2 - x1, y2 - y1);
      const ex = x2 - ((x2 - x1) / len) * 0.3;
      const ey = y2 - ((y2 - y1) / len) * 0.3;
      html += `<line x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}" stroke="${ar.color}" stroke-width="0.17" stroke-linecap="round" opacity="0.9" marker-end="url(#ah${i})"/>`;
    });
    html += "</svg>";
  }
  $("#board").innerHTML = html;
}

function drawEvalBar(pos) {
  const bar = $("#evalbar");
  bar.classList.toggle("flip", state.game.color === "b");
  bar.querySelector("i").style.height = `${pos.wp}%`;
  const label = bar.querySelector("span");
  const whiteAhead = pos.wp >= 50;
  label.className = whiteAhead ? "w" : "b";
  label.textContent = pos.mate != null ? (pos.mate === 0 ? "#" : `M${Math.abs(pos.mate)}`) : Math.abs(pos.cp / 100).toFixed(1);
}

function drawGraph() {
  const { positions, plies } = state.game.analysis;
  const W = 400, H = 70, n = positions.length - 1 || 1;
  const x = (k) => (k / n) * W;
  const y = (wp) => H - (wp / 100) * H;
  const pts = positions.map((p, k) => `${x(k).toFixed(1)},${y(p.wp).toFixed(1)}`).join(" ");
  const marks = plies
    .filter((p) => ["blunder", "mistake", "miss", "brilliant", "great"].includes(p.cls))
    .map((p) => `<circle cx="${x(p.ply).toFixed(1)}" cy="${y(positions[p.ply].wp).toFixed(1)}" r="2.6" fill="${CLS_COLOR(p.cls)}" stroke="#1c1b19" stroke-width=".6" vector-effect="non-scaling-stroke"/>`)
    .join("");
  $("#graph").innerHTML = `<polygon points="0,${H} ${pts} ${W},${H}" fill="#f4f4f2"/>
    <line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" stroke="#8886" stroke-width="1" vector-effect="non-scaling-stroke"/>
    ${marks}<line id="cursor" y1="0" y2="${H}" stroke="#e6912c" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
}
$("#graph").parentElement.onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  go(Math.round(((e.clientX - r.left) / r.width) * state.game.analysis.plies.length));
};

function buildMoveList() {
  const { plies } = state.game.analysis;
  let html = "";
  for (let i = 0; i < plies.length; i += 2) {
    const alt = (i / 2) % 2 ? "row-alt" : "";
    html += `<div class="n ${alt}">${i / 2 + 1}.</div>`;
    for (const p of [plies[i], plies[i + 1]]) {
      html += p ? `<div class="mv ${alt} ${p.color === state.game.color ? "me" : ""}" data-ply="${p.ply}">${dot(p.cls, true)}${esc(p.san)}</div>` : `<div class="${alt}"></div>`;
    }
  }
  $("#movelist").innerHTML = html;
}
$("#movelist").onclick = (e) => {
  const mv = e.target.closest(".mv");
  if (mv) go(Number(mv.dataset.ply));
};

function renderPosition() {
  const g = state.game;
  const a = g.analysis;
  const k = state.cur;
  const p = a.plies[k - 1];
  if (state.explore) return renderExplore();
  if (state.showBest && p) {
    drawBoard(a.positions[k - 1].fen, { arrows: [{ from: p.bestUci.slice(0, 2), to: p.bestUci.slice(2, 4), color: GREEN }] });
    drawEvalBar(a.positions[k - 1]);
  } else {
    drawBoard(a.positions[k].fen, p ? { last: p, cls: p.cls } : {});
    drawEvalBar(a.positions[k]);
  }
  const best = $("#bestBtn");
  best.classList.toggle("on", state.showBest);
  best.textContent = state.showBest ? "Back to the game move" : "Show best move";
  best.disabled = !p?.bestUci;
  $("#cursor")?.setAttribute("x1", (k / (a.positions.length - 1 || 1)) * 400);
  $("#cursor")?.setAttribute("x2", (k / (a.positions.length - 1 || 1)) * 400);

  for (const el of $("#movelist").querySelectorAll(".mv.cur")) el.classList.remove("cur");
  const cur = $(`#movelist .mv[data-ply="${k}"]`);
  if (cur) {
    cur.classList.add("cur");
    const list = $("#movelist");
    const top = cur.offsetTop - list.offsetTop;
    if (top < list.scrollTop || top + cur.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top - list.clientHeight / 2;
  }

  // Comment panel
  const el = $("#comment");
  if (!p) {
    el.innerHTML = `<div class="head">${esc(a.opening ? a.opening.name : "Starting position")}</div>
      ${g.coach?.opening ? `<p>${esc(g.coach.opening)}</p>` : g.coach ? "" : `<p class="writing">Your coach is going through the game</p>`}
      ${g.coach && (g.coach.notice || g.coach.basic) ? `<p class="notice" style="margin:10px 0 0">${esc(g.coach.notice ?? "This game only has the engine review so far.")}<span class="notice-act" style="display:block">${recoachControl("Write the coaching now")}</span></p>` : ""}
      <p class="alt">Step through with ← → or click any move. Press B to see what the engine wanted. Click a piece on the board to try your own moves.</p>`;
    return;
  }
  const mine = p.color === g.color;
  const comment = g.coach?.moves.find((m) => m.ply === p.ply)?.comment;
  let body;
  if (comment) body = `<p>${esc(comment)}</p>`;
  else if (!g.coach && p.cls !== "book") body = `<p class="writing">Your coach is writing this up</p>`;
  else body = `<p class="muted">${esc(p.cls === "book" && a.opening ? `Opening theory — ${a.opening.name}.` : FALLBACK[p.cls])}</p>`;
  const alt = !p.isBest && p.cls !== "book" && p.bestSan ? `<div class="alt">Best was <b>${esc(p.bestWords ?? describeMove(p.bestSan))}</b>. Press B to see it on the board.</div>` : "";
  const tryHint = `<div class="alt">Want to test something else? Click a piece on the board and play it out.</div>`;
  el.innerHTML = `<div class="head">${dot(p.cls)}<span>${esc(moveName(p))} <span class="muted" style="font-weight:400">(${esc(p.san)})</span> <span class="t-${p.cls}">${mine ? "" : "(opponent) "}${CLS[p.cls].label.toLowerCase()}</span></span>
      <span class="ev">${fmtEval(a.positions[k - 1])} → ${fmtEval(a.positions[k])}</span></div>${body}${alt}${tryHint}`;
}

// ---------- Trying your own moves ----------
// Click a piece, click where it goes. The engine then shows the best move for whoever is to play (green)
// and the best reply to it (blue), so different ideas can be played out from any point in the game.

const GREEN = "#3f8f2c";
const BLUE = "#3b82c4";
const winPct = (s) => (s.mate != null ? (s.mate > 0 ? 100 : 0) : 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-1500, Math.min(1500, s.cp)))) - 1));
const uciMove = (u) => ({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });

// The position currently shown on the board.
function boardFen() {
  if (state.explore) return state.explore.nodes.at(-1).fen;
  const a = state.game.analysis;
  return a.positions[state.showBest && state.cur > 0 ? state.cur - 1 : state.cur].fen;
}

$("#board").onclick = (e) => {
  const sq = e.target.closest(".sq")?.dataset.sq;
  if (!sq || !state.game) return;
  const chess = new Chess(boardFen());
  if (state.sel) {
    const options = chess.moves({ square: state.sel, verbose: true }).filter((m) => m.to === sq);
    const mv = options.find((m) => !m.promotion || m.promotion === "q"); // pawns promote to a queen
    if (mv) return tryMove(mv);
  }
  const pc = chess.get(sq);
  state.sel = pc && pc.color === chess.turn() && sq !== state.sel ? sq : null;
  renderPosition();
};

function tryMove(mv) {
  if (!state.explore) {
    const a = state.game.analysis;
    const k = state.showBest && state.cur > 0 ? state.cur - 1 : state.cur;
    const pos = a.positions[k];
    state.explore = { nodes: [{ fen: pos.fen, ev: pos, best: a.plies[k]?.bestUci ?? null }] };
    state.showBest = false;
  }
  const prev = state.explore.nodes.at(-1);
  const chess = new Chess(prev.fen);
  let m;
  try {
    m = chess.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
  } catch {
    return;
  }
  const node = {
    fen: chess.fen(),
    move: { from: m.from, to: m.to, color: m.color, uci: m.from + m.to + (m.promotion ?? ""), words: lineWords(prev.fen, [m.san]).words[0] },
    over: chess.isCheckmate() ? "checkmate" : chess.isStalemate() ? "stalemate" : chess.isDraw() ? "draw" : null,
    ev: null,
    lines: null,
    best: null,
    error: null,
  };
  state.explore.nodes.push(node);
  state.sel = null;
  renderPosition();
  loadExplore(node);
}

async function loadExplore(node) {
  if (node.over) {
    node.lines = [];
    node.ev = node.over === "checkmate" ? { wp: node.move.color === "w" ? 100 : 0, mate: 0, winner: node.move.color } : { wp: 50, cp: 0 };
  } else {
    try {
      const { lines } = await api("/api/explore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fen: node.fen }) });
      const top = lines[0];
      if (!top) throw new Error("The engine had nothing to say about this position.");
      const sign = node.fen.split(" ")[1] === "w" ? 1 : -1;
      const x = winPct(top);
      node.ev = { wp: sign === 1 ? x : 100 - x, ...(top.mate != null ? { mate: top.mate * sign } : { cp: top.cp * sign }) };
      node.lines = lines.map((l) => ({ pv: l.pv, words: lineWords(node.fen, l.pv.map(uciMove), 2).words.map((w) => w.replace(/^(White|Black)'s /, "")) }));
      node.best = top.pv[0];
    } catch (err) {
      node.error = err.message;
    }
  }
  if (state.explore?.nodes.at(-1) === node) renderPosition();
}

function undoExplore() {
  if (!state.explore) return;
  state.explore.nodes.pop();
  state.sel = null;
  if (state.explore.nodes.length <= 1) state.explore = null;
  renderPosition();
}
function exitExplore() {
  state.explore = null;
  state.sel = null;
  renderPosition();
}
function playBestExplore() {
  const node = state.explore?.nodes.at(-1);
  if (node?.best) tryMove(uciMove(node.best));
}

function tryVerdict(prev, node) {
  if (node.over === "checkmate") return "Checkmate.";
  if (node.over) return `That ends the game in a draw (${node.over}).`;
  if (!node.ev || !prev.ev) return "";
  if (prev.best && prev.best === node.move.uci) return "That is the engine's top choice here.";
  const loss = node.move.color === "w" ? prev.ev.wp - node.ev.wp : node.ev.wp - prev.ev.wp;
  if (loss <= 2) return "As good as the engine's top choice.";
  if (loss <= 5) return "A fine move, slightly short of the best.";
  if (loss <= 10) return "A small slip compared with the best move.";
  if (loss <= 20) return "A mistake: this gives away a real chunk of the position.";
  return "A blunder: this changes who is winning.";
}

function renderExplore() {
  const g = state.game;
  const nodes = state.explore.nodes;
  const node = nodes.at(-1);
  const line = node.lines?.[0];
  const arrows = [];
  if (line?.pv[0]) arrows.push({ ...uciMove(line.pv[0]), color: GREEN });
  if (line?.pv[1]) arrows.push({ ...uciMove(line.pv[1]), color: BLUE });
  drawBoard(node.fen, { last: node.move, arrows });
  if (node.ev) drawEvalBar(node.ev);
  const best = $("#bestBtn");
  best.classList.add("on");
  best.textContent = "Back to the game";
  best.disabled = false;

  const toMove = node.fen.split(" ")[1];
  const mine = toMove === g.color;
  let engine;
  if (node.error) engine = `<p class="notice">${esc(node.error)}</p>`;
  else if (node.over) engine = "";
  else if (!line) engine = `<p class="writing">The engine is looking at this position</p>`;
  else {
    engine = `<p><span class="key" style="background:${GREEN}"></span>${mine ? "Your best move now" : "Your opponent's best move now"}: <b>${esc(line.words[0] ?? "")}</b></p>`;
    if (line.words[1]) engine += `<p><span class="key" style="background:${BLUE}"></span>${mine ? "Your opponent's best reply" : "Your best reply"}: <b>${esc(line.words[1])}</b></p>`;
  }
  const verdict = tryVerdict(nodes.at(-2), node);
  $("#comment").innerHTML = `<div class="head"><span>Trying your own moves</span><span class="ev">${node.ev ? fmtEval(node.ev) : "…"}</span></div>
    <ol class="tried">${nodes.slice(1).map((n) => `<li>${esc(n.move.words)}</li>`).join("")}</ol>
    ${verdict ? `<p>${esc(verdict)}</p>` : ""}${engine}
    <div class="ex-actions">
      <button class="btn" data-ex="undo">Take back (←)</button>
      <button class="btn" data-ex="best" ${node.best ? "" : "disabled"}>Play the best move (→)</button>
      <button class="btn" data-ex="exit">Back to the game (Esc)</button>
    </div>
    <div class="alt">Keep clicking pieces to play either side. Pawns promote to a queen.</div>`;
}
$("#comment").addEventListener("click", (e) => {
  const act = e.target.dataset?.ex;
  if (act === "undo") undoExplore();
  else if (act === "best") playBestExplore();
  else if (act === "exit") exitExplore();
});

// Button (or a pointer to the picker) for writing this game's coaching with the currently selected model.
function recoachControl(label, subtle = false) {
  if (!state.settings) return "";
  if (!canUse("coach")) {
    if (subtle) return "";
    const p = currentProvider();
    return p?.hasKey
      ? `<a href="#">Pick a coach model</a> on the home page, then come back to this game.`
      : `Add ${esc(p?.env ?? "an API key")} to the .env file and restart, then come back to this game. <a href="#">Model settings</a>`;
  }
  const model = esc(chosen("coach"));
  return subtle
    ? `<a href="#" data-action="recoach">${label} with ${model}</a>`
    : `<button class="btn" data-action="recoach">${label} with ${model}</button>`;
}

async function recoach() {
  const g = state.game;
  const before = g.coach;
  g.coach = null; // shows the "coach is writing" state everywhere
  renderReview();
  try {
    const coach = await api(`/api/games/${g.id}/coach`, { method: "POST" });
    if (state.game !== g) return (g.coach = coach);
    g.coach = coach;
    await loadKnownPatterns();
  } catch (err) {
    g.coach = { ...(before ?? { moves: [], turning_points: [], patterns: [], takeaways: [] }), notice: err.message };
  }
  if (state.game === g) renderReview();
}

function renderReview() {
  const g = state.game;
  const a = g.analysis;
  const me = g.color === "w" ? a.white : a.black;
  const opp = g.color === "w" ? a.black : a.white;
  const myName = (g.color === "w" ? g.players.white : g.players.black) || "You";
  const oppName = (g.color === "w" ? g.players.black : g.players.white) || "Opponent";
  const myElo = g.ratings?.[g.color === "w" ? "white" : "black"];
  const oppElo = g.ratings?.[g.color === "w" ? "black" : "white"];
  const tag = (s, elo) => `<span class="meta">${elo ? `rated ${elo} · ` : ""}played like ~${s.rating} · ${s.accuracy}% accuracy</span>`;
  $("#topPlayer").innerHTML = `<span>${esc(oppName)} <span class="muted">(${g.color === "w" ? "Black" : "White"})</span></span>${tag(opp, oppElo)}`;
  $("#bottomPlayer").innerHTML = `<span>${esc(myName)} <span class="muted">(${g.color === "w" ? "White" : "Black"})</span></span>${tag(me, myElo)}`;
  renderPosition();

  const c = g.coach;
  const order = ["brilliant", "great", "best", "excellent", "good", "book", "inaccuracy", "mistake", "miss", "blunder"];
  const phaseLine = (s) => Object.entries(s.phases).map(([ph, v]) => `${ph} ${v.accuracy}%`).join(" · ");
  const outcome = g.outcome ? { win: "You won", loss: "You lost", draw: "Draw" }[g.outcome] : "";
  $("#tab-overview").innerHTML = `
    ${c && (c.notice || c.basic) ? `<div class="notice">${esc(c.notice ?? "This game only has the engine review so far.")}
      <div class="notice-act">${recoachControl("Write the coaching now")}</div></div>` : ""}
    ${c ? `<div class="headline">${esc(c.headline ?? "")}</div><p>${esc(c.summary ?? "")}</p>` : `<p class="writing">Your coach is writing the review</p>`}
    <div class="cards">
      <div class="rcard"><div class="who">You played like</div><div class="big">~${me.rating}</div>
        ${myElo ? `<div class="sub">actual rating ${myElo}</div>` : ""}
        <div class="sub">${me.accuracy}% accuracy · ${me.confidence} estimate${outcome ? ` · ${outcome}` : ""}</div>
        <div class="sub">${phaseLine(me)}</div>${c?.student_rating_reason ? `<p>${esc(c.student_rating_reason)}</p>` : ""}</div>
      <div class="rcard"><div class="who">Opponent played like</div><div class="big">~${opp.rating}</div>
        ${oppElo ? `<div class="sub">actual rating ${oppElo}</div>` : ""}
        <div class="sub">${opp.accuracy}% accuracy · ${opp.confidence} estimate</div>
        <div class="sub">${phaseLine(opp)}</div>${c?.opponent_rating_reason ? `<p>${esc(c.opponent_rating_reason)}</p>` : ""}</div>
    </div>
    <p class="muted" style="font-size:12.5px;margin-top:-4px">"Played like" is an estimate from how closely each side's moves matched the engine in this one game. It swings a lot from game to game.</p>
    <h3>Opening</h3>
    <p><strong>${esc(a.opening ? `${a.opening.name} (${a.opening.eco})` : "Not in the opening book")}</strong>${a.bookPlies ? ` <span class="muted">· theory for ${Math.ceil(a.bookPlies / 2)} moves</span>` : ""}</p>
    ${c?.opening ? `<p>${esc(c.opening)}</p>` : ""}
    <h3>Move quality</h3>
    <table class="counts"><tr><th>You</th><th></th><th>Opponent</th></tr>
      ${order.map((k) => `<tr><td class="num t-${k}">${me.counts[k] ?? 0}</td><td class="mid">${dot(k, true)} ${CLS[k].label}</td><td class="num t-${k}">${opp.counts[k] ?? 0}</td></tr>`).join("")}
    </table>
    ${c?.turning_points?.length ? `<h3>Turning points</h3>${c.turning_points.map((t) => {
      const p = a.plies[t.ply - 1];
      return `<div class="tp" data-ply="${t.ply}"><div class="tt">${dot(p.cls, true)} ${esc(moveName(p))} — ${esc(t.title)}</div><p>${esc(t.explanation)}</p></div>`;
    }).join("")}` : ""}
    ${c?.takeaways?.length ? `<h3>What to work on</h3><ol class="take">${c.takeaways.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>` : ""}
    ${c?.model ? `<p class="muted" style="font-size:12.5px;margin-top:18px">Coaching written by ${esc(c.model)}. ${recoachControl("Redo it", true)}</p>` : ""}`;

  const pats = c?.patterns ?? [];
  $("#tab-patterns").innerHTML = !c
    ? `<p class="writing">Your coach is looking for patterns</p>`
    : (pats.length
        ? pats.map((p) => {
            const known = state.knownPatterns.find((k) => k.id === p.id);
            const times = known?.games ?? 1;
            return `<div class="pat"><div class="tt">${esc(p.name)} <span class="pill ${p.kind}">${p.kind}</span>${times > 1 ? `<span class="pill rec">seen in ${times} games</span>` : ""}</div>
              <p>${esc(p.description)}</p>${p.in_this_game ? `<p><strong>In this game:</strong> ${esc(p.in_this_game)}</p>` : ""}<p class="advice">${esc(p.advice)}</p>
              <div class="plies">${p.plies.map((ply) => `<button class="chip" data-ply="${ply}">${esc(moveName(a.plies[ply - 1]))}</button>`).join("")}</div></div>`;
          }).join("")
        : `<p class="muted">${c.basic || c.notice ? "Pattern tracking needs the written review (a model and API key)." : "No clear patterns in this game."}</p>`) +
      `<p><a href="#profile">See your patterns across all games →</a></p>`;
}
$("#comment").onclick = $("#tab-overview").onclick = $("#tab-patterns").onclick = (e) => {
  if (e.target.closest('[data-action="recoach"]')) {
    e.preventDefault();
    return recoach();
  }
  const t = e.target.closest("[data-ply]");
  if (t) jumpTo(Number(t.dataset.ply));
};

// ------------------------------------------------------------------ profile

const shortDate = (d) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
// A game named by who it was against and how it went, e.g. "W vs magnus".
function gameChip(o) {
  const r = o.outcome === "win" ? "W" : o.outcome === "loss" ? "L" : o.outcome === "draw" ? "D" : "";
  const who = o.opponent ? `vs ${esc(o.opponent)}` : esc(o.opening?.split(":")[0] ?? "Pasted game");
  return `${r ? `<b class="t-${o.outcome === "win" ? "best" : o.outcome === "loss" ? "blunder" : "book"}">${r}</b> ` : ""}${who}`;
}

async function renderProfile() {
  const { stats, patterns } = await api("/api/profile");
  const el = $("#profile");
  if (!stats.games) return (el.innerHTML = `<div class="card"><h1>My patterns</h1><p class="muted">Review a game first — your habits get tracked here from one game to the next.</p></div>`);
  const TAGS = { "hung-piece": "Left a piece hanging", "missed-capture": "Missed a free capture", "missed-mate": "Missed a forced mate", "allowed-mate": "Walked into a forced mate" };
  const PIECES = { p: "Pawn", n: "Knight", b: "Bishop", r: "Rook", q: "Queen", k: "King" };
  const maxPiece = Math.max(1, ...Object.values(stats.errorsByPiece));
  const patHtml = (kind) =>
    patterns.filter((p) => p.kind === kind).map((p) => `<div class="pat"><div class="tt">${esc(p.name)} <span class="pill rec">${p.games} game${p.games === 1 ? "" : "s"}</span></div>
      <p>${esc(p.description)}</p><p class="advice">${esc(p.advice)}</p>
      <div class="plies">${p.occurrences.slice(0, 8).map((o) => `<a class="chip" href="#game/${esc(o.gameId)}" title="${esc(o.note ?? "")}">${gameChip(o)}</a>`).join("")}${p.occurrences.length > 8 ? `<span class="muted" style="font-size:12.5px;align-self:center">+ ${p.occurrences.length - 8} earlier</span>` : ""}</div></div>`).join("") || `<p class="muted">Nothing recorded yet.</p>`;
  el.innerHTML = `
    <h1>My patterns</h1><p class="muted">Built from ${stats.games} reviewed game${stats.games === 1 ? "" : "s"}.</p>
    <div class="stat-row">
      <div class="rcard"><div class="who">Typically play like</div><div class="big">~${stats.avgRating}</div></div>
      <div class="rcard"><div class="who">Average accuracy</div><div class="big">${stats.avgAccuracy}%</div></div>
      <div class="rcard"><div class="who">Record</div><div class="big">${stats.record.win}–${stats.record.loss}–${stats.record.draw}</div><div class="sub">wins – losses – draws</div></div>
    </div>
    <div class="review-grid" style="grid-template-columns:1fr 1fr">
      <div><h3>Recurring weaknesses</h3>${patHtml("weakness")}<h3>Strengths</h3>${patHtml("strength")}</div>
      <div>
        <div class="card"><h2>Accuracy by phase</h2><div class="bars">
          ${["opening", "middlegame", "endgame"].filter((ph) => stats.phases[ph]).map((ph) => `<span>${ph[0].toUpperCase() + ph.slice(1)}</span><div class="track"><i style="width:${stats.phases[ph].accuracy}%"></i></div><span class="v">${stats.phases[ph].accuracy}%</span>`).join("")}
        </div></div>
        ${Object.keys(stats.tags).length ? `<div class="card"><h2>How errors happen</h2><table class="plain">${Object.entries(stats.tags).sort((x, y) => y[1] - x[1]).map(([t, n]) => `<tr><td>${TAGS[t] ?? esc(t)}</td><td style="text-align:right;font-weight:700">${n}×</td></tr>`).join("")}</table></div>` : ""}
        ${Object.keys(stats.errorsByPiece).length ? `<div class="card"><h2>Mistakes by piece moved</h2><div class="bars">
          ${Object.entries(stats.errorsByPiece).sort((x, y) => y[1] - x[1]).map(([pc, n]) => `<span>${PIECES[pc]}</span><div class="track"><i style="width:${(n / maxPiece) * 100}%;background:var(--mistake)"></i></div><span class="v">${n}</span>`).join("")}
        </div></div>` : ""}
        <div class="card"><h2>Openings</h2><table class="plain"><tr><th>Opening</th><th>Games</th><th>W–L–D</th><th>Accuracy</th></tr>
          ${Object.entries(stats.openings).sort((x, y) => y[1].games - x[1].games).map(([name, o]) => `<tr><td>${esc(name)}</td><td>${o.games}</td><td>${o.win}–${o.loss}–${o.draw}</td><td>${o.accuracy}%</td></tr>`).join("")}
        </table></div>
        <div class="card"><h2>Game by game</h2><table class="plain"><tr><th>Game</th><th>Played like</th><th>Accuracy</th></tr>
          ${stats.trend.map((t) => `<tr style="cursor:pointer" onclick="location.hash='game/${esc(t.id)}'"><td>${gameChip(t)}${t.played ? ` <span class="muted">· ${shortDate(t.date)}</span>` : ""}</td><td>~${t.rating}</td><td>${t.accuracy}%</td></tr>`).join("")}
        </table></div>
      </div>
    </div>`;
}

// ------------------------------------------------------------------ boot

api("/api/settings").then((settings) => {
  state.settings = settings;
  renderSettings();
  if (state.game) renderReview(); // the review's "write the coaching" control depends on the settings
  loadModels();
});
try {
  const saved = new URLSearchParams(location.search).get("user") || localStorage.getItem("ccUser");
  if (saved) {
    $("#ccUser").value = saved;
    loadCcGames();
  }
} catch {}
route();
