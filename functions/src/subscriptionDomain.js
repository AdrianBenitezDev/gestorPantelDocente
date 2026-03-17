"use strict";

function mapMercadoPagoStatusToBillingStatus(rawStatus) {
  const status = String(rawStatus || "").trim().toLowerCase();
  if (status === "authorized") return "active";
  if (status === "pending") return "pending_confirmation";
  if (status === "paused") return "paused";
  if (status === "cancelled") return "cancelled";
  if (status === "rejected") return "rejected";
  if (status === "expired") return "expired";
  return "error";
}

function normalizeBillingStatus(value) {
  if (value === null || value === undefined) {
    return "null";
  }
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || "null";
}

function resolveNextRouteForProfile(profile) {
  if (!profile || typeof profile !== "object") {
    return "/registro.html";
  }

  const tenantId = String(profile.tenantId || "").trim();
  const appEnabled = profile?.access?.appEnabled === true;
  if (appEnabled && tenantId) {
    return "/index.html";
  }

  const billingStatus = normalizeBillingStatus(profile?.billing?.status);
  if ([
    "pending_confirmation",
    "rejected",
    "cancelled",
    "expired",
    "paused",
    "error",
  ].includes(billingStatus)) {
    return "/estado-suscripcion.html";
  }

  return "/activar-plan.html";
}

module.exports = {
  mapMercadoPagoStatusToBillingStatus,
  normalizeBillingStatus,
  resolveNextRouteForProfile,
};
