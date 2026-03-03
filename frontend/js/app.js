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
const loadingIndicator = document.getElementById("loading-indicator");
const loadingText = document.getElementById("loading-text");
const tenantEmptyImport = document.getElementById("tenant-empty-import");
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
};

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
}

function syncBannerLayout() {
  if (!topBanner || !subBanner || !appRoot) {
    return;
  }
  const topHeight = topBanner.getBoundingClientRect().height || 72;
  subBanner.style.top = `${Math.ceil(topHeight)}px`;
  const subVisible = !subBanner.classList.contains("is-hidden");
  const subHeight = subVisible ? (subBanner.getBoundingClientRect().height || 48) : 0;
  appRoot.style.marginTop = `${Math.ceil(topHeight + subHeight + 16)}px`;
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

function parseStartMinutes(rangeText) {
  const text = String(rangeText || "").trim();
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
  const refs = Array.isArray(docente?.cursoRefs) ? docente.cursoRefs : [];
  const refsHtml = refs.length
    ? refs
      .map((item) => {
        const cupof = esc(item?.cupof || "-");
        const curso = esc(item?.curso || "-");
        const materia = esc(item?.materia || "-");
        const situacion = esc(item?.situacionRevista || "-");
        return `
          <div class="card-chip">
            <strong>CUPOF ${cupof}</strong>
            <span>Curso: ${curso}</span>
            <span>Materia: ${materia}</span>
            <span>Revista: ${situacion}</span>
          </div>
        `;
      })
      .join("")
    : '<p class="msg">Sin cursoRefs detectados</p>';

  renderEditableCard(reviewDocente, docente);
  reviewDocente.insertAdjacentHTML(
    "afterbegin",
    `
      <div class="full">
        <p class="mini-title">Asignaciones detectadas</p>
        <div class="card-chip-list">${refsHtml}</div>
      </div>
    `
  );
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
  };
  homeCourseButtons.innerHTML = "";
  homeSelectedCourse.textContent = "Curso seleccionado: -";
  courseScheduleWrap.classList.add("is-hidden");
  courseScheduleTable.innerHTML = "";
  setMsg(homeMsg, "");
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

  const docente = importState.docentes[importState.index];
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
  const docentesRef = collection(db, "tenants", tenantId, "docentes");
  const firstDoc = await getDocs(query(docentesRef, limit(1)));
  const hasDocentes = !firstDoc.empty;
  tenantEmptyImport.classList.remove("is-hidden");
  setMsg(
    panelMsg,
    hasDocentes
      ? "Tu tenant ya tiene docentes cargados. Puedes cargar mas por curso."
      : "No hay docentes cargados en este tenant. Inicia con el curso 1A."
  );
}

function normalizeCourse(value) {
  return String(value || "").trim().toUpperCase();
}

function setSelectedCourse(courseName) {
  importState.selectedCourse = courseName;
  selectedCourseLabel.textContent = `Curso seleccionado: ${courseName || "-"}`;
}

function renderCourseButtons(courses) {
  courseButtons.innerHTML = "";
  if (!courses.length) {
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

  importState.courses = courses;
  courseButtonsMsg.textContent = `Cursos detectados: ${courses.join(", ")}`;

  courses.forEach((courseName) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `Cargar ${courseName}`;
    button.addEventListener("click", () => setSelectedCourse(courseName));
    courseButtons.appendChild(button);
  });

  const preferred = courses.find((course) => normalizeCourse(course) === "1A") || courses[0];
  setSelectedCourse(preferred);
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

  courses.forEach((courseName) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = courseName;
    button.addEventListener("click", () => loadScheduleForCourse(courseName));
    homeCourseButtons.appendChild(button);
  });
}

async function buildDocentesByCuilMap(tenantId) {
  const docentesSnap = await getDocs(collection(db, "tenants", tenantId, "docentes"));
  const map = new Map();
  docentesSnap.docs.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const cuil = String(data.cuil || "").trim();
    if (!cuil || cuil === "sin datos") {
      return;
    }
    const apellido = String(data.apellido || "").trim();
    const nombre = String(data.nombre || "").trim();
    const fullName = `${apellido} ${nombre}`.trim() || cuil;
    map.set(cuil, fullName);
  });
  homeState.docentesByCuil = map;
}

function renderScheduleTable(curso, items) {
  const days = ["LUNES", "MARTES", "MIERCOLES", "JUEVES", "VIERNES"];
  const slots = new Map();
  const allRanges = new Set();

  items.forEach((item) => {
    const dias = Array.isArray(item?.diaHorario?.dias) ? item.diaHorario.dias : [];
    dias.forEach((diaItem) => {
      const day = normalizeDayColumn(diaItem?.dia);
      const range = String(diaItem?.horario || "").trim();
      if (!day || !range) {
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

  if (!ranges.length) {
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
          const slotHtml = dayItems
            .map((item) => {
              const materia = esc(item.materia || "-");
              const titular = esc(docenteDisplayNameByCuil(item.docenteCuil));
              const suplente = esc(docenteDisplayNameByCuil(item.suplenteCuil));
              return `
                <div class="schedule-slot">
                  <span class="title">${materia}</span>
                  <span class="meta">Titular: ${titular}</span>
                  <span class="meta">Suplente: ${suplente}</span>
                </div>
              `;
            })
            .join("");
          return `<td>${slotHtml}</td>`;
        })
        .join("");

      return `<tr><th>${esc(range)}</th>${dayCells}</tr>`;
    })
    .join("");

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
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
  courseScheduleWrap.classList.remove("is-hidden");
  setMsg(homeMsg, `Curso ${curso} cargado`);
}

async function loadScheduleForCourse(courseName) {
  if (!homeState.tenantId) {
    return;
  }
  const course = normalizeCourse(courseName);
  homeState.selectedCourse = course;
  homeSelectedCourse.textContent = `Curso seleccionado: ${course}`;
  setMsg(homeMsg, `Cargando horario de ${course}...`);
  setLoading(true, `Cargando horario ${course}...`);

  try {
    const itemsSnap = await getDocs(collection(db, "tenants", homeState.tenantId, "cursos", course, "items"));
    const items = itemsSnap.docs.map((docSnap) => docSnap.data() || {});
    renderScheduleTable(course, items);
  } catch (error) {
    console.error(error);
    setMsg(homeMsg, "No se pudo cargar el horario del curso", true);
  } finally {
    setLoading(false);
  }
}

async function loadTenantCourses(tenantId) {
  setLoading(true, "Cargando cursos...");
  try {
    const cursosSnap = await getDocs(collection(db, "tenants", tenantId, "cursos"));
    const courses = cursosSnap.docs
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
    const unique = Array.from(new Set(courses.map((value) => normalizeCourse(value)))).filter(Boolean);
    renderCourseButtons(unique);
    renderHomeCourseButtons(unique);
    homeState.tenantId = tenantId;
    if (unique.length) {
      await buildDocentesByCuilMap(tenantId);
      await loadScheduleForCourse(unique[0]);
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

  if (!sheetUrl || !sheetName) {
    setMsg(panelMsg, "Completa URL y nombre de hoja", true);
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
    if (detectedCourses.length) {
      renderCourseButtons(detectedCourses);
      courseButtonsMsg.textContent = `Cursos detectados en hoja: ${detectedCourses.join(", ")}`;
    }

    if (!docentes.length) {
      const debug = result.data?.debug || {};
      const details = [
        "No se encontraron docentes en la hoja actual.",
        detectedCourses.length ? `Cursos detectados en hoja: ${detectedCourses.join(", ")}` : "",
        debug.hasHeaders === false ? "No se detectaron encabezados validos en la primera fila." : "",
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
  if (!sheetUrl || !sheetName) {
    setMsg(panelMsg, "Completa URL y nombre de hoja", true);
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
    if (detectedCourses.length) {
      renderCourseButtons(detectedCourses);
      courseButtonsMsg.textContent = `Cursos detectados en hoja: ${detectedCourses.join(", ")}`;
    }

    if (!cursos.length) {
      const details = [
        "No se encontraron cursos en la hoja actual.",
        detectedCourses.length ? `Cursos detectados: ${detectedCourses.join(", ")}` : "",
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
        appendPanelLog(`Se guardo el docente ${docenteName}`);
      } catch (error) {
        console.error(error);
        appendPanelLog(
          `Error al guardar docente ${docenteName}: ${error.message || "sin detalle"}`,
          true
        );
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

homeTabBtn.addEventListener("click", () => {
  setPanelView("home");
});

settingsTabBtn.addEventListener("click", () => {
  setPanelView("settings");
});

window.addEventListener("resize", () => {
  syncBannerLayout();
});

logoutBtn.addEventListener("click", async () => {
  try {
    await signOut(auth);
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

syncBannerLayout();
