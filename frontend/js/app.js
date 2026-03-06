import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  setDoc,
  where,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { auth, db, functions } from "./firebaseClient.js";

const loginForm = document.getElementById("login-form");
const loginSection = document.getElementById("login-section");
const loginMsg = document.getElementById("login-msg");
const userName = document.getElementById("user-name");
const userEmail = document.getElementById("user-email");
const logoutBtn = document.getElementById("logout-btn");
const googleLoginBtn = document.getElementById("google-login-btn");
const panelSection = document.getElementById("panel-section");
const panelMsg = document.getElementById("panel-msg");
const mainTitle = document.getElementById("main-title");
const topBanner = document.querySelector(".top-banner");
const subBanner = document.getElementById("sub-banner");
const appRoot = document.querySelector(".app");
const homeTabBtn = document.getElementById("home-tab-btn");
const settingsTabBtn = document.getElementById("settings-tab-btn");
const homeSection = document.getElementById("home-section");
const settingsSection = document.getElementById("settings-section");
const homeMsg = document.getElementById("home-msg");
const homeCourseButtons = document.getElementById("home-course-buttons");
const homeSelectedCourse = document.getElementById("home-selected-course");
const courseScheduleWrap = document.getElementById("course-schedule-wrap");
const courseScheduleTitle = document.getElementById("course-schedule-title");
const courseScheduleTable = document.getElementById("course-schedule-table");
const homeSearchInput = document.getElementById("home-search-input");
const homeSearchClearBtn = document.getElementById("home-search-clear-btn");
const homeSearchBtn = document.getElementById("home-search-btn");
const homeSearchPidBtn = document.getElementById("home-search-pid-btn");
const homeCommandResults = document.getElementById("home-command-results");
const docenteEditorModal = document.getElementById("docente-editor-modal");
const docenteEditorForm = document.getElementById("docente-editor-form");
const docenteCopyBtn = document.getElementById("docente-copy-btn");
const docenteSaveBtn = document.getElementById("docente-save-btn");
const docenteCancelBtn = document.getElementById("docente-cancel-btn");
const loadingIndicator = document.getElementById("loading-indicator");
const loadingText = document.getElementById("loading-text");
const tenantEmptyImport = document.getElementById("tenant-empty-import");
const buttonConfigMsg = document.getElementById("button-config-msg");
const turnButtonConfig = document.getElementById("turn-button-config");
const saveButtonConfigBtn = document.getElementById("save-button-config-btn");
const reloadButtonConfigBtn = document.getElementById("reload-button-config-btn");
const sheetImportForm = document.getElementById("sheet-import-form");
const sheetUrlInput = document.getElementById("sheet-url");
const sheetNameInput = document.getElementById("sheet-name");
const loadCursosBtn = document.getElementById("load-cursos-btn");
const saveAllBtn = document.getElementById("save-all-btn");
const courseButtonsMsg = document.getElementById("course-buttons-msg");
const courseButtons = document.getElementById("course-buttons");
const selectedCourseLabel = document.getElementById("selected-course");
const importReview = document.getElementById("import-review");
const reviewProgress = document.getElementById("review-progress");
const reviewDocente = document.getElementById("review-docente");
const acceptDocenteBtn = document.getElementById("accept-docente-btn");
const skipDocenteBtn = document.getElementById("skip-docente-btn");
const cancelDocenteBtn = document.getElementById("cancel-docente-btn");
const importReviewCursos = document.getElementById("import-review-cursos");
const reviewCursoProgress = document.getElementById("review-curso-progress");
const reviewCurso = document.getElementById("review-curso");
const acceptCursoBtn = document.getElementById("accept-curso-btn");
const skipCursoBtn = document.getElementById("skip-curso-btn");
const cancelCursoBtn = document.getElementById("cancel-curso-btn");
const bulkSaveWrap = document.getElementById("bulk-save-wrap");
const refreshFab = document.getElementById("refresh-fab");
const refreshFabIcon = document.getElementById("refresh-fab-icon");

let importState = {
  tenantId: "",
  sheetUrl: "",
  sheetName: "",
  docentes: [],
  index: 0,
  accepted: 0,
  skipped: 0,
  cancelled: false,
  selectedCourse: "",
  courses: [],
};

let importCursosState = {
  tenantId: "",
  sheetUrl: "",
  sheetName: "",
  cursos: [],
  index: 0,
  accepted: 0,
  skipped: 0,
  cancelled: false,
  selectedCourse: "",
};

let homeState = {
  tenantId: "",
  courses: [],
  selectedCourse: "",
  docentesByCuil: new Map(),
  docentesByCupof: new Map(),
  docentesAll: [],
  currentItems: [],
  slotItems: new Map(),
  editingDocente: null,
  loadingCourseButton: "",
};

const TURN_ORDER = ["M", "T", "V", "C", "N", "S"];
const DEFAULT_BUTTON_CONFIG = {
  M: { label: "Manana", color: "#0f6ab8" },
  T: { label: "Tarde", color: "#bf5f00" },
  V: { label: "Vespertino", color: "#6f42c1" },
  C: { label: "Contraturno", color: "#0f766e" },
  N: { label: "Noche", color: "#1d3a8a" },
  S: { label: "Sin turno", color: "#4a5568" },
};

let buttonConfigState = clonePlain(DEFAULT_BUTTON_CONFIG);
let refreshInProgress = false;
let bannerAutoHideEnabled = false;
let bannerLastScrollY = 0;
let bannerHiddenByScroll = false;
let currentSessionLogKey = "";

function setMsg(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.classList.toggle("success", !isError);
}

function setPanelView(view) {
  const isHome = view === "home";
  homeSection.classList.toggle("is-hidden", !isHome);
  settingsSection.classList.toggle("is-hidden", isHome);
  homeTabBtn.classList.toggle("google-btn", !isHome);
  settingsTabBtn.classList.toggle("google-btn", isHome);
  homeTabBtn.classList.toggle("active-tab", isHome);
  settingsTabBtn.classList.toggle("active-tab", !isHome);
  if (mainTitle) {
    mainTitle.textContent = isHome ? "Inicio" : "Configuracion";
  }
  if (panelMsg) {
    panelMsg.classList.toggle("is-hidden", isHome);
  }
}

function syncBannerLayout() {
  if (!topBanner || !subBanner || !appRoot) {
    return;
  }
  const isHidden = topBanner.classList.contains("banner-hidden");
  const topHeight = isHidden ? 0 : topBanner.getBoundingClientRect().height || 72;
  const stickyTop = Math.ceil(topHeight + 8);
  const tableMaxHeight = Math.max(260, Math.floor(window.innerHeight - stickyTop - 140));
  document.documentElement.style.setProperty("--sticky-top", `${stickyTop}px`);
  document.documentElement.style.setProperty("--table-max-height", `${tableMaxHeight}px`);
  appRoot.style.marginTop = `${Math.ceil(topHeight + 16)}px`;
}

function setBannerHiddenByScroll(hidden) {
  if (!topBanner) {
    return;
  }
  if (bannerHiddenByScroll === hidden) {
    return;
  }
  bannerHiddenByScroll = hidden;
  topBanner.classList.toggle("banner-hidden", hidden);
  syncBannerLayout();
}

function handleBannerAutoHideScroll() {
  if (!bannerAutoHideEnabled) {
    return;
  }

  const currentY = Math.max(0, window.scrollY || 0);
  const delta = currentY - bannerLastScrollY;
  const absDelta = Math.abs(delta);

  if (currentY <= 24) {
    setBannerHiddenByScroll(false);
    bannerLastScrollY = currentY;
    return;
  }

  if (absDelta < 8) {
    bannerLastScrollY = currentY;
    return;
  }

  if (delta > 0 && currentY > 80) {
    setBannerHiddenByScroll(true);
  } else if (delta < 0) {
    setBannerHiddenByScroll(false);
  }

  bannerLastScrollY = currentY;
}

function setLoading(isLoading, text = "Cargando...") {
  loadingIndicator.classList.toggle("is-hidden", !isLoading);
  if (isLoading) {
    loadingText.textContent = text;
  }
  syncBannerLayout();
}

function normalizeDayColumn(day) {
  const value = String(day || "").trim().toUpperCase();
  if (value.startsWith("LUN")) return "LUNES";
  if (value.startsWith("MAR")) return "MARTES";
  if (value.startsWith("MIE")) return "MIERCOLES";
  if (value.startsWith("JUE")) return "JUEVES";
  if (value.startsWith("VIE")) return "VIERNES";
  return "";
}

function normalizeHorarioRange(value) {
  const compact = String(value || "").trim().replace(/\s+/g, " ");
  if (!compact) {
    return "";
  }
  const withDash = compact.replace(/\s*[-–—]\s*/g, " - ");
  const rangeMatch = withDash.match(/^(\d{1,2}):(\d{2}) - (\d{1,2}):(\d{2})(.*)$/);
  if (rangeMatch) {
    const startHour = Number(rangeMatch[1]);
    const startMin = Number(rangeMatch[2]);
    const endHour = Number(rangeMatch[3]);
    const endMin = Number(rangeMatch[4]);
    const suffix = String(rangeMatch[5] || "").trim();
    if (
      Number.isFinite(startHour) &&
      Number.isFinite(startMin) &&
      Number.isFinite(endHour) &&
      Number.isFinite(endMin)
    ) {
      const normalized =
        `${String(startHour).padStart(2, "0")}:${String(startMin).padStart(2, "0")}` +
        ` - ` +
        `${String(endHour).padStart(2, "0")}:${String(endMin).padStart(2, "0")}`;
      return suffix ? `${normalized} ${suffix}` : normalized;
    }
  }
  return withDash;
}

function parseStartMinutes(rangeText) {
  const text = normalizeHorarioRange(rangeText);
  const match = text.match(/(\d{1,2}):(\d{2})/);
  if (!match) {
    return Number.MAX_SAFE_INTEGER;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return hours * 60 + minutes;
}

function docenteDisplayNameByCuil(cuil) {
  const key = String(cuil || "").trim();
  if (!key || key === "sin datos") {
    return "-";
  }
  const fromMap = homeState.docentesByCuil.get(key);
  return fromMap || key;
}

function normalizeSituacionRevista(value) {
  return String(value || "").trim().toUpperCase();
}

function situacionToClass(situacion) {
  const s = normalizeSituacionRevista(situacion);
  if (s === "T") return "sit-t";
  if (s === "P") return "sit-p";
  if (s === "TI") return "sit-ti";
  if (s === "S") return "sit-s";
  return "";
}

function extractDocenteRefs(data) {
  const refs = [];
  if (Array.isArray(data?.cursoRefs)) {
    refs.push(...data.cursoRefs);
  }
  if (Array.isArray(data?.curso)) {
    refs.push(...data.curso);
  } else if (data?.curso && typeof data.curso === "object") {
    refs.push(data.curso);
  }
  if (Array.isArray(data?.cursos)) {
    const objectCursos = data.cursos.filter((item) => item && typeof item === "object");
    refs.push(...objectCursos);
  }
  return refs;
}

function findDocenteBySlot(item, preferNonSuplente = true) {
  const cupof = String(item?.cupof || "").trim();
  const candidates = cupof ? homeState.docentesByCupof.get(cupof) || [] : [];
  const titularCuil = String(item?.docenteCuil || "").trim();
  const suplenteCuil = String(item?.suplenteCuil || "").trim();
  const working = preferNonSuplente
    ? candidates.filter((candidate) => normalizeSituacionRevista(candidate?.situacionRevista) !== "S")
    : candidates.filter((candidate) => normalizeSituacionRevista(candidate?.situacionRevista) === "S");
  const list = working.length ? working : [];

  if (titularCuil && titularCuil !== suplenteCuil) {
    const byTitularCuil = list.find((candidate) => String(candidate?.cuil || "").trim() === titularCuil);
    if (byTitularCuil) {
      return byTitularCuil;
    }
  }

  if (preferNonSuplente) {
    const withoutSuplente = list.find(
      (candidate) => String(candidate?.cuil || "").trim() !== suplenteCuil
    );
    if (withoutSuplente) {
      return withoutSuplente;
    }
  }

  return list[0] || null;
}

function resolveTitularInfo(item) {
  const docente = findDocenteBySlot(item, true);
  if (docente) {
    return {
      name: String(docente.name || "-").trim() || "-",
      situacionRevista: normalizeSituacionRevista(docente.situacionRevista || "TI"),
      docente,
    };
  }
  const direct = docenteDisplayNameByCuil(item?.docenteCuil);
  return {
    name: direct && direct !== resolveSuplenteInfo(item).name ? direct : "-",
    situacionRevista: direct === "-" ? "" : "TI",
    docente: null,
  };
}

function resolveSuplenteInfo(item) {
  const suplenteCuil = String(item?.suplenteCuil || "").trim();
  const byCupof = findDocenteBySlot(item, false);
  if (byCupof) {
    return {
      name: String(byCupof.name || "").trim(),
      situacionRevista: normalizeSituacionRevista(byCupof.situacionRevista || "S"),
      docente: byCupof,
    };
  }
  if (!suplenteCuil || suplenteCuil === "sin datos") {
    return { name: "", situacionRevista: "", docente: null };
  }
  const directS = homeState.docentesAll.find((docente) => {
    const cuil = String(docente?.cuil || "").trim();
    if (!cuil || cuil !== suplenteCuil) {
      return false;
    }
    const refs = extractDocenteRefs(docente);
    const cupof = String(item?.cupof || "").trim();
    return refs.some((ref) => String(ref?.cupof || "").trim() === cupof && normalizeSituacionRevista(ref?.situacionRevista) === "S");
  });
  if (directS) {
    const name = `${String(directS.apellido || "").trim()} ${String(directS.nombre || "").trim()}`.trim();
    return {
      name: name || "-",
      situacionRevista: "S",
      docente: { id: directS.id, data: clonePlain(directS) },
    };
  }

  // Compatibilidad con datos historicos: si no existe ref "S",
  // igual tomamos el suplente por cuil + cupof.
  const legacyByCupof = homeState.docentesAll.find((docente) => {
    const cuil = String(docente?.cuil || "").trim();
    if (!cuil || cuil !== suplenteCuil) {
      return false;
    }
    const refs = extractDocenteRefs(docente);
    const cupof = String(item?.cupof || "").trim();
    return refs.some((ref) => String(ref?.cupof || "").trim() === cupof);
  });
  if (legacyByCupof) {
    const name = `${String(legacyByCupof.apellido || "").trim()} ${String(legacyByCupof.nombre || "").trim()}`.trim();
    return {
      name: name || "-",
      situacionRevista: "S",
      docente: { id: legacyByCupof.id, data: clonePlain(legacyByCupof) },
    };
  }
  return { name: "", situacionRevista: "", docente: null };
}

function esc(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stringifyFieldValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

function parseFieldValue(rawValue, originalValue) {
  const raw = String(rawValue || "").trim();
  if (typeof originalValue === "number") {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new Error("Hay un campo numerico invalido");
    }
    return parsed;
  }
  if (typeof originalValue === "boolean") {
    return raw.toLowerCase() === "true";
  }
  return raw;
}

function clonePlain(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return {};
  }
}

function setRefreshFabLoading(isLoading) {
  refreshInProgress = isLoading;
  if (!refreshFabIcon) {
    return;
  }
  refreshFabIcon.classList.toggle("is-spinning", isLoading);
}

function setButtonBusy(button, isBusy) {
  if (!button) {
    return;
  }
  button.disabled = isBusy;
  button.classList.toggle("is-loading", isBusy);
}

async function registerCurrentSession(user, tenantId, profile = {}) {
  const uid = String(user?.uid || "").trim();
  const safeTenantId = String(tenantId || "").trim();
  if (!uid || !safeTenantId) {
    return;
  }
  const key = `${uid}:${safeTenantId}`;
  if (currentSessionLogKey === key) {
    return;
  }

  const storageKey = `gpd_session_logged_${key}`;
  try {
    if (window.sessionStorage?.getItem(storageKey) === "1") {
      currentSessionLogKey = key;
      return;
    }
  } catch (error) {
    console.error("No se pudo leer sessionStorage", error);
  }

  try {
    const registerSession = httpsCallable(functions, "registerSession");
    await registerSession({
      tenantId: safeTenantId,
      email: String(profile?.correo || user?.email || "").trim().toLowerCase(),
      nombre: String(profile?.nombre || user?.displayName || "").trim(),
      provider: String(user?.providerData?.[0]?.providerId || "").trim(),
      source: "web",
    });
    currentSessionLogKey = key;
    try {
      window.sessionStorage?.setItem(storageKey, "1");
    } catch (error) {
      console.error("No se pudo escribir sessionStorage", error);
    }
  } catch (error) {
    console.error("No se pudo registrar sesion", error);
  }
}

function openCacheDb() {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open("gpd-cache", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("tenant_home")) {
        db.createObjectStore("tenant_home", { keyPath: "tenantId" });
      }
      if (!db.objectStoreNames.contains("course_schedule")) {
        db.createObjectStore("course_schedule", { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(storeName, key) {
  const db = await openCacheDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbSet(storeName, value) {
  const db = await openCacheDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const request = store.put(value);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function courseScheduleCacheId(tenantId, course) {
  return `${tenantId}__${normalizeCourse(course)}`;
}

function flattenEntityFields(value, currentPath = "", output = []) {
  if (Array.isArray(value)) {
    if (!value.length) {
      return output;
    }
    value.forEach((item, index) => {
      const nextPath = `${currentPath}[${index}]`;
      flattenEntityFields(item, nextPath, output);
    });
    return output;
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (!keys.length) {
      return output;
    }
    keys.forEach((key) => {
      const nextPath = currentPath ? `${currentPath}.${key}` : key;
      flattenEntityFields(value[key], nextPath, output);
    });
    return output;
  }

  output.push({ path: currentPath, value });
  return output;
}

function splitPath(path) {
  const parts = [];
  const re = /([^[.\]]+)|\[(\d+)\]/g;
  let match = re.exec(path);
  while (match) {
    if (match[1]) {
      parts.push(match[1]);
    } else {
      parts.push(Number(match[2]));
    }
    match = re.exec(path);
  }
  return parts;
}

function getValueByPath(obj, path) {
  const parts = splitPath(path);
  let cursor = obj;
  for (let i = 0; i < parts.length; i += 1) {
    if (cursor === null || cursor === undefined) {
      return undefined;
    }
    cursor = cursor[parts[i]];
  }
  return cursor;
}

function setValueByPath(obj, path, value) {
  const parts = splitPath(path);
  if (!parts.length) {
    return;
  }

  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    const nextKey = parts[i + 1];
    if (cursor[key] === undefined || cursor[key] === null) {
      cursor[key] = typeof nextKey === "number" ? [] : {};
    }
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
}

function renderEditableCard(container, entity) {
  const entries = flattenEntityFields(entity || {});
  container.innerHTML = `
    <div class="review-grid">
      ${entries
        .map(({ path, value }) => {
          const isLong = String(stringifyFieldValue(value)).length > 80;
          return `
            <label class="${isLong ? "full" : ""}">
              <span class="mini-title">${esc(path)}</span>
              <input data-card-path="${esc(path)}" value="${esc(stringifyFieldValue(value))}" />
            </label>
          `;
        })
        .join("")}
    </div>
  `;
}

function readEditedObjectFromCard(container, originalEntity) {
  const result = clonePlain(originalEntity || {});
  const inputs = container.querySelectorAll("[data-card-path]");
  inputs.forEach((inputEl) => {
    const path = inputEl.getAttribute("data-card-path");
    if (!path) {
      return;
    }
    const originalValue = getValueByPath(originalEntity || {}, path);
    const parsedValue = parseFieldValue(inputEl.value, originalValue);
    setValueByPath(result, path, parsedValue);
  });
  return result;
}

function appendPanelLog(text, isError = false) {
  const line = String(text || "").trim();
  if (!line) {
    return;
  }
  if (!panelMsg.textContent.trim()) {
    setMsg(panelMsg, line, isError);
    return;
  }
  panelMsg.textContent = `${panelMsg.textContent}\n${line}`;
  if (isError) {
    panelMsg.classList.add("error");
    panelMsg.classList.remove("success");
  }
}

function toggleBulkSaveButton() {
  const pendingDocentes = Math.max(importState.docentes.length - importState.index, 0);
  const pendingCursos = Math.max(importCursosState.cursos.length - importCursosState.index, 0);
  const visible = pendingDocentes > 0 || pendingCursos > 0;
  bulkSaveWrap.classList.toggle("is-hidden", !visible);
}

function renderDocenteCard(docente) {
  const data = normalizeDocenteForReview(docente);
  const coreFields = [
    ["apellido", "Apellido"],
    ["nombre", "Nombre"],
    ["cuil", "CUIL"],
    ["fechaNacimiento", "Fecha Nacimiento"],
    ["telefono", "Telefono"],
    ["correo", "Correo"],
    ["domicilio", "Domicilio"],
    ["pid", "PID"],
  ];

  const coreHtml = coreFields
    .map(([path, label]) => `
      <label>
        <span class="mini-title">${esc(label)}</span>
        <input data-card-path="${esc(path)}" value="${esc(stringifyFieldValue(data?.[path]))}" />
      </label>
    `)
    .join("");

  const corePaths = new Set(coreFields.map(([path]) => path));
  const extraEntries = flattenEntityFields(data)
    .filter(({ path }) => path && !path.startsWith("cursoRefs[") && !corePaths.has(path))
    .sort((a, b) => a.path.localeCompare(b.path, "es", { numeric: true, sensitivity: "base" }));
  const extraHtml = extraEntries
    .map(({ path, value }) => {
      const isLong = String(stringifyFieldValue(value)).length > 80;
      return `
        <label class="${isLong ? "full" : ""}">
          <span class="mini-title">${esc(path)}</span>
          <input data-card-path="${esc(path)}" value="${esc(stringifyFieldValue(value))}" />
        </label>
      `;
    })
    .join("");

  const refs = Array.isArray(data?.cursoRefs) ? data.cursoRefs : [];
  const refsRowsHtml = refs.length
    ? refs
      .map((item, index) => `
        <tr>
          <td><input data-card-path="cursoRefs[${index}].cupof" value="${esc(stringifyFieldValue(item?.cupof))}" /></td>
          <td><input data-card-path="cursoRefs[${index}].curso" value="${esc(stringifyFieldValue(item?.curso))}" /></td>
          <td><input data-card-path="cursoRefs[${index}].materia" value="${esc(stringifyFieldValue(item?.materia))}" /></td>
          <td><input data-card-path="cursoRefs[${index}].situacionRevista" value="${esc(stringifyFieldValue(item?.situacionRevista))}" /></td>
        </tr>
      `)
      .join("")
    : '<tr><td colspan="4" class="msg">Sin cursoRefs detectados</td></tr>';

  reviewDocente.innerHTML = `
    <div class="review-grid docente-core-grid">
      ${coreHtml}
    </div>
    <div class="docente-cupof-wrap">
      <p class="mini-title">Asignaciones por CUPOF</p>
      <div class="docente-cupof-table-wrap">
        <table class="docente-cupof-table">
          <thead>
            <tr>
              <th>CUPOF</th>
              <th>Curso</th>
              <th>Materia</th>
              <th>Revista</th>
            </tr>
          </thead>
          <tbody>${refsRowsHtml}</tbody>
        </table>
      </div>
    </div>
    ${extraHtml ? `<div class="review-grid docente-extra-grid">${extraHtml}</div>` : ""}
  `;
}

function renderCursoCard(curso) {
  renderEditableCard(reviewCurso, curso);
}

function readEditedDocenteFromCard() {
  const original = importState.docentes[importState.index];
  if (!original || !reviewDocente.querySelector("[data-card-path]")) {
    return original;
  }
  return readEditedObjectFromCard(reviewDocente, original);
}

function readEditedCursoFromCard() {
  const original = importCursosState.cursos[importCursosState.index];
  if (!original || !reviewCurso.querySelector("[data-card-path]")) {
    return original;
  }
  return readEditedObjectFromCard(reviewCurso, original);
}

function clearDocentesReviewOnly() {
  importState.docentes = [];
  importState.index = 0;
  importState.accepted = 0;
  importState.skipped = 0;
  importState.cancelled = false;
  importReview.classList.add("is-hidden");
  reviewProgress.textContent = "";
  reviewDocente.innerHTML = "";
}

function clearCursosReviewOnly() {
  importCursosState.cursos = [];
  importCursosState.index = 0;
  importCursosState.accepted = 0;
  importCursosState.skipped = 0;
  importCursosState.cancelled = false;
  importReviewCursos.classList.add("is-hidden");
  reviewCursoProgress.textContent = "";
  reviewCurso.innerHTML = "";
}

function updateSessionLayout(isLoggedIn) {
  loginSection.classList.toggle("is-hidden", isLoggedIn);
  logoutBtn.classList.toggle("is-hidden", !isLoggedIn);
  panelSection.classList.toggle("is-hidden", !isLoggedIn);
  subBanner.classList.toggle("is-hidden", !isLoggedIn);
  refreshFab.classList.toggle("is-hidden", !isLoggedIn);
  bannerAutoHideEnabled = isLoggedIn;
  bannerLastScrollY = Math.max(0, window.scrollY || 0);
  if (!isLoggedIn) {
    setBannerHiddenByScroll(false);
  } else {
    handleBannerAutoHideScroll();
  }
  syncBannerLayout();
}

function resetImportState() {
  importState = {
    tenantId: "",
    sheetUrl: "",
    sheetName: "",
    docentes: [],
    index: 0,
    accepted: 0,
    skipped: 0,
    cancelled: false,
    selectedCourse: "",
    courses: [],
  };
  importReview.classList.add("is-hidden");
  importReviewCursos.classList.add("is-hidden");
  reviewProgress.textContent = "";
  reviewDocente.innerHTML = "";
  reviewCursoProgress.textContent = "";
  reviewCurso.innerHTML = "";
  courseButtonsMsg.textContent = "";
  courseButtons.innerHTML = "";
  selectedCourseLabel.textContent = "Curso seleccionado: -";
  bulkSaveWrap.classList.add("is-hidden");
  importCursosState = {
    tenantId: "",
    sheetUrl: "",
    sheetName: "",
    cursos: [],
    index: 0,
    accepted: 0,
    skipped: 0,
    cancelled: false,
    selectedCourse: "",
  };
  homeState = {
    tenantId: "",
    courses: [],
    selectedCourse: "",
    docentesByCuil: new Map(),
    docentesByCupof: new Map(),
    docentesAll: [],
    currentItems: [],
    slotItems: new Map(),
    editingDocente: null,
    loadingCourseButton: "",
  };
  buttonConfigState = clonePlain(DEFAULT_BUTTON_CONFIG);
  renderButtonConfigEditor();
  setMsg(buttonConfigMsg, "");
  homeCourseButtons.innerHTML = "";
  homeSelectedCourse.textContent = "Curso seleccionado: -";
  courseScheduleWrap.classList.add("is-hidden");
  courseScheduleTable.innerHTML = "";
  setMsg(homeMsg, "");
  if (homeCommandResults) {
    homeCommandResults.textContent = "";
  }
  if (homeSearchInput) {
    homeSearchInput.value = "";
  }
  closeDocenteEditor();
  setLoading(false);
}

function renderCurrentDocente() {
  const total = importState.docentes.length;
  if (!total || importState.cancelled) {
    importReview.classList.add("is-hidden");
    toggleBulkSaveButton();
    return;
  }

  if (importState.index >= total) {
    importReview.classList.add("is-hidden");
    setMsg(
      panelMsg,
      `Importacion finalizada. Guardados: ${importState.accepted}. Omitidos: ${importState.skipped}.`
    );
    toggleBulkSaveButton();
    return;
  }

  const docente = normalizeDocenteForReview(importState.docentes[importState.index]);
  importState.docentes[importState.index] = docente;
  importReview.classList.remove("is-hidden");
  reviewProgress.textContent = `Docente ${importState.index + 1} de ${total}`;
  renderDocenteCard(docente);
  toggleBulkSaveButton();
}

function renderCurrentCurso() {
  const total = importCursosState.cursos.length;
  if (!total || importCursosState.cancelled) {
    importReviewCursos.classList.add("is-hidden");
    toggleBulkSaveButton();
    return;
  }

  if (importCursosState.index >= total) {
    importReviewCursos.classList.add("is-hidden");
    setMsg(
      panelMsg,
      `Importacion de cursos finalizada. Guardados: ${importCursosState.accepted}. Omitidos: ${importCursosState.skipped}.`
    );
    toggleBulkSaveButton();
    return;
  }

  const curso = importCursosState.cursos[importCursosState.index];
  importReviewCursos.classList.remove("is-hidden");
  reviewCursoProgress.textContent = `Curso ${importCursosState.index + 1} de ${total}`;
  renderCursoCard(curso);
  toggleBulkSaveButton();
}

async function checkTenantDataAndToggleImport(tenantId) {
  if (!tenantId) {
    return;
  }
  tenantEmptyImport.classList.remove("is-hidden");
  setMsg(panelMsg, "");
}

function normalizeCourse(value) {
  return String(value || "").trim().toUpperCase();
}

function firstNumberInText(value) {
  const match = String(value || "").match(/\d+/);
  return match ? Number(match[0]) : Number.POSITIVE_INFINITY;
}

function compareCourseCodes(a, b) {
  const left = normalizeCourse(a);
  const right = normalizeCourse(b);
  const leftNum = firstNumberInText(left);
  const rightNum = firstNumberInText(right);
  if (leftNum !== rightNum) {
    return leftNum - rightNum;
  }
  return left.localeCompare(right, "es", { numeric: true, sensitivity: "base" });
}

function isLikelyCourseCode(value) {
  const course = normalizeCourse(value);
  if (!course) {
    return false;
  }
  if (course === "SEDE" || course === "AN" || course === "EX") {
    return false;
  }
  if (course.length > 10) {
    return false;
  }
  return /\d/.test(course);
}

function sanitizeCourseList(values) {
  const list = Array.isArray(values) ? values : [];
  const unique = [];
  const seen = new Set();
  list.forEach((raw) => {
    const item = normalizeCourse(raw?.course || raw);
    if (!isLikelyCourseCode(item)) {
      return;
    }
    if (seen.has(item)) {
      return;
    }
    seen.add(item);
    unique.push(item);
  });
  return unique;
}

function collectCoursesFromDocentes(docentes) {
  const list = Array.isArray(docentes) ? docentes : [];
  const out = [];
  list.forEach((docente) => {
    const refs = Array.isArray(docente?.cursoRefs) ? docente.cursoRefs : [];
    refs.forEach((ref) => {
      out.push(ref?.curso);
    });
  });
  return out;
}

function collectCoursesFromCursos(cursos) {
  const list = Array.isArray(cursos) ? cursos : [];
  return list.map((curso) => curso?.curso);
}

function sortCursoRefsByCupof(refs) {
  const list = Array.isArray(refs) ? refs : [];
  return list.slice().sort((a, b) => {
    const cupofA = String(a?.cupof || "").trim();
    const cupofB = String(b?.cupof || "").trim();
    const numA = firstNumberInText(cupofA);
    const numB = firstNumberInText(cupofB);
    if (numA !== numB) {
      return numA - numB;
    }
    return cupofA.localeCompare(cupofB, "es", { numeric: true, sensitivity: "base" });
  });
}

function normalizeDocenteForReview(docente) {
  const normalized = clonePlain(docente || {});
  normalized.cursoRefs = sortCursoRefsByCupof(normalized.cursoRefs);
  return normalized;
}

function hasSheetGid(sheetUrl) {
  return /[?&#]gid=\d+/.test(String(sheetUrl || ""));
}

function normalizeTurn(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (raw.startsWith("M")) return "M";
  if (raw.startsWith("T")) return "T";
  if (raw.startsWith("V")) return "V";
  if (raw.startsWith("C")) return "C";
  if (raw.startsWith("N")) return "N";
  return "S";
}

function normalizeRenderableTurn(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (raw === "M" || raw === "T" || raw === "V") {
    return raw;
  }
  return "";
}

function pickRenderableTurn(values) {
  const list = Array.isArray(values) ? values : [];
  const firstPassCount = Math.min(list.length, 2);
  for (let i = 0; i < firstPassCount; i += 1) {
    const turn = normalizeRenderableTurn(list[i]);
    if (turn) {
      return turn;
    }
  }
  for (let i = firstPassCount; i < list.length; i += 1) {
    const turn = normalizeRenderableTurn(list[i]);
    if (turn) {
      return turn;
    }
  }
  return "S";
}

async function resolveCourseButtonTurn(tenantId, course, fallbackTurns = []) {
  const fromFallback = pickRenderableTurn(fallbackTurns);
  if (fromFallback !== "S") {
    return fromFallback;
  }

  const cachedItems = await loadCourseScheduleCache(tenantId, course);
  if (Array.isArray(cachedItems) && cachedItems.length) {
    const fromCache = pickRenderableTurn(cachedItems.map((item) => item?.turno));
    if (fromCache !== "S") {
      return fromCache;
    }
  }

  try {
    const firstTwoItemsSnap = await getDocs(
      query(collection(db, "tenants", tenantId, "cursos", course, "items"), limit(2))
    );
    const firstTwoTurns = firstTwoItemsSnap.docs.map((itemSnap) => (itemSnap.data() || {}).turno);
    const fromFirstTwo = pickRenderableTurn(firstTwoTurns);
    if (fromFirstTwo !== "S") {
      return fromFirstTwo;
    }

    const allItemsSnap = await getDocs(collection(db, "tenants", tenantId, "cursos", course, "items"));
    const allTurns = allItemsSnap.docs.map((itemSnap) => (itemSnap.data() || {}).turno);
    return pickRenderableTurn(allTurns);
  } catch (error) {
    console.error("No se pudo resolver turno del boton", course, error);
    return "S";
  }
}

function normalizeHexColor(value, fallback) {
  const raw = String(value || "").trim();
  const isValid = /^#([0-9a-fA-F]{6})$/.test(raw);
  return isValid ? raw : fallback;
}

function normalizeButtonConfig(rawConfig) {
  const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const normalized = {};
  TURN_ORDER.forEach((turn) => {
    const fromDb = source[turn] || {};
    const fallback = DEFAULT_BUTTON_CONFIG[turn];
    normalized[turn] = {
      label: String(fromDb.label || fallback.label || turn).trim() || fallback.label,
      color: normalizeHexColor(fromDb.color, fallback.color),
    };
  });
  return normalized;
}

function getTurnButtonConfig(turnValue) {
  const turn = normalizeTurn(turnValue);
  const fromState = buttonConfigState?.[turn];
  if (fromState) {
    return fromState;
  }
  return DEFAULT_BUTTON_CONFIG[turn] || DEFAULT_BUTTON_CONFIG.S;
}

function applyTurnButtonStyle(button, turnValue) {
  const config = getTurnButtonConfig(turnValue);
  button.style.backgroundColor = config.color;
  button.style.borderColor = config.color;
  button.title = `${config.label} (${normalizeTurn(turnValue)})`;
}

function renderButtonConfigEditor() {
  if (!turnButtonConfig) {
    return;
  }
  turnButtonConfig.innerHTML = "";
  TURN_ORDER.forEach((turn) => {
    const config = getTurnButtonConfig(turn);
    const row = document.createElement("div");
    row.className = "turn-config-row";
    row.innerHTML = `
      <div class="turn-code">${turn}</div>
      <label>Nombre
        <input type="text" data-turn="${turn}" data-key="label" value="${esc(config.label)}" />
      </label>
      <label>Color
        <input type="color" data-turn="${turn}" data-key="color" value="${esc(config.color)}" />
      </label>
    `;
    turnButtonConfig.appendChild(row);
  });
}

function readButtonConfigFromEditor() {
  const output = {};
  TURN_ORDER.forEach((turn) => {
    const fallback = DEFAULT_BUTTON_CONFIG[turn];
    const labelInput = turnButtonConfig.querySelector(`input[data-turn="${turn}"][data-key="label"]`);
    const colorInput = turnButtonConfig.querySelector(`input[data-turn="${turn}"][data-key="color"]`);
    const label = String(labelInput?.value || fallback.label).trim() || fallback.label;
    const color = normalizeHexColor(colorInput?.value, fallback.color);
    output[turn] = { label, color };
  });
  return output;
}

async function loadButtonConfig(tenantId, options = {}) {
  const { allowFirestore = true } = options;
  if (!tenantId) {
    buttonConfigState = clonePlain(DEFAULT_BUTTON_CONFIG);
    renderButtonConfigEditor();
    return;
  }
  if (!allowFirestore) {
    renderButtonConfigEditor();
    return;
  }
  try {
    const configRef = doc(db, "tenants", tenantId, "botones", "config");
    const snap = await getDoc(configRef);
    if (!snap.exists()) {
      buttonConfigState = clonePlain(DEFAULT_BUTTON_CONFIG);
      renderButtonConfigEditor();
      setMsg(buttonConfigMsg, "Usando configuracion de botones por defecto.");
      return;
    }
    const data = snap.data() || {};
    buttonConfigState = normalizeButtonConfig(data.turnos);
    renderButtonConfigEditor();
    setMsg(buttonConfigMsg, "Configuracion de botones cargada.");
  } catch (error) {
    console.error(error);
    buttonConfigState = clonePlain(DEFAULT_BUTTON_CONFIG);
    renderButtonConfigEditor();
    setMsg(buttonConfigMsg, "No se pudo cargar configuracion de botones", true);
  }
}

async function loadCourseButtonsFromFirestore(tenantId) {
  if (!tenantId) {
    return [];
  }
  try {
    const snap = await getDocs(collection(db, "tenants", tenantId, "botones"));
    const entries = [];
    for (let i = 0; i < snap.docs.length; i += 1) {
      const docSnap = snap.docs[i];
      if (docSnap.id === "config") {
        continue;
      }
      const data = docSnap.data() || {};
      const course = normalizeCourse(data.course || docSnap.id);
      if (!course) {
        continue;
      }

      const turn = await resolveCourseButtonTurn(tenantId, course, [data.turno]);

      entries.push({
        course,
        turno: turn,
      });
    }
    return entries.sort((a, b) => a.course.localeCompare(b.course));
  } catch (error) {
    console.error("No se pudieron cargar botones de cursos", error);
    return [];
  }
}

async function upsertCourseButton(tenantId, courseName, turnValue) {
  const course = normalizeCourse(courseName);
  if (!tenantId || !course) {
    return;
  }
  const turn = pickRenderableTurn([turnValue]);
  await setDoc(
    doc(db, "tenants", tenantId, "botones", course),
    {
      course,
      turno: turn,
      updatedAt: new Date(),
    },
    { merge: true }
  );
}

async function loadTenantHomeCache(tenantId) {
  try {
    const cached = await idbGet("tenant_home", tenantId);
    if (!cached) {
      return false;
    }
    homeState.tenantId = tenantId;
    homeState.docentesByCuil = new Map(Array.isArray(cached.docentesByCuil) ? cached.docentesByCuil : []);
    homeState.docentesByCupof = new Map(Array.isArray(cached.docentesByCupof) ? cached.docentesByCupof : []);
    homeState.docentesAll = Array.isArray(cached.docentesAll) ? cached.docentesAll : [];
    buttonConfigState = normalizeButtonConfig(cached.buttonConfig);
    renderButtonConfigEditor();
    renderCourseButtons(Array.isArray(cached.courses) ? cached.courses : []);
    renderHomeCourseButtons(Array.isArray(cached.courseButtons) ? cached.courseButtons : []);
    setMsg(homeMsg, "Mostrando datos locales...");
    return true;
  } catch (error) {
    console.error("No se pudo leer cache local de tenant", error);
    return false;
  }
}

async function saveTenantHomeCache(tenantId, payload) {
  try {
    await idbSet("tenant_home", {
      tenantId,
      updatedAt: Date.now(),
      buttonConfig: clonePlain(buttonConfigState),
      ...payload,
    });
  } catch (error) {
    console.error("No se pudo guardar cache local de tenant", error);
  }
}

async function loadCourseScheduleCache(tenantId, course) {
  try {
    const cached = await idbGet("course_schedule", courseScheduleCacheId(tenantId, course));
    if (!cached || !Array.isArray(cached.items)) {
      return null;
    }
    return cached.items;
  } catch (error) {
    console.error("No se pudo leer cache local de horario", error);
    return null;
  }
}

async function saveCourseScheduleCache(tenantId, course, items) {
  try {
    await idbSet("course_schedule", {
      id: courseScheduleCacheId(tenantId, course),
      tenantId,
      course: normalizeCourse(course),
      items: Array.isArray(items) ? items : [],
      updatedAt: Date.now(),
    });
  } catch (error) {
    console.error("No se pudo guardar cache local de horario", error);
  }
}

function setSelectedCourse(courseName) {
  importState.selectedCourse = courseName;
  selectedCourseLabel.textContent = `Curso seleccionado: ${courseName || "-"}`;
}

function renderCourseButtons(courses) {
  const safeCourses = sanitizeCourseList(courses).sort(compareCourseCodes);
  courseButtons.innerHTML = "";
  if (!safeCourses.length) {
    courseButtonsMsg.textContent = "No hay cursos cargados en Firestore. Se creara boton 1A por defecto.";
    const defaultCourse = "1A";
    importState.courses = [defaultCourse];
    setSelectedCourse(defaultCourse);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `Cargar ${defaultCourse}`;
    button.addEventListener("click", () => setSelectedCourse(defaultCourse));
    courseButtons.appendChild(button);
    return;
  }

  importState.courses = safeCourses;
  courseButtonsMsg.textContent = `Cursos detectados: ${safeCourses.join(", ")}`;

  safeCourses.forEach((courseName) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `Cargar ${courseName}`;
    button.addEventListener("click", () => setSelectedCourse(courseName));
    courseButtons.appendChild(button);
  });

  const preferred = safeCourses.find((course) => normalizeCourse(course) === "1A") || safeCourses[0];
  setSelectedCourse(preferred);
}

function updateHomeCourseButtonSelection() {
  const selected = normalizeCourse(homeState.selectedCourse);
  const buttons = homeCourseButtons.querySelectorAll(".course-btn");
  buttons.forEach((button) => {
    const isSelected = normalizeCourse(button.dataset.course || "") === selected;
    button.classList.toggle("active-course", isSelected);
  });
}

function renderHomeCourseButtons(courses) {
  homeCourseButtons.innerHTML = "";
  homeState.courses = courses;

  if (!courses.length) {
    homeSelectedCourse.textContent = "Curso seleccionado: -";
    courseScheduleWrap.classList.add("is-hidden");
    setMsg(homeMsg, "No hay cursos guardados todavia", true);
    return;
  }

  const byTurn = new Map([
    ["M", []],
    ["T", []],
    ["V", []],
  ]);

  courses.forEach((entry) => {
    const course = normalizeCourse(entry?.course || entry);
    if (!course) {
      return;
    }
    const turn = pickRenderableTurn([entry?.turno]);
    if (!byTurn.has(turn)) {
      return;
    }
    byTurn.get(turn).push({
      course,
      turn,
    });
  });

  const turnLabels = {
    M: "Manana",
    T: "Tarde",
    V: "Vespertino",
  };

  ["M", "T", "V"].forEach((turn) => {
    const items = byTurn.get(turn) || [];
    if (!items.length) {
      return;
    }

    const row = document.createElement("div");
    row.className = "course-turn-row";
    const label = document.createElement("div");
    label.className = "turn-label";
    label.textContent = turnLabels[turn] || turn;
    row.appendChild(label);

    const buttonsWrap = document.createElement("div");
    buttonsWrap.className = "turn-buttons";

    items
      .sort((a, b) => a.course.localeCompare(b.course))
      .forEach((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `course-btn turn-${item.turn.toLowerCase()}`;
        button.dataset.course = item.course;
        button.textContent = item.course;
        applyTurnButtonStyle(button, item.turn);
        button.addEventListener("click", async () => {
          if (homeState.loadingCourseButton) {
            return;
          }
          homeState.loadingCourseButton = item.course;
          button.classList.add("is-loading");
          try {
            await loadScheduleForCourse(item.course, {
              preferCache: true,
              forceRefresh: false,
              allowFirestore: false,
            });
          } finally {
            homeState.loadingCourseButton = "";
            button.classList.remove("is-loading");
          }
        });
        buttonsWrap.appendChild(button);
      });

    row.appendChild(buttonsWrap);
    homeCourseButtons.appendChild(row);
  });

  updateHomeCourseButtonSelection();
}

async function buildDocentesByCuilMap(tenantId) {
  const docentesSnap = await getDocs(collection(db, "tenants", tenantId, "docentes"));
  const map = new Map();
  const cupofMap = new Map();
  const docentesAll = [];
  docentesSnap.docs.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const cuil = String(data.cuil || "").trim();
    const apellido = String(data.apellido || "").trim();
    const nombre = String(data.nombre || "").trim();
    const fullName = `${apellido} ${nombre}`.trim() || cuil || "-";
    if (cuil && cuil !== "sin datos") {
      map.set(cuil, fullName);
    }

    const refs = extractDocenteRefs(data);
    refs.forEach((ref) => {
      const cupof = String(ref?.cupof || "").trim();
      if (!cupof || !fullName || fullName === "-") {
        return;
      }
      if (!cupofMap.has(cupof)) {
        cupofMap.set(cupof, []);
      }
      cupofMap.get(cupof).push({
        id: docSnap.id,
        cuil,
        name: fullName,
        situacionRevista: normalizeSituacionRevista(ref?.situacionRevista),
        data: clonePlain(data),
      });
    });
    docentesAll.push({ id: docSnap.id, ...clonePlain(data) });
  });
  homeState.docentesByCuil = map;
  homeState.docentesByCupof = cupofMap;
  homeState.docentesAll = docentesAll;
}

function renderScheduleTable(curso, items) {
  const days = ["LUNES", "MARTES", "MIERCOLES", "JUEVES", "VIERNES"];
  const slots = new Map();
  const contracturnoByDay = new Map();
  days.forEach((day) => contracturnoByDay.set(day, []));
  const allRanges = new Set();
  let slotIndex = 0;
  homeState.currentItems = Array.isArray(items) ? items : [];
  homeState.slotItems = new Map();

  items.forEach((item) => {
    const isContracturno = normalizeTurn(item?.turno) === "C";
    const dias = Array.isArray(item?.diaHorario?.dias) ? item.diaHorario.dias : [];
    dias.forEach((diaItem) => {
      const day = normalizeDayColumn(diaItem?.dia);
      const range = normalizeHorarioRange(diaItem?.horario);
      if (!day || !range) {
        return;
      }
      if (isContracturno) {
        contracturnoByDay.get(day)?.push({ item, range });
        return;
      }
      allRanges.add(range);
      const key = `${day}__${range}`;
      if (!slots.has(key)) {
        slots.set(key, []);
      }
      slots.get(key).push(item);
    });
  });

  const ranges = Array.from(allRanges).sort((a, b) => {
    const byTime = parseStartMinutes(a) - parseStartMinutes(b);
    if (byTime !== 0) {
      return byTime;
    }
    return a.localeCompare(b);
  });

  const hasContracturno = days.some((day) => (contracturnoByDay.get(day) || []).length > 0);

  if (!ranges.length && !hasContracturno) {
    courseScheduleWrap.classList.add("is-hidden");
    setMsg(homeMsg, `El curso ${curso} no tiene horarios cargados`, true);
    return;
  }

  const rowsHtml = ranges
    .map((range) => {
      const dayCells = days
        .map((day) => {
          const key = `${day}__${range}`;
          const dayItems = slots.get(key) || [];
          if (!dayItems.length) {
            return "<td></td>";
          }
          let firstSlotId = "";
          const slotHtml = dayItems
            .map((item) => {
              const slotId = `${curso}_${day}_${range}_${slotIndex}`;
              slotIndex += 1;
              homeState.slotItems.set(slotId, item);
              if (!firstSlotId) {
                firstSlotId = slotId;
              }
              const materia = esc(item.materia || "-");
              const titularInfo = resolveTitularInfo(item);
              const suplenteInfo = resolveSuplenteInfo(item);
              const titularClass = situacionToClass(titularInfo.situacionRevista);
              const suplenteClass = situacionToClass(suplenteInfo.situacionRevista);
              const titular = esc(titularInfo.name);
              const suplenteHtml = suplenteInfo.name
                ? `<span class="meta ${suplenteClass}">Suplente: ${esc(suplenteInfo.name)}</span>`
                : "";
              const cupof = esc(item.cupof || "-");
              return `
                <div class="schedule-slot" data-slot-id="${esc(slotId)}">
                  <span class="title">${materia}</span>
                  <span class="meta docente-main ${titularClass}">${titular}</span>
                  ${suplenteHtml}
                  <span class="meta cupof">CUPOF: ${cupof}</span>
                </div>
              `;
            })
            .join("");
          return `<td data-slot-id="${esc(firstSlotId)}">${slotHtml}</td>`;
        })
        .join("");

      return `<tr><th>${esc(range)}</th>${dayCells}</tr>`;
    })
    .join("");

  let contracturnoRowHtml = "";
  if (hasContracturno) {
    const contracturnoCells = days
      .map((day) => {
        const entries = (contracturnoByDay.get(day) || []).sort(
          (a, b) => parseStartMinutes(a.range) - parseStartMinutes(b.range)
        );
        if (!entries.length) {
          return "<td></td>";
        }
        let firstSlotId = "";
        const slotHtml = entries
          .map(({ item, range }) => {
            const slotId = `${curso}_${day}_CONTRATURNO_${slotIndex}`;
            slotIndex += 1;
            homeState.slotItems.set(slotId, item);
            if (!firstSlotId) {
              firstSlotId = slotId;
            }
            const materia = esc(item.materia || "-");
            const titularInfo = resolveTitularInfo(item);
            const suplenteInfo = resolveSuplenteInfo(item);
            const titularClass = situacionToClass(titularInfo.situacionRevista);
            const suplenteClass = situacionToClass(suplenteInfo.situacionRevista);
            const titular = esc(titularInfo.name);
            const suplenteHtml = suplenteInfo.name
              ? `<span class="meta ${suplenteClass}">Suplente: ${esc(suplenteInfo.name)}</span>`
              : "";
            const cupof = esc(item.cupof || "-");
            const horario = esc(range);
            return `
              <div class="schedule-slot" data-slot-id="${esc(slotId)}">
                <span class="title">${materia}</span>
                <span class="meta docente-main ${titularClass}">${titular}</span>
                ${suplenteHtml}
                <span class="meta horario">Horario: ${horario}</span>
                <span class="meta cupof">CUPOF: ${cupof}</span>
              </div>
            `;
          })
          .join("");
        return `<td data-slot-id="${esc(firstSlotId)}">${slotHtml}</td>`;
      })
      .join("");
    contracturnoRowHtml = `<tr><th>Contraturno</th>${contracturnoCells}</tr>`;
  }

  courseScheduleTitle.textContent = `Horario del curso ${curso}`;
  courseScheduleTable.innerHTML = `
    <div class="schedule-table-wrap">
      <table class="schedule-table">
        <thead>
          <tr>
            <th>Horario</th>
            <th>Lunes</th>
            <th>Martes</th>
            <th>Miercoles</th>
            <th>Jueves</th>
            <th>Viernes</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}${contracturnoRowHtml}</tbody>
      </table>
    </div>
  `;
  courseScheduleWrap.classList.remove("is-hidden");
  setMsg(homeMsg, `Curso ${curso} cargado`);
}

function clearSlotMatches() {
  const slots = courseScheduleTable.querySelectorAll(".schedule-slot");
  slots.forEach((slot) => slot.classList.remove("is-match"));
}

function applySuplenteSearch(term) {
  const query = String(term || "").trim().toLowerCase();
  clearSlotMatches();
  if (!query || query.length < 3) {
    homeCommandResults.textContent = "";
    return;
  }
  let matches = 0;
  const slots = courseScheduleTable.querySelectorAll(".schedule-slot");
  slots.forEach((slot) => {
    const slotId = slot.dataset.slotId || "";
    const item = homeState.slotItems.get(slotId);
    if (!item) {
      return;
    }
    const suplenteInfo = resolveSuplenteInfo(item);
    const name = String(suplenteInfo.name || "").toLowerCase();
    if (name.includes(query)) {
      slot.classList.add("is-match");
      matches += 1;
    }
  });
  homeCommandResults.textContent = matches
    ? `Coincidencias de suplente: ${matches}`
    : "Sin coincidencias para suplente";
}

function renderPidResults(pid, results) {
  if (!results.length) {
    homeCommandResults.textContent = `Sin resultados para PID ${pid}`;
    return;
  }
  const lines = results
    .map((entry) => {
      const docente = entry.docente || "-";
      return `${entry.curso} | CUPOF ${entry.cupof} | ${entry.materia} | ${docente}`;
    })
    .join("\n");
  homeCommandResults.textContent = `PID ${pid} (${results.length})\n${lines}`;
}

function searchByPid(pid) {
  const target = String(pid || "").trim().toUpperCase();
  if (!target) {
    homeCommandResults.textContent = "PID vacio";
    return;
  }
  const results = [];
  homeState.docentesAll.forEach((docente) => {
    if (String(docente?.pid || "").trim().toUpperCase() !== target) {
      return;
    }
    const nombre = `${String(docente?.apellido || "").trim()} ${String(docente?.nombre || "").trim()}`.trim() || "-";
    const refs = extractDocenteRefs(docente);
    if (!refs.length) {
      results.push({
        curso: "Sin curso",
        cupof: "-",
        materia: "-",
        docente: nombre,
      });
      return;
    }
    refs.forEach((ref) => {
      results.push({
        curso: String(ref?.curso || "-").trim() || "-",
        cupof: String(ref?.cupof || "-").trim() || "-",
        materia: String(ref?.materia || ref?.espacioCurricular || "-").trim() || "-",
        docente: `${nombre} (${String(ref?.situacionRevista || "-").trim() || "-"})`,
      });
    });
  });
  renderPidResults(target, results);
}

function renderDocenteEditorForm(data) {
  const fields = [
    ["apellido", "Apellido"],
    ["nombre", "Nombre"],
    ["cuil", "CUIL"],
    ["fechaNacimiento", "Fecha Nacimiento"],
    ["telefono", "Telefono"],
    ["correo", "Correo"],
    ["domicilio", "Domicilio"],
  ];
  const html = fields
    .map(([key, label]) => {
      const value = esc(data?.[key] || "");
      return `
        <label class="docente-field-row">
          <span>${label}</span>
          <div class="docente-field-actions">
            <input type="text" data-docente-key="${key}" value="${value}" />
            <button type="button" class="google-btn field-copy-btn" data-docente-field="${key}">Copiar</button>
            <button type="button" class="google-btn field-paste-btn" data-docente-field="${key}">Pegar</button>
          </div>
        </label>
      `;
    })
    .join("");
  docenteEditorForm.innerHTML = html;
}

function getEditableDocenteFromSlot(item) {
  const titularInfo = resolveTitularInfo(item);
  if (titularInfo?.docente?.id) {
    return titularInfo.docente;
  }
  const suplenteInfo = resolveSuplenteInfo(item);
  if (suplenteInfo?.docente?.id) {
    return suplenteInfo.docente;
  }
  return null;
}

function openDocenteEditorBySlot(slotId) {
  const item = homeState.slotItems.get(slotId);
  if (!item) {
    return;
  }
  const editable = getEditableDocenteFromSlot(item);
  if (!editable || !editable.id) {
    setMsg(homeMsg, "No se encontro un docente editable para este horario", true);
    return;
  }
  homeState.editingDocente = clonePlain(editable);
  renderDocenteEditorForm(homeState.editingDocente.data || {});
  docenteEditorModal.classList.remove("is-hidden");
}

function closeDocenteEditor() {
  homeState.editingDocente = null;
  docenteEditorModal.classList.add("is-hidden");
}

async function saveDocenteEditorChanges() {
  const editing = homeState.editingDocente;
  if (!editing?.id || !homeState.tenantId) {
    closeDocenteEditor();
    return;
  }
  const updates = {};
  const fields = docenteEditorForm.querySelectorAll("[data-docente-key]");
  fields.forEach((input) => {
    const key = input.dataset.docenteKey;
    updates[key] = String(input.value || "").trim();
  });
  await setDoc(doc(db, "tenants", homeState.tenantId, "docentes", editing.id), updates, { merge: true });
  await buildDocentesByCuilMap(homeState.tenantId);
  if (homeState.selectedCourse) {
    await loadScheduleForCourse(homeState.selectedCourse, { preferCache: false, allowFirestore: true });
  }
  closeDocenteEditor();
}

async function loadScheduleForCourse(courseName, options = {}) {
  const { preferCache = true, forceRefresh = false, allowFirestore = false } = options;
  if (!homeState.tenantId) {
    return;
  }
  const course = normalizeCourse(courseName);
  homeState.selectedCourse = course;
  homeSelectedCourse.textContent = `Curso seleccionado: ${course}`;
  updateHomeCourseButtonSelection();
  if (!preferCache) {
    setMsg(homeMsg, `Cargando horario de ${course}...`);
  }
  setLoading(true, `Cargando horario ${course}...`);

  try {
    let usedCache = false;
    let hadCachedItems = false;
    if (preferCache) {
      const cachedItems = await loadCourseScheduleCache(homeState.tenantId, course);
      if (Array.isArray(cachedItems)) {
        hadCachedItems = true;
      }
      if (cachedItems && cachedItems.length) {
        renderScheduleTable(course, cachedItems);
        usedCache = true;
        if (!forceRefresh) {
          return;
        }
      }
    }
    if (usedCache && !forceRefresh) {
      return;
    }
    if (!allowFirestore) {
      if (!hadCachedItems) {
        courseScheduleWrap.classList.add("is-hidden");
        setMsg(homeMsg, `No hay cache local para ${course}. Presiona "Sincronizar".`, true);
      }
      return;
    }
    const itemsSnap = await getDocs(collection(db, "tenants", homeState.tenantId, "cursos", course, "items"));
    const items = itemsSnap.docs.map((docSnap) => docSnap.data() || {});
    renderScheduleTable(course, items);
    await saveCourseScheduleCache(homeState.tenantId, course, items);
  } catch (error) {
    console.error(error);
    setMsg(homeMsg, "No se pudo cargar el horario del curso", true);
  } finally {
    setLoading(false);
  }
}

async function loadTenantCourses(tenantId, options = {}) {
  const { forceRefresh = false, allowFirestore = true } = options;
  setLoading(true, "Cargando cursos...");
  try {
    const hasCache = await loadTenantHomeCache(tenantId);
    await loadButtonConfig(tenantId, { allowFirestore: allowFirestore && !hasCache });
    if (hasCache && !forceRefresh) {
      homeState.tenantId = tenantId;
      const sourceCourses = Array.isArray(homeState.courses) ? homeState.courses : [];
      const resolvedFromCache = sourceCourses
        .map((entry) => ({
          course: normalizeCourse(entry?.course || entry),
          turno: pickRenderableTurn([entry?.turno]),
        }))
        .filter((entry) => entry.course && entry.turno !== "S");
      if (resolvedFromCache.length) {
        renderHomeCourseButtons(resolvedFromCache);
      }
      const firstCourse = (resolvedFromCache.length ? resolvedFromCache : sourceCourses)[0];
      const firstCourseName = normalizeCourse(firstCourse?.course || firstCourse || "");
      if (firstCourseName) {
        await loadScheduleForCourse(firstCourseName, {
          preferCache: true,
          forceRefresh: false,
          allowFirestore: false,
        });
      }
      return;
    }
    if (!allowFirestore && !hasCache) {
      homeState.tenantId = tenantId;
      courseScheduleWrap.classList.add("is-hidden");
      setMsg(homeMsg, 'Sin datos locales. Presiona "Sincronizar" para descargar.', true);
      return;
    }
    await loadButtonConfig(tenantId, { allowFirestore: true });
    const cursosSnap = await getDocs(collection(db, "tenants", tenantId, "cursos"));
    const rawCourses = cursosSnap.docs
      .map((docSnap) => {
        const data = docSnap.data() || {};
        return (
          data.nombre ||
          data.curso ||
          data.codigo ||
          data.id ||
          docSnap.id
        );
      })
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    const unique = Array.from(new Set(rawCourses.map((value) => normalizeCourse(value)))).filter(Boolean);

    const rootTurnByCourse = new Map();
    cursosSnap.docs.forEach((docSnap) => {
      const data = docSnap.data() || {};
      const course = normalizeCourse(
        data.nombre ||
          data.curso ||
          data.codigo ||
          data.id ||
          docSnap.id
      );
      const turn = normalizeRenderableTurn(data.turno);
      if (course && turn) {
        rootTurnByCourse.set(course, turn);
      }
    });

    const homeCourseEntries = await Promise.all(
      unique.map(async (course) => {
        const turn = await resolveCourseButtonTurn(tenantId, course, [rootTurnByCourse.get(course)]);
        return { course, turno: turn };
      })
    );

    const courseButtonsFromDb = await loadCourseButtonsFromFirestore(tenantId);
    renderCourseButtons(unique);
    const buttonsToRender = courseButtonsFromDb.length ? courseButtonsFromDb : homeCourseEntries;
    renderHomeCourseButtons(buttonsToRender);
    homeState.tenantId = tenantId;
    if (unique.length) {
      await buildDocentesByCuilMap(tenantId);
      await saveTenantHomeCache(tenantId, {
        courses: unique,
        courseButtons: buttonsToRender,
        docentesByCuil: Array.from(homeState.docentesByCuil.entries()),
        docentesByCupof: Array.from(homeState.docentesByCupof.entries()),
        docentesAll: homeState.docentesAll,
      });
      await loadScheduleForCourse(unique[0], {
        preferCache: true,
        forceRefresh: false,
        allowFirestore: true,
      });
    } else {
      courseScheduleWrap.classList.add("is-hidden");
    }
  } finally {
    setLoading(false);
  }
}

async function resolveTenantIdForUser(uid, currentTenantId) {
  const directTenantId = String(currentTenantId || "").trim();
  if (directTenantId) {
    return directTenantId;
  }

  const tenantByOwnerQuery = query(
    collection(db, "tenants"),
    where("ownerUid", "==", uid),
    limit(1)
  );
  const tenantByOwnerSnap = await getDocs(tenantByOwnerQuery);
  if (tenantByOwnerSnap.empty) {
    return "";
  }

  const foundTenantId = tenantByOwnerSnap.docs[0].id;
  await setDoc(
    doc(db, "usuarios", uid),
    {
      tenantId: foundTenantId,
      updatedAt: new Date(),
    },
    { merge: true }
  );
  return foundTenantId;
}

async function ensureUserProfileDocument(user) {
  const userRef = doc(db, "usuarios", user.uid);
  const userSnap = await getDoc(userRef);

  if (userSnap.exists()) {
    return userSnap.data();
  }

  let foundTenantId = "";
  const byOwnerUid = await getDocs(
    query(collection(db, "tenants"), where("ownerUid", "==", user.uid), limit(1))
  );
  if (!byOwnerUid.empty) {
    foundTenantId = byOwnerUid.docs[0].id;
  } else if (user.email) {
    const byOwnerEmail = await getDocs(
      query(collection(db, "tenants"), where("ownerEmail", "==", user.email), limit(1))
    );
    if (!byOwnerEmail.empty) {
      foundTenantId = byOwnerEmail.docs[0].id;
    }
  }

  const bootstrapProfile = {
    uid: user.uid,
    nombre: user.displayName || user.email || "Usuario",
    correo: user.email || "",
    tenantId: foundTenantId,
    rol: "admin_escuela",
    updatedAt: new Date(),
    createdAt: new Date(),
  };

  await setDoc(userRef, bootstrapProfile, { merge: true });
  return bootstrapProfile;
}

async function ensureTenantForUser(user, profile) {
  let tenantId = await resolveTenantIdForUser(user.uid, profile.tenantId);
  if (tenantId) {
    return tenantId;
  }

  const tenantRef = doc(collection(db, "tenants"));
  tenantId = tenantRef.id;
  const now = new Date();
  const ownerEmail = String(user.email || profile.correo || "").trim().toLowerCase();
  const ownerName = String(profile.nombre || user.displayName || ownerEmail || "Usuario").trim();

  await setDoc(
    tenantRef,
    {
      tenantId,
      ownerUid: user.uid,
      ownerEmail,
      nombreInstitucion: String(profile.escuela || "Escuela").trim(),
      distrito: String(profile.distrito || "").trim(),
      nivel: String(profile.nivel || "").trim(),
      createdAt: now,
      updatedAt: now,
    },
    { merge: true }
  );

  await setDoc(
    doc(db, "usuarios", user.uid),
    {
      uid: user.uid,
      nombre: ownerName,
      correo: ownerEmail,
      tenantId,
      rol: String(profile.rol || "admin_escuela"),
      updatedAt: now,
      createdAt: profile.createdAt || now,
    },
    { merge: true }
  );

  return tenantId;
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;

  try {
    await signInWithEmailAndPassword(auth, email, password);
    setMsg(loginMsg, "Login correcto");
    loginForm.reset();
  } catch (error) {
    console.error(error);
    setMsg(loginMsg, "Credenciales invalidas", true);
  }
});

googleLoginBtn.addEventListener("click", async () => {
  try {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
    setMsg(loginMsg, "Login con Google correcto");
  } catch (error) {
    console.error(error);
    setMsg(loginMsg, "No se pudo iniciar con Google", true);
  }
});

sheetImportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearCursosReviewOnly();
  toggleBulkSaveButton();
  setLoading(true, "Cargando docentes...");

  if (!importState.tenantId) {
    setMsg(panelMsg, "No se encontro tenantId para este usuario", true);
    setLoading(false);
    return;
  }

  const sheetUrl = sheetUrlInput.value.trim();
  const sheetName = sheetNameInput.value.trim();
  const byGid = hasSheetGid(sheetUrl);

  if (!sheetUrl || (!sheetName && !byGid)) {
    setMsg(panelMsg, "Completa URL y nombre de hoja (o usa una URL con gid)", true);
    setLoading(false);
    return;
  }
  try {
    setMsg(panelMsg, "Extrayendo docentes de toda la hoja desde Google Sheets...");
    const loadDocentesFromSheet = httpsCallable(functions, "loadDocentesFromSheet");
    const result = await loadDocentesFromSheet({
      sheetUrl,
      sheetName,
    });
    const docentes = result.data?.docentes || [];
    const detectedCourses = result.data?.detectedCourses || [];
    const resolvedCourses = sanitizeCourseList([
      ...collectCoursesFromDocentes(docentes),
      ...detectedCourses,
    ]);
    if (resolvedCourses.length) {
      renderCourseButtons(resolvedCourses);
      courseButtonsMsg.textContent = `Cursos detectados en hoja: ${resolvedCourses.join(", ")}`;
    }

    if (!docentes.length) {
      const debug = result.data?.debug || {};
      const details = [
        "No se encontraron docentes en la hoja actual.",
        resolvedCourses.length ? `Cursos detectados en hoja: ${resolvedCourses.join(", ")}` : "",
        debug.hasHeaders === false ? "No se detectaron encabezados validos en las primeras filas de la hoja." : "",
      ]
        .filter(Boolean)
        .join(" ");
      setMsg(panelMsg, details || "No se encontraron docentes en la hoja indicada", true);
      importState.docentes = [];
      importState.index = 0;
      importState.accepted = 0;
      importState.skipped = 0;
      importState.cancelled = false;
      importReview.classList.add("is-hidden");
      toggleBulkSaveButton();
      return;
    }

    importState.sheetUrl = sheetUrl;
    importState.sheetName = sheetName;
    importState.docentes = docentes;
    importState.index = 0;
    importState.accepted = 0;
    importState.skipped = 0;
    importState.cancelled = false;

    setMsg(panelMsg, `Se cargaron ${docentes.length} docentes para revisar.`);
    renderCurrentDocente();
  } catch (error) {
    console.error(error);
    setMsg(panelMsg, error.message || "No se pudo leer la hoja", true);
    resetImportState();
  } finally {
    setLoading(false);
  }
});

loadCursosBtn.addEventListener("click", async () => {
  clearDocentesReviewOnly();
  toggleBulkSaveButton();
  setLoading(true, "Cargando cursos...");
  if (!importState.tenantId) {
    setMsg(panelMsg, "No se encontro tenantId para este usuario", true);
    setLoading(false);
    return;
  }

  const sheetUrl = sheetUrlInput.value.trim();
  const sheetName = sheetNameInput.value.trim();
  const byGid = hasSheetGid(sheetUrl);
  if (!sheetUrl || (!sheetName && !byGid)) {
    setMsg(panelMsg, "Completa URL y nombre de hoja (o usa una URL con gid)", true);
    setLoading(false);
    return;
  }
  try {
    setMsg(panelMsg, "Extrayendo cursos de toda la hoja desde Google Sheets...");
    const loadCursosFromSheet = httpsCallable(functions, "loadCursosFromSheet");
    const result = await loadCursosFromSheet({
      sheetUrl,
      sheetName,
    });
    const cursos = result.data?.cursos || [];
    const detectedCourses = result.data?.detectedCourses || [];
    const resolvedCourses = sanitizeCourseList([
      ...collectCoursesFromCursos(cursos),
      ...detectedCourses,
    ]);
    if (resolvedCourses.length) {
      renderCourseButtons(resolvedCourses);
      courseButtonsMsg.textContent = `Cursos detectados en hoja: ${resolvedCourses.join(", ")}`;
    }

    if (!cursos.length) {
      const details = [
        "No se encontraron cursos en la hoja actual.",
        resolvedCourses.length ? `Cursos detectados: ${resolvedCourses.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      setMsg(panelMsg, details || "No se encontraron cursos en la hoja indicada", true);
      importReviewCursos.classList.add("is-hidden");
      toggleBulkSaveButton();
      return;
    }

    importCursosState.tenantId = importState.tenantId;
    importCursosState.sheetUrl = sheetUrl;
    importCursosState.sheetName = sheetName;
    importCursosState.cursos = cursos;
    importCursosState.index = 0;
    importCursosState.accepted = 0;
    importCursosState.skipped = 0;
    importCursosState.cancelled = false;
    importCursosState.selectedCourse = importState.selectedCourse;

    setMsg(panelMsg, `Se cargaron ${cursos.length} cursos para revisar.`);
    renderCurrentCurso();
  } catch (error) {
    console.error(error);
    setMsg(panelMsg, error.message || "No se pudo leer cursos desde la hoja", true);
    importReviewCursos.classList.add("is-hidden");
    toggleBulkSaveButton();
  } finally {
    setLoading(false);
  }
});

saveAllBtn.addEventListener("click", async () => {
  if (importState.docentes[importState.index]) {
    importState.docentes[importState.index] = readEditedDocenteFromCard();
  }
  if (importCursosState.cursos[importCursosState.index]) {
    importCursosState.cursos[importCursosState.index] = readEditedCursoFromCard();
  }

  const pendingCursos = importCursosState.cursos.slice(importCursosState.index);
  const pendingDocentes = importState.docentes.slice(importState.index);
  const totalDocentesToSave = pendingDocentes.length;

  if (!pendingCursos.length && !pendingDocentes.length) {
    setMsg(panelMsg, "No hay datos pendientes para guardar", true);
    return;
  }

  setMsg(panelMsg, "Iniciando guardado masivo...");
  setLoading(true, "Guardando todo...");
  const saveImportedCurso = httpsCallable(functions, "saveImportedCurso");
  const saveImportedDocente = httpsCallable(functions, "saveImportedDocente");
  try {
    for (let i = 0; i < pendingCursos.length; i += 1) {
      const curso = pendingCursos[i];
      try {
        await saveImportedCurso({
          curso,
          sheetUrl: importCursosState.sheetUrl,
          sheetName: importCursosState.sheetName,
          course: importCursosState.selectedCourse,
        });
        await upsertCourseButton(importState.tenantId, curso.curso, curso.turno);
        importCursosState.accepted += 1;
        importCursosState.index += 1;
        appendPanelLog(`Se guardo ${curso.curso} (CUPOF ${curso.cupof})`);
      } catch (error) {
        console.error(error);
        appendPanelLog(
          `Error al guardar curso ${curso.curso} (CUPOF ${curso.cupof}): ${error.message || "sin detalle"}`,
          true
        );
      }
    }

    for (let i = 0; i < pendingDocentes.length; i += 1) {
      const docente = pendingDocentes[i];
      const docenteIndex = i + 1;
      const docenteName = `${docente.apellido || ""} ${docente.nombre || ""}`.trim() || docente.cuil || "sin nombre";
      try {
        await saveImportedDocente({
          docente,
          sheetUrl: importState.sheetUrl,
          sheetName: importState.sheetName,
          course: importState.selectedCourse,
        });
        importState.accepted += 1;
        importState.index += 1;
        appendPanelLog(`[${docenteIndex}/${totalDocentesToSave}] Se guardo el docente ${docenteName}`);
      } catch (error) {
        console.error(error);
        appendPanelLog(
          `[${docenteIndex}/${totalDocentesToSave}] Error al guardar docente ${docenteName}: ${error.message || "sin detalle"}`,
          true
        );
      }
    }

    if (importState.tenantId) {
      const refreshedButtons = await loadCourseButtonsFromFirestore(importState.tenantId);
      if (refreshedButtons.length) {
        renderHomeCourseButtons(refreshedButtons);
      }
    }

    appendPanelLog(
      `Guardado masivo finalizado. Cursos guardados: ${importCursosState.accepted}. Docentes guardados: ${importState.accepted}.`
    );
    renderCurrentCurso();
    renderCurrentDocente();
    toggleBulkSaveButton();
  } finally {
    setLoading(false);
  }
});

acceptDocenteBtn.addEventListener("click", async () => {
  const docente = importState.docentes[importState.index];
  if (!docente) {
    return;
  }

  try {
    const editedDocente = readEditedDocenteFromCard();
    importState.docentes[importState.index] = editedDocente;
    const saveImportedDocente = httpsCallable(functions, "saveImportedDocente");
    await saveImportedDocente({
      docente: editedDocente,
      sheetUrl: importState.sheetUrl,
      sheetName: importState.sheetName,
      course: importState.selectedCourse,
    });
    importState.accepted += 1;
    importState.index += 1;
    renderCurrentDocente();
  } catch (error) {
    console.error(error);
    setMsg(panelMsg, error.message || "No se pudo guardar el docente", true);
  }
});

skipDocenteBtn.addEventListener("click", () => {
  if (!importState.docentes[importState.index]) {
    return;
  }
  importState.skipped += 1;
  importState.index += 1;
  renderCurrentDocente();
});

cancelDocenteBtn.addEventListener("click", () => {
  importState.cancelled = true;
  importReview.classList.add("is-hidden");
  toggleBulkSaveButton();
  setMsg(
    panelMsg,
    `Importacion cancelada. Guardados: ${importState.accepted}. Omitidos: ${importState.skipped}.`
  );
});

acceptCursoBtn.addEventListener("click", async () => {
  const curso = importCursosState.cursos[importCursosState.index];
  if (!curso) {
    return;
  }

  try {
    const editedCurso = readEditedCursoFromCard();
    importCursosState.cursos[importCursosState.index] = editedCurso;
    const saveImportedCurso = httpsCallable(functions, "saveImportedCurso");
    await saveImportedCurso({
      curso: editedCurso,
      sheetUrl: importCursosState.sheetUrl,
      sheetName: importCursosState.sheetName,
      course: importCursosState.selectedCourse,
    });
    await upsertCourseButton(importState.tenantId, editedCurso.curso, editedCurso.turno);
    if (importState.tenantId) {
      const refreshedButtons = await loadCourseButtonsFromFirestore(importState.tenantId);
      if (refreshedButtons.length) {
        renderHomeCourseButtons(refreshedButtons);
      }
    }
    importCursosState.accepted += 1;
    importCursosState.index += 1;
    renderCurrentCurso();
  } catch (error) {
    console.error(error);
    setMsg(panelMsg, error.message || "No se pudo guardar el curso", true);
  }
});

skipCursoBtn.addEventListener("click", () => {
  if (!importCursosState.cursos[importCursosState.index]) {
    return;
  }
  importCursosState.skipped += 1;
  importCursosState.index += 1;
  renderCurrentCurso();
});

cancelCursoBtn.addEventListener("click", () => {
  importCursosState.cancelled = true;
  importReviewCursos.classList.add("is-hidden");
  toggleBulkSaveButton();
  setMsg(
    panelMsg,
    `Importacion de cursos cancelada. Guardados: ${importCursosState.accepted}. Omitidos: ${importCursosState.skipped}.`
  );
});

refreshFab.addEventListener("click", async () => {
  if (refreshInProgress || !importState.tenantId) {
    return;
  }
  setRefreshFabLoading(true);
  setLoading(true, "Actualizando datos...");
  try {
    await loadTenantCourses(importState.tenantId, { forceRefresh: true, allowFirestore: true });
    if (homeState.selectedCourse) {
      await loadScheduleForCourse(homeState.selectedCourse, {
        preferCache: true,
        forceRefresh: true,
        allowFirestore: true,
      });
    }
    setMsg(homeMsg, "Datos actualizados");
  } catch (error) {
    console.error(error);
    setMsg(homeMsg, "No se pudo actualizar", true);
  } finally {
    setRefreshFabLoading(false);
    setLoading(false);
  }
});

saveButtonConfigBtn.addEventListener("click", async () => {
  if (!importState.tenantId) {
    setMsg(buttonConfigMsg, "No hay tenantId activo para guardar configuracion", true);
    return;
  }

  try {
    const turnos = readButtonConfigFromEditor();
    buttonConfigState = normalizeButtonConfig(turnos);
    const configRef = doc(db, "tenants", importState.tenantId, "botones", "config");
    await setDoc(
      configRef,
      {
        tenantId: importState.tenantId,
        turnos: buttonConfigState,
        updatedAt: new Date(),
      },
      { merge: true }
    );
    renderButtonConfigEditor();
    renderHomeCourseButtons(homeState.courses);
    updateHomeCourseButtonSelection();
    setMsg(buttonConfigMsg, "Configuracion de botones guardada.");
  } catch (error) {
    console.error(error);
    setMsg(buttonConfigMsg, "No se pudo guardar la configuracion de botones", true);
  }
});

reloadButtonConfigBtn.addEventListener("click", async () => {
  if (!importState.tenantId) {
    setMsg(buttonConfigMsg, "No hay tenantId activo para recargar configuracion", true);
    return;
  }
  await loadButtonConfig(importState.tenantId);
  renderHomeCourseButtons(homeState.courses);
  updateHomeCourseButtonSelection();
});

homeTabBtn.addEventListener("click", () => {
  setPanelView("home");
});

settingsTabBtn.addEventListener("click", () => {
  setPanelView("settings");
});

homeSearchInput.addEventListener("input", () => {
  const value = String(homeSearchInput.value || "");
  if (value.trim().length >= 3) {
    applySuplenteSearch(value);
    return;
  }
  clearSlotMatches();
  homeCommandResults.textContent = "";
});

homeSearchClearBtn.addEventListener("click", () => {
  homeSearchInput.value = "";
  clearSlotMatches();
  homeCommandResults.textContent = "";
});

homeSearchBtn.addEventListener("click", () => {
  setButtonBusy(homeSearchBtn, true);
  try {
    applySuplenteSearch(homeSearchInput.value);
  } finally {
    setTimeout(() => setButtonBusy(homeSearchBtn, false), 220);
  }
});

homeSearchPidBtn.addEventListener("click", () => {
  setButtonBusy(homeSearchPidBtn, true);
  const value = window.prompt("Ingresa el PID a consultar", "");
  if (value === null) {
    setButtonBusy(homeSearchPidBtn, false);
    return;
  }
  try {
    searchByPid(value);
  } finally {
    setTimeout(() => setButtonBusy(homeSearchPidBtn, false), 220);
  }
});

homeSearchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    applySuplenteSearch(homeSearchInput.value);
  }
});

courseScheduleTable.addEventListener("click", (event) => {
  const slot = event.target.closest(".schedule-slot");
  const cell = event.target.closest("td");
  const slotId = String(slot?.dataset.slotId || cell?.dataset.slotId || "").trim();
  if (!slotId) {
    return;
  }
  openDocenteEditorBySlot(slotId);
});

docenteCancelBtn.addEventListener("click", () => {
  closeDocenteEditor();
});

docenteEditorModal.addEventListener("click", (event) => {
  if (event.target === docenteEditorModal) {
    closeDocenteEditor();
  }
});

docenteEditorForm.addEventListener("click", async (event) => {
  const copyBtn = event.target.closest(".field-copy-btn");
  if (copyBtn) {
    const key = copyBtn.dataset.docenteField;
    const input = docenteEditorForm.querySelector(`[data-docente-key="${key}"]`);
    if (!input) {
      return;
    }
    try {
      await navigator.clipboard.writeText(String(input.value || ""));
      setMsg(homeMsg, `Campo ${key} copiado`);
    } catch (error) {
      console.error(error);
      setMsg(homeMsg, `No se pudo copiar ${key}`, true);
    }
    return;
  }

  const pasteBtn = event.target.closest(".field-paste-btn");
  if (pasteBtn) {
    const key = pasteBtn.dataset.docenteField;
    const input = docenteEditorForm.querySelector(`[data-docente-key="${key}"]`);
    if (!input) {
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      input.value = String(text || "");
    } catch (error) {
      console.error(error);
      setMsg(homeMsg, `No se pudo pegar ${key}`, true);
    }
  }
});

docenteCopyBtn.addEventListener("click", async () => {
  const editing = homeState.editingDocente;
  if (!editing) {
    return;
  }
  const payload = {};
  const fields = docenteEditorForm.querySelectorAll("[data-docente-key]");
  fields.forEach((input) => {
    payload[input.dataset.docenteKey] = String(input.value || "").trim();
  });
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setMsg(homeMsg, "Datos copiados al portapapeles");
  } catch (error) {
    console.error(error);
    setMsg(homeMsg, "No se pudo copiar", true);
  }
});

docenteSaveBtn.addEventListener("click", async () => {
  try {
    await saveDocenteEditorChanges();
    setMsg(homeMsg, "Docente actualizado");
  } catch (error) {
    console.error(error);
    setMsg(homeMsg, "No se pudo guardar cambios del docente", true);
  }
});

window.addEventListener("resize", () => {
  syncBannerLayout();
});

window.addEventListener("scroll", () => {
  handleBannerAutoHideScroll();
});

logoutBtn.addEventListener("click", async () => {
  try {
    await signOut(auth);
    currentSessionLogKey = "";
    setMsg(loginMsg, "Sesion cerrada");
    setMsg(panelMsg, "");
    resetImportState();
  } catch (error) {
    console.error(error);
    setMsg(loginMsg, "No se pudo cerrar sesion", true);
  }
});

onAuthStateChanged(auth, (user) => {
  if (!user) {
    currentSessionLogKey = "";
    updateSessionLayout(false);
    setPanelView("home");
    userName.textContent = "Sin sesion";
    userEmail.textContent = "-";
    tenantEmptyImport.classList.add("is-hidden");
    resetImportState();
    return;
  }
  updateSessionLayout(true);
  setPanelView("home");
  userName.textContent = user.displayName || user.email || "Usuario";
  userEmail.textContent = user.email || "-";

  ensureUserProfileDocument(user)
    .then((profile) => {
      userName.textContent = profile.nombre || userName.textContent;
      userEmail.textContent = profile.correo || userEmail.textContent;
      ensureTenantForUser(user, profile)
        .then((tenantId) => {
          importState.tenantId = tenantId;
          if (!importState.tenantId) {
            setMsg(panelMsg, "Tu usuario no tiene tenantId asignado", true);
            tenantEmptyImport.classList.add("is-hidden");
            return;
          }
          registerCurrentSession(user, importState.tenantId, profile);
          return Promise.all([
            checkTenantDataAndToggleImport(importState.tenantId),
            loadTenantCourses(importState.tenantId),
          ]);
        })
        .catch((error) => {
          console.error(error);
          setMsg(panelMsg, "No se pudo cargar datos del tenant", true);
        });
    })
    .catch((error) => {
      console.error("No se pudo leer perfil en Firestore", error);
    });
});

renderButtonConfigEditor();
syncBannerLayout();
