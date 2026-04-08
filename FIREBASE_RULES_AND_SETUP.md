# Firebase xavfsiz ulash

Bu loyiha uchun tavsiya etilgan yo'l:

- Frontend Firebase Realtime Database'ga to'g'ridan-to'g'ri ulanmaydi.
- Backend Firebase Admin SDK orqali ulanadi.
- Realtime Database Security Rules to'liq yopiladi.

## 1) Rules
Firebase Console -> Realtime Database -> Rules bo'limiga `firebase.rules.json` dagi rules'ni qo'ying.

## 2) Backend env
`.env` ichiga quyidagilarni kiriting:

- `FIREBASE_URL=https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com`
- `FIREBASE_SERVICE_ACCOUNT_JSON={...}`

`FIREBASE_SERVICE_ACCOUNT_JSON` qiymati Firebase / Google Cloud service account JSON faylining butun matni bo'lishi kerak.

## 3) Ishlash mantig'i
- Frontend -> Backend -> Firebase Admin SDK -> Realtime Database
- Security Rules tashqi klientlarni bloklaydi
- Admin SDK server muhiti uchun ishlaydi


## Muhim eslatma
Production uchun `ALLOW_FIREBASE_REST_FALLBACK=false` qoldiring. Frontend bazaga to'g'ridan-to'g'ri ulanmaydi. Backend ishlashi uchun `FIREBASE_SERVICE_ACCOUNT_JSON` to'liq kiritilishi shart.
