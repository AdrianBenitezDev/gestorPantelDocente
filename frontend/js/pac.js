import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";
import { auth, functions } from "./firebaseClient.js";
import { formatUserError } from "./userFacingText.js";

const connectBtn = document.getElementById("pac-connect-btn");
const logoutBtn = document.getElementById("pac-logout-btn");
const previewBtn = document.getElementById("pac-preview-btn");
const runBtn = document.getElementById("pac-run-btn");
const authMsg = document.getElementById("pac-auth-msg");
const runMsg = document.getElementById("pac-run-msg");
const goHorariosLink = document.getElementById("pac-go-horarios-link");
const openDriveBtn = document.getElementById("pac-open-drive-btn");
const summaryMsg = document.getElementById("pac-summary-msg");
const errorsMsg = document.getElementById("pac-errors-msg");
const errorsPanel = document.getElementById("pac-errors-panel");
const errorsSummaryEl = document.getElementById("pac-errors-summary");
const errorsListEl = document.getElementById("pac-errors-list");
const headerMsg = document.getElementById("pac-header-msg");
const headerDetails = document.getElementById("pac-header-details");
const headerSummary = document.querySelector("#pac-header-details > .pac-header-summary");
const headerSummaryTitle = document.querySelector("#pac-header-details > .pac-header-summary h3");
const headerContent = document.getElementById("pac-header-content");
const userNameEl = document.getElementById("pac-user-name");
const userEmailEl = document.getElementById("pac-user-email");
const resultsBody = document.getElementById("pac-results-body");

const modeInput = document.getElementById("pac-mode");
const queryInput = document.getElementById("pac-gmail-query");
const maxResultsInput = document.getElementById("pac-max-results");
const sheetUrlInput = document.getElementById("pac-sheet-url");
const sheetNameInput = document.getElementById("pac-sheet-name");
const startRowInput = document.getElementById("pac-start-row");
const useCustomSheetInput = document.getElementById("pac-use-custom-sheet");

const headerSaveBtn = document.getElementById("pac-header-save-btn");
const headerEstablecimientoInput = document.getElementById("pac-header-establecimiento");
const headerAnexoInput = document.getElementById("pac-header-anexo");
const headerDomicilioInput = document.getElementById("pac-header-domicilio");
const headerTelefonoInput = document.getElementById("pac-header-telefono");
const headerEmailInput = document.getElementById("pac-header-email");
const headerCategoriaInput = document.getElementById("pac-header-categoria");
const headerTurnoMInput = document.getElementById("pac-header-turno-m");
const headerTurnoTInput = document.getElementById("pac-header-turno-t");
const headerTurnoVInput = document.getElementById("pac-header-turno-v");
const headerDesfavorableInput = document.getElementById("pac-header-desfavorable");
const headerDistritoInput = document.getElementById("pac-header-distrito");
const headerTipoOrganizacionInput = document.getElementById("pac-header-tipo-organizacion");
const headerEscuelaInput = document.getElementById("pac-header-escuela");
const headerAnioInput = document.getElementById("pac-header-anio");
const headerDesdeInput = document.getElementById("pac-header-desde");
const headerHastaInput = document.getElementById("pac-header-hasta");
const headerTurnoInputs = [headerTurnoMInput, headerTurnoTInput, headerTurnoVInput].filter(Boolean);
const headerFormInputs = [
  headerEstablecimientoInput,
  headerAnexoInput,
  headerDomicilioInput,
  headerTelefonoInput,
  headerEmailInput,
  headerCategoriaInput,
  headerDesfavorableInput,
  headerDistritoInput,
  headerTipoOrganizacionInput,
  headerEscuelaInput,
  headerAnioInput,
  headerDesdeInput,
  headerHastaInput,
  ...headerTurnoInputs,
].filter(Boolean);

const selectAllBtn = document.getElementById("pac-select-all-btn");
const selectAllCheckbox = document.getElementById("pac-select-all-checkbox");
const selectedCountEl = document.getElementById("pac-selected-count");

const floatingActions = document.getElementById("pac-floating-actions");
const floatCancelBtn = document.getElementById("pac-float-cancel-btn");
const floatDownloadBtn = document.getElementById("pac-float-download-btn");
const floatSaveBtn = document.getElementById("pac-float-save-btn");
const floatPreviewBtn = document.getElementById("pac-float-preview-btn");

const state = {
  accessToken: "",
  rows: [],
  selectedRowIds: new Set(),
  busy: false,
  savedFile: null,
  headerLoadedFromRemote: false,
  extractionConfigLoadedFromRemote: false,
  hasTenantAccess: false,
};
const PAC_GMAIL_QUERY_STORAGE_KEY = "pacGmailQuery";
const PAC_GMAIL_QUERY_IDB_KEY = "gmailQuery";
const PAC_PROCESS_STORAGE_KEY = "pacProcessValue";
const PAC_PROCESS_IDB_KEY = "processValue";
const PAC_EXTRACTION_CONFIG_IDB_KEY = "pacExtractionConfig";
const PAC_HEADER_IDB_KEY = "encabezadoPac";
const PAC_USE_CUSTOM_SHEET_STORAGE_KEY = "pacUseCustomSheet";
const PAC_ACCESS_TOKEN_STORAGE_KEY = "pacAccessToken";
const PAC_ACCESS_TOKEN_UID_STORAGE_KEY = "pacAccessTokenUid";
const PAC_ACCESS_TOKEN_AT_STORAGE_KEY = "pacAccessTokenStoredAt";
const PAC_DEFAULT_SHEET_URL = "https://docs.google.com/spreadsheets/d/1UP0FlTWQdHciMe1dbpj2i1dhsQAk4EsxCtq2Bvxlv2U/edit?usp=sharing";
const PAC_HORARIOS_ALLOWED_EMAIL = "secundaria3altebrown@abc.gob.ar";
const PAC_CACHE_DB_NAME = "gpd-pac-cache";
const PAC_CACHE_DB_VERSION = 1;
const PAC_CACHE_STORE = "settings";
const QUERY_PERSIST_DEBOUNCE_MS = 2000;
const PAC_ACCESS_TOKEN_TTL_MS = 45 * 60 * 1000;
const PAC_MONTHS = [
  "01",
  "02",
  "03",
  "04",
  "05",
  "06",
  "07",
  "08",
  "09",
  "10",
  "11",
  "12",
];

let extractionConfigPersistTimer = null;

function persistAccessToken(accessToken, uid) {
  if (!window.localStorage) {
    return;
  }
  try {
    const safeToken = String(accessToken || "").trim();
    const safeUid = String(uid || "").trim();
    if (!safeToken || !safeUid) {
      return;
    }
    window.localStorage.setItem(PAC_ACCESS_TOKEN_STORAGE_KEY, safeToken);
    window.localStorage.setItem(PAC_ACCESS_TOKEN_UID_STORAGE_KEY, safeUid);
    window.localStorage.setItem(PAC_ACCESS_TOKEN_AT_STORAGE_KEY, String(Date.now()));
  } catch (error) {
    console.error("No se pudo persistir accessToken PAC", error);
  }
}

function clearPersistedAccessToken() {
  if (!window.localStorage) {
    return;
  }
  try {
    window.localStorage.removeItem(PAC_ACCESS_TOKEN_STORAGE_KEY);
    window.localStorage.removeItem(PAC_ACCESS_TOKEN_UID_STORAGE_KEY);
    window.localStorage.removeItem(PAC_ACCESS_TOKEN_AT_STORAGE_KEY);
  } catch (error) {
    console.error("No se pudo limpiar accessToken PAC persistido", error);
  }
}

function restorePersistedAccessToken(user) {
  if (!window.localStorage || !user) {
    return "";
  }
  try {
    const storedToken = String(window.localStorage.getItem(PAC_ACCESS_TOKEN_STORAGE_KEY) || "").trim();
    const storedUid = String(window.localStorage.getItem(PAC_ACCESS_TOKEN_UID_STORAGE_KEY) || "").trim();
    const storedAt = Number(window.localStorage.getItem(PAC_ACCESS_TOKEN_AT_STORAGE_KEY) || "0");
    const safeUid = String(user?.uid || "").trim();
    const ageMs = Date.now() - storedAt;
    if (!storedToken || !storedUid || !safeUid) {
      return "";
    }
    if (storedUid !== safeUid) {
      return "";
    }
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > PAC_ACCESS_TOKEN_TTL_MS) {
      return "";
    }
    return storedToken;
  } catch (error) {
    console.error("No se pudo restaurar accessToken PAC persistido", error);
    return "";
  }
}

function setDefaultModeOption() {
  if (!modeInput) {
    return;
  }
  const options = Array.from(modeInput.options || []);
  const target = options.find((option) => {
    const normalizedText = String(option.textContent || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    return normalizedText.includes("designacion");
  });
  if (target) {
    modeInput.value = String(target.value || "1");
  }
}

function mapProcessValueToMode(processValue) {
  return String(processValue || "") === "0" ? "interinos_docx" : "designacion_body";
}

function buildDistrictNumberList() {
  const list = [];
  for (let district = 1; district <= 135; district += 1) {
    list.push(String(district).padStart(3, "0"));
  }
  return list;
}

function buildGmailQueryOptionsByProcess(processValue) {
  const prefix = String(processValue || "") === "0" ? "sad" : "apdsad";
  const districts = buildDistrictNumberList();
  return districts.map((district) => `from:${prefix}${district}@abc.gob.ar`);
}

function renderProcessDependentGmailQueries() {
  if (!queryInput) {
    return;
  }
  const currentValue = String(queryInput.value || "").trim();
  const options = buildGmailQueryOptionsByProcess(modeInput?.value);
  queryInput.textContent = "";
  options.forEach((query) => {
    const option = document.createElement("option");
    option.value = query;
    option.textContent = query;
    queryInput.appendChild(option);
  });
  if (currentValue && options.includes(currentValue)) {
    queryInput.value = currentValue;
  } else if (options.length) {
    queryInput.value = options[0];
  }
}

function getSheetConfigFromUi() {
  const useCustomSheet = Boolean(useCustomSheetInput?.checked);
  const defaultStartRow = 14;
  const startRowValue = Number(startRowInput?.value || defaultStartRow);
  const startRow = Number.isFinite(startRowValue) && startRowValue > 0
    ? Math.floor(startRowValue)
    : defaultStartRow;

  if (!useCustomSheet) {
    return {
      useCustomSheet: false,
      sheetUrl: PAC_DEFAULT_SHEET_URL,
      sheetName: "",
      startRow: defaultStartRow,
    };
  }

  return {
    useCustomSheet: true,
    sheetUrl: String(sheetUrlInput?.value || "").trim(),
    sheetName: String(sheetNameInput?.value || "").trim(),
    startRow,
  };
}

function applySheetCustomizationUi() {
  const useCustomSheet = Boolean(useCustomSheetInput?.checked);
  if (!useCustomSheet && sheetUrlInput) {
    sheetUrlInput.value = PAC_DEFAULT_SHEET_URL;
  }
  if (sheetUrlInput) {
    sheetUrlInput.disabled = !useCustomSheet;
  }
  if (sheetNameInput) {
    sheetNameInput.disabled = !useCustomSheet;
  }
  if (startRowInput) {
    startRowInput.disabled = !useCustomSheet;
    if (!useCustomSheet) {
      startRowInput.value = "14";
    }
  }
}

function hydrateSheetCustomizationToggle() {
  if (!useCustomSheetInput) {
    return;
  }
  let enabled = false;
  try {
    enabled = String(localStorage.getItem(PAC_USE_CUSTOM_SHEET_STORAGE_KEY) || "") === "true";
  } catch (error) {
    console.error("No se pudo leer configuracion de sheet personalizado", error);
  }
  useCustomSheetInput.checked = enabled;
  applySheetCustomizationUi();
}

function persistSheetCustomizationToggle() {
  if (!useCustomSheetInput) {
    return;
  }
  try {
    localStorage.setItem(
      PAC_USE_CUSTOM_SHEET_STORAGE_KEY,
      useCustomSheetInput.checked ? "true" : "false"
    );
  } catch (error) {
    console.error("No se pudo guardar configuracion de sheet personalizado", error);
  }
}

function setMsg(el, text, isError = false) {
  if (!el) {
    return;
  }
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.classList.toggle("success", !isError && Boolean(text));
}

function applyHorariosLinkVisibility(user) {
  if (!goHorariosLink) {
    return;
  }
  const email = String(user?.email || "").trim().toLowerCase();
  goHorariosLink.hidden = email !== PAC_HORARIOS_ALLOWED_EMAIL;
}

function setDriveResultButton(sheetUrl = "") {
  if (!openDriveBtn) {
    return;
  }
  const safeUrl = String(sheetUrl || "").trim();
  if (!safeUrl) {
    openDriveBtn.hidden = true;
    openDriveBtn.classList.add("is-hidden");
    openDriveBtn.removeAttribute("href");
    return;
  }
  openDriveBtn.href = safeUrl;
  openDriveBtn.hidden = false;
  openDriveBtn.classList.remove("is-hidden");
}

function setBusy(btn, busy) {
  if (!btn) {
    return;
  }
  btn.disabled = busy;
  if (busy) {
    btn.dataset.originalText = btn.textContent;
    btn.textContent = "Procesando...";
  } else if (btn.dataset.originalText) {
    btn.textContent = btn.dataset.originalText;
  }
}

function isSubscriptionRequiredError(error) {
  const code = String(error?.code || "").trim().toLowerCase();
  const detailsCode = String(error?.details?.code || "").trim().toLowerCase();
  const message = String(error?.message || "").trim().toLowerCase();
  const isFailedPrecondition = code.includes("failed-precondition");
  return isFailedPrecondition
    && (detailsCode === "subscription_required" || message.includes("subscription required"));
}

function redirectToRouteIfNeeded(route) {
  const target = String(route || "").trim();
  if (!target) {
    return false;
  }
  const normalizedCurrent = String(window.location.pathname || "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();
  const normalizedTarget = target.replace(/\/+$/, "").toLowerCase();
  if (normalizedCurrent === normalizedTarget) {
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

async function refreshPacTenantAccess(user) {
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
      redirectToRouteIfNeeded(route);
    }
    return state.hasTenantAccess;
  } catch (error) {
    console.error("No se pudo validar acceso PAC por suscripcion", error);
    state.hasTenantAccess = false;
    const detailsCode = String(error?.details?.code || "").trim().toLowerCase();
    if (detailsCode === "user_profile_missing") {
      redirectToRouteIfNeeded("/registro.html");
    } else if (isSubscriptionRequiredError(error)) {
      redirectToRouteIfNeeded("/activar-plan.html");
    }
    return false;
  }
}

function openPacCacheDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      resolve(null);
      return;
    }
    const request = window.indexedDB.open(PAC_CACHE_DB_NAME, PAC_CACHE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PAC_CACHE_STORE)) {
        db.createObjectStore(PAC_CACHE_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGetSetting(settingKey) {
  const db = await openPacCacheDb();
  if (!db) {
    return null;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PAC_CACHE_STORE, "readonly");
    const store = tx.objectStore(PAC_CACHE_STORE);
    const request = store.get(String(settingKey || ""));
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onabort = () => db.close();
  });
}

async function idbSetSetting(settingKey, value) {
  const db = await openPacCacheDb();
  if (!db) {
    return;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PAC_CACHE_STORE, "readwrite");
    const store = tx.objectStore(PAC_CACHE_STORE);
    const request = store.put({
      key: String(settingKey || ""),
      value,
      updatedAt: Date.now(),
    });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onabort = () => db.close();
  });
}

function normalizePacProcessValue(value) {
  return String(value || "") === "0" ? "0" : "1";
}

function getPacExtractionConfigFromUi() {
  return {
    processValue: normalizePacProcessValue(modeInput?.value),
    gmailQuery: String(queryInput?.value || "").trim(),
  };
}

function getStoredPacExtractionConfigFromLocalStorage() {
  let processValue = "";
  let gmailQuery = "";
  try {
    processValue = String(window.localStorage?.getItem(PAC_PROCESS_STORAGE_KEY) || "");
  } catch (error) {
    console.error("No se pudo leer pac-process-value desde localStorage", error);
  }
  try {
    gmailQuery = String(window.localStorage?.getItem(PAC_GMAIL_QUERY_STORAGE_KEY) || "");
  } catch (error) {
    console.error("No se pudo leer pac-gmail-query desde localStorage", error);
  }
  return {
    processValue: normalizePacProcessValue(processValue),
    gmailQuery: String(gmailQuery || "").trim(),
  };
}

function persistPacExtractionConfigInLocalStorage(config) {
  const safe = config && typeof config === "object" ? config : {};
  try {
    window.localStorage?.setItem(
      PAC_PROCESS_STORAGE_KEY,
      normalizePacProcessValue(safe.processValue)
    );
  } catch (error) {
    console.error("No se pudo guardar pac-process-value en localStorage", error);
  }
  try {
    window.localStorage?.setItem(
      PAC_GMAIL_QUERY_STORAGE_KEY,
      String(safe.gmailQuery || "").trim()
    );
  } catch (error) {
    console.error("No se pudo guardar pac-gmail-query en localStorage", error);
  }
}

async function persistPacExtractionConfigInIndexedDb(config) {
  const safe = config && typeof config === "object" ? config : {};
  const processValue = normalizePacProcessValue(safe.processValue);
  const gmailQuery = String(safe.gmailQuery || "").trim();
  const payload = { processValue, gmailQuery };

  try {
    await idbSetSetting(PAC_EXTRACTION_CONFIG_IDB_KEY, payload);
  } catch (error) {
    console.error("No se pudo guardar configuracion PAC de extraccion en IndexedDB", error);
  }
  try {
    await idbSetSetting(PAC_PROCESS_IDB_KEY, processValue);
  } catch (error) {
    console.error("No se pudo guardar pac-process-value en IndexedDB", error);
  }
  try {
    await idbSetSetting(PAC_GMAIL_QUERY_IDB_KEY, gmailQuery);
  } catch (error) {
    console.error("No se pudo guardar pac-gmail-query en IndexedDB", error);
  }
}

async function loadPacExtractionConfigFromIndexedDb() {
  let processValue = "";
  let gmailQuery = "";

  try {
    const configRecord = await idbGetSetting(PAC_EXTRACTION_CONFIG_IDB_KEY);
    if (configRecord && configRecord.value && typeof configRecord.value === "object") {
      processValue = String(configRecord.value.processValue || "");
      gmailQuery = String(configRecord.value.gmailQuery || "");
    }
  } catch (error) {
    console.error("No se pudo leer configuracion PAC de extraccion desde IndexedDB", error);
  }

  if (!processValue) {
    try {
      const processRecord = await idbGetSetting(PAC_PROCESS_IDB_KEY);
      if (processRecord && typeof processRecord.value === "string") {
        processValue = processRecord.value;
      }
    } catch (error) {
      console.error("No se pudo leer pac-process-value desde IndexedDB", error);
    }
  }

  if (!gmailQuery) {
    try {
      const queryRecord = await idbGetSetting(PAC_GMAIL_QUERY_IDB_KEY);
      if (queryRecord && typeof queryRecord.value === "string") {
        gmailQuery = queryRecord.value;
      }
    } catch (error) {
      console.error("No se pudo leer pac-gmail-query desde IndexedDB", error);
    }
  }

  return {
    processValue: normalizePacProcessValue(processValue),
    gmailQuery: String(gmailQuery || "").trim(),
  };
}

function applyPacExtractionConfigToForm(config) {
  if (!modeInput || !queryInput) {
    return;
  }
  const safe = config && typeof config === "object" ? config : {};
  const processValue = normalizePacProcessValue(safe.processValue || modeInput.value);
  modeInput.value = processValue;
  renderProcessDependentGmailQueries();

  const desiredQuery = String(safe.gmailQuery || "").trim();
  const options = Array.from(queryInput.options).map((option) => String(option.value || "").trim());
  if (desiredQuery && options.includes(desiredQuery)) {
    queryInput.value = desiredQuery;
  }
}

async function hydratePacExtractionConfigFromIndexedDb() {
  const fromIdb = await loadPacExtractionConfigFromIndexedDb();
  const fromLocalStorage = getStoredPacExtractionConfigFromLocalStorage();
  const processValue =
    String(fromIdb.processValue || "").trim() || String(fromLocalStorage.processValue || "").trim();
  const gmailQuery = String(fromIdb.gmailQuery || "").trim() || String(fromLocalStorage.gmailQuery || "").trim();
  applyPacExtractionConfigToForm({ processValue, gmailQuery });
}

async function savePacExtractionConfigToFirestore(config) {
  if (!auth.currentUser) {
    return;
  }
  const callable = httpsCallable(functions, "actualizarConfiguracionPacExtraccion");
  await callable({
    configuracionPac: {
      processValue: normalizePacProcessValue(config.processValue),
      gmailQuery: String(config.gmailQuery || "").trim(),
    },
  });
}

async function loadPacExtractionConfigFromFirestore() {
  if (!auth.currentUser || !state.hasTenantAccess) {
    return null;
  }
  try {
    const callable = httpsCallable(functions, "obtenerConfiguracionPacExtraccion");
    const response = await callable({});
    const result = response.data || {};
    if (result && result.configuracionPac && typeof result.configuracionPac === "object") {
      return result.configuracionPac;
    }
    return null;
  } catch (error) {
    if (isSubscriptionRequiredError(error)) {
      return null;
    }
    throw error;
  }
}

async function persistPacExtractionConfig({ syncRemote = false } = {}) {
  if (!modeInput || !queryInput) {
    return;
  }
  const payload = getPacExtractionConfigFromUi();
  persistPacExtractionConfigInLocalStorage(payload);
  await persistPacExtractionConfigInIndexedDb(payload);

  if (syncRemote && auth.currentUser) {
    try {
      await savePacExtractionConfigToFirestore(payload);
    } catch (error) {
      console.error("No se pudo guardar configuracion PAC de extraccion en Firestore", error);
    }
  }
}

function schedulePacExtractionConfigPersistence() {
  if (extractionConfigPersistTimer) {
    clearTimeout(extractionConfigPersistTimer);
  }
  extractionConfigPersistTimer = setTimeout(() => {
    extractionConfigPersistTimer = null;
    void persistPacExtractionConfig({ syncRemote: true });
  }, QUERY_PERSIST_DEBOUNCE_MS);
}

async function hydratePacExtractionConfigForCurrentUser(user) {
  if (!user || state.extractionConfigLoadedFromRemote) {
    return;
  }
  try {
    const remoteData = await loadPacExtractionConfigFromFirestore();
    if (remoteData) {
      applyPacExtractionConfigToForm(remoteData);
      persistPacExtractionConfigInLocalStorage(remoteData);
      await persistPacExtractionConfigInIndexedDb(remoteData);
    }
  } catch (error) {
    console.error("No se pudo cargar configuracion PAC de extraccion desde Firestore", error);
  } finally {
    state.extractionConfigLoadedFromRemote = true;
  }
}

function getCurrentYear() {
  return new Date().getFullYear();
}

function getSafeHeaderYear(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return getCurrentYear();
  }
  const year = Math.floor(parsed);
  if (year < 2000 || year > 2999) {
    return getCurrentYear();
  }
  return year;
}

function getMonthFromDateValue(value) {
  const match = String(value || "").match(/^\d{2}\/(\d{2})\/\d{4}$/);
  if (!match) {
    return "";
  }
  return match[1];
}

function buildDesdeValue(month, year) {
  return `01/${String(month || "").padStart(2, "0")}/${year}`;
}

function buildHastaValue(month, year) {
  const monthNumber = Number(month);
  const lastDay = new Date(year, monthNumber, 0).getDate();
  const day = String(lastDay).padStart(2, "0");
  return `${day}/${String(month || "").padStart(2, "0")}/${year}`;
}

function rebuildPacHeaderDateSelects(preferredDesde = "", preferredHasta = "") {
  if (!headerAnioInput || !headerDesdeInput || !headerHastaInput) {
    return;
  }
  const year = getSafeHeaderYear(headerAnioInput.value);
  headerAnioInput.value = String(year);

  const selectedDesdeMonth = getMonthFromDateValue(preferredDesde || headerDesdeInput.value) || "01";
  const selectedHastaMonth = getMonthFromDateValue(preferredHasta || headerHastaInput.value) || "12";

  headerDesdeInput.textContent = "";
  headerHastaInput.textContent = "";

  PAC_MONTHS.forEach((month) => {
    const desdeOption = document.createElement("option");
    desdeOption.value = buildDesdeValue(month, year);
    desdeOption.textContent = desdeOption.value;
    headerDesdeInput.appendChild(desdeOption);

    const hastaOption = document.createElement("option");
    hastaOption.value = buildHastaValue(month, year);
    hastaOption.textContent = hastaOption.value;
    headerHastaInput.appendChild(hastaOption);
  });

  const desiredDesde = buildDesdeValue(selectedDesdeMonth, year);
  const desiredHasta = buildHastaValue(selectedHastaMonth, year);
  headerDesdeInput.value = desiredDesde;
  headerHastaInput.value = desiredHasta;
}

function getPacHeaderTurnoValue() {
  const selected = headerTurnoInputs.find((checkbox) => checkbox.checked);
  return selected ? String(selected.value || "").trim().toUpperCase() : "";
}

function setPacHeaderTurnoValue(value) {
  const target = String(value || "").trim().toUpperCase();
  headerTurnoInputs.forEach((checkbox) => {
    checkbox.checked = Boolean(target && String(checkbox.value || "").toUpperCase() === target);
  });
}

function collectPacHeaderData() {
  const year = getSafeHeaderYear(headerAnioInput?.value);
  const desdeDefault = buildDesdeValue("01", year);
  const hastaDefault = buildHastaValue("12", year);
  return {
    establecimientoReparticion: String(headerEstablecimientoInput?.value || "").trim(),
    anexo: String(headerAnexoInput?.value || "").trim(),
    domicilioEscuela: String(headerDomicilioInput?.value || "").trim(),
    telefono: String(headerTelefonoInput?.value || "").trim(),
    email: String(headerEmailInput?.value || "").trim(),
    categoria: String(headerCategoriaInput?.value || "").trim(),
    turno: getPacHeaderTurnoValue(),
    desfavorable: String(headerDesfavorableInput?.value || "").trim(),
    distrito: String(headerDistritoInput?.value || "").trim(),
    tipoOrganizacion: String(headerTipoOrganizacionInput?.value || "").trim(),
    escuela: String(headerEscuelaInput?.value || "").trim(),
    anio: String(year),
    desde: String(headerDesdeInput?.value || desdeDefault).trim(),
    hasta: String(headerHastaInput?.value || hastaDefault).trim(),
  };
}

function applyPacHeaderDataToForm(data) {
  const safe = data && typeof data === "object" ? data : {};
  if (headerEstablecimientoInput) {
    headerEstablecimientoInput.value = String(safe.establecimientoReparticion || "");
  }
  if (headerAnexoInput) {
    headerAnexoInput.value = String(safe.anexo || "");
  }
  if (headerDomicilioInput) {
    headerDomicilioInput.value = String(safe.domicilioEscuela || "");
  }
  if (headerTelefonoInput) {
    headerTelefonoInput.value = String(safe.telefono || "");
  }
  if (headerEmailInput) {
    headerEmailInput.value = String(safe.email || "");
  }
  if (headerCategoriaInput) {
    headerCategoriaInput.value = String(safe.categoria || "");
  }
  if (headerDesfavorableInput) {
    headerDesfavorableInput.value = String(safe.desfavorable || "");
  }
  if (headerDistritoInput) {
    headerDistritoInput.value = String(safe.distrito || "");
  }
  if (headerTipoOrganizacionInput) {
    headerTipoOrganizacionInput.value = String(safe.tipoOrganizacion || "");
  }
  if (headerEscuelaInput) {
    headerEscuelaInput.value = String(safe.escuela || "");
  }
  if (headerAnioInput) {
    headerAnioInput.value = String(safe.anio || getCurrentYear());
  }
  rebuildPacHeaderDateSelects(String(safe.desde || ""), String(safe.hasta || ""));
  setPacHeaderTurnoValue(safe.turno || "");
  updatePacHeaderSummaryStatus();
}

function isPacHeaderComplete(headerData) {
  const data = headerData && typeof headerData === "object" ? headerData : {};
  const requiredKeys = [
    "establecimientoReparticion",
    "anexo",
    "domicilioEscuela",
    "telefono",
    "email",
    "categoria",
    "turno",
    "desfavorable",
    "distrito",
    "tipoOrganizacion",
    "escuela",
    "anio",
    "desde",
    "hasta",
  ];
  return requiredKeys.every((key) => String(data[key] || "").trim());
}

function updatePacHeaderSummaryStatus() {
  if (!headerSummaryTitle) {
    return;
  }
  const status = isPacHeaderComplete(collectPacHeaderData())
    ? "\u2705 Listo"
    : "\u274C Faltan Cargar";
  headerSummaryTitle.textContent = `Datos de encabezado del PAC ${status}`;
}

function syncPacHeaderOpenStateFromData() {
  if (!headerDetails) {
    return;
  }
  const shouldOpen = !isPacHeaderComplete(collectPacHeaderData());
  if (headerDetails.open === shouldOpen) {
    return;
  }
  headerDetails.open = shouldOpen;
  if (headerContent) {
    headerContent.style.height = "";
    headerContent.style.opacity = "";
    headerContent.style.overflow = "";
  }
}

async function persistPacHeaderInIndexedDb(headerData) {
  try {
    await idbSetSetting(PAC_HEADER_IDB_KEY, headerData || {});
  } catch (error) {
    console.error("No se pudo guardar encabezado PAC en IndexedDB", error);
  }
}

async function hydratePacHeaderFromIndexedDb() {
  try {
    const savedRecord = await idbGetSetting(PAC_HEADER_IDB_KEY);
    if (savedRecord && savedRecord.value && typeof savedRecord.value === "object") {
      applyPacHeaderDataToForm(savedRecord.value);
      syncPacHeaderOpenStateFromData();
      return true;
    }
  } catch (error) {
    console.error("No se pudo leer encabezado PAC desde IndexedDB", error);
  }
  updatePacHeaderSummaryStatus();
  syncPacHeaderOpenStateFromData();
  return false;
}

function setDefaultPacHeaderEmail(email) {
  const safeEmail = String(email || "").trim();
  if (!headerEmailInput || !safeEmail) {
    return;
  }
  if (!String(headerEmailInput.value || "").trim()) {
    headerEmailInput.value = safeEmail;
    updatePacHeaderSummaryStatus();
  }
}

async function loadPacHeaderFromFirestore() {
  if (!auth.currentUser || !state.hasTenantAccess) {
    return null;
  }
  try {
    const callable = httpsCallable(functions, "obtenerEncabezadoPac");
    const response = await callable({});
    const result = response.data || {};
    if (result && result.encabezadoPac && typeof result.encabezadoPac === "object") {
      return result.encabezadoPac;
    }
    return null;
  } catch (error) {
    if (isSubscriptionRequiredError(error)) {
      return null;
    }
    throw error;
  }
}

async function hydratePacHeaderForCurrentUser(user) {
  setDefaultPacHeaderEmail(user?.email || "");
  if (!user || state.headerLoadedFromRemote) {
    return;
  }
  try {
    const remoteData = await loadPacHeaderFromFirestore();
    if (remoteData) {
      applyPacHeaderDataToForm(remoteData);
      await persistPacHeaderInIndexedDb(remoteData);
      syncPacHeaderOpenStateFromData();
    }
  } catch (error) {
    console.error("No se pudo cargar encabezado PAC desde Firestore", error);
  } finally {
    state.headerLoadedFromRemote = true;
    setDefaultPacHeaderEmail(user?.email || "");
    syncPacHeaderOpenStateFromData();
  }
}

async function savePacHeader() {
  const payload = collectPacHeaderData();
  updatePacHeaderSummaryStatus();
  await persistPacHeaderInIndexedDb(payload);

  if (!auth.currentUser) {
    setMsg(headerMsg, "Datos guardados en local. Inicia sesion para sincronizar con Firestore.", true);
    return;
  }

  setBusy(headerSaveBtn, true);
  setMsg(headerMsg, "Guardando encabezado PAC...");
  try {
    const callable = httpsCallable(functions, "actuaizarEncabezadoPac");
    const response = await callable({ encabezadoPac: payload });
    const result = response.data || {};
    const normalized = result?.encabezadoPac && typeof result.encabezadoPac === "object"
      ? result.encabezadoPac
      : payload;
    applyPacHeaderDataToForm(normalized);
    await persistPacHeaderInIndexedDb(normalized);
    setMsg(headerMsg, "Encabezado PAC guardado en IndexedDB y Firestore.");
  } catch (error) {
    console.error("No se pudo guardar encabezado PAC en Firestore", error);
    setMsg(headerMsg, `Se guardo en local, pero fallo Firestore: ${formatCallableError(error)}`, true);
  } finally {
    setBusy(headerSaveBtn, false);
  }
}

function initPacHeaderToggleAnimation() {
  if (!headerDetails || !headerSummary || !headerContent) {
    return;
  }

  let animating = false;

  headerSummary.addEventListener("click", (event) => {
    event.preventDefault();
    if (animating) {
      return;
    }

    const isOpen = headerDetails.open;
    const currentHeight = headerContent.getBoundingClientRect().height || 0;
    headerContent.style.overflow = "hidden";

    if (isOpen) {
      animating = true;
      headerContent.style.height = `${currentHeight}px`;
      headerContent.style.opacity = "1";
      requestAnimationFrame(() => {
        headerContent.style.height = "0px";
        headerContent.style.opacity = "0";
      });

      const onCloseEnd = (closeEvent) => {
        if (closeEvent?.propertyName !== "height") {
          return;
        }
        headerContent.removeEventListener("transitionend", onCloseEnd);
        headerDetails.open = false;
        headerContent.style.height = "";
        headerContent.style.opacity = "";
        headerContent.style.overflow = "";
        animating = false;
      };
      headerContent.addEventListener("transitionend", onCloseEnd);
      return;
    }

    animating = true;
    headerDetails.open = true;
    headerContent.style.height = "0px";
    headerContent.style.opacity = "0";
    requestAnimationFrame(() => {
      const targetHeight = headerContent.scrollHeight;
      headerContent.style.height = `${targetHeight}px`;
      headerContent.style.opacity = "1";
    });

    const onOpenEnd = (openEvent) => {
      if (openEvent?.propertyName !== "height") {
        return;
      }
      headerContent.removeEventListener("transitionend", onOpenEnd);
      headerContent.style.height = "";
      headerContent.style.opacity = "";
      headerContent.style.overflow = "";
      animating = false;
    };
    headerContent.addEventListener("transitionend", onOpenEnd);
  });
}

function initPacHeaderForm() {
  initPacHeaderToggleAnimation();

  if (headerAnioInput && !String(headerAnioInput.value || "").trim()) {
    headerAnioInput.value = String(getCurrentYear());
  }
  rebuildPacHeaderDateSelects();

  if (headerAnioInput) {
    headerAnioInput.addEventListener("change", () => {
      rebuildPacHeaderDateSelects();
      updatePacHeaderSummaryStatus();
    });
  }

  headerTurnoInputs.forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (!checkbox.checked) {
        return;
      }
      headerTurnoInputs.forEach((other) => {
        if (other !== checkbox) {
          other.checked = false;
        }
      });
      updatePacHeaderSummaryStatus();
    });
  });

  headerFormInputs.forEach((input) => {
    input.addEventListener("input", () => {
      updatePacHeaderSummaryStatus();
    });
    input.addEventListener("change", () => {
      updatePacHeaderSummaryStatus();
    });
  });

  updatePacHeaderSummaryStatus();
}

function sanitize(value) {
  return String(value || "").replace(/[<>&]/g, "");
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function splitCuilParts(cuilValue, dniValue) {
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
    dni: dniDigits || String(dniValue || ""),
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

function decodeBase64ToBlob(base64Value, mimeType) {
  const binary = atob(String(base64Value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], {
    type: String(
      mimeType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ),
  });
}

function downloadBlobFile(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = String(fileName || "pac.xlsx");
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function formatListAsText(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean).join("; ");
  }
  return String(value || "").trim();
}

function safeRowId(index, row) {
  const messageId = String(row?.messageId || "").trim() || "row";
  return `${messageId}-${index}`;
}

function decorateRows(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row, index) => ({
    ...row,
    __rowId: safeRowId(index, row),
  }));
}

function getSelectedRows() {
  return state.rows.filter((row) => state.selectedRowIds.has(row.__rowId));
}

function setFloatingVisible(visible) {
  if (!floatingActions) {
    return;
  }
  floatingActions.hidden = !visible;
}

function updateSelectionUI() {
  const total = state.rows.length;
  const selected = getSelectedRows().length;

  if (selectedCountEl) {
    selectedCountEl.textContent = `Filas seleccionadas: ${selected}/${total}`;
  }

  const allChecked = total > 0 && selected === total;
  if (selectAllCheckbox) {
    selectAllCheckbox.checked = allChecked;
    selectAllCheckbox.indeterminate = selected > 0 && selected < total;
  }

  if (selectAllBtn) {
    selectAllBtn.textContent = allChecked ? "Deseleccionar todo" : "Seleccionar todo";
    selectAllBtn.disabled = total === 0;
  }

  const hasRows = total > 0;
  setFloatingVisible(hasRows);
  if (floatSaveBtn) {
    floatSaveBtn.disabled = !hasRows || selected === 0;
  }
  if (floatDownloadBtn) {
    floatDownloadBtn.disabled = !hasRows || selected === 0;
  }
  if (floatPreviewBtn) {
    floatPreviewBtn.disabled = !hasRows || selected === 0;
  }
}

function renderRows(rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (!safeRows.length) {
    resultsBody.innerHTML = `<tr><td colspan="15">Sin datos</td></tr>`;
    updateSelectionUI();
    return;
  }

  const html = safeRows
    .slice(0, 500)
    .map((row) => {
      const missing = Array.isArray(row.missingFields) && row.missingFields.length
        ? ` (faltan: ${row.missingFields.join(", ")})`
        : "";
      const checked = state.selectedRowIds.has(row.__rowId) ? "checked" : "";
      const cuilParts = splitCuilParts(row.cuil, row.dni);
      const modCarr = deriveModCarr(row.curso);
      const rowTitle = [row.subject, row.messageId, missing].filter(Boolean).join(" | ");
      return `<tr>
        <td title="${sanitize(rowTitle)}"><input class="pac-row-checkbox" type="checkbox" data-row-id="${sanitize(row.__rowId)}" ${checked} /></td>
        <td>${sanitize(row.cupof)}</td>
        <td>${sanitize(cuilParts.prefix)}</td>
        <td>${sanitize(cuilParts.dni)}</td>
        <td>${sanitize(cuilParts.suffix)}</td>
        <td></td>
        <td>${sanitize(row.fechaNacimiento)}</td>
        <td>${sanitize(row.apellidoNombre)}</td>
        <td>${sanitize(row.situacionRevista)}</td>
        <td>${sanitize(modCarr)}</td>
        <td>${sanitize(row.pid)}</td>
        <td>${sanitize(row.cargoModulosHoras)}</td>
        <td></td>
        <td>${sanitize(row.curso)}</td>
        <td>${sanitize(row.division)}</td>
      </tr>`;
    })
    .join("");

  resultsBody.innerHTML = html;
  updateSelectionUI();
}

function toggleSelectAll(forceValue = null) {
  const shouldSelect = typeof forceValue === "boolean"
    ? forceValue
    : getSelectedRows().length !== state.rows.length;

  if (shouldSelect) {
    state.selectedRowIds = new Set(state.rows.map((row) => row.__rowId));
  } else {
    state.selectedRowIds.clear();
  }
  renderRows(state.rows);
}

function buildPayload(previewOnly) {
  const maxResults = Number(maxResultsInput.value || 30);
  const sheetConfig = getSheetConfigFromUi();
  const processMode = mapProcessValueToMode(modeInput.value);
  return {
    mode: processMode,
    gmailQuery: String(queryInput.value || "").trim(),
    maxResults: Number.isFinite(maxResults) ? maxResults : 30,
    sheetUrl: sheetConfig.sheetUrl,
    sheetName: sheetConfig.sheetName,
    startRow: sheetConfig.startRow,
    previewOnly: Boolean(previewOnly),
    accessToken: state.accessToken,
  };
}

function buildSavePayload(rows, delivery = "drive") {
  const sheetConfig = getSheetConfigFromUi();
  const processMode = mapProcessValueToMode(modeInput.value);
  return {
    mode: processMode,
    sheetUrl: sheetConfig.sheetUrl,
    sheetName: sheetConfig.sheetName,
    startRow: sheetConfig.startRow,
    accessToken: state.accessToken,
    outputTitle: "",
    rows,
    delivery: String(delivery || "drive"),
    encabezadoPac: collectPacHeaderData(),
  };
}

function formatSummary(result, previewOnly) {
  const parts = [
    `Mails encontrados: ${Number(result.totalMessages || 0)}`,
    `Filas extraidas: ${Number(result.rowsExtracted || 0)}`,
    `Omitidos sin DNI/CUIL: ${Number(result.omittedWithoutIdentity || 0)}`,
    `Omitidos sin CUPOF: ${Number(result.omittedWithoutCupof || 0)}`,
    `Errores: ${Number(result.errorsCount || 0)}`,
  ];
  if (!previewOnly && result.writeSummary) {
    parts.push(`Filas escritas: ${Number(result.writeSummary.rowsWritten || 0)}`);
    parts.push(`Rango: ${String(result.writeSummary.range || "-")}`);
  }
  return parts.join(" | ");
}

function formatCallableError(error) {
  if (isSubscriptionRequiredError(error)) {
    return "Debes tener una suscripcion activa para usar el modulo PAC.";
  }
  const base = formatUserError(error, "No se pudo ejecutar el proceso PAC.");
  const details = error?.details && typeof error.details === "object" ? error.details : null;
  if (!details) {
    return base;
  }

  const lines = [];
  if (details.errorType) {
    lines.push(`Tipo: ${String(details.errorType)}`);
  }
  if (Array.isArray(details.missingScopes) && details.missingScopes.length) {
    lines.push(`Scopes faltantes: ${details.missingScopes.join(", ")}`);
  }
  if (Array.isArray(details.grantedScopes) && details.grantedScopes.length) {
    lines.push(`Scopes del token: ${details.grantedScopes.join(", ")}`);
  }
  if (details.apiContext) {
    lines.push(`API: ${String(details.apiContext)}`);
  }
  if (details.status) {
    lines.push(`Estado HTTP: ${String(details.status)}`);
  }
  if (details.googleReason) {
    lines.push(`Motivo de Google: ${String(details.googleReason)}`);
  }
  if (details.googleErrorMessage) {
    lines.push(`Mensaje de Google: ${String(details.googleErrorMessage)}`);
  }

  return lines.length ? `${base}\n${lines.join("\n")}` : base;
}

function buildErrorEntries(errors) {
  const safeErrors = Array.isArray(errors) ? errors : [];
  return safeErrors.slice(0, 25).map((item, index) => {
    const id = String(item.messageId || "-");
    const reason = String(item.reason || "Sin detalle");
    const subject = String(item.subject || "(sin asunto)");
    const from = String(item.from || "(sin remitente)");
    const date = String(item.date || "(sin fecha)");
    const attachments = String(item.attachmentsSummary || "");
    const driveLinks = String(item.driveLinksSummary || "");
    const sourceErrors = formatListAsText(item.sourceErrors || "");
    const details = [
      `Motivo: ${reason}`,
      `Asunto: ${subject}`,
      `Remitente: ${from}`,
      `Fecha: ${date}`,
    ];
    if (attachments) {
      details.push(`Adjuntos detectados: ${attachments}`);
    }
    if (driveLinks) {
      details.push(`Links Drive detectados: ${driveLinks}`);
    }
    if (sourceErrors) {
      details.push(`Detalle fuente: ${sourceErrors}`);
    }
    return {
      title: `#${index + 1} | MessageId: ${id}`,
      details,
    };
  });
}

function renderErrors(errors) {
  const safeErrors = Array.isArray(errors) ? errors : [];
  const entries = buildErrorEntries(safeErrors);

  if (errorsSummaryEl) {
    errorsSummaryEl.textContent = `Errores detectados (${safeErrors.length})`;
  }
  if (errorsPanel) {
    errorsPanel.open = false;
  }
  if (!errorsListEl) {
    if (errorsMsg) {
      setMsg(errorsMsg, safeErrors.length ? `Errores detectados: ${safeErrors.length}` : "");
    }
    return;
  }

  errorsListEl.textContent = "";
  if (!entries.length) {
    const empty = document.createElement("li");
    empty.className = "pac-errors-empty";
    empty.textContent = "Sin errores.";
    errorsListEl.appendChild(empty);
    return;
  }

  entries.forEach((entry) => {
    const item = document.createElement("li");
    item.className = "pac-error-item";

    const titleEl = document.createElement("p");
    titleEl.className = "pac-error-title";
    titleEl.textContent = entry.title;
    item.appendChild(titleEl);

    entry.details.forEach((detail) => {
      const lineEl = document.createElement("p");
      lineEl.className = "pac-error-line";
      lineEl.textContent = detail;
      item.appendChild(lineEl);
    });

    errorsListEl.appendChild(item);
  });

  if (safeErrors.length > entries.length) {
    const truncated = document.createElement("li");
    truncated.className = "pac-errors-empty";
    truncated.textContent = `Se muestran ${entries.length} de ${safeErrors.length} errores.`;
    errorsListEl.appendChild(truncated);
  }
}

async function runPacProcess(previewOnly) {
  if (state.busy) {
    return;
  }
  if (!auth.currentUser) {
    setMsg(runMsg, "Inicia sesion con Google antes de ejecutar el proceso", true);
    return;
  }
  if (!state.accessToken) {
    setMsg(runMsg, "Primero presiona 'Conectar Gmail + Sheets + Drive' para autorizar permisos", true);
    return;
  }

  state.busy = true;
  setDriveResultButton("");
  setBusy(previewBtn, true);
  setBusy(runBtn, true);
  setMsg(runMsg, previewOnly ? "Ejecutando prueba..." : "Procesando...");
  setMsg(summaryMsg, "");
  renderErrors([]);

  const callable = httpsCallable(functions, "runPacProcess");
  try {
    const payload = buildPayload(previewOnly);
    const response = await callable(payload);
    const result = response.data || {};
    const rows = decorateRows(Array.isArray(result.rows) ? result.rows : []);

    state.rows = rows;
    state.savedFile = null;
    state.selectedRowIds = new Set(rows.map((row) => row.__rowId));
    renderRows(state.rows);

    let summaryText = formatSummary(result, previewOnly);
    if (result?.diagnostics?.tokenEmail) {
      summaryText += ` | Token: ${String(result.diagnostics.tokenEmail)}`;
    }
    if (Array.isArray(result?.diagnostics?.missingScopes) && result.diagnostics.missingScopes.length) {
      summaryText += ` | Scopes faltantes: ${result.diagnostics.missingScopes.join(", ")}`;
    }
    setMsg(summaryMsg, summaryText);
    renderErrors(result.errors);

    setMsg(runMsg, previewOnly ? "Prueba finalizada" : "Proceso completado");
  } catch (error) {
    console.error("PAC callable error", {
      code: error?.code || "",
      message: error?.message || "",
      details: error?.details || null,
      customData: error?.customData || null,
    });
    setMsg(runMsg, formatCallableError(error), true);
  } finally {
    state.busy = false;
    setBusy(previewBtn, false);
    setBusy(runBtn, false);
  }
}

async function processSelectedRows(delivery = "drive") {
  if (state.busy) {
    return null;
  }
  setDriveResultButton("");

  const encabezadoPac = collectPacHeaderData();
  if (!isPacHeaderComplete(encabezadoPac)) {
    const alertMessage = "debe completar los datos de encabezado del pac para continuar";
    window.alert(alertMessage);
    setMsg(runMsg, alertMessage, true);
    return null;
  }

  const selectedRows = getSelectedRows();
  if (!selectedRows.length) {
    setMsg(runMsg, "Selecciona al menos una fila antes de guardar en Drive", true);
    return null;
  }

  const sheetConfig = getSheetConfigFromUi();
  const sheetUrl = String(sheetConfig.sheetUrl || "").trim();
  if (!sheetUrl) {
    setMsg(runMsg, "Debes completar la URL de plantilla", true);
    return null;
  }

  state.busy = true;
  setBusy(previewBtn, true);
  setBusy(runBtn, true);
  if (floatSaveBtn) {
    setBusy(floatSaveBtn, true);
  }
  if (floatDownloadBtn) {
    setBusy(floatDownloadBtn, true);
  }
  const isDownload = delivery === "download";
  setMsg(runMsg, isDownload ? "Generando archivo para descarga..." : "Guardando archivo en Drive...");

  const callable = httpsCallable(functions, "savePacRowsToDrive");
  try {
    const payload = buildSavePayload(selectedRows, delivery);
    const response = await callable(payload);
    const result = response.data || {};

    if (isDownload) {
      const fileBase64 = String(result.fileBase64 || "");
      if (!fileBase64) {
        throw new Error("No se recibio el archivo XLSX para descarga");
      }
      const blob = decodeBase64ToBlob(result.fileBase64, result.fileMimeType);
      const fileName = String(result.fileName || "PAC.xlsx");
      downloadBlobFile(blob, fileName);
      setMsg(runMsg, `Archivo descargado: ${fileName}`);
      setDriveResultButton("");
      return result;
    }

    state.savedFile = result;
    const written = Number(result.rowsWritten || 0);
    const sheetUrlResult = String(result.sheetUrl || "");
    setDriveResultButton(sheetUrlResult);
    setMsg(runMsg, `Archivo guardado en Drive. Filas escritas: ${written}`);
    return result;
  } catch (error) {
    console.error("savePacRowsToDrive error", error);
    setDriveResultButton("");
    setMsg(runMsg, formatCallableError(error), true);
    return null;
  } finally {
    state.busy = false;
    setBusy(previewBtn, false);
    setBusy(runBtn, false);
    if (floatSaveBtn) {
      setBusy(floatSaveBtn, false);
    }
    if (floatDownloadBtn) {
      setBusy(floatDownloadBtn, false);
    }
  }
}

async function saveSelectedRowsToDrive() {
  return processSelectedRows("drive");
}

async function downloadSelectedRowsWorkbook() {
  return processSelectedRows("download");
}

function openPreviewTab() {
  const selectedRows = getSelectedRows();
  if (!selectedRows.length) {
    setMsg(runMsg, "Selecciona al menos una fila para abrir la vista previa", true);
    return;
  }

  const sheetConfig = getSheetConfigFromUi();
  const previewPayload = {
    rows: selectedRows,
    mode: mapProcessValueToMode(modeInput.value),
    sheetUrl: sheetConfig.sheetUrl,
    sheetName: sheetConfig.sheetName,
    startRow: sheetConfig.startRow,
    encabezadoPac: collectPacHeaderData(),
    accessToken: state.accessToken,
    savedFile: state.savedFile || null,
  };

  localStorage.setItem("pacPreviewPayload", JSON.stringify(previewPayload));
  window.open("/pac-preview.html", "_blank", "noopener");
}

function cancelSelectionFlow() {
  state.rows = [];
  state.selectedRowIds.clear();
  state.savedFile = null;
  setDriveResultButton("");
  renderRows([]);
  setMsg(summaryMsg, "");
  renderErrors([]);
  setMsg(runMsg, "Operacion cancelada");
}

function updateHeaderAuthButton(user) {
  if (!logoutBtn) {
    return;
  }
  if (user) {
    logoutBtn.textContent = "Cerrar sesion";
    logoutBtn.dataset.authAction = "logout";
    logoutBtn.classList.add("google-btn");
    return;
  }
  logoutBtn.textContent = "Iniciar sesion con Google";
  logoutBtn.dataset.authAction = "login";
  logoutBtn.classList.add("google-btn");
}

async function signInAndAuthorizeGoogleScopes() {
  try {
    const provider = new GoogleAuthProvider();
    provider.addScope("https://www.googleapis.com/auth/gmail.readonly");
    provider.addScope("https://www.googleapis.com/auth/spreadsheets");
    provider.addScope("https://www.googleapis.com/auth/drive.readonly");
    provider.addScope("https://www.googleapis.com/auth/drive");
    provider.setCustomParameters({
      prompt: "consent",
      include_granted_scopes: "true",
    });

    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const accessToken = credential?.accessToken || "";
    if (!accessToken) {
      throw new Error("No se obtuvo accessToken para Gmail/Sheets/Drive");
    }
    state.accessToken = accessToken;
    persistAccessToken(accessToken, result?.user?.uid || auth.currentUser?.uid || "");
    setMsg(authMsg, "Permisos Gmail + Sheets + Drive autorizados.");
    return true;
  } catch (error) {
    console.error(error);
    setMsg(authMsg, formatUserError(error, "No se pudo autorizar Gmail + Sheets + Drive."), true);
    return false;
  }
}

if (connectBtn) {
  connectBtn.addEventListener("click", async () => {
    await signInAndAuthorizeGoogleScopes();
  });
}

previewBtn.addEventListener("click", () => {
  runPacProcess(true);
});

runBtn.addEventListener("click", async () => {
  await saveSelectedRowsToDrive();
});

if (queryInput) {
  queryInput.addEventListener("change", () => {
    schedulePacExtractionConfigPersistence();
  });
}

if (modeInput) {
  modeInput.addEventListener("change", () => {
    renderProcessDependentGmailQueries();
    schedulePacExtractionConfigPersistence();
  });
}

if (useCustomSheetInput) {
  useCustomSheetInput.addEventListener("change", () => {
    applySheetCustomizationUi();
    persistSheetCustomizationToggle();
  });
}

if (headerSaveBtn) {
  headerSaveBtn.addEventListener("click", async () => {
    await savePacHeader();
  });
}

resultsBody.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.classList.contains("pac-row-checkbox")) {
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
  updateSelectionUI();
});

if (selectAllBtn) {
  selectAllBtn.addEventListener("click", () => {
    toggleSelectAll();
  });
}

if (selectAllCheckbox) {
  selectAllCheckbox.addEventListener("change", () => {
    toggleSelectAll(selectAllCheckbox.checked);
  });
}

if (floatCancelBtn) {
  floatCancelBtn.addEventListener("click", () => {
    cancelSelectionFlow();
  });
}

if (floatPreviewBtn) {
  floatPreviewBtn.addEventListener("click", () => {
    openPreviewTab();
  });
}

if (floatDownloadBtn) {
  floatDownloadBtn.addEventListener("click", async () => {
    await downloadSelectedRowsWorkbook();
  });
}

if (floatSaveBtn) {
  floatSaveBtn.addEventListener("click", async () => {
    await saveSelectedRowsToDrive();
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    if (!auth.currentUser) {
      await signInAndAuthorizeGoogleScopes();
      return;
    }
    try {
      await signOut(auth);
      state.accessToken = "";
      clearPersistedAccessToken();
      state.headerLoadedFromRemote = false;
      state.extractionConfigLoadedFromRemote = false;
      state.hasTenantAccess = false;
      applyHorariosLinkVisibility(null);
      cancelSelectionFlow();
      setMsg(authMsg, "Sesion cerrada");
      setMsg(runMsg, "");
    } catch (error) {
      console.error(error);
      setMsg(authMsg, "No se pudo cerrar sesion", true);
    }
  });
}

onAuthStateChanged(auth, (user) => {
  updateHeaderAuthButton(user);
  if (!user) {
    state.accessToken = "";
    clearPersistedAccessToken();
    userNameEl.textContent = "Sin sesion";
    userEmailEl.textContent = "-";
    state.headerLoadedFromRemote = false;
    state.extractionConfigLoadedFromRemote = false;
    state.hasTenantAccess = false;
    applyHorariosLinkVisibility(null);
    if (!state.accessToken) {
      setMsg(authMsg, "Inicia sesion con Google y luego autoriza Gmail + Sheets + Drive.");
    }
    return;
  }

  userNameEl.textContent = user.displayName || user.email || "Usuario";
  userEmailEl.textContent = user.email || "-";
  state.headerLoadedFromRemote = false;
  state.extractionConfigLoadedFromRemote = false;
  state.hasTenantAccess = false;
  if (!state.accessToken) {
    state.accessToken = restorePersistedAccessToken(user);
  }
  applyHorariosLinkVisibility(user);
  void (async () => {
    const hasTenantAccess = await refreshPacTenantAccess(user);
    if (!hasTenantAccess) {
      return;
    }
    await hydratePacHeaderForCurrentUser(user);
    await hydratePacExtractionConfigForCurrentUser(user);
  })();
  if (state.accessToken) {
    setMsg(authMsg, "Sesion iniciada con permisos Gmail + Sheets + Drive.");
  } else {
    setMsg(authMsg, "Sesion iniciada. Falta autorizar Gmail + Sheets + Drive.");
  }
});

initPacHeaderForm();
void hydratePacHeaderFromIndexedDb();
hydrateSheetCustomizationToggle();
setDefaultModeOption();
renderProcessDependentGmailQueries();
void hydratePacExtractionConfigFromIndexedDb();
applyHorariosLinkVisibility(null);
updateHeaderAuthButton(auth.currentUser);
setDriveResultButton("");
renderRows([]);
renderErrors([]);
setFloatingVisible(false);
