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
const tenantEmptyImport = document.getElementById("tenant-empty-import");
const sheetImportForm = document.getElementById("sheet-import-form");
const sheetUrlInput = document.getElementById("sheet-url");
const sheetNameInput = document.getElementById("sheet-name");
const courseButtonsMsg = document.getElementById("course-buttons-msg");
const courseButtons = document.getElementById("course-buttons");
const selectedCourseLabel = document.getElementById("selected-course");
const importReview = document.getElementById("import-review");
const reviewProgress = document.getElementById("review-progress");
const reviewDocente = document.getElementById("review-docente");
const acceptDocenteBtn = document.getElementById("accept-docente-btn");
const skipDocenteBtn = document.getElementById("skip-docente-btn");
const cancelDocenteBtn = document.getElementById("cancel-docente-btn");

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

function setMsg(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.classList.toggle("success", !isError);
}

function updateSessionLayout(isLoggedIn) {
  loginSection.classList.toggle("is-hidden", isLoggedIn);
  logoutBtn.classList.toggle("is-hidden", !isLoggedIn);
  panelSection.classList.toggle("is-hidden", !isLoggedIn);
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
  reviewProgress.textContent = "";
  reviewDocente.textContent = "";
  courseButtonsMsg.textContent = "";
  courseButtons.innerHTML = "";
  selectedCourseLabel.textContent = "Curso seleccionado: -";
}

function renderCurrentDocente() {
  const total = importState.docentes.length;
  if (!total || importState.cancelled) {
    importReview.classList.add("is-hidden");
    return;
  }

  if (importState.index >= total) {
    importReview.classList.add("is-hidden");
    setMsg(
      panelMsg,
      `Importacion finalizada. Guardados: ${importState.accepted}. Omitidos: ${importState.skipped}.`
    );
    return;
  }

  const docente = importState.docentes[importState.index];
  importReview.classList.remove("is-hidden");
  reviewProgress.textContent = `Docente ${importState.index + 1} de ${total}`;
  reviewDocente.textContent = JSON.stringify(docente, null, 2);
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

async function loadTenantCourses(tenantId) {
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

  renderCourseButtons(Array.from(new Set(courses)));
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

  if (!importState.tenantId) {
    setMsg(panelMsg, "No se encontro tenantId para este usuario", true);
    return;
  }

  const sheetUrl = sheetUrlInput.value.trim();
  const sheetName = sheetNameInput.value.trim();

  if (!sheetUrl || !sheetName) {
    setMsg(panelMsg, "Completa URL y nombre de hoja", true);
    return;
  }
  if (!importState.selectedCourse) {
    setMsg(panelMsg, "Selecciona un curso para iniciar la carga", true);
    return;
  }

  try {
    setMsg(panelMsg, `Extrayendo docentes del curso ${importState.selectedCourse} desde Google Sheets...`);
    const loadDocentesFromSheet = httpsCallable(functions, "loadDocentesFromSheet");
    const result = await loadDocentesFromSheet({
      sheetUrl,
      sheetName,
      course: importState.selectedCourse,
    });
    const docentes = result.data?.docentes || [];

    if (!docentes.length) {
      const detectedCourses = result.data?.detectedCourses || [];
      const debug = result.data?.debug || {};
      const details = [
        `No se encontraron docentes para el curso ${importState.selectedCourse}.`,
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
  }
});

acceptDocenteBtn.addEventListener("click", async () => {
  const docente = importState.docentes[importState.index];
  if (!docente) {
    return;
  }

  try {
    const saveImportedDocente = httpsCallable(functions, "saveImportedDocente");
    await saveImportedDocente({
      docente,
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
  setMsg(
    panelMsg,
    `Importacion cancelada. Guardados: ${importState.accepted}. Omitidos: ${importState.skipped}.`
  );
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
    userName.textContent = "Sin sesion";
    userEmail.textContent = "-";
    tenantEmptyImport.classList.add("is-hidden");
    resetImportState();
    return;
  }
  updateSessionLayout(true);
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
