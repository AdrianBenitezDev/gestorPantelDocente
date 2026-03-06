const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const allowedCorsOrigins = ["https://horario-escuelas.web.app"];
const callableOptions = { cors: allowedCorsOrigins, invoker: "public" };

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeCourse(value) {
  return String(value || "").trim().toUpperCase();
}

function buildTenantId() {
  return `tenant_${db.collection("tenants").doc().id}`;
}

function assertString(value, field, min = 1, max = 120) {
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", `Invalid field: ${field}`);
  }
  const v = value.trim();
  if (v.length < min || v.length > max) {
    throw new HttpsError("invalid-argument", `Invalid length for: ${field}`);
  }
  return v;
}

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < csv.length; i += 1) {
    const ch = csv[i];
    const next = csv[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }

    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && next === "\n") {
        i += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += ch;
  }

  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function pickField(data, keys) {
  for (const key of keys) {
    if (typeof data[key] === "string" && data[key].trim()) {
      return data[key].trim();
    }
  }
  return "";
}

function pickFieldContaining(data, fragments) {
  const keys = Object.keys(data || {});
  for (const key of keys) {
    if (!fragments.some((fragment) => key.includes(fragment))) {
      continue;
    }
    const value = String(data[key] || "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function pickTitularCuil(data, values = []) {
  const direct = pickField(data, [
    "cuil",
    "cuiltitular",
    "cuiltitular",
    "cuildocente",
    "dni",
    "documento",
  ]);
  const directDigits = String(direct || "").replace(/\D/g, "");
  if (directDigits.length >= 11) {
    return direct;
  }
  const prefix = String(values[10] || "").trim();
  const body = String(values[11] || "").trim();
  const suffix = String(values[12] || "").trim();
  const prefixDigits = prefix.replace(/\D/g, "");
  const bodyDigits = body.replace(/\D/g, "");
  const suffixDigits = suffix.replace(/\D/g, "");
  if (
    prefixDigits.length === 2 &&
    bodyDigits.length >= 7 &&
    bodyDigits.length <= 8 &&
    suffixDigits.length === 1
  ) {
    return `${prefixDigits}${bodyDigits}${suffixDigits}`;
  }
  if (direct) {
    return direct;
  }
  const keys = Object.keys(data || {});
  for (const key of keys) {
    const normalizedKey = String(key || "");
    if (!normalizedKey.includes("cuil")) {
      continue;
    }
    if (normalizedKey.includes("suplente")) {
      continue;
    }
    if (normalizedKey.includes("correo")) {
      continue;
    }
    const value = String(data[normalizedKey] || "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function splitCursos(value) {
  return String(value || "")
    .split(/[;,|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasHeaderRow(firstRow = []) {
  const normalized = firstRow.map((cell) => normalizeHeader(cell));
  const knownHeaders = [
    "curso",
    "ano",
    "anio",
    "seccion",
    "orientacion",
    "lunes",
    "martes",
    "miercoles",
    "jueves",
    "viernes",
    "espaciocurricular",
    "cupof",
    "situacionderevista",
    "apellidoynombre",
    "suplente",
    "cuilsuplente",
    "suplente2",
    "cuilsuplente2",
    "turno",
    "telefono",
    "correoabctitular",
    "domiciliotitular",
    "apellido",
    "apellidos",
    "nombre",
    "nombres",
    "apellidoynombre",
    "cuil",
    "dni",
    "documento",
    "pid",
    "legajo",
    "id",
    "curso",
    "cursos",
  ];
  return normalized.some((item) => knownHeaders.includes(item));
}

function findHeaderRowIndex(rows = []) {
  const maxScan = Math.min(rows.length, 400);
  for (let idx = 0; idx < maxScan; idx += 1) {
    if (hasHeaderRow(rows[idx])) {
      return idx;
    }
  }
  return -1;
}

function pickCourseValue(rowObj, values) {
  const explicit = pickField(rowObj, ["curso", "cursos", "division"]);
  if (explicit) {
    return normalizeCourse(explicit);
  }
  const normalizeCourseToken = (value) =>
    String(value || "")
      .trim()
      .toUpperCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Z0-9]+/g, "");
  const yearRaw =
    pickField(rowObj, ["anio", "ano", "grado"]) ||
    String(values[1] || "").trim();
  const sectionRaw =
    pickField(rowObj, ["seccion"]) ||
    String(values[2] || "").trim();
  const year = normalizeCourseToken(yearRaw);
  const section = normalizeCourseToken(sectionRaw);
  const fromYearSection = year && section ? `${year}${section}` : year;
  if (fromYearSection) {
    return normalizeCourse(fromYearSection);
  }
  const fallback = normalizeCourse(values[0] || "");
  // Evita tomar columnas de sede/ambito como curso.
  if (!fallback || fallback === "SEDE" || fallback === "AN" || fallback === "EX") {
    return "";
  }
  return fallback;
}

function parseNombreApellido(rowObj, values) {
  const apellido = pickField(rowObj, ["apellido", "apellidos"]) || String(values[1] || "").trim();
  const nombre = pickField(rowObj, ["nombre", "nombres"]) || String(values[2] || "").trim();
  const fullName = pickField(rowObj, ["apellidoynombre", "nombreatellido", "docente"]);

  if ((apellido || nombre) || !fullName) {
    return { apellido, nombre };
  }

  const parts = fullName.split(",").map((v) => v.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { apellido: parts[0], nombre: parts.slice(1).join(" ") };
  }

  return { apellido: fullName, nombre: "" };
}

function parseFullName(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return { apellido: "", nombre: "" };
  }
  const partsByComma = raw.split(",").map((v) => v.trim()).filter(Boolean);
  if (partsByComma.length >= 2) {
    return { apellido: partsByComma[0], nombre: partsByComma.slice(1).join(" ") };
  }
  const partsBySpace = raw.split(/\s+/).filter(Boolean);
  if (partsBySpace.length >= 2) {
    return { apellido: partsBySpace[0], nombre: partsBySpace.slice(1).join(" ") };
  }
  return { apellido: raw, nombre: "" };
}

function looksLikeSchedule(value) {
  const text = String(value || "").trim();
  if (!text) {
    return false;
  }
  return /\d{1,2}:\d{2}/.test(text);
}

function parseModuleCount(value) {
  const n = Number(String(value || "").replace(",", ".").trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeDayName(day) {
  const normalized = normalizeHeader(day);
  if (normalized === "miercoles") {
    return "MIERCOLES";
  }
  if (normalized === "lunes") {
    return "LUNES";
  }
  if (normalized === "martes") {
    return "MARTES";
  }
  if (normalized === "jueves") {
    return "JUEVES";
  }
  if (normalized === "viernes") {
    return "VIERNES";
  }
  return String(day || "").trim().toUpperCase();
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

function buildCursoRefs(
  cupof,
  modulosTitular,
  modulosTitularInterino,
  modulosProvisional,
  curso,
  materia
) {
  const refs = [];
  const cupofValue = String(cupof || "").trim();
  const cursoValue = normalizeCourse(curso);
  const materiaValue = String(materia || "").trim();
  if (!cupofValue) {
    return refs;
  }
  if (modulosTitular > 0) {
    refs.push({ cupof: cupofValue, situacionRevista: "T", curso: cursoValue, materia: materiaValue });
  }
  if (modulosTitularInterino > 0) {
    refs.push({ cupof: cupofValue, situacionRevista: "TI", curso: cursoValue, materia: materiaValue });
  }
  if (modulosProvisional > 0) {
    refs.push({ cupof: cupofValue, situacionRevista: "P", curso: cursoValue, materia: materiaValue });
  }
  return refs;
}

function buildSuplenteCursoRefs(cupof, curso, materia) {
  const cupofValue = String(cupof || "").trim();
  const cursoValue = normalizeCourse(curso);
  const materiaValue = String(materia || "").trim();
  if (!cupofValue) {
    return [];
  }
  return [{ cupof: cupofValue, situacionRevista: "S", curso: cursoValue, materia: materiaValue }];
}

function mergeCursoRefs(existing, incoming) {
  const map = new Map();
  const all = [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])];
  all.forEach((item) => {
    const cupof = String(item?.cupof || "").trim();
    const situacionRevista = String(item?.situacionRevista || "").trim().toUpperCase();
    const curso = normalizeCourse(item?.curso || "");
    const materia = String(item?.materia || "").trim();
    if (!cupof || !situacionRevista || !["T", "TI", "P", "S"].includes(situacionRevista)) {
      return;
    }
    map.set(`${cupof}__${situacionRevista}`, { cupof, situacionRevista, curso, materia });
  });
  return Array.from(map.values());
}

function normalizeIdentityPart(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "");
}

function normalizeCuil(value) {
  const raw = String(value || "").trim();
  return raw || "sin datos";
}

function buildDocenteAggregateKey(docente) {
  const cuil = String(docente?.cuil || "").trim();
  if (cuil) {
    return `cuil:${cuil}`;
  }
  const apellido = normalizeIdentityPart(docente?.apellido);
  const nombre = normalizeIdentityPart(docente?.nombre);
  const telefono = normalizeIdentityPart(docente?.telefono);
  const correo = normalizeIdentityPart(docente?.correo);
  const fallback = [apellido, nombre, telefono, correo].filter(Boolean).join("_");
  return `identity:${fallback || db.collection("_tmp").doc().id}`;
}

function mergeDocenteRecord(base, incoming) {
  return {
    ...base,
    ...incoming,
    apellido: base.apellido || incoming.apellido || "",
    nombre: base.nombre || incoming.nombre || "",
    cuil: base.cuil || incoming.cuil || "",
    fechaNacimiento: base.fechaNacimiento || incoming.fechaNacimiento || "",
    telefono: base.telefono || incoming.telefono || "",
    correo: base.correo || incoming.correo || "",
    domicilio: base.domicilio || incoming.domicilio || "",
    cursoRefs: mergeCursoRefs(base.cursoRefs, incoming.cursoRefs),
  };
}

function buildDocenteKey({ cuil, apellido, nombre, pid, keyHint }) {
  const normalizedCuil = String(cuil || "").trim();
  if (normalizedCuil) {
    return normalizedCuil.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  const apellidoKey = normalizeIdentityPart(apellido);
  const nombreKey = normalizeIdentityPart(nombre);
  const pidKey = normalizeIdentityPart(pid);
  const hintKey = normalizeIdentityPart(keyHint);
  const composed = [apellidoKey, nombreKey, pidKey, hintKey]
    .filter(Boolean)
    .join("_");

  return composed || db.collection("_tmp").doc().id;
}

function parseSheetId(sheetUrl) {
  const match = String(sheetUrl || "").match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : "";
}

function parseSheetGid(sheetUrl) {
  const match = String(sheetUrl || "").match(/[?&#]gid=(\d+)/);
  return match ? match[1] : "";
}

function getForcedHeaderRowIndex(rows = [], sheetGid = "") {
  // Hoja DATOS (gid 687928343): encabezado en fila 216, datos desde 217.
  const forcedHeaderRowByGid = {
    "687928343": 216,
  };
  const oneBased = forcedHeaderRowByGid[String(sheetGid || "").trim()];
  if (!oneBased) {
    return -1;
  }
  const zeroBased = oneBased - 1;
  if (zeroBased < 0 || zeroBased >= rows.length) {
    return -1;
  }
  return zeroBased;
}

function normalizeSituacionRevista(value) {
  const raw = normalizeHeader(value);
  if (!raw) {
    return "";
  }
  if (raw.includes("supl")) {
    return "S";
  }
  if (raw.includes("inter")) {
    return "TI";
  }
  if (raw.includes("provis")) {
    return "P";
  }
  if (raw.includes("tit")) {
    return "T";
  }
  if (raw === "t") return "T";
  if (raw === "ti") return "TI";
  if (raw === "p") return "P";
  if (raw === "s") return "S";
  return "";
}

async function getUserTenantId(uid) {
  const userRef = db.collection("usuarios").doc(uid);
  const userSnap = await userRef.get();
  let tenantId = String(userSnap.data()?.tenantId || "").trim();

  if (tenantId) {
    return tenantId;
  }

  const tenantByOwnerUid = await db
    .collection("tenants")
    .where("ownerUid", "==", uid)
    .limit(1)
    .get();
  if (!tenantByOwnerUid.empty) {
    tenantId = tenantByOwnerUid.docs[0].id;
  } else {
    const authUser = await admin.auth().getUser(uid).catch(() => null);
    const email = String(authUser?.email || "").trim().toLowerCase();
    if (email) {
      const tenantByOwnerEmail = await db
        .collection("tenants")
        .where("ownerEmail", "==", email)
        .limit(1)
        .get();
      if (!tenantByOwnerEmail.empty) {
        tenantId = tenantByOwnerEmail.docs[0].id;
      }
    }
  }

  if (!tenantId) {
    throw new HttpsError("failed-precondition", "Tenant not configured for user");
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  await userRef.set(
    {
      uid,
      tenantId,
      updatedAt: now,
      createdAt: userSnap.exists ? userSnap.data()?.createdAt || now : now,
    },
    { merge: true }
  );

  return tenantId;
}

exports.health = onCall(callableOptions, () => {
  return { ok: true, service: "gestor-plantel-docente" };
});

exports.registerUser = onCall(callableOptions, async (request) => {
  const data = request.data || {};

  const nombre = assertString(data.nombre, "nombre", 3, 120);
  const contacto = assertString(data.contacto, "contacto", 6, 40);
  const distrito = assertString(data.distrito, "distrito", 1, 80);
  const nivel = assertString(data.nivel, "nivel", 1, 80);
  const escuela = assertString(String(data.escuela || ""), "escuela", 1, 20);
  const usuario = assertString(data.usuario, "usuario", 3, 40);
  const password = assertString(data.password, "password", 8, 72);

  const correo = normalizeEmail(assertString(data.correo, "correo", 5, 120));
  const correoAltRaw = String(data.correoAlt || "").trim();
  const correoAlt = correoAltRaw ? normalizeEmail(correoAltRaw) : "";

  if (!correo.includes("@")) {
    throw new HttpsError("invalid-argument", "Invalid email");
  }

  const usernameKey = normalizeUsername(usuario);

  const usernameRef = db.collection("usernames").doc(usernameKey);
  const existingUsername = await usernameRef.get();
  if (existingUsername.exists) {
    throw new HttpsError("already-exists", "Username already exists");
  }

  let userRecord;
  try {
    userRecord = await admin.auth().createUser({
      email: correo,
      password,
      displayName: nombre,
      emailVerified: false,
    });
  } catch (err) {
    logger.error("createUser failed", err);
    throw new HttpsError("already-exists", "Email already exists or is invalid");
  }

  const uid = userRecord.uid;
  const createdAt = admin.firestore.FieldValue.serverTimestamp();
  const tenantId = buildTenantId();
  const tenantRef = db.collection("tenants").doc(tenantId);

  const profile = {
    uid,
    tenantId,
    nombre,
    contacto,
    correo,
    correoAlt,
    distrito,
    nivel,
    escuela,
    usuario,
    usuarioKey: usernameKey,
    verificado: false,
    rol: "admin_escuela",
    createdAt,
    updatedAt: createdAt,
  };

  try {
    await db.runTransaction(async (tx) => {
      tx.set(tenantRef, {
        tenantId,
        ownerUid: uid,
        ownerEmail: correo,
        ownerUsername: usernameKey,
        distrito,
        nivel,
        escuela,
        createdAt,
        updatedAt: createdAt,
      });
      tx.set(usernameRef, { uid, createdAt });
      tx.set(db.collection("usuarios").doc(uid), profile);
    });

    const link = await admin.auth().generateEmailVerificationLink(correo);

    return {
      ok: true,
      uid,
      tenantId,
      verificationLink: link,
      message: "User created",
    };
  } catch (err) {
    logger.error("profile transaction failed", err);
    try {
      await admin.auth().deleteUser(uid);
    } catch (rollbackErr) {
      logger.error("rollback deleteUser failed", rollbackErr);
    }
    throw new HttpsError("internal", "Could not complete registration");
  }
});

exports.setUserProfile = onCall(callableOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Auth required");
  }

  const uid = request.auth.uid;
  const data = request.data || {};

  const updates = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const editable = ["nombre", "contacto", "distrito", "nivel", "escuela", "correoAlt"];
  editable.forEach((field) => {
    if (typeof data[field] === "string") {
      updates[field] = data[field].trim();
    }
  });

  await db.collection("usuarios").doc(uid).set(updates, { merge: true });
  return { ok: true };
});

exports.registerSession = onCall(callableOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Auth required");
  }

  const uid = request.auth.uid;
  const tenantId = await getUserTenantId(uid);
  const token = request.auth.token || {};
  const data = request.data || {};
  const now = admin.firestore.FieldValue.serverTimestamp();

  const email = String(data.email || token.email || "").trim().toLowerCase();
  const nombre = String(data.nombre || token.name || "").trim();
  const source = String(data.source || "web").trim();
  const provider = String(data.provider || token.firebase?.sign_in_provider || "").trim();

  const sessionRef = db.collection("tenants").doc(tenantId).collection("sesiones").doc();
  await sessionRef.set({
    sessionId: sessionRef.id,
    tenantId,
    uid,
    email,
    nombre,
    source,
    provider,
    createdAt: now,
  });

  const summaryRef = db.collection("tenants").doc(tenantId).collection("sesionesUsuarios").doc(uid);
  await summaryRef.set(
    {
      tenantId,
      uid,
      email,
      nombre,
      totalInicios: admin.firestore.FieldValue.increment(1),
      lastInicioAt: now,
      updatedAt: now,
      createdAt: now,
    },
    { merge: true }
  );

  return {
    ok: true,
    tenantId,
    sessionId: sessionRef.id,
  };
});

exports.loadDocentesFromSheet = onCall(callableOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Auth required");
  }

  const uid = request.auth.uid;
  await getUserTenantId(uid);

  const data = request.data || {};
  const sheetUrl = assertString(data.sheetUrl, "sheetUrl", 20, 500);
  const sheetGid = parseSheetGid(sheetUrl);
  const sheetName = sheetGid ? String(data.sheetName || "").trim() : assertString(data.sheetName, "sheetName", 1, 120);
  const selectedCourse = normalizeCourse(String(data.course || "").trim());
  const sheetId = parseSheetId(sheetUrl);

  if (!sheetId) {
    throw new HttpsError("invalid-argument", "Invalid Google Sheets URL");
  }

  const endpoint = sheetGid
    ? `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${sheetGid}`
    : `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  logger.info("loadDocentesFromSheet: start", {
    uid,
    sheetId,
    sheetGid,
    sheetName,
    selectedCourse,
  });

  let csvText = "";
  try {
    const response = await fetch(endpoint);
    if (!response.ok) {
      throw new Error(`Sheets request failed with status ${response.status}`);
    }
    csvText = await response.text();
  } catch (err) {
    logger.error("loadDocentesFromSheet fetch failed", err);
    throw new HttpsError(
      "failed-precondition",
      "Could not read sheet. Verify URL, sheet name, and sharing permissions."
    );
  }

  const rows = parseCsv(csvText);
  logger.info("loadDocentesFromSheet: csv parsed", {
    rowsCount: rows.length,
  });
  if (!rows.length) {
    return { ok: true, docentes: [], total: 0 };
  }

  const forcedHeaderRowIndex = getForcedHeaderRowIndex(rows, sheetGid);
  const headerRowIndex = forcedHeaderRowIndex >= 0
    ? forcedHeaderRowIndex
    : findHeaderRowIndex(rows);
  const hasHeaders = headerRowIndex >= 0;
  const headers = hasHeaders ? rows[headerRowIndex].map((header) => normalizeHeader(header)) : [];
  const dataRows = hasHeaders ? rows.slice(headerRowIndex + 1) : rows;
  logger.info("loadDocentesFromSheet: headers analysis", {
    forcedHeaderRowIndex,
    headerRowIndex,
    hasHeaders,
    headers: headers.slice(0, 20),
    firstRowSample: rows[0].slice(0, 10),
    dataRowsCount: dataRows.length,
  });

  const detectedCoursesSet = new Set();
  const rejectionStats = {
    byCourse: 0,
    missingIdentity: 0,
    emptyDocente: 0,
  };
  let lastDetectedCourse = "";

  const docentesRaw = dataRows
    .flatMap((values) => {
      const rowObj = {};
      if (hasHeaders) {
        headers.forEach((header, idx) => {
          rowObj[header] = String(values[idx] || "").trim();
        });
      }

      const pid = pickField(rowObj, ["pid", "legajo", "id"]) || "";
      const espacioCurricular =
        pickField(rowObj, ["espaciocurricular", "materia"]) || String(values[11] || "").trim();
      const cupof = pickField(rowObj, ["cupof"]) || String(values[14] || "").trim();
      if (!cupof || !espacioCurricular) {
        rejectionStats.emptyDocente += 1;
        return [];
      }
      const rawDetectedCourse = pickCourseValue(rowObj, values);
      const detectedCourse = rawDetectedCourse || lastDetectedCourse;
      if (rawDetectedCourse) {
        lastDetectedCourse = rawDetectedCourse;
      }
      if (!detectedCourse) {
        rejectionStats.byCourse += 1;
        return [];
      }
      detectedCoursesSet.add(detectedCourse);
      if (selectedCourse && detectedCourse !== selectedCourse) {
        rejectionStats.byCourse += 1;
        return [];
      }
      const turno = pickField(rowObj, ["turno"]) || String(values[3] || "").trim();
      const modulosTitular = parseModuleCount(
        pickField(rowObj, ["hsmodt", "t"]) || values[6] || values[15]
      );
      const modulosTitularInterino = parseModuleCount(
        pickField(rowObj, ["hsmodti", "ti"]) || values[7] || values[16]
      );
      const modulosProvisional = parseModuleCount(
        pickField(rowObj, ["hsmodp", "p"]) || values[8] || values[17]
      );
      const situacionesActivas = [];
      if (modulosTitular > 0) {
        situacionesActivas.push("T");
      }
      if (modulosTitularInterino > 0) {
        situacionesActivas.push("TI");
      }
      if (modulosProvisional > 0) {
        situacionesActivas.push("P");
      }
      const situacionFromRow = normalizeSituacionRevista(
        pickField(rowObj, ["situacionderevista"]) || String(values[16] || "").trim()
      );

      const titularFullName =
        pickField(rowObj, ["apellidoynombre", "docente", "nombreatellido"]) ||
        pickFieldContaining(rowObj, ["apellidoynombre", "docente"]) ||
        (hasHeaders ? "" : String(values[13] || "").trim());
      const titularParsed = parseFullName(titularFullName);
      const titularCuil = pickTitularCuil(rowObj, values);
      const fechaNacimiento = pickField(rowObj, [
        "fechanacimiento",
        "fecha_nacimiento",
        "nacimiento",
      ]) || "";

      const suplenteParsed = parseFullName(
        pickField(rowObj, ["suplente"]) || (hasHeaders ? "" : String(values[6] || "").trim())
      );
      const suplente2Parsed = parseFullName(
        pickField(rowObj, ["suplente2"]) || (hasHeaders ? "" : String(values[8] || "").trim())
      );

      const docenteVariants = [
        {
          tipo: "titular",
          apellido: titularParsed.apellido,
          nombre: titularParsed.nombre,
          cuil: titularCuil,
          telefono: pickField(rowObj, ["telefonotitular"]) || (!hasHeaders ? String(values[19] || "").trim() : ""),
          correo: pickField(rowObj, ["correoabctitular"]) || (!hasHeaders ? String(values[20] || "").trim() : ""),
          domicilio: pickField(rowObj, ["domiciliotitular"]) || (!hasHeaders ? String(values[21] || "").trim() : ""),
        },
        {
          tipo: "suplente",
          apellido: suplenteParsed.apellido,
          nombre: suplenteParsed.nombre,
          cuil: pickField(rowObj, ["cuilsuplente"]) || (!hasHeaders ? String(values[7] || "").trim() : ""),
          telefono: pickField(rowObj, ["telefonosuplente"]) || (!hasHeaders ? String(values[22] || "").trim() : ""),
          correo: pickField(rowObj, ["correoabcsuplente"]) || (!hasHeaders ? String(values[23] || "").trim() : ""),
          domicilio: pickField(rowObj, ["domiciliosuplente"]) || (!hasHeaders ? String(values[24] || "").trim() : ""),
        },
        {
          tipo: "suplente2",
          apellido: suplente2Parsed.apellido,
          nombre: suplente2Parsed.nombre,
          cuil: pickField(rowObj, ["cuilsuplente2"]) || (!hasHeaders ? String(values[9] || "").trim() : ""),
          telefono: pickField(rowObj, ["telefonosuplente2"]) || (!hasHeaders ? String(values[25] || "").trim() : ""),
          correo: pickField(rowObj, ["correoabcsuplente2"]) || (!hasHeaders ? String(values[26] || "").trim() : ""),
          domicilio: pickField(rowObj, ["domiciliosuplente2"]) || (!hasHeaders ? String(values[27] || "").trim() : ""),
        },
      ];

      return docenteVariants
        .map((variant) => {
          const hasName = Boolean(variant.apellido || variant.nombre);
          const hasIdentity = Boolean(variant.cuil || pid);
          const scheduleLikeName =
            looksLikeSchedule(variant.apellido) || looksLikeSchedule(variant.nombre);
          if (!hasName) {
            rejectionStats.emptyDocente += 1;
            return null;
          }
          if (scheduleLikeName) {
            rejectionStats.emptyDocente += 1;
            return null;
          }
          if (!hasIdentity) {
            rejectionStats.missingIdentity += 1;
            return null;
          }

          return {
            apellido: variant.apellido,
            nombre: variant.nombre,
            cuil: variant.cuil,
            fechaNacimiento,
            cursoRefs: (() => {
              if (variant.tipo !== "titular") {
                return buildSuplenteCursoRefs(cupof, detectedCourse, espacioCurricular);
              }
              const hasByModules = situacionesActivas.length > 0;
              if (hasByModules) {
                return buildCursoRefs(
                  cupof,
                  modulosTitular,
                  modulosTitularInterino,
                  modulosProvisional,
                  detectedCourse,
                  espacioCurricular
                );
              }
              if (situacionFromRow === "TI") {
                return buildCursoRefs(cupof, 0, 1, 0, detectedCourse, espacioCurricular);
              }
              if (situacionFromRow === "P") {
                return buildCursoRefs(cupof, 0, 0, 1, detectedCourse, espacioCurricular);
              }
              if (situacionFromRow === "S") {
                return buildSuplenteCursoRefs(cupof, detectedCourse, espacioCurricular);
              }
              return buildCursoRefs(cupof, 1, 0, 0, detectedCourse, espacioCurricular);
            })(),
            telefono: variant.telefono,
            correo: variant.correo,
            domicilio: variant.domicilio,
          };
        })
        .filter(Boolean);
    })
    .filter(Boolean)
    .slice(0, 500);

  const docentesMap = new Map();
  docentesRaw.forEach((docente) => {
    const key = buildDocenteAggregateKey(docente);
    const existing = docentesMap.get(key);
    if (!existing) {
      docentesMap.set(key, {
        ...docente,
        cursoRefs: Array.isArray(docente.cursoRefs) ? docente.cursoRefs : [],
      });
      return;
    }
    docentesMap.set(key, mergeDocenteRecord(existing, docente));
  });
  const docentes = Array.from(docentesMap.values()).slice(0, 500);

  const detectedCourses = Array.from(detectedCoursesSet).slice(0, 20);
  logger.info("loadDocentesFromSheet: result summary", {
    selectedCourse,
    detectedCourses,
    totalDocentes: docentes.length,
    rejectionStats,
  });

  return {
    ok: true,
    course: selectedCourse || "",
    detectedCourses,
    debug: {
      rowsCount: rows.length,
      dataRowsCount: dataRows.length,
      headerRowIndex,
      hasHeaders,
      rejectionStats,
    },
    docentes,
    total: docentes.length,
  };
});

exports.saveImportedDocente = onCall(callableOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Auth required");
  }

  const uid = request.auth.uid;
  const tenantId = await getUserTenantId(uid);
  const data = request.data || {};
  const docente = data.docente || {};

  const apellido = String(docente.apellido || "").trim();
  const nombre = String(docente.nombre || "").trim();
  const cuil = normalizeCuil(docente.cuil);
  const fechaNacimiento = String(docente.fechaNacimiento || "").trim();
  const pid = String(docente.pid || "").trim();
  const modulosTitular = parseModuleCount(docente.modulosTitular);
  const modulosTitularInterino = parseModuleCount(docente.modulosTitularInterino);
  const modulosProvisional = parseModuleCount(docente.modulosProvisional);
  const telefono = String(docente.telefono || "").trim();
  const correo = String(docente.correo || "").trim();
  const domicilio = String(docente.domicilio || "").trim();
  const course = normalizeCourse(data.course || "");
  const cursosFromPayload = Array.isArray(docente.cursoRefs)
    ? docente.cursoRefs
    : [];
  const fallbackCursoRefs = buildCursoRefs(
    docente.cupof,
    modulosTitular,
    modulosTitularInterino,
    modulosProvisional,
    course,
    String(docente.espacioCurricular || docente.materia || "")
  );
  const incomingCursoRefs = cursosFromPayload.length ? cursosFromPayload : fallbackCursoRefs;

  if ((!cuil || cuil === "sin datos") && !pid && !nombre && !apellido) {
    throw new HttpsError("invalid-argument", "Docente without identity");
  }

  const createdAt = admin.firestore.FieldValue.serverTimestamp();
  let key = buildDocenteKey({
    cuil,
    apellido,
    nombre,
    pid,
    keyHint: docente.keyHint,
  });
  let docenteRef = db.collection("tenants").doc(tenantId).collection("docentes").doc(key);
  let docenteSnap = await docenteRef.get();

  if (cuil && cuil !== "sin datos") {
    const byCuilSnap = await db
      .collection("tenants")
      .doc(tenantId)
      .collection("docentes")
      .where("cuil", "==", cuil)
      .limit(1)
      .get();
    if (!byCuilSnap.empty) {
      docenteRef = byCuilSnap.docs[0].ref;
      docenteSnap = byCuilSnap.docs[0];
      key = byCuilSnap.docs[0].id;
    }
  }

  const existingData = docenteSnap.exists ? docenteSnap.data() : {};
  const mergedCursos = mergeCursoRefs(existingData?.cursos, incomingCursoRefs);

  await docenteRef.set(
    {
      apellido,
      nombre,
      cuil,
      fechaNacimiento,
      pid,
      telefono,
      correo,
      domicilio,
      cursos: mergedCursos,
      tenantId,
      source: {
        sheetUrl: String(data.sheetUrl || ""),
        sheetName: String(data.sheetName || ""),
        course,
        importedBy: uid,
      },
      updatedAt: createdAt,
      createdAt,
    },
    { merge: true }
  );

  return { ok: true, tenantId, docenteId: key };
});

exports.loadCursosFromSheet = onCall(callableOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Auth required");
  }

  const uid = request.auth.uid;
  await getUserTenantId(uid);

  const data = request.data || {};
  const sheetUrl = assertString(data.sheetUrl, "sheetUrl", 20, 500);
  const sheetGid = parseSheetGid(sheetUrl);
  const sheetName = sheetGid ? String(data.sheetName || "").trim() : assertString(data.sheetName, "sheetName", 1, 120);
  const selectedCourse = normalizeCourse(String(data.course || "").trim());
  const sheetId = parseSheetId(sheetUrl);

  if (!sheetId) {
    throw new HttpsError("invalid-argument", "Invalid Google Sheets URL");
  }

  const endpoint = sheetGid
    ? `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${sheetGid}`
    : `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;

  let csvText = "";
  try {
    const response = await fetch(endpoint);
    if (!response.ok) {
      throw new Error(`Sheets request failed with status ${response.status}`);
    }
    csvText = await response.text();
  } catch (err) {
    logger.error("loadCursosFromSheet fetch failed", err);
    throw new HttpsError(
      "failed-precondition",
      "Could not read sheet. Verify URL, sheet name, and sharing permissions."
    );
  }

  const rows = parseCsv(csvText);
  if (!rows.length) {
    return { ok: true, cursos: [], total: 0 };
  }

  const forcedHeaderRowIndex = getForcedHeaderRowIndex(rows, sheetGid);
  const headerRowIndex = forcedHeaderRowIndex >= 0
    ? forcedHeaderRowIndex
    : findHeaderRowIndex(rows);
  const hasHeaders = headerRowIndex >= 0;
  const headers = hasHeaders ? rows[headerRowIndex].map((header) => normalizeHeader(header)) : [];
  const dataRows = hasHeaders ? rows.slice(headerRowIndex + 1) : rows;
  const detectedCoursesSet = new Set();
  let lastDetectedCourse = "";

  const cursos = dataRows
    .flatMap((values) => {
      const rowObj = {};
      if (hasHeaders) {
        headers.forEach((header, idx) => {
          rowObj[header] = String(values[idx] || "").trim();
        });
      }

      const cupof = pickField(rowObj, ["cupof"]) || String(values[14] || "").trim();
      const materia =
        pickField(rowObj, ["espaciocurricular", "materia"]) || String(values[11] || "").trim();
      const pid = pickField(rowObj, ["pid", "legajo", "id"]) || "";
      const turno = pickField(rowObj, ["turno"]) || String(values[3] || "").trim();
      const docenteCuil = pickTitularCuil(rowObj, values);
      const suplenteCuil =
        pickField(rowObj, ["cuilsuplente"]) || (hasHeaders ? "" : String(values[7] || "").trim());

      if (!cupof || !materia) {
        return [];
      }
      const rawDetectedCourse = pickCourseValue(rowObj, values);
      const detectedCourse = rawDetectedCourse || lastDetectedCourse;
      if (rawDetectedCourse) {
        lastDetectedCourse = rawDetectedCourse;
      }
      if (!detectedCourse) {
        return [];
      }
      detectedCoursesSet.add(detectedCourse);
      if (selectedCourse && detectedCourse !== selectedCourse) {
        return [];
      }

      return [{
        curso: detectedCourse || selectedCourse || "",
        cupof,
        materia,
        pid,
        turno,
        diaHorario: {
          dias: [],
          aclaracion: "",
        },
        docenteCuil,
        suplenteCuil,
      }];
    })
    .filter(Boolean)
    .slice(0, 1000);

  const detectedCourses = Array.from(detectedCoursesSet).slice(0, 20);

  return {
    ok: true,
    course: selectedCourse || "",
    detectedCourses,
    cursos,
    total: cursos.length,
  };
});

exports.saveImportedCurso = onCall(callableOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Auth required");
  }

  const uid = request.auth.uid;
  const tenantId = await getUserTenantId(uid);
  const data = request.data || {};
  const curso = data.curso || {};
  const diaHorario = curso.diaHorario || {};

  const cursoNombre = normalizeCourse(String(curso.curso || data.course || "").trim());
  const cupof = String(curso.cupof || "").trim();
  const materia = String(curso.materia || "").trim();
  const pid = String(curso.pid || "").trim();
  const turno = String(curso.turno || "").trim();
  const docenteCuil = String(curso.docenteCuil || "").trim();
  const suplenteCuil = String(curso.suplenteCuil || "").trim();
  const dias = Array.isArray(diaHorario.dias)
    ? diaHorario.dias
      .map((item) => ({
        dia: normalizeDayName(item?.dia || ""),
        horario: normalizeHorarioRange(item?.horario),
      }))
      .filter((item) => item.dia && item.horario)
    : [];
  const aclaracion = String(diaHorario.aclaracion || "").trim();

  if (!cursoNombre || !cupof || !materia) {
    throw new HttpsError("invalid-argument", "Curso incompleto para guardar");
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const safePid = pid || "sinpid";
  const cursoId = `${cursoNombre}_${safePid}_${cupof}`
    .replace(/[^a-zA-Z0-9_-]/g, "_");

  const cursoRootRef = db.collection("tenants").doc(tenantId).collection("cursos").doc(cursoNombre);
  await cursoRootRef.set(
    {
      curso: cursoNombre,
      tenantId,
      updatedAt: now,
      createdAt: now,
    },
    { merge: true }
  );

  const cursoItemRef = cursoRootRef.collection("items").doc(cursoId);
  await cursoItemRef.set(
    {
      curso: cursoNombre,
      cupof,
      materia,
      pid,
      turno,
      diaHorario: {
        dias,
        aclaracion,
      },
      docenteCuil,
      suplenteCuil,
      tenantId,
      source: {
        sheetUrl: String(data.sheetUrl || ""),
        sheetName: String(data.sheetName || ""),
        importedBy: uid,
      },
      updatedAt: now,
      createdAt: now,
    },
    { merge: true }
  );

  return { ok: true, tenantId, cursoId, cursoCollection: cursoNombre };
});
