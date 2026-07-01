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
  startPolling();
}

function initTabs() {
  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
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
  setField("maxConcurrentRuns", c.maxConcurrentRuns);
  setField("requestTimeoutSeconds", msToSeconds(c.requestTimeoutMs));
  setField("rateLimitMax", c.rateLimitMax);
  setField("rateLimitWindowSeconds", msToSeconds(c.rateLimitWindowMs));
  setField("host", c.host);
  setField("port", c.port);
  setField("corsOrigin", c.corsOrigin);
  setField("autoOpenBrowser", c.autoOpenBrowser, true);
  setField("authKeyMasked", c.authKey || "(none set - dashboard and API open to anyone with network access)");
  setField("adminAllowRemote", c.adminAllowRemote, true);
  setField("logLevel", c.logLevel);
  setField("logPretty", c.logPretty, true);
  setField("defaultModel", c.defaultModel);

  settingsModelPicker.setSelected(c.defaultModel);
}

function initSettingsForms() {
  const forms = {};
  document.querySelectorAll("[data-settings-form]").forEach((form) => {
    forms[form.dataset.settingsForm] = form;
  });

  const sections = {
    account: () => ({
      cursorKeyMode: getField(forms.account, "cursorKeyMode").value,
      cursorRuntime: getField(forms.account, "cursorRuntime").value,
      ...(getField(forms.account, "cursorApiKey").value.trim() ? { cursorApiKey: getField(forms.account, "cursorApiKey").value.trim() } : {}),
    }),
    model: () => ({ defaultModel: getField(forms.model, "defaultModel").value }),
    sessions: () => ({
      sessionsEnabled: getField(forms.sessions, "sessionsEnabled").checked,
      autoSessionEnabled: getField(forms.sessions, "autoSessionEnabled").checked,
      sessionTtlMs: minutesToMs(getField(forms.sessions, "sessionTtlMinutes").value),
      maxCachedAgents: Number(getField(forms.sessions, "maxCachedAgents").value),
    }),
    behavior: () => ({
      cursorAgentMode: getField(forms.behavior, "cursorAgentMode").value,
      includeThinking: getField(forms.behavior, "includeThinking").checked,
      toolBridgeEnabled: getField(forms.behavior, "toolBridgeEnabled").checked,
    }),
    limits: () => ({
      maxConcurrentRuns: Number(getField(forms.limits, "maxConcurrentRuns").value),
      requestTimeoutMs: secondsToMs(getField(forms.limits, "requestTimeoutSeconds").value),
      rateLimitMax: Number(getField(forms.limits, "rateLimitMax").value),
      rateLimitWindowMs: secondsToMs(getField(forms.limits, "rateLimitWindowSeconds").value),
    }),
    server: () => ({
      host: getField(forms.server, "host").value.trim(),
      port: Number(getField(forms.server, "port").value),
      corsOrigin: getField(forms.server, "corsOrigin").value.trim() || "*",
      autoOpenBrowser: getField(forms.server, "autoOpenBrowser").checked,
    }),
    security: () => ({ adminAllowRemote: getField(forms.security, "adminAllowRemote").checked }),
    logging: () => ({ logLevel: getField(forms.logging, "logLevel").value, logPretty: getField(forms.logging, "logPretty").checked }),
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
// Dashboard: test chat
// ---------------------------------------------------------------------------

function appendChatBubble(role, text) {
  const list = document.getElementById("test-chat-messages");
  const row = document.createElement("div");
  row.className = "chat-row";
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${role}`;
  bubble.textContent = text;
  row.appendChild(bubble);
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
  return bubble;
}

function appendReasoningBubble(text) {
  const list = document.getElementById("test-chat-messages");
  const row = document.createElement("div");
  row.className = "chat-row";
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble reasoning";
  bubble.textContent = text;
  row.appendChild(bubble);
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
}

function initTestChat() {
  document.querySelector('[data-action="test-chat-form"]').addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.getElementById("test-chat-input");
    const message = input.value.trim();
    if (!message) return;
    appendChatBubble("user", message);
    input.value = "";
    input.disabled = true;
    const thinkingBubble = appendChatBubble("assistant", "Thinking\u2026");
    try {
      const result = await api("/test-chat", { method: "POST", body: JSON.stringify({ message }) });
      thinkingBubble.parentElement.remove();
      if (result.reasoningContent) appendReasoningBubble(result.reasoningContent);
      appendChatBubble("assistant", result.content || "(empty response)");
    } catch (err) {
      thinkingBubble.textContent = `Error: ${err.message}`;
      thinkingBubble.parentElement.classList.add("text-danger");
    } finally {
      input.disabled = false;
      input.focus();
    }
  });
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
  initActivityTab();
  initSessionsTab();
  initTestChat();
  initLogout();
  initCopyTargets();

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
