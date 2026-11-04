const REFRESH_MS = 5000;
const GROUPS = [["all", "All"], ["technical", "Technical"], ["non-technical", "Non-technical"]];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// A figure with how many of the counted members are seeded (FR-DB-005).
const figure = (c) => `<b>${c.total}</b> <span class="seeded">${c.seeded} seeded</span>`;
const countOrDash = (c) => (c ? figure(c) : "n/a");

function headline(m) {
  return GROUPS.map(([key, label]) => {
    const g = m.groups[key];
    const rate = g.completionRate === null ? "n/a" : `${g.completionRate}%`;
    const waiting = g.mostWaiting ? `${esc(g.mostWaiting.item)} ${esc(g.mostWaiting.name)} (${g.mostWaiting.members})` : "n/a";
    return `<div class="card"><h3>${label}</h3>
      <div class="metric"><span>Started</span><span>${figure(g.started)}</span></div>
      <div class="metric"><span>Completed</span><span>${figure(g.completed)}</span></div>
      <div class="metric"><span>Completion rate</span><span><b>${rate}</b> <span class="seeded">${g.started.seeded} seeded</span></span></div>
      <div class="metric"><span>In progress</span><span>${figure(g.inProgress)}</span></div>
      <div class="metric"><span>Most waiting</span><span><b>${waiting}</b></span></div>
    </div>`;
  }).join("");
}

function itemsTable(m) {
  const rows = m.items.map((i) => `<tr><td>${esc(i.id)} ${esc(i.name)}</td>${GROUPS.map(([k]) => `<td>${countOrDash(i.ticks[k])}</td>`).join("")}</tr>`);
  return `<table><tr><th>Item</th>${GROUPS.map(([, l]) => `<th>${l}</th>`).join("")}</tr>${rows.join("")}</table>`;
}

function methodsTable(m) {
  const methods = ["observed", "validated", "self-attested"];
  const rows = m.items.map((i) => `<tr><td>${esc(i.id)} ${esc(i.name)}</td>${methods.map((k) => `<td>${figure(i.methods[k])}</td>`).join("")}</tr>`);
  return `<table><tr><th>Item</th>${methods.map((k) => `<th>${k}</th>`).join("")}</tr>${rows.join("")}</table>`;
}

async function refresh() {
  const error = document.getElementById("error");
  try {
    const res = await fetch("/api/metrics", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const m = await res.json();
    document.getElementById("headline").innerHTML = headline(m);
    document.getElementById("items").innerHTML = itemsTable(m);
    document.getElementById("methods").innerHTML = methodsTable(m);
    error.style.display = "none";
    document.getElementById("status").textContent = `Updated ${new Date().toLocaleTimeString()}. Refreshes every ${REFRESH_MS / 1000} seconds.`;
  } catch {
    // An error shows no figures, never zeros (data contract: aggregate response).
    for (const id of ["headline", "items", "methods"]) document.getElementById(id).innerHTML = "";
    error.style.display = "block";
  }
}

refresh();
setInterval(refresh, REFRESH_MS);
