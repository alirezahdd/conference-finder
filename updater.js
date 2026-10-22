/* Conference Finder — pulls deadlines from the community-maintained ccf-deadlines dataset
 * (https://github.com/ccfddl/ccf-deadlines) and merges them into the entries of data.js.
 * Runs in the browser (window.CFUpdater) and in Node (module.exports) so it can be tested offline. */
(function (root) {
  "use strict";

  const SOURCE = "https://ccfddl.com/conference/allconf.yml";
  const SOURCE_PAGE = "https://ccfddl.com/";
  const YAML_LIB = "https://cdnjs.cloudflare.com/ajax/libs/js-yaml/4.1.0/js-yaml.min.js";
  // Our conference name -> ccf-deadlines title, where they differ.
  const TITLES = { ATC: "SIGOPS ATC", CGO: "IEEE/ACM CGO", ESOP: "ETAPS", TACAS: "ETAPS" };
  const MATCH_DAYS = 45; // a ccf cycle and one of ours are the same cycle if their deadlines are this close

  const DAY = 86400000;
  const dayOf = (s) => (s ? Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY : null);
  const isoOfDay = (n) => new Date(n * DAY).toISOString().slice(0, 10);
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

  // UTC offset (hours) of a ccf timezone on a given date; null means AoE.
  function offsetOf(tz, date) {
    if (!tz || tz === "AoE" || tz === "UTC-12") return null;
    if (tz === "UTC") return 0;
    const m = /^UTC([+-]\d+(?:\.\d+)?)$/.exec(tz);
    if (m) return Number(m[1]);
    if (tz === "PT" || tz === "ET") {
      // US daylight time: second Sunday of March to first Sunday of November.
      const y = +date.slice(0, 4);
      const sunday = (month, nth) => { const d = new Date(Date.UTC(y, month, 1)); return Date.UTC(y, month, 1 + ((7 - d.getUTCDay()) % 7) + 7 * (nth - 1)) / DAY; };
      const dst = dayOf(date) >= sunday(2, 2) && dayOf(date) < sunday(10, 1);
      return (tz === "PT" ? -8 : -5) + (dst ? 1 : 0);
    }
    return undefined; // unknown zone: keep the date only
  }

  // "2026-11-16 23:59:59" in timezone tz -> { date, time?, utcOffset? } in data.js terms.
  function when(stamp, tz) {
    if (!stamp) return null;
    const s = String(stamp);
    const date = s.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const off = offsetOf(tz, date);
    if (off == null) return { date };
    return { date, time: s.slice(11, 16) || "23:59", utcOffset: off };
  }

  // "June 5-9, 2027", "October 30-November 1, 2023", "August 23 - August 27, 2027" -> [start, end]
  function confDates(text) {
    const m = /^\s*([A-Za-z]+)\.?\s+(\d{1,2})\s*(?:[-–]\s*(?:([A-Za-z]+)\.?\s+)?(\d{1,2}))?\s*,\s*(\d{4})\s*$/.exec(String(text || ""));
    if (!m) return null;
    const month = (name) => MONTHS.findIndex((x) => x.startsWith(name.toLowerCase().slice(0, 3)));
    const m1 = month(m[1]);
    const m2 = m[3] ? month(m[3]) : m1;
    if (m1 < 0 || m2 < 0) return null;
    const y = +m[5];
    const iso = (mo, d) => isoOfDay(Date.UTC(y, mo, +d) / DAY);
    return [iso(m1, m[2]), iso(m2, m[4] || m[2])];
  }

  // Flatten ccf-deadlines into one record per submission cycle, keyed by our conference names.
  function cyclesFrom(ccf, names) {
    const byTitle = new Map(ccf.map((c) => [String(c.title).toLowerCase(), c]));
    const out = new Map();
    for (const name of names) {
      const conf = byTitle.get((TITLES[name] || name).toLowerCase());
      if (!conf) continue;
      const cycles = [];
      for (const ed of conf.confs || []) {
        const timeline = ed.timeline || [];
        const dates = confDates(ed.date);
        for (const t of timeline) {
          const deadline = when(t.deadline, ed.timezone);
          if (!deadline) continue;
          cycles.push({
            year: ed.year, multi: timeline.length > 1, comment: t.comment || "", link: ed.link || null, place: ed.place || null,
            deadline, abstract: when(t.abstract_deadline, ed.timezone),
            rebuttalEnd: when(t.rebuttal_deadline, ed.timezone), notification: when(t.decision_deadline, ed.timezone),
            confStart: dates && dates[0], confEnd: dates && dates[1],
          });
        }
      }
      out.set(name, cycles);
    }
    return out;
  }

  const fmtVal = (v) => (v == null || v === "" ? "—" : String(v));

  // Instant (ms) a deadline passes: 23:59 AoE unless a time and UTC offset are given.
  const instant = (date, time, utcOffset) => {
    if (utcOffset == null) return dayOf(date) * DAY + (24 * 60 - 1) * 60000 + 12 * 3600000;
    const [h, m] = (time || "23:59").split(":").map(Number);
    return dayOf(date) * DAY + (h * 60 + m) * 60000 - utcOffset * 3600000;
  };
  const SAME_INSTANT_MS = 2 * 3600000; // closer than this: the same deadline written in another zone

  /* Merge ccf cycles into our entries. Returns { entries, changes, kept, added, missing }.
   * Policy: entries marked "confirmed" in data.js come from the official CFP, so they keep their values,
   * except that a later paper/abstract deadline (an extension) is applied; other disagreements are
   * listed in `kept`. Entries that are "partial" or "estimated" take ccf-deadlines' values. Empty
   * fields are always filled. Cycles newer than anything in data.js are added. */
  function merge(raw, ccf) {
    const names = [...new Set(raw.map((c) => c.name))];
    const cycles = cyclesFrom(ccf, names);
    const entries = raw.map((c) => ({ ...c }));
    const changes = [];
    const kept = [];
    const added = [];
    const label = (c) => `${c.name} ${c.year}${c.cycle ? ` (${c.cycle})` : ""}`;
    const apply = (c, field, from, to) => {
      changes.push({ id: c.id, label: label(c), field, from: fmtVal(from), to: fmtVal(to) });
      c.updated = [...(c.updated || []), field];
    };
    const set = (c, field, value) => {
      if (value == null || value === c[field]) return;
      if (c[field] && c.status === "confirmed") {
        kept.push({ id: c.id, label: label(c), field, ours: c[field], theirs: value });
        return;
      }
      apply(c, field, c[field], value);
      c[field] = value;
    };
    // Paper and abstract deadlines: compare instants, and accept extensions even on confirmed entries.
    const setDeadline = (c, field, k) => {
      if (!k) return;
      if (!c[field]) { apply(c, field, null, k.date); c[field] = k.date; return; }
      const ours = instant(c[field], c.time, c.utcOffset);
      const theirs = instant(k.date, k.time, k.utcOffset);
      if (Math.abs(theirs - ours) < SAME_INSTANT_MS) return;
      if (c.status === "confirmed" && theirs < ours) {
        kept.push({ id: c.id, label: label(c), field, ours: c[field], theirs: k.date });
        return;
      }
      apply(c, field, c[field], k.date + (theirs > ours && c.status === "confirmed" ? " (extended)" : ""));
      c[field] = k.date;
      if (field === "deadline") {
        if (k.utcOffset == null) { delete c.time; delete c.utcOffset; } else { c.time = k.time; c.utcOffset = k.utcOffset; }
      }
    };

    for (const [name, list] of cycles) {
      const ours = entries.filter((c) => c.name === name && c.deadline);
      const latest = Math.max(...ours.map((c) => dayOf(c.deadline)));
      // Pair ccf cycles with ours, closest deadlines first, so monthly cycles do not slip by one.
      const pairs = [];
      list.forEach((k, i) => ours.forEach((c) => {
        const gap = Math.abs(dayOf(c.deadline) - dayOf(k.deadline.date));
        if (gap <= MATCH_DAYS) pairs.push({ i, c, gap });
      }));
      pairs.sort((a, b) => a.gap - b.gap);
      const matchOf = new Map();
      const used = new Set();
      for (const p of pairs) if (!matchOf.has(p.i) && !used.has(p.c)) { matchOf.set(p.i, p.c); used.add(p.c); }

      list.forEach((k, i) => {
        const D = dayOf(k.deadline.date);
        const c = matchOf.get(i);
        if (c) {
          setDeadline(c, "deadline", k.deadline);
          setDeadline(c, "abstract", k.abstract);
          set(c, "rebuttalEnd", k.rebuttalEnd && k.rebuttalEnd.date);
          set(c, "notification", k.notification && k.notification.date);
          if (!c.confStart) { set(c, "confStart", k.confStart); set(c, "confEnd", k.confEnd); }
          if (!c.location) set(c, "location", k.place);
          if (!c.url) set(c, "url", k.link);
          if (c.updated && c.status === "estimated") c.status = "partial";
        } else if (D > latest) {
          // A cycle newer than anything in data.js (e.g. next year's CFP is out): add it.
          const tmpl = ours[ours.length - 1] || {};
          const month = new Date(D * DAY).toLocaleDateString("en-GB", { month: k.multi && list.filter((x) => x.year === k.year).length > 3 ? "short" : "long", timeZone: "UTC" });
          const day = new Date(D * DAY).getUTCDate();
          const c = {
            id: `${name.toLowerCase()}${String(k.year).slice(2)}-ccf-${k.deadline.date}`, name, fullName: tmpl.fullName, year: k.year,
            cycle: k.multi ? (month.length <= 3 ? `${month} ${day}` : month) : undefined, areas: tmpl.areas || [],
            abstract: k.abstract && k.abstract.date, deadline: k.deadline.date,
            ...(k.deadline.utcOffset != null ? { time: k.deadline.time, utcOffset: k.deadline.utcOffset } : {}),
            rebuttalStart: null, rebuttalEnd: k.rebuttalEnd && k.rebuttalEnd.date, notification: k.notification && k.notification.date,
            confStart: k.confStart, confEnd: k.confEnd, location: k.place, url: k.link, status: "partial", added: true,
            notes: `Added from ccf-deadlines${k.comment ? ` (${k.comment})` : ""}. That dataset has no rebuttal start or early-reject dates; check the CFP.`,
          };
          entries.push(c);
          added.push({ id: c.id, label: label(c), deadline: c.deadline });
        }
      });
    }
    const missing = names.filter((n) => !cycles.has(n));
    return { entries, changes, kept, added, missing };
  }

  // Browser: load js-yaml on demand, download the dataset and parse it.
  function loadYamlLib() {
    if (root.jsyaml) return Promise.resolve(root.jsyaml);
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = YAML_LIB;
      s.onload = () => resolve(root.jsyaml);
      s.onerror = () => reject(new Error("could not load the YAML parser"));
      document.head.appendChild(s);
    });
  }
  async function fetchDataset() {
    const [yaml, res] = await Promise.all([loadYamlLib(), fetch(SOURCE, { cache: "no-cache" })]);
    if (!res.ok) throw new Error(`ccf-deadlines answered ${res.status}`);
    return yaml.load(await res.text());
  }

  // Only the records for our conferences, small enough to cache in the browser.
  const subset = (ccf, names) => {
    const wanted = new Set(names.map((n) => (TITLES[n] || n).toLowerCase()));
    return ccf.filter((c) => wanted.has(String(c.title).toLowerCase()));
  };

  const api = { SOURCE, SOURCE_PAGE, merge, subset, fetchDataset, confDates, when };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CFUpdater = api;
})(typeof window !== "undefined" ? window : globalThis);
