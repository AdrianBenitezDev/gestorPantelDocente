# Suscripciones - Operacion Produccion

Fecha: 2026-03-16

## 1) Secrets requeridos

- `MP_ACCESS_TOKEN`
- `MP_WEBHOOK_SECRET`

Comandos (ejemplo):

```bash
firebase functions:secrets:set MP_ACCESS_TOKEN
firebase functions:secrets:set MP_WEBHOOK_SECRET
```

## 2) Webhook durable (Cloud Tasks)

### Implementado en codigo

- Webhook HTTP: `mercadoPagoWebhook`
  - guarda evento en `/billingEvents/{autoId}`
  - responde `200` rapido
  - encola procesamiento durable en `processMercadoPagoWebhookTask` (Cloud Tasks)
- Worker de cola: `processMercadoPagoWebhookTask` (`onTaskDispatched`)
  - reintentos configurados
  - ejecuta `processMercadoPagoWebhookEvent(...)`
- Punto de extension exacto: `enqueueMercadoPagoWebhookTask(...)` en `functions/src/index.js`
- Fallback de continuidad: si falla el enqueue, se intenta procesamiento inline y se marca `status = enqueue_failed`.

### Requiere infraestructura adicional (GCP/Firebase)

1. API habilitada:
   - `cloudtasks.googleapis.com`
2. IAM del runtime de Functions para encolar tasks:
   - rol recomendado: `roles/cloudtasks.enqueuer`
3. Deploy de Functions para crear/actualizar la task queue function:
   - `firebase deploy --only functions`

Nota:
- Mientras la cola no este operativa, el fallback inline mantiene continuidad pero no reemplaza durabilidad.

## 3) Migracion de usuarios (billing/access/onboarding)

Dry-run:

```bash
npm --prefix functions run migrate:billing:dry-run -- --project horario-escuelas
```

Revision:
- inspeccionar JSON generado en `docs/migraciones/`
- revisar inconsistencias ambiguas manualmente

Apply:

```bash
npm --prefix functions run migrate:billing:apply -- --project horario-escuelas
```

## 4) Deploy

Functions:

```bash
firebase deploy --only functions
```

Rules:

```bash
firebase deploy --only firestore:rules
```

Indexes:

```bash
firebase deploy --only firestore:indexes
```

## 5) Reglas sobre tenants/**

Se endurecio acceso por pertenencia activa al tenant:

- condicion base: `usuarios/{uid}.tenantId == tenantId` y `access.appEnabled == true`

Rutas cliente habilitadas por compatibilidad actual frontend:

- `tenants/{tenantId}`: lectura
- `tenants/{tenantId}/configuraciones/turnosAndHorarios`: lectura/escritura
- `tenants/{tenantId}/configuraciones/tunosAndHorarios`: lectura/escritura (legacy typo)
- `tenants/{tenantId}/botones/{docId}`: lectura/escritura
- `tenants/{tenantId}/docentes/{docId}`: lectura/escritura
- `tenants/{tenantId}/cursos/{cursoId}`: lectura
- `tenants/{tenantId}/cursos/{cursoId}/items/{itemId}`: lectura/escritura

Todo lo demas en `tenants/**` queda denegado.

## 6) Verificacion manual E2E

1. Usuario nuevo -> checkout aprobado
   - se activa `billing.status = active`
   - `access.appEnabled = true`
   - se crea `tenantId`
2. Usuario nuevo -> checkout rechazado
   - no se crea tenant
   - va a `estado-suscripcion`
3. Webhook
   - evento en `/billingEvents`
   - `status = enqueued` y luego `processed`
4. Fallback
   - si enqueue falla, evento queda `enqueue_failed` y se intenta inline
5. Sync manual
   - `syncSubscriptionStatus` recupera estado si webhook no llega

## 7) Estructura minima creada al activar suscripcion

En `ensureBillingActivation` se crea/asegura:

- `/tenants/{tenantId}`
  - `ownerUid`, `ownerEmail`, `ownerUsername`
  - `distrito`, `nivel`, `escuela`
  - `planCode`, `status`
- `/tenants/{tenantId}/configuraciones/turnosAndHorarios`
- `/tenants/{tenantId}/configuraciones/pacExtraccion`
- `/tenants/{tenantId}/configuraciones/encabezadoPac`
- `/tenants/{tenantId}/botones/config`

## 8) Callables que requieren suscripcion activa (tenant gate)

Se validan con `getUserTenantId(uid)`:

- `registerSession`
- `loadDocentesFromSheet`
- `saveImportedDocente`
- `loadCursosFromSheet`
- `saveImportedCurso`
- `actuaizarEncabezadoPac`
- `obtenerEncabezadoPac`
- `actualizarConfiguracionPacExtraccion`
- `obtenerConfiguracionPacExtraccion`
- `savePacRowsToDrive`

Recomendacion operacional:
- no invocar estas funciones fuera de contexto activo.
- front pre-activacion debe usar `getSubscriptionStatus`, `startSubscriptionCheckout` y `syncSubscriptionStatus`.
