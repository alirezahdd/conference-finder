/* Conference Finder — plain JS, no build step. Data comes from data.js (window.CONFERENCES). */
(() => {
  "use strict";

  const DAY = 86400000;
  const AOE_OFFSET = 12 * 3600000; // AoE = UTC-12
  const TIGHT_DAYS = 14;

  // ---------- date helpers ----------
  // Day index (days since epoch) for a "YYYY-MM-DD" string; null-safe.
  const dayOf = (s) => {
    if (!s) return null;
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d) / DAY;
  };
  // Instant at which a date's 23:59 AoE passes.
  const aoeEnd = (s) => dayOf(s) * DAY + (23 * 60 + 59) * 60000 + AOE_OFFSET;
  // Instant at which a submission deadline of cycle c passes (honours c.time / c.utcOffset).
  const dueAt = (c, s) => {
    if (c.utcOffset == null) return aoeEnd(s);
    const [h, m] = (c.time || "23:59").split(":").map(Number);
    return dayOf(s) * DAY + (h * 60 + m) * 60000 - c.utcOffset * 3600000;
  };
  const tzLabel = (c) => (c.utcOffset == null ? " AoE" : ` ${c.time || "23:59"} UTC${c.utcOffset < 0 ? "−" : "+"}${Math.abs(c.utcOffset)}`);
  const fmt = (s, withYear = true) => {
    if (!s) return "—";
    const d = new Date(dayOf(s) * DAY);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: withYear ? "numeric" : undefined, timeZone: "UTC" });
  };
  const fmtRange = (a, b) => (!a ? "—" : !b || a === b ? fmt(a) : `${fmt(a, false)} – ${fmt(b)}`);
  const isoOfDay = (n) => new Date(n * DAY).toISOString().slice(0, 10);
  const addYear = (s) => (s ? `${Number(s.slice(0, 4)) + 1}${s.slice(4)}` : null);
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  const now = () => Date.now();
  const todayIso = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  // Time left until an instant, for tooltips.
  function countdown(instant) {
    const ms = instant - now();
    if (ms <= 0) return "closed";
    const d = Math.floor(ms / DAY);
    const h = Math.floor((ms % DAY) / 3600000);
    return d > 0 ? `${d}d ${h}h left` : `${h}h ${Math.floor((ms % 3600000) / 60000)}m left`;
  }

  // ---------- storage (per-viewer convenience only) ----------
  const store = {
    get(k, fallback) {
      try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  // ---------- state ----------
  const BASE = (window.CONFERENCES || []).map((c) => ({ ...c, areas: c.areas || [] }));

  // For every conference/cycle whose latest known deadline has passed, add an estimated
  // next edition (+1 year, +2 for biennial) so the rejection plan can still suggest it.
  function withProjections(list) {
    const latest = new Map();
    for (const c of list) {
      if (!c.deadline) continue;
      const key = `${c.name}|${c.cycle || ""}`;
      if (!latest.has(key) || dayOf(c.deadline) > dayOf(latest.get(key).deadline)) latest.set(key, c);
    }
    const shift = (s, n) => (s ? `${Number(s.slice(0, 4)) + n}${s.slice(4)}` : null);
    const projected = [];
    for (const c of latest.values()) {
      if (dueAt(c, c.deadline) > Date.now()) continue;
      const n = c.biennial ? 2 : 1;
      // The next edition has no site yet: link to the series homepage, not last year's page.
      const p = { ...c, id: `${c.id}-proj`, year: c.year ? c.year + n : null, status: "estimated", projected: true, updated: undefined, added: undefined,
        url: (window.SERIES_HOMEPAGES || {})[c.name] || c.url,
        notes: `Projected from the ${c.year ?? "previous"} dates (+${n} yr). Check the official CFP once it is out.` };
      for (const k of ["abstract", "deadline", "rebuttalStart", "rebuttalEnd", "earlyReject", "notification", "confStart", "confEnd"]) p[k] = shift(c[k], n);
      projected.push(p);
    }
    return [...list, ...projected];
  }
  // ---------- updates from ccf-deadlines (see updater.js) ----------
  const UPD = window.CFUpdater;
  // { fetchedAt, data }: ccf-deadlines records for our conferences. The weekly GitHub Action commits a
  // snapshot (data-ccf.js); a viewer's own "Check for updates" result wins when it is newer.
  const newer = (a, b) => (!a ? b : !b ? a : a.fetchedAt >= b.fetchedAt ? a : b);
  let sync = store.get("cf-ccf-off", false) ? null : newer(store.get("cf-ccf", null), window.CCF_SNAPSHOT || null);
  let merged = null; // result of merging `sync` into data.js: { entries, changes, kept, added, missing }
  let ALL, AREAS;
  // Conferences ccf-deadlines does not cover: their dates are only as current as data.js.
  let MANUAL = new Set();
  function applySync() {
    merged = null;
    if (sync && UPD) {
      try { merged = UPD.merge(BASE, sync.data); } catch { sync = null; } // unreadable cache: fall back to data.js
    }
    const coverage = (sync || window.CCF_SNAPSHOT || {}).data;
    MANUAL = new Set(coverage && UPD ? UPD.missingFrom(coverage, [...new Set(BASE.map((c) => c.name))]) : []);
    ALL = withProjections(merged ? merged.entries : BASE);
    AREAS = [...new Set(ALL.flatMap((c) => c.areas))].sort();
  }
  applySync();
  const savedPlan = store.get("cf-plan", {});
  const state = {
    query: "",
    areas: new Set(store.get("cf-areas", [])),
    showPast: false,
    onlyStarred: false,
    stars: new Set(store.get("cf-stars", [])),
    tlPick: new Set(store.get("cf-tlpick", [])), // conference names picked for the timeline; empty = use filters
    tlOpen: store.get("cf-tlopen", false), // conference picker expanded
    planId: savedPlan.id || null, // cycle you submitted to; null = no rejection scenario
    planMode: savedPlan.mode === "early" ? "early" : "final", // decide on the final notification or the early-reject notice
  };
  const savePlan = () => store.set("cf-plan", { id: state.planId, mode: state.planMode });

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const label = (c) => `${c.name} ${c.year}${c.cycle ? ` (${c.cycle})` : ""}`;
  const isClosed = (c) => dueAt(c, c.deadline) < now();

  function filtered({ ignorePast = false } = {}) {
    const q = state.query.trim().toLowerCase();
    return ALL.filter((c) => {
      if (!c.deadline) return false;
      if (!ignorePast && !state.showPast && isClosed(c)) return false;
      if (state.onlyStarred && !state.stars.has(c.id)) return false;
      if (state.areas.size && !c.areas.some((a) => state.areas.has(a))) return false;
      if (q) {
        const hay = `${c.name} ${c.fullName} ${c.cycle || ""} ${c.areas.join(" ")} ${c.location || ""} ${c.year}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  const byDeadline = (a, b) => dayOf(a.deadline) - dayOf(b.deadline);

  // ---------- "if rejected" scenario ----------
  const planCandidates = () => ALL.filter((c) => c.notification && c.deadline).sort(byDeadline);

  function planDecisionDate(c) {
    if (state.planMode === "early" && c.earlyReject) return c.earlyReject;
    return c.notification;
  }

  // The cycle you submitted to, its deadline (S), the day the decision arrives (N) and,
  // if it has a rebuttal, the day you could withdraw once you have seen the reviews: the rebuttal's second day (W); null if none picked.
  function planContext() {
    const sel = state.planId && planCandidates().find((c) => c.id === state.planId);
    if (!sel) return null;
    if (state.planMode === "early" && !sel.earlyReject) state.planMode = "final";
    const decision = planDecisionDate(sel);
    const N = dayOf(decision);
    const W = sel.rebuttalStart && dayOf(sel.rebuttalStart) + 1 < N ? dayOf(sel.rebuttalStart) + 1 : null;
    return { sel, decision, S: dayOf(sel.deadline), N, W };
  }

  // What leaving p.sel on day `free` (decision or withdrawal) means for cycle c.
  function planStatus(c, p, free, when) {
    if (c.id === p.sel.id) return { cls: "sel", text: "submitted here" };
    const D = dayOf(c.deadline);
    const A = dayOf(c.abstract);
    if (D <= p.S) return { cls: "before", text: "" }; // closed before you even submitted
    if (D <= free) {
      return { cls: "missed", text: "missed",
        tip: `${label(c)} closes ${plural(free - D, "day")} before ${when} (no dual submission). Next edition ≈ ${fmt(addYear(c.deadline))} (est.)` };
    }
    const slack = D - free;
    const abstractFirst = A !== null && A <= free;
    const tip = `${label(c)}: ${plural(slack, "day")} between ${when} and the paper deadline (${fmt(c.deadline)})` +
      (abstractFirst ? `. The abstract (${fmt(c.abstract)}) is due before then; register it speculatively if the CFP allows.` : ".");
    if (slack > 330) return { cls: "far", text: `${slack} d`, tip }; // ~a year out: not a meaningful plan B
    return { cls: slack < TIGHT_DAYS || abstractFirst ? "tight" : "open", text: `${slack} d to revise${abstractFirst ? " ⚠" : ""}`, tip };
  }

  // One-line summary shown only while a submission is ticked.
  function planSummary(p, statuses) {
    if (!p) return "";
    const { sel, decision } = p;
    const counts = (key) => {
      const n = (cls) => statuses.filter((s) => s[key].cls === cls).length;
      return `<span class="pc open">${n("open")} still open</span>
        <span class="pc tight" title="Under ${TIGHT_DAYS} days to revise, or the abstract is due before you are free">${n("tight")} tight</span>
        <span class="pc missed">${n("missed")} missed</span>`;
    };
    const saved = p.W ? statuses.filter((s) => s.rej.cls === "missed" && s.wd.cls !== "missed").length : 0;
    return `
      <div class="plan-summary">
        <span class="ps-label">If rejected from <b>${esc(label(sel))}</b> on ${fmt(decision)}${sel.status !== "confirmed" ? ` <span class="badge ${esc(sel.status)}">${esc(sel.status)}</span>` : ""}:</span>
        ${counts("rej")}
        ${sel.earlyReject ? `<label class="toggle"><input type="checkbox" id="planEarly" ${state.planMode === "early" ? "checked" : ""}> use early-reject notice (${fmt(sel.earlyReject)})</label>` : ""}
        <button class="linkish" data-planclear>clear</button>
      </div>
      ${p.W ? `<div class="plan-summary">
        <span class="ps-label">If withdrawn on day 2 of the rebuttal (${fmt(isoOfDay(p.W))}):</span>
        ${counts("wd")}
        <span class="hint">${saved ? `withdrawing makes ${plural(saved, "missed deadline")} reachable` : "withdrawing does not save any missed deadline"}</span>
      </div>` : ""}`;
  }

  // ---------- timeline ----------
  function timelinePicker() {
    const names = [...new Set(ALL.map((c) => c.name))].sort((a, b) => a.localeCompare(b));
    const picked = state.tlPick.size;
    const open = state.tlOpen;
    // Collapsed, the header says what is shown; expanded, it explains how the selection works.
    const pickedList = [...state.tlPick].sort((a, b) => a.localeCompare(b));
    const summary = picked
      ? `${picked} selected: ${esc(pickedList.slice(0, 6).join(", "))}${picked > 6 ? ", …" : ""}`
      : "All conferences matching the filters above.";
    const hint = picked
      ? `${picked} selected. The area, search and starred filters are ignored while a selection is active.`
      : "None selected, so the filters above decide. Click names to choose exactly which to show.";
    return `
      <div class="tl-picker ${open ? "open" : ""}">
        <div class="tl-picker-head">
          <button class="tl-toggle" data-tltoggle aria-expanded="${open}"><span class="caret"></span><b>Conferences on the timeline</b></button>
          <span class="hint">${open ? hint : summary}</span>
          <span class="tl-picker-actions">
            ${open ? `<button class="linkish" data-tlaction="matching" title="Add every conference that matches the current filters">+ add matching filters</button>
            <button class="linkish" data-tlaction="starred">+ add starred</button>` : ""}
            ${picked ? `<button class="linkish" data-tlaction="clear">clear selection</button>` : ""}
            ${open ? "" : `<button class="linkish" data-tltoggle>choose…</button>`}
          </span>
        </div>
        ${open ? `<div class="chips">${names.map((n) => {
          const fullName = ALL.find((c) => c.name === n).fullName || "";
          return `<button class="chip ${state.tlPick.has(n) ? "on" : ""}" data-tlpick="${esc(n)}" title="${esc(fullName)}">${esc(n)}</button>`;
        }).join("")}</div>` : ""}
      </div>`;
  }

  function renderTimeline() {
    const p = planContext();
    // While a rejection scenario is active, deadlines that close during your review stay visible even if past.
    const keep = (c) => state.showPast || !isClosed(c) || (p && (c.id === p.sel.id || (dayOf(c.deadline) > p.S && dayOf(c.deadline) <= p.N)));
    const base = state.tlPick.size ? ALL.filter((c) => c.deadline && state.tlPick.has(c.name)) : filtered({ ignorePast: true });
    const items = base.filter(keep);
    if (p && !items.includes(p.sel)) items.push(p.sel);
    items.sort(byDeadline);
    const statuses = p ? items.map((c) => ({
      rej: planStatus(c, p, p.N, "your decision"),
      wd: p.W ? planStatus(c, p, p.W, "withdrawing on day 2 of the rebuttal") : null,
    })) : [];

    const el = $("#timeline");
    if (!items.length) {
      el.innerHTML = `${timelinePicker()}<div class="empty">${state.tlPick.size ? "The selected conferences have no open deadlines (tick “Show closed deadlines”)." : "No conferences match these filters."}</div>`;
      return;
    }
    const today = dayOf(todayIso());
    const allDays = items.flatMap((c) => [c.abstract, c.deadline, c.notification, c.confEnd || c.confStart].filter(Boolean).map(dayOf));
    // Start at the first of the current month: months that have passed are not shown (earlier marks are clipped).
    const maxDay = Math.max(today + 300, ...allDays);
    const start = new Date(today * DAY);
    const startDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1) / DAY;
    const end = new Date(maxDay * DAY);
    const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 1) / DAY;
    const span = endDay - startDay;
    const pct = (s) => `${((dayOf(s) - startDay) / span) * 100}%`;
    const pctDay = (d) => `${((d - startDay) / span) * 100}%`;

    const months = [];
    for (let d = new Date(startDay * DAY); d.getTime() / DAY < endDay; d.setUTCMonth(d.getUTCMonth() + 1)) {
      months.push({ day: d.getTime() / DAY, label: d.toLocaleDateString("en-GB", { month: "short", year: d.getUTCMonth() === 0 ? "2-digit" : undefined, timeZone: "UTC" }) });
    }
    const grid = months.map((m) => `<div class="tl-grid" style="left:${pctDay(m.day)}"></div>`).join("");
    const todayLine = `<div class="tl-today" style="left:${pctDay(today)}" title="Today"></div>`;
    const lock = p
      ? `<div class="tl-lock" style="left:${pctDay(p.S)};width:${((p.N - p.S) / span) * 100}%"></div><div class="tl-decision" style="left:${pctDay(p.N)}"></div>${p.W ? `<div class="tl-decision wd" style="left:${pctDay(p.W)}"></div>` : ""}`
      : "";
    const cell = (s, head) => `<div class="tl-plan ${s ? s.cls : ""}" ${s && s.tip ? `data-tip="${esc(s.tip)}"` : ""}>${s ? esc(s.text) : head}</div>`;
    const planCell = (s) => (p ? cell(s && s.rej, "If rejected") + (p.W ? cell(s && s.wd, "If withdrawn") : "") : "");

    const mark = (cls, date, tip) => (date ? `<div class="tl-mark ${cls}" style="left:${pct(date)}" data-tip="${esc(tip)}"></div>` : "");
    const rows = items.map((c, i) => {
      const s = statuses[i];
      const bar = c.notification
        ? `<div class="tl-bar" style="left:${pct(c.deadline)};width:calc(${pct(c.notification)} - ${pct(c.deadline)})"></div>`
        : "";
      const reb = c.rebuttalStart
        ? `<div class="tl-rebut" style="left:${pct(c.rebuttalStart)};width:max(3px, calc(${pct(c.rebuttalEnd || c.rebuttalStart)} - ${pct(c.rebuttalStart)}))" data-tip="${esc(`${label(c)} rebuttal: ${fmtRange(c.rebuttalStart, c.rebuttalEnd)}`)}"></div>`
        : "";
      const left = (date) => (isClosed(c) ? "" : ` (${countdown(dueAt(c, date))})`);
      return `
        <div class="tl-row ${isClosed(c) ? "dim" : ""} ${state.stars.has(c.id) ? "highlight" : ""} ${s ? `plan-${s.rej.cls === "missed" && s.wd && s.wd.cls !== "missed" ? "saved" : s.rej.cls}` : ""}">
          <div class="tl-label" title="${esc(c.fullName || "")}">${c.notification
            ? `<input type="checkbox" class="sub" data-plan="${esc(c.id)}" ${p && p.sel.id === c.id ? "checked" : ""} title="I submitted here: show what is left if rejected">`
            : `<span class="sub"></span>`}<button class="star ${state.stars.has(c.id) ? "on" : ""}" data-star="${esc(c.id)}" title="Star: mark as a target">★</button>${MANUAL.has(c.name) ? `<span class="manual" data-tip="${esc(`${c.name} is not in ccf-deadlines, so its dates are never updated automatically. They are as of ${window.DATA_UPDATED ? fmt(window.DATA_UPDATED) : "the last edit of data.js"}; check the call for papers.`)}">!</span>` : ""}${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener" title="${c.url === (window.SERIES_HOMEPAGES || {})[c.name] ? `Series homepage: no ${c.name} ${c.year} site yet` : `${c.name} ${c.year} homepage`}">${esc(c.name)} ${String(c.year).slice(2)}</a>` : `${esc(c.name)} ${String(c.year).slice(2)}`}${c.cycle ? ` <small>${esc(c.cycle)}</small>` : ""}${c.status === "estimated" ? ` <small>(est.)</small>` : ""}${c.added ? ` <small class="upd" data-tip="${esc(`Added from ccf-deadlines. ${c.notes || ""}`)}">new</small>` : c.updated ? ` <small class="upd" data-tip="${esc(`Updated from ccf-deadlines: ${c.updated.join(", ")}`)}">updated</small>` : ""}</div>
          <div class="tl-track">${grid}${lock}${todayLine}${bar}${reb}
            ${mark("ab", c.abstract, `${label(c)} abstract: ${fmt(c.abstract)}${tzLabel(c)}${left(c.abstract)}`)}
            ${mark("dl", c.deadline, `${label(c)} paper deadline: ${fmt(c.deadline)}${tzLabel(c)}${left(c.deadline)}`)}
            ${c.earlyReject ? mark("nt", c.earlyReject, `${label(c)} early-reject notice: ${fmt(c.earlyReject)}`) : ""}
            ${mark("nt", c.notification, `${label(c)} notification: ${fmt(c.notification)}`)}
            ${mark("cf", c.confStart, `${label(c)} conference: ${fmtRange(c.confStart, c.confEnd)}${c.location ? ` · ${c.location}` : ""}`)}
          </div>
          ${planCell(s)}
        </div>`;
    }).join("");

    el.innerHTML = `
      ${timelinePicker()}
      <div class="tl-legend">
        <span><i class="sw" style="background:var(--bad)"></i>Paper deadline (faint: abstract)</span>
        <span><i class="sw" style="background:var(--review);opacity:.45"></i>Under review</span>
        <span><i class="sw" style="background:var(--rebut)"></i>Rebuttal</span>
        <span><i class="sw" style="background:var(--review);transform:rotate(45deg);width:9px;height:9px"></i>Notification</span>
        <span><i class="sw" style="background:var(--conf);border-radius:50%;width:9px;height:9px"></i>Conference</span>
        <span><i class="sw" style="background:var(--bad);width:2px;height:12px"></i>Today</span>
        ${items.some((c) => MANUAL.has(c.name)) ? `<span><span class="manual">!</span>Not in ccf-deadlines, never auto-updated: check the CFP</span>` : ""}
        ${p ? `<span><i class="sw" style="background:var(--lock);border:1px solid var(--accent)"></i>Your paper in review → decision</span>${p.W ? `<span><i class="sw" style="border-left:2px dashed var(--rebut);width:2px;height:12px;border-radius:0"></i>Withdraw (rebuttal day 2)</span>` : ""}` : `<span><input type="checkbox" disabled style="margin:0"> Tick where you submitted to see what is left if rejected</span>`}
      </div>
      ${planSummary(p, statuses)}
      <div class="tl-wrap"><div class="tl ${p ? (p.W ? "with-plan2" : "with-plan") : ""}">
        <div class="tl-row tl-head"><div class="tl-label"></div><div class="tl-track">
          ${months.map((m) => `<div class="tl-month" style="left:${pctDay(m.day)}">${m.label}</div>`).join("")}
        </div>${planCell(null)}</div>
        ${rows}
      </div></div>`;
  }

  // ---------- update check ----------
  function renderSyncLine() {
    const checked = sync ? ` · checked against ccf-deadlines ${fmt(sync.fetchedAt.slice(0, 10))}` : "";
    const n = merged ? merged.changes.length + merged.added.length : 0;
    $("#syncLine").textContent = `data: ${window.DATA_UPDATED ? fmt(window.DATA_UPDATED) : "—"}${checked}${n ? ` (${plural(n, "update")})` : ""}`;
  }

  function showReport(err) {
    const el = $("#syncReport");
    const src = `<a href="${UPD.SOURCE_PAGE}" target="_blank" rel="noopener">ccf-deadlines</a>`;
    if (err) {
      el.innerHTML = `<div class="sync-report bad"><b>Could not check for updates.</b> ${esc(err.message || err)}. You may be offline; the dates shown are unchanged.
        <button class="linkish close" data-syncclose title="Close">×</button></div>`;
      return;
    }
    const { changes, kept, added, missing } = merged;
    const li = (t) => `<li>${t}</li>`;
    const nice = (v) => (/^\d{4}-\d{2}-\d{2}/.test(v) ? `${fmt(v.slice(0, 10))}${v.slice(10)}` : esc(v));
    el.innerHTML = `
      <div class="sync-report">
        <button class="linkish close" data-syncclose title="Close">×</button>
        <b>Checked against ${src}.</b>
        ${changes.length || added.length
          ? `${changes.length ? plural(changes.length, "date") + " updated" : ""}${changes.length && added.length ? ", " : ""}${added.length ? plural(added.length, "new cycle") + " added" : ""}.`
          : "Everything matches; nothing to update."}
        ${changes.length || added.length ? `<ul>${[
          ...added.map((a) => li(`<b>${esc(a.label)}</b>: new cycle, paper deadline ${fmt(a.deadline)}`)),
          ...changes.map((c) => li(`<b>${esc(c.label)}</b> ${esc(c.field)}: ${nice(c.from)} → ${nice(c.to)}`)),
        ].join("")}</ul>` : ""}
        ${kept.length ? `<details><summary>${plural(kept.length, "difference")} kept: data.js has these from the official CFP</summary><ul>${
          kept.map((k) => li(`<b>${esc(k.label)}</b> ${esc(k.field)}: data.js ${nice(k.ours)} · ccf-deadlines ${nice(k.theirs)}`)).join("")}</ul></details>` : ""}
        ${missing.length ? `<p class="hint">Not in ccf-deadlines, so not checked: ${esc(missing.join(", "))}.</p>` : ""}
        ${sync ? `<button class="linkish" data-syncreset>Undo: use data.js only</button>` : ""}
      </div>`;
  }

  async function checkUpdates() {
    const btn = $("#checkUpdates");
    btn.disabled = true;
    btn.textContent = "Checking…";
    try {
      const ccf = await UPD.fetchDataset();
      sync = { fetchedAt: new Date().toISOString(), data: UPD.subset(ccf, [...new Set(BASE.map((c) => c.name))]) };
      store.set("cf-ccf", sync);
      store.set("cf-ccf-off", false);
      applySync();
      showReport();
    } catch (err) {
      showReport(err);
    } finally {
      btn.disabled = false;
      btn.textContent = "Check for updates";
      renderSyncLine();
      render();
    }
  }

  // ---------- .ics export ----------
  function exportIcs() {
    const items = filtered();
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const ev = (c, kind, date) => {
      if (!date) return "";
      const d = date.replace(/-/g, "");
      const next = isoOfDay(dayOf(date) + 1).replace(/-/g, "");
      return [
        "BEGIN:VEVENT",
        `UID:${c.id}-${kind.replace(/\W+/g, "-").toLowerCase()}@conference-finder`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${d}`,
        `DTEND;VALUE=DATE:${next}`,
        `SUMMARY:${label(c)} — ${kind}${c.status === "estimated" ? " (estimated)" : ""}`,
        c.url ? `URL:${c.url}` : "",
        "END:VEVENT",
      ].filter(Boolean).join("\r\n");
    };
    const body = items.flatMap((c) => [
      ev(c, "abstract deadline (AoE)", c.abstract),
      ev(c, "paper deadline (AoE)", c.deadline),
      ev(c, "rebuttal opens", c.rebuttalStart),
      ev(c, "notification", c.notification),
    ]).filter(Boolean);
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Conference Finder//EN", ...body, "END:VCALENDAR"].join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
    a.download = "conference-deadlines.ics";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- wiring ----------
  const render = renderTimeline;

  function init() {
    $("#today").textContent = fmt(todayIso());
    $("#areaChips").innerHTML = AREAS.map((a) => `<button class="chip ${state.areas.has(a) ? "on" : ""}" data-area="${esc(a)}">${esc(a)}</button>`).join("");

    $("#search").oninput = (e) => { state.query = e.target.value; render(); };
    $("#showPast").onchange = (e) => { state.showPast = e.target.checked; render(); };
    $("#onlyStarred").onchange = (e) => { state.onlyStarred = e.target.checked; render(); };
    $("#exportIcs").onclick = exportIcs;
    if (UPD) $("#checkUpdates").onclick = checkUpdates;
    else $("#checkUpdates").hidden = true;
    renderSyncLine();
    $("#syncReport").addEventListener("click", (e) => {
      if (e.target.closest("[data-syncclose]")) $("#syncReport").innerHTML = "";
      else if (e.target.closest("[data-syncreset]")) {
        sync = null;
        store.set("cf-ccf-off", true); // also ignore the committed snapshot until the next check
        try { localStorage.removeItem("cf-ccf"); } catch { /* ignore */ }
        applySync();
        $("#syncReport").innerHTML = "";
        renderSyncLine();
        render();
      }
    });
    $("#areaChips").onclick = (e) => {
      const b = e.target.closest("[data-area]");
      if (!b) return;
      const a = b.dataset.area;
      state.areas.has(a) ? state.areas.delete(a) : state.areas.add(a);
      b.classList.toggle("on");
      store.set("cf-areas", [...state.areas]);
      render();
    };

    // "Submitted here" boxes and the early-reject toggle are re-rendered with the timeline, so listen on the container.
    $("#timeline").addEventListener("change", (e) => {
      if (e.target.dataset.plan) {
        // Only one submission at a time: ticking a box replaces the previous one.
        state.planId = e.target.checked ? e.target.dataset.plan : null;
        state.planMode = "final";
      } else if (e.target.id === "planEarly") state.planMode = e.target.checked ? "early" : "final";
      else return;
      savePlan();
      render();
    });

    document.body.addEventListener("click", (e) => {
      const star = e.target.closest("[data-star]");
      if (star) {
        const id = star.dataset.star;
        state.stars.has(id) ? state.stars.delete(id) : state.stars.add(id);
        store.set("cf-stars", [...state.stars]);
        render();
        return;
      }
      if (e.target.closest("[data-tltoggle]")) {
        state.tlOpen = !state.tlOpen;
        store.set("cf-tlopen", state.tlOpen);
        render();
        return;
      }
      const pick = e.target.closest("[data-tlpick]");
      const tlAction = e.target.closest("[data-tlaction]");
      if (pick || tlAction) {
        if (pick) {
          const n = pick.dataset.tlpick;
          state.tlPick.has(n) ? state.tlPick.delete(n) : state.tlPick.add(n);
        } else if (tlAction.dataset.tlaction === "clear") {
          state.tlPick.clear();
        } else {
          const src = tlAction.dataset.tlaction === "starred" ? ALL.filter((c) => state.stars.has(c.id)) : filtered();
          src.forEach((c) => state.tlPick.add(c.name));
        }
        store.set("cf-tlpick", [...state.tlPick]);
        render();
        return;
      }
      if (e.target.closest("[data-planclear]")) {
        state.planId = null;
        state.planMode = "final";
        savePlan();
        render();
      }
    });

    // Tooltips for timeline marks.
    const tip = $("#tooltip");
    document.addEventListener("mousemove", (e) => {
      const t = e.target.closest("[data-tip]");
      if (!t) { tip.hidden = true; return; }
      tip.textContent = t.dataset.tip;
      tip.hidden = false;
      const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
      tip.style.left = `${x}px`;
      tip.style.top = `${e.clientY + 14}px`;
    });

    render();
  }

  init();
})();
