# Conference Finder

Deadline tracker for top conferences in computer architecture, systems, programming languages, formal verification, software engineering and testing, embedded/real-time systems and security.
No install, no server: **open `index.html` in a browser.**

## Using it

- **Timeline**: Gantt-style view of every submission cycle: abstract → paper deadline → review → rebuttal → notification → conference. Hover a mark for its date and time left. Click a name to open its CFP; star (★) the cycles you target.
- **If rejected…**: tick the box in front of the conference you submitted to. The timeline shades the period your paper is locked in review, and the "If rejected" column tags every other row (missed rows are tinted red):
  - **Still open**: the deadline is after your decision, with the number of days you have to revise;
  - **Tight**: under 14 days, or the abstract is due before you hear back (⚠);
  - **Missed**: the deadline closes while your paper is under review (dual submission is not allowed).

  If the conference has a rebuttal, an "If withdrawn" column shows the same thing for withdrawing on the second day of the rebuttal (once you have read the reviews). Rows that are missed if rejected but reachable if you withdraw are tinted orange instead of red.
  If the conference sends early-reject notices, the summary line lets you use that date instead of the final notification.

Filters (area chips, search, starred-only) apply to the timeline. **Export .ics** downloads the visible deadlines to import into your calendar.

## Check for updates

The **Check for updates** button downloads the community-maintained [ccf-deadlines](https://github.com/ccfddl/ccf-deadlines) dataset straight from the browser (no server needed) and merges it into the dates from `data.js`:

- Entries marked `confirmed` in `data.js` keep their dates; only a **later** paper/abstract deadline (an extension) is applied. Other disagreements are listed in the report as "kept" so you can check them.
- `partial` and `estimated` entries take the ccf-deadlines dates; empty fields are filled in.
- A cycle newer than anything in `data.js` (e.g. next year's CFP) is added. Its rebuttal start is unknown, so check the CFP.
- CC and ISLPED are not in ccf-deadlines and are never updated this way.

The result is saved in your browser only (rows show an `updated`/`new` tag); **Undo: use data.js only** in the report discards it. The merge logic lives in `updater.js`.

## Hosting and the weekly update

The site is plain static files, served by GitHub Pages from the `main` branch. Every Monday the **Update deadlines** GitHub Action (`.github/workflows/update-deadlines.yml`) runs `scripts/update-ccf.mjs`. The script downloads ccf-deadlines and, if anything changed, commits `data-ccf.js`, a snapshot the page merges on load with the same rules as the button. `data.js` itself is never edited by the bot. To run it by hand, open the Actions tab, choose **Update deadlines** and click **Run workflow**. The run summary lists what changed.

## Updating data

All hand-curated data lives in `data.js`. Each entry is one submission cycle:

```js
{
  id: "asplos27-fall", name: "ASPLOS", fullName: "...", year: 2027, cycle: "Fall",
  areas: ["Architecture", "OS/Systems"],
  abstract: "2026-..", deadline: "2026-..",       // YYYY-MM-DD, AoE
  rebuttalStart: null, rebuttalEnd: null,
  earlyReject: null,                              // optional: first-round reject notice
  notification: "2027-..",
  confStart: "2027-..", confEnd: "2027-..", location: "...",
  url: "https://...", status: "confirmed" | "partial" | "estimated", notes: "..."
}
```

`estimated` dates are projected from the previous edition, so check them against the official CFP before relying on them.
