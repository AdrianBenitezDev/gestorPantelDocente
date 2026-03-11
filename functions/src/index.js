const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const zlib = require("zlib");

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

function pacDecodeBase64Url(rawValue, returnBuffer = false) {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    return returnBuffer ? Buffer.from("") : "";
  }
  let value = raw.replace(/-/g, "+").replace(/_/g, "/");
  const pad = value.length % 4;
  if (pad) {
    value += "=".repeat(4 - pad);
  }
  const buffer = Buffer.from(value, "base64");
  return returnBuffer ? buffer : buffer.toString("utf8");
}

function pacDecodeBase64UrlToText(rawValue) {
  return String(pacDecodeBase64Url(rawValue, false) || "");
}

function pacNormalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function pacNormalizeComparable(value) {
  return pacNormalizeText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function pacEscapeSheetName(value) {
  const name = String(value || "").trim() || "Hoja 1";
  return name.replace(/'/g, "''");
}

function pacParseSheetId(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  const fromUrl = parseSheetId(text);
  if (fromUrl) {
    return fromUrl;
  }
  if (/^[a-zA-Z0-9-_]{20,}$/.test(text)) {
    return text;
  }
  return "";
}

function pacNormalizeScopeList(rawScopes) {
  if (Array.isArray(rawScopes)) {
    return rawScopes
      .map((scope) => String(scope || "").trim())
      .filter(Boolean)
      .sort();
  }
  return String(rawScopes || "")
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean)
    .sort();
}

function pacBuildErrorMetadata(error) {
  const metadata = {
    message: String(error?.message || "Unknown error"),
    code: String(error?.code || ""),
    status: Number(error?.status) || null,
    apiContext: String(error?.apiContext || ""),
    googleStatus: String(error?.googleStatus || ""),
    googleReason: String(error?.googleReason || ""),
    googleDomain: String(error?.googleDomain || ""),
    googleErrorMessage: String(error?.googleErrorMessage || ""),
  };

  return metadata;
}

async function pacFetchTokenInfo(accessToken) {
  const endpoint =
    `https://oauth2.googleapis.com/tokeninfo?access_token=` +
    encodeURIComponent(String(accessToken || "").trim());
  const response = await fetch(endpoint);
  const rawText = await response.text();
  let payload = {};
  if (rawText) {
    try {
      payload = JSON.parse(rawText);
    } catch (parseError) {
      payload = { raw: rawText };
    }
  }

  if (!response.ok) {
    const detail =
      payload?.error_description ||
      payload?.error ||
      payload?.raw ||
      `status ${response.status}`;
    throw new Error(`tokeninfo failed: ${detail}`);
  }

  return {
    audience: String(payload?.aud || ""),
    email: String(payload?.email || ""),
    expiresIn: Number(payload?.expires_in || 0),
    scopeList: pacNormalizeScopeList(payload?.scope || ""),
  };
}

async function pacFetchJson(url, accessToken, options = {}, apiContext = "") {
  const requestHeaders = {
    Authorization: `Bearer ${accessToken}`,
    ...(options.headers || {}),
  };

  if (options.body && !requestHeaders["Content-Type"]) {
    requestHeaders["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    ...options,
    headers: requestHeaders,
  });

  const rawText = await response.text();
  let payload = {};
  if (rawText) {
    try {
      payload = JSON.parse(rawText);
    } catch (parseError) {
      payload = { raw: rawText };
    }
  }

  if (!response.ok) {
    const err = new Error(
      payload?.error?.message || payload?.raw || `Google API status ${response.status}`
    );
    err.name = "PacGoogleApiError";
    err.status = response.status;
    err.apiContext = apiContext;
    err.url = String(url || "");
    err.googleStatus = String(payload?.error?.status || "");
    err.googleErrorMessage = String(payload?.error?.message || "");
    err.googleReason = String(payload?.error?.errors?.[0]?.reason || payload?.error?.details?.[0]?.reason || "");
    err.googleDomain = String(payload?.error?.errors?.[0]?.domain || "");
    err.googlePayload = payload;
    throw err;
  }

  return payload;
}

async function pacListMessages(accessToken, queryText, maxResults) {
  const query = encodeURIComponent(String(queryText || "").trim());
  const safeMax = Math.max(1, Math.min(100, Number(maxResults) || 30));
  const endpoint = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=${safeMax}`;
  const data = await pacFetchJson(endpoint, accessToken, {}, "gmail.listMessages");
  return Array.isArray(data.messages) ? data.messages : [];
}

async function pacGetMessage(accessToken, messageId) {
  const endpoint = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`;
  return pacFetchJson(endpoint, accessToken, {}, "gmail.getMessage");
}

async function pacGetAttachment(accessToken, messageId, attachmentId) {
  const endpoint =
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}` +
    `/attachments/${encodeURIComponent(attachmentId)}`;
  return pacFetchJson(endpoint, accessToken, {}, "gmail.getAttachment");
}

function pacHeaderValue(headers, headerName) {
  const list = Array.isArray(headers) ? headers : [];
  const key = String(headerName || "").trim().toLowerCase();
  const found = list.find((header) => String(header?.name || "").trim().toLowerCase() === key);
  return pacNormalizeText(found?.value || "");
}

function pacExtractUrlsFromText(text) {
  const value = String(text || "");
  if (!value) {
    return [];
  }
  const matches = value.match(/https?:\/\/[^\s<>"')]+/gi);
  if (!matches) {
    return [];
  }
  return matches
    .map((item) => String(item || "").trim().replace(/[),.;]+$/g, ""))
    .filter(Boolean);
}

function pacExtractUrlsFromHtml(htmlText) {
  const value = String(htmlText || "");
  if (!value) {
    return [];
  }
  const urls = [];
  const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;
  let match = hrefRegex.exec(value);
  while (match) {
    const href = String(match[1] || "").trim();
    if (/^https?:\/\//i.test(href)) {
      urls.push(href);
    }
    match = hrefRegex.exec(value);
  }
  return urls;
}

function pacPushUniqueUrl(target, seen, url) {
  const safe = String(url || "").trim();
  if (!safe) {
    return;
  }
  if (seen.has(safe)) {
    return;
  }
  seen.add(safe);
  target.push(safe);
}

function pacCollectMessageContent(payload) {
  const plainChunks = [];
  const htmlChunks = [];
  const attachments = [];
  const seenAttachments = new Set();
  const urls = [];
  const seenUrls = new Set();

  function visitPart(part) {
    if (!part || typeof part !== "object") {
      return;
    }

    const mimeType = String(part.mimeType || "").toLowerCase();
    const filename = String(part.filename || "").trim();
    const body = part.body && typeof part.body === "object" ? part.body : {};
    const dataChunk = typeof body.data === "string" ? body.data : "";
    const attachmentId = String(body.attachmentId || "").trim();
    const size = Number(body.size || 0);
    const isTextPayload =
      mimeType.includes("text/plain") ||
      mimeType.includes("text/html") ||
      mimeType.includes("multipart/");

    if (dataChunk) {
      const decoded = pacDecodeBase64UrlToText(dataChunk);
      if (mimeType.includes("text/plain")) {
        plainChunks.push(decoded);
        pacExtractUrlsFromText(decoded).forEach((url) => pacPushUniqueUrl(urls, seenUrls, url));
      } else if (mimeType.includes("text/html")) {
        htmlChunks.push(decoded);
        pacExtractUrlsFromHtml(decoded).forEach((url) => pacPushUniqueUrl(urls, seenUrls, url));
      }
    }

    const isBinaryPayload = Boolean(attachmentId) || (Boolean(dataChunk) && !isTextPayload);
    const attachmentKey = attachmentId || `${filename}|${mimeType}|${size}|${dataChunk.length}`;
    if (isBinaryPayload && !seenAttachments.has(attachmentKey)) {
      attachments.push({
        attachmentId,
        filename,
        mimeType,
        size,
        inlineData: !attachmentId && Boolean(dataChunk),
        inlineDataChunk: !attachmentId && dataChunk ? dataChunk : "",
      });
      seenAttachments.add(attachmentKey);
    }

    const children = Array.isArray(part.parts) ? part.parts : [];
    children.forEach((child) => visitPart(child));
  }

  visitPart(payload);

  return {
    plainText: plainChunks.join("\n").trim(),
    htmlText: htmlChunks.join("\n").trim(),
    attachments,
    urls,
  };
}

function pacIsDocxAttachment(attachment) {
  const filename = String(attachment?.filename || "").toLowerCase();
  const mimeType = String(attachment?.mimeType || "").toLowerCase();
  return (
    filename.endsWith(".docx") ||
    mimeType.includes("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
  );
}

function pacBuildAttachmentSummary(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (!list.length) {
    return "Sin adjuntos detectados";
  }
  return list
    .slice(0, 8)
    .map((attachment) => {
      const filename = String(attachment?.filename || "").trim() || "(sin nombre)";
      const mimeType = String(attachment?.mimeType || "").trim() || "mime-desconocido";
      const sourceType = attachment?.inlineData ? "inline" : "adjunto";
      return `${filename} [${mimeType}] (${sourceType})`;
    })
    .join(", ");
}

function pacExtractDriveFileIdFromUrl(rawUrl) {
  const url = String(rawUrl || "").trim();
  if (!url) {
    return "";
  }

  const patterns = [
    /docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]{20,})/i,
    /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]{20,})/i,
    /[?&]id=([a-zA-Z0-9_-]{20,})/i,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return String(match[1]).trim();
    }
  }

  return "";
}

function pacExtractDriveFileRefs(sourceText, sourceUrls = []) {
  const refs = [];
  const seenIds = new Set();

  function pushRef(fileId, url, source) {
    const id = String(fileId || "").trim();
    if (!id || seenIds.has(id)) {
      return;
    }
    seenIds.add(id);
    refs.push({
      fileId: id,
      url: String(url || "").trim(),
      source: String(source || ""),
    });
  }

  const text = String(sourceText || "");
  const combinedUrls = [
    ...pacExtractUrlsFromText(text),
    ...(Array.isArray(sourceUrls) ? sourceUrls : []),
  ];

  combinedUrls.forEach((rawUrl) => {
    let candidates = [String(rawUrl || "").trim()];
    try {
      const parsed = new URL(String(rawUrl || "").trim());
      const host = String(parsed.hostname || "").toLowerCase();
      if (host === "www.google.com" && parsed.pathname === "/url") {
        const nested = parsed.searchParams.get("q") || parsed.searchParams.get("url");
        if (nested) {
          candidates.push(String(nested || "").trim());
        }
      }
    } catch (error) {
      // Ignorar URLs no parseables
    }

    candidates.forEach((candidateUrl) => {
      const fileId = pacExtractDriveFileIdFromUrl(candidateUrl);
      if (fileId) {
        pushRef(fileId, candidateUrl, "url");
      }
    });
  });

  const directTextPatterns = [
    /docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]{20,})/gi,
    /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]{20,})/gi,
  ];
  directTextPatterns.forEach((pattern) => {
    let match = pattern.exec(text);
    while (match) {
      pushRef(match[1], match[0], "text");
      match = pattern.exec(text);
    }
  });

  return refs;
}

function pacBuildDriveRefsSummary(driveRefs) {
  const list = Array.isArray(driveRefs) ? driveRefs : [];
  if (!list.length) {
    return "Sin enlaces Drive detectados";
  }
  return list
    .slice(0, 8)
    .map((ref) => {
      const fileId = String(ref?.fileId || "").trim();
      const url = String(ref?.url || "").trim();
      return `${fileId}${url ? ` -> ${url}` : ""}`;
    })
    .join(", ");
}

async function pacFetchBinary(url, accessToken, options = {}, apiContext = "") {
  const requestHeaders = {
    Authorization: `Bearer ${accessToken}`,
    ...(options.headers || {}),
  };

  const response = await fetch(url, {
    ...options,
    headers: requestHeaders,
  });

  if (!response.ok) {
    const rawText = await response.text();
    let payload = {};
    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch (parseError) {
        payload = { raw: rawText };
      }
    }
    const err = new Error(
      payload?.error?.message || payload?.raw || `Google API status ${response.status}`
    );
    err.name = "PacGoogleApiError";
    err.status = response.status;
    err.apiContext = apiContext;
    err.url = String(url || "");
    err.googleStatus = String(payload?.error?.status || "");
    err.googleErrorMessage = String(payload?.error?.message || "");
    err.googleReason = String(payload?.error?.errors?.[0]?.reason || payload?.error?.details?.[0]?.reason || "");
    err.googleDomain = String(payload?.error?.errors?.[0]?.domain || "");
    err.googlePayload = payload;
    throw err;
  }

  const arr = await response.arrayBuffer();
  return Buffer.from(arr);
}

async function pacGetDriveFileMetadata(accessToken, fileId) {
  const endpoint =
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}` +
    "?fields=id,name,mimeType,webViewLink";
  return pacFetchJson(endpoint, accessToken, {}, "drive.getFileMetadata");
}

async function pacGetDriveDocxBuffer(accessToken, fileMeta) {
  const fileId = String(fileMeta?.id || "").trim();
  const mimeType = String(fileMeta?.mimeType || "").trim().toLowerCase();
  if (!fileId) {
    throw new Error("Drive file id invalido");
  }

  if (mimeType === "application/vnd.google-apps.document") {
    const endpoint =
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}` +
      "/export?mimeType=application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    return pacFetchBinary(endpoint, accessToken, {}, "drive.exportDocx");
  }

  const endpoint =
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  return pacFetchBinary(endpoint, accessToken, {}, "drive.downloadFile");
}

function pacPushMailError(target, metadata, reason, extra = {}) {
  const output = Array.isArray(target) ? target : [];
  output.push({
    messageId: String(metadata?.messageId || ""),
    threadId: String(metadata?.threadId || ""),
    subject: String(metadata?.subject || ""),
    from: String(metadata?.from || ""),
    date: String(metadata?.date || ""),
    reason: String(reason || "Sin detalle"),
    ...extra,
  });
}

function pacDecodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    })
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function pacStripHtml(htmlText) {
  const html = String(htmlText || "");
  if (!html) {
    return "";
  }
  const withoutScript = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");

  const withBreaks = withoutScript
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n");

  const withoutTags = withBreaks.replace(/<[^>]+>/g, " ");
  return pacDecodeHtmlEntities(withoutTags)
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => pacNormalizeText(line))
    .filter(Boolean)
    .join("\n");
}

function pacPickMessageBodyText(content) {
  const plainText = pacNormalizeText(content?.plainText || "");
  if (plainText) {
    return String(content.plainText || "").trim();
  }
  const htmlAsText = pacStripHtml(content?.htmlText || "");
  return String(htmlAsText || "").trim();
}

function pacDecodeXmlEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function pacReadZipEntry(zipBuffer, entryName) {
  if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length < 22) {
    throw new Error("DOCX invalido");
  }

  const minOffset = Math.max(0, zipBuffer.length - 66000);
  let eocdOffset = -1;
  for (let cursor = zipBuffer.length - 22; cursor >= minOffset; cursor -= 1) {
    if (zipBuffer.readUInt32LE(cursor) === 0x06054b50) {
      eocdOffset = cursor;
      break;
    }
  }

  if (eocdOffset < 0) {
    throw new Error("No se encontro cabecera ZIP en DOCX");
  }

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = zipBuffer.readUInt32LE(eocdOffset + 16);
  let cursor = centralDirOffset;

  for (let i = 0; i < totalEntries; i += 1) {
    if (cursor + 46 > zipBuffer.length) {
      break;
    }
    if (zipBuffer.readUInt32LE(cursor) !== 0x02014b50) {
      break;
    }

    const compressionMethod = zipBuffer.readUInt16LE(cursor + 10);
    const compressedSize = zipBuffer.readUInt32LE(cursor + 20);
    const fileNameLength = zipBuffer.readUInt16LE(cursor + 28);
    const extraLength = zipBuffer.readUInt16LE(cursor + 30);
    const commentLength = zipBuffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + fileNameLength;

    if (nameEnd > zipBuffer.length) {
      break;
    }

    const fileName = zipBuffer.toString("utf8", nameStart, nameEnd);
    cursor = nameEnd + extraLength + commentLength;

    if (fileName !== entryName) {
      continue;
    }

    if (localHeaderOffset + 30 > zipBuffer.length) {
      throw new Error("Cabecera local ZIP invalida");
    }

    if (zipBuffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error("Firma local ZIP invalida");
    }

    const localNameLength = zipBuffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = zipBuffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;

    if (dataEnd > zipBuffer.length) {
      throw new Error("Datos ZIP truncados");
    }

    const compressed = zipBuffer.subarray(dataStart, dataEnd);
    if (compressionMethod === 0) {
      return Buffer.from(compressed);
    }
    if (compressionMethod === 8) {
      return zlib.inflateRawSync(compressed);
    }
    throw new Error(`Metodo de compresion ZIP no soportado: ${compressionMethod}`);
  }

  throw new Error(`No se encontro ${entryName} en el DOCX`);
}

function pacExtractDocxText(docxBuffer) {
  const xmlBuffer = pacReadZipEntry(docxBuffer, "word/document.xml");
  const xml = xmlBuffer.toString("utf8");

  const withBreaks = xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n");

  const plain = withBreaks.replace(/<[^>]+>/g, " ");
  return pacDecodeXmlEntities(plain)
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => pacNormalizeText(line))
    .filter(Boolean)
    .join("\n");
}

function pacFindFirst(text, regexList) {
  const value = String(text || "");
  for (const regex of regexList) {
    const match = value.match(regex);
    if (match && match[1]) {
      return pacNormalizeText(match[1]);
    }
  }
  return "";
}

function pacNormalizeCuil(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11) {
    return digits;
  }
  return "";
}

function pacDniFromCuil(cuilDigits) {
  const digits = String(cuilDigits || "").replace(/\D/g, "");
  if (digits.length !== 11) {
    return "";
  }
  return digits.slice(2, 10);
}

function pacNormalizeDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/([0-3]?\d)[\/\-.]([01]?\d)[\/\-.]((?:19|20)\d{2})/);
  if (!match) {
    return "";
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);

  if (
    !Number.isFinite(day) ||
    !Number.isFinite(month) ||
    !Number.isFinite(year) ||
    day < 1 ||
    day > 31 ||
    month < 1 ||
    month > 12
  ) {
    return "";
  }

  return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
}

function pacBuildCargoModulosHoras(text) {
  const raw = String(text || "");
  const mergedLine = pacFindFirst(raw, [
    /cargo\s*\/\s*m[oó]dulos?\s*\/\s*horas?\s*[:\-]?\s*([^\n\r]+)/i,
    /cargo\/modulos\/horas\s*[:\-]?\s*([^\n\r]+)/i,
  ]);
  if (mergedLine) {
    return mergedLine;
  }

  const cargo = pacFindFirst(raw, [/cargo\s*[:\-]?\s*([^\n\r]+)/i]);
  const modulos = pacFindFirst(raw, [/m[oó]dulos?\s*[:\-]?\s*([^\n\r]+)/i]);
  const horas = pacFindFirst(raw, [/horas?\s*[:\-]?\s*([^\n\r]+)/i]);

  const parts = [];
  if (cargo) {
    parts.push(`Cargo: ${cargo}`);
  }
  if (modulos) {
    parts.push(`Modulos: ${modulos}`);
  }
  if (horas) {
    parts.push(`Horas: ${horas}`);
  }

  return parts.join(" | ");
}

function pacParseCursoDivision(rawValue) {
  const raw = pacNormalizeText(rawValue).toUpperCase();
  if (!raw) {
    return { curso: "", division: "" };
  }

  const matchCompact = raw.match(/(\d{1,2})\s*(?:[°º]|ERO|RO|DO|TO)?\s*([A-Z0-9]{1,3})\b/);
  if (matchCompact) {
    return {
      curso: pacNormalizeText(matchCompact[1]),
      division: pacNormalizeText(matchCompact[2]),
    };
  }

  const tokens = raw.split(/[\s,;:/_-]+/).filter(Boolean);
  const cursoToken = tokens.find((token) => /^\d{1,2}$/.test(token));
  const divisionToken = tokens.find((token) => /^[A-Z]{1,3}$/.test(token));

  return {
    curso: pacNormalizeText(cursoToken || ""),
    division: pacNormalizeText(divisionToken || ""),
  };
}

function pacExtractPacRow(text, meta = {}) {
  const source = String(text || "").replace(/\r/g, "\n");

  const cupof = pacFindFirst(source, [
    /cu\.?p\.?o\.?f\.?\s*(?:n[º°o])?\s*[:\-]?\s*([0-9]{4,})/i,
    /cupof\s*[:\-]?\s*([0-9]{4,})/i,
  ]);

  const cuilRaw = pacFindFirst(source, [
    /cuil(?:\s*(?:nro|numero|n[oú]mero))?\s*[:\-]?\s*([0-9]{2}\D?[0-9]{7,8}\D?[0-9])/i,
    /(?:^|\D)([0-9]{2}\D?[0-9]{7,8}\D?[0-9])(?:\D|$)/,
  ]);
  const cuil = pacNormalizeCuil(cuilRaw);

  const dniByLabel = pacFindFirst(source, [/dni\s*[:\-]?\s*([0-9]{7,8})/i]);
  const dni = dniByLabel || pacDniFromCuil(cuil);

  const fechaNacimiento = pacNormalizeDate(
    pacFindFirst(source, [
      /fecha(?:\s+de)?\s+nac(?:imiento)?\s*[:\-]?\s*([0-3]?\d[\/\-.][01]?\d[\/\-.](?:19|20)\d{2})/i,
      /nac(?:imiento)?\s*[:\-]?\s*([0-3]?\d[\/\-.][01]?\d[\/\-.](?:19|20)\d{2})/i,
    ])
  );

  const apellidoNombre = pacFindFirst(source, [
    /apellido(?:s)?\s*y?\s*nombre(?:s)?\s*[:\-]?\s*([^\n\r]+)/i,
    /nombre(?:s)?\s+y?\s*apellido(?:s)?\s*[:\-]?\s*([^\n\r]+)/i,
    /docente\s*[:\-]?\s*([^\n\r]+)/i,
  ]);

  const pid = pacFindFirst(source, [/pid\s*[:\-]?\s*([A-Za-z0-9./_-]+)/i]);
  const cargoModulosHoras = pacBuildCargoModulosHoras(source);

  const cursoLabel = pacFindFirst(source, [/curso\s*[:\-]?\s*([^\n\r]+)/i]);
  const divisionLabel = pacFindFirst(source, [/divisi[oó]n\s*[:\-]?\s*([^\n\r]+)/i]);
  const cursoDivisionLine = pacFindFirst(source, [
    /curso\s*(?:y|\/)\s*divisi[oó]n\s*[:\-]?\s*([^\n\r]+)/i,
  ]);

  const parsedCursoDivision = pacParseCursoDivision(
    `${cursoDivisionLine || ""} ${cursoLabel || ""} ${divisionLabel || ""}`
  );

  const curso = pacNormalizeText(cursoLabel || parsedCursoDivision.curso);
  const division = pacNormalizeText(divisionLabel || parsedCursoDivision.division);

  const row = {
    cupof,
    dni,
    fechaNacimiento,
    apellidoNombre,
    pid,
    cargoModulosHoras,
    curso,
    division,
    cuil,
    messageId: String(meta.messageId || ""),
    subject: String(meta.subject || ""),
    from: String(meta.from || ""),
    date: String(meta.date || ""),
    attachmentName: String(meta.attachmentName || ""),
  };

  const requiredFields = [
    ["cupof", "cupof"],
    ["dni", "dni"],
    ["fechaNacimiento", "fechaNacimiento"],
    ["apellidoNombre", "apellidoNombre"],
    ["pid", "pid"],
    ["cargoModulosHoras", "cargoModulosHoras"],
    ["curso", "curso"],
    ["division", "division"],
  ];

  row.missingFields = requiredFields
    .filter(([key]) => !pacNormalizeText(row[key]))
    .map(([, label]) => label);

  return row;
}

function pacFieldScore(row) {
  const fields = [
    "cupof",
    "dni",
    "fechaNacimiento",
    "apellidoNombre",
    "pid",
    "cargoModulosHoras",
    "curso",
    "division",
  ];
  return fields.reduce((total, key) => {
    return total + (pacNormalizeText(row?.[key] || "") ? 1 : 0);
  }, 0);
}

function pacBuildFieldMapFromHeaders(headerRows) {
  const defaults = {
    cupof: 0,
    dni: 1,
    fechaNacimiento: 2,
    apellidoNombre: 3,
    pid: 4,
    cargoModulosHoras: 5,
    curso: 6,
    division: 7,
  };

  const row12 = Array.isArray(headerRows?.[0]) ? headerRows[0] : [];
  const row13 = Array.isArray(headerRows?.[1]) ? headerRows[1] : [];
  const maxLen = Math.max(row12.length, row13.length, 0);
  if (!maxLen) {
    return defaults;
  }

  const labels = [];
  for (let i = 0; i < maxLen; i += 1) {
    const merged = `${String(row12[i] || "")} ${String(row13[i] || "")}`;
    labels.push(pacNormalizeComparable(merged));
  }

  function findColumn(keywords) {
    for (let index = 0; index < labels.length; index += 1) {
      const label = labels[index];
      if (!label) {
        continue;
      }
      for (const keyword of keywords) {
        if (label.includes(pacNormalizeComparable(keyword))) {
          return index;
        }
      }
    }
    return -1;
  }

  return {
    cupof: findColumn(["cupof"]) >= 0 ? findColumn(["cupof"]) : defaults.cupof,
    dni: findColumn(["dni", "documento"]) >= 0 ? findColumn(["dni", "documento"]) : defaults.dni,
    fechaNacimiento: findColumn(["fecha de nacimiento", "fecha nacimiento", "nacimiento"]) >= 0
      ? findColumn(["fecha de nacimiento", "fecha nacimiento", "nacimiento"])
      : defaults.fechaNacimiento,
    apellidoNombre: findColumn(["apellido y nombre", "apellidos y nombres", "nombre y apellido"]) >= 0
      ? findColumn(["apellido y nombre", "apellidos y nombres", "nombre y apellido"])
      : defaults.apellidoNombre,
    pid: findColumn(["pid"]) >= 0 ? findColumn(["pid"]) : defaults.pid,
    cargoModulosHoras: findColumn(["cargo/modulos/horas", "cargo modulos horas", "cargo", "modulos", "horas"]) >= 0
      ? findColumn(["cargo/modulos/horas", "cargo modulos horas", "cargo", "modulos", "horas"])
      : defaults.cargoModulosHoras,
    curso: findColumn(["curso"]) >= 0 ? findColumn(["curso"]) : defaults.curso,
    division: findColumn(["division", "seccion"]) >= 0
      ? findColumn(["division", "seccion"])
      : defaults.division,
  };
}

function pacColumnIndexToLetter(index) {
  let num = Number(index);
  if (!Number.isFinite(num) || num < 0) {
    return "A";
  }

  let letter = "";
  while (num >= 0) {
    letter = String.fromCharCode((num % 26) + 65) + letter;
    num = Math.floor(num / 26) - 1;
  }
  return letter;
}

async function pacReadSheetHeaderRows(accessToken, sheetId, sheetName) {
  const escapedSheet = pacEscapeSheetName(sheetName);
  const range = `'${escapedSheet}'!12:13`;
  const endpoint =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    `/values/${encodeURIComponent(range)}`;
  const payload = await pacFetchJson(endpoint, accessToken, {}, "sheets.readHeaderRows");
  return Array.isArray(payload.values) ? payload.values : [];
}

async function pacResolveSheetName(accessToken, sheetId, requestedName) {
  const explicitName = pacNormalizeText(requestedName || "");
  if (explicitName) {
    return explicitName;
  }

  const endpoint =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    "?fields=sheets.properties.title";
  const payload = await pacFetchJson(endpoint, accessToken, {}, "sheets.resolveSheetName");
  const sheets = Array.isArray(payload?.sheets) ? payload.sheets : [];
  const firstTitle = pacNormalizeText(sheets[0]?.properties?.title || "");
  if (!firstTitle) {
    throw new Error("No se encontro ninguna hoja en la plantilla");
  }
  return firstTitle;
}

async function pacFindFirstInsertRow(accessToken, sheetId, sheetName, startRow) {
  const safeStartRow = Math.max(1, Number(startRow) || 14);
  const escapedSheet = pacEscapeSheetName(sheetName);
  const range = `'${escapedSheet}'!A${safeStartRow}:A`;
  const endpoint =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    `/values/${encodeURIComponent(range)}`;
  const payload = await pacFetchJson(endpoint, accessToken, {}, "sheets.findFirstInsertRow");
  const values = Array.isArray(payload.values) ? payload.values : [];

  let occupied = 0;
  for (let i = 0; i < values.length; i += 1) {
    const firstCell = pacNormalizeText(values[i]?.[0] || "");
    if (!firstCell) {
      break;
    }
    occupied += 1;
  }

  return safeStartRow + occupied;
}

function pacBuildSheetValues(rows, fieldMap) {
  const map = fieldMap || {
    cupof: 0,
    dni: 1,
    fechaNacimiento: 2,
    apellidoNombre: 3,
    pid: 4,
    cargoModulosHoras: 5,
    curso: 6,
    division: 7,
  };

  const width = Math.max(
    Number(map.cupof || 0),
    Number(map.dni || 1),
    Number(map.fechaNacimiento || 2),
    Number(map.apellidoNombre || 3),
    Number(map.pid || 4),
    Number(map.cargoModulosHoras || 5),
    Number(map.curso || 6),
    Number(map.division || 7),
    7
  ) + 1;

  return rows.map((row) => {
    const line = new Array(width).fill("");
    line[map.cupof] = String(row?.cupof || "");
    line[map.dni] = String(row?.dni || "");
    line[map.fechaNacimiento] = String(row?.fechaNacimiento || "");
    line[map.apellidoNombre] = String(row?.apellidoNombre || "");
    line[map.pid] = String(row?.pid || "");
    line[map.cargoModulosHoras] = String(row?.cargoModulosHoras || "");
    line[map.curso] = String(row?.curso || "");
    line[map.division] = String(row?.division || "");
    return line;
  });
}

async function pacWriteRowsToSheet(accessToken, sheetId, sheetName, startRow, rows) {
  const headerRows = await pacReadSheetHeaderRows(accessToken, sheetId, sheetName);
  const fieldMap = pacBuildFieldMapFromHeaders(headerRows);
  const values = pacBuildSheetValues(rows, fieldMap);

  if (!values.length) {
    return {
      rowsWritten: 0,
      range: "",
      startRow: Math.max(1, Number(startRow) || 14),
      endRow: Math.max(1, Number(startRow) || 14),
      fieldMap,
    };
  }

  const insertRow = await pacFindFirstInsertRow(accessToken, sheetId, sheetName, startRow);
  const endRow = insertRow + values.length - 1;
  const endCol = pacColumnIndexToLetter(values[0].length - 1);
  const escapedSheet = pacEscapeSheetName(sheetName);
  const range = `'${escapedSheet}'!A${insertRow}:${endCol}${endRow}`;
  const endpoint =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    `/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;

  await pacFetchJson(endpoint, accessToken, {
    method: "PUT",
    body: JSON.stringify({ values }),
  }, "sheets.writeRows");

  return {
    rowsWritten: values.length,
    range,
    startRow: insertRow,
    endRow,
    fieldMap,
  };
}

exports.runPacProcess = onCall(callableOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Auth required");
  }

  const data = request.data || {};
  const requestedMode = String(data.mode || "interinos_docx").trim().toLowerCase();
  const mode =
    requestedMode === "designacion_body"
      ? "designacion_body"
      : requestedMode === "interinos_docx"
        ? "interinos_docx"
        : "";

  if (!mode) {
    throw new HttpsError("invalid-argument", "mode must be interinos_docx or designacion_body");
  }

  const accessToken = assertString(data.accessToken, "accessToken", 20, 10000);
  const maxResultsRaw = Number(data.maxResults);
  const maxResults = Number.isFinite(maxResultsRaw)
    ? Math.max(1, Math.min(100, Math.floor(maxResultsRaw)))
    : 30;
  const startRowRaw = Number(data.startRow);
  const startRow = Number.isFinite(startRowRaw) && startRowRaw > 0 ? Math.floor(startRowRaw) : 14;
  const previewOnly = Boolean(data.previewOnly);

  const defaultQuery = mode === "interinos_docx"
    ? "has:attachment filename:docx newer_than:30d"
    : "newer_than:30d";
  const gmailQuery = pacNormalizeText(data.gmailQuery || "") || defaultQuery;

  const sheetUrl = String(data.sheetUrl || "").trim();
  const requestedSheetName = pacNormalizeText(data.sheetName || "");
  const sheetId = pacParseSheetId(sheetUrl);

  if (!previewOnly && !sheetId) {
    throw new HttpsError("invalid-argument", "Invalid Google Sheet URL/ID");
  }

  const authEmail = normalizeEmail(request.auth.token?.email || "");
  if (authEmail && !authEmail.endsWith("@abc.gob.ar")) {
    logger.warn("runPacProcess email outside abc.gob.ar domain", { email: authEmail });
  }

  const requiredScopes = ["https://www.googleapis.com/auth/gmail.readonly"];
  if (!previewOnly) {
    requiredScopes.push("https://www.googleapis.com/auth/spreadsheets");
  }
  if (mode === "interinos_docx") {
    requiredScopes.push("https://www.googleapis.com/auth/drive.readonly");
  }

  let tokenInfo = null;
  try {
    tokenInfo = await pacFetchTokenInfo(accessToken);
  } catch (tokenInfoError) {
    logger.warn("runPacProcess tokeninfo unavailable", {
      message: String(tokenInfoError?.message || "tokeninfo failed"),
      mode,
      previewOnly,
      authEmail,
    });
  }

  const grantedScopes = tokenInfo?.scopeList || [];
  const missingScopes = requiredScopes.filter((scope) => !grantedScopes.includes(scope));

  if (tokenInfo && missingScopes.length) {
    logger.warn("runPacProcess missing scopes", {
      mode,
      previewOnly,
      authEmail,
      requiredScopes,
      grantedScopes,
      missingScopes,
      tokenAudience: tokenInfo.audience,
      tokenEmail: tokenInfo.email,
    });
    throw new HttpsError(
      "failed-precondition",
      "El token de Google no tiene permisos suficientes para este proceso.",
      {
        errorType: "missing_scopes",
        mode,
        previewOnly,
        requiredScopes,
        grantedScopes,
        missingScopes,
        tokenAudience: tokenInfo.audience,
        tokenEmail: tokenInfo.email,
      }
    );
  }

  let messages = [];
  try {
    messages = await pacListMessages(accessToken, gmailQuery, maxResults);
  } catch (error) {
    const errorMetadata = pacBuildErrorMetadata(error);
    logger.error("runPacProcess list messages error", {
      ...errorMetadata,
      mode,
      previewOnly,
      authEmail,
      gmailQuery,
      requiredScopes,
      grantedScopes,
      missingScopes,
      tokenAudience: tokenInfo?.audience || "",
      tokenEmail: tokenInfo?.email || "",
    });
    throw new HttpsError(
      "failed-precondition",
      `No se pudo leer Gmail. Reautoriza permisos e intenta nuevamente. ${error.message || ""}`,
      {
        errorType: "gmail_list_failed",
        mode,
        previewOnly,
        gmailQuery,
        requiredScopes,
        grantedScopes,
        missingScopes,
        tokenAudience: tokenInfo?.audience || "",
        tokenEmail: tokenInfo?.email || "",
        ...errorMetadata,
      }
    );
  }

  const rows = [];
  const errors = [];

  let sheetName = requestedSheetName;
  if (!previewOnly && sheetId) {
    try {
      sheetName = await pacResolveSheetName(accessToken, sheetId, requestedSheetName);
    } catch (sheetNameError) {
      const errorMetadata = pacBuildErrorMetadata(sheetNameError);
      throw new HttpsError(
        "failed-precondition",
        `No se pudo resolver la hoja destino: ${sheetNameError.message || "sin detalle"}`,
        {
          errorType: "sheet_name_failed",
          sheetId,
          requestedSheetName,
          ...errorMetadata,
        }
      );
    }
  } else if (!sheetName) {
    sheetName = "Hoja 1";
  }

  for (const item of messages) {
    const messageId = String(item?.id || "").trim();
    if (!messageId) {
      continue;
    }

    try {
      const fullMessage = await pacGetMessage(accessToken, messageId);
      const headers = Array.isArray(fullMessage?.payload?.headers) ? fullMessage.payload.headers : [];
      const subject = pacHeaderValue(headers, "Subject");
      const from = pacHeaderValue(headers, "From");
      const date = pacHeaderValue(headers, "Date");
      const threadId = String(fullMessage?.threadId || item?.threadId || "");
      const mailMetadata = {
        messageId,
        threadId,
        subject,
        from,
        date,
      };
      const content = pacCollectMessageContent(fullMessage?.payload || {});

      if (mode === "interinos_docx") {
        const docxAttachments = content.attachments.filter((attachment) =>
          pacIsDocxAttachment(attachment)
        );
        const driveRefs = pacExtractDriveFileRefs(
          `${String(content?.plainText || "")}\n${String(content?.htmlText || "")}\n${subject}`,
          content.urls
        );

        const sourceCandidates = [
          ...docxAttachments.map((attachment) => ({
            type: "attachment",
            label: String(attachment?.filename || "").trim() || String(attachment?.mimeType || "adjunto"),
            attachment,
          })),
          ...driveRefs.map((ref) => ({
            type: "drive",
            label: `drive:${ref.fileId}`,
            driveRef: ref,
          })),
        ];

        if (!sourceCandidates.length) {
          pacPushMailError(errors, mailMetadata, "No se encontro adjunto DOCX ni enlace a Google Docs/Drive", {
            attachmentsDetected: content.attachments.length,
            attachmentsSummary: pacBuildAttachmentSummary(content.attachments),
            driveLinksDetected: driveRefs.length,
            driveLinksSummary: pacBuildDriveRefsSummary(driveRefs),
          });
          continue;
        }

        let bestRow = null;
        let bestScore = -1;
        const sourceErrors = [];

        for (const source of sourceCandidates) {
          try {
            let docxBuffer = null;
            let sourceName = source.label;

            if (source.type === "attachment") {
              const attachment = source.attachment || {};
              let attachmentData = String(attachment?.inlineDataChunk || "");
              if (!attachmentData) {
                const attachmentPayload = await pacGetAttachment(
                  accessToken,
                  messageId,
                  attachment.attachmentId
                );
                attachmentData = String(attachmentPayload?.data || "");
              }
              if (!attachmentData) {
                throw new Error("Adjunto vacio");
              }
              docxBuffer = pacDecodeBase64Url(attachmentData, true);
              sourceName = String(attachment?.filename || sourceName || "").trim() || sourceName;
            } else {
              const ref = source.driveRef || {};
              const metadata = await pacGetDriveFileMetadata(accessToken, ref.fileId);
              docxBuffer = await pacGetDriveDocxBuffer(accessToken, metadata);
              sourceName = String(metadata?.name || source.label || "").trim() || source.label;
            }

            const docxText = pacExtractDocxText(docxBuffer);
            const row = pacExtractPacRow(docxText, {
              messageId,
              subject,
              from,
              date,
              attachmentName: sourceName,
            });
            const score = pacFieldScore(row);
            if (score > bestScore) {
              bestRow = row;
              bestScore = score;
            }
          } catch (sourceError) {
            sourceErrors.push(`${source.label}: ${String(sourceError?.message || "Error sin detalle")}`);
          }
        }

        if (!bestRow) {
          pacPushMailError(
            errors,
            mailMetadata,
            sourceErrors[0] || "No se pudo extraer datos del adjunto DOCX o del enlace Drive",
            {
            attachmentsDetected: content.attachments.length,
            attachmentsSummary: pacBuildAttachmentSummary(content.attachments),
            driveLinksDetected: driveRefs.length,
            driveLinksSummary: pacBuildDriveRefsSummary(driveRefs),
            sourceErrors: sourceErrors.slice(0, 5),
            }
          );
          continue;
        }

        rows.push(bestRow);
        continue;
      }

      const bodyText = pacPickMessageBodyText(content);
      if (!bodyText) {
        pacPushMailError(errors, mailMetadata, "El mail no tiene cuerpo de texto util", {
          attachmentsDetected: content.attachments.length,
          attachmentsSummary: pacBuildAttachmentSummary(content.attachments),
        });
        continue;
      }

      rows.push(
        pacExtractPacRow(bodyText, {
          messageId,
          subject,
          from,
          date,
          attachmentName: "",
        })
      );
    } catch (messageError) {
      logger.error("runPacProcess message error", { messageId, messageError });
      pacPushMailError(errors, {
        messageId,
        threadId: String(item?.threadId || ""),
      }, String(messageError?.message || "No se pudo procesar el mail"), {
        debugMessage: String(messageError?.message || ""),
      });
    }
  }

  let writeSummary = null;
  if (!previewOnly && rows.length) {
    try {
      writeSummary = await pacWriteRowsToSheet(accessToken, sheetId, sheetName, startRow, rows);
    } catch (writeError) {
      const errorMetadata = pacBuildErrorMetadata(writeError);
      logger.error("runPacProcess write sheet error", {
        ...errorMetadata,
        sheetId,
        sheetName,
        startRow,
      });
      throw new HttpsError(
        "failed-precondition",
        `No se pudo escribir en Google Sheet: ${writeError.message || "sin detalle"}`,
        {
          errorType: "sheet_write_failed",
          sheetId,
          sheetName,
          startRow,
          ...errorMetadata,
        }
      );
    }
  }

  const safeRows = rows.map((row) => ({
    cupof: String(row.cupof || ""),
    dni: String(row.dni || ""),
    fechaNacimiento: String(row.fechaNacimiento || ""),
    apellidoNombre: String(row.apellidoNombre || ""),
    pid: String(row.pid || ""),
    cargoModulosHoras: String(row.cargoModulosHoras || ""),
    curso: String(row.curso || ""),
    division: String(row.division || ""),
    messageId: String(row.messageId || ""),
    subject: String(row.subject || ""),
    from: String(row.from || ""),
    date: String(row.date || ""),
    attachmentName: String(row.attachmentName || ""),
    missingFields: Array.isArray(row.missingFields) ? row.missingFields : [],
  }));

  return {
    ok: true,
    mode,
    gmailQuery,
    totalMessages: messages.length,
    rowsExtracted: safeRows.length,
    errorsCount: errors.length,
    rows: safeRows,
    errors: errors.slice(0, 100),
    diagnostics: {
      requiredScopes,
      grantedScopes,
      missingScopes,
      tokenAudience: tokenInfo?.audience || "",
      tokenEmail: tokenInfo?.email || "",
    },
    writeSummary,
  };
});
