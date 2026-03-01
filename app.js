const express = require("express");
const multer = require("multer");
const dotenv = require("dotenv");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require("@supabase/supabase-js");

dotenv.config();

const app = express();

const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));
app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024,
  },
});

const MODEL_CANDIDATES = [
  process.env.GEMINI_MODEL,
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
].filter(Boolean);

const DATA_DIR = process.env.VERCEL ? path.join("/tmp", "instaroast-data") : path.join(__dirname, "data");
const ROAST_STORE = path.join(DATA_DIR, "roasts.json");
const SITE_URL = (process.env.SITE_URL || "http://localhost:3000").replace(/\/$/, "");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_KEY = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_PUBLISHABLE_KEY;
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_KEY);
const supabase = USE_SUPABASE ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "uploads";
const memoryRoasts = [];
const CACHE_WINDOW_HOURS = Math.max(1, Number(process.env.CACHE_WINDOW_HOURS || 24));
let storageBucketChecked = false;

function extractJson(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    return fenced[1].trim();
  }

  const objectLike = text.match(/\{[\s\S]*\}/);
  return objectLike ? objectLike[0] : text;
}

function getRetryDelaySeconds(error) {
  const details = Array.isArray(error?.errorDetails) ? error.errorDetails : [];
  const retryInfo = details.find((item) => item?.["@type"] === "type.googleapis.com/google.rpc.RetryInfo");
  const retryDelay = retryInfo?.retryDelay;
  if (typeof retryDelay !== "string") {
    return null;
  }

  const match = retryDelay.match(/^(\d+)s$/);
  return match ? Number(match[1]) : null;
}

function shouldTryNextModel(error) {
  const status = error?.status;
  return status === 404 || status === 429;
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function trimText(input, maxLength) {
  const text = String(input || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function normalizeText(input) {
  return String(input || "").replace(/\s+/g, " ").trim();
}

function normalizeUsername(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9._]/g, "")
    .slice(0, 30);
}

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function getExtensionFromMimeType(mimeType) {
  const value = String(mimeType || "").toLowerCase();
  if (value.includes("png")) {
    return "png";
  }
  if (value.includes("jpeg") || value.includes("jpg")) {
    return "jpg";
  }
  if (value.includes("webp")) {
    return "webp";
  }
  if (value.includes("gif")) {
    return "gif";
  }
  return "bin";
}

function escapeHtml(input) {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function ensureStore() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.access(ROAST_STORE);
    return true;
  } catch {
    // Read-only environments (serverless) can fail here; caller can use memory fallback.
    return false;
  }
}

function readMemoryRoasts() {
  return [...memoryRoasts];
}

function writeMemoryRoasts(items) {
  memoryRoasts.length = 0;
  memoryRoasts.push(...items);
}

async function readRoasts() {
  const storageReady = await ensureStore();
  if (!storageReady) {
    return readMemoryRoasts();
  }

  try {
    const raw = await fs.readFile(ROAST_STORE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeRoasts(items) {
  const storageReady = await ensureStore();
  if (!storageReady) {
    writeMemoryRoasts(items);
    return;
  }

  try {
    await fs.writeFile(ROAST_STORE, JSON.stringify(items, null, 2), "utf8");
  } catch {
    writeMemoryRoasts(items);
  }
}

async function initializeLocalStore() {
  const storageReady = await ensureStore();
  if (!storageReady) {
    return;
  }

  try {
    await fs.access(ROAST_STORE);
  } catch {
    await fs.writeFile(ROAST_STORE, "[]", "utf8");
  }
}

initializeLocalStore().catch(() => {
  // Ignore init errors in serverless/runtime-restricted environments.
});

function mapDbRowToCaseItem(row) {
  return {
    id: row.id,
    slug: row.slug,
    slugLabel: row.slug_label,
    title: row.title,
    roast: row.roast,
    flexScore: row.flex_score,
    createdAt: row.created_at,
    imageUrl: row.image_url || null,
  };
}

function buildCaseTheme(score) {
  if (score >= 80) {
    return "vizyoner-profiller";
  }
  if (score >= 60) {
    return "en-komik-isletmeler";
  }
  if (score >= 40) {
    return "orta-seviye-flex";
  }
  return "en-cok-gomulenler";
}

function buildCaseTitle(caseItem) {
  return `En Acimasiz Instagram Roast Ornekleri - ${caseItem.slugLabel} Analizi`;
}

function buildOgImageUrl(score, shortRoast) {
  const params = new URLSearchParams({
    score: String(score),
    text: trimText(shortRoast, 90),
  });
  return `${SITE_URL}/og/score.svg?${params.toString()}`;
}

function makeCaseStudyPayload({ roast, flexScore }) {
  const score = Number.isFinite(Number(flexScore)) ? Math.max(0, Math.min(100, Number(flexScore))) : 0;
  const theme = buildCaseTheme(score);
  const seed = slugify(`${theme}-${Date.now().toString(36).slice(-4)}`) || `roast-${Date.now()}`;
  const slugLabel = seed.replace(/-/g, " ");
  const slug = `${theme}-${seed}`;

  return {
    id: `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    slug,
    slugLabel,
    title: buildCaseTitle({ slugLabel }),
    roast: normalizeText(roast),
    flexScore: score,
    createdAt: new Date().toISOString(),
  };
}

function makeCaseStudyPayloadWithProfile({ roast, flexScore, username, imageHash }) {
  const normalizedUser = normalizeUsername(username);
  const base = makeCaseStudyPayload({ roast, flexScore });
  if (!normalizedUser) {
    return { ...base, imageHash: imageHash || null };
  }

  const userSlug = slugify(normalizedUser) || normalizedUser.replace(/\./g, "-");
  return {
    ...base,
    slugLabel: normalizedUser,
    slug: `${userSlug}-${Date.now().toString(36).slice(-4)}`,
    title: `@${normalizedUser} Instagram Roast Analizi ve Flex Score`,
    imageHash: imageHash || null,
  };
}

function isWithinHours(isoDate, hours) {
  const dateMs = new Date(isoDate).getTime();
  if (!Number.isFinite(dateMs)) {
    return false;
  }
  const diff = Date.now() - dateMs;
  return diff >= 0 && diff <= hours * 60 * 60 * 1000;
}

async function saveCaseStudy(item) {
  if (USE_SUPABASE) {
    const basePayload = {
      id: item.id,
      slug: item.slug,
      slug_label: item.slugLabel,
      title: item.title,
      roast: item.roast,
      flex_score: item.flexScore,
      created_at: item.createdAt,
    };
    const payloadVariants = [
      { ...basePayload, image_hash: item.imageHash || null, image_url: item.imageUrl || null },
      { ...basePayload, image_url: item.imageUrl || null },
      { ...basePayload, image_hash: item.imageHash || null },
      basePayload,
    ];

    let error = null;
    for (const payload of payloadVariants) {
      const result = await supabase.from("roast_cases").upsert(payload, { onConflict: "id" });
      error = result.error;
      if (!error) {
        break;
      }
    }

    if (!error) {
      return;
    }
    console.error("Supabase save failed, falling back to local store:", error.message);
  }

  const current = await readRoasts();
  const next = [item, ...current].slice(0, 600);
  await writeRoasts(next);
}

async function attachImageMetaToCase(caseId, imageUrl, imageHash) {
  if (!USE_SUPABASE || !caseId) {
    return false;
  }

  const updates = [
    { image_url: imageUrl || null, image_hash: imageHash || null },
    { image_url: imageUrl || null },
    { image_hash: imageHash || null },
  ];

  for (const values of updates) {
    const { error } = await supabase.from("roast_cases").update(values).eq("id", caseId);
    if (!error) {
      return true;
    }
  }

  return false;
}

async function getAllRoasts() {
  if (USE_SUPABASE) {
    let { data, error } = await supabase
      .from("roast_cases")
      .select("id,slug,slug_label,title,roast,flex_score,created_at,image_url")
      .order("created_at", { ascending: false })
      .limit(1000);

    if (error && String(error.message || "").toLowerCase().includes("image_url")) {
      ({ data, error } = await supabase
        .from("roast_cases")
        .select("id,slug,slug_label,title,roast,flex_score,created_at")
        .order("created_at", { ascending: false })
        .limit(1000));
    }

    if (!error) {
      return (data || []).map(mapDbRowToCaseItem);
    }

    console.error("Supabase read failed, falling back to local store:", error.message);
  }

  return readRoasts();
}

function jsonLdForRoast(caseItem, roastUrl) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        name: "InstaRoast AI",
        applicationCategory: "EntertainmentApplication",
        operatingSystem: "Web",
        offers: {
          "@type": "Offer",
          price: "0",
          priceCurrency: "USD",
        },
        aggregateRating: {
          "@type": "AggregateRating",
          ratingValue: Math.max(1, Math.round(caseItem.flexScore / 20)),
          reviewCount: 1,
          bestRating: 5,
          worstRating: 1,
        },
        url: SITE_URL,
      },
      {
        "@type": "Review",
        itemReviewed: {
          "@type": "CreativeWork",
          name: caseItem.title,
        },
        author: {
          "@type": "Organization",
          name: "InstaRoast AI",
        },
        reviewBody: caseItem.roast,
        reviewRating: {
          "@type": "Rating",
          ratingValue: caseItem.flexScore,
          bestRating: 100,
          worstRating: 0,
        },
        url: roastUrl,
      },
    ],
  };
}

function renderRoastPage(caseItem) {
  const roastUrl = `${SITE_URL}/roast/${caseItem.slug}`;
  const title = caseItem.title;
  const description = trimText(
    `Flex Score ${caseItem.flexScore}/100. ${caseItem.roast} Arkadasina meydan oku ve kendi skorunu test et.`,
    160
  );
  const ogImage = buildOgImageUrl(caseItem.flexScore, caseItem.roast);
  const structuredData = JSON.stringify(jsonLdForRoast(caseItem, roastUrl));

  return `<!doctype html>
<html lang="tr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="${escapeHtml(roastUrl)}" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:type" content="article" />
    <meta property="og:url" content="${escapeHtml(roastUrl)}" />
    <meta property="og:image" content="${escapeHtml(ogImage)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <script type="application/ld+json">${structuredData}</script>
    <script src="https://cdn.tailwindcss.com"></script>
  </head>
  <body class="min-h-screen bg-[#070312] text-white">
    <main class="mx-auto max-w-3xl px-4 py-10">
      <p class="text-fuchsia-300">InstaRoast AI - Case Study</p>
      <h1 class="mt-2 text-3xl font-extrabold">${escapeHtml(title)}</h1>
      <p class="mt-3 text-violet-200">Flex Score: ${caseItem.flexScore}/100</p>
      <article class="mt-6 rounded-xl border border-violet-400/40 bg-white/5 p-5 leading-relaxed text-violet-50">
        ${escapeHtml(caseItem.roast)}
      </article>
      <section class="mt-6 rounded-xl border border-cyan-300/30 bg-cyan-500/5 p-5 text-sm leading-relaxed text-cyan-50">
        <h2 class="text-lg font-bold text-cyan-100">Analiz Hakkinda</h2>
        <p class="mt-2">
          Bu sayfa, yuklenen profil ekran goruntusunun yapay zeka modeli tarafindan mizahi tonda yorumlanmasi ile
          olusturulmustur. Analiz, profilde gorunen metin ve gorsel ipuclarina dayanir.
        </p>
        <p class="mt-2">
          Sonuc eglenme amaclidir; gercek bir kisi degerlendirmesi, psikolojik test veya profesyonel gorus yerine gecmez.
          Benzer profiller icin farkli zamanlarda farkli roast ciktilari uretebilir.
        </p>
      </section>
      <div class="mt-8 flex flex-wrap gap-3">
        <a class="rounded-lg bg-fuchsia-600 px-4 py-2 font-semibold" href="/">Kendi profilini roast et</a>
        <a class="rounded-lg border border-cyan-300/60 px-4 py-2 font-semibold" href="/?challenge=${caseItem.flexScore}">
          Arkadasina meydan oku
        </a>
      </div>
    </main>
  </body>
</html>`;
}

async function generateWithFallback(genAI, parts) {
  let lastError = null;

  for (const modelName of MODEL_CANDIDATES) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const response = await model.generateContent(parts);
      return { response, modelName };
    } catch (error) {
      lastError = error;
      if (!shouldTryNextModel(error)) {
        throw error;
      }
    }
  }

  throw lastError || new Error("No compatible Gemini model found.");
}

async function ensureStorageBucket() {
  if (!USE_SUPABASE || storageBucketChecked) {
    return;
  }
  storageBucketChecked = true;

  const { error } = await supabase.storage.createBucket(SUPABASE_STORAGE_BUCKET, {
    public: false,
  });
  if (error && !String(error.message || "").toLowerCase().includes("already exists")) {
    console.error("Supabase bucket check/create failed:", error.message);
  }
}

async function uploadImageToSupabaseStorage({ file, caseId, imageHash, username }) {
  if (!USE_SUPABASE || !file?.buffer || !SUPABASE_STORAGE_BUCKET) {
    return null;
  }

  await ensureStorageBucket();

  const ext = getExtensionFromMimeType(file.mimetype);
  const day = new Date().toISOString().slice(0, 10);
  const userPart = normalizeUsername(username) || "anon";
  const hashPart = String(imageHash || "").slice(0, 12) || "nohash";
  const objectPath = `roasts/${day}/${userPart}-${caseId}-${hashPart}.${ext}`;

  const { error: uploadError } = await supabase.storage.from(SUPABASE_STORAGE_BUCKET).upload(objectPath, file.buffer, {
    contentType: file.mimetype || "application/octet-stream",
    upsert: false,
  });
  if (uploadError) {
    console.error("Supabase storage upload failed:", uploadError.message);
    return null;
  }

  const { data } = supabase.storage.from(SUPABASE_STORAGE_BUCKET).getPublicUrl(objectPath);
  if (data?.publicUrl) {
    return data.publicUrl;
  }
  return `${SUPABASE_STORAGE_BUCKET}/${objectPath}`;
}

async function findFreshCachedCase({ username, imageHash, maxAgeHours }) {
  const normalizedUser = normalizeUsername(username);
  const cutoffIso = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();

  if (USE_SUPABASE) {
    if (normalizedUser) {
      const { data, error } = await supabase
        .from("roast_cases")
        .select("id,slug,slug_label,title,roast,flex_score,created_at,image_url,image_hash")
        .eq("slug_label", normalizedUser)
        .gte("created_at", cutoffIso)
        .order("created_at", { ascending: false })
        .limit(1);
      if (!error && data?.length) {
        return mapDbRowToCaseItem(data[0]);
      }
    }

    if (imageHash) {
      const { data, error } = await supabase
        .from("roast_cases")
        .select("id,slug,slug_label,title,roast,flex_score,created_at,image_url,image_hash")
        .eq("image_hash", imageHash)
        .gte("created_at", cutoffIso)
        .order("created_at", { ascending: false })
        .limit(1);
      if (!error && data?.length) {
        return mapDbRowToCaseItem(data[0]);
      }
    }
  }

  const local = await readRoasts();
  const found = local.find((item) => {
    const fresh = isWithinHours(item.createdAt, maxAgeHours);
    if (!fresh) {
      return false;
    }
    if (normalizedUser && normalizeUsername(item.slugLabel) === normalizedUser) {
      return true;
    }
    if (imageHash && item.imageHash && item.imageHash === imageHash) {
      return true;
    }
    return false;
  });
  return found || null;
}

app.get("/api/leaderboard", async (_req, res) => {
  try {
    const all = await getAllRoasts();
    const topFlex = [...all]
      .sort((a, b) => Number(b.flexScore || 0) - Number(a.flexScore || 0))
      .slice(0, 10)
      .map((item) => ({
        slug: item.slug,
        flexScore: item.flexScore,
        teaser: trimText(item.roast, 100),
      }));

    const mostRoasted = [...all]
      .sort((a, b) => Number(a.flexScore || 0) - Number(b.flexScore || 0))
      .slice(0, 10)
      .map((item) => ({
        slug: item.slug,
        flexScore: item.flexScore,
        teaser: trimText(item.roast, 100),
      }));

    return res.json({ topFlex, mostRoasted });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Leaderboard olusturulamadi." });
  }
});

app.get("/roast/:slug", async (req, res) => {
  try {
    const all = await getAllRoasts();
    const requested = String(req.params.slug || "").toLowerCase();
    const foundBySlug = all.find((item) => String(item.slug || "").toLowerCase() === requested);
    const foundByUsername = all
      .filter((item) => normalizeUsername(item.slugLabel) === normalizeUsername(requested))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    const found = foundBySlug || foundByUsername;
    if (!found) {
      return res.status(404).send("Roast case bulunamadi.");
    }

    return res.type("html").send(renderRoastPage(found));
  } catch (error) {
    console.error(error);
    return res.status(500).send("Sayfa olusturulamadi.");
  }
});

app.get("/og/score.svg", (req, res) => {
  const score = Math.max(0, Math.min(100, Number(req.query.score || 0)));
  const text = trimText(req.query.text || "Benim Flex Score sonucum hazir.", 80);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#130a26"/>
      <stop offset="100%" stop-color="#2b0f4f"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#g)"/>
  <rect x="40" y="40" width="1120" height="550" rx="28" fill="rgba(255,255,255,0.08)" stroke="#cb5cff" stroke-width="2"/>
  <text x="90" y="145" fill="#d8b4fe" font-size="54" font-family="Arial" font-weight="700">InstaRoast AI</text>
  <text x="90" y="240" fill="#a5f3fc" font-size="70" font-family="Arial" font-weight="700">Flex Score: ${score}/100</text>
  <text x="90" y="335" fill="#f5d0fe" font-size="38" font-family="Arial">${escapeHtml(text)}</text>
  <text x="90" y="560" fill="#67e8f9" font-size="34" font-family="Arial" font-weight="700">instaroast.ai</text>
</svg>`;

  res.set("Content-Type", "image/svg+xml");
  res.set("Cache-Control", "public, max-age=3600");
  return res.send(svg);
});

app.get("/sitemap.xml", async (_req, res) => {
  try {
    const all = await getAllRoasts();
    const staticUrls = [
      `${SITE_URL}/`,
      `${SITE_URL}/en-iyi-instagram-profilleri.html`,
      `${SITE_URL}/ai-roast-ornekleri.html`,
      `${SITE_URL}/hakkimizda.html`,
      `${SITE_URL}/iletisim.html`,
      `${SITE_URL}/gizlilik-politikasi.html`,
      `${SITE_URL}/cerez-politikasi.html`,
      `${SITE_URL}/kullanim-sartlari.html`,
    ];
    const dynamicSlugUrls = all.slice(0, 500).map((item) => `${SITE_URL}/roast/${item.slug}`);
    const dynamicUserUrls = all
      .map((item) => normalizeUsername(item.slugLabel))
      .filter(Boolean)
      .slice(0, 500)
      .map((username) => `${SITE_URL}/roast/${username}`);
    const urls = [...new Set([...staticUrls, ...dynamicSlugUrls, ...dynamicUserUrls])];
    const xmlItems = urls
      .map(
        (url) => `<url><loc>${escapeHtml(url)}</loc><changefreq>daily</changefreq><priority>0.8</priority></url>`
      )
      .join("");
    const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${xmlItems}</urlset>`;
    res.type("application/xml");
    return res.send(xml);
  } catch (error) {
    console.error(error);
    return res.status(500).send("Sitemap olusturulamadi.");
  }
});

app.post("/api/roast", upload.single("image"), async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: "Sunucuda GEMINI_API_KEY tanimli degil.",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "Lutfen bir Instagram ekran goruntusu yukleyin.",
      });
    }

    const imageHash = hashBuffer(req.file.buffer);
    const username = normalizeUsername(req.body?.username || "");
    const cached = await findFreshCachedCase({
      username,
      imageHash,
      maxAgeHours: CACHE_WINDOW_HOURS,
    });
    if (cached) {
      let imageUrl = cached.imageUrl || null;
      if (!imageUrl) {
        imageUrl = await uploadImageToSupabaseStorage({
          file: req.file,
          caseId: cached.id,
          imageHash,
          username: cached.slugLabel || username,
        });
        if (imageUrl) {
          await attachImageMetaToCase(cached.id, imageUrl, imageHash);
        }
      }

      return res.json({
        roast: cached.roast,
        flexScore: cached.flexScore,
        highlights: [],
        caseStudyUrl: `/roast/${cached.slug}`,
        challengeUrl: `/?challenge=${cached.flexScore}`,
        imageUrl,
        cached: true,
      });
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const prompt = [
      "Sen bir sosyal medya elestirmenisin.",
      "Sana gonderilen bu Instagram profil goruntusunu incele.",
      "Bio ve fotograflara bakarak sert, acimasiz ve komik bir roast yaz.",
      "Roast tonu stand-up sahnesindeki iğneleyici ve zekice mizah gibi olsun.",
      "Yumusatma yapma, direkt ve net vurucu cumleler kullan.",
      "En az 4-6 cumlelik roast yaz ve her cumlede belirgin bir punchline olsun.",
      "Abartili benzetmeler, alayci tespitler ve ego dusuren mizah kullan.",
      "Sonunda 100 uzerinden bir Flex Score ver.",
      "Kufur, nefret soylemi, ayrimcilik veya tehdit kullanma; ama sert ve dalga gecen tonda kal.",
      "Yanitini SADECE JSON olarak ver.",
      "JSON formati: { \"roast\": \"...\", \"flexScore\": 0, \"highlights\": [\"...\", \"...\"] }",
      "flexScore 0-100 araliginda bir tam sayi olmali.",
    ].join(" ");

    const generationParts = [
      { text: prompt },
      {
        inlineData: {
          mimeType: req.file.mimetype,
          data: req.file.buffer.toString("base64"),
        },
      },
    ];
    const { response } = await generateWithFallback(genAI, generationParts);
    const rawText = response.response.text();
    const jsonText = extractJson(rawText);

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (_error) {
      parsed = {
        roast: rawText,
        flexScore: null,
        highlights: [],
      };
    }

    if (typeof parsed.flexScore !== "number") {
      const scoreMatch = String(rawText).match(/(\d{1,3})/);
      parsed.flexScore = scoreMatch ? Math.min(100, Number(scoreMatch[1])) : null;
    }

    const caseStudy = makeCaseStudyPayloadWithProfile({
      roast: parsed.roast || "Roast olusturulamadi.",
      flexScore: parsed.flexScore,
      username,
      imageHash,
    });
    caseStudy.imageUrl = await uploadImageToSupabaseStorage({
      file: req.file,
      caseId: caseStudy.id,
      imageHash,
      username,
    });
    await saveCaseStudy(caseStudy);

    return res.json({
      roast: caseStudy.roast,
      flexScore: caseStudy.flexScore,
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights.slice(0, 3) : [],
      caseStudyUrl: `/roast/${caseStudy.slug}`,
      challengeUrl: `/?challenge=${caseStudy.flexScore}`,
      imageUrl: caseStudy.imageUrl || null,
    });
  } catch (error) {
    console.error(error);

    if (error?.status === 429) {
      const retryAfterSeconds = getRetryDelaySeconds(error);
      const message = String(error?.message || "");
      const noQuotaAvailable = message.includes("limit: 0");
      const quotaMessage = noQuotaAvailable
        ? "Gemini ucretsiz kota su an bu API key/proje icin 0 gorunuyor. AI Studio'da yeni bir proje + yeni API key olusturup tekrar dene."
        : "Gemini kota sinirina ulastin. Kisa bir sure sonra tekrar dene.";

      return res.status(429).json({
        error: quotaMessage,
        retryAfterSeconds,
      });
    }

    return res.status(500).json({
      error: "Roast uretilirken bir hata olustu.",
    });
  }
});

module.exports = app;
