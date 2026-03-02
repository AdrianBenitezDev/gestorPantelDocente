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
    "lunes",
    "martes",
    "miercoles",
    "jueves",
    "viernes",
    "espaciocurricular",
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
  const maxScan = Math.min(rows.length, 4);
  for (let idx = 0; idx < maxScan; idx += 1) {
    if (hasHeaderRow(rows[idx])) {
      return idx;
    }
  }
  return -1;
}

function pickCourseValue(rowObj, values) {
  return normalizeCourse(
    pickField(rowObj, ["curso", "cursos", "division", "seccion", "grado", "anio"]) ||
      values[0] ||
      ""
  );
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

function buildCursoRefs(cupof, modulosTitular, modulosTitularInterino, modulosProvisional) {
  const refs = [];
  const cupofValue = String(cupof || "").trim();
  if (!cupofValue) {
    return refs;
  }
  if (modulosTitular > 0) {
    refs.push({ cupof: cupofValue, situacionRevista: "T" });
  }
  if (modulosTitularInterino > 0) {
    refs.push({ cupof: cupofValue, situacionRevista: "TI" });
  }
  if (modulosProvisional > 0) {
    refs.push({ cupof: cupofValue, situacionRevista: "P" });
  }
  return refs;
}

function mergeCursoRefs(existing, incoming) {
  const map = new Map();
  const all = [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])];
  all.forEach((item) => {
    const cupof = String(item?.cupof || "").trim();
    const situacionRevista = String(item?.situacionRevista || "").trim().toUpperCase();
    if (!cupof || !situacionRevista || !["T", "TI", "P"].includes(situacionRevista)) {
      return;
    }
    map.set(`${cupof}__${situacionRevista}`, { cupof, situacionRevista });
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

exports.loadDocentesFromSheet = onCall(callableOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Auth required");
  }

  const uid = request.auth.uid;
  await getUserTenantId(uid);

  const data = request.data || {};
  const sheetUrl = assertString(data.sheetUrl, "sheetUrl", 20, 500);
  const sheetName = assertString(data.sheetName, "sheetName", 1, 120);
  const selectedCourse = normalizeCourse(assertString(data.course, "course", 1, 30));
  const sheetId = parseSheetId(sheetUrl);

  if (!sheetId) {
    throw new HttpsError("invalid-argument", "Invalid Google Sheets URL");
  }

  const endpoint =
    `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  logger.info("loadDocentesFromSheet: start", {
    uid,
    sheetId,
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

  const headerRowIndex = findHeaderRowIndex(rows);
  const hasHeaders = headerRowIndex >= 0;
  const headers = hasHeaders ? rows[headerRowIndex].map((header) => normalizeHeader(header)) : [];
  const dataRows = hasHeaders ? rows.slice(headerRowIndex + 1) : rows;
  logger.info("loadDocentesFromSheet: headers analysis", {
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

  const docentes = dataRows
    .flatMap((values) => {
      const rowObj = {};
      if (hasHeaders) {
        headers.forEach((header, idx) => {
          rowObj[header] = String(values[idx] || "").trim();
        });
      }

      const detectedCourse = pickCourseValue(rowObj, values);
      if (detectedCourse) {
        detectedCoursesSet.add(detectedCourse);
      }
      if (detectedCourse !== selectedCourse) {
        rejectionStats.byCourse += 1;
        return [];
      }

      const pid = pickField(rowObj, ["pid", "legajo", "id"]) || String(values[10] || "").trim();
      const espacioCurricular =
        pickField(rowObj, ["espaciocurricular", "materia"]) || String(values[11] || "").trim();
      const cupof = pickField(rowObj, ["cupof"]) || String(values[12] || "").trim();
      const turno = pickField(rowObj, ["turno"]) || String(values[18] || "").trim();
      const modulosTitular = parseModuleCount(pickField(rowObj, ["t"]) || values[15]);
      const modulosTitularInterino = parseModuleCount(pickField(rowObj, ["ti"]) || values[16]);
      const modulosProvisional = parseModuleCount(pickField(rowObj, ["p"]) || values[17]);
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

      const titularFullName =
        pickField(rowObj, ["apellidoynombre", "docente", "nombreatellido"]) ||
        pickFieldContaining(rowObj, ["apellidoynombre", "docente"]) ||
        (hasHeaders ? "" : String(values[13] || "").trim());
      const titularParsed = parseFullName(titularFullName);
      const titularCuil =
        pickField(rowObj, ["cuiltitular", "cuil", "dni", "documento"]) || "";
      const fechaNacimiento = pickField(rowObj, [
        "fechanacimiento",
        "fecha_nacimiento",
        "nacimiento",
      ]) || "";

      const suplenteParsed = parseFullName(
        pickField(rowObj, ["suplente"]) || String(values[6] || "").trim()
      );
      const suplente2Parsed = parseFullName(
        pickField(rowObj, ["suplente2"]) || String(values[8] || "").trim()
      );

      const docenteVariants = [
        {
          tipo: "titular",
          apellido: titularParsed.apellido,
          nombre: titularParsed.nombre,
          cuil: titularCuil,
          telefono: pickField(rowObj, ["telefonotitular"]) || String(values[19] || "").trim(),
          correo: pickField(rowObj, ["correoabctitular"]) || String(values[20] || "").trim(),
          domicilio: pickField(rowObj, ["domiciliotitular"]) || String(values[21] || "").trim(),
        },
        {
          tipo: "suplente",
          apellido: suplenteParsed.apellido,
          nombre: suplenteParsed.nombre,
          cuil: pickField(rowObj, ["cuilsuplente"]) || String(values[7] || "").trim(),
          telefono: pickField(rowObj, ["telefonosuplente"]) || String(values[22] || "").trim(),
          correo: pickField(rowObj, ["correoabcsuplente"]) || String(values[23] || "").trim(),
          domicilio: pickField(rowObj, ["domiciliosuplente"]) || String(values[24] || "").trim(),
        },
        {
          tipo: "suplente2",
          apellido: suplente2Parsed.apellido,
          nombre: suplente2Parsed.nombre,
          cuil: pickField(rowObj, ["cuilsuplente2"]) || String(values[9] || "").trim(),
          telefono: pickField(rowObj, ["telefonosuplente2"]) || String(values[25] || "").trim(),
          correo: pickField(rowObj, ["correoabcsuplente2"]) || String(values[26] || "").trim(),
          domicilio: pickField(rowObj, ["domiciliosuplente2"]) || String(values[27] || "").trim(),
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
            cursoRefs: buildCursoRefs(
              cupof,
              modulosTitular,
              modulosTitularInterino,
              modulosProvisional
            ),
            telefono: variant.telefono,
            correo: variant.correo,
            domicilio: variant.domicilio,
          };
        })
        .filter(Boolean);
    })
    .filter(Boolean)
    .slice(0, 500);

  const detectedCourses = Array.from(detectedCoursesSet).slice(0, 20);
  logger.info("loadDocentesFromSheet: result summary", {
    selectedCourse,
    detectedCourses,
    totalDocentes: docentes.length,
    rejectionStats,
  });

  return {
    ok: true,
    course: selectedCourse,
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
  const cuil = String(docente.cuil || "").trim();
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
    modulosProvisional
  );
  const incomingCursoRefs = cursosFromPayload.length ? cursosFromPayload : fallbackCursoRefs;

  if (!cuil && !pid && !nombre && !apellido) {
    throw new HttpsError("invalid-argument", "Docente without identity");
  }

  const createdAt = admin.firestore.FieldValue.serverTimestamp();
  const key = buildDocenteKey({
    cuil,
    apellido,
    nombre,
    pid,
    keyHint: docente.keyHint,
  });
  const docenteRef = db.collection("tenants").doc(tenantId).collection("docentes").doc(key);
  const docenteSnap = await docenteRef.get();
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
