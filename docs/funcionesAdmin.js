"use strict";

/**
 * Resumen de la respuesta:
 * - billing.status = "active" no alcanza por si solo.
 * - Para habilitar ingreso, la app exige:
 *   - access.appEnabled = true
 *   - tenantId con valor (no vacio)
 * - Campos recomendados en usuarios/{uid}:
 *   - billing.status: "active"
 *   - billing.planCode: "plan_pro"
 *   - access.appEnabled: true
 *   - access.reason: "active_subscription"
 *   - onboarding.subscriptionActivated: true
 *   - onboarding.tenantProvisioned: true
 *   - tenantId: "<tenantId>"
 *
 * Este archivo usa Firebase Admin para aplicar esos cambios automaticamente.
 */

const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const now = admin.firestore.FieldValue.serverTimestamp();

/**
 * Habilita acceso de un usuario a partir de un tenantId.
 * Busca ownerUid en tenants/{tenantId} y habilita usuarios/{ownerUid}.
 *
 * @param {string} tenantId
 * @returns {Promise<{ok: boolean, tenantId: string, uid: string}>}
 */
async function habiitarUsuaio(tenantId) {
  const safeTenantId = String(tenantId || "").trim();
  if (!safeTenantId) {
    throw new Error("tenantId es obligatorio");
  }

  const tenantRef = db.collection("tenants").doc(safeTenantId);
  const tenantSnap = await tenantRef.get();
  if (!tenantSnap.exists) {
    throw new Error(`No existe tenants/${safeTenantId}`);
  }

  const tenantData = tenantSnap.data() || {};
  const uid = String(tenantData.ownerUid || "").trim();
  if (!uid) {
    throw new Error(`tenants/${safeTenantId} no tiene ownerUid`);
  }

  const planCode = String(tenantData.planCode || "plan_pro").trim() || "plan_pro";
  const userRef = db.collection("usuarios").doc(uid);

  const batch = db.batch();

  // Garantiza estado activo en tenant.
  batch.set(
    tenantRef,
    {
      tenantId: safeTenantId,
      ownerUid: uid,
      planCode,
      status: "active",
      updatedAt: now,
    },
    { merge: true }
  );

  // Habilita usuario para pasar validaciones de suscripcion/gating.
  batch.set(
    userRef,
    {
      tenantId: safeTenantId,
      "billing.status": "active",
      "billing.planCode": planCode,
      "billing.updatedAt": now,
      "access.appEnabled": true,
      "access.reason": "active_subscription",
      "access.enabledAt": now,
      "onboarding.subscriptionActivated": true,
      "onboarding.tenantProvisioned": true,
      "onboarding.tenantProvisionedAt": now,
      updatedAt: now,
    },
    { merge: true }
  );

  // Estructura minima para evitar errores iniciales al ingresar al modulo.
  batch.set(
    tenantRef.collection("configuraciones").doc("turnosAndHorarios"),
    {
      tenantId: safeTenantId,
      turns: {},
      updatedAt: now,
      createdAt: now,
    },
    { merge: true }
  );
  batch.set(
    tenantRef.collection("configuraciones").doc("pacExtraccion"),
    {
      tenantId: safeTenantId,
      processValue: "0",
      gmailQuery: "",
      useCustomSheet: false,
      customSheetUrl: "https://docs.google.com/spreadsheets/d/1UP0FlTWQdHciMe1dbpj2i1dhsQAk4EsxCtq2Bvxlv2U/edit?usp=sharing",
      customSheetName: "POFA",
      startRow: 2,
      updatedAt: now,
      createdAt: now,
    },
    { merge: true }
  );
  batch.set(
    tenantRef.collection("configuraciones").doc("encabezadoPac"),
    {
      tenantId: safeTenantId,
      establecimientoReparticion: "",
      anexo: "",
      domicilioEscuela: "",
      telefono: "",
      email: "",
      categoria: "",
      turno: "",
      desfavorable: "",
      distrito: "",
      tipoOrganizacion: "",
      escuela: "",
      anio: String(new Date().getFullYear()),
      desde: "",
      hasta: "",
      updatedAt: now,
      createdAt: now,
    },
    { merge: true }
  );
  batch.set(
    tenantRef.collection("botones").doc("config"),
    {
      tenantId: safeTenantId,
      turnos: {},
      updatedAt: now,
      createdAt: now,
    },
    { merge: true }
  );

  await batch.commit();

  return {
    ok: true,
    tenantId: safeTenantId,
    uid,
  };
}

module.exports = {
  habiitarUsuaio,
};

// Uso rapido por consola:
// node docs/funcionesAdmin.js <tenantId>
if (require.main === module) {
  const tenantId = process.argv[2];
  habiitarUsuaio(tenantId)
    .then((result) => {
      // eslint-disable-next-line no-console
      console.log("Usuario habilitado:", result);
      process.exit(0);
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error("Error:", error.message || error);
      process.exit(1);
    });
}
