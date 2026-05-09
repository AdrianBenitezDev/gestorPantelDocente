import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";
import { auth, functions } from "./firebaseClient.js";
import { fetchProcessedPacDetail, fetchProcessedPacList } from "./pacProcessedService.js";
import { formatUserError } from "./userFacingText.js";

const userNameEl = document.getElementById("pac-proc-user-name");
const userEmailEl = document.getElementById("pac-proc-user-email");
const authBtn = document.getElementById("pac-proc-auth-btn");
const guestLoginBtn = document.getElementById("pac-proc-guest-login-btn");
const globalMsgEl = document.getElementById("pac-proc-msg");
const listMsgEl = document.getElementById("pac-proc-list-msg");
const guestSection = document.getElementById("pac-proc-guest-section");
const authenticatedContent = document.getElementById("pac-proc-auth-content");
const refreshBtn = document.getElementById("pac-proc-refresh-btn");
const emptyStateEl = document.getElementById("pac-proc-empty-state");
const listBodyEl = document.getElementById("pac-proc-list-body");
const detailCardEl = document.getElementById("pac-proc-detail-card");
const detailTitleEl = document.getElementById("pac-proc-detail-title");
const detailFromEl = document.getElementById("pac-proc-detail-from");
const detailToEl = document.getElementById("pac-proc-detail-to");
const detailSubjectEl = document.getElementById("pac-proc-detail-subject");
const detailDateEl = document.getElementById("pac-proc-detail-date");
const detailStateEl = document.getElementById("pac-proc-detail-state");
const detailRowsCountEl = document.getElementById("pac-proc-detail-rows-count");
const rowsHeadEl = document.getElementById("pac-proc-rows-head");
const rowsBodyEl = document.getElementById("pac-proc-rows-body");

const PREFERRED_ROW_COLUMNS = [
  "cupof",
  "cuil",
  "dni",
  "fechaNacimiento",
  "apellidoNombre",
  "situacionRevista",
  "pid",
  "cargoModulosHoras",
  "curso",
  "division",
];

const state = {
  entries: [],
  hasTenantAccess: false,
  loading: false,
  selectedEntryId: "",
};

function setMsg(el, text, isError = false) {
  if (!el) {
    return;
  }
  el.textContent = String(text || "");
  el.classList.toggle("error", isError);
  el.classList.toggle("success", !isError && Boolean(text));
}

function setBusy(button, busy) {
  if (!button) {
    return;
  }
  button.disabled = busy;
}

function normalizeRoute(value) {
  return String(value || "").trim().replace(/\/+$/, "").toLowerCase();
}

function redirectIfNeeded(route) {
  const target = String(route || "").trim();
  if (!target) {
    return false;
  }
  if (normalizeRoute(window.location.pathname) === normalizeRoute(target)) {
    return false;
  }
  window.location.replace(target);
  return true;
}

function resolveSubscriptionRouteFallback(data = {}) {
  const nextRoute = String(data?.nextRoute || "").trim();
  if (nextRoute) {
    return nextRoute;
  }
  const appEnabled = data?.appEnabled === true;
  const tenantId = String(data?.tenantId || "").trim();
  if (appEnabled && tenantId) {
    return "";
  }
  return "/activar-plan.html";
}

function updateHeaderAuthButton(user) {
  if (!authBtn) {
    return;
  }
  if (user) {
    authBtn.textContent = "Cerrar sesion";
    authBtn.dataset.authAction = "logout";
    return;
  }
  authBtn.textContent = "Iniciar sesion con Google";
  authBtn.dataset.authAction = "login";
}

function updateViewBySession(user, hasTenantAccess) {
  const hasSession = Boolean(user);
  const canUseApp = Boolean(hasSession && hasTenantAccess);
  if (guestSection) {
    guestSection.hidden = canUseApp;
    guestSection.classList.toggle("is-hidden", canUseApp);
  }
  if (authenticatedContent) {
    authenticatedContent.hidden = !canUseApp;
    authenticatedContent.classList.toggle("is-hidden", !canUseApp);
  }
}

function formatDateTime(valueMs, fallbackText = "-") {
  const value = Number(valueMs);
  if (!Number.isFinite(value) || value <= 0) {
    return fallbackText;
  }
  try {
    return new Intl.DateTimeFormat("es-AR", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(value));
  } catch (_error) {
    return fallbackText;
  }
}

function sanitizeCellText(value) {
  return String(value || "").trim() || "-";
}

function pickRowColumns(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const dynamicColumns = [];
  list.forEach((row) => {
    if (!row || typeof row !== "object") {
      return;
    }
    Object.keys(row).forEach((key) => {
      const safeKey = String(key || "").trim();
      if (!safeKey || safeKey === "missingFields") {
        return;
      }
      if (!dynamicColumns.includes(safeKey)) {
        dynamicColumns.push(safeKey);
      }
    });
  });

  const preferred = PREFERRED_ROW_COLUMNS.filter((column) => dynamicColumns.includes(column));
  const rest = dynamicColumns.filter((column) => !preferred.includes(column));
  const merged = [...preferred, ...rest];
  return merged.length ? merged : ["detalle"];
}

function renderRowsTable(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const columns = pickRowColumns(list);
  rowsHeadEl.textContent = "";
  rowsBodyEl.textContent = "";

  const headRow = document.createElement("tr");
  columns.forEach((column) => {
    const th = document.createElement("th");
    th.textContent = column;
    headRow.appendChild(th);
  });
  rowsHeadEl.appendChild(headRow);

  if (!list.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = columns.length;
    td.textContent = "No hay filas extraidas para este procesamiento.";
    tr.appendChild(td);
    rowsBodyEl.appendChild(tr);
    return;
  }

  list.forEach((row) => {
    const tr = document.createElement("tr");
    columns.forEach((column) => {
      const td = document.createElement("td");
      const value = row && typeof row === "object" ? row[column] : "";
      if (Array.isArray(value)) {
        td.textContent = value.join(", ");
      } else if (value && typeof value === "object") {
        td.textContent = JSON.stringify(value);
      } else {
        td.textContent = sanitizeCellText(value);
      }
      tr.appendChild(td);
    });
    rowsBodyEl.appendChild(tr);
  });
}

function renderDetail(entry = null) {
  if (!entry) {
    detailCardEl.hidden = true;
    detailCardEl.classList.add("is-hidden");
    return;
  }

  detailCardEl.hidden = false;
  detailCardEl.classList.remove("is-hidden");
  detailTitleEl.textContent = `Detalle: ${sanitizeCellText(entry.asunto || "PAC procesado")}`;
  detailFromEl.textContent = sanitizeCellText(entry.origenEmail);
  detailToEl.textContent = sanitizeCellText(entry.destinoEmail);
  detailSubjectEl.textContent = sanitizeCellText(entry.asunto);
  detailDateEl.textContent = formatDateTime(entry.fechaRecepcionMs, sanitizeCellText(entry.fechaRecepcion));
  detailStateEl.textContent = sanitizeCellText(entry.estado || "procesado");
  detailRowsCountEl.textContent = String(Number(entry.rowsCount || 0));
  renderRowsTable(entry.rows || []);
}

function renderEntries(entries = []) {
  listBodyEl.textContent = "";
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) {
    if (emptyStateEl) {
      emptyStateEl.hidden = false;
      emptyStateEl.classList.remove("is-hidden");
    }
    renderDetail(null);
    return;
  }

  if (emptyStateEl) {
    emptyStateEl.hidden = true;
    emptyStateEl.classList.add("is-hidden");
  }

  list.forEach((entry, index) => {
    const tr = document.createElement("tr");
    const tdDate = document.createElement("td");
    tdDate.textContent = formatDateTime(entry.fechaRecepcionMs, sanitizeCellText(entry.fechaRecepcion));
    tr.appendChild(tdDate);

    const tdFrom = document.createElement("td");
    tdFrom.textContent = sanitizeCellText(entry.origenEmail);
    tr.appendChild(tdFrom);

    const tdSubject = document.createElement("td");
    tdSubject.textContent = sanitizeCellText(entry.asunto);
    tr.appendChild(tdSubject);

    const tdState = document.createElement("td");
    tdState.textContent = sanitizeCellText(entry.estado);
    tr.appendChild(tdState);

    const tdRows = document.createElement("td");
    tdRows.textContent = String(Number(entry.rowsCount || 0));
    tr.appendChild(tdRows);

    const tdAction = document.createElement("td");
    const detailBtn = document.createElement("button");
    detailBtn.type = "button";
    detailBtn.className = "google-btn";
    detailBtn.dataset.entryIndex = String(index);
    detailBtn.textContent = "Ver detalle";
    tdAction.appendChild(detailBtn);
    tr.appendChild(tdAction);
    listBodyEl.appendChild(tr);
  });
}

async function signInWithGoogleAccount() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({
    prompt: "select_account",
  });
  await signInWithPopup(auth, provider);
}

async function validateTenantAccessForUser(user) {
  if (!user) {
    state.hasTenantAccess = false;
    return false;
  }
  try {
    const callable = httpsCallable(functions, "getSubscriptionStatus");
    const response = await callable({});
    const data = response.data || {};
    const appEnabled = data.appEnabled === true;
    const tenantId = String(data.tenantId || "").trim();
    state.hasTenantAccess = Boolean(appEnabled && tenantId);
    if (!state.hasTenantAccess) {
      const route = resolveSubscriptionRouteFallback(data);
      redirectIfNeeded(route);
    }
    return state.hasTenantAccess;
  } catch (error) {
    console.error("pac procesados access check failed", error);
    state.hasTenantAccess = false;
    const detailsCode = String(error?.details?.code || "").trim().toLowerCase();
    if (detailsCode === "user_profile_missing") {
      redirectIfNeeded("/registro.html");
    } else {
      redirectIfNeeded("/activar-plan.html");
    }
    return false;
  }
}

async function loadProcessedEntries() {
  if (!auth.currentUser || !state.hasTenantAccess || state.loading) {
    return;
  }
  state.loading = true;
  setBusy(refreshBtn, true);
  setMsg(listMsgEl, "Cargando PAC procesados...");
  try {
    const result = await fetchProcessedPacList({ limit: 60 });
    const items = Array.isArray(result.items) ? result.items : [];
    state.entries = items.map((entry) => ({
      ...entry,
      rowsLoaded: false,
      rows: [],
    }));
    renderEntries(state.entries);
    setMsg(
      listMsgEl,
      items.length
        ? `Se encontraron ${items.length} procesamientos para este tenant.`
        : "Aun no hay PAC procesados."
    );
  } catch (error) {
    console.error("loadProcessedEntries failed", error);
    setMsg(listMsgEl, formatUserError(error, "No se pudieron cargar los PAC procesados."), true);
  } finally {
    state.loading = false;
    setBusy(refreshBtn, false);
  }
}

async function openEntryDetail(entryIndex) {
  const index = Number(entryIndex);
  if (!Number.isInteger(index) || index < 0 || index >= state.entries.length) {
    return;
  }
  const entry = state.entries[index];
  if (!entry) {
    return;
  }
  setMsg(globalMsgEl, "Cargando detalle...");
  try {
    if (!entry.rowsLoaded) {
      const result = await fetchProcessedPacDetail(entry);
      const detailed = result?.item && typeof result.item === "object" ? result.item : null;
      if (!detailed) {
        throw new Error("No se encontro el detalle del PAC procesado.");
      }
      state.entries[index] = {
        ...entry,
        ...detailed,
        rowsLoaded: true,
        rows: Array.isArray(detailed.rows) ? detailed.rows : [],
      };
    }
    const selected = state.entries[index];
    state.selectedEntryId = String(selected.id || "");
    renderDetail(selected);
    setMsg(globalMsgEl, "Detalle actualizado.");
  } catch (error) {
    console.error("openEntryDetail failed", error);
    setMsg(globalMsgEl, formatUserError(error, "No se pudo cargar el detalle."), true);
  }
}

listBodyEl?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const trigger = target.closest("button[data-entry-index]");
  if (!trigger) {
    return;
  }
  void openEntryDetail(trigger.dataset.entryIndex);
});

refreshBtn?.addEventListener("click", async () => {
  await loadProcessedEntries();
});

authBtn?.addEventListener("click", async () => {
  const action = String(authBtn.dataset.authAction || "").trim();
  if (action === "logout" && auth.currentUser) {
    try {
      setBusy(authBtn, true);
      await signOut(auth);
      setMsg(globalMsgEl, "Sesion cerrada.");
    } catch (error) {
      console.error(error);
      setMsg(globalMsgEl, "No se pudo cerrar sesion.", true);
    } finally {
      setBusy(authBtn, false);
    }
    return;
  }

  try {
    setBusy(authBtn, true);
    setMsg(globalMsgEl, "Abriendo Google para iniciar sesion...");
    await signInWithGoogleAccount();
  } catch (error) {
    console.error(error);
    setMsg(globalMsgEl, formatUserError(error, "No se pudo iniciar sesion."), true);
  } finally {
    setBusy(authBtn, false);
  }
});

guestLoginBtn?.addEventListener("click", async () => {
  try {
    setBusy(guestLoginBtn, true);
    setMsg(globalMsgEl, "Abriendo Google para iniciar sesion...");
    await signInWithGoogleAccount();
  } catch (error) {
    console.error(error);
    setMsg(globalMsgEl, formatUserError(error, "No se pudo iniciar sesion."), true);
  } finally {
    setBusy(guestLoginBtn, false);
  }
});

onAuthStateChanged(auth, (user) => {
  updateHeaderAuthButton(user);
  if (!user) {
    userNameEl.textContent = "Sin sesion";
    userEmailEl.textContent = "-";
    state.entries = [];
    state.selectedEntryId = "";
    state.hasTenantAccess = false;
    renderEntries([]);
    renderDetail(null);
    updateViewBySession(null, false);
    setMsg(globalMsgEl, "Inicia sesion para ver tus PAC procesados.");
    setMsg(listMsgEl, "");
    return;
  }

  userNameEl.textContent = user.displayName || user.email || "Usuario";
  userEmailEl.textContent = user.email || "-";
  updateViewBySession(user, false);
  setMsg(globalMsgEl, "Validando acceso por suscripcion...");
  setMsg(listMsgEl, "");

  void validateTenantAccessForUser(user).then(async (hasAccess) => {
    if (String(auth.currentUser?.uid || "") !== String(user?.uid || "")) {
      return;
    }
    updateViewBySession(user, hasAccess);
    if (!hasAccess) {
      return;
    }
    setMsg(globalMsgEl, "Reenviando correos a procesarpac@paneldocente.com.ar podras verlos aqui.");
    await loadProcessedEntries();
  });
});
