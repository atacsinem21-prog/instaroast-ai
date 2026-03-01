const imageInput = document.getElementById("imageInput");
const usernameInput = document.getElementById("usernameInput");
const analyzeBtn = document.getElementById("analyzeBtn");
const roastText = document.getElementById("roastText");
const roastToggleBtn = document.getElementById("roastToggleBtn");
const scoreText = document.getElementById("scoreText");
const highlightsList = document.getElementById("highlights");
const statusText = document.getElementById("status");
const progressBar = document.getElementById("progressBar");
const progressText = document.getElementById("progressText");
const shareBtn = document.getElementById("shareBtn");
const copyBtn = document.getElementById("copyBtn");
const challengeBtn = document.getElementById("challengeBtn");
const caseStudyLink = document.getElementById("caseStudyLink");
const sharePreview = document.getElementById("sharePreview");
const sharePreviewHint = document.getElementById("sharePreviewHint");
const recentRoastsList = document.getElementById("recentRoasts");
const topFlexList = document.getElementById("topFlexList");
const mostRoastedList = document.getElementById("mostRoastedList");

const RECENT_ROASTS_KEY = "instaroast_recent_roasts_v1";
const PROGRESS_MESSAGES = [
  "AI profilini inceliyor...",
  "Bio'daki iddialar analiz ediliyor...",
  "Ego seviyesi olculuyor...",
  "Komik roast ciktisi parlatiliyor...",
];

let lastResult = "";
let lastCaseUrl = window.location.href;
let lastScore = null;
let shareImageBlob = null;
let roastFullText = "";
let roastExpanded = false;
const ROAST_PREVIEW_MAX = 260;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildShareText() {
  if (!lastResult) {
    return "InstaRoast AI ile profilini roast ettir.";
  }
  return `${lastResult}\nCase: ${lastCaseUrl}\nBenim skorum ${lastScore ?? "--"}, ya senin?`;
}

function sanitizeRoast(roast) {
  return String(roast || "")
    .replace(/@\w+/g, "@kullanici")
    .replace(/\s+/g, " ")
    .trim();
}

function trimText(input, maxLength) {
  const text = String(input || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function normalizeUsername(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9._]/g, "")
    .slice(0, 30);
}

function renderRoastText() {
  const full = String(roastFullText || "").trim();
  if (!full) {
    roastText.textContent = "Henuz analiz yok.";
    roastToggleBtn.classList.add("hidden");
    return;
  }

  const isLong = full.length > ROAST_PREVIEW_MAX;
  if (!isLong) {
    roastText.textContent = full;
    roastToggleBtn.classList.add("hidden");
    return;
  }

  if (roastExpanded) {
    roastText.textContent = full;
    roastToggleBtn.textContent = "Daha az goster";
  } else {
    roastText.textContent = trimText(full, ROAST_PREVIEW_MAX);
    roastToggleBtn.textContent = "Devamini oku";
  }
  roastToggleBtn.classList.remove("hidden");
}

function readRecentRoasts() {
  try {
    const raw = localStorage.getItem(RECENT_ROASTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function writeRecentRoasts(items) {
  try {
    localStorage.setItem(RECENT_ROASTS_KEY, JSON.stringify(items));
  } catch (_error) {
    // localStorage write failures can be ignored.
  }
}

function renderRecentRoasts() {
  const items = readRecentRoasts();
  if (!items.length) {
    return;
  }

  recentRoastsList.innerHTML = "";
  items.forEach((item) => {
    const li = document.createElement("li");
    li.className = "rounded-md bg-white/5 p-3";
    li.textContent = `Flex Score ${item.score}/100 - "${item.roast}"`;
    recentRoastsList.appendChild(li);
  });
}

function rememberRoast(roast, score) {
  const sanitized = sanitizeRoast(roast).slice(0, 170);
  const numericScore = Number.isFinite(Number(score)) ? Math.max(0, Math.min(100, Number(score))) : 0;
  const previous = readRecentRoasts();
  const next = [{ roast: sanitized, score: numericScore, ts: Date.now() }, ...previous]
    .filter((item, index, arr) => arr.findIndex((x) => x.roast === item.roast && x.score === item.score) === index)
    .slice(0, 8);
  writeRecentRoasts(next);
  renderRecentRoasts();
}

function setProgress(percent, message) {
  progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  progressText.textContent = message || "";
}

function startNarrativeProgress() {
  let progress = 5;
  let messageIndex = 0;
  setProgress(progress, PROGRESS_MESSAGES[messageIndex]);

  const timer = setInterval(() => {
    progress = Math.min(92, progress + 4);
    messageIndex = (messageIndex + 1) % PROGRESS_MESSAGES.length;
    setProgress(progress, PROGRESS_MESSAGES[messageIndex]);
  }, 900);

  return {
    complete() {
      clearInterval(timer);
      setProgress(100, "Skor kartin hazirlandi.");
    },
    fail() {
      clearInterval(timer);
      setProgress(0, "Analiz durdu.");
    },
  };
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

async function fileToImage(file) {
  if ("createImageBitmap" in window) {
    return createImageBitmap(file);
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = reject;
      element.src = objectUrl;
    });
    return img;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function optimizeUploadImage(file) {
  const source = await fileToImage(file);
  const maxWidth = 1400;
  const scale = source.width > maxWidth ? maxWidth / source.width : 1;
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return file;
  }

  ctx.drawImage(source, 0, 0, width, height);
  const webpBlob = await canvasToBlob(canvas, "image/webp", 0.82);
  return webpBlob || file;
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  const words = String(text).split(" ");
  let line = "";
  let lines = 0;

  for (let i = 0; i < words.length; i += 1) {
    const testLine = `${line}${words[i]} `;
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && i > 0) {
      ctx.fillText(line.trim(), x, y + lines * lineHeight);
      line = `${words[i]} `;
      lines += 1;
      if (lines >= maxLines - 1) {
        break;
      }
    } else {
      line = testLine;
    }
  }

  const finalLine = line.trim();
  if (finalLine) {
    const rendered = lines >= maxLines - 1 ? `${finalLine.slice(0, 80)}...` : finalLine;
    ctx.fillText(rendered, x, y + lines * lineHeight);
  }
}

async function generateShareVisual(score, roast) {
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1350;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }

  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, "#130a26");
  gradient.addColorStop(0.55, "#261047");
  gradient.addColorStop(1, "#090314");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "rgba(203, 92, 255, 0.15)";
  ctx.fillRect(70, 70, canvas.width - 140, canvas.height - 140);

  ctx.fillStyle = "#d8b4fe";
  ctx.font = "bold 64px Arial";
  ctx.fillText("InstaRoast AI", 90, 170);

  ctx.fillStyle = "#a5f3fc";
  ctx.font = "bold 58px Arial";
  ctx.fillText(`Flex Score: ${score}/100`, 90, 270);

  ctx.fillStyle = "#f5d0fe";
  ctx.font = "bold 42px Arial";
  ctx.fillText("Roast:", 90, 380);

  ctx.fillStyle = "#f8fafc";
  ctx.font = "36px Arial";
  wrapText(ctx, sanitizeRoast(roast), 90, 450, 900, 52, 11);

  ctx.fillStyle = "#67e8f9";
  ctx.font = "30px Arial";
  ctx.fillText(`Profilini test et: ${window.location.origin}`, 90, 1220);

  // Watermark for social repost loops.
  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.font = "bold 28px Arial";
  ctx.fillText("instaroast.ai", 860, 1290);

  const blob = await canvasToBlob(canvas, "image/png");
  if (!blob) {
    return null;
  }
  return {
    blob,
    dataUrl: canvas.toDataURL("image/png"),
  };
}

function updateChallengeLink(score) {
  const normalized = Number.isFinite(Number(score)) ? Math.max(0, Math.min(100, Number(score))) : 0;
  const link = new URL(window.location.href);
  link.searchParams.set("challenge", String(normalized));
  challengeBtn.href = link.toString();
}

function applyChallengeHintFromQuery() {
  const url = new URL(window.location.href);
  const challenge = url.searchParams.get("challenge");
  if (!challenge) {
    return;
  }
  statusText.textContent = `Meydan okuma geldi. Hedef: ${challenge}/100 ustu yap!`;
}

function renderLeaderboardList(target, items, prefixLabel) {
  target.innerHTML = "";
  if (!Array.isArray(items) || !items.length) {
    const li = document.createElement("li");
    li.className = "rounded-md bg-white/5 p-2";
    li.textContent = "Henuz veri yok.";
    target.appendChild(li);
    return;
  }

  items.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = "rounded-md bg-white/5 p-2";

    const link = document.createElement("a");
    link.className = "underline";
    link.href = `/roast/${item.slug}`;
    link.textContent = `${prefixLabel} #${index + 1} - ${item.flexScore}/100`;

    const teaser = document.createElement("p");
    teaser.className = "mt-1 text-xs text-violet-200/90";
    teaser.textContent = trimText(item.teaser, 90);

    li.appendChild(link);
    li.appendChild(teaser);
    target.appendChild(li);
  });
}

async function loadLeaderboards() {
  try {
    const response = await fetch("/api/leaderboard");
    if (!response.ok) {
      throw new Error("Leaderboard yuklenemedi.");
    }
    const data = await response.json();
    renderLeaderboardList(topFlexList, data.topFlex, "Flex");
    renderLeaderboardList(mostRoastedList, data.mostRoasted, "Roast");
  } catch (_error) {
    renderLeaderboardList(topFlexList, [], "Flex");
    renderLeaderboardList(mostRoastedList, [], "Roast");
  }
}

analyzeBtn.addEventListener("click", async () => {
  const file = imageInput.files?.[0];
  if (!file) {
    statusText.textContent = "Once bir gorsel secmelisin.";
    return;
  }

  if (!file.type.startsWith("image/")) {
    statusText.textContent = "Sadece gorsel dosyasi yukleyebilirsin.";
    return;
  }

  analyzeBtn.disabled = true;
  statusText.textContent = "Roast motoru baslatildi...";
  const progress = startNarrativeProgress();

  try {
    const optimized = await optimizeUploadImage(file);
    const formData = new FormData();
    const normalizedUser = normalizeUsername(usernameInput?.value || "");
    formData.append("image", optimized, "profile.webp");
    if (normalizedUser) {
      formData.append("username", normalizedUser);
    }

    const fetchPromise = fetch("/api/roast", {
      method: "POST",
      body: formData,
    });

    const [response] = await Promise.all([fetchPromise, sleep(5600)]);
    const data = await response.json();
    if (!response.ok) {
      const retryText =
        data.retryAfterSeconds != null ? ` ${data.retryAfterSeconds} sn sonra tekrar dene.` : "";
      throw new Error((data.error || "Bilinmeyen hata") + retryText);
    }

    const safeScore = Number.isFinite(Number(data.flexScore)) ? Number(data.flexScore) : 0;
    roastFullText = String(data.roast || "");
    roastExpanded = false;
    renderRoastText();
    scoreText.textContent = `${safeScore} / 100`;
    highlightsList.innerHTML = "";
    (data.highlights || []).forEach((item) => {
      const li = document.createElement("li");
      li.className = "rounded-md bg-white/5 p-2";
      li.textContent = `- ${item}`;
      highlightsList.appendChild(li);
    });

    lastScore = safeScore;
    lastCaseUrl = data.caseStudyUrl ? new URL(data.caseStudyUrl, window.location.origin).toString() : window.location.href;
    lastResult = `InstaRoast AI Sonucu:\nFlex Score: ${safeScore}/100\nRoast: ${data.roast}`;
    rememberRoast(data.roast, safeScore);

    caseStudyLink.href = lastCaseUrl;
    updateChallengeLink(data.challengeUrl ? new URL(data.challengeUrl, window.location.origin).searchParams.get("challenge") : safeScore);

    const visual = await generateShareVisual(safeScore, data.roast);
    if (visual) {
      shareImageBlob = visual.blob;
      sharePreview.src = visual.dataUrl;
      sharePreview.classList.remove("hidden");
      sharePreviewHint.textContent = "Rozetli paylasim gorseli hazir. Mobilde Paylas butonuna bas.";
    }

    progress.complete();
    statusText.textContent = data.cached
      ? "Hazir. Bu sonuc son analizlerden cache'den getirildi, kota korunuyor."
      : "Hazir. Sonucu paylasabilir veya case study linkini yayinlayabilirsin.";
    loadLeaderboards();
  } catch (error) {
    progress.fail();
    statusText.textContent = error.message;
  } finally {
    analyzeBtn.disabled = false;
  }
});

roastToggleBtn.addEventListener("click", () => {
  roastExpanded = !roastExpanded;
  renderRoastText();
});

shareBtn.addEventListener("click", async () => {
  const text = buildShareText();
  if (!lastResult) {
    statusText.textContent = "Paylasimdan once bir analiz yapmalisin.";
    return;
  }

  try {
    if (navigator.share) {
      if (shareImageBlob && typeof navigator.canShare === "function") {
        const shareFile = new File([shareImageBlob], "instaroast-flex-score.png", {
          type: "image/png",
        });
        if (navigator.canShare({ files: [shareFile] })) {
          await navigator.share({
            title: "InstaRoast AI Sonucum",
            text: `Benim skorum ${lastScore}/100, ya senin?`,
            files: [shareFile],
          });
          return;
        }
      }

      await navigator.share({
        title: "InstaRoast AI Sonucum",
        text,
        url: lastCaseUrl,
      });
      return;
    }
  } catch (_error) {
    // User can close the share panel without error handling.
  }

  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(`${text}\n${lastCaseUrl}`)}`;
  window.open(whatsappUrl, "_blank", "noopener,noreferrer");
});

copyBtn.addEventListener("click", async () => {
  const text = buildShareText();
  try {
    await navigator.clipboard.writeText(text);
    statusText.textContent = "Sonuc panoya kopyalandi.";
  } catch (_error) {
    statusText.textContent = "Kopyalama basarisiz oldu.";
  }
});

challengeBtn.addEventListener("click", () => {
  if (!lastResult) {
    return;
  }
  statusText.textContent = `Meydan okuma linki hazir: hedef ${lastScore}/100 ustu.`;
});

renderRecentRoasts();
loadLeaderboards();
applyChallengeHintFromQuery();
