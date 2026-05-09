"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  mapMercadoPagoStatusToBillingStatus,
  normalizeBillingStatus,
  resolveNextRouteForProfile,
} = require("../src/subscriptionDomain");

test("mapMercadoPagoStatusToBillingStatus aplica mapping oficial", () => {
  assert.equal(mapMercadoPagoStatusToBillingStatus("authorized"), "active");
  assert.equal(mapMercadoPagoStatusToBillingStatus("pending"), "pending_confirmation");
  assert.equal(mapMercadoPagoStatusToBillingStatus("paused"), "paused");
  assert.equal(mapMercadoPagoStatusToBillingStatus("cancelled"), "cancelled");
  assert.equal(mapMercadoPagoStatusToBillingStatus("rejected"), "rejected");
  assert.equal(mapMercadoPagoStatusToBillingStatus("expired"), "expired");
  assert.equal(mapMercadoPagoStatusToBillingStatus("unknown_status"), "error");
});

test("normalizeBillingStatus normaliza null/undefined y texto", () => {
  assert.equal(normalizeBillingStatus(null), "null");
  assert.equal(normalizeBillingStatus(undefined), "null");
  assert.equal(normalizeBillingStatus("  "), "null");
  assert.equal(normalizeBillingStatus(" Active "), "active");
});

test("routing: usuario sin perfil va a registro", () => {
  assert.equal(resolveNextRouteForProfile(null), "/registro.html");
  assert.equal(resolveNextRouteForProfile(undefined), "/registro.html");
  assert.equal(resolveNextRouteForProfile("bad_payload"), "/registro.html");
});

test("routing: usuario activo con tenant entra a selector PAC", () => {
  const route = resolveNextRouteForProfile({
    tenantId: "tenant_123",
    access: { appEnabled: true },
    billing: { status: "active" },
  });
  assert.equal(route, "/pac.html");
});

test("routing: usuario sin pago (status null) va a activar-plan", () => {
  const route = resolveNextRouteForProfile({
    tenantId: "",
    access: { appEnabled: false },
    billing: { status: null },
  });
  assert.equal(route, "/activar-plan.html");
});

test("routing: usuario en pending_checkout va a activar-plan", () => {
  const route = resolveNextRouteForProfile({
    tenantId: "",
    access: { appEnabled: false },
    billing: { status: "pending_checkout" },
  });
  assert.equal(route, "/activar-plan.html");
});

test("routing: usuario rechazado o pendiente de confirmacion va a estado-suscripcion", () => {
  const rejectedRoute = resolveNextRouteForProfile({
    tenantId: "",
    access: { appEnabled: false },
    billing: { status: "rejected" },
  });
  const pendingRoute = resolveNextRouteForProfile({
    tenantId: "",
    access: { appEnabled: false },
    billing: { status: "pending_confirmation" },
  });
  assert.equal(rejectedRoute, "/estado-suscripcion.html");
  assert.equal(pendingRoute, "/estado-suscripcion.html");
});

test("routing: perfil con claves literales con punto mantiene compatibilidad", () => {
  const activeRoute = resolveNextRouteForProfile({
    tenantId: "tenant_compat",
    "access.appEnabled": true,
    "billing.status": "active",
  });
  const pendingRoute = resolveNextRouteForProfile({
    tenantId: "",
    "access.appEnabled": false,
    "billing.status": "pending_confirmation",
  });
  assert.equal(activeRoute, "/pac.html");
  assert.equal(pendingRoute, "/estado-suscripcion.html");
});
