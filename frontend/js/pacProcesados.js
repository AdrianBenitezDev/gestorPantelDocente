import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";
import { auth, functions } from "./firebaseClient.js";
import { fetchProcessedPacList } from "./pacProcessedService.js";
import { formatUserError } from "./userFacingText.js";

const userNameEl = document.getElementById("pac-proc-user-name");
const userEmailEl = document.getElementById("pac-proc-user-email");
const authBtn = document.getElementById("pac-proc-auth-btn");
const guestLoginBtn = document.getElementById("pac-proc-guest-login-btn");
const globalMsgEl = document.getElementById("pac-proc-msg");
const listMsgEl = document.getElementById("pac-proc-list-msg");
const rowsMsgEl = document.getElementById("pac-proc-rows-msg");
const guestSection = document.getElementById("pac-proc-guest-section");
const authenticatedContent = document.getElementById("pac-proc-auth-content");
const refreshBtn = document.getElementById("pac-proc-refresh-btn");
const emptyStateEl = document.getElementById("pac-proc-empty-state");
const listBodyEl = document.getElementById("pac-proc-list-body");
const copyEmailBtn = document.getElementById("pac-proc-copy-email-btn");
const copyToastEl = document.getElementById("pac-proc-copy-toast");
const listPaginationEl = document.getElementById("pac-proc-list-pagination");
const pagePrevBtn = document.getElementById("pac-proc-page-prev-btn");
const pageNextBtn = document.getElementById("pac-proc-page-next-btn");
const pageStatusEl = document.getElementById("pac-proc-page-status");
const detailRowsCountEl = document.getElementById("pac-proc-detail-rows-count");
const selectedCountEl = document.getElementById("pac-proc-selected-count");
const rowsHeadEl = document.getElementById("pac-proc-rows-head");
const rowsBodyEl = document.getElementById("pac-proc-rows-body");
const openGeneratedFileBtn = document.getElementById("pac-proc-open-drive-btn");
const modeSelectEl = document.getElementById("pac-proc-mode");
const selectAllBtn = document.getElementById("pac-proc-select-all-btn");
const clearSelectionBtn = document.getElementById("pac-proc-clear-selection-btn");
const previewBtn = document.getElementById("pac-proc-preview-btn");
const createDriveBtn = document.getElementById("pac-proc-create-drive-btn");
const downloadBtn = document.getElementById("pac-proc-download-btn");

const PAC_PREVIEW_STORAGE_KEY = "pacPreviewPayload";
const PAC_FORWARD_EMAIL = "procesarpac@paneldocente.com.ar";
const PAC_DEFAULT_START_ROW = 14;
const PAC_ROWS_PER_ITEM_LIMIT = 300;
const PAC_PROCESSED_PAGE_SIZE = 10;
const GOOGLE_SCOPE_SHEETS = "https://www.googleapis.com/auth/spreadsheets";
const GOOGLE_SCOPE_DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const COPY_TOAST_TIMEOUT_MS = 2200;

const ROW_COLUMNS = [
  { key: "cupof", label: "CUPOF" },
  { key: "cuilPrefix", label: "CUIL pref" },
  { key: "dni", label: "DNI" },
  { key: "cuilSuffix", label: "CUIL suf" },
  { key: "fechaNacimiento", label: "Fecha nac" },
  { key: "apellidoNombre", label: "Apellido y nombre" },
  { key: "situacionRevista", label: "Sit revista" },
  { key: "modCarr", label: "Mod/Carr" },
  { key: "pid", label: "PID" },
  { key: "cargoModulosHoras", label: "Cargo/Mod/Hs" },
  { key: "curso", label: "Curso" },
  { key: "division", label: "Division" },
];

const state = {
  entries: [],
  flatRows: [],
  selectedRowIds: new Set(),
  hasTenantAccess: false,
  loading: false,
  busySaving: false,
  accessToken: "",
  grantedScopes: new Set(),
  entriesPage: 1,
};

let copyToastTimer = null;

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
  button.disabled = Boolean(busy);
}

function setGeneratedFileButton(sheetUrl = "") {
  if (!openGeneratedFileBtn) {
    return;
  }
  const safeUrl = String(sheetUrl || "").trim();
  if (!safeUrl) {
    openGeneratedFileBtn.hidden = true;
    openGeneratedFileBtn.classList.add("is-hidden");
    openGeneratedFileBtn.removeAttribute("href");
    return;
  }
  openGeneratedFileBtn.href = safeUrl;
  openGeneratedFileBtn.hidden = false;
  openGeneratedFileBtn.classList.remove("is-hidden");
}

function totalEntriesPages() {
  const totalEntries = Array.isArray(state.entries) ? state.entries.length : 0;
  const pageCount = Math.ceil(totalEntries / PAC_PROCESSED_PAGE_SIZE);
  return Math.max(1, Number.isFinite(pageCount) ? pageCount : 1);
}

function clampEntriesPage(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 1;
  }
  const maxPage = totalEntriesPages();
  return Math.max(1, Math.min(maxPage, Math.floor(parsed)));
}

function currentPageEntries(entries = []) {
  const list = Array.isArray(entries) ? entries : [];
  const page = clampEntriesPage(state.entriesPage);
  const start = (page - 1) * PAC_PROCESSED_PAGE_SIZE;
  return list.slice(start, start + PAC_PROCESSED_PAGE_SIZE);
}

function renderEntriesPagination(entries = []) {
  const list = Array.isArray(entries) ? entries : [];
  const hasEntries = list.length > 0;
  const maxPage = totalEntriesPages();
  state.entriesPage = clampEntriesPage(state.entriesPage);

  if (!listPaginationEl) {
    return;
  }
  listPaginationEl.hidden = !hasEntries;
  listPaginationEl.classList.toggle("is-hidden", !hasEntries);

  if (pageStatusEl) {
    pageStatusEl.textContent = `Pagina ${state.entriesPage} de ${maxPage}`;
  }
  if (pagePrevBtn) {
    pagePrevBtn.disabled = !hasEntries || state.entriesPage <= 1;
  }
  if (pageNextBtn) {
    pageNextBtn.disabled = !hasEntries || state.entriesPage >= maxPage;
  }
}

function showCopyToast(text, isError = false) {
  if (!copyToastEl) {
    return;
  }
  copyToastEl.textContent = String(text || "");
  copyToastEl.classList.toggle("is-error", Boolean(isError));
  copyToastEl.hidden = false;
  copyToastEl.classList.remove("is-hidden");
  if (copyToastTimer) {
    clearTimeout(copyToastTimer);
  }
  copyToastTimer = window.setTimeout(() => {
    copyToastEl.classList.add("is-hidden");
    copyToastEl.hidden = true;
  }, COPY_TOAST_TIMEOUT_MS);
}

async function writeTextToClipboard(rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    throw new Error("No hay texto para copiar.");
  }

  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const helper = document.createElement("textarea");
  helper.value = text;
  helper.setAttribute("readonly", "");
  helper.style.position = "fixed";
  helper.style.top = "-1000px";
  helper.style.opacity = "0";
  document.body.appendChild(helper);
  helper.focus();
  helper.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(helper);
  if (!copied) {
    throw new Error("No se pudo copiar al portapapeles.");
  }
}

async function copyForwardEmailToClipboard() {
  try {
    await writeTextToClipboard(PAC_FORWARD_EMAIL);
    showCopyToast("Email copiado al portapapeles.");
  } catch (error) {
    console.error("copyForwardEmailToClipboard failed", error);
    showCopyToast("No se pudo copiar el email.", true);
  }
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
  return String(value || "").trim();
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function splitCuilParts(cuilValue, dniValue = "") {
  const cuilDigits = onlyDigits(cuilValue);
  const dniDigits = onlyDigits(dniValue);
  if (cuilDigits.length >= 11) {
    return {
      prefix: cuilDigits.slice(0, 2),
      dni: cuilDigits.slice(2, 10),
      suffix: cuilDigits.slice(10, 11),
    };
  }
  return {
    prefix: "",
    dni: dniDigits,
    suffix: "",
  };
}

function deriveModCarr(cursoValue) {
  const match = String(cursoValue || "").match(/\d{1,2}/);
  if (!match) {
    return "";
  }
  const year = Number(match[0]);
  if (!Number.isFinite(year) || year <= 0) {
    return "";
  }
  return year < 4 ? "CB" : "CS";
}

function buildFullCuil(prefix, dni, suffix) {
  const p = onlyDigits(prefix);
  const d = onlyDigits(dni);
  const s = onlyDigits(suffix);
  if (p.length !== 2 || s.length !== 1 || d.length < 7 || d.length > 8) {
    return "";
  }
  return `${p}-${d}-${s}`;
}

function normalizeModCarr(value, cursoFallback = "") {
  const raw = sanitizeCellText(value).toUpperCase();
  if (raw === "CB" || raw === "CS") {
    return raw;
  }
  return deriveModCarr(cursoFallback);
}

function normalizeRowForExcel(rawRow = {}, entry = {}, index = 0) {
  const docId = sanitizeCellText(entry.docId || entry.id || "entry");
  const cuil = sanitizeCellText(rawRow.cuil || "");
  const rawDni = sanitizeCellText(rawRow.dni || "");
  const legacyParts = splitCuilParts(cuil, rawDni);
  const cuilPrefix = onlyDigits(rawRow.cuilPrefix || "") || legacyParts.prefix;
  const dni = onlyDigits(rawDni) || legacyParts.dni;
  const cuilSuffix = onlyDigits(rawRow.cuilSuffix || "") || legacyParts.suffix;
  const fullCuil = cuil || buildFullCuil(cuilPrefix, dni, cuilSuffix);
  const curso = sanitizeCellText(rawRow.curso || "");
  const modCarr = normalizeModCarr(rawRow.modCarr || "", curso);
  const messageId = sanitizeCellText(rawRow.messageId || "");
  return {
    __rowId: `${docId}_${index}`,
    docId,
    cupof: sanitizeCellText(rawRow.cupof || ""),
    cuil: fullCuil,
    cuilPrefix,
    dni,
    cuilSuffix,
    fechaNacimiento: sanitizeCellText(rawRow.fechaNacimiento || ""),
    apellidoNombre: sanitizeCellText(rawRow.apellidoNombre || ""),
    situacionRevista: sanitizeCellText(rawRow.situacionRevista || ""),
    modCarr,
    pid: sanitizeCellText(rawRow.pid || ""),
    cargoModulosHoras: sanitizeCellText(rawRow.cargoModulosHoras || ""),
    curso,
    division: sanitizeCellText(rawRow.division || ""),
    rowFormatVersion: sanitizeCellText(rawRow.rowFormatVersion || "legacy") || "legacy",
    missingFields: Array.isArray(rawRow.missingFields) ? rawRow.missingFields : [],
    metadata: {
      source: sanitizeCellText(rawRow.source || entry.source || "email_forward"),
      subject: sanitizeCellText(rawRow.subject || entry.asunto || ""),
      from: sanitizeCellText(rawRow.from || entry.origenEmail || ""),
      date: sanitizeCellText(rawRow.date || entry.fechaRecepcion || ""),
      attachmentName: sanitizeCellText(rawRow.attachmentName || ""),
      messageId,
      entryState: sanitizeCellText(entry.estado || ""),
    },
  };
}

function buildFlatRows(entries = []) {
  const list = Array.isArray(entries) ? entries : [];
  const flatRows = [];
  list.forEach((entry) => {
    const rows = Array.isArray(entry?.rows) ? entry.rows : [];
    rows.forEach((row, index) => {
      flatRows.push(normalizeRowForExcel(row, entry, index));
    });
  });
  return flatRows;
}

function getSelectedRows() {
  return state.flatRows.filter((row) => state.selectedRowIds.has(row.__rowId));
}

function updateSelectionUi() {
  const total = state.flatRows.length;
  const selected = getSelectedRows().length;
  if (selectedCountEl) {
    selectedCountEl.textContent = `${selected}/${total}`;
  }
  if (createDriveBtn) {
    createDriveBtn.disabled = state.busySaving || selected === 0;
  }
  if (downloadBtn) {
    downloadBtn.disabled = state.busySaving || selected === 0;
  }
  if (previewBtn) {
    previewBtn.disabled = state.busySaving || selected === 0;
  }
  if (selectAllBtn) {
    selectAllBtn.disabled = total === 0 || state.busySaving;
  }
  if (clearSelectionBtn) {
    clearSelectionBtn.disabled = selected === 0 || state.busySaving;
  }
}

function renderRowsTable(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  rowsHeadEl.textContent = "";
  rowsBodyEl.textContent = "";

  const headRow = document.createElement("tr");
  const selectTh = document.createElement("th");
  selectTh.textContent = "Sel";
  headRow.appendChild(selectTh);
  ROW_COLUMNS.forEach((column) => {
    const th = document.createElement("th");
    th.textContent = column.label;
    headRow.appendChild(th);
  });
  rowsHeadEl.appendChild(headRow);

  if (!list.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = ROW_COLUMNS.length + 1;
    td.textContent = "No hay rows cargadas para este tenant.";
    tr.appendChild(td);
    rowsBodyEl.appendChild(tr);
    updateSelectionUi();
    return;
  }

  list.forEach((row) => {
    const tr = document.createElement("tr");
    const tdCheck = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "pac-proc-row-checkbox";
    checkbox.dataset.rowId = row.__rowId;
    checkbox.checked = state.selectedRowIds.has(row.__rowId);
    tdCheck.appendChild(checkbox);
    tr.appendChild(tdCheck);

    ROW_COLUMNS.forEach((column) => {
      const td = document.createElement("td");
      td.textContent = sanitizeCellText(row[column.key]) || "-";
      tr.appendChild(td);
    });
    rowsBodyEl.appendChild(tr);
  });
  updateSelectionUi();
}

function renderEntries(entries = []) {
  listBodyEl.textContent = "";
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) {
    if (emptyStateEl) {
      emptyStateEl.hidden = false;
      emptyStateEl.classList.remove("is-hidden");
    }
    renderEntriesPagination([]);
    return;
  }
  if (emptyStateEl) {
    emptyStateEl.hidden = true;
    emptyStateEl.classList.add("is-hidden");
  }

  const visibleItems = currentPageEntries(list);
  visibleItems.forEach((entry) => {
    const tr = document.createElement("tr");
    const tdDate = document.createElement("td");
    tdDate.textContent = formatDateTime(entry.fechaRecepcionMs, sanitizeCellText(entry.fechaRecepcion) || "-");
    tr.appendChild(tdDate);

    const tdFrom = document.createElement("td");
    tdFrom.textContent = sanitizeCellText(entry.origenEmail) || "-";
    tr.appendChild(tdFrom);

    const tdSubject = document.createElement("td");
    tdSubject.textContent = sanitizeCellText(entry.asunto) || "-";
    tr.appendChild(tdSubject);

    const tdState = document.createElement("td");
    tdState.textContent = sanitizeCellText(entry.estado) || "-";
    tr.appendChild(tdState);

    const tdRows = document.createElement("td");
    tdRows.textContent = String(Number(entry.rowsCount || 0));
    tr.appendChild(tdRows);
    listBodyEl.appendChild(tr);
  });
  renderEntriesPagination(list);
}

function setSavingBusy(busy) {
  state.busySaving = Boolean(busy);
  setBusy(createDriveBtn, busy);
  setBusy(downloadBtn, busy);
  setBusy(refreshBtn, busy);
  updateSelectionUi();
}

function uniqueScopes(scopes = []) {
  const list = Array.isArray(scopes) ? scopes : [];
  return Array.from(new Set(list.map((scope) => String(scope || "").trim()).filter(Boolean)));
}

function rememberGrantedScopes(scopes = []) {
  uniqueScopes(scopes).forEach((scope) => {
    state.grantedScopes.add(scope);
  });
}

function hasAllGrantedScopes(scopes = []) {
  const required = uniqueScopes(scopes);
  if (!required.length) {
    return true;
  }
  return required.every((scope) => state.grantedScopes.has(scope));
}

function getMissingScopesFromError(error) {
  const details = error?.details && typeof error.details === "object" ? error.details : null;
  const missingScopes = Array.isArray(details?.missingScopes) ? details.missingScopes : [];
  const grantedScopes = Array.isArray(details?.grantedScopes) ? details.grantedScopes : [];
  if (grantedScopes.length) {
    rememberGrantedScopes(grantedScopes);
  }
  return uniqueScopes(missingScopes);
}

async function signInWithGoogleAccount() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({
    prompt: "select_account",
  });
  await signInWithPopup(auth, provider);
}

async function signInAndAuthorizeGoogleScopes(scopes, successMessage, errorMessage) {
  const requiredScopes = uniqueScopes(scopes);
  try {
    const provider = new GoogleAuthProvider();
    requiredScopes.forEach((scope) => provider.addScope(scope));
    provider.setCustomParameters({
      include_granted_scopes: "true",
      login_hint: String(auth.currentUser?.email || "").trim(),
    });
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const accessToken = credential?.accessToken || "";
    if (!accessToken) {
      throw new Error("No se obtuvo accessToken de Google.");
    }
    const grantedScopes = uniqueScopes(
      String(result?._tokenResponse?.oauthScope || result?._tokenResponse?.scope || "").split(/\s+/)
    );
    state.accessToken = accessToken;
    rememberGrantedScopes(grantedScopes.length ? grantedScopes : requiredScopes);
    setMsg(globalMsgEl, successMessage || "Permisos de Google autorizados.");
    return true;
  } catch (error) {
    console.error(error);
    setMsg(globalMsgEl, formatUserError(error, errorMessage || "No se pudieron autorizar permisos."), true);
    return false;
  }
}

function buildSaveRowPayload(row = {}) {
  return {
    cupof: row.cupof,
    cuil: row.cuil,
    cuilPrefix: row.cuilPrefix,
    dni: row.dni,
    cuilSuffix: row.cuilSuffix,
    fechaNacimiento: row.fechaNacimiento,
    apellidoNombre: row.apellidoNombre,
    situacionRevista: row.situacionRevista,
    modCarr: row.modCarr,
    pid: row.pid,
    cargoModulosHoras: row.cargoModulosHoras,
    curso: row.curso,
    division: row.division,
    rowFormatVersion: row.rowFormatVersion,
    messageId: row.metadata?.messageId || "",
    subject: row.metadata?.subject || "",
    from: row.metadata?.from || "",
    date: row.metadata?.date || "",
    attachmentName: row.metadata?.attachmentName || "",
    source: row.metadata?.source || "email_forward",
  };
}

function decodeBase64ToBlob(base64Value, mimeType) {
  const binary = atob(String(base64Value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: String(mimeType || "application/octet-stream") });
}

function downloadBlobFile(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = String(fileName || "PAC.xlsx");
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function processSelectedRows(delivery = "drive") {
  if (state.busySaving) {
    return;
  }
  const selectedRows = getSelectedRows();
  if (!selectedRows.length) {
    setMsg(rowsMsgEl, "Selecciona al menos una fila.", true);
    setGeneratedFileButton("");
    return;
  }
  const saveRequiredScopes = [GOOGLE_SCOPE_SHEETS, GOOGLE_SCOPE_DRIVE_FILE];
  if (!hasAllGrantedScopes(saveRequiredScopes) || !state.accessToken) {
    const authorized = await signInAndAuthorizeGoogleScopes(
      saveRequiredScopes,
      "Permisos de Sheets/Drive autorizados.",
      "No se pudieron autorizar permisos de Sheets/Drive."
    );
    if (!authorized) {
      return;
    }
  }

  setSavingBusy(true);
  setMsg(rowsMsgEl, delivery === "download" ? "Generando archivo..." : "Creando PAC en Drive...");
  setGeneratedFileButton("");
  try {
    const callable = httpsCallable(functions, "savePacRowsToDrive");
    const mode = String(modeSelectEl?.value || "interinos_docx").trim() || "interinos_docx";
    const payload = {
      mode,
      sheetUrl: "",
      sheetName: "",
      startRow: PAC_DEFAULT_START_ROW,
      accessToken: state.accessToken,
      outputTitle: "",
      rows: selectedRows.map(buildSaveRowPayload),
      delivery: String(delivery || "drive"),
    };

    let response;
    try {
      response = await callable(payload);
    } catch (error) {
      const missingScopes = getMissingScopesFromError(error);
      if (!missingScopes.length) {
        throw error;
      }
      const reauthorized = await signInAndAuthorizeGoogleScopes(
        missingScopes,
        "Permisos adicionales autorizados. Reintentando...",
        "No se pudieron autorizar permisos adicionales."
      );
      if (!reauthorized) {
        throw error;
      }
      response = await callable(payload);
    }

    const result = response.data || {};
    if (delivery === "download") {
      const fileBase64 = String(result.fileBase64 || "");
      if (!fileBase64) {
        throw new Error("No se recibio archivo para descarga.");
      }
      const blob = decodeBase64ToBlob(result.fileBase64, result.fileMimeType);
      const fileName = String(result.fileName || "PAC.xlsx");
      downloadBlobFile(blob, fileName);
      setMsg(rowsMsgEl, `Archivo descargado: ${fileName}`);
      setGeneratedFileButton("");
      return;
    }
    const rowsWritten = Number(result.rowsWritten || result.writeSummary?.rowsWritten || 0);
    const sheetUrl = String(result.sheetUrl || "");
    setMsg(rowsMsgEl, `PAC creado en Drive. Filas escritas: ${rowsWritten}.`);
    setGeneratedFileButton(sheetUrl);
  } catch (error) {
    console.error("processSelectedRows failed", error);
    setMsg(rowsMsgEl, formatUserError(error, "No se pudo generar el Excel."), true);
    setGeneratedFileButton("");
  } finally {
    setSavingBusy(false);
  }
}

function openPreviewTab() {
  const selectedRows = getSelectedRows();
  if (!selectedRows.length) {
    setMsg(rowsMsgEl, "Selecciona al menos una fila para abrir la vista previa.", true);
    setGeneratedFileButton("");
    return;
  }

  const payload = {
    rows: selectedRows.map(buildSaveRowPayload),
    mode: String(modeSelectEl?.value || "interinos_docx").trim() || "interinos_docx",
    sheetUrl: "",
    sheetName: "",
    startRow: PAC_DEFAULT_START_ROW,
    accessToken: state.accessToken,
    grantedScopes: Array.from(state.grantedScopes),
    savedFile: null,
  };

  try {
    localStorage.setItem(PAC_PREVIEW_STORAGE_KEY, JSON.stringify(payload));
    window.open("/pac-preview.html", "_blank", "noopener");
  } catch (error) {
    console.error("openPreviewTab storage error", error);
    setMsg(rowsMsgEl, "No se pudo abrir la vista previa en este navegador.", true);
    setGeneratedFileButton("");
  }
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
  if (!auth.currentUser || !state.hasTenantAccess || state.loading || state.busySaving) {
    return;
  }
  state.loading = true;
  setBusy(refreshBtn, true);
  setMsg(listMsgEl, "Cargando PAC procesados...");
  setMsg(rowsMsgEl, "");
  setGeneratedFileButton("");
  try {
    const result = await fetchProcessedPacList({
      limit: 120,
      includeRows: true,
      rowsPerItemLimit: PAC_ROWS_PER_ITEM_LIMIT,
    });
    const items = Array.isArray(result.items) ? result.items : [];
    state.entries = items;
    state.entriesPage = 1;
    renderEntries(items);
    state.flatRows = buildFlatRows(items);
    state.selectedRowIds = new Set(state.flatRows.map((row) => row.__rowId));
    renderRowsTable(state.flatRows);
    if (detailRowsCountEl) {
      detailRowsCountEl.textContent = String(state.flatRows.length);
    }
    setMsg(
      listMsgEl,
      items.length
        ? `Se encontraron ${items.length} procesamientos para este tenant.`
        : "Aun no hay PAC procesados."
    );
    setMsg(
      rowsMsgEl,
      state.flatRows.length
        ? `Rows listas para Excel: ${state.flatRows.length}.`
        : "No hay rows para renderizar."
    );
  } catch (error) {
    console.error("loadProcessedEntries failed", error);
    setMsg(listMsgEl, formatUserError(error, "No se pudieron cargar los PAC procesados."), true);
    setMsg(rowsMsgEl, "");
    setGeneratedFileButton("");
  } finally {
    state.loading = false;
    setBusy(refreshBtn, false);
    updateSelectionUi();
  }
}

rowsBodyEl?.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.classList.contains("pac-proc-row-checkbox")) {
    return;
  }
  const rowId = String(target.dataset.rowId || "");
  if (!rowId) {
    return;
  }
  if (target.checked) {
    state.selectedRowIds.add(rowId);
  } else {
    state.selectedRowIds.delete(rowId);
  }
  updateSelectionUi();
});

pagePrevBtn?.addEventListener("click", () => {
  state.entriesPage = clampEntriesPage(state.entriesPage - 1);
  renderEntries(state.entries);
});

pageNextBtn?.addEventListener("click", () => {
  state.entriesPage = clampEntriesPage(state.entriesPage + 1);
  renderEntries(state.entries);
});

selectAllBtn?.addEventListener("click", () => {
  state.selectedRowIds = new Set(state.flatRows.map((row) => row.__rowId));
  renderRowsTable(state.flatRows);
});

clearSelectionBtn?.addEventListener("click", () => {
  state.selectedRowIds.clear();
  renderRowsTable(state.flatRows);
});

createDriveBtn?.addEventListener("click", async () => {
  await processSelectedRows("drive");
});

downloadBtn?.addEventListener("click", async () => {
  await processSelectedRows("download");
});

previewBtn?.addEventListener("click", () => {
  openPreviewTab();
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

copyEmailBtn?.addEventListener("click", async () => {
  await copyForwardEmailToClipboard();
});

onAuthStateChanged(auth, (user) => {
  updateHeaderAuthButton(user);
  if (!user) {
    userNameEl.textContent = "Sin sesion";
    userEmailEl.textContent = "-";
    state.entries = [];
    state.flatRows = [];
    state.selectedRowIds.clear();
    state.hasTenantAccess = false;
    state.entriesPage = 1;
    state.accessToken = "";
    state.grantedScopes.clear();
    renderEntries([]);
    renderRowsTable([]);
    if (detailRowsCountEl) {
      detailRowsCountEl.textContent = "0";
    }
    updateViewBySession(null, false);
    setMsg(globalMsgEl, "Inicia sesion para ver tus PAC procesados.");
    setMsg(listMsgEl, "");
    setMsg(rowsMsgEl, "");
    setGeneratedFileButton("");
    return;
  }

  userNameEl.textContent = user.displayName || user.email || "Usuario";
  userEmailEl.textContent = user.email || "-";
  updateViewBySession(user, false);
  setMsg(globalMsgEl, "Validando acceso por suscripcion...");
  setMsg(listMsgEl, "");
  setMsg(rowsMsgEl, "");
  setGeneratedFileButton("");

  void validateTenantAccessForUser(user).then(async (hasAccess) => {
    if (String(auth.currentUser?.uid || "") !== String(user?.uid || "")) {
      return;
    }
    updateViewBySession(user, hasAccess);
    if (!hasAccess) {
      return;
    }
    setMsg(globalMsgEl, "Rows PAC procesadas listas para revision y Excel.");
    await loadProcessedEntries();
  });
});

updateSelectionUi();
