# העלאת Hipis לענן (חינם) — מדריך

המטרה: כתובת אינטרנט קבועה (למשל `https://hipus.onrender.com`) שעובדת מכל מחשב/טלפון,
בלי Node ובלי proxy מקומי. ה-token נשמר כ-secret בצד השרת.

## מה כבר מוכן בתיקייה
- `server.js`     — שרת אחד שמגיש את הדף + המחירים
- `package.json`  — אומר לענן איך להריץ (`npm start`)
- `.gitignore`    — מונע העלאת ה-token הסודי לאינטרנט
- `index.html`    — האתר

## שלב 1 — GitHub (אחסון הקוד)
1. היכנס ל-https://github.com → Sign up (חשבון חינמי).
2. למעלה מימין: **+** → **New repository**.
3. שם: `hipus`  ·  בחר **Private** (מומלץ)  ·  לחץ **Create repository**.
4. בעמוד הריק: **uploading an existing file** → גרור את כל קבצי התיקייה
   (חוץ מתיקיית Backup ומ-proxy.config.json — ה-.gitignore דואג לזה ממילא).
5. **Commit changes**.

## שלב 2 — Render (הרצת השרת)
1. היכנס ל-https://render.com → Sign up (אפשר עם GitHub).
2. **New +** → **Web Service** → חבר את ה-repository `hipus`.
3. הגדרות:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: **Free**
4. **Environment** → **Add Environment Variable**:
   - `TP_TOKEN`  = ה-API token שלך מ-Travelpayouts
   - `TP_MARKER` = `742171`
5. **Create Web Service** → המתן לבנייה (~2 דק׳).
6. תקבל כתובת כמו `https://hipus.onrender.com` — פתח אותה. זהו! 🎉

## הערות
- שכבה חינמית ב-Render: השרת "נרדם" אחרי ~15 דק׳ חוסר פעילות;
  הכניסה הראשונה אחריה לוקחת ~30–50 שניות, ואז מהיר.
- ה-token לא נשמר בקוד — רק כ-env var בענן וב-proxy.config.json מקומי.
- לעדכון האתר: מעלים קובץ מעודכן ל-GitHub → Render בונה מחדש אוטומטית.
