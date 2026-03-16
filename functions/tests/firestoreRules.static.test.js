"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const RULES_PATH = path.resolve(__dirname, "..", "..", "firestore.rules");

function loadRules() {
  return fs.readFileSync(RULES_PATH, "utf8");
}

test("firestore.rules: bloquea writes cliente en billingAttempts", () => {
  const rules = loadRules();
  assert.match(
    rules,
    /match\s+\/billingAttempts\/\{attemptId\}\s*\{[\s\S]*allow\s+write:\s+if\s+false;/m
  );
});

test("firestore.rules: bloquea read/write cliente en billingEvents", () => {
  const rules = loadRules();
  assert.match(
    rules,
    /match\s+\/billingEvents\/\{eventId\}\s*\{[\s\S]*allow\s+read,\s*write:\s+if\s+false;/m
  );
});

test("firestore.rules: billingPlans es solo lectura cliente", () => {
  const rules = loadRules();
  assert.match(
    rules,
    /match\s+\/billingPlans\/\{planId\}\s*\{[\s\S]*allow\s+read:\s+if\s+isSignedIn\(\);[\s\S]*allow\s+write:\s+if\s+false;/m
  );
});

test("firestore.rules: /usuarios preserva campos sensibles", () => {
  const rules = loadRules();
  const requiredFragments = [
    "request.resource.data.tenantId == resource.data.tenantId",
    "request.resource.data.billing == resource.data.billing",
    "request.resource.data.access == resource.data.access",
    "request.resource.data.onboarding == resource.data.onboarding",
  ];
  requiredFragments.forEach((fragment) => {
    assert.ok(
      rules.includes(fragment),
      `No se encontro fragmento sensible esperado en reglas: ${fragment}`
    );
  });
});

