"use strict";

const fs = require("node:fs");
const path = require("node:path");
const admin = require("firebase-admin");

const COLLECTIONS = {
  USERS: "usuarios",
  TENANTS: "tenants",
};

const ACTIVE_STATUSES = new Set(["active"]);
const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, "..", "..", "docs", "migraciones");

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const options = {
    apply: false,
    output: "",
    projectId: "",
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || "").trim();
    if (!arg) continue;

    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.apply = false;
      continue;
    }
    if (arg === "--output" || arg === "-o") {
      options.output = String(args[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg.startsWith("--output=")) {
      options.output = String(arg.slice("--output=".length) || "").trim();
      continue;
    }
    if (arg === "--project") {
      options.projectId = String(args[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg.startsWith("--project=")) {
      options.projectId = String(arg.slice("--project=".length) || "").trim();
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsageAndExit(0);
    }

    console.error(`Argumento no soportado: ${arg}`);
    printUsageAndExit(1);
  }

  if (!options.output) {
    const suffix = new Date()
      .toISOString()
      .replace(/[:.]/g, "-");
    const mode = options.apply ? "apply" : "dry-run";
    options.output = path.join(
      DEFAULT_OUTPUT_DIR,
      `migracion_billing_access_onboarding_${mode}_${suffix}.json`
    );
  } else {
    options.output = path.resolve(process.cwd(), options.output);
  }

  if (options.projectId) {
    process.env.GCLOUD_PROJECT = options.projectId;
  }

  return options;
}

function printUsageAndExit(code) {
  const lines = [
    "Uso:",
    "  node scripts/migrateBillingAccessOnboarding.js [--dry-run|--apply] [--output <archivo>] [--project <id>]",
    "",
    "Opciones:",
    "  --dry-run     Simula cambios (default).",
    "  --apply       Aplica cambios sobre /usuarios.",
    "  --output      Ruta del JSON de reporte.",
    "  --project     Fuerza projectId (opcional).",
  ];
  const out = code === 0 ? console.log : console.error;
  out(lines.join("\n"));
  process.exit(code);
}

function cleanString(value) {
  return String(value || "").trim();
}

function normalizeBillingStatus(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = cleanString(value).toLowerCase();
  return normalized || null;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getNested(source, pathText) {
  const pathParts = String(pathText || "").split(".");
  let current = source;
  for (const part of pathParts) {
    if (!isObject(current) || !(part in current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function valuesEqual(left, right) {
  if (left === right) {
    return true;
  }
  if (left === null && right === null) {
    return true;
  }
  return false;
}

function addIfChanged(context, fieldPath, desiredValue) {
  const currentValue = getNested(context.original, fieldPath);
  if (!valuesEqual(currentValue, desiredValue)) {
    context.patchData[fieldPath] = desiredValue;
    context.patchPreview[fieldPath] = desiredValue;
  }
}

function markInconsistency(report, item) {
  report.inconsistencies.push(item);
  const current = Number(report.stats.inconsistenciesByType[item.type] || 0);
  report.stats.inconsistenciesByType[item.type] = current + 1;
}

function getTenantMissingFields(tenantId, tenantData) {
  const missing = [];
  const ownerUid = cleanString(tenantData?.ownerUid);
  const planCode = cleanString(tenantData?.planCode);
  const status = cleanString(tenantData?.status);
  const distrito = cleanString(tenantData?.distrito);
  const nivel = cleanString(tenantData?.nivel);
  const escuela = cleanString(tenantData?.escuela);
  const tenantFieldId = cleanString(tenantData?.tenantId);

  if (!ownerUid) missing.push("ownerUid");
  if (!planCode) missing.push("planCode");
  if (!status) missing.push("status");
  if (!distrito) missing.push("distrito");
  if (!nivel) missing.push("nivel");
  if (!escuela) missing.push("escuela");
  if (!tenantFieldId || tenantFieldId !== tenantId) missing.push("tenantId");
  if (!tenantData?.createdAt) missing.push("createdAt");
  if (!tenantData?.updatedAt) missing.push("updatedAt");

  return missing;
}

function isBillingActiveWithoutTenant(userData, tenantId) {
  const status = normalizeBillingStatus(userData?.billing?.status);
  const appEnabled = userData?.access?.appEnabled === true;
  const activeByStatus = status && ACTIVE_STATUSES.has(status);
  return (!tenantId) && Boolean(activeByStatus || appEnabled);
}

function buildUserPatch(userData, tenantId) {
  const context = {
    original: userData,
    patchData: {},
    patchPreview: {},
  };

  const hasTenant = Boolean(tenantId);
  const currentStatus = normalizeBillingStatus(userData?.billing?.status);
  const currentPlanCode = cleanString(userData?.billing?.planCode) || null;
  const lastAttemptId = cleanString(userData?.billing?.lastAttemptId) || null;
  const mpPreapprovalId = cleanString(userData?.billing?.mpPreapprovalId) || null;
  const existingCheckoutStarted = userData?.onboarding?.checkoutStarted;
  const existingSubscriptionActivated = userData?.onboarding?.subscriptionActivated;
  const existingTenantProvisioned = userData?.onboarding?.tenantProvisioned;

  addIfChanged(context, "onboarding.accountCreated", true);
  addIfChanged(context, "billing.planCode", currentPlanCode || (hasTenant ? "plan_pro" : null));
  addIfChanged(context, "billing.lastAttemptId", lastAttemptId);
  addIfChanged(context, "billing.mpPreapprovalId", mpPreapprovalId);

  if (hasTenant) {
    addIfChanged(context, "billing.status", currentStatus || "active");
    addIfChanged(context, "access.appEnabled", true);
    addIfChanged(context, "access.reason", "active_subscription");
    addIfChanged(context, "onboarding.checkoutStarted", true);
    addIfChanged(context, "onboarding.subscriptionActivated", true);
    addIfChanged(context, "onboarding.tenantProvisioned", true);
  } else {
    addIfChanged(context, "tenantId", null);
    addIfChanged(context, "billing.status", currentStatus);
    addIfChanged(context, "access.appEnabled", false);
    addIfChanged(
      context,
      "access.reason",
      cleanString(userData?.access?.reason) || "payment_required"
    );

    const checkoutStartedDefault = Boolean(currentStatus);
    addIfChanged(
      context,
      "onboarding.checkoutStarted",
      typeof existingCheckoutStarted === "boolean"
        ? existingCheckoutStarted
        : checkoutStartedDefault
    );
    addIfChanged(
      context,
      "onboarding.subscriptionActivated",
      typeof existingSubscriptionActivated === "boolean"
        ? existingSubscriptionActivated
        : false
    );
    addIfChanged(
      context,
      "onboarding.tenantProvisioned",
      typeof existingTenantProvisioned === "boolean"
        ? existingTenantProvisioned
        : false
    );
  }

  if (Object.keys(context.patchData).length > 0) {
    context.patchData.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    context.patchPreview.updatedAt = "__SERVER_TIMESTAMP__";
  }

  return context;
}

function ensureOutputDirectory(filePath) {
  const dir = path.dirname(path.resolve(filePath));
  fs.mkdirSync(dir, { recursive: true });
}

async function collectTenants(db, report) {
  const snap = await db.collection(COLLECTIONS.TENANTS).get();
  const tenantsById = new Map();

  report.stats.tenantsScanned = snap.size;

  snap.forEach((tenantDoc) => {
    const tenantId = tenantDoc.id;
    const data = tenantDoc.data() || {};
    const ownerUid = cleanString(data.ownerUid);
    const missingFields = getTenantMissingFields(tenantId, data);

    tenantsById.set(tenantId, {
      id: tenantId,
      ownerUid,
      data,
      missingFields,
    });

    if (!ownerUid) {
      markInconsistency(report, {
        type: "tenant_without_owner_uid",
        tenantId,
        details: {
          ownerUid: data.ownerUid ?? null,
        },
        recommendedAction: "manual_review",
      });
    }

    if (missingFields.length > 0) {
      markInconsistency(report, {
        type: "tenant_without_minimum_data",
        tenantId,
        details: {
          missingFields,
        },
        recommendedAction: "manual_review",
      });
    }
  });

  return tenantsById;
}

async function buildMigrationPlan(db, tenantsById, report) {
  const usersSnap = await db.collection(COLLECTIONS.USERS).get();
  report.stats.usersScanned = usersSnap.size;

  const operations = [];

  usersSnap.forEach((userDoc) => {
    const uid = userDoc.id;
    const data = userDoc.data() || {};
    const tenantId = cleanString(data.tenantId);
    const hasBillingObject = isObject(data.billing);

    if (tenantId && !hasBillingObject) {
      markInconsistency(report, {
        type: "user_with_tenant_without_billing",
        uid,
        tenantId,
        details: {
          hasBillingObject: false,
        },
        recommendedAction: "auto_fill_possible_if_owner_is_clear",
      });
    }

    const activeWithoutTenant = isBillingActiveWithoutTenant(data, tenantId);
    if (activeWithoutTenant) {
      markInconsistency(report, {
        type: "billing_active_without_tenant",
        uid,
        tenantId: null,
        details: {
          billingStatus: normalizeBillingStatus(data?.billing?.status),
          appEnabled: data?.access?.appEnabled === true,
        },
        recommendedAction: "manual_review",
      });
    }

    const ownerValidationReasons = [];
    if (tenantId) {
      const tenant = tenantsById.get(tenantId);
      if (!tenant) {
        ownerValidationReasons.push("tenant_not_found");
      } else if (!tenant.ownerUid) {
        ownerValidationReasons.push("tenant_without_owner_uid");
      } else if (tenant.ownerUid !== uid) {
        ownerValidationReasons.push(`owner_mismatch:${tenant.ownerUid}`);
      }
    }

    const ownerIsClear = ownerValidationReasons.length === 0;
    if (tenantId && !ownerIsClear) {
      markInconsistency(report, {
        type: "user_with_tenant_without_clear_owner",
        uid,
        tenantId,
        details: {
          reasons: ownerValidationReasons,
        },
        recommendedAction: "manual_review",
      });
    }

    const patch = buildUserPatch(data, tenantId);
    if (Object.keys(patch.patchData).length === 0) {
      return;
    }

    const ambiguous = activeWithoutTenant || (tenantId && !ownerIsClear);
    const operation = {
      uid,
      tenantId: tenantId || null,
      mode: tenantId ? "active_tenant" : "base_user",
      ambiguous,
      skipReason: ambiguous
        ? (activeWithoutTenant
          ? "billing_active_without_tenant"
          : "user_with_tenant_without_clear_owner")
        : "",
      patchData: patch.patchData,
      patchPreview: patch.patchPreview,
    };

    report.patchPreview.push({
      uid: operation.uid,
      tenantId: operation.tenantId,
      mode: operation.mode,
      ambiguous: operation.ambiguous,
      skipReason: operation.skipReason || null,
      fields: operation.patchPreview,
    });

    if (ambiguous) {
      report.stats.patchesSkippedAmbiguous += 1;
      return;
    }

    operations.push(operation);
  });

  report.stats.patchesPrepared = operations.length;
  return operations;
}

async function applyPatches(db, operations) {
  const BATCH_LIMIT = 400;
  let applied = 0;
  let batch = db.batch();
  let batchCount = 0;

  for (const op of operations) {
    const userRef = db.collection(COLLECTIONS.USERS).doc(op.uid);
    batch.set(userRef, op.patchData, { merge: true });
    batchCount += 1;
    applied += 1;

    if (batchCount >= BATCH_LIMIT) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  }

  if (batchCount > 0) {
    await batch.commit();
  }

  return applied;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  ensureOutputDirectory(options.output);

  if (!admin.apps.length) {
    admin.initializeApp();
  }
  const db = admin.firestore();
  const projectId = process.env.GCLOUD_PROJECT || admin.app().options.projectId || "";

  const report = {
    generatedAt: new Date().toISOString(),
    projectId,
    mode: options.apply ? "apply" : "dry-run",
    stats: {
      tenantsScanned: 0,
      usersScanned: 0,
      patchesPrepared: 0,
      patchesApplied: 0,
      patchesSkippedAmbiguous: 0,
      inconsistenciesByType: {},
    },
    inconsistencies: [],
    patchPreview: [],
  };

  console.log(`[migracion] Proyecto: ${projectId || "(detectado por credenciales)"}`);
  console.log(`[migracion] Modo: ${report.mode}`);

  const tenantsById = await collectTenants(db, report);
  const operations = await buildMigrationPlan(db, tenantsById, report);

  if (options.apply) {
    report.stats.patchesApplied = await applyPatches(db, operations);
  }

  report.stats.inconsistenciesTotal = report.inconsistencies.length;

  fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`[migracion] Tenants escaneados: ${report.stats.tenantsScanned}`);
  console.log(`[migracion] Usuarios escaneados: ${report.stats.usersScanned}`);
  console.log(`[migracion] Parches preparados: ${report.stats.patchesPrepared}`);
  console.log(`[migracion] Parches ambiguos omitidos: ${report.stats.patchesSkippedAmbiguous}`);
  console.log(`[migracion] Parches aplicados: ${report.stats.patchesApplied}`);
  console.log(`[migracion] Inconsistencias: ${report.stats.inconsistenciesTotal}`);
  console.log(`[migracion] Reporte: ${options.output}`);
}

run().catch((error) => {
  console.error("[migracion] Error fatal:", error?.message || error);
  process.exit(1);
});
