const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onTaskDispatched } = require("firebase-functions/v2/tasks");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { getFunctions } = require("firebase-admin/functions");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { fetchFechaNacimientoByDni, UNKNOWN_BIRTHDATE } = require("./pacNacimientoLookup");
const {
  mapMercadoPagoStatusToBillingStatus,
  normalizeBillingStatus,
  resolveNextRouteForProfile,
} = require("./subscriptionDomain");

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const allowedCorsOrigins = [
  "https://paneldocente.com.ar",
  "https://www.paneldocente.com.ar",
  "https://horario-escuelas.web.app",
];
const primaryAppOrigin = allowedCorsOrigins[0] || "https://paneldocente.com.ar";
const callableOptions = { cors: allowedCorsOrigins, invoker: "public" };
const savePacRowsCallableOptions = { ...callableOptions, timeoutSeconds: 300 };
const GOOGLE_TEST_BYPASS_EMAILS = new Set([
  "ellariatyrell.341412@gmail.com",
  "eurontyrell.571112@gmail.com",
  "cens452altebrown@abc.gob.ar",
]);
const ADMIN_ALLOWED_EMAIL = "artbenitezdev@gmail.com";
const GOOGLE_TEST_BYPASS_TAG = "google_test_allowlist";
const GOOGLE_TEST_BYPASS_EMAILS_CANONICAL = new Set(
  Array.from(GOOGLE_TEST_BYPASS_EMAILS).map((email) => normalizeEmailForAllowlist(email))
);

const MP_ACCESS_TOKEN = defineSecret("MP_ACCESS_TOKEN");
const MP_WEBHOOK_SECRET = defineSecret("MP_WEBHOOK_SECRET");
const MP_PUBLIC_KEY = defineSecret("MP_PUBLIC_KEY");
const MP_WEBHOOK_TASK_QUEUE_NAME = "processMercadoPagoWebhookTask";
const DEFAULT_FUNCTION_REGION = "us-central1";
const DEFAULT_PROJECT_ID = "horario-escuelas";
const PAC_FORWARD_DESTINATION_EMAIL = "procesarpac@paneldocente.com.ar";
const PAC_PROCESSED_DEFAULT_LIMIT = 40;
const PAC_PROCESSED_MAX_LIMIT = 120;
const PAC_PROCESSED_MAX_ROWS_PER_ITEM = 1200;
const PAC_PROCESSED_LIST_ROWS_DEFAULT_LIMIT = 300;
const PAC_PROCESSED_LIST_ROWS_MAX_LIMIT = 1200;
const PAC_LOCAL_TEMPLATE_RELATIVE_PATH = path.join("..", "assets", "plantilla.xlsx");
const PAC_LOCAL_TEMPLATE_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
let pacLocalTemplateBufferCache = null;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeEmailForAllowlist(value) {
  const normalized = normalizeEmail(value);
  const [rawLocal = "", rawDomain = ""] = normalized.split("@");
  const local = String(rawLocal || "").trim();
  const domain = String(rawDomain || "").trim();
  if (!local || !domain) {
    return normalized;
  }
  if (domain === "gmail.com" || domain === "googlemail.com") {
    const canonicalLocal = local.split("+")[0].replace(/\./g, "");
    return `${canonicalLocal}@gmail.com`;
  }
  return normalized;
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function buildMercadoPagoWebhookNotificationUrl() {
  const projectId = String(process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || DEFAULT_PROJECT_ID).trim() ||
    DEFAULT_PROJECT_ID;
  const region = String(process.env.FUNCTION_REGION || DEFAULT_FUNCTION_REGION).trim() ||
    DEFAULT_FUNCTION_REGION;
  const baseUrl = `https://${region}-${projectId}.cloudfunctions.net/mercadoPagoWebhook`;
  const url = new URL(baseUrl);
  // Fuerza el canal Webhooks y evita depender del flujo IPN legacy.
  url.searchParams.set("source_news", "webhooks");
  return url.toString();
}

function normalizeCourse(value) {
  return String(value || "").trim().toUpperCase();
}

function buildTenantId() {
  return `tenant_${db.collection("tenants").doc().id}`;
}

function buildPlanProDefaults(mpPreapprovalPlanId = "") {
  return {
    code: "plan_pro",
    title: "Plan Pro",
    amount: 3000,
    currency: "ARS",
    frequency: 1,
    frequencyType: "months",
    active: true,
    mpPreapprovalPlanId: String(mpPreapprovalPlanId || "").trim(),
  };
}

async function ensurePlanProSupport() {
  const planRef = db.collection("billingPlans").doc("plan_pro");
  const planSnap = await planRef.get();
  const existing = planSnap.exists ? (planSnap.data() || {}) : {};
  const defaults = buildPlanProDefaults(existing.mpPreapprovalPlanId);
  const now = admin.firestore.FieldValue.serverTimestamp();

  if (!planSnap.exists) {
    await planRef.set({
      ...defaults,
      createdAt: now,
      updatedAt: now,
    });
    return { ...defaults, created: true };
  }

  await planRef.set(
    {
      ...defaults,
      updatedAt: now,
    },
    { merge: true }
  );
  return { ...defaults, created: false };
}

function normalizePlanCode(value) {
  return String(value || "").trim().toLowerCase();
}

function shortText(value, maxLength = 280) {
  return String(value || "").trim().slice(0, Math.max(0, Number(maxLength) || 0));
}

function timestampToMillis(value) {
  if (value && typeof value.toMillis === "function") {
    try {
      return value.toMillis();
    } catch (_error) {
      return null;
    }
  }
  return null;
}

function assertAdminAccess(request) {
  if (!request?.auth) {
    throw new HttpsError("unauthenticated", "Auth required");
  }
  const uid = String(request.auth.uid || "").trim();
  const authEmail = normalizeEmail(request.auth.token?.email || "");
  if (authEmail !== ADMIN_ALLOWED_EMAIL) {
    logger.warn("admin access denied", {
      uid,
      email: authEmail || null,
    });
    throw new HttpsError("permission-denied", "Admin access denied", {
      code: "admin_forbidden",
    });
  }
  return { uid, authEmail };
}

const METRIC_EVENT_COUNTER_FIELD_BY_TYPE = Object.freeze({
  inicio_sesion: "iniciosSesion",
  pac_realizado: "pacRealizados",
  pac_descargado: "pacDescargados",
  pac_guardado_drive: "pacGuardadosDrive",
});

function sanitizeMetricMetadataValue(value) {
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    return shortText(value, 600);
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 30)
      .map((item) => shortText(item, 140))
      .filter(Boolean);
  }
  return shortText(JSON.stringify(value), 1200);
}

function sanitizeMetricMetadata(rawMetadata) {
  const source = rawMetadata && typeof rawMetadata === "object" ? rawMetadata : {};
  const metadata = {};
  Object.entries(source).forEach(([rawKey, rawValue]) => {
    const key = shortText(rawKey, 80);
    if (!key) {
      return;
    }
    const safeValue = sanitizeMetricMetadataValue(rawValue);
    if (safeValue === undefined) {
      return;
    }
    metadata[key] = safeValue;
  });
  return metadata;
}

function resolveMetricCounterField(eventType) {
  const safeType = shortText(eventType, 80).toLowerCase();
  return METRIC_EVENT_COUNTER_FIELD_BY_TYPE[safeType] || "";
}

async function resolveTenantIdForMetrics(uid) {
  const safeUid = String(uid || "").trim();
  if (!safeUid) {
    return "";
  }
  try {
    const userSnap = await db.collection("usuarios").doc(safeUid).get();
    if (!userSnap.exists) {
      return "";
    }
    const userData = userSnap.data() || {};
    const tenantId = profileTenantId(userData);
    const appEnabled = profileAccessAppEnabled(userData);
    if (!tenantId || !appEnabled) {
      return "";
    }
    return tenantId;
  } catch (error) {
    logger.warn("resolveTenantIdForMetrics failed", {
      uid: safeUid,
      message: shortText(error?.message || "unknown_error", 280),
    });
    return "";
  }
}

async function registerTenantMetricEvent({
  tenantId,
  uid = "",
  email = "",
  eventType = "",
  source = "",
  metadata = {},
} = {}) {
  const safeTenantId = String(tenantId || "").trim();
  const safeEventType = shortText(eventType, 80).toLowerCase();
  if (!safeTenantId || !safeEventType) {
    return "";
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const eventRef = db.collection("tenants").doc(safeTenantId).collection("metricasEventos").doc();
  const summaryRef = db.collection("tenants").doc(safeTenantId).collection("metricasResumen").doc("general");
  const counterField = resolveMetricCounterField(safeEventType);
  const safeMetadata = sanitizeMetricMetadata(metadata);

  const batch = db.batch();
  batch.set(eventRef, {
    eventId: eventRef.id,
    tenantId: safeTenantId,
    uid: shortText(uid, 120),
    email: normalizeEmail(email),
    eventType: safeEventType,
    source: shortText(source, 80) || "web",
    metadata: safeMetadata,
    createdAt: now,
  });

  const summaryPayload = {
    tenantId: safeTenantId,
    lastEventAt: now,
    lastEventType: safeEventType,
    updatedAt: now,
    createdAt: now,
  };
  if (counterField) {
    summaryPayload[counterField] = admin.firestore.FieldValue.increment(1);
  }
  batch.set(summaryRef, summaryPayload, { merge: true });
  await batch.commit();

  return eventRef.id;
}

function isGoogleTestBypassEmail(value) {
  const normalized = normalizeEmailForAllowlist(value);
  if (!normalized) {
    return false;
  }
  return GOOGLE_TEST_BYPASS_EMAILS_CANONICAL.has(normalized);
}

function hasOwn(source, key) {
  return Boolean(source && Object.prototype.hasOwnProperty.call(source, key));
}

function readProfileValue(profile, mapKey, fieldKey) {
  if (!profile || typeof profile !== "object") {
    return undefined;
  }
  const mapValue = profile[mapKey];
  if (mapValue && typeof mapValue === "object" && hasOwn(mapValue, fieldKey)) {
    return mapValue[fieldKey];
  }
  const dottedKey = `${mapKey}.${fieldKey}`;
  if (hasOwn(profile, dottedKey)) {
    return profile[dottedKey];
  }
  return undefined;
}

function profileTenantId(profile) {
  if (!profile || typeof profile !== "object") {
    return "";
  }
  return String(profile.tenantId || "").trim();
}

function profileAccessAppEnabled(profile) {
  return readProfileValue(profile, "access", "appEnabled") === true;
}

function profileAccessReason(profile, fallback = "payment_required") {
  const raw = readProfileValue(profile, "access", "reason");
  return String(raw || fallback).trim() || fallback;
}

function profileAccessEnabledAt(profile) {
  return readProfileValue(profile, "access", "enabledAt") || null;
}

function profileBillingStatusRaw(profile) {
  const raw = readProfileValue(profile, "billing", "status");
  return raw === undefined ? null : raw;
}

function profileBillingPlanCode(profile) {
  const raw = readProfileValue(profile, "billing", "planCode");
  return raw || null;
}

function profileBillingLastAttemptId(profile) {
  const raw = readProfileValue(profile, "billing", "lastAttemptId");
  return raw || null;
}

function profileBillingMpPreapprovalId(profile) {
  return String(readProfileValue(profile, "billing", "mpPreapprovalId") || "").trim();
}

function profileBillingActivatedAt(profile) {
  return readProfileValue(profile, "billing", "activatedAt") || null;
}

function profileOnboardingFlag(profile, key) {
  return readProfileValue(profile, "onboarding", key) === true;
}

function profileOnboardingTenantProvisionedAt(profile) {
  return readProfileValue(profile, "onboarding", "tenantProvisionedAt") || null;
}

function hasNestedProfileMap(profile, key) {
  if (!profile || typeof profile !== "object") {
    return false;
  }
  return Boolean(profile[key] && typeof profile[key] === "object" && !Array.isArray(profile[key]));
}

async function resolveAuthIdentityForBypass(uid) {
  const safeUid = String(uid || "").trim();
  if (!safeUid) {
    return { email: "", displayName: "", emailVerified: false };
  }
  try {
    const userRecord = await admin.auth().getUser(safeUid);
    return {
      email: normalizeEmail(userRecord.email || ""),
      displayName: shortText(userRecord.displayName || "", 120),
      emailVerified: userRecord.emailVerified === true,
    };
  } catch (error) {
    logger.warn("google test bypass auth lookup failed", {
      uid: safeUid,
      message: shortText(error?.message || "auth_lookup_failed", 280),
    });
    return { email: "", displayName: "", emailVerified: false };
  }
}

async function ensureGoogleTestBypassAccess({
  uid,
  authToken = {},
  existingProfile = null,
  forceAuthLookup = false,
} = {}) {
  const safeUid = String(uid || "").trim();
  if (!safeUid) {
    return { applied: false, reason: "missing_uid" };
  }

  const userRef = db.collection("usuarios").doc(safeUid);
  let profile = existingProfile && typeof existingProfile === "object" ? existingProfile : null;
  if (!profile) {
    const profileSnap = await userRef.get();
    profile = profileSnap.exists ? (profileSnap.data() || {}) : null;
  }
  const userData = profile && typeof profile === "object" ? profile : {};

  const tokenEmail = normalizeEmailForAllowlist(authToken?.email || "");
  const profileEmail = normalizeEmailForAllowlist(userData?.correo || "");
  let bypassEmail = [tokenEmail, profileEmail].find((candidate) => isGoogleTestBypassEmail(candidate)) || "";
  let authIdentity = null;

  if (!bypassEmail && (forceAuthLookup || (!tokenEmail && !profileEmail))) {
    authIdentity = await resolveAuthIdentityForBypass(safeUid);
    if (isGoogleTestBypassEmail(authIdentity.email)) {
      bypassEmail = authIdentity.email;
    }
  }

  if (!bypassEmail) {
    return { applied: false, reason: "email_not_allowlisted" };
  }

  const tenantId = profileTenantId(userData);
  const appEnabled = profileAccessAppEnabled(userData);
  const billingStatus = normalizeBillingStatus(profileBillingStatusRaw(userData));
  const hasNestedAccess = hasNestedProfileMap(userData, "access");
  const hasNestedBilling = hasNestedProfileMap(userData, "billing");
  const hasNestedOnboarding = hasNestedProfileMap(userData, "onboarding");
  const hasNestedTesting = hasNestedProfileMap(userData, "testing");
  if (tenantId && appEnabled && billingStatus === "active" && hasNestedAccess && hasNestedBilling && hasNestedOnboarding && hasNestedTesting) {
    return {
      applied: true,
      bypassTag: GOOGLE_TEST_BYPASS_TAG,
      email: bypassEmail,
      tenantId,
      alreadyActive: true,
    };
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const seedFromEmail = shortText(String(bypassEmail.split("@")[0] || ""), 40);
  const normalizedSeed = normalizeUsername(
    String(userData?.usuario || userData?.usuarioKey || seedFromEmail || `google_test_${safeUid.slice(0, 8)}`)
  ).slice(0, 40);
  const usuarioValue = normalizedSeed.length >= 3 ? normalizedSeed : `gt_${safeUid.slice(0, 6)}`;
  const displayName = shortText(
    String(
      userData?.nombre ||
      authToken?.name ||
      authIdentity?.displayName ||
      seedFromEmail ||
      "Google Test User"
    ),
    120
  );

  await userRef.set(
    {
      uid: safeUid,
      nombre: displayName,
      contacto: String(userData?.contacto || "").trim(),
      correo: bypassEmail,
      correoAlt: String(userData?.correoAlt || "").trim(),
      distrito: String(userData?.distrito || "").trim(),
      nivel: String(userData?.nivel || "").trim(),
      escuela: String(userData?.escuela || "").trim(),
      usuario: usuarioValue,
      usuarioKey: normalizeUsername(String(userData?.usuarioKey || usuarioValue || "")).slice(0, 40),
      verificado: userData?.verificado === true || authToken?.email_verified === true || authIdentity?.emailVerified === true,
      rol: String(userData?.rol || "").trim() || "admin_escuela",
      billing: {
        planCode: String(profileBillingPlanCode(userData) || "plan_pro").trim() || "plan_pro",
        status: profileBillingStatusRaw(userData),
        lastAttemptId: profileBillingLastAttemptId(userData),
        mpPreapprovalId: profileBillingMpPreapprovalId(userData) || null,
        activatedAt: profileBillingActivatedAt(userData) || null,
      },
      access: {
        appEnabled,
        reason: profileAccessReason(userData),
        enabledAt: profileAccessEnabledAt(userData) || null,
      },
      onboarding: {
        accountCreated: true,
        checkoutStarted: profileOnboardingFlag(userData, "checkoutStarted"),
        subscriptionActivated: profileOnboardingFlag(userData, "subscriptionActivated"),
        tenantProvisioned: profileOnboardingFlag(userData, "tenantProvisioned"),
        tenantProvisionedAt: profileOnboardingTenantProvisionedAt(userData) || null,
      },
      testing: {
        googleBypassEnabled: true,
        googleBypassTag: GOOGLE_TEST_BYPASS_TAG,
        googleBypassEmail: bypassEmail,
        googleBypassUpdatedAt: now,
      },
      createdAt: userData?.createdAt || now,
      updatedAt: now,
    },
    { merge: true }
  );

  await ensureBillingActivation(safeUid, {
    id: `google_test_bypass_${safeUid}`,
    payer_email: bypassEmail,
    preapproval_plan_id: "google_test_bypass_plan_pro",
  });

  await userRef.set(
    {
      billing: {
        planCode: "plan_pro",
        bypassEnabled: true,
        bypassTag: GOOGLE_TEST_BYPASS_TAG,
        bypassUpdatedAt: now,
      },
      access: {
        reason: "active_subscription",
      },
      testing: {
        googleBypassEnabled: true,
        googleBypassTag: GOOGLE_TEST_BYPASS_TAG,
        googleBypassEmail: bypassEmail,
        googleBypassUpdatedAt: now,
      },
      updatedAt: now,
    },
    { merge: true }
  );

  const refreshedSnap = await userRef.get();
  const refreshed = refreshedSnap.exists ? (refreshedSnap.data() || {}) : {};
  logger.info("google test bypass access applied", {
    uid: safeUid,
    email: bypassEmail,
    tenantId: String(refreshed?.tenantId || "").trim() || null,
  });

  return {
    applied: true,
    bypassTag: GOOGLE_TEST_BYPASS_TAG,
    email: bypassEmail,
    tenantId: String(refreshed?.tenantId || "").trim(),
    alreadyActive: false,
    profile: refreshed,
  };
}

async function createMercadoPagoPreapproval({
  accessToken,
  planCode,
  plan,
  payerEmail,
  externalReference,
}) {
  const safeAccessToken = String(accessToken || "").trim();
  if (!safeAccessToken) {
    throw new HttpsError("failed-precondition", "Mercado Pago access token is not configured");
  }

  const safePlan = plan && typeof plan === "object" ? plan : {};
  const safePayerEmail = normalizeEmail(payerEmail);
  const safePlanCode = normalizePlanCode(planCode || safePlan.code || "plan_pro");
  const safeExternalReference = shortText(externalReference, 120);
  const preapprovalPlanId = shortText(safePlan.mpPreapprovalPlanId, 120);
  const notificationUrl = shortText(buildMercadoPagoWebhookNotificationUrl(), 500);

  const payload = {
    reason: shortText("suscripci\u00f3n a paneldocente.com.ar", 120),
    payer_email: safePayerEmail,
    external_reference: safeExternalReference,
    status: "pending",
    back_url: `${primaryAppOrigin}/estado-suscripcion.html`,
    notification_url: notificationUrl,
  };

  if (preapprovalPlanId) {
    payload.preapproval_plan_id = preapprovalPlanId;
  } else {
    payload.auto_recurring = {
      frequency: Number(safePlan.frequency || 1),
      frequency_type: String(safePlan.frequencyType || "months"),
      transaction_amount: Number(safePlan.amount || 3000),
      currency_id: String(safePlan.currency || "ARS"),
    };
  }

  const response = await fetch("https://api.mercadopago.com/preapproval", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${safeAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const rawBody = await response.text();
  let parsedBody = {};
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : {};
  } catch (_error) {
    parsedBody = { rawBody: shortText(rawBody, 1200) };
  }

  if (!response.ok) {
    logger.error("startSubscriptionCheckout Mercado Pago preapproval failed", {
      status: response.status,
      statusText: response.statusText,
      planCode: safePlanCode,
      externalReference: safeExternalReference,
      response: parsedBody,
    });
    throw new HttpsError(
      "failed-precondition",
      "No se pudo iniciar el checkout de Mercado Pago",
      {
        code: "mercadopago_preapproval_failed",
        httpStatus: response.status,
      }
    );
  }

  const mpPreapprovalId = shortText(parsedBody?.id, 120);
  const initPoint = String(parsedBody?.init_point || parsedBody?.sandbox_init_point || "").trim();
  if (!mpPreapprovalId || !initPoint) {
    logger.error("startSubscriptionCheckout Mercado Pago response incomplete", {
      planCode: safePlanCode,
      externalReference: safeExternalReference,
      response: parsedBody,
    });
    throw new HttpsError("internal", "Respuesta incompleta de Mercado Pago al iniciar checkout");
  }

  return {
    mpPreapprovalId,
    initPoint,
    notificationUrl,
    raw: parsedBody,
  };
}

function safeObject(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value;
}

function parseMercadoPagoSignatureHeader(signatureHeader) {
  const parsed = {};
  String(signatureHeader || "")
    .split(",")
    .forEach((item) => {
      const [key, ...rest] = String(item || "").split("=");
      const cleanKey = String(key || "").trim().toLowerCase();
      const cleanValue = String(rest.join("=") || "").trim();
      if (cleanKey) {
        parsed[cleanKey] = cleanValue;
      }
    });
  return parsed;
}

function safeHexToBuffer(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[^a-f0-9]/g, "");
  if (!normalized || normalized.length % 2 !== 0) {
    return Buffer.from("");
  }
  return Buffer.from(normalized, "hex");
}

function timingSafeEqualHex(left, right) {
  const a = safeHexToBuffer(left);
  const b = safeHexToBuffer(right);
  if (!a.length || !b.length || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function extractWebhookPreapprovalId(payload = {}, query = {}) {
  const body = safeObject(payload);
  const q = safeObject(query);

  const queryDataId = String(q["data.id"] || q.dataId || "").trim();
  if (queryDataId) {
    return queryDataId;
  }

  const bodyDataId = String(body?.data?.id || "").trim();
  if (bodyDataId) {
    return bodyDataId;
  }

  const bodyId = String(body?.id || "").trim();
  if (bodyId) {
    return bodyId;
  }

  const resourcePath = String(body?.resource || body?.api_version || "").trim();
  const resourceMatch = resourcePath.match(/preapproval\/([a-zA-Z0-9_-]+)/i);
  if (resourceMatch && resourceMatch[1]) {
    return String(resourceMatch[1]).trim();
  }

  return "";
}

function firestoreTimestampToMillis(value) {
  if (!value) {
    return 0;
  }
  if (typeof value?.toMillis === "function") {
    return Number(value.toMillis()) || 0;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  return 0;
}

function validateMercadoPagoWebhookSignature({
  signatureHeader,
  requestId,
  webhookSecret,
  preapprovalId,
}) {
  const secret = String(webhookSecret || "").trim();
  if (!secret) {
    return { valid: false, reason: "missing_webhook_secret" };
  }

  const parsedSignature = parseMercadoPagoSignatureHeader(signatureHeader);
  const ts = String(parsedSignature.ts || "").trim();
  const v1 = String(parsedSignature.v1 || "").trim().toLowerCase();
  const safeRequestId = String(requestId || "").trim();
  const safePreapprovalId = String(preapprovalId || "").trim();

  if (!ts || !v1 || !safeRequestId || !safePreapprovalId) {
    return { valid: false, reason: "signature_fields_missing", ts, v1 };
  }

  const manifest = `id:${safePreapprovalId};request-id:${safeRequestId};ts:${ts};`;
  const expected = crypto.createHmac("sha256", secret).update(manifest).digest("hex").toLowerCase();
  const valid = timingSafeEqualHex(expected, v1);

  return {
    valid,
    reason: valid ? "ok" : "signature_mismatch",
    ts,
    v1,
  };
}

async function enqueueMercadoPagoWebhookTask({ eventRefId, preapprovalId }) {
  const safeEventRefId = String(eventRefId || "").trim();
  if (!safeEventRefId) {
    throw new HttpsError("invalid-argument", "eventRefId is required to enqueue webhook task");
  }

  const queue = getFunctions().taskQueue(MP_WEBHOOK_TASK_QUEUE_NAME);
  await queue.enqueue(
    {
      eventId: safeEventRefId,
      preapprovalId: String(preapprovalId || "").trim() || null,
    },
    {
      dispatchDeadlineSeconds: 300,
    }
  );
}

async function fetchMercadoPagoPreapprovalById(accessToken, preapprovalId) {
  const safeAccessToken = String(accessToken || "").trim();
  const safePreapprovalId = String(preapprovalId || "").trim();
  if (!safeAccessToken || !safePreapprovalId) {
    throw new HttpsError("invalid-argument", "Invalid access token or preapprovalId");
  }

  const response = await fetch(`https://api.mercadopago.com/preapproval/${encodeURIComponent(safePreapprovalId)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${safeAccessToken}`,
      "Content-Type": "application/json",
    },
  });

  const rawBody = await response.text();
  let parsedBody = {};
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : {};
  } catch (_error) {
    parsedBody = { rawBody: shortText(rawBody, 1200) };
  }

  if (!response.ok) {
    throw new HttpsError(
      "failed-precondition",
      "No se pudo consultar el estado de suscripcion en Mercado Pago",
      {
        code: "mercadopago_preapproval_lookup_failed",
        httpStatus: response.status,
      }
    );
  }

  return parsedBody;
}

async function resolvePreapprovalContext(preapprovalId, preapprovalData) {
  const safePreapprovalId = String(preapprovalId || "").trim();
  const externalReference = String(preapprovalData?.external_reference || "").trim();
  const payerEmail = normalizeEmail(preapprovalData?.payer_email || "");

  let uid = "";
  let attemptId = "";
  let attemptRef = null;

  if (safePreapprovalId) {
    const mapRef = db.collection("billingPreapprovals").doc(safePreapprovalId);
    const mapSnap = await mapRef.get();
    if (mapSnap.exists) {
      const mapData = mapSnap.data() || {};
      uid = String(mapData.uid || "").trim();
      attemptId = String(mapData.attemptId || "").trim();
      if (attemptId) {
        attemptRef = db.collection("billingAttempts").doc(attemptId);
      }
    }
  }

  if (!attemptRef && safePreapprovalId) {
    const byPreapprovalId = await db
      .collection("billingAttempts")
      .where("mpPreapprovalId", "==", safePreapprovalId)
      .limit(1)
      .get();
    if (!byPreapprovalId.empty) {
      const attemptDoc = byPreapprovalId.docs[0];
      attemptRef = attemptDoc.ref;
      attemptId = attemptDoc.id;
      const attemptData = attemptDoc.data() || {};
      uid = uid || String(attemptData.uid || "").trim();
    }
  }

  if (!attemptRef && externalReference) {
    const byExternalReference = await db
      .collection("billingAttempts")
      .where("externalReference", "==", externalReference)
      .limit(1)
      .get();
    if (!byExternalReference.empty) {
      const attemptDoc = byExternalReference.docs[0];
      attemptRef = attemptDoc.ref;
      attemptId = attemptDoc.id;
      const attemptData = attemptDoc.data() || {};
      uid = uid || String(attemptData.uid || "").trim();
    }
  }

  if (!uid && payerEmail) {
    const byEmail = await db
      .collection("usuarios")
      .where("correo", "==", payerEmail)
      .limit(1)
      .get();
    if (!byEmail.empty) {
      uid = byEmail.docs[0].id;
    }
  }

  return {
    uid,
    attemptId,
    attemptRef,
    externalReference,
    payerEmail,
  };
}

async function resolveLatestUserPreapprovalId(uid, preferredPreapprovalId = "") {
  const safePreferred = String(preferredPreapprovalId || "").trim();
  if (safePreferred) {
    return safePreferred;
  }

  const safeUid = String(uid || "").trim();
  if (!safeUid) {
    return "";
  }

  const attemptsSnap = await db
    .collection("billingAttempts")
    .where("uid", "==", safeUid)
    .get();

  if (attemptsSnap.empty) {
    return "";
  }

  let selected = null;
  attemptsSnap.docs.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const mpPreapprovalId = String(data.mpPreapprovalId || "").trim();
    if (!mpPreapprovalId) {
      return;
    }
    const sortWeight = Math.max(
      firestoreTimestampToMillis(data.updatedAt),
      firestoreTimestampToMillis(data.createdAt)
    );
    if (!selected || sortWeight > selected.sortWeight) {
      selected = {
        mpPreapprovalId,
        sortWeight,
      };
    }
  });

  return String(selected?.mpPreapprovalId || "").trim();
}

async function syncSubscriptionFromMercadoPago({
  preapprovalId,
  sourceLabel = "",
  topic = "",
  action = "",
}) {
  const safePreapprovalId = String(preapprovalId || "").trim();
  if (!safePreapprovalId) {
    throw new HttpsError("failed-precondition", "Missing preapprovalId");
  }

  const accessToken = String(MP_ACCESS_TOKEN.value() || "").trim();
  const preapprovalData = await fetchMercadoPagoPreapprovalById(accessToken, safePreapprovalId);
  const mpStatus = String(preapprovalData?.status || "").trim().toLowerCase();
  const mappedStatus = mapMercadoPagoStatusToBillingStatus(mpStatus);
  const statusDetail = shortText(preapprovalData?.status_detail || mpStatus || "unknown", 280);
  const now = admin.firestore.FieldValue.serverTimestamp();

  const resolved = await resolvePreapprovalContext(safePreapprovalId, preapprovalData);
  const safeUid = String(resolved.uid || "").trim();
  const safeAttemptId = String(resolved.attemptId || "").trim();
  const safeSource = shortText(sourceLabel || "system", 80);

  if (resolved.attemptRef) {
    await resolved.attemptRef.set(
      {
        uid: safeUid || null,
        attemptId: safeAttemptId || resolved.attemptRef.id,
        status: mappedStatus,
        mpPreapprovalId: safePreapprovalId,
        lastWebhookAt: now,
        lastWebhookType: shortText(`${safeSource}:${topic || ""}:${action || ""}`, 120),
        lastStatusDetail: statusDetail,
        updatedAt: now,
      },
      { merge: true }
    );
  }

  if (safeUid) {
    const userRef = db.collection("usuarios").doc(safeUid);
    await userRef.set(
      {
        billing: {
          status: mappedStatus,
          planCode: normalizePlanCode("plan_pro"),
          lastAttemptId: safeAttemptId || null,
          mpPreapprovalId: safePreapprovalId,
          updatedAt: now,
        },
        updatedAt: now,
      },
      { merge: true }
    );
  }

  await db.collection("billingPreapprovals").doc(safePreapprovalId).set(
    {
      uid: safeUid || null,
      attemptId: safeAttemptId || null,
      status: mappedStatus,
      updatedAt: now,
      createdAt: now,
    },
    { merge: true }
  );

  if (mappedStatus === "active" && safeUid) {
    await ensureBillingActivation(safeUid, preapprovalData);
  }

  return {
    preapprovalId: safePreapprovalId,
    mpStatus,
    mappedStatus,
    uid: safeUid || null,
    attemptId: safeAttemptId || null,
  };
}

async function ensureBillingActivation(uid, preapprovalData = {}) {
  const safeUid = String(uid || "").trim();
  if (!safeUid) {
    throw new HttpsError("invalid-argument", "uid is required for tenant activation");
  }

  const userRef = db.collection("usuarios").doc(safeUid);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const candidateTenantRef = db.collection("tenants").doc(buildTenantId());

  await db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) {
      throw new HttpsError("failed-precondition", "User profile not found for activation");
    }

    const userData = userSnap.data() || {};
    const existingTenantId = profileTenantId(userData);
    const alreadyEnabled = profileAccessAppEnabled(userData);
    const billingActivatedAt = profileBillingActivatedAt(userData) || now;
    const accessEnabledAt = profileAccessEnabledAt(userData) || now;
    const tenantProvisionedAt = profileOnboardingTenantProvisionedAt(userData) || now;
    const mpPreapprovalId = String(preapprovalData?.id || profileBillingMpPreapprovalId(userData) || "").trim();
    const planCode = normalizePlanCode(
      preapprovalData?.preapproval_plan_id ? "plan_pro" : profileBillingPlanCode(userData) || "plan_pro"
    );
    const ownerEmail = normalizeEmail(preapprovalData?.payer_email || userData?.correo || "");

    if (existingTenantId && alreadyEnabled) {
      tx.set(
        userRef,
        {
          billing: {
            status: "active",
            planCode: planCode || "plan_pro",
            mpPreapprovalId: mpPreapprovalId || null,
            activatedAt: billingActivatedAt,
            updatedAt: now,
          },
          access: {
            appEnabled: true,
            reason: "active_subscription",
            enabledAt: accessEnabledAt,
          },
          onboarding: {
            subscriptionActivated: true,
            tenantProvisioned: true,
            tenantProvisionedAt: tenantProvisionedAt,
          },
          updatedAt: now,
        },
        { merge: true }
      );
      return;
    }

    const tenantRef = existingTenantId
      ? db.collection("tenants").doc(existingTenantId)
      : candidateTenantRef;
    const tenantId = tenantRef.id;

    tx.set(
      tenantRef,
      {
        tenantId,
        ownerUid: safeUid,
        ownerEmail,
        ownerUsername: String(userData.usuarioKey || "").trim() || null,
        distrito: String(userData.distrito || "").trim(),
        nivel: String(userData.nivel || "").trim(),
        escuela: String(userData.escuela || "").trim(),
        planCode: planCode || "plan_pro",
        status: "active",
        createdAt: userData?.createdAt || now,
        updatedAt: now,
      },
      { merge: true }
    );

    tx.set(
      tenantRef.collection("configuraciones").doc("pacExtraccion"),
      {
        tenantId,
        processValue: "0",
        gmailQuery: "",
        useCustomSheet: false,
        customSheetUrl: "https://docs.google.com/spreadsheets/d/1UP0FlTWQdHciMe1dbpj2i1dhsQAk4EsxCtq2Bvxlv2U/edit?usp=sharing",
        customSheetName: "POFA",
        startRow: 2,
        createdAt: now,
        updatedAt: now,
      },
      { merge: true }
    );
    tx.set(
      tenantRef.collection("configuraciones").doc("encabezadoPac"),
      {
        tenantId,
        establecimientoReparticion: "",
        anexo: "",
        domicilioEscuela: "",
        telefono: "",
        email: String(userData.correo || "").trim(),
        categoria: "",
        turno: "",
        desfavorable: "",
        distrito: String(userData.distrito || "").trim(),
        tipoOrganizacion: String(userData.nivel || "").trim(),
        escuela: String(userData.escuela || "").trim(),
        anio: String(new Date().getFullYear()),
        desde: "",
        hasta: "",
        createdAt: now,
        updatedAt: now,
      },
      { merge: true }
    );
    tx.set(
      userRef,
      {
        tenantId,
        billing: {
          status: "active",
          planCode: planCode || "plan_pro",
          mpPreapprovalId: mpPreapprovalId || null,
          activatedAt: billingActivatedAt,
          updatedAt: now,
        },
        access: {
          appEnabled: true,
          reason: "active_subscription",
          enabledAt: accessEnabledAt,
        },
        onboarding: {
          subscriptionActivated: true,
          tenantProvisioned: true,
          tenantProvisionedAt: tenantProvisionedAt,
        },
        updatedAt: now,
      },
      { merge: true }
    );
  });
}

async function processMercadoPagoWebhookEvent({
  eventId,
  preapprovalId,
  sourceLabel = "webhook",
  throwOnError = false,
}) {
  const safeEventId = String(eventId || "").trim();
  if (!safeEventId) {
    return;
  }

  const eventRef = db.collection("billingEvents").doc(safeEventId);
  const eventSnap = await eventRef.get();
  if (!eventSnap.exists) {
    return;
  }

  const eventData = eventSnap.data() || {};
  const currentStatus = String(eventData.status || "").trim().toLowerCase();
  if (eventData.processed === true && (currentStatus === "processed" || currentStatus === "ignored")) {
    return;
  }

  const safePreapprovalId = String(preapprovalId || eventData.preapprovalId || "").trim();
  const safeSourceLabel = shortText(sourceLabel || "webhook", 80);
  if (!safePreapprovalId) {
    await eventRef.set(
      {
        processed: true,
        status: "ignored",
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
        errorMessage: "preapproval_id_missing",
        processingSource: safeSourceLabel,
      },
      { merge: true }
    );
    return;
  }

  try {
    const syncResult = await syncSubscriptionFromMercadoPago({
      preapprovalId: safePreapprovalId,
      sourceLabel: safeSourceLabel,
      topic: String(eventData.topic || ""),
      action: String(eventData.action || ""),
    });
    const now = admin.firestore.FieldValue.serverTimestamp();

    await eventRef.set(
      {
        processed: true,
        status: "processed",
        processedAt: now,
        errorMessage: null,
        mpStatus: syncResult.mpStatus,
        mappedStatus: syncResult.mappedStatus,
        uid: syncResult.uid || null,
        attemptId: syncResult.attemptId || null,
        processingSource: safeSourceLabel,
      },
      { merge: true }
    );
  } catch (error) {
    logger.error("processMercadoPagoWebhookEvent failed", {
      eventId: safeEventId,
      preapprovalId: safePreapprovalId,
      message: String(error?.message || "unknown_error"),
    });
    await eventRef.set(
      {
        processed: false,
        status: "error",
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
        errorMessage: shortText(error?.message || "processing_failed", 500),
        processingSource: safeSourceLabel,
      },
      { merge: true }
    );
    if (throwOnError) {
      throw error;
    }
  }
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

function applyMinimumSheetRow(dataRows = [], hasHeaders = false, headerRowIndex = -1, minimumRowOneBased = 217) {
  const firstDataRowOneBased = hasHeaders ? headerRowIndex + 2 : 1;
  const startOffset = Math.max(0, Number(minimumRowOneBased) - Number(firstDataRowOneBased));
  return dataRows.slice(startOffset);
}

function extractMateriaPidFromColumnF(rawValue) {
  const compact = String(rawValue || "")
    .trim()
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ");
  if (!compact) {
    return { materia: "", pid: "" };
  }

  const strictMatch = compact.match(/^(.*?)\s*-\s*([^-]+?)\s*-\s*$/);
  if (strictMatch) {
    return {
      materia: String(strictMatch[1] || "").trim(),
      pid: String(strictMatch[2] || "").trim(),
    };
  }

  const firstDash = compact.indexOf("-");
  const lastDash = compact.lastIndexOf("-");
  if (firstDash >= 0 && lastDash > firstDash) {
    return {
      materia: compact.slice(0, firstDash).trim(),
      pid: compact.slice(firstDash + 1, lastDash).trim(),
    };
  }

  return { materia: compact, pid: "" };
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

function columnLetterToIndex(columnName) {
  const letters = String(columnName || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  if (!letters) {
    return 0;
  }

  let index = 0;
  for (let i = 0; i < letters.length; i += 1) {
    index = (index * 26) + (letters.charCodeAt(i) - 64);
  }
  return Math.max(0, index - 1);
}

function resolveSheetLayoutProfile(sheetName = "", sheetGid = "") {
  const normalizedSheetName = normalizeHeader(sheetName);
  const sheetProfilesByName = {
    pofa: {
      key: "pofa",
      startColumnIndex: 0,
      startRowOneBased: 217,
    },
    pofaedartistica: {
      key: "pofa_ed_artistica",
      startColumnIndex: columnLetterToIndex("AH"),
      startRowOneBased: 7,
    },
    pofaedfisica: {
      key: "pofa_ed_fisica",
      startColumnIndex: columnLetterToIndex("AK"),
      startRowOneBased: 2,
    },
  };

  if (sheetProfilesByName[normalizedSheetName]) {
    return {
      sheetName: String(sheetName || "").trim(),
      ...sheetProfilesByName[normalizedSheetName],
    };
  }

  // Compatibilidad con configuraciones anteriores (hoja DATOS por gid).
  if (String(sheetGid || "").trim() === "687928343") {
    return {
      key: "datos_gid_687928343",
      sheetName: String(sheetName || "").trim(),
      startColumnIndex: 0,
      startRowOneBased: 217,
    };
  }

  return {
    key: "default",
    sheetName: String(sheetName || "").trim(),
    startColumnIndex: 0,
    startRowOneBased: 217,
  };
}

function applySheetColumnOffset(rows = [], startColumnIndex = 0) {
  const safeStartColumn = Math.max(0, Number(startColumnIndex) || 0);
  if (!safeStartColumn) {
    return rows;
  }
  return rows.map((row) => (Array.isArray(row) ? row.slice(safeStartColumn) : []));
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
  const safeUid = String(uid || "").trim();
  const userRef = db.collection("usuarios").doc(safeUid);
  let userSnap = await userRef.get();
  if (!userSnap.exists) {
    const bypassResult = await ensureGoogleTestBypassAccess({
      uid: safeUid,
      forceAuthLookup: true,
    });
    if (bypassResult.applied) {
      userSnap = await userRef.get();
    }
  }

  if (!userSnap.exists) {
    throw new HttpsError(
      "failed-precondition",
      "Subscription required",
      {
        code: "subscription_required",
        reason: "user_profile_missing",
      }
    );
  }

  let userData = userSnap.data() || {};
  let tenantId = profileTenantId(userData);
  let appEnabled = profileAccessAppEnabled(userData);

  if (!tenantId || !appEnabled) {
    const bypassResult = await ensureGoogleTestBypassAccess({
      uid: safeUid,
      existingProfile: userData,
      forceAuthLookup: false,
    });
    if (bypassResult.applied) {
      userSnap = await userRef.get();
      userData = userSnap.exists ? (userSnap.data() || {}) : {};
      tenantId = profileTenantId(userData);
      appEnabled = profileAccessAppEnabled(userData);
    }
  }

  if (!tenantId || !appEnabled) {
    throw new HttpsError(
      "failed-precondition",
      "Subscription required",
      {
        code: "subscription_required",
        reason: !tenantId ? "tenant_not_assigned" : "access_not_enabled",
      }
    );
  }

  return tenantId;
}

exports.health = onCall(callableOptions, () => {
  return { ok: true, service: "gestor-plantel-docente" };
});

exports.mercadoPagoSetupStatus = onCall(
  {
    ...callableOptions,
    secrets: [MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET, MP_PUBLIC_KEY],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Auth required");
    }

    const accessToken = String(MP_ACCESS_TOKEN.value() || "").trim();
    const webhookSecret = String(MP_WEBHOOK_SECRET.value() || "").trim();
    const publicKey = String(MP_PUBLIC_KEY.value() || "").trim();
    const planPro = await ensurePlanProSupport();

    return {
      ok: true,
      mode: "production_only",
      plan: {
        code: String(planPro.code || "plan_pro"),
        amount: Number(planPro.amount || 3000),
        currency: String(planPro.currency || "ARS"),
        frequency: Number(planPro.frequency || 1),
        frequencyType: String(planPro.frequencyType || "months"),
        active: Boolean(planPro.active),
      },
      secrets: {
        hasAccessToken: Boolean(accessToken),
        hasWebhookSecret: Boolean(webhookSecret),
        hasPublicKey: Boolean(publicKey),
      },
    };
  }
);

exports.processMercadoPagoWebhookTask = onTaskDispatched(
  {
    retryConfig: {
      maxAttempts: 10,
      minBackoffSeconds: 20,
      maxBackoffSeconds: 600,
      maxDoublings: 5,
    },
    rateLimits: {
      maxConcurrentDispatches: 10,
      maxDispatchesPerSecond: 5,
    },
    secrets: [MP_ACCESS_TOKEN],
  },
  async (request) => {
    const data = safeObject(request?.data);
    const eventId = shortText(data.eventId || data.eventRefId || "", 120);
    const preapprovalId = shortText(data.preapprovalId || "", 120);

    if (!eventId) {
      logger.warn("processMercadoPagoWebhookTask skipped: missing eventId");
      return;
    }

    await processMercadoPagoWebhookEvent({
      eventId,
      preapprovalId,
      sourceLabel: "cloud_tasks",
      throwOnError: true,
    });
  }
);

exports.mercadoPagoWebhook = onRequest(
  {
    invoker: "public",
    secrets: [MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET],
  },
  async (req, res) => {
    const payload = safeObject(req.body);
    const query = safeObject(req.query);
    const headers = safeObject(req.headers);

    const eventId = shortText(
      payload?.id ||
      payload?.event_id ||
      query?.id ||
      "",
      120
    );
    const topic = shortText(payload?.topic || query?.topic || payload?.type || "", 120);
    const action = shortText(payload?.action || query?.action || payload?.type || "", 120);
    const preapprovalId = shortText(extractWebhookPreapprovalId(payload, query), 120);
    const xRequestId = shortText(headers["x-request-id"] || headers["x_request_id"] || "", 200);
    const xSignature = shortText(headers["x-signature"] || headers["x_signature"] || "", 500);

    const signatureValidation = validateMercadoPagoWebhookSignature({
      signatureHeader: xSignature,
      requestId: xRequestId,
      webhookSecret: MP_WEBHOOK_SECRET.value(),
      preapprovalId,
    });

    const eventRef = db.collection("billingEvents").doc();
    await eventRef.set({
      eventRefId: eventRef.id,
      eventId: eventId || null,
      topic: topic || null,
      action: action || null,
      preapprovalId: preapprovalId || null,
      xRequestId: xRequestId || null,
      signatureValidated: signatureValidation.valid === true,
      signatureReason: shortText(signatureValidation.reason || "", 80),
      signatureTs: shortText(signatureValidation.ts || "", 60),
      status: "received",
      processed: false,
      processedAt: null,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      errorMessage: null,
      rawPayload: {
        body: payload,
        query,
      },
      rawHeaders: {
        userAgent: shortText(headers["user-agent"] || "", 200),
        xSignature,
        xRequestId,
      },
    });

    res.status(200).send({ ok: true });

    if (!signatureValidation.valid) {
      void eventRef.set(
        {
          processed: true,
          status: "ignored",
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
          errorMessage: shortText(`invalid_signature:${signatureValidation.reason || "unknown"}`, 200),
        },
        { merge: true }
      ).catch((error) => {
        logger.error("mercadoPagoWebhook could not persist invalid signature state", {
          eventRefId: eventRef.id,
          message: String(error?.message || "unknown_error"),
        });
      });
      return;
    }

    // Procesamiento desacoplado con cola durable (Cloud Tasks).
    void (async () => {
      try {
        await enqueueMercadoPagoWebhookTask({
          eventRefId: eventRef.id,
          preapprovalId,
        });
        await eventRef.set(
          {
            status: "enqueued",
            processed: false,
            queueName: MP_WEBHOOK_TASK_QUEUE_NAME,
            enqueuedAt: admin.firestore.FieldValue.serverTimestamp(),
            errorMessage: null,
          },
          { merge: true }
        );
      } catch (enqueueError) {
        logger.error("mercadoPagoWebhook enqueue failed", {
          eventRefId: eventRef.id,
          preapprovalId,
          message: String(enqueueError?.message || "unknown_error"),
        });
        await eventRef.set(
          {
            status: "enqueue_failed",
            processed: false,
            queueName: MP_WEBHOOK_TASK_QUEUE_NAME,
            errorMessage: shortText(enqueueError?.message || "enqueue_failed", 400),
            enqueueFailedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        // Fallback de continuidad: procesa inline si la cola no esta disponible.
        // Este fallback evita perdida de eventos, pero no reemplaza la durabilidad
        // de Cloud Tasks. Mantener hasta validar infraestructura de cola en prod.
        void processMercadoPagoWebhookEvent({
          eventId: eventRef.id,
          preapprovalId,
          sourceLabel: "webhook_inline_fallback",
          throwOnError: false,
        }).catch((processingError) => {
          logger.error("mercadoPagoWebhook fallback processing failed", {
            eventRefId: eventRef.id,
            preapprovalId,
            message: String(processingError?.message || "unknown_error"),
          });
        });
      }
    })();
  }
);

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
  let reusedExistingAuthUser = false;
  try {
    userRecord = await admin.auth().createUser({
      email: correo,
      password,
      displayName: nombre,
      emailVerified: false,
    });
  } catch (err) {
    logger.error("createUser failed", err);
    const authCode = String(err?.errorInfo?.code || err?.code || "").trim().toLowerCase();
    if (authCode.includes("email-already-exists")) {
      try {
        userRecord = await admin.auth().getUserByEmail(correo);
        reusedExistingAuthUser = true;
      } catch (lookupError) {
        logger.error("createUser existing email lookup failed", lookupError);
        throw new HttpsError("already-exists", "Email already exists", {
          code: "email_already_exists",
        });
      }
    } else if (authCode.includes("invalid-email")) {
      throw new HttpsError("invalid-argument", "Invalid email", {
        code: "invalid_email",
      });
    } else {
      throw new HttpsError("failed-precondition", "Could not create auth user", {
        code: "create_auth_user_failed",
      });
    }
  }

  const uid = userRecord.uid;
  const createdAt = admin.firestore.FieldValue.serverTimestamp();

  if (reusedExistingAuthUser) {
    const existingProfileSnap = await db.collection("usuarios").doc(uid).get();
    if (existingProfileSnap.exists) {
      throw new HttpsError("already-exists", "Email already exists", {
        code: "email_already_exists",
      });
    }
  }

  const profile = {
    uid,
    tenantId: null,
    nombre,
    contacto,
    correo,
    correoAlt,
    distrito,
    nivel,
    escuela,
    usuario,
    usuarioKey: usernameKey,
    verificado: userRecord.emailVerified === true,
    rol: "admin_escuela",
    billing: {
      planCode: null,
      status: null,
      lastAttemptId: null,
      mpPreapprovalId: null,
    },
    access: {
      appEnabled: false,
      reason: "payment_required",
    },
    onboarding: {
      accountCreated: true,
      checkoutStarted: false,
      subscriptionActivated: false,
      tenantProvisioned: false,
    },
    createdAt,
    updatedAt: createdAt,
  };

  try {
    await ensurePlanProSupport();

    await db.runTransaction(async (tx) => {
      tx.set(usernameRef, { uid, createdAt });
      tx.set(db.collection("usuarios").doc(uid), profile);
    });

    const link = await admin.auth().generateEmailVerificationLink(correo);
    let customAuthToken = "";
    try {
      customAuthToken = await admin.auth().createCustomToken(uid);
    } catch (tokenError) {
      logger.error("createCustomToken failed", {
        uid,
        message: String(tokenError?.message || "unknown_error"),
      });
    }

    return {
      ok: true,
      uid,
      tenantId: null,
      verificationLink: link,
      customAuthToken,
      reusedExistingAuthUser,
      message: "Base user created. Subscription required before tenant activation.",
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

exports.checkRegisterEmailStatus = onCall(callableOptions, async (request) => {
  const data = request.data || {};
  const correo = normalizeEmail(assertString(data.correo, "correo", 5, 120));
  if (!correo.includes("@")) {
    throw new HttpsError("invalid-argument", "Invalid email", {
      code: "invalid_email",
    });
  }

  try {
    const userRecord = await admin.auth().getUserByEmail(correo);
    const uid = String(userRecord?.uid || "").trim();
    const providerIds = Array.isArray(userRecord?.providerData)
      ? userRecord.providerData
        .map((item) => String(item?.providerId || "").trim())
        .filter(Boolean)
      : [];

    let hasProfile = false;
    let nextRoute = "/activar-plan.html";
    if (uid) {
      const profileSnap = await db.collection("usuarios").doc(uid).get();
      hasProfile = profileSnap.exists;
      if (profileSnap.exists) {
        nextRoute = resolveNextRouteForProfile(profileSnap.data() || {});
      }
    }

    return {
      ok: true,
      correo,
      exists: true,
      uid,
      emailVerified: userRecord.emailVerified === true,
      providerIds,
      hasProfile,
      nextRoute,
    };
  } catch (error) {
    const authCode = String(error?.errorInfo?.code || error?.code || "").trim().toLowerCase();
    if (authCode.includes("user-not-found")) {
      return {
        ok: true,
        correo,
        exists: false,
      };
    }

    logger.error("checkRegisterEmailStatus failed", {
      correo,
      code: authCode || "unknown",
      message: String(error?.message || "unknown_error"),
    });
    throw new HttpsError("internal", "Could not verify email status", {
      code: "check_email_status_failed",
    });
  }
});

exports.startSubscriptionCheckout = onCall(
  {
    ...callableOptions,
    secrets: [MP_ACCESS_TOKEN],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Auth required");
    }

    const data = request.data || {};
    const planCode = normalizePlanCode(data.planCode);
    if (planCode !== "plan_pro") {
      throw new HttpsError("invalid-argument", "planCode must be plan_pro");
    }

    const uid = request.auth.uid;
    const authToken = request.auth.token || {};
    const bypassResult = await ensureGoogleTestBypassAccess({
      uid,
      authToken,
      forceAuthLookup: false,
    });
    if (bypassResult.applied) {
      return {
        ok: true,
        bypassCheckout: true,
        bypassTag: bypassResult.bypassTag || GOOGLE_TEST_BYPASS_TAG,
        initPoint: `${primaryAppOrigin}/pac.html`,
        nextRoute: "/pac.html",
      };
    }

    await ensurePlanProSupport();
    const planRef = db.collection("billingPlans").doc(planCode);
    const planSnap = await planRef.get();
    if (!planSnap.exists) {
      throw new HttpsError("failed-precondition", "Subscription plan not configured");
    }
    const plan = planSnap.data() || {};
    if (plan.active !== true) {
      throw new HttpsError("failed-precondition", "Subscription plan is not active");
    }

    const userRef = db.collection("usuarios").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      throw new HttpsError(
        "failed-precondition",
        "User profile not found",
        {
          code: "user_profile_missing",
        }
      );
    }

    const userData = userSnap.data() || {};
    const payerEmail = normalizeEmail(authToken.email || userData.correo || "");
    if (!payerEmail || !payerEmail.includes("@")) {
      throw new HttpsError("failed-precondition", "User email is required to start checkout");
    }

    const attemptRef = db.collection("billingAttempts").doc();
    const attemptId = attemptRef.id;
    const externalReference = shortText(`sub_uid_${uid}_attempt_${attemptId}`, 120);
    const now = admin.firestore.FieldValue.serverTimestamp();

    const currentAttemptsSnap = await db
      .collection("billingAttempts")
      .where("uid", "==", uid)
      .where("isCurrent", "==", true)
      .get();

    const createAttemptBatch = db.batch();
    currentAttemptsSnap.docs.forEach((docSnap) => {
      createAttemptBatch.set(
        docSnap.ref,
        {
          isCurrent: false,
          updatedAt: now,
        },
        { merge: true }
      );
    });
    createAttemptBatch.set(
      attemptRef,
      {
        attemptId,
        uid,
        email: payerEmail,
        tenantId: String(userData.tenantId || "").trim() || null,
        planCode,
        status: "pending_checkout",
        isCurrent: true,
        externalReference,
        mpPreapprovalId: null,
        mpPreapprovalPlanId: shortText(plan.mpPreapprovalPlanId, 120) || null,
        initPoint: null,
        lastWebhookAt: null,
        lastWebhookType: null,
        lastStatusDetail: null,
        createdAt: now,
        updatedAt: now,
      },
      { merge: true }
    );
    await createAttemptBatch.commit();

    const accessToken = String(MP_ACCESS_TOKEN.value() || "").trim();
    let preapproval = null;
    try {
      preapproval = await createMercadoPagoPreapproval({
        accessToken,
        planCode,
        plan,
        payerEmail,
        externalReference,
      });
    } catch (error) {
      await attemptRef.set(
        {
          status: "error",
          isCurrent: false,
          lastStatusDetail: shortText(error?.message || "preapproval_failed", 280),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      if (error instanceof HttpsError) {
        throw error;
      }
      throw new HttpsError("internal", "No se pudo iniciar checkout de suscripcion");
    }

    const mpPreapprovalId = String(preapproval?.mpPreapprovalId || "").trim();
    const initPoint = String(preapproval?.initPoint || "").trim();
    const notificationUrl = String(preapproval?.notificationUrl || "").trim() || null;

    const finalizeBatch = db.batch();
    finalizeBatch.set(
      attemptRef,
      {
        status: "pending_checkout",
        mpPreapprovalId,
        initPoint,
        notificationUrl,
        lastStatusDetail: "checkout_initialized",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    finalizeBatch.update(userRef, {
      "billing.planCode": planCode,
      "billing.status": "pending_checkout",
      "billing.lastAttemptId": attemptId,
      "billing.mpPreapprovalId": mpPreapprovalId,
      "billing.updatedAt": admin.firestore.FieldValue.serverTimestamp(),
      "onboarding.checkoutStarted": true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    finalizeBatch.set(
      db.collection("billingPreapprovals").doc(mpPreapprovalId),
      {
        uid,
        attemptId,
        status: "pending_checkout",
        planCode,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await finalizeBatch.commit();

    return {
      ok: true,
      attemptId,
      initPoint,
    };
  }
);

exports.getSubscriptionStatus = onCall(callableOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Auth required");
  }

  const uid = request.auth.uid;
  const authToken = request.auth.token || {};
  const authEmail = normalizeEmail(authToken.email || "");
  await ensureGoogleTestBypassAccess({
    uid,
    authToken,
    forceAuthLookup: false,
  });

  if (isGoogleTestBypassEmail(authEmail)) {
    try {
      await getUserTenantId(uid);
    } catch (bypassError) {
      logger.error("getSubscriptionStatus reviewer bypass resolution failed", {
        uid,
        authEmail,
        message: String(bypassError?.message || "unknown_error"),
      });
    }
  }

  const userSnap = await db.collection("usuarios").doc(uid).get();
  if (!userSnap.exists) {
    return {
      billingStatus: null,
      appEnabled: false,
      reason: "profile_missing",
      planCode: null,
      tenantId: "",
      nextRoute: "/registro.html",
    };
  }

  const profile = userSnap.data() || {};
  const tenantId = profileTenantId(profile);
  const appEnabled = profileAccessAppEnabled(profile);
  const billingStatusRaw = profileBillingStatusRaw(profile);
  const billingStatus = billingStatusRaw === undefined ? null : billingStatusRaw;
  const reason = profileAccessReason(profile, "payment_required");
  const planCode = profileBillingPlanCode(profile);
  const nextRoute = resolveNextRouteForProfile(profile);

  return {
    billingStatus,
    appEnabled,
    reason,
    planCode,
    tenantId,
    nextRoute,
  };
});

exports.getAdminUsers = onCall(callableOptions, async (request) => {
  const { authEmail } = assertAdminAccess(request);

  const usersSnap = await db.collection("usuarios").get();
  const users = usersSnap.docs.map((docSnap) => {
    const data = docSnap.data() || {};
    const access = data.access && typeof data.access === "object" ? data.access : {};
    const billing = data.billing && typeof data.billing === "object" ? data.billing : {};
    return {
      uid: String(docSnap.id || "").trim(),
      nombre: shortText(data.nombre || "", 140),
      correo: normalizeEmail(data.correo || data.email || ""),
      distrito: shortText(data.distrito || "", 40),
      nivel: shortText(data.nivel || "", 80),
      escuela: shortText(data.escuela || "", 40),
      tenantId: shortText(data.tenantId || "", 120),
      appEnabled: access.appEnabled === true,
      billingStatus: shortText(billing.status || "", 80),
      planCode: shortText(billing.planCode || "", 80),
      createdAtMs: timestampToMillis(data.createdAt),
      updatedAtMs: timestampToMillis(data.updatedAt),
    };
  });

  users.sort((a, b) => {
    const left = Number(a.updatedAtMs || a.createdAtMs || 0);
    const right = Number(b.updatedAtMs || b.createdAtMs || 0);
    return right - left;
  });

  return {
    ok: true,
    adminEmail: authEmail,
    total: users.length,
    users,
  };
});

exports.syncSubscriptionStatus = onCall(
  {
    ...callableOptions,
    secrets: [MP_ACCESS_TOKEN],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Auth required");
    }

    const uid = request.auth.uid;
    const authToken = request.auth.token || {};
    const bypassResult = await ensureGoogleTestBypassAccess({
      uid,
      authToken,
      forceAuthLookup: false,
    });
    const userRef = db.collection("usuarios").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      throw new HttpsError("failed-precondition", "User profile not found", {
        code: "user_profile_missing",
      });
    }

    const userData = userSnap.data() || {};
    if (bypassResult.applied) {
      return {
        ok: true,
        bypassSync: true,
        bypassTag: bypassResult.bypassTag || GOOGLE_TEST_BYPASS_TAG,
        preapprovalId: profileBillingMpPreapprovalId(userData) || null,
        billingStatus: profileBillingStatusRaw(userData),
        appEnabled: profileAccessAppEnabled(userData),
        reason: profileAccessReason(userData, "payment_required"),
        planCode: profileBillingPlanCode(userData),
        tenantId: profileTenantId(userData),
        nextRoute: resolveNextRouteForProfile(userData),
      };
    }

    const preferredPreapprovalId = profileBillingMpPreapprovalId(userData);
    const preapprovalId = await resolveLatestUserPreapprovalId(uid, preferredPreapprovalId);
    if (!preapprovalId) {
      throw new HttpsError("failed-precondition", "Subscription not found", {
        code: "subscription_not_found",
      });
    }

    const syncResult = await syncSubscriptionFromMercadoPago({
      preapprovalId,
      sourceLabel: "manual_sync",
      topic: "callable",
      action: "sync",
    });

    const refreshedSnap = await userRef.get();
    const refreshed = refreshedSnap.exists ? (refreshedSnap.data() || {}) : {};

    return {
      ok: true,
      preapprovalId: syncResult.preapprovalId,
      billingStatus: profileBillingStatusRaw(refreshed),
      appEnabled: profileAccessAppEnabled(refreshed),
      reason: profileAccessReason(refreshed, "payment_required"),
      planCode: profileBillingPlanCode(refreshed),
      tenantId: profileTenantId(refreshed),
      nextRoute: resolveNextRouteForProfile(refreshed),
    };
  }
);

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

  try {
    await registerTenantMetricEvent({
      tenantId,
      uid,
      email,
      eventType: "inicio_sesion",
      source,
      metadata: {
        provider,
        sessionId: sessionRef.id,
      },
    });
  } catch (metricError) {
    logger.warn("registerSession metric event failed", {
      tenantId,
      uid,
      message: shortText(metricError?.message || "metric_write_failed", 280),
    });
  }

  return {
    ok: true,
    tenantId,
    sessionId: sessionRef.id,
  };
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

function pacPad2(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return "01";
  }
  return String(Math.max(1, Math.min(12, Math.floor(num)))).padStart(2, "0");
}

function pacCurrentYear() {
  return new Date().getFullYear();
}

function pacNormalizeYear(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return pacCurrentYear();
  }
  const year = Math.floor(parsed);
  if (year < 2000 || year > 2999) {
    return pacCurrentYear();
  }
  return year;
}

function pacDaysInMonth(month, year) {
  const monthNum = Number(month);
  const safeMonth = Number.isFinite(monthNum) ? Math.max(1, Math.min(12, Math.floor(monthNum))) : 1;
  return new Date(year, safeMonth, 0).getDate();
}

function pacNormalizeMonth(value, fallbackMonth = "01") {
  const match = String(value || "").trim().match(/^(\d{1,2})$/);
  if (!match) {
    return pacPad2(fallbackMonth);
  }
  return pacPad2(match[1]);
}

function pacMonthFromDateString(value, fallbackMonth = "01") {
  const match = String(value || "").trim().match(/^\d{1,2}\/(\d{1,2})\/\d{4}$/);
  if (!match) {
    return pacPad2(fallbackMonth);
  }
  return pacNormalizeMonth(match[1], fallbackMonth);
}

function pacBuildBoundaryDate(month, year, isEnd) {
  const mm = pacNormalizeMonth(month, "01");
  if (isEnd) {
    const day = String(pacDaysInMonth(mm, year)).padStart(2, "0");
    return `${day}/${mm}/${year}`;
  }
  return `01/${mm}/${year}`;
}

function pacNormalizeTurno(value) {
  const upper = String(value || "").toUpperCase();
  const match = upper.match(/[MTV]/);
  return match ? match[0] : "";
}

function pacNormalizeOrdinal(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  const match = text.match(/[1-5]/);
  if (!match) {
    return "";
  }
  return `${match[0]}°`;
}

function pacNormalizeEncabezadoPac(rawData, fallbackEmail = "") {
  const data = rawData && typeof rawData === "object" ? rawData : {};
  const year = pacNormalizeYear(data.anio);
  const desdeMonth = pacMonthFromDateString(data.desde, "01");
  const hastaMonth = pacMonthFromDateString(data.hasta, "12");
  const establecimientoReparticion = pacNormalizeText(
    data.establecimientoReparticion || data.establecimiento || data.reparticion || ""
  );
  const anexo = pacNormalizeText(data.anexo || "");
  const email = pacNormalizeText(data.email || "") || pacNormalizeText(fallbackEmail || "");

  return {
    establecimientoReparticion,
    anexo,
    domicilioEscuela: pacNormalizeText(data.domicilioEscuela || data.domicilio || ""),
    telefono: pacNormalizeText(data.telefono || ""),
    email,
    categoria: pacNormalizeOrdinal(data.categoria || ""),
    turno: pacNormalizeTurno(data.turno || ""),
    desfavorable: pacNormalizeOrdinal(data.desfavorable || ""),
    distrito: pacNormalizeText(data.distrito || ""),
    tipoOrganizacion: pacNormalizeText(data.tipoOrganizacion || ""),
    escuela: pacNormalizeText(data.escuela || ""),
    anio: String(year),
    desde: pacBuildBoundaryDate(desdeMonth, year, false),
    hasta: pacBuildBoundaryDate(hastaMonth, year, true),
  };
}

function pacNormalizeExtractionProcessValue(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "0" || raw === "interinos_docx") {
    return "0";
  }
  if (raw === "1" || raw === "designacion_body") {
    return "1";
  }
  return "1";
}

function pacDefaultGmailQueryFromProcess(processValue) {
  const safeProcess = pacNormalizeExtractionProcessValue(processValue);
  const prefix = safeProcess === "0" ? "sad" : "apdsad";
  return `from:${prefix}001@abc.gob.ar`;
}

function pacNormalizeExtractionConfig(rawData) {
  const data = rawData && typeof rawData === "object" ? rawData : {};
  const processValue = pacNormalizeExtractionProcessValue(
    data.processValue || data.proceso || data.process || data.mode || ""
  );
  const gmailQuery =
    pacNormalizeText(data.gmailQuery || data.query || "") ||
    pacDefaultGmailQueryFromProcess(processValue);
  return {
    processValue,
    gmailQuery,
  };
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

function pacScopeGranted(grantedScopes, requiredScope) {
  const granted = Array.isArray(grantedScopes) ? grantedScopes : [];
  const required = String(requiredScope || "").trim();
  if (!required) {
    return true;
  }
  if (granted.includes(required)) {
    return true;
  }

  const impliedBy = {
    "https://www.googleapis.com/auth/drive.readonly": [
      "https://www.googleapis.com/auth/drive",
    ],
    "https://www.googleapis.com/auth/drive.file": [
      "https://www.googleapis.com/auth/drive",
    ],
  };

  const superscopes = Array.isArray(impliedBy[required]) ? impliedBy[required] : [];
  return superscopes.some((scope) => granted.includes(scope));
}

function pacComputeMissingScopes(requiredScopes, grantedScopes) {
  const required = Array.isArray(requiredScopes) ? requiredScopes : [];
  return required.filter((scope) => !pacScopeGranted(grantedScopes, scope));
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

async function pacFetchBuffer(url, accessToken, options = {}, apiContext = "") {
  const requestHeaders = {
    Authorization: `Bearer ${accessToken}`,
    ...(options.headers || {}),
  };

  const response = await fetch(url, {
    ...options,
    headers: requestHeaders,
  });

  const arrayBuffer = await response.arrayBuffer();
  const bodyBuffer = Buffer.from(arrayBuffer || new ArrayBuffer(0));

  if (!response.ok) {
    let payload = {};
    const rawText = bodyBuffer.toString("utf8");
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

  return bodyBuffer;
}

async function pacListMessages(accessToken, queryText, maxResults) {
  const query = encodeURIComponent(String(queryText || "").trim());
  const safeMax = Math.max(1, Math.min(100, Number(maxResults) || 30));
  const endpoint = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=${safeMax}`;
  const data = await pacFetchJson(endpoint, accessToken, {}, "gmail.listMessages");
  return Array.isArray(data.messages) ? data.messages : [];
}

async function fetchGmailEmails(accessToken, queryText, maxResults) {
  return pacListMessages(accessToken, queryText, maxResults);
}

async function getEmails(userEmail, {
  accessToken = "",
  gmailQuery = "",
  maxResults = 30,
} = {}) {
  const messages = await fetchGmailEmails(accessToken, gmailQuery, maxResults);
  return {
    demoMode: false,
    demoEmails: [],
    messages,
  };
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

function pacNormalizeDni(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 7 || digits.length === 8) {
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
  const normalizeNumber = (value) => String(value || "").trim().replace(",", ".");

  const modulosDirect = pacFindFirst(raw, [
    /m[^\s/]{0,2}dulos?\s*[:\-]?\s*([0-9]+(?:[.,][0-9]+)?)/i,
    /m[^\s/]{0,2}dulos?\s+([0-9]+(?:[.,][0-9]+)?)/i,
  ]);
  if (modulosDirect) {
    return normalizeNumber(modulosDirect);
  }

  const mergedLine = pacFindFirst(raw, [
    /cargo\s*\/\s*m[^\s/]{0,2}dulos?\s*\/\s*horas?\s*[:\-]?\s*([^\n\r]+)/i,
    /cargo\/m[^\s/]{0,2}dulos\/horas\s*[:\-]?\s*([^\n\r]+)/i,
    /cargo\s*[:\-]?\s*[^\n\r]*?\|\s*m[^\s/]{0,2}dulos?\s*[:\-]?\s*([^\n\r]+)/i,
  ]);
  if (mergedLine) {
    const modulosInMerged = pacFindFirst(mergedLine, [
      /m[^\s/]{0,2}dulos?\s*[:\-]?\s*([0-9]+(?:[.,][0-9]+)?)/i,
      /([0-9]+(?:[.,][0-9]+)?)/i,
    ]);
    if (modulosInMerged) {
      return normalizeNumber(modulosInMerged);
    }
  }

  const horasDirect = pacFindFirst(raw, [
    /horas?\s*[:\-]?\s*([0-9]+(?:[.,][0-9]+)?)/i,
    /horas?\s+([0-9]+(?:[.,][0-9]+)?)/i,
  ]);
  if (horasDirect) {
    return normalizeNumber(horasDirect);
  }

  return "";
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

function pacNormalizeSituacionRevista(value) {
  const normalized = pacNormalizeText(value).toUpperCase().replace(/\./g, "");
  const allowed = new Set(["S", "P", "T", "TI", "DD"]);
  return allowed.has(normalized) ? normalized : "";
}

function pacExtractPacRow(text, meta = {}) {
  const source = String(text || "").replace(/\r/g, "\n");

  const cupof = pacFindFirst(source, [
    /cu\.?p\.?o\.?f\.?\s*(?:n[º°o])?\s*[:\-]?\s*([0-9]{4,})/i,
    /cupof\s*[:\-]?\s*([0-9]{4,})/i,
  ]);

  const cuilRaw = pacFindFirst(source, [
    /cuil(?:\s*(?:nro|numero|n[uú]mero))?\s*[:\-]?\s*([0-9.\-\s]{11,24})/i,
    /cuil(?:\s*(?:nro|numero|n[uú]mero))?\s*[:\-]?\s*([0-9]{2}\D?[0-9]{7,8}\D?[0-9])/i,
    /(?:^|\D)([0-9]{2}\D?[0-9]{7,8}\D?[0-9])(?:\D|$)/,
  ]);
  const cuil = pacNormalizeCuil(cuilRaw);

  const dniByLabel = pacNormalizeDni(
    pacFindFirst(source, [
      /d\.?\s*n\.?\s*i\.?\s*[:\-]?\s*([0-9.\-\s]{7,20})/i,
      /dni\s*[:\-]?\s*([0-9]{7,8})/i,
    ])
  );
  const dni = dniByLabel || pacDniFromCuil(cuil);

  const fechaNacimiento = pacNormalizeDate(
    pacFindFirst(source, [
      /fecha(?:\s+de)?\s+nac(?:imiento)?\s*[:\-]?\s*([0-3]?\d[\/\-.][01]?\d[\/\-.](?:19|20)\d{2})/i,
      /nac(?:imiento)?\s*[:\-]?\s*([0-3]?\d[\/\-.][01]?\d[\/\-.](?:19|20)\d{2})/i,
    ])
  );

  const apellidoNombreRaw = pacFindFirst(source, [
    /apellido(?:s)?\s*y?\s*nombre(?:s|\s*\/\s*s)?\s*[:\-]?\s*([^\n\r]+)/i,
    /nombre(?:s|\s*\/\s*s)?\s+y?\s*apellido(?:s)?\s*[:\-]?\s*([^\n\r]+)/i,
    /docente\s*[:\-]?\s*([^\n\r]+)/i,
  ]);
  const apellidoNombre = pacNormalizeText(
    String(apellidoNombreRaw || "").replace(/^\/\s*s\s*[:\-]\s*/i, "")
  );

  const pid = pacFindFirst(source, [/pid\s*[:\-]?\s*([A-Za-z0-9./_-]+)/i]);
  const cargoModulosHoras = pacBuildCargoModulosHoras(source);
  const situacionRevista = pacNormalizeSituacionRevista(
    pacFindFirst(source, [
      /situaci[oóÓ]n\s*de\s*revista\s*[:\-]?\s*([A-Za-z.]{1,3})/i,
      /\brevista\s*[:\-]?\s*([A-Za-z.]{1,3})/i,
    ])
  );

  const cursoLabel = pacFindFirst(source, [
    /\bcurso\b(?!\s*(?:y|\/)\s*divisi[oóÓ]n)\s*[:\-]?\s*([^\n\r]+)/i,
  ]);
  const divisionLabel = pacFindFirst(source, [/\bdivisi[oóÓ]n\b\s*[:\-]?\s*([^\n\r]+)/i]);
  const cursoDivisionLine = pacFindFirst(source, [
    /\bcurso\b\s*(?:y|\/)\s*divisi[oóÓ]n\s*[:\-]?\s*([^\n\r]+)/i,
  ]);

  const parsedCursoDivisionLine = pacParseCursoDivision(cursoDivisionLine);
  const parsedCursoLabel = pacParseCursoDivision(cursoLabel);
  const parsedDivisionLabel = pacParseCursoDivision(divisionLabel);

  const curso = pacNormalizeText(
    parsedCursoDivisionLine.curso ||
      parsedCursoLabel.curso ||
      parsedDivisionLabel.curso
  );
  const division = pacNormalizeText(
    parsedCursoDivisionLine.division ||
      parsedDivisionLabel.division ||
      parsedCursoLabel.division
  );
  const cuilParts = pacSplitCuilForSheet(cuil, dni);
  const modCarr = pacDeriveModCarrValue(curso);

  const row = {
    cupof,
    dni,
    cuilPrefix: cuilParts.prefix,
    cuilSuffix: cuilParts.suffix,
    fechaNacimiento,
    apellidoNombre,
    pid,
    cargoModulosHoras,
    situacionRevista,
    modCarr,
    curso,
    division,
    cuil,
    rowFormatVersion: "v2",
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

function pacRowHasDniOrCuil(row) {
  const dniDigits = String(row?.dni || "").replace(/\D/g, "");
  if (dniDigits.length === 7 || dniDigits.length === 8) {
    return true;
  }

  const cuilDigits = String(row?.cuil || "").replace(/\D/g, "");
  return cuilDigits.length === 11;
}

function pacRowHasCupof(row) {
  const cupofDigits = String(row?.cupof || "").replace(/\D/g, "");
  return cupofDigits.length >= 4;
}

async function pacResolveBirthDateByDni(dni, cache = new Map()) {
  const dniDigits = String(dni || "").replace(/\D/g, "");
  if (!dniDigits) {
    return UNKNOWN_BIRTHDATE;
  }

  if (cache.has(dniDigits)) {
    return await cache.get(dniDigits);
  }

  const lookupPromise = (async () => {
    const fetchedDate = await fetchFechaNacimientoByDni(dniDigits);
    const normalizedDate = pacNormalizeDate(fetchedDate);
    return normalizedDate || UNKNOWN_BIRTHDATE;
  })();
  cache.set(dniDigits, lookupPromise);
  try {
    const finalDate = await lookupPromise;
    cache.set(dniDigits, finalDate);
    return finalDate;
  } catch (error) {
    cache.delete(dniDigits);
    throw error;
  }
}

async function pacMapWithConcurrency(items, concurrency, mapper) {
  const list = Array.isArray(items) ? items : [];
  const safeConcurrency = Math.max(1, Math.min(20, Number(concurrency) || 6));
  if (!list.length) {
    return [];
  }

  const results = new Array(list.length);
  let nextIndex = 0;
  const totalWorkers = Math.min(safeConcurrency, list.length);

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      if (currentIndex >= list.length) {
        return;
      }
      nextIndex += 1;
      results[currentIndex] = await mapper(list[currentIndex], currentIndex);
    }
  }

  const workers = [];
  for (let idx = 0; idx < totalWorkers; idx += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

async function pacEnrichRowsWithExternalData(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const cache = new Map();
  return pacMapWithConcurrency(list, 6, async (row) => {
    const item = row && typeof row === "object" ? { ...row } : {};
    const dniFromField = pacNormalizeDni(item.dni || "");
    const dniFromCuil = pacDniFromCuil(item.cuil || "");
    const dniForLookup = dniFromField || dniFromCuil;
    if (!dniFromField && dniFromCuil) {
      item.dni = dniFromCuil;
    }

    const extractedBirthDate = pacNormalizeDate(item.fechaNacimiento || "");
    if (extractedBirthDate) {
      item.fechaNacimiento = extractedBirthDate;
    } else {
      const fetchedBirthDate = await pacResolveBirthDateByDni(dniForLookup, cache);
      item.fechaNacimiento = fetchedBirthDate !== UNKNOWN_BIRTHDATE
        ? fetchedBirthDate
        : UNKNOWN_BIRTHDATE;
    }
    item.situacionRevista = pacNormalizeSituacionRevista(item.situacionRevista || "");
    return item;
  });
}

function pacBuildFieldMapFromHeaders(headerRows) {
  const defaults = {
    cupof: 0,
    cuilPrefix: 1,
    dni: 2,
    cuilSuffix: 3,
    fechaNacimiento: 5,
    apellidoNombre: 6,
    situacionRevista: 7,
    modCarr: 8,
    pid: 9,
    cargoModulosHoras: 10,
    curso: 12,
    division: 13,
  };

  const row11 = Array.isArray(headerRows?.[0]) ? headerRows[0] : [];
  const row12 = Array.isArray(headerRows?.[1]) ? headerRows[1] : [];
  const row13 = Array.isArray(headerRows?.[2]) ? headerRows[2] : [];
  const maxLen = Math.max(row11.length, row12.length, row13.length, 0);
  if (!maxLen) {
    return defaults;
  }

  const labels = [];
  for (let i = 0; i < maxLen; i += 1) {
    const merged = `${String(row11[i] || "")} ${String(row12[i] || "")} ${String(row13[i] || "")}`;
    labels.push(pacNormalizeComparable(merged));
  }

  function findColumn(keywords, used) {
    for (let index = 0; index < labels.length; index += 1) {
      if (used && used.has(index)) {
        continue;
      }
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

  const used = new Set();
  function pickColumn(keywords, fallback) {
    const found = findColumn(keywords, used);
    if (found >= 0) {
      used.add(found);
      return found;
    }
    if (!used.has(fallback)) {
      used.add(fallback);
      return fallback;
    }
    for (let index = 0; index < labels.length; index += 1) {
      if (!used.has(index)) {
        used.add(index);
        return index;
      }
    }
    return fallback;
  }

  return {
    cupof: pickColumn(["cupof"], defaults.cupof),
    cuilPrefix: pickColumn(["cuil"], defaults.cuilPrefix),
    dni: pickColumn(["dni", "documento"], defaults.dni),
    cuilSuffix: defaults.cuilSuffix,
    fechaNacimiento: pickColumn(
      ["fecha de nacimiento", "fecha nacimiento", "fecha nac", "nacimiento"],
      defaults.fechaNacimiento
    ),
    apellidoNombre: pickColumn(
      ["apellido y nombre", "apellidos y nombres", "nombre y apellido"],
      defaults.apellidoNombre
    ),
    situacionRevista: pickColumn(
      ["situacion de revista", "situacion revista", "rev"],
      defaults.situacionRevista
    ),
    modCarr: pickColumn(["mod./carr.", "mod carr", "mod/carr"], defaults.modCarr),
    pid: pickColumn(["pid", "esp cur/asig", "esp cur", "asig"], defaults.pid),
    cargoModulosHoras: pickColumn(
      ["cargo/modulos/horas", "cargo modulos horas", "hs/mod/car", "hs mod car"],
      defaults.cargoModulosHoras
    ),
    curso: pickColumn(["curso", "ano", "año"], defaults.curso),
    division: pickColumn(["division", "seccion"], defaults.division),
  };
}

function pacDeriveModCarrValue(cursoValue) {
  const raw = String(cursoValue || "");
  const match = raw.match(/\d{1,2}/);
  if (!match) {
    return "";
  }

  const cursoNumber = Number(match[0]);
  if (!Number.isFinite(cursoNumber) || cursoNumber <= 0) {
    return "";
  }

  return cursoNumber < 4 ? "CB" : "CS";
}

function pacSplitCuilForSheet(cuilValue, fallbackDniValue) {
  const cleanCuil = String(cuilValue || "").replace(/\D/g, "");
  const fallbackDni = String(fallbackDniValue || "").replace(/\D/g, "");
  if (cleanCuil.length >= 11) {
    return {
      prefix: cleanCuil.slice(0, 2),
      dni: cleanCuil.slice(2, 10),
      suffix: cleanCuil.slice(10, 11),
    };
  }
  return {
    prefix: "",
    dni: fallbackDni,
    suffix: "",
  };
}

function pacBuildCuilFromParts(prefix, dni, suffix) {
  const cleanPrefix = String(prefix || "").replace(/\D/g, "");
  const cleanDni = String(dni || "").replace(/\D/g, "");
  const cleanSuffix = String(suffix || "").replace(/\D/g, "");
  if (cleanPrefix.length !== 2 || cleanDni.length < 7 || cleanDni.length > 8 || cleanSuffix.length !== 1) {
    return "";
  }
  return `${cleanPrefix}-${cleanDni}-${cleanSuffix}`;
}

function pacNormalizeModCarrValue(value, cursoFallback = "") {
  const raw = pacNormalizeText(value || "").toUpperCase();
  if (raw === "CB" || raw === "CS") {
    return raw;
  }
  return pacDeriveModCarrValue(cursoFallback);
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
  const range = `'${escapedSheet}'!11:13`;
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
    cuilPrefix: 1,
    dni: 2,
    cuilSuffix: 3,
    fechaNacimiento: 5,
    apellidoNombre: 6,
    situacionRevista: 7,
    modCarr: 8,
    pid: 9,
    cargoModulosHoras: 10,
    curso: 12,
    division: 13,
  };

  const width = Math.max(
    Number(map.cupof || 0),
    Number(map.cuilPrefix || 1),
    Number(map.dni || 2),
    Number(map.cuilSuffix || 3),
    Number(map.fechaNacimiento || 5),
    Number(map.apellidoNombre || 6),
    Number(map.situacionRevista || 7),
    Number(map.modCarr || 8),
    Number(map.pid || 9),
    Number(map.cargoModulosHoras || 10),
    Number(map.curso || 12),
    Number(map.division || 13),
    13
  ) + 1;

  return rows.map((row) => {
    const line = new Array(width).fill("");
    const curso = String(row?.curso || "");
    const legacyCuilParts = pacSplitCuilForSheet(String(row?.cuil || ""), String(row?.dni || ""));
    const rowPrefix = String(row?.cuilPrefix || "").replace(/\D/g, "");
    const rowSuffix = String(row?.cuilSuffix || "").replace(/\D/g, "");
    const rowDni = String(row?.dni || "").replace(/\D/g, "");
    const cuilPrefix = rowPrefix || legacyCuilParts.prefix;
    const cuilSuffix = rowSuffix || legacyCuilParts.suffix;
    const dni = rowDni || legacyCuilParts.dni || String(row?.dni || "");
    line[map.cupof] = String(row?.cupof || "");
    line[map.cuilPrefix] = cuilPrefix;
    line[map.dni] = dni;
    line[map.cuilSuffix] = cuilSuffix;
    line[map.fechaNacimiento] = String(row?.fechaNacimiento || "");
    line[map.apellidoNombre] = String(row?.apellidoNombre || "");
    line[map.situacionRevista] = pacNormalizeSituacionRevista(row?.situacionRevista || "");
    line[map.modCarr] = pacNormalizeModCarrValue(row?.modCarr || "", curso);
    line[map.pid] = String(row?.pid || "");
    line[map.cargoModulosHoras] = String(row?.cargoModulosHoras || "");
    line[map.curso] = curso;
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

function pacBuildEncabezadoCellUpdates(sheetName, encabezadoPac) {
  const safeSheetName = pacEscapeSheetName(sheetName);
  const encabezado = encabezadoPac && typeof encabezadoPac === "object" ? encabezadoPac : {};
  const map = [
    ["D4", encabezado.establecimientoReparticion || ""],
    ["E4", encabezado.anexo || ""],
    ["D5", encabezado.domicilioEscuela || ""],
    ["D6", encabezado.telefono || ""],
    ["B7", encabezado.email || ""],
    ["B8", encabezado.categoria || ""],
    ["C9", encabezado.turno || ""],
    ["C10", encabezado.desfavorable || ""],
    ["AI6", encabezado.distrito || ""],
    ["AM6", encabezado.tipoOrganizacion || ""],
    ["AQ6", encabezado.escuela || ""],
    ["AQ11", encabezado.anio || ""],
    ["AI9", encabezado.desde || ""],
    ["AI10", encabezado.hasta || ""],
  ];

  return map.map(([cell, value]) => ({
    range: `'${safeSheetName}'!${cell}`,
    values: [[pacNormalizeText(value || "")]],
  }));
}

async function pacWriteEncabezadoToSheet(accessToken, sheetId, sheetName, encabezadoPac) {
  const updates = pacBuildEncabezadoCellUpdates(sheetName, encabezadoPac);
  if (!updates.length) {
    return { cellsUpdated: 0 };
  }

  const endpoint =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    "/values:batchUpdate";
  await pacFetchJson(endpoint, accessToken, {
    method: "POST",
    body: JSON.stringify({
      valueInputOption: "USER_ENTERED",
      data: updates,
    }),
  }, "sheets.writeEncabezadoPac");

  return { cellsUpdated: updates.length };
}

function pacNormalizeRowsForWrite(rawRows) {
  const list = Array.isArray(rawRows) ? rawRows : [];
  return list
    .slice(0, 500)
    .map((item) => {
      const cupof = pacNormalizeText(item?.cupof || "");
      const dni = pacNormalizeText(item?.dni || "");
      const fechaNacimiento = pacNormalizeText(item?.fechaNacimiento || "");
      const apellidoNombre = pacNormalizeText(item?.apellidoNombre || "");
      const situacionRevista = pacNormalizeSituacionRevista(item?.situacionRevista || "");
      const pid = pacNormalizeText(item?.pid || "");
      const cargoModulosHoras = pacNormalizeText(item?.cargoModulosHoras || "");
      const curso = pacNormalizeText(item?.curso || "");
      const division = pacNormalizeText(item?.division || "");

      const rawCuil = pacNormalizeText(item?.cuil || "");
      const rawPrefix = pacNormalizeText(item?.cuilPrefix || "");
      const rawSuffix = pacNormalizeText(item?.cuilSuffix || "");
      const legacyParts = pacSplitCuilForSheet(rawCuil, dni);
      const cuilPrefix = rawPrefix || legacyParts.prefix;
      const cuilSuffix = rawSuffix || legacyParts.suffix;
      const cuil = rawCuil || pacBuildCuilFromParts(cuilPrefix, dni || legacyParts.dni, cuilSuffix);

      return {
        cupof,
        dni,
        cuilPrefix,
        cuilSuffix,
        fechaNacimiento,
        apellidoNombre,
        situacionRevista,
        modCarr: pacNormalizeModCarrValue(item?.modCarr || "", curso),
        pid,
        cargoModulosHoras,
        curso,
        division,
        cuil,
        rowFormatVersion: pacNormalizeText(item?.rowFormatVersion || ""),
        messageId: pacNormalizeText(item?.messageId || ""),
        subject: pacNormalizeText(item?.subject || ""),
        from: pacNormalizeText(item?.from || ""),
        date: pacNormalizeText(item?.date || ""),
        attachmentName: pacNormalizeText(item?.attachmentName || ""),
        missingFields: Array.isArray(item?.missingFields)
          ? item.missingFields.map((field) => pacNormalizeText(field)).filter(Boolean)
          : [],
      };
    })
    .filter((row) =>
      Boolean(
        row.cupof ||
        row.dni ||
        row.apellidoNombre ||
        row.situacionRevista ||
        row.pid ||
        row.cargoModulosHoras ||
        row.curso ||
        row.division
      )
    );
}

function pacBuildOutputSheetTitle(mode) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const base = mode === "designacion_body"
    ? "PAC Designacion"
    : "PAC Destino Definitivo Interinos";
  return `${base} ${yyyy}-${mm}-${dd} ${hh}${mi}`;
}

async function pacCopySpreadsheetTemplate(accessToken, templateSheetId, outputTitle) {
  const endpoint =
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(templateSheetId)}` +
    "/copy?fields=id,name,webViewLink";
  const payload = await pacFetchJson(endpoint, accessToken, {
    method: "POST",
    body: JSON.stringify({
      name: pacNormalizeText(outputTitle || "") || pacBuildOutputSheetTitle("interinos_docx"),
    }),
  }, "drive.copyTemplate");

  const copiedId = pacNormalizeText(payload?.id || "");
  if (!copiedId) {
    throw new Error("No se pudo crear la copia de la plantilla");
  }

  return {
    id: copiedId,
    name: pacNormalizeText(payload?.name || ""),
    webViewLink: pacNormalizeText(payload?.webViewLink || ""),
  };
}

function pacReadLocalTemplateBuffer() {
  if (Buffer.isBuffer(pacLocalTemplateBufferCache) && pacLocalTemplateBufferCache.length) {
    return pacLocalTemplateBufferCache;
  }

  const templatePath = path.resolve(__dirname, PAC_LOCAL_TEMPLATE_RELATIVE_PATH);
  let buffer = null;
  try {
    buffer = fs.readFileSync(templatePath);
  } catch (error) {
    const wrapped = new Error(`No se pudo leer la plantilla PAC local en ${templatePath}`);
    wrapped.name = "PacLocalTemplateError";
    wrapped.code = "template_local_not_found";
    wrapped.cause = error;
    throw wrapped;
  }

  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    const wrapped = new Error("La plantilla PAC local esta vacia o no se pudo cargar");
    wrapped.name = "PacLocalTemplateError";
    wrapped.code = "template_local_empty";
    throw wrapped;
  }

  pacLocalTemplateBufferCache = buffer;
  return pacLocalTemplateBufferCache;
}

function pacBuildDriveMultipartBody(metadata, mediaBuffer, mediaContentType) {
  const boundary = `pac_boundary_${crypto.randomBytes(12).toString("hex")}`;
  const delimiter = `--${boundary}\r\n`;
  const separator = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--\r\n`;

  const metadataPart = Buffer.from(
    `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata || {})}`,
    "utf8"
  );
  const mediaHeader = Buffer.from(
    `${separator}Content-Type: ${mediaContentType || PAC_LOCAL_TEMPLATE_CONTENT_TYPE}\r\n\r\n`,
    "utf8"
  );
  const closingPart = Buffer.from(closeDelimiter, "utf8");

  return {
    boundary,
    body: Buffer.concat([metadataPart, mediaHeader, mediaBuffer || Buffer.alloc(0), closingPart]),
  };
}

async function pacCreateSpreadsheetFromLocalTemplate(accessToken, outputTitle) {
  const templateBuffer = pacReadLocalTemplateBuffer();
  const safeOutputTitle =
    pacNormalizeText(outputTitle || "") || pacBuildOutputSheetTitle("interinos_docx");
  const metadata = {
    name: safeOutputTitle,
    mimeType: "application/vnd.google-apps.spreadsheet",
  };
  const multipart = pacBuildDriveMultipartBody(
    metadata,
    templateBuffer,
    PAC_LOCAL_TEMPLATE_CONTENT_TYPE
  );
  const endpoint =
    "https://www.googleapis.com/upload/drive/v3/files" +
    "?uploadType=multipart&fields=id,name,webViewLink,mimeType";

  const payload = await pacFetchJson(endpoint, accessToken, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/related; boundary=${multipart.boundary}`,
    },
    body: multipart.body,
  }, "drive.uploadLocalTemplate");

  const copiedId = pacNormalizeText(payload?.id || "");
  if (!copiedId) {
    throw new Error("No se pudo crear la planilla desde la plantilla local");
  }

  return {
    id: copiedId,
    name: pacNormalizeText(payload?.name || safeOutputTitle),
    webViewLink: pacNormalizeText(payload?.webViewLink || ""),
    source: "local_template_upload",
    mimeType: pacNormalizeText(payload?.mimeType || ""),
  };
}

async function pacExportSpreadsheetAsXlsx(accessToken, sheetId) {
  const endpoint =
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sheetId)}` +
    "/export?mimeType=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return pacFetchBuffer(endpoint, accessToken, {}, "drive.exportXlsx");
}

async function pacDeleteDriveFile(accessToken, fileId) {
  const endpoint = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`;
  await pacFetchBuffer(endpoint, accessToken, { method: "DELETE" }, "drive.deleteFile");
}

const updatePacEncabezadoCallable = onCall(callableOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Auth required");
  }

  const uid = request.auth.uid;
  const tenantId = await getUserTenantId(uid);
  const authEmail = normalizeEmail(request.auth.token?.email || "");
  const raw = request.data?.encabezadoPac && typeof request.data.encabezadoPac === "object"
    ? request.data.encabezadoPac
    : request.data || {};
  const encabezadoPac = pacNormalizeEncabezadoPac(raw, authEmail);
  const ref = db.collection("tenants").doc(tenantId).collection("configuraciones").doc("encabezadoPac");
  const existing = await ref.get();
  const now = admin.firestore.FieldValue.serverTimestamp();

  await ref.set(
    {
      tenantId,
      ...encabezadoPac,
      updatedAt: now,
      updatedBy: uid,
      createdAt: existing.exists ? existing.data()?.createdAt || now : now,
    },
    { merge: true }
  );

  return {
    ok: true,
    tenantId,
    path: `tenants/${tenantId}/configuraciones/encabezadoPac`,
    encabezadoPac,
  };
});

exports.actuaizarEncabezadoPac = updatePacEncabezadoCallable;
exports.actualizarEncabezadoPac = updatePacEncabezadoCallable;

exports.obtenerEncabezadoPac = onCall(callableOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Auth required");
  }

  const uid = request.auth.uid;
  const tenantId = await getUserTenantId(uid);
  const authEmail = normalizeEmail(request.auth.token?.email || "");
  const ref = db.collection("tenants").doc(tenantId).collection("configuraciones").doc("encabezadoPac");
  const snap = await ref.get();

  if (!snap.exists) {
    return {
      ok: true,
      tenantId,
      exists: false,
      path: `tenants/${tenantId}/configuraciones/encabezadoPac`,
      encabezadoPac: null,
    };
  }

  const data = snap.data() || {};
  const encabezadoPac = pacNormalizeEncabezadoPac(data, authEmail);
  return {
    ok: true,
    tenantId,
    exists: true,
    path: `tenants/${tenantId}/configuraciones/encabezadoPac`,
    encabezadoPac,
  };
});

exports.actualizarConfiguracionPacExtraccion = onCall(callableOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Auth required");
  }

  const uid = request.auth.uid;
  const tenantId = await getUserTenantId(uid);
  const raw = request.data?.configuracionPac && typeof request.data.configuracionPac === "object"
    ? request.data.configuracionPac
    : request.data || {};
  const configuracionPac = pacNormalizeExtractionConfig(raw);
  const ref = db.collection("tenants").doc(tenantId).collection("configuraciones").doc("pacExtraccion");
  const existing = await ref.get();
  const now = admin.firestore.FieldValue.serverTimestamp();

  await ref.set(
    {
      tenantId,
      ...configuracionPac,
      updatedAt: now,
      updatedBy: uid,
      createdAt: existing.exists ? existing.data()?.createdAt || now : now,
    },
    { merge: true }
  );

  return {
    ok: true,
    tenantId,
    path: `tenants/${tenantId}/configuraciones/pacExtraccion`,
    configuracionPac,
  };
});

exports.obtenerConfiguracionPacExtraccion = onCall(callableOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Auth required");
  }

  const uid = request.auth.uid;
  const tenantId = await getUserTenantId(uid);
  const ref = db.collection("tenants").doc(tenantId).collection("configuraciones").doc("pacExtraccion");
  const snap = await ref.get();

  if (!snap.exists) {
    return {
      ok: true,
      tenantId,
      exists: false,
      path: `tenants/${tenantId}/configuraciones/pacExtraccion`,
      configuracionPac: null,
    };
  }

  const data = snap.data() || {};
  return {
    ok: true,
    tenantId,
    exists: true,
    path: `tenants/${tenantId}/configuraciones/pacExtraccion`,
    configuracionPac: pacNormalizeExtractionConfig(data),
  };
});

exports.runPacProcess = onCall(callableOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Auth required");
  }

  const uid = String(request.auth.uid || "").trim();
  const authEmail = normalizeEmail(request.auth.token?.email || "");
  const tenantIdForMetrics = await resolveTenantIdForMetrics(uid);
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

  if (authEmail && !authEmail.endsWith("@abc.gob.ar")) {
    logger.warn("runPacProcess email outside abc.gob.ar domain", { email: authEmail });
  }

  const requiredScopes = ["https://www.googleapis.com/auth/gmail.readonly"];
  if (!previewOnly) {
    requiredScopes.push("https://www.googleapis.com/auth/spreadsheets");
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
  const missingScopes = pacComputeMissingScopes(requiredScopes, grantedScopes);

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
  let demoEmails = [];
  let demoMode = false;
  try {
    const emailResult = await getEmails(authEmail, {
      accessToken,
      gmailQuery,
      maxResults,
    });
    demoMode = emailResult?.demoMode === true;
    demoEmails = Array.isArray(emailResult?.demoEmails) ? emailResult.demoEmails : [];
    messages = Array.isArray(emailResult?.messages) ? emailResult.messages : [];
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

  const rows = demoEmails.map((row) => ({ ...(row || {}) }));
  const errors = [];
  let omittedWithoutIdentity = 0;
  let omittedWithoutCupof = 0;

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

  if (!demoMode) {
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
              if (!pacRowHasCupof(row)) {
                sourceErrors.push(`${source.label}: No se detecto CUPOF en la extraccion`);
                continue;
              }
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

          if (!pacRowHasDniOrCuil(bestRow)) {
            omittedWithoutIdentity += 1;
            pacPushMailError(
              errors,
              mailMetadata,
              "Se omitio el mensaje porque no se detecto DNI ni CUIL en el contenido extraido"
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

        const extractedBodyRow = pacExtractPacRow(bodyText, {
          messageId,
          subject,
          from,
          date,
          attachmentName: "",
        });
        if (!pacRowHasCupof(extractedBodyRow)) {
          omittedWithoutCupof += 1;
          pacPushMailError(
            errors,
            mailMetadata,
            "Se omitio el mensaje porque no se detecto CUPOF en el cuerpo del mail"
          );
          continue;
        }
        if (!pacRowHasDniOrCuil(extractedBodyRow)) {
          omittedWithoutIdentity += 1;
          pacPushMailError(
            errors,
            mailMetadata,
            "Se omitio el mensaje porque no se detecto DNI ni CUIL en el cuerpo del mail"
          );
          continue;
        }

        rows.push(extractedBodyRow);
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
  }

  const enrichedRows = demoMode
    ? rows.map((row) => ({
      ...row,
      missingFields: Array.isArray(row?.missingFields) ? row.missingFields : [],
    }))
    : rows.length
      ? await pacEnrichRowsWithExternalData(rows)
      : [];

  let writeSummary = null;
  if (!previewOnly && enrichedRows.length) {
    try {
      writeSummary = await pacWriteRowsToSheet(accessToken, sheetId, sheetName, startRow, enrichedRows);
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

  const safeRows = enrichedRows.map((row) => ({
    cupof: String(row.cupof || ""),
    cuil: String(row.cuil || ""),
    cuilPrefix: String(row.cuilPrefix || ""),
    dni: String(row.dni || ""),
    cuilSuffix: String(row.cuilSuffix || ""),
    fechaNacimiento: String(row.fechaNacimiento || ""),
    apellidoNombre: String(row.apellidoNombre || ""),
    situacionRevista: String(row.situacionRevista || ""),
    modCarr: String(row.modCarr || ""),
    pid: String(row.pid || ""),
    cargoModulosHoras: String(row.cargoModulosHoras || ""),
    curso: String(row.curso || ""),
    division: String(row.division || ""),
    rowFormatVersion: String(row.rowFormatVersion || ""),
    messageId: String(row.messageId || ""),
    subject: String(row.subject || ""),
    from: String(row.from || ""),
    date: String(row.date || ""),
    attachmentName: String(row.attachmentName || ""),
    missingFields: Array.isArray(row.missingFields) ? row.missingFields : [],
  }));

  if (tenantIdForMetrics) {
    try {
      await registerTenantMetricEvent({
        tenantId: tenantIdForMetrics,
        uid,
        email: authEmail,
        eventType: "pac_realizado",
        source: "pac",
        metadata: {
          mode,
          previewOnly,
          demoMode,
          gmailQuery,
          totalMessages: demoMode ? safeRows.length : messages.length,
          rowsExtracted: safeRows.length,
          errorsCount: errors.length,
          omittedWithoutIdentity,
          omittedWithoutCupof,
        },
      });
    } catch (metricError) {
      logger.warn("runPacProcess metric event failed", {
        tenantId: tenantIdForMetrics,
        uid,
        message: shortText(metricError?.message || "metric_write_failed", 280),
      });
    }
  }

  return {
    ok: true,
    mode,
    demoMode,
    demoEmails: demoMode ? safeRows : [],
    gmailQuery,
    totalMessages: demoMode ? safeRows.length : messages.length,
    rowsExtracted: safeRows.length,
    omittedWithoutIdentity,
    omittedWithoutCupof,
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

exports.savePacRowsToDrive = onCall(savePacRowsCallableOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Auth required");
  }

  const uid = request.auth.uid;
  const tenantId = await getUserTenantId(uid);
  const authEmail = normalizeEmail(request.auth.token?.email || "");
  const data = request.data || {};
  const accessToken = assertString(data.accessToken, "accessToken", 20, 10000);
  const sheetUrl = String(data.sheetUrl || "").trim();
  const templateSheetId = pacParseSheetId(sheetUrl);

  const rawRows = pacNormalizeRowsForWrite(data.rows || []);
  if (!rawRows.length) {
    throw new HttpsError("invalid-argument", "No hay filas seleccionadas para guardar");
  }
  const rows = await pacEnrichRowsWithExternalData(rawRows);
  const rawEncabezadoPac = data.encabezadoPac && typeof data.encabezadoPac === "object"
    ? data.encabezadoPac
    : {};
  const hasPayloadEncabezado = Object.keys(rawEncabezadoPac).length > 0;
  let storedEncabezadoPac = {};
  try {
    const configSnap = await db
      .collection("tenants")
      .doc(tenantId)
      .collection("configuraciones")
      .doc("encabezadoPac")
      .get();
    if (configSnap.exists) {
      storedEncabezadoPac = configSnap.data() || {};
    }
  } catch (configError) {
    logger.warn("savePacRowsToDrive encabezadoPac read failed", {
      tenantId,
      message: String(configError?.message || "read failed"),
    });
  }
  const encabezadoPac = pacNormalizeEncabezadoPac(
    hasPayloadEncabezado ? rawEncabezadoPac : storedEncabezadoPac,
    authEmail
  );

  const requestedSheetName = pacNormalizeText(data.sheetName || "");
  const startRowRaw = Number(data.startRow);
  const startRow = Number.isFinite(startRowRaw) && startRowRaw > 0 ? Math.floor(startRowRaw) : 14;
  const mode = pacNormalizeText(data.mode || "interinos_docx").toLowerCase();
  const deliveryRaw = pacNormalizeText(data.delivery || "drive").toLowerCase();
  const delivery =
    deliveryRaw === "download"
      ? "download"
      : deliveryRaw === "drive"
        ? "drive"
        : "";
  if (!delivery) {
    throw new HttpsError("invalid-argument", "delivery must be 'drive' or 'download'");
  }
  const outputTitle =
    pacNormalizeText(data.outputTitle || "") ||
    pacBuildOutputSheetTitle(mode === "designacion_body" ? "designacion_body" : "interinos_docx");

  const requiredScopes = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file",
  ];

  let tokenInfo = null;
  try {
    tokenInfo = await pacFetchTokenInfo(accessToken);
  } catch (tokenInfoError) {
    logger.warn("savePacRowsToDrive tokeninfo unavailable", {
      message: String(tokenInfoError?.message || "tokeninfo failed"),
      authEmail: normalizeEmail(request.auth.token?.email || ""),
    });
  }

  const grantedScopes = tokenInfo?.scopeList || [];
  const missingScopes = pacComputeMissingScopes(requiredScopes, grantedScopes);
  if (tokenInfo && missingScopes.length) {
    throw new HttpsError(
      "failed-precondition",
      "Faltan permisos para guardar en Drive. Reautoriza Sheets + Drive (drive.file) e intenta nuevamente.",
      {
        errorType: "missing_scopes_save_drive",
        requiredScopes,
        grantedScopes,
        missingScopes,
        tokenAudience: tokenInfo?.audience || "",
        tokenEmail: tokenInfo?.email || "",
      }
    );
  }

  try {
    let copied = null;
    let templateSource = "local_template";

    if (templateSheetId) {
      try {
        copied = await pacCopySpreadsheetTemplate(accessToken, templateSheetId, outputTitle);
        templateSource = "google_sheet_copy";
      } catch (copyError) {
        const metadata = pacBuildErrorMetadata(copyError);
        const shouldFallbackToLocalTemplate =
          Number(metadata.status || 0) === 404 ||
          String(metadata.googleReason || "").toLowerCase() === "notfound";
        if (!shouldFallbackToLocalTemplate) {
          throw copyError;
        }
        logger.warn("savePacRowsToDrive template copy failed, falling back to local template", {
          templateSheetId,
          ...metadata,
        });
        copied = await pacCreateSpreadsheetFromLocalTemplate(accessToken, outputTitle);
        templateSource = "local_template_fallback_notfound";
      }
    } else {
      copied = await pacCreateSpreadsheetFromLocalTemplate(accessToken, outputTitle);
    }

    let targetSheetName = "";
    let writeSummary = null;
    let encabezadoWriteSummary = null;
    try {
      targetSheetName = await pacResolveSheetName(accessToken, copied.id, requestedSheetName);
      encabezadoWriteSummary = await pacWriteEncabezadoToSheet(
        accessToken,
        copied.id,
        targetSheetName,
        encabezadoPac
      );
      writeSummary = await pacWriteRowsToSheet(accessToken, copied.id, targetSheetName, startRow, rows);
      const outputSheetUrl = `https://docs.google.com/spreadsheets/d/${copied.id}/edit`;
      const rowsWritten = Number(writeSummary?.rowsWritten || 0);

      if (delivery === "download") {
        const xlsxBuffer = await pacExportSpreadsheetAsXlsx(accessToken, copied.id);
        const cleanTitle = pacNormalizeText(copied.name || outputTitle || "PAC");
        const fileName = `${cleanTitle || "PAC"}.xlsx`;
        try {
          await registerTenantMetricEvent({
            tenantId,
            uid,
            email: authEmail,
            eventType: "pac_descargado",
            source: "pac",
            metadata: {
              delivery,
              mode,
              rowsReceived: rows.length,
              rowsWritten,
              fileName,
              templateSource,
            },
          });
        } catch (metricError) {
          logger.warn("savePacRowsToDrive metric event failed", {
            tenantId,
            uid,
            eventType: "pac_descargado",
            message: shortText(metricError?.message || "metric_write_failed", 280),
          });
        }
        return {
          ok: true,
          delivery,
          rowsReceived: rows.length,
          rowsWritten,
          fileName,
          fileMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          fileBase64: xlsxBuffer.toString("base64"),
          writeSummary,
          encabezadoWriteSummary,
          templateSource,
          diagnostics: {
            requiredScopes,
            grantedScopes,
            missingScopes,
            tokenAudience: tokenInfo?.audience || "",
            tokenEmail: tokenInfo?.email || "",
          },
        };
      }

      try {
        await registerTenantMetricEvent({
          tenantId,
          uid,
          email: authEmail,
          eventType: "pac_guardado_drive",
          source: "pac",
          metadata: {
            delivery,
            mode,
            rowsReceived: rows.length,
            rowsWritten,
            sheetId: copied.id,
            sheetName: targetSheetName,
            templateSource,
          },
        });
      } catch (metricError) {
        logger.warn("savePacRowsToDrive metric event failed", {
          tenantId,
          uid,
          eventType: "pac_guardado_drive",
          message: shortText(metricError?.message || "metric_write_failed", 280),
        });
      }

      return {
        ok: true,
        delivery,
        rowsReceived: rows.length,
        rowsWritten,
        sheetId: copied.id,
        sheetName: targetSheetName,
        sheetUrl: outputSheetUrl,
        downloadXlsxUrl: `https://docs.google.com/spreadsheets/d/${copied.id}/export?format=xlsx`,
        writeSummary,
        encabezadoWriteSummary,
        templateSource,
        diagnostics: {
          requiredScopes,
          grantedScopes,
          missingScopes,
          tokenAudience: tokenInfo?.audience || "",
          tokenEmail: tokenInfo?.email || "",
        },
      };
    } finally {
      if (delivery === "download") {
        try {
          await pacDeleteDriveFile(accessToken, copied.id);
        } catch (deleteError) {
          logger.warn("savePacRowsToDrive download cleanup failed", {
            fileId: copied.id,
            message: String(deleteError?.message || "delete failed"),
          });
        }
      }
    }
  } catch (error) {
    const errorMetadata = pacBuildErrorMetadata(error);
    logger.error("savePacRowsToDrive error", {
      templateSheetId,
      requestedSheetName,
      startRow,
      rowsCount: rows.length,
      delivery,
      ...errorMetadata,
    });
    throw new HttpsError(
      "failed-precondition",
      `No se pudo generar el archivo PAC: ${error.message || "sin detalle"}`,
      {
        errorType: "save_pac_drive_failed",
        templateSheetId,
        requestedSheetName,
        startRow,
        rowsCount: rows.length,
        delivery,
        ...errorMetadata,
      }
    );
  }
});

function pacTimestampFromUnknown(value) {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value?.toMillis === "function") {
    try {
      const millis = Number(value.toMillis());
      return Number.isFinite(millis) ? millis : 0;
    } catch (_error) {
      return 0;
    }
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : 0;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return 0;
    }
    return value < 2_000_000_000 ? Math.floor(value * 1000) : Math.floor(value);
  }
  const raw = String(value || "").trim();
  if (!raw) {
    return 0;
  }
  const parsedAsNumber = Number(raw);
  if (Number.isFinite(parsedAsNumber)) {
    return parsedAsNumber < 2_000_000_000
      ? Math.floor(parsedAsNumber * 1000)
      : Math.floor(parsedAsNumber);
  }
  const parsedAsDate = Date.parse(raw);
  return Number.isFinite(parsedAsDate) ? parsedAsDate : 0;
}

function pacUniqueStrings(values = []) {
  const source = Array.isArray(values) ? values : [];
  const seen = new Set();
  const result = [];
  source.forEach((value) => {
    const safe = String(value || "").trim();
    if (!safe) {
      return;
    }
    if (seen.has(safe)) {
      return;
    }
    seen.add(safe);
    result.push(safe);
  });
  return result;
}

function pacExtractEmailsFromText(rawValue) {
  const value = String(rawValue || "");
  if (!value) {
    return [];
  }
  const matches = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return pacUniqueStrings(matches.map((entry) => normalizeEmail(entry)));
}

function pacExtractSingleEmail(rawValue) {
  const list = pacExtractEmailsFromText(rawValue);
  return list[0] || "";
}

function pacBuildSenderCandidates(senderEmail) {
  const primary = normalizeEmail(senderEmail || "");
  const canonical = normalizeEmailForAllowlist(primary);
  return pacUniqueStrings([primary, canonical]);
}

async function pacResolveTenantBySenderEmail(senderEmail) {
  const candidates = pacBuildSenderCandidates(senderEmail);
  if (!candidates.length) {
    return {
      resolved: false,
      reason: "sender_email_missing",
      senderEmail: "",
      tenantId: "",
      uid: "",
      appEnabled: false,
      matchedField: "",
      matchedValue: "",
    };
  }

  const fields = ["correo", "correoAlt"];
  let fallback = null;

  for (const candidate of candidates) {
    for (const fieldName of fields) {
      const snapshot = await db
        .collection("usuarios")
        .where(fieldName, "==", candidate)
        .limit(3)
        .get();

      if (snapshot.empty) {
        continue;
      }

      for (const doc of snapshot.docs) {
        const profile = doc.data() || {};
        const tenantId = profileTenantId(profile);
        const appEnabled = profileAccessAppEnabled(profile);
        const resolution = {
          resolved: Boolean(tenantId && appEnabled),
          reason: tenantId
            ? (appEnabled ? "resolved" : "access_not_enabled")
            : "tenant_not_assigned",
          senderEmail: candidate,
          tenantId,
          uid: doc.id,
          appEnabled,
          matchedField: fieldName,
          matchedValue: candidate,
        };

        if (resolution.resolved) {
          return resolution;
        }
        if (!fallback) {
          fallback = resolution;
        }
      }
    }
  }

  return fallback || {
    resolved: false,
    reason: "user_not_found",
    senderEmail: candidates[0] || "",
    tenantId: "",
    uid: "",
    appEnabled: false,
    matchedField: "",
    matchedValue: "",
  };
}

function pacExtractDestinationEmailsFromPayload(payload = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const rawCandidates = [];
  const pushCandidate = (value) => {
    if (Array.isArray(value)) {
      value.forEach((item) => rawCandidates.push(String(item || "")));
      return;
    }
    if (value !== undefined && value !== null) {
      rawCandidates.push(String(value || ""));
    }
  };

  pushCandidate(source.to);
  pushCandidate(source.recipient);
  pushCandidate(source.recipients);
  pushCandidate(source.destination);
  pushCandidate(source.toEmail);
  pushCandidate(source.to_email);
  pushCandidate(source.envelope?.to);
  pushCandidate(source.envelopeTo);
  pushCandidate(source.headers?.to);

  const emails = [];
  rawCandidates.forEach((raw) => {
    emails.push(...pacExtractEmailsFromText(raw));
  });
  return pacUniqueStrings(emails);
}

function pacExtractInboundBodyText(payload = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const textCandidates = [
    source.text,
    source.bodyPlain,
    source.bodyText,
    source["body-plain"],
    source.strippedText,
    source["stripped-text"],
    source.body,
  ];

  for (const candidate of textCandidates) {
    const safe = String(candidate || "").trim();
    if (safe) {
      return safe;
    }
  }

  const htmlCandidates = [
    source.html,
    source.bodyHtml,
    source["body-html"],
    source.strippedHtml,
    source["stripped-html"],
  ];
  for (const candidate of htmlCandidates) {
    const safeHtml = String(candidate || "").trim();
    if (!safeHtml) {
      continue;
    }
    const htmlAsText = pacStripHtml(safeHtml);
    if (htmlAsText) {
      return htmlAsText;
    }
  }
  return "";
}

function pacNormalizeRowValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 40)
      .map((entry) => shortText(entry, 160))
      .filter(Boolean);
  }
  if (typeof value === "object") {
    return shortText(JSON.stringify(value), 1200);
  }
  return shortText(value, 280);
}

function pacNormalizeStoredRows(rawRows = []) {
  const sourceRows = Array.isArray(rawRows) ? rawRows : [];
  return sourceRows
    .slice(0, PAC_PROCESSED_MAX_ROWS_PER_ITEM)
    .map((rawRow) => {
      if (!rawRow || typeof rawRow !== "object") {
        return null;
      }
      const normalizedRow = {};
      Object.entries(rawRow).forEach(([rawKey, rawValue]) => {
        const key = shortText(rawKey, 80);
        if (!key) {
          return;
        }
        normalizedRow[key] = pacNormalizeRowValue(rawValue);
      });

      if (Array.isArray(normalizedRow.missingFields)) {
        normalizedRow.missingFields = normalizedRow.missingFields
          .map((entry) => shortText(entry, 80))
          .filter(Boolean);
      }
      return normalizedRow;
    })
    .filter(Boolean);
}

function pacExtractRowsFromPayloadObject(payload = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const candidates = [
    source.rows,
    source.pacRows,
    source.extractedRows,
    source.dataRows,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) {
      return pacNormalizeStoredRows(candidate);
    }
  }
  return [];
}

function pacDecodeBase64Flexible(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    return Buffer.from("");
  }
  const clean = raw.includes(",") && raw.startsWith("data:")
    ? raw.slice(raw.indexOf(",") + 1)
    : raw;
  let buffer = Buffer.from("");
  try {
    buffer = pacDecodeBase64Url(clean, true);
  } catch (_error) {
    buffer = Buffer.from("");
  }
  if (buffer.length) {
    return buffer;
  }
  try {
    return Buffer.from(clean, "base64");
  } catch (_error) {
    return Buffer.from("");
  }
}

function pacExtractRowsFromInboundAttachments(payload = {}, meta = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const attachments = Array.isArray(source.attachments) ? source.attachments : [];
  const rows = [];

  attachments.forEach((item, index) => {
    const attachment = item && typeof item === "object" ? item : {};
    const attachmentName = shortText(
      attachment.filename ||
      attachment.name ||
      `attachment_${index + 1}`,
      180
    );
    const lowerName = attachmentName.toLowerCase();
    const isDocx = lowerName.endsWith(".docx")
      || String(attachment.contentType || "").toLowerCase().includes("wordprocessingml");
    if (!isDocx) {
      return;
    }

    const encodedContent = String(
      attachment.contentBase64 ||
      attachment.base64 ||
      attachment.data ||
      attachment.content ||
      ""
    ).trim();
    if (!encodedContent) {
      return;
    }

    try {
      const docxBuffer = pacDecodeBase64Flexible(encodedContent);
      if (!docxBuffer.length) {
        return;
      }
      const docxText = pacExtractDocxText(docxBuffer);
      const extracted = pacExtractPacRow(docxText, {
        messageId: String(meta.messageId || ""),
        subject: String(meta.subject || ""),
        from: String(meta.from || ""),
        date: String(meta.date || ""),
        attachmentName,
      });
      if (pacFieldScore(extracted) >= 3 || pacRowHasDniOrCuil(extracted) || pacRowHasCupof(extracted)) {
        rows.push(extracted);
      }
    } catch (error) {
      logger.warn("ingestPacForwardedEmail attachment parsing failed", {
        attachmentName,
        message: shortText(error?.message || "attachment_parse_failed", 280),
      });
    }
  });

  return rows;
}

function pacExtractRowsFromBodyText(bodyText = "", meta = {}) {
  const safeBody = String(bodyText || "").trim();
  if (!safeBody) {
    return [];
  }
  const extracted = pacExtractPacRow(safeBody, meta);
  const hasEnoughSignals =
    pacFieldScore(extracted) >= 3 ||
    pacRowHasDniOrCuil(extracted) ||
    pacRowHasCupof(extracted);
  return hasEnoughSignals ? [extracted] : [];
}

function pacBuildRowDedupKey(row = {}) {
  const safeRow = row && typeof row === "object" ? row : {};
  const keyParts = [
    pacNormalizeComparable(safeRow.cupof || ""),
    pacNormalizeComparable(safeRow.dni || ""),
    pacNormalizeComparable(safeRow.cuil || ""),
    pacNormalizeComparable(safeRow.pid || ""),
    pacNormalizeComparable(safeRow.curso || ""),
    pacNormalizeComparable(safeRow.division || ""),
    pacNormalizeComparable(safeRow.apellidoNombre || ""),
  ];
  return keyParts.join("|");
}

function pacDeduplicateRows(rows = []) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const seen = new Set();
  const uniqueRows = [];
  sourceRows.forEach((row) => {
    const safeRow = row && typeof row === "object" ? row : null;
    if (!safeRow) {
      return;
    }
    const key = pacBuildRowDedupKey(safeRow);
    if (key && seen.has(key)) {
      return;
    }
    if (key) {
      seen.add(key);
    }
    uniqueRows.push(safeRow);
  });
  return uniqueRows;
}

function pacBuildProcessedDocSummary({
  id = "",
  storageType = "subcollection",
  legacyIndex = -1,
  data = {},
  includeRows = false,
  rowsPerItemLimit = PAC_PROCESSED_LIST_ROWS_DEFAULT_LIMIT,
}) {
  const source = data && typeof data === "object" ? data : {};
  const rows = Array.isArray(source.rows) ? source.rows : [];
  const rowsCount = Number(source.rowsCount || rows.length || 0);
  const createdAtMs = pacTimestampFromUnknown(source.createdAt);
  const updatedAtMs = pacTimestampFromUnknown(source.updatedAt);
  const receivedAtMs = pacTimestampFromUnknown(
    source.fechaRecepcionMs ||
    source.fechaRecepcion ||
    source.receivedAt
  );

  const safeId = String(id || "").trim();
  const summary = {
    id: safeId,
    docId: safeId,
    storageType: String(storageType || "subcollection"),
    legacyIndex: Number.isInteger(legacyIndex) ? legacyIndex : -1,
    origenEmail: normalizeEmail(source.origenEmail || source.from || ""),
    destinoEmail: normalizeEmail(source.destinoEmail || source.to || ""),
    asunto: shortText(source.asunto || source.subject || "", 220),
    fechaRecepcion: shortText(source.fechaRecepcion || source.date || "", 120),
    fechaRecepcionMs: receivedAtMs,
    estado: shortText(source.estado || "", 80) || "procesado",
    source: shortText(source.source || "email_forward", 80),
    cuerpoResumen: shortText(source.cuerpoResumen || source.bodySummary || "", 420),
    rowsCount: rowsCount > 0 ? rowsCount : 0,
    createdAtMs,
    updatedAtMs,
  };
  if (!includeRows) {
    return summary;
  }
  const safeRowsLimit = Math.max(
    1,
    Math.min(
      PAC_PROCESSED_LIST_ROWS_MAX_LIMIT,
      Number.isFinite(Number(rowsPerItemLimit))
        ? Math.floor(Number(rowsPerItemLimit))
        : PAC_PROCESSED_LIST_ROWS_DEFAULT_LIMIT
    )
  );
  return {
    ...summary,
    rowsLoaded: true,
    rows: pacNormalizeStoredRows(rows).slice(0, safeRowsLimit),
  };
}

function pacSortProcessedEntries(entries = []) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  return list.sort((a, b) => {
    const aMs = Number(a?.fechaRecepcionMs || a?.updatedAtMs || a?.createdAtMs || 0);
    const bMs = Number(b?.fechaRecepcionMs || b?.updatedAtMs || b?.createdAtMs || 0);
    if (aMs !== bMs) {
      return bMs - aMs;
    }
    const aId = String(a?.id || "");
    const bId = String(b?.id || "");
    return bId.localeCompare(aId);
  });
}

exports.getProcessedPacList = onCall(callableOptions, async (request) => {
  if (!request?.auth) {
    throw new HttpsError("unauthenticated", "Auth required");
  }

  const uid = String(request.auth.uid || "").trim();
  const data = safeObject(request.data);
  const requestedLimit = Number(data.limit || PAC_PROCESSED_DEFAULT_LIMIT);
  const includeRows = data.includeRows === true;
  const requestedRowsPerItemLimit = Number(data.rowsPerItemLimit || PAC_PROCESSED_LIST_ROWS_DEFAULT_LIMIT);
  const rowsPerItemLimit = Math.max(
    1,
    Math.min(
      PAC_PROCESSED_LIST_ROWS_MAX_LIMIT,
      Number.isFinite(requestedRowsPerItemLimit)
        ? Math.floor(requestedRowsPerItemLimit)
        : PAC_PROCESSED_LIST_ROWS_DEFAULT_LIMIT
    )
  );
  const limit = Math.max(1, Math.min(
    PAC_PROCESSED_MAX_LIMIT,
    Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : PAC_PROCESSED_DEFAULT_LIMIT
  ));

  const tenantId = await getUserTenantId(uid);
  const tenantRef = db.collection("tenants").doc(tenantId);
  const subcollectionRef = tenantRef.collection("datosExtraidos");
  const summaries = [];

  let subcollectionSnap = null;
  try {
    subcollectionSnap = await subcollectionRef
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();
  } catch (error) {
    logger.warn("getProcessedPacList fallback query without orderBy", {
      tenantId,
      message: shortText(error?.message || "query_failed", 240),
    });
    subcollectionSnap = await subcollectionRef.limit(limit).get();
  }

  subcollectionSnap.forEach((docSnap) => {
    summaries.push(
      pacBuildProcessedDocSummary({
        id: docSnap.id,
        storageType: "subcollection",
        data: docSnap.data() || {},
        includeRows,
        rowsPerItemLimit,
      })
    );
  });

  const tenantSnap = await tenantRef.get();
  const tenantData = tenantSnap.exists ? (tenantSnap.data() || {}) : {};
  const legacyRows = Array.isArray(tenantData.datosExtraidos) ? tenantData.datosExtraidos : [];
  const legacyStart = Math.max(0, legacyRows.length - limit);
  for (let index = legacyRows.length - 1; index >= legacyStart; index -= 1) {
    const legacyItem = legacyRows[index];
    summaries.push(
      pacBuildProcessedDocSummary({
        id: `legacy_${index}`,
        storageType: "legacy_array",
        legacyIndex: index,
        data: legacyItem,
        includeRows,
        rowsPerItemLimit,
      })
    );
  }

  const ordered = pacSortProcessedEntries(summaries).slice(0, limit);
  return {
    ok: true,
    tenantId,
    items: ordered,
    diagnostics: {
      subcollectionCount: subcollectionSnap.size,
      legacyCount: legacyRows.length,
      includeRows,
      rowsPerItemLimit,
    },
  };
});

exports.getProcessedPacDetail = onCall(callableOptions, async (request) => {
  if (!request?.auth) {
    throw new HttpsError("unauthenticated", "Auth required");
  }

  const uid = String(request.auth.uid || "").trim();
  const data = safeObject(request.data);
  const storageType = String(data.storageType || "subcollection").trim().toLowerCase();
  const tenantId = await getUserTenantId(uid);
  const tenantRef = db.collection("tenants").doc(tenantId);

  if (storageType === "legacy_array") {
    const legacyIndex = Number(data.legacyIndex);
    if (!Number.isInteger(legacyIndex) || legacyIndex < 0) {
      throw new HttpsError("invalid-argument", "legacyIndex is required for legacy_array");
    }
    const tenantSnap = await tenantRef.get();
    const tenantData = tenantSnap.exists ? (tenantSnap.data() || {}) : {};
    const legacyRows = Array.isArray(tenantData.datosExtraidos) ? tenantData.datosExtraidos : [];
    if (legacyIndex >= legacyRows.length) {
      throw new HttpsError("not-found", "Legacy PAC entry not found");
    }
    const legacyData = legacyRows[legacyIndex] || {};
    return {
      ok: true,
      tenantId,
      item: {
        ...pacBuildProcessedDocSummary({
          id: `legacy_${legacyIndex}`,
          storageType: "legacy_array",
          legacyIndex,
          data: legacyData,
        }),
        rows: pacNormalizeStoredRows(legacyData.rows || []),
      },
    };
  }

  const docId = shortText(data.docId || data.id || "", 160);
  if (!docId) {
    throw new HttpsError("invalid-argument", "docId is required");
  }
  const docRef = tenantRef.collection("datosExtraidos").doc(docId);
  const docSnap = await docRef.get();
  if (!docSnap.exists) {
    throw new HttpsError("not-found", "PAC processed entry not found");
  }
  const entry = docSnap.data() || {};
  return {
    ok: true,
    tenantId,
    item: {
      ...pacBuildProcessedDocSummary({
        id: docSnap.id,
        storageType: "subcollection",
        data: entry,
      }),
      rows: pacNormalizeStoredRows(entry.rows || []),
    },
  };
});

exports.ingestPacForwardedEmail = onRequest(
  {
    invoker: "public",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send({ ok: false, error: "method_not_allowed" });
      return;
    }

    const payload = safeObject(req.body);
    const query = safeObject(req.query);
    const headers = safeObject(req.headers);
    const expectedToken = shortText(process.env.PAC_EMAIL_INGEST_TOKEN || "", 240);
    const providedToken = shortText(
      headers["x-paneldocente-ingest-token"] ||
      headers["x_paneldocente_ingest_token"] ||
      query.token ||
      payload.token ||
      "",
      240
    );
    if (expectedToken && providedToken !== expectedToken) {
      res.status(401).send({ ok: false, error: "invalid_ingest_token" });
      return;
    }

    const senderRaw = String(
      payload.from ||
      payload.sender ||
      payload.fromEmail ||
      payload.from_email ||
      payload.envelope?.from ||
      payload.envelopeFrom ||
      payload.headers?.from ||
      ""
    );
    const senderEmail = pacExtractSingleEmail(senderRaw);
    const destinationCandidates = pacExtractDestinationEmailsFromPayload(payload);
    const destinationEmail = destinationCandidates.find((email) => email === PAC_FORWARD_DESTINATION_EMAIL)
      || destinationCandidates[0]
      || PAC_FORWARD_DESTINATION_EMAIL;

    const subject = shortText(payload.subject || payload.asunto || "", 220);
    const messageId = shortText(
      payload.messageId ||
      payload.message_id ||
      payload.headers?.["message-id"] ||
      "",
      220
    );
    const receivedAtMs = pacTimestampFromUnknown(
      payload.fechaRecepcion ||
      payload.receivedAt ||
      payload.date ||
      payload.timestamp
    ) || Date.now();
    const receivedAtIso = new Date(receivedAtMs).toISOString();
    const bodyText = pacExtractInboundBodyText(payload);
    const bodySummary = shortText(bodyText, 3200);

    const seedRows = pacExtractRowsFromPayloadObject(payload);
    const bodyRows = pacExtractRowsFromBodyText(bodyText, {
      messageId,
      subject,
      from: senderEmail,
      date: receivedAtIso,
      attachmentName: "",
    });
    const attachmentRows = pacExtractRowsFromInboundAttachments(payload, {
      messageId,
      subject,
      from: senderEmail,
      date: receivedAtIso,
    });

    const mergedRows = pacDeduplicateRows([
      ...seedRows,
      ...bodyRows,
      ...attachmentRows,
    ]).slice(0, PAC_PROCESSED_MAX_ROWS_PER_ITEM);

    let processedRows = mergedRows;
    try {
      if (mergedRows.length) {
        processedRows = await pacEnrichRowsWithExternalData(mergedRows);
      }
    } catch (error) {
      logger.warn("ingestPacForwardedEmail pacEnrichRowsWithExternalData failed", {
        message: shortText(error?.message || "row_enrichment_failed", 280),
      });
    }

    const tenantResolution = await pacResolveTenantBySenderEmail(senderEmail);
    const now = admin.firestore.FieldValue.serverTimestamp();
    const baseDoc = {
      origenEmail: senderEmail || null,
      destinoEmail: destinationEmail || null,
      asunto: subject || null,
      fechaRecepcion: receivedAtIso,
      fechaRecepcionMs: receivedAtMs,
      cuerpoResumen: bodySummary || null,
      rows: pacNormalizeStoredRows(processedRows),
      rowsCount: processedRows.length,
      estado: tenantResolution.resolved ? "procesado" : "sin_tenant",
      source: "email_forward",
      ingestion: {
        provider: shortText(payload.provider || payload.source || payload.service || "", 120) || null,
        messageId: messageId || null,
        matchedField: shortText(tenantResolution.matchedField || "", 80) || null,
        matchedValue: shortText(tenantResolution.matchedValue || "", 160) || null,
        matchedUid: shortText(tenantResolution.uid || "", 160) || null,
        destinationMatchesConfigured: destinationEmail === PAC_FORWARD_DESTINATION_EMAIL,
      },
      updatedAt: now,
      createdAt: now,
    };

    if (tenantResolution.resolved && tenantResolution.tenantId) {
      const tenantId = tenantResolution.tenantId;
      const targetRef = db.collection("tenants").doc(tenantId).collection("datosExtraidos").doc();
      await targetRef.set({
        ...baseDoc,
        tenantId,
      });

      res.status(200).send({
        ok: true,
        status: "stored",
        tenantId,
        docId: targetRef.id,
        rowsCount: processedRows.length,
      });
      return;
    }

    const unidentifiedRef = db.collection("emailsNoIdentificados").doc();
    await unidentifiedRef.set({
      ...baseDoc,
      resolutionReason: shortText(tenantResolution.reason || "sin_tenant", 120),
    });

    res.status(202).send({
      ok: true,
      status: "stored_without_tenant",
      reason: shortText(tenantResolution.reason || "sin_tenant", 120),
      docId: unidentifiedRef.id,
      rowsCount: processedRows.length,
    });
  }
);
