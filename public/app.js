const COLUMNS = [
  { id: "applied", title: "Applied", statuses: ["applied", "submitted"] },
  { id: "screening", title: "Screening", statuses: ["screening", "recruiter", "phone"] },
  { id: "interview", title: "Interview", statuses: ["interview", "onsite", "final"] },
  { id: "closed", title: "Closed / offer", statuses: ["offer", "rejected", "withdrawn", "closed"] },
];

const ALL_STATUSES = [
  "applied",
  "screening",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
];

const state = {
  snapshot: null,
  token: "",
  ingestUrl: "",
  view: "home",
  metricsPanel: "overview",
};

const PAGE_TITLES = {
  home: "Welcome, Carter",
  metrics: "Metrics",
  connect: "Connect bots",
  about: "About",
};

const PAGE_SUBS = {
  home: "Your live pipeline from Job Tracker, LinkedIn Job Bot, and Job Email Bot.",
  metrics: "Rates, mix, and company concentration across applications and suggestions.",
  connect: "Wire Grok Bot into this board with local ingest or a JSON drop.",
  about: "How to run Command Center as the desk for your search.",
};

function $(id) {
  return document.getElementById(id);
}

function fmt(iso) {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function normalizeStatus(status) {
  const value = (status || "applied").toLowerCase();
  if (COLUMNS.some((col) => col.statuses.includes(value))) return value;
  return "applied";
}

function matchesFilter(row, q) {
  if (!q) return true;
  const blob = [row.title, row.company, row.location, row.status, row.source]
    .join(" ")
    .toLowerCase();
  return blob.includes(q);
}

function renderStats(snapshot, q) {
  const apps = (snapshot.applications || []).filter((row) => matchesFilter(row, q));
  const open = apps.filter((row) => !["rejected", "withdrawn", "closed"].includes(normalizeStatus(row.status))).length;
  const interviews = apps.filter((row) => ["interview", "onsite", "final"].includes(normalizeStatus(row.status))).length;
  const suggestions = (snapshot.suggestions || []).length;
  const last = Object.values(snapshot.bots || {})
    .map((bot) => bot.lastSyncAt)
    .filter(Boolean)
    .sort()
    .at(-1);

  $("stats").innerHTML = [
    ["Open applications", open],
    ["In interview", interviews],
    ["LinkedIn suggestions", suggestions],
  ]
    .map(
      ([label, value]) =>
        `<article class="stat"><b>${value}</b><span>${label}</span></article>`
    )
    .join("");

  $("updated").textContent = snapshot.updatedAt
    ? `Synced ${fmt(snapshot.updatedAt)}`
    : "Waiting for first sync";
}

function renderBots(snapshot) {
  $("nav-bots").innerHTML = Object.entries(snapshot.bots || {})
    .map(([id, bot]) => {
      const synced = Boolean(bot.lastSyncAt);
      return `<article class="bot ${synced ? "is-live" : "is-idle"}" title="${escapeHtml(bot.label || id)}">
        <span class="dot"></span>
        <div>
          <b>${escapeHtml(bot.label || id)}</b>
          <span>${synced ? `${bot.records || 0} · ${fmt(bot.lastSyncAt)}` : "Not synced"}</span>
        </div>
      </article>`;
    })
    .join("");
}

function card(row, extra = "") {
  const title = row.title || "Untitled role";
  const company = row.company || "Unknown company";
  const location = row.location || "";
  const detail = [row.matchReason, row.notes].filter(Boolean).join(" ");
  const link = row.url
    ? `<a href="${row.url}" target="_blank" rel="noreferrer">Posting</a>`
    : "";
  const more = detail
    ? `<details><summary>Notes</summary><p>${escapeHtml(detail)}</p></details>`
    : "";
  return `<article class="card">
    <h4>${escapeHtml(title)}</h4>
    <p>${escapeHtml(company)}${location ? ` · ${escapeHtml(location)}` : ""}</p>
    ${link}
    ${more}
    ${extra}
  </article>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderPipeline(snapshot, q) {
  const apps = (snapshot.applications || []).filter((row) => matchesFilter(row, q));
  $("pipeline").innerHTML = COLUMNS.map((col) => {
    const rows = apps.filter((row) => col.statuses.includes(normalizeStatus(row.status)));
    const body =
      rows.length === 0
        ? `<p class="empty">Nothing here yet.</p>`
        : rows
            .map((row) => {
              const options = ALL_STATUSES.map(
                (status) =>
                  `<option value="${status}" ${
                    normalizeStatus(row.status) === status ? "selected" : ""
                  }>${status}</option>`
              ).join("");
              return card(
                row,
                `<div class="row-actions"><select data-id="${escapeHtml(row.id)}">${options}</select></div>`
              );
            })
            .join("");
    return `<div class="column"><h3>${col.title} (${rows.length})</h3>${body}</div>`;
  }).join("");

  $("pipeline").querySelectorAll("select").forEach((select) => {
    select.addEventListener("change", async () => {
      await fetch(`/api/applications/${select.dataset.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: select.value }),
      });
      await load();
    });
  });
}

function renderSuggestions(snapshot) {
  const rows = snapshot.suggestions || [];
  $("suggestions").innerHTML =
    rows.length === 0
      ? `<p class="empty">LinkedIn Job Bot has not sent suggestions yet. Use Connect bots to push a scrape.</p>`
      : rows
          .map((row) => {
            const id = escapeHtml(row.id);
            const canApply = Boolean(row.url);
            const applyBtn = canApply
              ? `<button class="btn-apply" data-apply="${id}" type="button">Apply</button>`
              : `<button class="btn-apply" data-apply="${id}" type="button" title="No posting URL — will mark as applied">Apply</button>`;
            return card(
              row,
              `<div class="row-actions">
                ${applyBtn}
                <button class="btn-quiet" data-dismiss="${id}" type="button">Remove</button>
              </div>`
            );
          })
          .join("");

  $("suggestions").querySelectorAll("[data-apply]").forEach((button) => {
    button.addEventListener("click", async () => {
      const res = await fetch("/api/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: button.dataset.apply }),
      });
      const body = await res.json();
      if (body.url) {
        window.open(body.url, "_blank", "noopener,noreferrer");
      }
      await load();
    });
  });

  $("suggestions").querySelectorAll("[data-dismiss]").forEach((button) => {
    button.addEventListener("click", async () => {
      await fetch("/api/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: button.dataset.dismiss }),
      });
      await load();
    });
  });
}

function isNoiseEvent(row) {
  const title = `${row.title || ""} ${row.kind || ""} ${row.detail || ""}`.toLowerCase();
  return title.includes("hourly") && title.includes("outcome check");
}

function renderEvents(snapshot) {
  const rows = (snapshot.events || []).filter((row) => !isNoiseEvent(row));
  $("events").innerHTML =
    rows.length === 0
      ? `<p class="empty">Email and tracker events will land here.</p>`
      : rows
          .slice(0, 12)
          .map(
            (row) => `<article class="card">
              <p class="muted">${fmt(row.at)} · ${escapeHtml(row.source || "")}</p>
              <h4>${escapeHtml(row.title || row.kind || "Update")}</h4>
              <p>${escapeHtml(row.detail || "")}</p>
            </article>`
          )
          .join("");
}

function botPrompt(name, bot, extra) {
  return `You are ${name} syncing into Job Command Center on Carter's Mac.

Use Execution on Local Computer (not the cloud computer terminal). The dashboard only listens on this machine.

POST JSON to ${state.ingestUrl}
Header: X-Ingest-Token: ${state.token}

Payload shape:
{
  "bot": "${bot}",
  "applications": [
    {
      "title": "",
      "company": "",
      "location": "",
      "url": "",
      "status": "applied|screening|interview|offer|rejected|withdrawn",
      "appliedAt": "ISO-8601",
      "lastUpdateAt": "ISO-8601",
      "notes": ""
    }
  ],
  "suggestions": [],
  "events": [
    { "title": "", "detail": "", "at": "ISO-8601" }
  ]
}

${extra}

If HTTP is blocked, write the same JSON to:
/Users/carterlawhorn/Projects/job-command-center/data/inbox/${bot}-$(date +%Y%m%dT%H%M%S).json

Sync now with everything you currently know, then keep the board current after each run.`;
}

function renderConnect() {
  $("ingest-url").textContent = state.ingestUrl;
  $("ingest-token").textContent = state.token;
  $("prompt-tracker").textContent = botPrompt(
    "Job Tracker",
    "job_tracker",
    "Send every application and its latest status. Prefer URL as the stable identity."
  );
  $("prompt-linkedin").textContent = botPrompt(
    "LinkedIn Job Bot",
    "linkedin_job_bot",
    "Put scraped / recommended roles in suggestions. If you already applied, put them in applications instead of suggestions."
  );
  $("prompt-email").textContent = botPrompt(
    "Job Email Bot",
    "job_email_bot",
    "Turn recruiter and ATS emails into application status updates and events. Map rejection, interview, and offer language into status."
  );
}

function pct(n, d) {
  if (!d) return "—";
  return `${Math.round((n / d) * 100)}%`;
}

function countBy(rows, fn) {
  const map = new Map();
  rows.forEach((row) => {
    const key = fn(row);
    map.set(key, (map.get(key) || 0) + 1);
  });
  return map;
}

function topEntries(map, n = 8) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([label, value]) => ({ label, value }));
}

function weekStart(date) {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d;
}

function weekKey(date) {
  const d = weekStart(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function locationBucket(row) {
  const loc = (row.location || "").toLowerCase();
  if (!loc.trim()) return "Unspecified";
  if (loc.includes("remote")) return "Remote";
  if (loc.includes("hybrid")) return "Hybrid";
  return "On-site / other";
}

function hbars(items, emptyText) {
  if (!items.length) return `<p class="empty">${emptyText}</p>`;
  const max = Math.max(...items.map((item) => item.value), 1);
  return items
    .map(
      (item) => `<div class="hbar">
        <span class="hbar-label">${escapeHtml(item.label)}</span>
        <span class="hbar-track" aria-hidden="true"><span class="hbar-fill" style="width:${(item.value / max) * 100}%"></span></span>
        <span class="hbar-value">${item.value}</span>
      </div>`
    )
    .join("");
}

function donut(items) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (!total) return `<p class="empty">No applications yet.</p>`;
  const r = 42;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const colors = ["#1f6feb", "#12171c", "#1f7a4d", "#b45309", "#5c6770", "#7c5cbf"];
  const slices = items
    .filter((item) => item.value > 0)
    .map((item, i) => {
      const len = (item.value / total) * circ;
      const gap = circ - len;
      const el = `<circle cx="56" cy="56" r="${r}" fill="none" stroke="${colors[i % colors.length]}" stroke-width="16" stroke-dasharray="${len} ${gap}" stroke-dashoffset="${-offset}"></circle>`;
      offset += len;
      return { el, item, color: colors[i % colors.length] };
    });
  const legend = slices
    .map(
      (slice) => `<li><span class="swatch" style="background:${slice.color}"></span>${escapeHtml(slice.item.label)} · ${slice.item.value} (${pct(slice.item.value, total)})</li>`
    )
    .join("");
  return `<div class="donut-wrap">
    <svg class="donut" viewBox="0 0 112 112" role="img" aria-label="Application status mix">
      ${slices.map((slice) => slice.el).join("")}
      <text x="56" y="52" text-anchor="middle" class="donut-total">${total}</text>
      <text x="56" y="68" text-anchor="middle" class="donut-sub">apps</text>
    </svg>
    <ul class="legend">${legend}</ul>
  </div>`;
}

function weekChart(points) {
  if (!points.some((p) => p.value)) return `<p class="empty">No applied dates in the last 8 weeks.</p>`;
  const w = 360;
  const h = 140;
  const padL = 28;
  const padB = 28;
  const padT = 16;
  const max = Math.max(...points.map((p) => p.value), 1);
  const innerW = w - padL - 8;
  const innerH = h - padT - padB;
  const barW = innerW / points.length - 6;
  const bars = points
    .map((p, i) => {
      const x = padL + i * (innerW / points.length) + 3;
      const bh = (p.value / max) * innerH;
      const y = padT + innerH - bh;
      return `<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(bh, p.value ? 2 : 0)}" rx="3" fill="#1f6feb"></rect>
        <text x="${x + barW / 2}" y="${h - 8}" text-anchor="middle" class="axis">${p.label}</text>
        <text x="${x + barW / 2}" y="${y - 4}" text-anchor="middle" class="axis-val">${p.value || ""}</text>`;
    })
    .join("");
  return `<svg class="week-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Applications by week">
    <line x1="${padL}" y1="${padT + innerH}" x2="${w - 8}" y2="${padT + innerH}" stroke="#e2e7eb"></line>
    ${bars}
  </svg>`;
}

function lastEightWeeks(apps) {
  const now = weekStart(new Date());
  const weeks = [];
  for (let i = 7; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    weeks.push({ key: weekKey(d), label: `${d.getMonth() + 1}/${d.getDate()}`, value: 0 });
  }
  const index = Object.fromEntries(weeks.map((w, i) => [w.key, i]));
  apps.forEach((row) => {
    if (!row.appliedAt) return;
    const parsed = new Date(row.appliedAt);
    if (Number.isNaN(parsed.getTime())) return;
    const key = weekKey(parsed);
    if (index[key] != null) weeks[index[key]].value += 1;
  });
  return weeks;
}

function renderMetrics(snapshot) {
  const apps = snapshot.applications || [];
  const suggestions = snapshot.suggestions || [];
  const n = apps.length;
  const statusCounts = ALL_STATUSES.map((status) => ({
    label: status,
    value: apps.filter((row) => normalizeStatus(row.status) === status).length,
  }));
  const interviews = apps.filter((row) => ["interview", "onsite", "final"].includes(normalizeStatus(row.status))).length;
  const screening = apps.filter((row) => ["screening", "recruiter", "phone"].includes(normalizeStatus(row.status))).length;
  const offers = apps.filter((row) => normalizeStatus(row.status) === "offer").length;
  const rejected = apps.filter((row) => normalizeStatus(row.status) === "rejected").length;
  const withdrawn = apps.filter((row) => normalizeStatus(row.status) === "withdrawn").length;
  const open = apps.filter((row) => !["rejected", "withdrawn", "closed"].includes(normalizeStatus(row.status))).length;

  $("metrics-kpis").innerHTML = [
    ["Applications", n],
    ["Open", `${open} (${pct(open, n)})`],
    ["Interview rate", pct(interviews, n)],
    ["Rejection rate", pct(rejected, n)],
    ["Suggestions", suggestions.length],
    ["Sug. → applied", pct(n, n + suggestions.length)],
  ]
    .map(([label, value]) => `<article class="stat"><b>${value}</b><span>${label}</span></article>`)
    .join("");

  $("chart-status").innerHTML = hbars(statusCounts, "No applications yet.");
  $("chart-mix").innerHTML = donut(statusCounts);
  $("chart-weeks").innerHTML = weekChart(lastEightWeeks(apps));
  $("chart-funnel").innerHTML = hbars(
    [
      { label: "LinkedIn suggestions", value: suggestions.length },
      { label: "Applications", value: n },
      { label: "Screening+", value: screening + interviews + offers },
      { label: "Interview+", value: interviews + offers },
      { label: "Offer", value: offers },
      { label: "Rejected / withdrawn", value: rejected + withdrawn },
    ],
    "No funnel data yet."
  );
  $("chart-companies").innerHTML = hbars(
    topEntries(countBy(apps, (row) => row.company || "Unknown")),
    "No companies yet."
  );
  $("chart-suggested-companies").innerHTML = hbars(
    topEntries(countBy(suggestions, (row) => row.company || "Unknown")),
    "No suggestions yet."
  );
  $("chart-location").innerHTML = hbars(
    topEntries(countBy(apps, locationBucket), 4),
    "No location data yet."
  );
  $("chart-volume").innerHTML = hbars(
    [
      { label: "Open suggestions", value: suggestions.length },
      { label: "Applications", value: n },
    ],
    "No volume data yet."
  );
}

function setMetricsPanel(panel) {
  state.metricsPanel = panel;
  document.querySelectorAll(".subtab").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.metrics === panel);
  });
  document.querySelectorAll("[data-metrics-panel]").forEach((el) => {
    el.classList.toggle("is-active", el.dataset.metricsPanel === panel);
  });
}

function setView(view) {
  if (!PAGE_TITLES[view]) view = "home";
  state.view = view;
  $("home-view").classList.toggle("hidden", view !== "home");
  $("metrics-view").classList.toggle("hidden", view !== "metrics");
  $("connect-view").classList.toggle("hidden", view !== "connect");
  $("about-view").classList.toggle("hidden", view !== "about");
  $("stats").classList.toggle("hidden", view !== "home");
  $("home-search").classList.toggle("hidden", view !== "home");
  $("page-title").textContent = PAGE_TITLES[view];
  $("page-sub").textContent = PAGE_SUBS[view];
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.view === view);
  });
  if (location.hash.replace("#", "") !== view) {
    history.replaceState(null, "", `#${view}`);
  }
}

async function load() {
  const [snapshot, creds] = await Promise.all([
    fetch("/api/snapshot").then((r) => r.json()),
    fetch("/api/token").then((r) => r.json()),
  ]);
  state.snapshot = snapshot;
  state.token = creds.token;
  state.ingestUrl = creds.ingestUrl;
  const q = $("filter").value.trim().toLowerCase();
  renderStats(snapshot, q);
  renderBots(snapshot);
  renderPipeline(snapshot, q);
  renderSuggestions(snapshot);
  renderEvents(snapshot);
  renderConnect();
  renderMetrics(snapshot);
}

$("filter").addEventListener("input", () => {
  if (!state.snapshot) return;
  const q = $("filter").value.trim().toLowerCase();
  renderStats(state.snapshot, q);
  renderPipeline(state.snapshot, q);
});

document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", () => setView(item.dataset.view));
});

document.querySelectorAll(".subtab").forEach((tab) => {
  tab.addEventListener("click", () => setMetricsPanel(tab.dataset.metrics));
});

$("nav-toggle").addEventListener("click", () => {
  const collapsed = document.body.classList.toggle("nav-collapsed");
  $("nav-toggle").setAttribute("aria-expanded", collapsed ? "false" : "true");
  $("nav-toggle").title = collapsed ? "Expand menu" : "Collapse menu";
  localStorage.setItem("jcc-nav-collapsed", collapsed ? "1" : "0");
});

if (localStorage.getItem("jcc-nav-collapsed") === "1") {
  document.body.classList.add("nav-collapsed");
  $("nav-toggle").setAttribute("aria-expanded", "false");
  $("nav-toggle").title = "Expand menu";
}

window.addEventListener("hashchange", () => {
  setView(location.hash.replace("#", "") || "home");
});

setView(location.hash.replace("#", "") || "home");

$("copy-all").addEventListener("click", async () => {
  const text = [
    $("prompt-tracker").textContent,
    $("prompt-linkedin").textContent,
    $("prompt-email").textContent,
  ].join("\n\n---\n\n");
  await navigator.clipboard.writeText(text);
  $("copy-all").textContent = "Copied";
  setTimeout(() => {
    $("copy-all").textContent = "Copy all instructions";
  }, 1500);
});

$("import-btn").addEventListener("click", async () => {
  const status = $("import-status");
  try {
    const payload = JSON.parse($("import-json").value);
    const res = await fetch("/api/ingest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ingest-Token": state.token,
      },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Import failed");
    status.textContent = `Imported ${body.accepted} records from ${body.bot}.`;
    $("import-json").value = "";
    await load();
  } catch (err) {
    status.textContent = err.message;
  }
});

load().catch((err) => {
  $("updated").textContent = `Could not load board: ${err.message}`;
});

setInterval(() => {
  if (state.view === "home" || state.view === "metrics") load().catch(() => {});
}, 8000);
