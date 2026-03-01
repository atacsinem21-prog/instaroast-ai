# InstaRoast AI

Instagram profil screenshot'unu yukleyip Gemini 1.5 Flash ile komik roast + Flex Score ureten web uygulamasi.

## 1) API anahtari al
- Google AI Studio: https://aistudio.google.com
- Gemini API key olustur.
- Projede `.env` dosyasi ac:

```env
GEMINI_API_KEY=buraya_api_key
GEMINI_MODEL=gemini-2.5-flash
SITE_URL=https://your-domain.vercel.app
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=service_role_key
PORT=3000
```

Supabase baglarsan case study URL'leri kalici olur. Supabase SQL Editor'de su tabloyu ac:

```sql
create table if not exists roast_cases (
  id text primary key,
  slug text unique not null,
  slug_label text not null,
  title text not null,
  roast text not null,
  flex_score int not null,
  created_at timestamptz not null default now()
);

create index if not exists roast_cases_created_at_idx on roast_cases (created_at desc);
create index if not exists roast_cases_flex_score_idx on roast_cases (flex_score desc);
```

## 2) Calistir
```bash
npm install
npm run dev
```
Tarayicida: `http://localhost:3000`

## 3) Mimari
- Ortak uygulama: `app.js`
- Local server: `server.js`
- Vercel serverless girisi: `api/index.js`
- Endpoint: `POST /api/roast`
- Leaderboard API: `GET /api/leaderboard`
- Programmatic SEO sayfalari: `GET /roast/:slug`
- Dinamik OG kart endpoint: `GET /og/score.svg`
- Veri katmani: Supabase (`roast_cases`) varsa kalici DB, yoksa lokal dosya fallback
- Frontend: `public/index.html` + `public/app.js`
- SEO sayfalari:
  - `public/en-iyi-instagram-profilleri.html`
  - `public/ai-roast-ornekleri.html`
  - `public/robots.txt`
  - Dinamik `sitemap.xml` route'u (`/sitemap.xml`)

## 4) Prompt / Model
Model fallback: `gemini-2.5-flash` -> `gemini-2.0-flash` -> `gemini-1.5-flash`

Prompt, modele sosyal medya elestirmeni rolu verip JSON cikisi ister:
- `roast` (metin)
- `flexScore` (0-100)
- `highlights` (kisa maddeler)

## 5) Ucretsiz deploy
### Vercel
1. Repo'yu GitHub'a push et.
2. Vercel'de projeyi import et.
3. Environment Variable ekle: `GEMINI_API_KEY`
4. Deploy et (`api/index.js` + `vercel.json` hazir).

### Railway
1. New Project > Deploy from GitHub.
2. `GEMINI_API_KEY` environment variable ekle.
3. Start command: `npm start`

## 6) Paylasim (Viral)
- Mobilde Web Share API ile sistem paylasim sayfasi acilir.
- Destek yoksa WhatsApp link fallback kullanilir.

## 7) Not
Instagram Story'e web'den dogrudan otomatik post atmak her zaman mumkun degildir; en guvenli yol Web Share API ile kullanicinin telefonundaki paylasim panelini acmaktir.
