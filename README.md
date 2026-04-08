# MoyTrack — final Render-ready versiya

Bitta Render web service ichida frontend va backend birga ishlaydi.

## DevSMS uchun 2 ta shablon

### 1) service_done
Hurmatli mijoz, {car_name} ({car_number}) avtomobili bo'yicha quyidagi ma'lumot qayd etildi: {service_name}.
Sana: {date}.
Joriy probeg: {km} km.

### 2) service_reminder
Hurmatli mijoz, {car_name} ({car_number}) avtomobili bo'yicha {service_name} tavsiya etiladi.
Sana: {date}.
Joriy probeg: {km} km.
Manzil: Avto Oil Beshariq, mo'ljal: tekstil yonida.

## Muhim
- Frontend bazaga to'g'ridan-to'g'ri ulanmaydi.
- Asosiy saqlash: Firebase Realtime Database.
- SMS token backenddagi `.env` orqali ishlaydi.
- Frontend PIN kodi: `7070`.

## Render uchun kerakli env
- FIREBASE_URL
- FIREBASE_SERVICE_ACCOUNT_JSON
- DEVSMS_TOKEN
- SESSION_SECRET
- SMS_CALLBACK_URL


Interfeys soddalashtirildi: xodim faqat mashina, xizmat, xabar va tarix bilan ishlaydi. Xabar matnlari va ulanish sozlamalari backend orqali boshqariladi; frontendda shablon yaratish yo'q.


Firebase uchun ikki yo'ldan biri ishlaydi:
- FIREBASE_SERVICE_ACCOUNT_FILE=./firebase-service-account.json
- yoki FIREBASE_SERVICE_ACCOUNT_JSON ga bitta qator JSON
