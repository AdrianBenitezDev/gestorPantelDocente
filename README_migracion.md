# Migracion Firebase

Estructura inicial creada para separar la app nueva de `legacy_gas`.

## Estructura
- `frontend/`: web para Firebase Hosting.
- `functions/`: Cloud Functions (Node 20).
- `legacy_gas/`: codigo Apps Script original.

## Modulo migrado (v1)
- Registro de usuario: `registerUser` (Cloud Function callable).
- Login: Firebase Auth email/password desde frontend.
- Perfil: documento en Firestore `usuarios/{uid}`.
- Reserva de usuario: `usernames/{usuarioKey}`.

## Configuracion necesaria
1. Crear proyecto Firebase y vincularlo:
   - `firebase login`
   - `firebase use --add`
2. Instalar dependencias de Functions:
   - `cd functions`
   - `npm install`
3. Completar `firebaseConfig` en `frontend/js/app.js`.
4. Habilitar en Firebase Console:
   - Authentication -> Email/Password.
   - Firestore Database (modo produccion).

## Deploy
- `firebase deploy --only functions,hosting,firestore`

## Deploy automatico con GitHub Actions
Se agrego el workflow `.github/workflows/firebase-hosting-deploy.yml`.

Para activarlo:
1. Generar token local:
   - `firebase login:ci`
2. En GitHub repo -> Settings -> Secrets and variables -> Actions:
   - Crear secret `FIREBASE_TOKEN` con el valor generado.
3. Hacer `push` a `master` o `main`.

El workflow deploya Hosting con:
- `firebase deploy --only hosting --project horario-escuelas --non-interactive`

## Nota sobre verificacion de correo
La funcion `registerUser` genera `verificationLink` de Firebase Auth y lo devuelve para pruebas.
En produccion conviene enviar ese link por correo con un proveedor dedicado (SendGrid, Resend o SMTP).
