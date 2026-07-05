// Cursor OpenAI Gateway - admin dashboard. Vanilla JS, no build step, no framework.
// Talks to the /api/admin/* endpoints defined in src/routes/admin.ts.

const STORAGE_KEY = "cursor-gateway-admin-key";

const state = {
  adminKey: sessionStorage.getItem(STORAGE_KEY) || localStorage.getItem(STORAGE_KEY) || "",
  status: null,
  config: null,
  models: [],
};

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function requestJson(url, options) {
  const res = await fetch(url, options);
  let body = null;
  try {
    body = await res.json();
  } catch {
    // no/invalid body - fall through with body = null
  }
  if (!res.ok) {
    const message = body && body.error && body.error.message ? body.error.message : `Request failed (${res.status})`;
    throw new Error(message);
  }
  return body;
}

/** Calls an authenticated /api/admin/* endpoint (adds the admin bearer token, if any). */
function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.adminKey) headers["Authorization"] = `Bearer ${state.adminKey}`;
  return requestJson(`/api/admin${path}`, { ...options, headers });
}

/** Calls an endpoint that doesn't require the admin session yet (status/setup/login/health). */
function apiPublic(path, options = {}) {
  return requestJson(path, { headers: { "Content-Type": "application/json" }, ...options });
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function toast(message, kind = "ok") {
  const root = document.getElementById("toast-root");
  const el = document.createElement("div");
  el.className = `toast${kind === "error" ? " error" : ""}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 200ms ease";
    setTimeout(() => el.remove(), 220);
  }, 3600);
}

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------

function showView(name) {
  document.querySelectorAll("[data-view]").forEach((section) => {
    section.classList.toggle("hidden", section.dataset.view !== name);
  });
}

function setBusy(button, busy, busyLabel) {
  const label = button.querySelector("[data-label]");
  if (busy) {
    button.disabled = true;
    button.dataset.originalLabel = label ? label.textContent : "";
    if (label) label.textContent = busyLabel || "Working\u2026";
  } else {
    button.disabled = false;
    if (label && button.dataset.originalLabel) label.textContent = button.dataset.originalLabel;
  }
}

// ---------------------------------------------------------------------------
// Model picker (reusable, self-contained - owns its own re-rendering so
// callers never need to manage listeners themselves)
// ---------------------------------------------------------------------------

function filterModels(models, query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return models;
  return models.filter(
    (model) =>
      model.id.toLowerCase().includes(normalized) ||
      (model.displayName || "").toLowerCase().includes(normalized) ||
      (model.aliases || []).some((alias) => alias.toLowerCase().includes(normalized)),
  );
}

function createModelPicker({ container, filterInput, getModels, onSelect }) {
  let selected = "";

  function render() {
    const query = filterInput ? filterInput.value : "";
    const models = filterModels(getModels(), query);
    container.innerHTML = "";
    if (models.length === 0) {
      const empty = document.createElement("p");
      empty.className = "text-sm text-slate-500 p-3";
      empty.textContent = "No models found.";
      container.appendChild(empty);
      return;
    }
    for (const model of models) {
      const option = document.createElement("div");
      option.className = `model-option${model.id === selected ? " selected" : ""}`;
      option.setAttribute("role", "button");
      option.tabIndex = 0;

      const idEl = document.createElement("div");
      idEl.className = "model-id";
      idEl.textContent = model.displayName ? `${model.displayName}  (${model.id})` : model.id;
      option.appendChild(idEl);

      if (model.description) {
        const descEl = document.createElement("div");
        descEl.className = "model-desc";
        descEl.textContent = model.description;
        option.appendChild(descEl);
      }

      const select = () => {
        selected = model.id;
        onSelect(model.id);
        render();
      };
      option.addEventListener("click", select);
      option.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select();
        }
      });
      container.appendChild(option);
    }
  }

  if (filterInput) filterInput.addEventListener("input", render);

  return {
    render,
    setSelected(id) {
      selected = id;
      render();
    },
    getSelected: () => selected,
  };
}

// ---------------------------------------------------------------------------
// Setup wizard
// ---------------------------------------------------------------------------

const setupState = { apiKey: "", models: [], accountLabel: "" };

const setupModelPicker = createModelPicker({
  container: document.getElementById("setup-model-list"),
  filterInput: document.getElementById("setup-model-filter"),
  getModels: () => setupState.models,
  onSelect: () => {},
});

function showSetupStep(step) {
  document.querySelectorAll("[data-setup-step]").forEach((el) => {
    el.classList.toggle("hidden", el.dataset.setupStep !== String(step));
  });
  document.querySelectorAll("[data-step-indicator]").forEach((dot) => {
    const n = Number(dot.dataset.stepIndicator);
    dot.classList.toggle("active", n === step);
    dot.classList.toggle("done", typeof step === "number" && n < step);
  });
}

function initSetupWizard() {
  showSetupStep(1);

  const errorEl = document.querySelector("[data-setup-error]");
  document.querySelector('[data-action="setup-validate"]').addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const input = document.getElementById("setup-api-key");
    const key = input.value.trim();
    errorEl.classList.add("hidden");
    if (!key) {
      errorEl.textContent = "Paste your Cursor API key to continue.";
      errorEl.classList.remove("hidden");
      return;
    }
    setBusy(button, true, "Checking\u2026");
    try {
      const result = await apiPublic("/api/admin/setup/preview-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cursorApiKey: key }),
      });
      setupState.apiKey = key;
      setupState.models = result.models || [];
      setupState.accountLabel = result.user.userEmail || result.user.apiKeyName || "your Cursor account";
      document.querySelector("[data-setup-account]").textContent = setupState.accountLabel;
      const preferred = setupState.models.some((m) => m.id === "composer-2.5") ? "composer-2.5" : (setupState.models[0] && setupState.models[0].id) || "";
      setupModelPicker.setSelected(preferred);
      showSetupStep(2);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove("hidden");
    } finally {
      setBusy(button, false);
    }
  });

  document.querySelector('[data-action="setup-back-1"]').addEventListener("click", () => showSetupStep(1));
  document.querySelector('[data-action="setup-back-2"]').addEventListener("click", () => showSetupStep(2));

  document.querySelector('[data-action="setup-continue-3"]').addEventListener("click", () => {
    if (!setupModelPicker.getSelected()) {
      toast("Pick a default model to continue.", "error");
      return;
    }
    showSetupStep(3);
  });

  document.querySelector('[data-action="setup-finish"]').addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const errorEl3 = document.querySelector("[data-setup-error-3]");
    errorEl3.classList.add("hidden");
    const generateAuthKey = document.getElementById("setup-generate-key").checked;
    setBusy(button, true, "Finishing\u2026");
    try {
      const result = await apiPublic("/api/admin/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cursorApiKey: setupState.apiKey, defaultModel: setupModelPicker.getSelected(), generateAuthKey }),
      });
      showSetupStep("done");
      if (result.authKey) {
        state.adminKey = result.authKey;
        localStorage.setItem(STORAGE_KEY, result.authKey);
        document.getElementById("setup-key-reveal").classList.remove("hidden");
        document.getElementById("setup-issued-key").textContent = result.authKey;
      }
    } catch (err) {
      errorEl3.textContent = err.message;
      errorEl3.classList.remove("hidden");
    } finally {
      setBusy(button, false);
    }
  });

  document.querySelector('[data-action="copy-issued-key"]').addEventListener("click", () => {
    copyText(document.getElementById("setup-issued-key").textContent);
  });

  document.querySelector('[data-action="setup-goto-dashboard"]').addEventListener("click", () => {
    bootDashboard();
  });
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

function initLogin() {
  const errorEl = document.querySelector("[data-login-error]");
  document.querySelector('[data-action="login-submit"]').addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const key = document.getElementById("login-key").value.trim();
    const remember = document.getElementById("login-remember").checked;
    errorEl.classList.add("hidden");
    if (!key) {
      errorEl.textContent = "Enter your admin key.";
      errorEl.classList.remove("hidden");
      return;
    }
    setBusy(button, true, "Signing in\u2026");
    try {
      await apiPublic("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authKey: key }),
      });
      state.adminKey = key;
      (remember ? localStorage : sessionStorage).setItem(STORAGE_KEY, key);
      await bootDashboard();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove("hidden");
    } finally {
      setBusy(button, false);
    }
  });

  document.getElementById("login-key").addEventListener("keydown", (event) => {
    if (event.key === "Enter") document.querySelector('[data-action="login-submit"]').click();
  });
}

// ---------------------------------------------------------------------------
// Dashboard: tabs
// ---------------------------------------------------------------------------

let activeTab = "overview";
let pollTimer = null;

const TAB_REFRESH_MS = 6000;

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function refreshActiveTab() {
  if (activeTab === "overview") void renderOverview();
  else if (activeTab === "activity") void renderActivityTab();
  else if (activeTab === "sessions") void renderSessionsTab();
}

function startPolling() {
  stopPolling();
  if (activeTab === "overview" || activeTab === "activity" || activeTab === "sessions") {
    pollTimer = setInterval(refreshActiveTab, TAB_REFRESH_MS);
  }
}

/** Polls `/health` until the gateway responds again after a restart (or times out). A brief initial delay + tolerance for fetch errors, since the old process is still closing and the new one still starting for the first moment or two. */
async function waitForGatewayBackUp(timeoutMs = 20000, intervalMs = 700) {
  await new Promise((resolve) => setTimeout(resolve, 800));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("/health", { cache: "no-store" });
      if (res.ok) return true;
    } catch {
      // Expected while the old process is closing / the new one is still starting up.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function switchTab(name) {
  activeTab = name;
  document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.tabPanel !== name);
  });
  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === name);
  });
  if (name === "connect") renderConnectTab();
  else if (name === "overview") void renderOverview();
  else if (name === "activity") void renderActivityTab();
  else if (name === "sessions") void renderSessionsTab();
  else if (name === "models") void renderModelsTab();
  else if (name === "settings") void renderSystemInfo();
  else if (name === "chat") initChatTabOnce();
  startPolling();
}

function initTabs() {
  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchTab(btn.dataset.tab);
      closeMobileNav();
    });
  });
  document.querySelectorAll("[data-goto-tab]").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.gotoTab));
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopPolling();
    else startPolling();
  });
}

// ---------------------------------------------------------------------------
// Dashboard: fallback mobile navigation drawer (hamburger menu)
//
// Independent of the CSS breakpoint that switches between the desktop
// sidebar and the mobile topbar - reachable at any viewport width, so
// navigation is never fully inaccessible even if that responsive layout
// ever misbehaves again.
// ---------------------------------------------------------------------------

function openMobileNav() {
  document.getElementById("mobile-drawer").classList.add("open");
  document.getElementById("mobile-drawer-overlay").classList.add("open");
}

function closeMobileNav() {
  document.getElementById("mobile-drawer").classList.remove("open");
  document.getElementById("mobile-drawer-overlay").classList.remove("open");
}

function initMobileNav() {
  document.querySelector('[data-action="open-mobile-nav"]').addEventListener("click", openMobileNav);
  document.querySelectorAll('[data-action="close-mobile-nav"]').forEach((el) => {
    el.addEventListener("click", closeMobileNav);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMobileNav();
  });
}

// ---------------------------------------------------------------------------
// Dashboard: overview
// ---------------------------------------------------------------------------

function statCard(label, value) {
  const el = document.createElement("div");
  el.className = "stat-card";
  const labelEl = document.createElement("div");
  labelEl.className = "stat-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("div");
  valueEl.className = "stat-value";
  valueEl.textContent = value;
  el.appendChild(labelEl);
  el.appendChild(valueEl);
  return el;
}

function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${remMinutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

// ---------------------------------------------------------------------------
// Activity / sessions: shared formatting helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(timestampMs) {
  const diffSeconds = Math.max(0, Math.round((Date.now() - timestampMs) / 1000));
  if (diffSeconds < 5) return "just now";
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDurationMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusBadgeHtml(status) {
  const labels = { ok: "OK", error: "Error", tool_calls: "Tool calls", cancelled: "Cancelled" };
  const cls = ["ok", "error", "tool_calls", "cancelled"].includes(status) ? status : "ok";
  return `<span class="badge badge-${cls}">${labels[status] || status}</span>`;
}

function typeBadgeHtml(type) {
  const labels = { explicit: "Explicit", auto: "Auto", resume: "Resume", fresh: "Fresh" };
  const cls = ["explicit", "auto", "resume", "fresh"].includes(type) ? type : "fresh";
  return `<span class="badge badge-${cls}">${labels[type] || type}</span>`;
}

function emptyStateHtml(message) {
  return `<div class="empty-state">
    <svg class="h-9 w-9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.586a1 1 0 0 1 .707.293l5.414 5.414a1 1 0 0 1 .293.707V19a2 2 0 0 1-2 2Z"/></svg>
    <p>${message}</p>
  </div>`;
}

function skeletonRowsHtml(columns, rows = 4) {
  const cells = Array.from({ length: columns }, () => `<td><div class="skeleton" style="height: 0.9rem; width: 100%"></div></td>`).join("");
  return Array.from({ length: rows }, () => `<tr>${cells}</tr>`).join("");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function activityTableHtml(entries) {
  if (entries.length === 0) return emptyStateHtml("No requests yet. Once clients start calling this gateway, they'll show up here.");
  const rows = entries
    .map((e) => {
      const tokens = e.usage ? `${e.usage.inputTokens} in / ${e.usage.outputTokens} out` : "\u2014";
      return `<tr>
        <td class="text-slate-400">${formatRelativeTime(e.timestamp)}</td>
        <td>${statusBadgeHtml(e.status)}</td>
        <td class="font-mono text-xs">${escapeHtml(e.model)}</td>
        <td class="text-slate-400">${escapeHtml(e.endpoint)}</td>
        <td>${e.streaming ? "Yes" : "No"}</td>
        <td>${formatDurationMs(e.durationMs)}</td>
        <td class="text-slate-400">${tokens}</td>
      </tr>`;
    })
    .join("");
  return `<table class="data-table">
    <thead><tr><th>Time</th><th>Status</th><th>Model</th><th>Endpoint</th><th>Streamed</th><th>Duration</th><th>Tokens</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

let requestsChart = null;

function renderRequestsChart(hourlyBuckets) {
  const canvas = document.getElementById("requests-chart");
  if (!canvas || typeof Chart === "undefined") return;
  const labels = hourlyBuckets.map((b) => new Date(b.hourStart).toLocaleTimeString([], { hour: "numeric" }));
  const data = hourlyBuckets.map((b) => b.count);

  if (requestsChart) {
    requestsChart.data.labels = labels;
    requestsChart.data.datasets[0].data = data;
    requestsChart.update();
    return;
  }

  requestsChart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          data,
          backgroundColor: "rgba(34, 197, 94, 0.55)",
          hoverBackgroundColor: "rgba(34, 197, 94, 0.85)",
          borderRadius: 3,
          maxBarThickness: 18,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: (items) => items[0].label } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: "#94a3b8", font: { size: 10 } } },
        y: { beginAtZero: true, ticks: { precision: 0, color: "#94a3b8", font: { size: 10 } }, grid: { color: "rgba(51, 65, 85, 0.5)" } },
      },
    },
  });
}

function renderModelBreakdown(requestsByModel) {
  const container = document.getElementById("model-breakdown");
  const entries = Object.entries(requestsByModel).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    container.innerHTML = `<p class="text-sm text-slate-500">No requests yet.</p>`;
    return;
  }
  const max = entries[0][1];
  container.innerHTML = entries
    .map(([model, count]) => {
      const pct = Math.max(4, Math.round((count / max) * 100));
      return `<div class="model-bar-row">
        <div class="flex items-center justify-between text-xs">
          <span class="font-mono text-slate-300 truncate">${escapeHtml(model)}</span>
          <span class="text-slate-500">${count}</span>
        </div>
        <div class="model-bar-track"><div class="model-bar-fill" style="width:${pct}%"></div></div>
      </div>`;
    })
    .join("");
}

async function renderOverview() {
  const container = document.getElementById("overview-cards");
  if (container.children.length === 0) container.appendChild(statCard("Status", "Loading\u2026"));

  const [health, account, activity] = await Promise.allSettled([apiPublic("/health"), api("/account"), api("/activity")]);

  container.innerHTML = "";
  if (health.status === "fulfilled") {
    container.appendChild(statCard("Status", "Online"));
    container.appendChild(statCard("Uptime", formatUptime(health.value.uptimeSeconds)));
    container.appendChild(statCard("Cached sessions", `${health.value.sessions.cachedAgents} / ${health.value.sessions.maxCachedAgents}`));
    container.appendChild(statCard("Concurrency", `${health.value.concurrency.inUse} active, ${health.value.concurrency.queued} queued`));
  } else {
    container.appendChild(statCard("Status", "Unreachable"));
  }

  if (activity.status === "fulfilled") {
    const { stats } = activity.value;
    container.appendChild(statCard("Total requests", stats.totalRequests));
    container.appendChild(statCard("Errors", stats.totalErrors));
    container.appendChild(statCard("Tokens (in / out)", `${stats.totalPromptTokens} / ${stats.totalCompletionTokens}`));
  }

  if (account.status === "fulfilled" && account.value.account) {
    container.appendChild(statCard("Cursor account", account.value.account.userEmail || account.value.account.apiKeyName || "\u2014"));
  }
  container.appendChild(statCard("Default model", state.config.defaultModel || "\u2014"));
  container.appendChild(statCard("Key mode", state.config.cursorKeyMode));

  if (activity.status === "fulfilled") {
    renderRequestsChart(activity.value.stats.hourlyBuckets);
    renderModelBreakdown(activity.value.stats.requestsByModel);
    document.getElementById("overview-activity-table").innerHTML = activityTableHtml(activity.value.entries.slice(0, 6));
  }
}

// ---------------------------------------------------------------------------
// Dashboard: activity tab
// ---------------------------------------------------------------------------

async function renderActivityTab() {
  const container = document.getElementById("activity-table-full");
  if (!container.dataset.loaded) {
    container.innerHTML = `<table class="data-table"><tbody>${skeletonRowsHtml(7, 6)}</tbody></table>`;
  }
  try {
    const result = await api("/activity");
    container.innerHTML = activityTableHtml(result.entries);
    container.dataset.loaded = "1";
  } catch (err) {
    container.innerHTML = emptyStateHtml(`Could not load activity: ${escapeHtml(err.message)}`);
  }
}

function initActivityTab() {
  document.querySelector('[data-action="refresh-activity"]').addEventListener("click", () => renderActivityTab());
  document.querySelector('[data-action="clear-activity"]').addEventListener("click", async () => {
    if (!confirm("Clear the in-memory activity log? This does not affect any running conversations.")) return;
    try {
      await api("/activity", { method: "DELETE" });
      await renderActivityTab();
      toast("Activity log cleared.");
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

// ---------------------------------------------------------------------------
// Dashboard: sessions tab
// ---------------------------------------------------------------------------

function sessionsTableHtml(sessions) {
  if (sessions.length === 0) return emptyStateHtml("No cached sessions right now. They'll appear here as soon as a multi-turn conversation starts.");
  const rows = sessions
    .map(
      (s) => `<tr>
        <td>${typeBadgeHtml(s.type)}</td>
        <td class="font-mono text-xs">${escapeHtml(s.agentId)}</td>
        <td class="font-mono text-xs">${escapeHtml(s.model || "\u2014")}</td>
        <td>${s.messageCount}</td>
        <td class="text-slate-400">${formatRelativeTime(s.createdAt)}</td>
        <td class="text-slate-400">${formatRelativeTime(s.lastUsedAt)}</td>
        <td><button class="btn-secondary text-xs text-danger" data-evict-session="${encodeURIComponent(s.id)}" type="button">Evict</button></td>
      </tr>`,
    )
    .join("");
  return `<table class="data-table">
    <thead><tr><th>Type</th><th>Agent ID</th><th>Model</th><th>Messages</th><th>Created</th><th>Last used</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

async function renderSessionsTab() {
  const container = document.getElementById("sessions-table");
  if (!container.dataset.loaded) {
    container.innerHTML = `<table class="data-table"><tbody>${skeletonRowsHtml(7, 3)}</tbody></table>`;
  }
  try {
    const result = await api("/sessions");
    container.innerHTML = sessionsTableHtml(result.sessions);
    container.dataset.loaded = "1";
    container.querySelectorAll("[data-evict-session]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api(`/sessions/${btn.dataset.evictSession}`, { method: "DELETE" });
          await renderSessionsTab();
          toast("Session evicted.");
        } catch (err) {
          toast(err.message, "error");
        }
      });
    });
  } catch (err) {
    container.innerHTML = emptyStateHtml(`Could not load sessions: ${escapeHtml(err.message)}`);
  }
}

function initSessionsTab() {
  document.querySelector('[data-action="refresh-sessions"]').addEventListener("click", () => renderSessionsTab());
  document.querySelector('[data-action="clear-sessions"]').addEventListener("click", async () => {
    if (!confirm("Evict every cached session? Every ongoing conversation will start fresh on its next message.")) return;
    try {
      const result = await api("/sessions", { method: "DELETE" });
      await renderSessionsTab();
      toast(`Cleared ${result.evicted} session(s).`);
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

// ---------------------------------------------------------------------------
// Dashboard: settings
// ---------------------------------------------------------------------------

function secondsToMs(seconds) {
  return Math.round(Number(seconds) * 1000);
}
function msToSeconds(ms) {
  return Math.round(Number(ms) / 1000);
}
function msToMinutes(ms) {
  return Math.round(Number(ms) / 60000);
}
function minutesToMs(minutes) {
  return Math.round(Number(minutes) * 60000);
}

function setField(name, value, isCheckbox) {
  const el = document.querySelector(`[data-field="${name}"]`);
  if (!el) return;
  if (isCheckbox) el.checked = Boolean(value);
  else el.value = value === undefined || value === null ? "" : value;
}

function getField(form, name) {
  return form.querySelector(`[data-field="${name}"]`);
}

const settingsModelPicker = createModelPicker({
  container: document.getElementById("settings-model-list"),
  filterInput: document.getElementById("settings-model-filter"),
  getModels: () => state.models,
  onSelect: (id) => setField("defaultModel", id),
});

function populateSettingsForms() {
  const c = state.config;

  setField("cursorApiKeyMasked", c.cursorApiKey || "(not set)");
  setField("cursorKeyMode", c.cursorKeyMode);
  setField("cursorRuntime", c.cursorRuntime);
  setField("sessionsEnabled", c.sessionsEnabled, true);
  setField("autoSessionEnabled", c.autoSessionEnabled, true);
  setField("sessionTtlMinutes", msToMinutes(c.sessionTtlMs));
  setField("maxCachedAgents", c.maxCachedAgents);
  setField("cursorAgentMode", c.cursorAgentMode);
  setField("includeThinking", c.includeThinking, true);
  setField("toolBridgeEnabled", c.toolBridgeEnabled, true);
  setField("toolBridgeMode", c.toolBridgeMode);
  setField("toolResultTimeoutSeconds", msToSeconds(c.toolResultTimeoutMs));
  setField("maxConcurrentRuns", c.maxConcurrentRuns);
  setField("requestTimeoutSeconds", msToSeconds(c.requestTimeoutMs));
  setField("rateLimitMax", c.rateLimitMax);
  setField("rateLimitWindowSeconds", msToSeconds(c.rateLimitWindowMs));
  setField("jsonBodyLimitMb", c.jsonBodyLimitMb);
  setField("host", c.host);
  setField("port", c.port);
  setField("corsOrigin", c.corsOrigin);
  setField("autoOpenBrowser", c.autoOpenBrowser, true);
  setField("authKeyMasked", c.authKey || "(none set - dashboard and API open to anyone with network access)");
  setField("adminAllowRemote", c.adminAllowRemote, true);
  setField("logLevel", c.logLevel);
  setField("logPretty", c.logPretty, true);
  setField("defaultModel", c.defaultModel);
  setField("cursorWorkdirRoot", c.cursorWorkdirRoot);
  setField("nodeEnv", c.nodeEnv);

  settingsModelPicker.setSelected(c.defaultModel);
}

// ---------------------------------------------------------------------------
// Dashboard: settings sub-navigation (General/Sessions/.../System info)
// ---------------------------------------------------------------------------

function switchSettingsSection(name) {
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.settingsPanel !== name);
  });
  document.querySelectorAll("[data-settings-section]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.settingsSection === name);
  });
  if (name === "system") void renderSystemInfo();
}

function initSettingsSubnav() {
  document.querySelectorAll("[data-settings-section]").forEach((btn) => {
    btn.addEventListener("click", () => switchSettingsSection(btn.dataset.settingsSection));
  });
  switchSettingsSection("general");
}

async function renderSystemInfo() {
  const container = document.getElementById("system-info-table");
  if (!container || container.dataset.loaded) return;
  try {
    const system = await api("/system");
    const rows = {
      "Gateway version": system.gatewayVersion,
      "Node.js version": system.nodeVersion,
      Platform: `${system.platform} (${system.arch})`,
      "Process ID": system.pid,
      "Process uptime": formatUptime(system.processUptimeSeconds),
    };
    if (Array.isArray(system.networkBaseUrls) && system.networkBaseUrls.length > 0) {
      rows["Reachable on your network"] = system.networkBaseUrls.join("\n");
    }
    let html = Object.entries(rows)
      .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd style="white-space:pre-line">${escapeHtml(value)}</dd>`)
      .join("");
    if (system.openToNetworkWithoutAuth) {
      html +=
        `<dt>Security</dt><dd class="text-danger">Reachable by other devices with no API key set. ` +
        `Anyone who can reach this port can use your Cursor plan. Set an admin/API key in the Security tab, ` +
        `or set Host to 127.0.0.1 in Network &amp; server to keep it local-only.</dd>`;
    }
    container.innerHTML = html;
    container.dataset.loaded = "1";
  } catch (err) {
    container.innerHTML = `<dd class="text-danger col-span-2">${escapeHtml(err.message)}</dd>`;
  }
}

function initConfigImport() {
  const fileInput = document.getElementById("import-config-file");
  const filenameEl = document.getElementById("import-config-filename");
  const applyBtn = document.querySelector('[data-action="import-config"]');
  const statusEl = document.getElementById("import-config-status");
  const resultEl = document.getElementById("import-config-result");
  let selectedFile = null;

  fileInput.addEventListener("change", () => {
    selectedFile = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
    filenameEl.textContent = selectedFile ? selectedFile.name : "Click to choose a configuration JSON file\u2026";
    applyBtn.disabled = !selectedFile;
    statusEl.textContent = "";
    statusEl.className = "save-status";
    resultEl.classList.add("hidden");
  });

  applyBtn.addEventListener("click", async () => {
    if (!selectedFile) return;
    setBusy(applyBtn, true, "Applying\u2026");
    statusEl.textContent = "";
    statusEl.className = "save-status";
    resultEl.classList.add("hidden");
    try {
      // Strip a leading UTF-8 BOM (U+FEFF) - common in files re-saved by
      // Windows tools (Notepad, PowerShell), which JSON.parse rejects outright.
      const text = (await selectedFile.text()).replace(/^\uFEFF/, "");
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("That file is not valid JSON.");
      }
      const result = await api("/config/import", { method: "POST", body: JSON.stringify(parsed) });
      state.config = result.config;
      populateSettingsForms();
      const lines = [];
      if (result.applied.length > 0) lines.push(`<p><strong class="text-accent">Applied:</strong> ${escapeHtml(result.applied.join(", "))}</p>`);
      if (result.ignored.length > 0) lines.push(`<p class="mt-1"><strong class="text-slate-400">Ignored:</strong> ${escapeHtml(result.ignored.join(", "))}</p>`);
      resultEl.innerHTML = lines.join("") || "<p>Nothing to apply.</p>";
      resultEl.classList.remove("hidden");
      statusEl.textContent = "Applied";
      statusEl.classList.add("ok");
      toast("Configuration imported.");
    } catch (err) {
      resultEl.innerHTML = `<p class="text-danger">${escapeHtml(err.message)}</p>`;
      resultEl.classList.remove("hidden");
      statusEl.textContent = "Failed";
      statusEl.classList.add("error");
      toast(err.message, "error");
    } finally {
      setBusy(applyBtn, false);
    }
  });
}

function initSettingsForms() {
  const forms = {};
  document.querySelectorAll("[data-settings-form]").forEach((form) => {
    forms[form.dataset.settingsForm] = form;
  });

  const sections = {
    general: () => ({
      cursorKeyMode: getField(forms.general, "cursorKeyMode").value,
      cursorRuntime: getField(forms.general, "cursorRuntime").value,
      cursorAgentMode: getField(forms.general, "cursorAgentMode").value,
      defaultModel: getField(forms.general, "defaultModel").value,
      ...(getField(forms.general, "cursorApiKey").value.trim() ? { cursorApiKey: getField(forms.general, "cursorApiKey").value.trim() } : {}),
    }),
    sessions: () => ({
      sessionsEnabled: getField(forms.sessions, "sessionsEnabled").checked,
      autoSessionEnabled: getField(forms.sessions, "autoSessionEnabled").checked,
      sessionTtlMs: minutesToMs(getField(forms.sessions, "sessionTtlMinutes").value),
      maxCachedAgents: Number(getField(forms.sessions, "maxCachedAgents").value),
    }),
    behavior: () => ({
      includeThinking: getField(forms.behavior, "includeThinking").checked,
      toolBridgeEnabled: getField(forms.behavior, "toolBridgeEnabled").checked,
      toolBridgeMode: getField(forms.behavior, "toolBridgeMode").value,
      toolResultTimeoutMs: secondsToMs(getField(forms.behavior, "toolResultTimeoutSeconds").value),
    }),
    limits: () => ({
      maxConcurrentRuns: Number(getField(forms.limits, "maxConcurrentRuns").value),
      requestTimeoutMs: secondsToMs(getField(forms.limits, "requestTimeoutSeconds").value),
      rateLimitMax: Number(getField(forms.limits, "rateLimitMax").value),
      rateLimitWindowMs: secondsToMs(getField(forms.limits, "rateLimitWindowSeconds").value),
      jsonBodyLimitMb: Number(getField(forms.limits, "jsonBodyLimitMb").value),
    }),
    server: () => ({
      host: getField(forms.server, "host").value.trim(),
      port: Number(getField(forms.server, "port").value),
      corsOrigin: getField(forms.server, "corsOrigin").value.trim() || "*",
      autoOpenBrowser: getField(forms.server, "autoOpenBrowser").checked,
    }),
    security: () => {
      const payload = { adminAllowRemote: getField(forms.security, "adminAllowRemote").checked };
      const customKey = getField(forms.security, "authKeyCustom").value.trim();
      if (customKey) payload.authKey = customKey;
      return payload;
    },
    logging: () => ({ logLevel: getField(forms.logging, "logLevel").value, logPretty: getField(forms.logging, "logPretty").checked }),
    advanced: () => ({
      cursorWorkdirRoot: getField(forms.advanced, "cursorWorkdirRoot").value.trim(),
      nodeEnv: getField(forms.advanced, "nodeEnv").value.trim(),
    }),
  };

  Object.entries(forms).forEach(([name, form]) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      const statusEl = form.querySelector(".save-status");
      setBusy(button, true, "Saving\u2026");
      statusEl.textContent = "";
      statusEl.className = "save-status";
      try {
        const payload = sections[name]();
        const before = { host: state.config.host, port: state.config.port };
        const updated = await api("/config", { method: "PATCH", body: JSON.stringify(payload) });
        state.config = updated;
        populateSettingsForms();
        // These are "write-only" inputs (a new value to apply, not a
        // reflection of current state) - clear them after every successful
        // save regardless of which section submitted, since populateSettingsForms()
        // has no persisted value to restore them from anyway.
        setField("cursorApiKey", "");
        setField("authKeyCustom", "");
        statusEl.textContent = "Saved";
        statusEl.classList.add("ok");
        toast("Settings saved.");
        if (updated.restartRequired && (updated.host !== before.host || updated.port !== before.port)) {
          statusEl.textContent = "Reconnecting to the new address\u2026";
          const newUrl = `${location.protocol}//${updated.host === "0.0.0.0" ? location.hostname : updated.host}:${updated.port}${location.pathname}`;
          setTimeout(() => {
            location.href = newUrl;
          }, 1200);
        }
      } catch (err) {
        statusEl.textContent = err.message;
        statusEl.classList.add("error");
        toast(err.message, "error");
      } finally {
        setBusy(button, false);
      }
    });
  });

  document.querySelector('[data-action="regenerate-key"]').addEventListener("click", async () => {
    if (!confirm("Generate a new admin key? Anything using the old key (including this browser session) will need to be updated.")) return;
    try {
      const result = await api("/regenerate-auth-key", { method: "POST" });
      state.adminKey = result.authKey;
      if (localStorage.getItem(STORAGE_KEY)) localStorage.setItem(STORAGE_KEY, result.authKey);
      if (sessionStorage.getItem(STORAGE_KEY)) sessionStorage.setItem(STORAGE_KEY, result.authKey);
      document.getElementById("revealed-key-box").classList.remove("hidden");
      document.getElementById("revealed-key").textContent = result.authKey;
      setField("authKeyMasked", result.authKey);
      toast("New admin key generated.");
    } catch (err) {
      toast(err.message, "error");
    }
  });

  document.querySelector('[data-action="clear-key"]').addEventListener("click", async () => {
    if (!confirm("Remove the admin key? The dashboard and gateway will then be open to anyone with network access to this machine.")) return;
    try {
      await api("/clear-auth-key", { method: "POST" });
      state.adminKey = "";
      localStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem(STORAGE_KEY);
      setField("authKeyMasked", "(none set - dashboard and API open to anyone with network access)");
      document.getElementById("revealed-key-box").classList.add("hidden");
      toast("Admin key removed.");
    } catch (err) {
      toast(err.message, "error");
    }
  });

  document.querySelector('[data-action="copy-revealed-key"]').addEventListener("click", () => {
    copyText(document.getElementById("revealed-key").textContent);
  });

  document.querySelector('[data-action="restart-gateway"]').addEventListener("click", async (event) => {
    if (!confirm("Restart the gateway now? It should be back within a few seconds, and this page will reconnect automatically.")) return;
    const button = event.currentTarget;
    setBusy(button, true, "Restarting\u2026");
    stopPolling();
    try {
      await api("/restart", { method: "POST" });
      toast("Restarting the gateway\u2026");
      const backUp = await waitForGatewayBackUp();
      if (backUp) {
        toast("Gateway is back online. Reloading\u2026");
        setTimeout(() => location.reload(), 500);
      } else {
        toast("The gateway didn't come back within the expected time - check the server console.", "error");
        setBusy(button, false);
        startPolling();
      }
    } catch (err) {
      toast(err.message, "error");
      setBusy(button, false);
      startPolling();
    }
  });

  document.querySelector('[data-action="export-config"]').addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setBusy(button, true, "Preparing\u2026");
    try {
      const headers = {};
      if (state.adminKey) headers["Authorization"] = `Bearer ${state.adminKey}`;
      const res = await fetch("/api/admin/config/export", { headers });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "cursor-openai-gateway-settings.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast("Configuration downloaded.");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setBusy(button, false);
    }
  });
}

// ---------------------------------------------------------------------------
// Dashboard: chat
//
// Each browser tab gets its own conversation: a random session id is
// generated once and kept in sessionStorage (not localStorage - deliberately
// scoped per-tab, not shared across every tab/device using this dashboard,
// which is what a single hardcoded shared session id used to do). "New
// conversation" simply mints a fresh id; the old server-side session is left
// to expire via the normal session TTL sweep (or can be evicted manually
// from the Sessions tab) rather than needing a dedicated eviction path here.
// ---------------------------------------------------------------------------

const CHAT_SESSION_STORAGE_KEY = "cursor-gateway-chat-session-id";
let chatSessionId = sessionStorage.getItem(CHAT_SESSION_STORAGE_KEY) || "";
let chatInitialized = false;
let chatInFlight = false;

function newChatSessionId() {
  const id = `dashboard-${(crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).slice(0, 18)}`;
  sessionStorage.setItem(CHAT_SESSION_STORAGE_KEY, id);
  return id;
}

function renderMarkdown(text) {
  if (typeof marked === "undefined" || typeof DOMPurify === "undefined") return escapeHtml(text).replace(/\n/g, "<br>");
  return DOMPurify.sanitize(marked.parse(text, { breaks: true }));
}

function chatMessagesEl() {
  return document.getElementById("chat-messages");
}

function clearChatEmptyState() {
  const list = chatMessagesEl();
  const empty = list.querySelector(".empty-state");
  if (empty) empty.remove();
}

function appendChatGroup(role) {
  clearChatEmptyState();
  const list = chatMessagesEl();
  const group = document.createElement("div");
  group.className = `chat-bubble-group ${role}`;

  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${role}`;
  group.appendChild(bubble);

  const meta = document.createElement("div");
  meta.className = "chat-meta hidden";
  group.appendChild(meta);

  list.appendChild(group);
  list.scrollTop = list.scrollHeight;
  return { group, bubble, meta };
}

function addMessageActions(group, getText) {
  const actions = document.createElement("div");
  actions.className = "chat-actions";
  const copyBtn = document.createElement("button");
  copyBtn.className = "btn-icon";
  copyBtn.type = "button";
  copyBtn.title = "Copy";
  copyBtn.style.height = "1.75rem";
  copyBtn.style.width = "1.75rem";
  copyBtn.innerHTML =
    '<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>';
  copyBtn.addEventListener("click", () => copyText(getText()));
  actions.appendChild(copyBtn);
  group.appendChild(actions);
}

async function submitChatMessage(message) {
  if (chatInFlight) return;
  chatInFlight = true;
  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send-btn");
  const modelSelect = document.getElementById("chat-model-select");
  input.disabled = true;
  sendBtn.disabled = true;

  const userGroup = appendChatGroup("user");
  userGroup.bubble.textContent = message;
  addMessageActions(userGroup.group, () => message);

  const assistantGroup = appendChatGroup("assistant");
  assistantGroup.bubble.innerHTML = '<span class="streaming-cursor"></span>';
  let accumulated = "";
  let reasoning = "";

  try {
    const headers = { "Content-Type": "application/json" };
    if (state.adminKey) headers["Authorization"] = `Bearer ${state.adminKey}`;
    const res = await fetch("/api/admin/test-chat/stream", {
      method: "POST",
      headers,
      body: JSON.stringify({ message, model: modelSelect.value || undefined, sessionId: chatSessionId }),
    });
    if (!res.ok || !res.body) {
      let body = null;
      try {
        body = await res.json();
      } catch {
        // ignore
      }
      throw new Error((body && body.error && body.error.message) || `Request failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let finalFrame = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const parts = buffered.split("\n\n");
      buffered = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let frame;
        try {
          frame = JSON.parse(payload);
        } catch {
          continue;
        }
        if (frame.type === "text") {
          accumulated += frame.delta;
          assistantGroup.bubble.innerHTML = `<div class="chat-md">${renderMarkdown(accumulated)}</div><span class="streaming-cursor"></span>`;
          chatMessagesEl().scrollTop = chatMessagesEl().scrollHeight;
        } else if (frame.type === "reasoning") {
          reasoning += frame.delta;
        } else if (frame.type === "error") {
          throw new Error(frame.message);
        } else if (frame.type === "done") {
          finalFrame = frame;
        }
      }
    }

    assistantGroup.bubble.innerHTML = `<div class="chat-md">${renderMarkdown(accumulated || "(empty response)")}</div>`;
    addMessageActions(assistantGroup.group, () => accumulated);
    if (finalFrame) {
      const tokens = finalFrame.usage ? `${finalFrame.usage.inputTokens} in / ${finalFrame.usage.outputTokens} out tokens` : "";
      assistantGroup.meta.textContent = [finalFrame.model, tokens].filter(Boolean).join(" \u00b7 ");
      assistantGroup.meta.classList.remove("hidden");
    }
    if (reasoning) {
      const reasoningGroup = appendChatGroup("assistant");
      reasoningGroup.bubble.classList.add("reasoning");
      reasoningGroup.bubble.textContent = reasoning;
      assistantGroup.group.before(reasoningGroup.group);
    }
  } catch (err) {
    assistantGroup.bubble.classList.add("text-danger");
    assistantGroup.bubble.textContent = `Error: ${err.message}`;
  } finally {
    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
    chatInFlight = false;
  }
}

function autoGrowTextarea(el) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
}

function initChatTabOnce() {
  if (chatInitialized) return;
  chatInitialized = true;

  if (!chatSessionId) chatSessionId = newChatSessionId();

  const modelSelect = document.getElementById("chat-model-select");
  modelSelect.innerHTML = "";
  const autoOpt = document.createElement("option");
  autoOpt.value = "";
  autoOpt.textContent = `Default (${state.config.defaultModel})`;
  modelSelect.appendChild(autoOpt);
  for (const model of state.models) {
    const opt = document.createElement("option");
    opt.value = model.id;
    opt.textContent = model.displayName ? `${model.displayName} (${model.id})` : model.id;
    modelSelect.appendChild(opt);
  }

  const input = document.getElementById("chat-input");
  input.addEventListener("input", () => autoGrowTextarea(input));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      document.querySelector('[data-action="chat-form"]').requestSubmit();
    }
  });

  document.querySelector('[data-action="chat-form"]').addEventListener("submit", (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    autoGrowTextarea(input);
    void submitChatMessage(message);
  });

  document.querySelector('[data-action="chat-new"]').addEventListener("click", () => {
    chatSessionId = newChatSessionId();
    chatMessagesEl().innerHTML = `<div class="empty-state">
      <svg class="h-9 w-9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M8 10h8M8 14h5M21 12c0 4.97-4.03 9-9 9-1.5 0-2.9-.37-4.14-1.02L3 21l1.06-3.68A8.96 8.96 0 0 1 3 12c0-4.97 4.03-9 9-9s9 4.03 9 9Z"/></svg>
      <p>Start a conversation below.</p>
    </div>`;
    toast("Started a new conversation.");
  });
}

// ---------------------------------------------------------------------------
// Dashboard: models
// ---------------------------------------------------------------------------

/** Cursor's `values[]` entries for boolean-style parameters (e.g. "thinking") often have no `displayName` at all, just the literal string "true"/"false" - show those as "On"/"Off" instead of leaking the raw wire value. */
function formatParamValueLabel(value) {
  if (value.displayName) return value.displayName;
  if (value.value === "true") return "On";
  if (value.value === "false") return "Off";
  return value.value;
}

/**
 * Renders each configurable *dimension* a model exposes (e.g. "Effort: Low,
 * Medium, High" / "Context: 300K, 1M") from `model.parameters`.
 *
 * Deliberately NOT rendering `model.variants` (the pre-combined
 * parameter-value tuples Cursor also returns): every variant's own
 * `displayName` is just the model's own name repeated verbatim, with no
 * per-variant label at all, and there can be dozens of them (one per
 * combination) - listing them produced a card with "Opus 4.8" repeated 20+
 * times and zero useful information, found by actually looking at a real
 * rendered screenshot, not just checking the HTML contained the right
 * elements. The `parameters` field is the actually human-readable summary
 * of the same underlying knobs.
 */
function modelParametersHtml(model) {
  const parameters = model.parameters || [];
  if (parameters.length === 0) return "";
  return parameters
    .map((param) => {
      const values = (param.values || []).map((v) => escapeHtml(formatParamValueLabel(v))).join(", ");
      return `<div class="model-card-variant"><strong class="text-slate-300">${escapeHtml(param.displayName || param.id)}:</strong> ${values}</div>`;
    })
    .join("");
}

function modelCardHtml(model, isDefault) {
  const aliases = (model.aliases || []).map((a) => `<span class="pill">${escapeHtml(a)}</span>`).join(" ");
  return `<div class="model-card${isDefault ? " is-default" : ""}">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="font-medium text-white truncate">${escapeHtml(model.displayName || model.id)}</div>
        <div class="font-mono text-xs text-slate-500 truncate">${escapeHtml(model.id)}</div>
      </div>
      ${isDefault ? '<span class="badge badge-ok whitespace-nowrap">Default</span>' : `<button class="btn-secondary text-xs whitespace-nowrap" data-set-default-model="${escapeHtml(model.id)}" type="button">Set as default</button>`}
    </div>
    ${model.description ? `<p class="text-sm text-slate-400 mt-2">${escapeHtml(model.description)}</p>` : ""}
    ${aliases ? `<div class="flex flex-wrap gap-1.5 mt-3">${aliases}</div>` : ""}
    ${modelParametersHtml(model)}
  </div>`;
}

async function renderModelsTab() {
  const grid = document.getElementById("models-grid");
  if (!grid.dataset.loaded) {
    grid.innerHTML = Array.from({ length: 4 }, () => `<div class="skeleton" style="height: 6rem"></div>`).join("");
  }
  try {
    const result = await api("/models");
    state.models = result.models || [];
    grid.dataset.loaded = "1";
    grid.dataset.note = result.note || "";
    renderModelsGrid();
  } catch (err) {
    grid.innerHTML = emptyStateHtml(`Could not load models: ${escapeHtml(err.message)}`);
  }
}

function renderModelsGrid() {
  const grid = document.getElementById("models-grid");
  const query = document.getElementById("models-filter").value;
  const models = filterModels(state.models, query);
  if (models.length === 0) {
    grid.innerHTML = emptyStateHtml(grid.dataset.note || "No models found.");
    return;
  }
  grid.innerHTML = models.map((m) => modelCardHtml(m, m.id === state.config.defaultModel)).join("");
  grid.querySelectorAll("[data-set-default-model]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.setDefaultModel;
      try {
        state.config = await api("/config", { method: "PATCH", body: JSON.stringify({ defaultModel: id }) });
        populateSettingsForms();
        renderModelsGrid();
        toast(`Default model set to ${id}.`);
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });
}

function initModelsTab() {
  document.getElementById("models-filter").addEventListener("input", renderModelsGrid);
  document.querySelector('[data-action="refresh-models"]').addEventListener("click", () => renderModelsTab());
}

// ---------------------------------------------------------------------------
// Dashboard: connect snippets
// ---------------------------------------------------------------------------

function copyText(text) {
  navigator.clipboard.writeText(text).then(
    () => toast("Copied to clipboard."),
    () => toast("Could not copy - select and copy manually.", "error"),
  );
}

function renderConnectTab() {
  const baseUrl = `${location.origin}/v1`;
  const apiKeyValue = state.config.authKey
    ? state.adminKey || "<your gateway API key>"
    : state.config.cursorKeyMode === "passthrough"
      ? "<your own Cursor API key>"
      : "not-needed";

  document.getElementById("connect-base-url").textContent = baseUrl;
  document.getElementById("connect-api-key").textContent = apiKeyValue;

  const select = document.getElementById("connect-model-select");
  const currentSelection = select.value || state.config.defaultModel;
  select.innerHTML = "";
  for (const model of state.models) {
    const opt = document.createElement("option");
    opt.value = model.id;
    opt.textContent = model.displayName ? `${model.displayName} (${model.id})` : model.id;
    select.appendChild(opt);
  }
  select.value = state.models.some((m) => m.id === currentSelection) ? currentSelection : state.config.defaultModel;
  select.onchange = () => renderSnippetBlocks(baseUrl, apiKeyValue, select.value);
  renderSnippetBlocks(baseUrl, apiKeyValue, select.value || state.config.defaultModel);
}

function snippetBlock(title, code) {
  const wrapper = document.createElement("div");
  wrapper.className = "card";
  const header = document.createElement("div");
  header.className = "flex items-center justify-between";
  const h = document.createElement("h3");
  h.className = "card-title";
  h.textContent = title;
  const btn = document.createElement("button");
  btn.className = "btn-icon";
  btn.type = "button";
  btn.title = "Copy";
  btn.innerHTML =
    '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>';
  btn.addEventListener("click", () => copyText(code));
  header.appendChild(h);
  header.appendChild(btn);
  const pre = document.createElement("pre");
  pre.className = "snippet mt-3";
  const codeEl = document.createElement("code");
  codeEl.textContent = code;
  pre.appendChild(codeEl);
  wrapper.appendChild(header);
  wrapper.appendChild(pre);
  return wrapper;
}

function renderSnippetBlocks(baseUrl, apiKey, model) {
  const container = document.getElementById("connect-snippets");
  container.innerHTML = "";

  container.appendChild(
    snippetBlock(
      "curl",
      `curl ${baseUrl}/chat/completions \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer ${apiKey}" \\\n  -d '{\n    "model": "${model}",\n    "messages": [{"role": "user", "content": "Say hello."}]\n  }'`,
    ),
  );

  container.appendChild(
    snippetBlock(
      "Python (openai SDK)",
      `from openai import OpenAI\n\nclient = OpenAI(base_url="${baseUrl}", api_key="${apiKey}")\nresp = client.chat.completions.create(\n    model="${model}",\n    messages=[{"role": "user", "content": "Say hello."}],\n)\nprint(resp.choices[0].message.content)`,
    ),
  );

  container.appendChild(
    snippetBlock(
      "Node (openai SDK)",
      `import OpenAI from "openai";\n\nconst client = new OpenAI({ baseURL: "${baseUrl}", apiKey: "${apiKey}" });\nconst resp = await client.chat.completions.create({\n  model: "${model}",\n  messages: [{ role: "user", content: "Say hello." }],\n});\nconsole.log(resp.choices[0].message.content);`,
    ),
  );

  container.appendChild(
    snippetBlock(
      "LiteLLM (config.yaml)",
      `model_list:\n  - model_name: ${model}\n    litellm_params:\n      model: openai/${model}\n      api_base: ${baseUrl}\n      api_key: "${apiKey}"`,
    ),
  );

  container.appendChild(
    snippetBlock(
      "Continue.dev (config.json)",
      `{\n  "models": [\n    {\n      "title": "Cursor via gateway",\n      "provider": "openai",\n      "model": "${model}",\n      "apiBase": "${baseUrl}",\n      "apiKey": "${apiKey}"\n    }\n  ]\n}`,
    ),
  );

  const gatewayOrigin = location.origin;
  const keyFlag = apiKey && apiKey !== "not-needed" ? ` --key ${apiKey}` : "";
  container.appendChild(
    snippetBlock(
      "CLI (from the project directory - or `npm link` once for a global `cursor-gateway` command)",
      `node bin/cursor-gateway.mjs status --url ${gatewayOrigin}\nnode bin/cursor-gateway.mjs chat "Say hello" --model ${model} --url ${gatewayOrigin}${keyFlag}\nnode bin/cursor-gateway.mjs config set defaultModel=${model} --url ${gatewayOrigin}${keyFlag}`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function loadModels() {
  try {
    const result = await api("/models");
    state.models = result.models || [];
  } catch {
    state.models = [];
  }
}

async function bootDashboard() {
  showView("dashboard");
  try {
    state.config = await api("/config");
    await loadModels();
    populateSettingsForms();
    document.querySelectorAll("#logout-btn, #logout-btn-mobile").forEach((btn) => btn.classList.toggle("hidden", !state.config.authKey));
    switchTab("overview");
  } catch (err) {
    toast(err.message, "error");
    if (String(err.message).toLowerCase().includes("admin key")) {
      state.adminKey = "";
      localStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem(STORAGE_KEY);
      showView("login");
    }
  }
}

function initLogout() {
  document.querySelectorAll("#logout-btn, #logout-btn-mobile").forEach((btn) => {
    btn.addEventListener("click", () => {
      stopPolling();
      state.adminKey = "";
      localStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem(STORAGE_KEY);
      showView("login");
    });
  });
}

function initCopyTargets() {
  document.querySelectorAll("[data-copy-target]").forEach((btn) => {
    btn.addEventListener("click", () => copyText(document.getElementById(btn.dataset.copyTarget).textContent));
  });
}

async function init() {
  initSetupWizard();
  initLogin();
  initTabs();
  initSettingsForms();
  initSettingsSubnav();
  initConfigImport();
  initActivityTab();
  initSessionsTab();
  initModelsTab();
  initLogout();
  initCopyTargets();
  initMobileNav();

  try {
    const status = await apiPublic("/api/admin/status");
    state.status = status;
    if (!status.setupComplete) {
      showView("setup");
      return;
    }
    if (status.authRequired && !state.adminKey) {
      showView("login");
      return;
    }
    await bootDashboard();
  } catch (err) {
    toast(`Could not reach the gateway: ${err.message}`, "error");
  }
}

init();
