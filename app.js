const express = require("express");
const multer = require("multer");
const dotenv = require("dotenv");
const fs = require("fs/promises");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require("@supabase/supabase-js");

dotenv.config();

const app = express();

app.use(express.static("public"));

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

const DATA_DIR = path.join(__dirname, "data");
const ROAST_STORE = path.join(DATA_DIR, "roasts.json");
const SITE_URL = (process.env.SITE_URL || "http://localhost:3000").replace(/\/$/, "");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_KEY = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_PUBLISHABLE_KEY;
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_KEY);
const supabase = USE_SUPABASE ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

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

function escapeHtml(input) {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(ROAST_STORE);
  } catch {
    await fs.writeFile(ROAST_STORE, "[]", "utf8");
  }
}

async function readRoasts() {
  await ensureStore();
  const raw = await fs.readFile(ROAST_STORE, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeRoasts(items) {
  await ensureStore();
  await fs.writeFile(ROAST_STORE, JSON.stringify(items, null, 2), "utf8");
}

function mapDbRowToCaseItem(row) {
  return {
    id: row.id,
    slug: row.slug,
    slugLabel: row.slug_label,
    title: row.title,
    roast: row.roast,
    flexScore: row.flex_score,
    createdAt: row.created_at,
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
    roast: trimText(roast, 420),
    flexScore: score,
    createdAt: new Date().toISOString(),
  };
}

async function saveCaseStudy(item) {
  if (USE_SUPABASE) {
    const { error } = await supabase.from("roast_cases").upsert(
      {
        id: item.id,
        slug: item.slug,
        slug_label: item.slugLabel,
        title: item.title,
        roast: item.roast,
        flex_score: item.flexScore,
        created_at: item.createdAt,
      },
      { onConflict: "id" }
    );
    if (!error) {
      return;
    }
    console.error("Supabase save failed, falling back to local store:", error.message);
  }

  const current = await readRoasts();
  const next = [item, ...current].slice(0, 600);
  await writeRoasts(next);
}

async function getAllRoasts() {
  if (USE_SUPABASE) {
    const { data, error } = await supabase
      .from("roast_cases")
      .select("id,slug,slug_label,title,roast,flex_score,created_at")
      .order("created_at", { ascending: false })
      .limit(1000);

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
    const found = all.find((item) => item.slug === req.params.slug);
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
    ];
    const dynamicUrls = all.slice(0, 500).map((item) => `${SITE_URL}/roast/${item.slug}`);
    const urls = [...staticUrls, ...dynamicUrls];
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

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const prompt = [
      "Sen bir sosyal medya elestirmenisin.",
      "Sana gonderilen bu Instagram profil goruntusunu incele.",
      "Bio ve fotograflara bakarak acimasiz ama komik bir roast yaz.",
      "Sonunda 100 uzerinden bir Flex Score ver.",
      "Hakaret veya nefret soylemi kullanma; eglenceli, alayci ve viral bir tonda kal.",
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

    const caseStudy = makeCaseStudyPayload({
      roast: parsed.roast || "Roast olusturulamadi.",
      flexScore: parsed.flexScore,
    });
    await saveCaseStudy(caseStudy);

    return res.json({
      roast: caseStudy.roast,
      flexScore: caseStudy.flexScore,
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights.slice(0, 3) : [],
      caseStudyUrl: `/roast/${caseStudy.slug}`,
      challengeUrl: `/?challenge=${caseStudy.flexScore}`,
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
