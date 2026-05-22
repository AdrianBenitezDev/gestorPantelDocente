# Contexto Tecnico Unificado
_Actualizado: 2026-05-21_

## Objetivo
Este workspace (`carpetaPanelDocente`) tiene 3 repos que operan como un solo sistema.  
Este documento define arquitectura, contratos e interfaces para trabajar sin romper integraciones.

## Componentes
| Componente | Carpeta | Rol | Stack | Deploy |
|---|---|---|---|---|
| Web principal | `panelDocente` | Producto principal (registro, suscripciones, PAC) | Firebase Hosting + Cloud Functions v2 + Firestore | Firebase project `horario-escuelas` |
| Email worker | `paneldocente-email-worker` | Ingestion de emails PAC | Cloudflare Email Worker (`wrangler`) | Cloudflare Workers |
| Panel admin | `adminPanelDocente` | Administracion de usuarios y estado de pago | Express + Firebase Functions + Hosting estatico | Firebase project `horario-escuelas` (target admin) |

## Limites de Responsabilidad
| Si la tarea es... | Repo owner |
|---|---|
| UI/UX web, PAC en frontend, registro/login, suscripciones | `panelDocente` |
| Parseo de correos, adjuntos DOCX y POST al webhook | `paneldocente-email-worker` |
| Listado/admin de usuarios, bloqueo/desbloqueo, API admin | `adminPanelDocente` |

## Contratos Entre Repos
| Productor | Consumidor | Contrato | Estado |
|---|---|---|---|
| `paneldocente-email-worker` | `panelDocente/functions` | HTTP `ingestPacForwardedEmail` | Activo |
| `panelDocente/frontend/js` | `panelDocente/functions` | Callable names exactos (`runPacProcess`, `savePacRowsToDrive`, etc.) | Activo |
| `adminPanelDocente/public` | `adminPanelDocente/functions` | `/api/admin/users`, `/api/admin/users/:uid/disabled`, `/health` | Activo |

## Contrato Email PAC (Cloudflare -> Firebase)
### Endpoint destino
- `https://us-central1-horario-escuelas.cloudfunctions.net/ingestPacForwardedEmail`

### Auth
- Header: `x-paneldocente-ingest-token`
- Worker secret: `PAC_INGEST_TOKEN`
- Firebase expected secret: `PAC_EMAIL_INGEST_TOKEN`

### Payload minimo esperado
```json
{
  "from": "string",
  "to": "string",
  "subject": "string",
  "messageId": "string",
  "date": "ISO-8601",
  "provider": "cloudflare-email-worker",
  "source": "email_forward",
  "rows": [],
  "rowsCount": 0
}
```

### Persistencia en Firestore
- Si hay tenant resuelto: `tenants/{tenantId}/datosExtraidos`
- Si no hay tenant: `emailsNoIdentificados`

## Contrato Frontend <-> Functions (panelDocente)
### Callables criticos
- `registerUser`
- `checkRegisterEmailStatus`
- `startSubscriptionCheckout`
- `getSubscriptionStatus`
- `syncSubscriptionStatus`
- `registerSession`
- `runPacProcess`
- `savePacRowsToDrive`
- `getProcessedPacList`
- `getProcessedPacDetail`
- `obtenerEncabezadoPac`
- `actualizarEncabezadoPac`
- `actuaizarEncabezadoPac` (alias legacy con typo, mantener por compatibilidad)
- `obtenerConfiguracionPacExtraccion`
- `actualizarConfiguracionPacExtraccion`

### HTTP/Task en backend
- HTTP: `mercadoPagoWebhook`
- Task: `processMercadoPagoWebhookTask`
- HTTP: `ingestPacForwardedEmail`

## API Admin (adminPanelDocente)
### Endpoints
- `GET /api/admin/users`
- `PATCH /api/admin/users/:uid/disabled`
- `GET /health`

### Seguridad
- Header opcional: `x-admin-key`
- Secret: `ADMIN_PANEL_KEY`

## Reglas de No-Rotura
1. Cada carpeta es un repo independiente (cada una tiene `.git` propio).
2. No renombrar exports/callables/endpoints sin migracion coordinada del consumidor.
3. No eliminar alias legacy `actuaizarEncabezadoPac` hasta migrar frontend.
4. No cambiar secretos/token names en un solo lado (alinear worker + functions).
5. No mezclar deploys: cambios en un repo no implican deploy de los otros.

## Checklist Pre-Cambio
1. Identificar repo owner de la funcionalidad.
2. Verificar interfaz publica afectada (callable, endpoint, payload, secret, coleccion).
3. Si cambia contrato, actualizar productor y consumidor en el mismo cambio.
4. Confirmar compatibilidad legacy.
5. Probar el flujo principal del modulo tocado.

## Archivos Fuente de Verdad
- `panelDocente/functions/src/index.js`
- `panelDocente/frontend/js/pac.js`
- `panelDocente/frontend/js/pacProcessedService.js`
- `paneldocente-email-worker/src/index.js`
- `paneldocente-email-worker/wrangler.toml`
- `adminPanelDocente/server.js`
- `adminPanelDocente/functions/index.js`
- `panelDocente/firebase.json`
