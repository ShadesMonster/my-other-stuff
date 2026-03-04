const express = require("express");
const https = require("https");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const DATA_DIR = path.join(__dirname, "investigations");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, crypto.randomBytes(16).toString("hex") + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

app.use(express.json({ limit: "20mb" }));
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOADS_DIR));

// ── Helpers ─────────────────────────────────────────────────────────────

function fetchJSON(url, headers = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const driver = opts.protocol === "https:" ? https : http;
    const reqOpts = {
      hostname: opts.hostname,
      path: opts.pathname + opts.search,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json",
        ...headers,
      },
    };
    const req = driver.request(reqOpts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on("error", (err) => reject(err));
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

function fetchText(url, headers = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const driver = opts.protocol === "https:" ? https : http;
    const reqOpts = {
      hostname: opts.hostname,
      path: opts.pathname + opts.search,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        ...headers,
      },
    };
    const req = driver.request(reqOpts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let loc = res.headers.location;
        if (loc.startsWith("/")) loc = opts.protocol + "//" + opts.hostname + loc;
        fetchText(loc, headers, timeout).then(resolve).catch(reject);
        res.resume();
        return;
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, data, headers: res.headers }));
    });
    req.on("error", (err) => reject(err));
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

function headCheck(url, timeout = 8000) {
  return new Promise((resolve) => {
    try {
      const opts = new URL(url);
      const driver = opts.protocol === "https:" ? https : http;
      const req = driver.request({
        hostname: opts.hostname,
        path: opts.pathname + opts.search,
        method: "HEAD",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", () => resolve(0));
      req.setTimeout(timeout, () => { req.destroy(); resolve(0); });
      req.end();
    } catch { resolve(0); }
  });
}

function getCheck(url, timeout = 8000) {
  return new Promise((resolve) => {
    try {
      const opts = new URL(url);
      const driver = opts.protocol === "https:" ? https : http;
      const req = driver.request({
        hostname: opts.hostname,
        path: opts.pathname + opts.search,
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html",
        },
      }, (res) => {
        res.resume();
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let loc = res.headers.location;
          if (loc.startsWith("/")) loc = opts.protocol + "//" + opts.hostname + loc;
          if (loc.includes("/login") || loc.includes("/404") || loc.includes("error")) {
            resolve(404);
          } else {
            resolve(200);
          }
        } else {
          resolve(res.statusCode);
        }
      });
      req.on("error", () => resolve(0));
      req.setTimeout(timeout, () => { req.destroy(); resolve(0); });
      req.end();
    } catch { resolve(0); }
  });
}

async function safeFetch(url, headers) {
  try {
    const { status, data } = await fetchJSON(url, headers);
    if (status !== 200 || !data) return null;
    return data;
  } catch { return null; }
}

// ── Smart username check — GET + body analysis ───────────────────────────

async function smartCheckUsername(platformName, url) {
  try {
    let fetchUrl = url;
    let fetchHeaders = {};

    if (platformName === "GitHub") {
      const parts = new URL(url).pathname.split("/").filter(Boolean);
      fetchUrl = `https://api.github.com/users/${parts[0]}`;
      fetchHeaders = { Accept: "application/json" };
    } else if (platformName === "Reddit") {
      const parts = new URL(url).pathname.replace(/\/$/, "").split("/").filter(Boolean);
      const username = parts[parts.length - 1];
      fetchUrl = `https://www.reddit.com/user/${username}/about.json`;
      fetchHeaders = { Accept: "application/json" };
    }

    const { status, data: body } = await fetchText(fetchUrl, fetchHeaders, 10000);

    if (!body && status === 0) return { exists: false, status: 0, confidence: "low" };

    const b = body || "";

    switch (platformName) {
      case "Instagram":
        if (b.includes('"is_private"') || b.includes('"user"')) return { exists: true, status, confidence: "high" };
        if (b.includes("Sorry, this page")) return { exists: false, status, confidence: "high" };
        return { exists: status === 200, status, confidence: "medium" };

      case "Twitter/X":
        if (b.includes("profile_image") || b.includes('content="@')) return { exists: true, status, confidence: "high" };
        if (b.includes("This account doesn't exist") || b.includes("Hmm...this page doesn't exist")) return { exists: false, status, confidence: "high" };
        return { exists: status === 200, status, confidence: "medium" };

      case "TikTok":
        if (b.includes("userInfo") || b.includes("uniqueId")) return { exists: true, status, confidence: "high" };
        if (b.includes("Couldn't find this account")) return { exists: false, status, confidence: "high" };
        return { exists: status === 200, status, confidence: "medium" };

      case "Facebook":
        if (b.includes("profile_owner") || b.includes("pageTitle")) return { exists: true, status, confidence: "high" };
        if (b.includes("page isn't available") || b.includes("content isn't available")) return { exists: false, status, confidence: "high" };
        return { exists: status === 200, status, confidence: "medium" };

      case "YouTube":
        if (b.includes("channelMetadataRenderer") || b.includes("subscriberCountText")) return { exists: true, status, confidence: "high" };
        if (b.includes("This page isn't available")) return { exists: false, status, confidence: "high" };
        return { exists: status === 200, status, confidence: "medium" };

      case "GitHub": {
        let parsed = null;
        try { parsed = JSON.parse(b); } catch {}
        if (status === 200 && parsed && parsed.avatar_url) return { exists: true, status, confidence: "high" };
        if (parsed && parsed.message === "Not Found") return { exists: false, status, confidence: "high" };
        return { exists: false, status, confidence: "low" };
      }

      case "Reddit": {
        let parsed = null;
        try { parsed = JSON.parse(b); } catch {}
        if (parsed && parsed.data) return { exists: true, status, confidence: "high" };
        if (status === 404 || (parsed && parsed.error)) return { exists: false, status, confidence: "high" };
        return { exists: false, status, confidence: "low" };
      }

      default: {
        const notFoundPhrases = [
          "not found", "doesn't exist", "does not exist", "no user",
          "page not available", "user not found", "account not found",
          "404", "nothing here", "page doesn't exist",
        ];
        const bodyLower = b.toLowerCase();
        const hasNotFound = notFoundPhrases.some(p => bodyLower.includes(p));
        if (status === 200 && !hasNotFound && b.length > 5000) return { exists: true, status, confidence: "medium" };
        if (hasNotFound || status === 404) return { exists: false, status, confidence: "medium" };
        return { exists: status >= 200 && status < 400 && b.length > 5000, status, confidence: "low" };
      }
    }
  } catch { return { exists: false, status: 0, confidence: "low" }; }
}

// ── Username check across 26 platforms ──────────────────────────────────

async function checkUsername(username) {
  const platforms = [
    { name: "Instagram",    url: `https://www.instagram.com/${username}/` },
    { name: "Twitter/X",   url: `https://x.com/${username}` },
    { name: "TikTok",      url: `https://www.tiktok.com/@${username}` },
    { name: "Facebook",    url: `https://www.facebook.com/${username}` },
    { name: "YouTube",     url: `https://www.youtube.com/@${username}` },
    { name: "GitHub",      url: `https://github.com/${username}` },
    { name: "Reddit",      url: `https://www.reddit.com/user/${username}` },
    { name: "Pinterest",   url: `https://www.pinterest.com/${username}/` },
    { name: "Twitch",      url: `https://www.twitch.tv/${username}` },
    { name: "Spotify",     url: `https://open.spotify.com/user/${username}` },
    { name: "SoundCloud",  url: `https://soundcloud.com/${username}` },
    { name: "Medium",      url: `https://medium.com/@${username}` },
    { name: "Dribbble",    url: `https://dribbble.com/${username}` },
    { name: "Behance",     url: `https://www.behance.net/${username}` },
    { name: "DeviantArt",  url: `https://www.deviantart.com/${username}` },
    { name: "Flickr",      url: `https://www.flickr.com/people/${username}` },
    { name: "Patreon",     url: `https://www.patreon.com/${username}` },
    { name: "Steam",       url: `https://steamcommunity.com/id/${username}` },
    { name: "Letterboxd",  url: `https://letterboxd.com/${username}` },
    { name: "Last.fm",     url: `https://www.last.fm/user/${username}` },
    { name: "MyAnimeList", url: `https://myanimelist.net/profile/${username}` },
    { name: "Linktree",    url: `https://linktr.ee/${username}` },
    { name: "About.me",    url: `https://about.me/${username}` },
    { name: "Product Hunt",url: `https://www.producthunt.com/@${username}` },
    { name: "CodePen",     url: `https://codepen.io/${username}` },
    { name: "Replit",      url: `https://replit.com/@${username}` },
    { name: "Kaggle",      url: `https://www.kaggle.com/${username}` },
    { name: "Threads",     url: `https://www.threads.net/@${username}` },
  ];

  const CONCURRENCY = 8;
  const results = [];
  for (let i = 0; i < platforms.length; i += CONCURRENCY) {
    const batch = platforms.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (p) => {
        try {
          const check = await smartCheckUsername(p.name, p.url);
          return { name: p.name, url: p.url, exists: check.exists, status: check.status, confidence: check.confidence };
        } catch {
          return { name: p.name, url: p.url, exists: false, status: 0, confidence: "low" };
        }
      })
    );
    for (const r of batchResults) {
      if (r.status === "fulfilled") results.push(r.value);
    }
  }
  return results;
}

// ── Confidence scoring ───────────────────────────────────────────────────

function calculateConfidence(result) {
  if (!result) return "low";
  const src = (result.source || "").toLowerCase();
  const name = (result.name || "").toLowerCase();

  // High confidence: direct API matches or face-identified names
  if (src === "github" && result.avatar_url) return "high";
  if (src === "reddit" && result.link_karma !== undefined) return "high";
  if (src === "wikipedia" && result.extract) return "high";
  if (src === "duckduckgo" && result.description && result.profile_url) return "high";
  if (src === "github commit emails") return "high";
  if (src === "keybase" && result.linked_accounts) return "high";
  if (result.confidence === "high") return "high";

  // Medium confidence: site-scoped DDG hits, cross-checks, named search results
  if (src.includes("duckduckgo") && result.profile_url) return "medium";
  if (src === "stack overflow" && result.profile_url) return "medium";
  if (src === "hacker news" && result.karma !== undefined) return "medium";
  if (src === "gitlab" && result.profile_url) return "medium";
  if (src === "mastodon" && result.profile_url) return "medium";
  if (src === "gravatar" && result.profile_url) return "medium";
  if (src === "lichess" && result.profile_url) return "medium";
  if (src === "chess.com" && result.profile_url) return "medium";
  if (src === "dev.to" && result.profile_url) return "medium";
  if (src === "docker hub" && result.profile_url) return "medium";
  if (src === "npm" && result.profile_url) return "medium";
  if (src === "hugging face" && result.profile_url) return "medium";
  if (src === "crates.io" && result.profile_url) return "medium";
  if (result.confidence === "medium") return "medium";
  if (result.source_engine === "ddg-site" && result.url) return "medium";
  if (result.source_engine === "username-check" && result.url) return "medium";

  // Low confidence: generic web links, image URLs, unconfirmed checks
  return "low";
}

// ── DuckDuckGo HTML search scrape ────────────────────────────────────────

async function scrapeWebSearch(query) {
  try {
    const { status, data } = await fetchText(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { Accept: "text/html" },
      12000
    );
    if (status !== 200 || !data) return [];

    const results = [];
    const linkRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    const links = [...data.matchAll(linkRegex)];
    const snippets = [...data.matchAll(snippetRegex)];

    for (let i = 0; i < Math.min(links.length, 10); i++) {
      let url = links[i][1];
      const uddg = url.match(/uddg=([^&]+)/);
      if (uddg) url = decodeURIComponent(uddg[1]);
      const title = links[i][2].replace(/<[^>]*>/g, "").trim();
      const snippet = snippets[i] ? snippets[i][1].replace(/<[^>]*>/g, "").trim() : "";
      if (title && url.startsWith("http")) results.push({ title, url, snippet });
    }
    return results;
  } catch { return []; }
}

// ── Reverse image search helpers ─────────────────────────────────────────

function buildMultipart(fields, fileField, fileBuffer, filename, contentType) {
  const boundary = "----PersonLookup" + crypto.randomBytes(16).toString("hex");
  const parts = [];
  for (const [key, val] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`));
  parts.push(fileBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

function proxyReverseSearch(engine, fileBuffer, filename, contentType) {
  return new Promise((resolve) => {
    let host, postPath, fileField, extraFields;
    switch (engine) {
      case "google":
        host = "www.google.com"; postPath = "/searchbyimage/upload";
        fileField = "encoded_image"; extraFields = { image_url: "", sbisrc: "cr_1" };
        break;
      case "yandex":
        host = "yandex.com"; postPath = "/images/search?rpt=imageview&format=json";
        fileField = "upfile"; extraFields = {};
        break;
      case "tineye":
        host = "tineye.com"; postPath = "/search";
        fileField = "image"; extraFields = {};
        break;
      default: return resolve({ engine, status: "error", error: "Unknown engine" });
    }
    const { boundary, body } = buildMultipart(extraFields, fileField, fileBuffer, filename, contentType);
    const req = https.request({
      hostname: host, path: postPath, method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let loc = res.headers.location;
          if (loc.startsWith("/")) loc = `https://${host}${loc}`;
          resolve({ engine, redirect: loc, status: "redirect" });
        } else {
          resolve({ engine, status: "html", statusCode: res.statusCode });
        }
      });
    });
    req.on("error", (err) => resolve({ engine, status: "error", error: err.message }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ engine, status: "error", error: "timeout" }); });
    req.write(body);
    req.end();
  });
}

// ── Exposure score ────────────────────────────────────────────────────────

function calculateExposureScore(results, usernameResults) {
  let score = 0;
  const factors = [];
  for (const r of results) {
    const s = r.source || "";
    if (s === "GitHub") { score += 15; factors.push("GitHub profile exposed");
      if (r.email) { score += 10; factors.push("Email visible on GitHub"); }
      if (r.location) { score += 5; factors.push("Location on GitHub"); }
    }
    if (s === "Reddit") { score += 10; factors.push("Reddit account found"); }
    if (s === "Wikipedia") { score += 5; factors.push("Wikipedia page exists"); }
    if (s === "Stack Overflow") { score += 8; factors.push("Stack Overflow profile"); }
    if (s === "Hacker News") { score += 8; factors.push("Hacker News account"); }
    if (s === "Gravatar") { score += 10; factors.push("Gravatar profile"); }
    if (s === "GitLab") { score += 8; factors.push("GitLab profile"); }
    if (s === "Keybase") { score += 10; factors.push("Keybase (links many accounts)"); }
    if (s === "Docker Hub") { score += 5; factors.push("Docker Hub account"); }
    if (s === "npm") { score += 5; factors.push("npm profile"); }
    if (s === "DEV.to") { score += 5; factors.push("DEV.to profile"); }
    if (s.includes("Mastodon")) { score += 8; factors.push("Fediverse presence"); }
    if (s.includes("GitHub Repos")) { score += 5; factors.push("Public repos reveal tech stack"); }
    if (s.includes("GitHub Activity")) { score += 8; factors.push("Activity patterns reveal timezone"); }
    if (s.includes("GitHub Gists")) { score += 5; factors.push("Public gists"); }
    if (s.includes("Commit Emails")) { score += 15; factors.push("Real email in git commits"); }
    if (s.includes("DuckDuckGo")) { score += 5; factors.push("Structured info on search engines"); }
    if (s.includes("Lichess") || s.includes("Chess.com")) { score += 3; factors.push("Gaming profile"); }
    if (s.includes("Roblox")) { score += 3; factors.push("Roblox profile"); }
  }
  if (usernameResults) {
    const found = usernameResults.filter(r => r.exists);
    if (found.length > 5) { score += 15; factors.push(`Username found on ${found.length} platforms`); }
    else if (found.length > 0) { score += 8; factors.push(`Username found on ${found.length} platforms`); }
    for (const r of found) {
      if (["Instagram", "Facebook", "Twitter/X", "TikTok", "LinkedIn"].includes(r.name)) {
        score += 3; factors.push(`${r.name} profile exists`);
      }
    }
  }
  return { score: Math.min(score, 100), factors };
}

// ── Deep social name search across 31 platforms ──────────────────────────

async function deepSocialSearch(name) {
  const sites = [
    "instagram.com", "twitter.com", "x.com", "tiktok.com", "facebook.com",
    "linkedin.com", "youtube.com", "pinterest.com", "reddit.com", "tumblr.com",
    "flickr.com", "deviantart.com", "behance.net", "dribbble.com", "medium.com",
    "twitch.tv", "soundcloud.com", "spotify.com", "threads.net", "bsky.app",
    "mastodon.social", "vk.com", "ok.ru", "weibo.com", "snapchat.com",
    "patreon.com", "onlyfans.com", "fansly.com", "letterboxd.com",
    "myanimelist.net", "steamcommunity.com",
  ];

  const allResults = [];
  const CONCURRENCY = 5;

  for (let i = 0; i < sites.length; i += CONCURRENCY) {
    const batch = sites.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (site) => {
        const wr = await scrapeWebSearch(`"${name}" site:${site}`);
        return wr.slice(0, 4).map(r => ({
          title: r.title, url: r.url, snippet: r.snippet,
          source_engine: "ddg-site", platform: detectPlatform(r.url),
          confidence: "medium",
        }));
      })
    );
    for (const br of batchResults) {
      if (br.status === "fulfilled") allResults.push(...br.value);
    }
  }

  // Also do a broad name search
  const broadResults = await scrapeWebSearch(`"${name}" social media profile`);
  for (const r of broadResults) {
    allResults.push({
      title: r.title, url: r.url, snippet: r.snippet,
      source_engine: "ddg-broad", platform: detectPlatform(r.url),
      confidence: "low",
    });
  }

  return allResults;
}

// ── Platform detection ────────────────────────────────────────────────────

const PLATFORM_MAP = [
  ["instagram.com", "Instagram"], ["twitter.com", "Twitter/X"], ["x.com", "Twitter/X"],
  ["facebook.com", "Facebook"], ["fb.com", "Facebook"], ["linkedin.com", "LinkedIn"],
  ["tiktok.com", "TikTok"], ["pinterest.com", "Pinterest"], ["youtube.com", "YouTube"],
  ["youtu.be", "YouTube"], ["reddit.com", "Reddit"], ["tumblr.com", "Tumblr"],
  ["vk.com", "VK"], ["flickr.com", "Flickr"], ["deviantart.com", "DeviantArt"],
  ["twitch.tv", "Twitch"], ["snapchat.com", "Snapchat"], ["threads.net", "Threads"],
  ["bsky.app", "Bluesky"], ["mastodon.social", "Mastodon"], ["github.com", "GitHub"],
  ["gitlab.com", "GitLab"], ["imdb.com", "IMDb"], ["wikipedia.org", "Wikipedia"],
  ["wikidata.org", "Wikidata"], ["medium.com", "Medium"], ["quora.com", "Quora"],
  ["spotify.com", "Spotify"], ["soundcloud.com", "SoundCloud"], ["myspace.com", "MySpace"],
  ["weibo.com", "Weibo"], ["ok.ru", "Odnoklassniki"], ["telegram.org", "Telegram"],
  ["t.me", "Telegram"], ["discord.gg", "Discord"], ["discord.com", "Discord"],
  ["patreon.com", "Patreon"], ["onlyfans.com", "OnlyFans"], ["fansly.com", "Fansly"],
  ["behance.net", "Behance"], ["dribbble.com", "Dribbble"], ["500px.com", "500px"],
  ["ask.fm", "ASKfm"], ["about.me", "About.me"], ["linktr.ee", "Linktree"],
  ["steamcommunity.com", "Steam"], ["letterboxd.com", "Letterboxd"],
  ["pixiv.net", "Pixiv"], ["artstation.com", "ArtStation"], ["deviantart.com", "DeviantArt"],
  ["last.fm", "Last.fm"], ["myanimelist.net", "MyAnimeList"], ["codepen.io", "CodePen"],
  ["replit.com", "Replit"], ["kaggle.com", "Kaggle"], ["producthunt.com", "Product Hunt"],
  ["dev.to", "DEV.to"], ["keybase.io", "Keybase"], ["npmjs.com", "npm"],
  ["hub.docker.com", "Docker Hub"], ["huggingface.co", "Hugging Face"],
  ["crates.io", "Crates.io"], ["lichess.org", "Lichess"], ["chess.com", "Chess.com"],
  ["roblox.com", "Roblox"], ["news.ycombinator.com", "Hacker News"],
  ["stackoverflow.com", "Stack Overflow"], ["gravatar.com", "Gravatar"],
  ["archive.org", "Internet Archive"], ["web.archive.org", "Wayback Machine"],
];

function detectPlatform(url) {
  if (!url) return null;
  const u = url.toLowerCase();
  for (const [domain, name] of PLATFORM_MAP) { if (u.includes(domain)) return name; }
  return null;
}

// ── Investigation storage ─────────────────────────────────────────────────

function saveInvestigation(data) {
  const id = crypto.randomBytes(12).toString("hex");
  const ts = new Date().toISOString();
  const record = { id, created: ts, ...data };
  const filePath = path.join(DATA_DIR, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2));
  return id;
}

function loadInvestigation(id) {
  if (!/^[a-f0-9]{24}$/.test(id)) return null;
  const filePath = path.join(DATA_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); }
  catch { return null; }
}

function listInvestigations() {
  try {
    return fs.readdirSync(DATA_DIR)
      .filter(f => f.endsWith(".json"))
      .map(f => {
        try {
          const raw = fs.readFileSync(path.join(DATA_DIR, f), "utf-8");
          const d = JSON.parse(raw);
          return { id: d.id, created: d.created, query: d.query || null, label: d.label || null };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.created) - new Date(a.created));
  } catch { return []; }
}

function deleteInvestigation(id) {
  if (!/^[a-f0-9]{24}$/.test(id)) return false;
  const filePath = path.join(DATA_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return false;
  try { fs.unlinkSync(filePath); return true; }
  catch { return false; }
}

// ══════════════════════════════════════════════════════════════════════════
//  ROUTE HANDLERS START BELOW
// ══════════════════════════════════════════════════════════════════════════
// ── All API lookup functions ────────────────────────────────────────────

async function lookupGitHub(username) {
  const data = await safeFetch(`https://api.github.com/users/${encodeURIComponent(username)}`);
  if (!data || data.message) return null;
  return { source: "GitHub", profile_url: data.html_url, avatar: data.avatar_url,
    name: data.name, bio: data.bio, location: data.location, company: data.company,
    blog: data.blog, public_repos: data.public_repos, followers: data.followers,
    following: data.following, twitter_username: data.twitter_username, created: data.created_at };
}

async function lookupGitHubByName(name) {
  const data = await safeFetch(`https://api.github.com/search/users?q=${encodeURIComponent(name)}&per_page=5`);
  if (!data || !data.items || !data.items.length) return null;
  const results = [];
  for (const u of data.items.slice(0, 3)) {
    const d = await lookupGitHub(u.login);
    if (d) results.push(d);
  }
  return results.length ? results : null;
}

async function lookupGitHubEmails(username) {
  const data = await safeFetch(`https://api.github.com/users/${encodeURIComponent(username)}/events/public?per_page=30`);
  if (!data || !data.length) return null;
  const emails = new Set();
  for (const ev of data) {
    if (ev.type === "PushEvent" && ev.payload?.commits) {
      for (const c of ev.payload.commits) {
        if (c.author?.email && !c.author.email.includes("noreply") && !c.author.email.includes("users.noreply")) {
          emails.add(c.author.email);
        }
      }
    }
  }
  if (!emails.size) return null;
  return { source: "GitHub Commit Emails", name: username + "'s Commit Emails",
    emails_found: [...emails].join(", "),
    note: "Extracted from public git commits" };
}

async function lookupGitHubRepos(username) {
  const data = await safeFetch(`https://api.github.com/users/${encodeURIComponent(username)}/repos?sort=stars&per_page=10`);
  if (!data || !data.length) return null;
  const langs = [...new Set(data.map(r => r.language).filter(Boolean))];
  const totalStars = data.reduce((s, r) => s + r.stargazers_count, 0);
  return { source: "GitHub Repos", profile_url: `https://github.com/${encodeURIComponent(username)}?tab=repositories`,
    name: username + "'s Projects", top_languages: langs.slice(0,6).join(", "),
    total_stars: totalStars, top_repos: data.slice(0,3).map(r => r.name + " (" + r.stargazers_count + " stars)").join(", ") };
}

async function lookupGitHubGists(username) {
  const data = await safeFetch(`https://api.github.com/users/${encodeURIComponent(username)}/gists?per_page=5`);
  if (!data || !data.length) return null;
  return { source: "GitHub Gists", profile_url: `https://gist.github.com/${encodeURIComponent(username)}`,
    name: username + "'s Gists", gist_count: data.length + "+",
    languages: [...new Set(data.flatMap(g => Object.values(g.files).map(f => f.language)).filter(Boolean))].join(", ") || null };
}

async function lookupGitHubEvents(username) {
  const data = await safeFetch(`https://api.github.com/users/${encodeURIComponent(username)}/events/public?per_page=30`);
  if (!data || !data.length) return null;
  const types = {};
  const repos = new Set();
  data.forEach(e => { types[e.type] = (types[e.type] || 0) + 1; repos.add(e.repo?.name); });
  return { source: "GitHub Activity", name: username + "'s Recent Activity",
    events_analyzed: data.length,
    activity_types: Object.entries(types).sort((a,b) => b[1] - a[1]).map(([k,v]) => k.replace("Event","") + " (" + v + ")").join(", "),
    active_repos: [...repos].slice(0,5).join(", "),
    active_hours: [...new Set(data.map(e => new Date(e.created_at).getUTCHours()))].sort((a,b)=>a-b).map(h => h + ":00 UTC").join(", ") };
}

async function lookupReddit(username) {
  const data = await safeFetch(`https://www.reddit.com/user/${encodeURIComponent(username)}/about.json`);
  if (!data || !data.data) return null;
  const d = data.data;
  return { source: "Reddit", profile_url: `https://www.reddit.com/user/${d.name}`,
    avatar: d.icon_img ? d.icon_img.split("?")[0] : null, name: d.name,
    link_karma: d.link_karma, comment_karma: d.comment_karma,
    created: new Date(d.created_utc * 1000).toISOString() };
}

async function lookupWikipedia(name) {
  const data = await safeFetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name.replace(/ /g, "_"))}`);
  if (!data || data.type === "not_found") return null;
  return { source: "Wikipedia", profile_url: data.content_urls?.desktop?.page,
    thumbnail: data.thumbnail?.source, name: data.title, description: data.description,
    extract: data.extract };
}

async function lookupStackOverflow(username) {
  const data = await safeFetch(`https://api.stackexchange.com/2.3/users?order=desc&sort=reputation&inname=${encodeURIComponent(username)}&site=stackoverflow&pagesize=3`);
  if (!data || !data.items || !data.items.length) return null;
  return data.items.slice(0, 3).map(u => ({
    source: "Stack Overflow", profile_url: u.link, avatar: u.profile_image,
    name: u.display_name, reputation: u.reputation, location: u.location,
    created: new Date(u.creation_date * 1000).toISOString() }));
}

async function lookupHackerNews(username) {
  const data = await safeFetch(`https://hacker-news.firebaseio.com/v0/user/${encodeURIComponent(username)}.json`);
  if (!data || !data.id) return null;
  return { source: "Hacker News", profile_url: `https://news.ycombinator.com/user?id=${data.id}`,
    name: data.id, karma: data.karma, about: data.about,
    created: new Date(data.created * 1000).toISOString() };
}

async function lookupGitLab(username) {
  const data = await safeFetch(`https://gitlab.com/api/v4/users?username=${encodeURIComponent(username)}`);
  if (!data || !data.length) return null;
  const u = data[0];
  return { source: "GitLab", profile_url: u.web_url, avatar: u.avatar_url,
    name: u.name, username: u.username, bio: u.bio || null, created: u.created_at };
}

async function lookupKeybase(username) {
  const data = await safeFetch(`https://keybase.io/_/api/1.0/user/lookup.json?usernames=${encodeURIComponent(username)}`);
  if (!data || !data.them || !data.them.length || !data.them[0]) return null;
  const u = data.them[0];
  const proofs = (u.proofs_summary?.all || []).map(p => p.proof_type + ": " + p.nametag);
  return { source: "Keybase", profile_url: `https://keybase.io/${u.basics?.username}`,
    avatar: u.pictures?.primary?.url, name: u.profile?.full_name,
    bio: u.profile?.bio, linked_accounts: proofs.join(", ") || null };
}

async function lookupNpm(username) {
  const data = await safeFetch(`https://registry.npmjs.org/-/user/org.couchdb.user:${encodeURIComponent(username)}`);
  if (!data || data.error) return null;
  return { source: "npm", profile_url: `https://www.npmjs.com/~${encodeURIComponent(username)}`,
    name: data.name, email: data.email || null };
}

async function lookupDockerHub(username) {
  const data = await safeFetch(`https://hub.docker.com/v2/users/${encodeURIComponent(username)}`);
  if (!data || data.detail) return null;
  return { source: "Docker Hub", profile_url: `https://hub.docker.com/u/${data.username}`,
    avatar: data.gravatar_url, name: data.full_name || data.username,
    company: data.company, location: data.location, joined: data.date_joined };
}

async function lookupDevTo(username) {
  const data = await safeFetch(`https://dev.to/api/users/by_username?url=${encodeURIComponent(username)}`);
  if (!data || !data.id) return null;
  return { source: "DEV.to", profile_url: `https://dev.to/${data.username}`,
    avatar: data.profile_image, name: data.name, bio: data.summary,
    github: data.github_username, twitter: data.twitter_username };
}

async function lookupLichess(username) {
  const data = await safeFetch(`https://lichess.org/api/user/${encodeURIComponent(username)}`);
  if (!data || data.error) return null;
  return { source: "Lichess", profile_url: data.url, name: data.username,
    bio: data.profile?.bio, country: data.profile?.country, games_played: data.count?.all,
    created: new Date(data.createdAt).toISOString() };
}

async function lookupChessCom(username) {
  const data = await safeFetch(`https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}`);
  if (!data || !data.username) return null;
  return { source: "Chess.com", profile_url: data.url,
    name: data.name || data.username, avatar: data.avatar,
    title: data.title, location: data.location, followers: data.followers,
    joined: data.joined ? new Date(data.joined * 1000).toISOString() : null };
}

async function lookupRoblox(username) {
  const data = await safeFetch(`https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(username)}&limit=10`);
  if (!data || !data.data || !data.data.length) return null;
  const exact = data.data.find(u => u.name.toLowerCase() === username.toLowerCase()) || data.data[0];
  return { source: "Roblox", profile_url: `https://www.roblox.com/users/${exact.id}/profile`,
    name: exact.name, display_name: exact.displayName };
}

async function lookupMastodon(username) {
  const data = await safeFetch(`https://mastodon.social/api/v2/search?q=${encodeURIComponent(username)}&type=accounts&limit=3`);
  if (!data || !data.accounts || !data.accounts.length) return null;
  return data.accounts.slice(0, 2).map(a => ({
    source: "Mastodon", profile_url: a.url, avatar: a.avatar,
    name: a.display_name, username: a.acct, followers: a.followers_count,
    posts: a.statuses_count, created: a.created_at }));
}

async function lookupGravatar(query) {
  try {
    const hash = query.includes("@")
      ? crypto.createHash("md5").update(query.trim().toLowerCase()).digest("hex")
      : query.toLowerCase();
    const data = await safeFetch(`https://en.gravatar.com/${encodeURIComponent(hash)}.json`);
    if (!data || !data.entry || !data.entry.length) return null;
    const e = data.entry[0];
    return { source: "Gravatar", profile_url: e.profileUrl, avatar: e.thumbnailUrl,
      name: e.displayName, about: e.aboutMe, location: e.currentLocation };
  } catch { return null; }
}

async function lookupWikidata(name) {
  const data = await safeFetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&limit=3&format=json&origin=*`);
  if (!data || !data.search || !data.search.length) return null;
  return data.search.slice(0, 2).map(e => ({
    source: "Wikidata", profile_url: `https://www.wikidata.org/wiki/${e.id}`,
    name: e.label, description: e.description, wikidata_id: e.id }));
}

async function lookupOpenLibrary(name) {
  const data = await safeFetch(`https://openlibrary.org/search/authors.json?q=${encodeURIComponent(name)}&limit=3`);
  if (!data || !data.docs || !data.docs.length) return null;
  return data.docs.filter(d => d.work_count > 0).slice(0, 2).map(d => ({
    source: "Open Library", profile_url: `https://openlibrary.org/authors/${d.key}`,
    name: d.name, birth_date: d.birth_date, top_work: d.top_work, works_count: d.work_count }));
}

async function lookupDNS(query) {
  if (!/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(query)) return null;
  const data = await safeFetch(`https://dns.google/resolve?name=${encodeURIComponent(query)}&type=A`);
  if (!data) return null;
  return { source: "DNS Lookup", domain: query, status_code: data.Status,
    answers: (data.Answer || []).map(a => ({ type: a.type, data: a.data })) };
}

async function lookupRDAP(query) {
  if (!/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(query)) return null;
  const data = await safeFetch(`https://rdap.org/domain/${encodeURIComponent(query)}`);
  if (!data || data.errorCode) return null;
  const events = {};
  (data.events || []).forEach(e => { events[e.eventAction] = e.eventDate; });
  return { source: "WHOIS / RDAP", domain: data.ldhName,
    status: (data.status || []).join(", "),
    registered: events.registration, expires: events.expiration,
    nameservers: (data.nameservers || []).map(n => n.ldhName).join(", ") };
}

async function lookupIPGeo(query) {
  if (!/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(query)) return null;
  const dns = await safeFetch(`https://dns.google/resolve?name=${encodeURIComponent(query)}&type=A`);
  if (!dns || !dns.Answer || !dns.Answer.length) return null;
  const ip = dns.Answer.find(a => a.type === 1)?.data;
  if (!ip) return null;
  const geo = await safeFetch(`https://ipapi.co/${ip}/json/`);
  if (!geo || geo.error) return null;
  return { source: "IP Geolocation", domain: query, ip,
    city: geo.city, region: geo.region, country: geo.country_name,
    org: geo.org, timezone: geo.timezone };
}

async function lookupWayback(query) {
  const data = await safeFetch(`https://archive.org/wayback/available?url=${encodeURIComponent(query)}`);
  if (!data || !data.archived_snapshots || !data.archived_snapshots.closest) return null;
  const snap = data.archived_snapshots.closest;
  return { source: "Wayback Machine", profile_url: snap.url,
    name: "Internet Archive Snapshot", snapshot_date: snap.timestamp };
}

async function lookupArchiveOrg(query) {
  const data = await safeFetch(`https://archive.org/advancedsearch.php?q=creator%3A%22${encodeURIComponent(query)}%22&output=json&rows=3`);
  if (!data || !data.response || !data.response.docs || !data.response.docs.length) return null;
  return data.response.docs.slice(0, 2).map(d => ({
    source: "Internet Archive", profile_url: `https://archive.org/details/${d.identifier}`,
    name: d.title, creator: d.creator, type: d.mediatype, date: d.date }));
}

async function lookupDuckDuckGo(query) {
  const data = await safeFetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1`);
  if (!data) return null;
  const results = [];
  if (data.Abstract) {
    results.push({ source: "DuckDuckGo", profile_url: data.AbstractURL,
      name: data.Heading || query, description: data.Abstract,
      image: data.Image ? "https://duckduckgo.com" + data.Image : null });
  }
  if (data.Infobox?.content?.length) {
    const info = {};
    data.Infobox.content.slice(0, 8).forEach(c => { info[c.label] = c.value; });
    if (Object.keys(info).length) {
      results.push({ source: "DuckDuckGo Infobox", name: data.Heading || query, ...info });
    }
  }
  return results.length ? results : null;
}

async function lookupPyPI(username) {
  const data = await safeFetch(`https://pypi.org/pypi/${encodeURIComponent(username)}/json`);
  if (!data || !data.info) return null;
  return { source: "PyPI Package", profile_url: data.info.project_url || data.info.package_url,
    name: data.info.name, author: data.info.author, author_email: data.info.author_email,
    summary: data.info.summary, version: data.info.version };
}

async function lookupCratesIO(username) {
  const data = await safeFetch(`https://crates.io/api/v1/users/${encodeURIComponent(username)}`);
  if (!data || !data.user) return null;
  return { source: "Crates.io", profile_url: `https://crates.io/users/${data.user.login}`,
    avatar: data.user.avatar, name: data.user.name || data.user.login };
}

async function lookupHuggingFace(username) {
  const data = await safeFetch(`https://huggingface.co/api/users/${encodeURIComponent(username)}/overview`);
  if (!data) return null;
  return { source: "Hugging Face", profile_url: `https://huggingface.co/${encodeURIComponent(username)}`,
    name: data.fullname || username, avatar: data.avatarUrl,
    num_models: data.numModels, num_datasets: data.numDatasets };
}

async function lookupBreaches(query) {
  if (!query.includes("@")) {
    const data = await safeFetch("https://haveibeenpwned.com/api/v3/breaches");
    if (!data) return null;
    return { source: "HIBP Breach Database",
      note: "Enter an email address to check specific breach exposure",
      total_known_breaches: data.length,
      largest_breaches: data.sort((a,b) => b.PwnCount - a.PwnCount).slice(0,5).map(b => b.Name + " (" + (b.PwnCount/1e6).toFixed(1) + "M)").join(", ") };
  }
  return null;
}

// Confidence scoring for face scan matches
function scoreFaceScanMatch(m, identifiedName) {
  // High: direct engine match with identified person, username-check confirmed
  if (m.source_engine === "username-check") return "high";
  if (m.source_engine === "yandex-faces" || m.source_engine === "facecheck") return "high";
  if (m.source_engine === "yandex" && m.title && identifiedName && m.title.toLowerCase().includes(identifiedName.toLowerCase())) return "high";
  if (m.source_engine === "google" && m.title && identifiedName && m.title.toLowerCase().includes(identifiedName.toLowerCase())) return "high";
  // Medium: direct engine results, site-scoped searches
  if (["yandex", "google", "bing", "tineye", "baidu", "search4faces", "saucenao"].includes(m.source_engine)) return "medium";
  if (m.source_engine === "ddg-site" && m.platform) return "medium";
  if (m.source_engine === "people-search") return "medium";
  if (m.source_engine === "deep-crawl" && m.platform) return "medium";
  // Low: generic web, images from search pages
  return "low";
}
// ══════════════════════════════════════════════════════════════════════════
//  FACE SCANNING PIPELINE v3 — DEEP SEARCH EVERYWHERE
// ══════════════════════════════════════════════════════════════════════════

// ── Chain request with PROPER redirect tracking ─────────────────────────
function chainRequest(startUrl, options = {}, depth = 0, _redirectChain = []) {
  return new Promise((resolve) => {
    if (depth > 10) return resolve({ statusCode: 0, body: "", startUrl, finalUrl: startUrl, redirectChain: _redirectChain, error: "too many redirects" });
    try {
      const parsed = new URL(startUrl);
      const driver = parsed.protocol === "https:" ? https : http;
      const reqOpts = {
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        method: options.method || "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "identity",
          "Connection": "keep-alive",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          ...(options.headers || {}),
        },
      };
      const req = driver.request(reqOpts, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          let loc = res.headers.location;
          if (loc.startsWith("/")) loc = parsed.protocol + "//" + parsed.hostname + loc;
          else if (!loc.startsWith("http")) loc = parsed.protocol + "//" + parsed.hostname + "/" + loc;
          _redirectChain.push(loc);
          const prevCookies = options.headers?.Cookie || "";
          const newCookies = res.headers["set-cookie"]?.map(c => c.split(";")[0]).join("; ") || "";
          const allCookies = [prevCookies, newCookies].filter(Boolean).join("; ");
          chainRequest(loc, { method: "GET", headers: { Cookie: allCookies }, timeout: options.timeout }, depth + 1, _redirectChain).then(resolve);
          return;
        }
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => {
          let bodyStr;
          try { bodyStr = Buffer.concat(chunks).toString("utf-8"); } catch { bodyStr = ""; }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: bodyStr,
            bodySize: bodyStr.length,
            startUrl: _redirectChain.length ? _redirectChain[0] : startUrl,
            finalUrl: startUrl,  // THIS is the URL we actually fetched (the last redirect target)
            redirectChain: _redirectChain,
            redirectCount: depth,
          });
        });
      });
      req.on("error", err => resolve({ statusCode: 0, body: "", startUrl, finalUrl: startUrl, redirectChain: _redirectChain, error: err.message, bodySize: 0 }));
      req.setTimeout(options.timeout || 30000, () => { req.destroy(); resolve({ statusCode: 0, body: "", startUrl, finalUrl: startUrl, redirectChain: _redirectChain, error: "timeout", bodySize: 0 }); });
      if (options.body) req.write(options.body);
      req.end();
    } catch (err) { resolve({ statusCode: 0, body: "", startUrl, finalUrl: startUrl, redirectChain: _redirectChain, error: err.message, bodySize: 0 }); }
  });
}

// Retry wrapper
async function withRetry(fn, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    const result = await fn();
    if (result && result.status !== "error") return result;
    if (i < retries) await new Promise(r => setTimeout(r, 1500 * (i + 1)));
  }
  return await fn();
}

// detectPlatform and PLATFORM_MAP defined in srv_part1

// ── Username extraction from URLs ───────────────────────────────────────
function extractUsernameFromUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace("www.", "");
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (!parts.length) return null;
    if (host.includes("instagram.com") && !["p", "reel", "explore", "accounts", "directory"].includes(parts[0])) return parts[0];
    if ((host.includes("twitter.com") || host.includes("x.com")) && !["i", "search", "hashtag", "intent", "home", "explore", "settings"].includes(parts[0])) return parts[0];
    if (host.includes("facebook.com") && !["pages", "groups", "events", "watch", "marketplace", "profile.php"].includes(parts[0])) return parts[0];
    if (host.includes("tiktok.com") && parts[0].startsWith("@")) return parts[0].slice(1);
    if (host.includes("linkedin.com") && parts[0] === "in" && parts[1]) return parts[1];
    if (host.includes("youtube.com")) { if (parts[0].startsWith("@")) return parts[0].slice(1); if (["c","user","channel"].includes(parts[0]) && parts[1]) return parts[1]; }
    if (host.includes("reddit.com") && parts[0] === "user" && parts[1]) return parts[1];
    if (host.includes("github.com") && !["features","enterprise","pricing","login","join","orgs","settings"].includes(parts[0])) return parts[0];
    if (host.includes("pinterest.com") && !["pin","search","ideas","today"].includes(parts[0])) return parts[0];
    if (host.includes("twitch.tv") && !["directory","videos","settings","downloads"].includes(parts[0])) return parts[0];
    if (host.includes("vk.com") && !["feed","im","groups","video","music"].includes(parts[0])) return parts[0];
  } catch {}
  return null;
}

// Helper: extract ALL external links from HTML
function extractLinks(html, excludeDomains = []) {
  const results = [];
  const seen = new Set();
  const regex = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const href = m[1];
    const hrefLower = href.toLowerCase();
    if (seen.has(href)) continue;
    let dominated = false;
    for (const ex of excludeDomains) { if (hrefLower.includes(ex)) { dominated = true; break; } }
    if (dominated) continue;
    seen.add(href);
    const text = m[2].replace(/<[^>]*>/g, "").trim();
    if (text.length > 0 && text.length < 300) results.push({ title: text, url: href });
  }
  return results;
}

// Helper: extract ALL image URLs from HTML
function extractImages(html, excludeDomains = []) {
  const results = [];
  const seen = new Set();
  const patterns = [
    /(?:src|data-src|href)="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp|gif)[^"]*)"/gi,
    /\["(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp|gif)[^"]*)",\s*\d+,\s*\d+\]/gi,
    /(?:url|image|img|photo|thumb|avatar|src)\s*[=:]\s*["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp|gif)[^"']*)["']/gi,
  ];
  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(html)) !== null) {
      const url = m[1].replace(/\\u003d/g, "=").replace(/\\u0026/g, "&").replace(/\\u002f/gi, "/");
      if (seen.has(url)) continue;
      let dominated = false;
      for (const ex of excludeDomains) { if (url.toLowerCase().includes(ex)) { dominated = true; break; } }
      if (dominated) continue;
      seen.add(url);
      results.push(url);
    }
  }
  return results;
}

// ══════════════════════════════════════════════════════════════════════════
//  SEARCH ENGINES — 9 engines with retry, diagnostics, deep parsing
// ══════════════════════════════════════════════════════════════════════════

async function yandexFaceScan(buffer, filename, contentType) {
  try {
    const { boundary, body } = buildMultipart({}, "upfile", buffer, filename, contentType);
    const response = await chainRequest("https://yandex.com/images/search?rpt=imageview", {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length.toString(), "Referer": "https://yandex.com/images/" },
      body, timeout: 35000,
    });
    const html = response.body || "";
    const results = [];
    let identifiedName = null;
    const diag = { bodySize: html.length, status: response.statusCode, redirects: response.redirectCount || 0, finalUrl: response.finalUrl };

    // Try getting cbir_id from redirect chain
    let cbirId = null;
    for (const rurl of (response.redirectChain || [])) { const m = rurl.match(/cbir_id=([^&]+)/); if (m) cbirId = m[1]; }
    if (!cbirId) { const m = (response.finalUrl || "").match(/cbir_id=([^&]+)/); if (m) cbirId = m[1]; }
    diag.cbirId = cbirId;

    // Extract CBIR tags (person name)
    const tagMatches = [...html.matchAll(/CbirTags[\s\S]{0,3000}?<\/div>/gi)];
    for (const tm of tagMatches) {
      const links = [...tm[0].matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)];
      for (const l of links) {
        const t = l[1].replace(/<[^>]*>/g, "").trim();
        if (t && t.length > 1 && t.length < 80) { if (!identifiedName) identifiedName = t; }
      }
    }

    // Extract serp-items
    const serpRegex = /data-bem='(\{"serp-item":\{[^']*\})'/g;
    let match;
    while ((match = serpRegex.exec(html)) !== null) {
      try {
        const decoded = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
        const data = JSON.parse(decoded)["serp-item"];
        if (data) results.push({ title: data.snippet?.title || "", url: data.snippet?.url || data.img_href || "", thumbnail: data.preview?.[0]?.url || data.thumb?.url || "", image_url: data.img_href || "", source_engine: "yandex" });
      } catch {}
    }

    // Extract ALL links
    const links = extractLinks(html, ["yandex.", "yastatic."]);
    for (const l of links) { if (!results.some(r => r.url === l.url)) results.push({ ...l, source_engine: "yandex" }); }

    // Extract ALL images
    const images = extractImages(html, ["yandex.", "yastatic.", "avatars.mds"]);
    for (const img of images.slice(0, 20)) {
      if (!results.some(r => r.url === img)) results.push({ title: "Yandex image match", url: img, thumbnail: img, image_url: img, source_engine: "yandex-img" });
    }

    // ── JSON API request if we got cbir_id ──
    if (cbirId) {
      try {
        const jsonResp = await chainRequest(`https://yandex.com/images/search?format=json&rpt=imageview&cbir_id=${cbirId}`, { timeout: 20000 });
        diag.jsonApiSize = (jsonResp.body || "").length;
        if (jsonResp.body) {
          // Try parsing as JSON
          try {
            const jd = JSON.parse(jsonResp.body);
            const blocks = jd.blocks || [];
            for (const block of blocks) {
              if (block.html) {
                const blinks = extractLinks(block.html, ["yandex."]);
                for (const bl of blinks) { if (!results.some(r => r.url === bl.url)) results.push({ ...bl, source_engine: "yandex-json" }); }
                const bimgs = extractImages(block.html, ["yandex.", "yastatic."]);
                for (const bi of bimgs.slice(0, 10)) { if (!results.some(r => r.url === bi)) results.push({ title: "Yandex similar", url: bi, thumbnail: bi, source_engine: "yandex-json" }); }
              }
            }
          } catch {
            // Not JSON — parse as HTML
            const jlinks = extractLinks(jsonResp.body, ["yandex."]);
            for (const jl of jlinks) { if (!results.some(r => r.url === jl.url)) results.push({ ...jl, source_engine: "yandex-json" }); }
          }
        }
      } catch {}

      // ── Also try the "similar faces" API ──
      try {
        const facesResp = await chainRequest(`https://yandex.com/images/search?rpt=imageview&cbir_id=${cbirId}&cbir_page=similar`, { timeout: 20000 });
        diag.facesApiSize = (facesResp.body || "").length;
        const flinks = extractLinks(facesResp.body || "", ["yandex."]);
        for (const fl of flinks) { if (!results.some(r => r.url === fl.url)) results.push({ ...fl, source_engine: "yandex-faces" }); }
        const fimgs = extractImages(facesResp.body || "", ["yandex.", "yastatic."]);
        for (const fi of fimgs.slice(0, 15)) { if (!results.some(r => r.url === fi)) results.push({ title: "Yandex face match", url: fi, thumbnail: fi, source_engine: "yandex-faces" }); }
      } catch {}
    }

    for (const r of results) r.platform = detectPlatform(r.url);
    return { engine: "yandex", status: "ok", results_url: response.finalUrl, identified_name: identifiedName, matches: results.slice(0, 60), diag };
  } catch (err) { return { engine: "yandex", status: "error", error: err.message, matches: [], diag: {} }; }
}

async function googleFaceScan(buffer, filename, contentType) {
  try {
    const { boundary, body } = buildMultipart({ image_url: "", sbisrc: "cr_1" }, "encoded_image", buffer, filename, contentType);
    const response = await chainRequest("https://www.google.com/searchbyimage/upload", {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length.toString(), "Referer": "https://www.google.com/" },
      body, timeout: 35000,
    });
    const html = response.body || "";
    const results = [];
    let identifiedName = null;
    const diag = { bodySize: html.length, status: response.statusCode, redirects: response.redirectCount || 0, finalUrl: response.finalUrl };

    // Entity identification — many patterns
    for (const pat of [
      /Results for[:\s]*<[^>]*>([^<]+)/i, /data-attrid="title"[^>]*>([^<]+)/i,
      /"kc_nm"[^>]*>([^<]+)/i, /aria-level="3"[^>]*>([^<]{2,60})<\//i,
      /class="[^"]*SDkEP[^"]*"[^>]*>([^<]+)/i, /Possible related search[:\s]*<[^>]*>([^<]+)/i,
      /class="[^"]*fKDtNb[^"]*"[^>]*>([^<]+)/i, /class="[^"]*r5a77d[^"]*"[^>]*>([^<]+)/i,
    ]) {
      const m = html.match(pat);
      if (m && !identifiedName) { const n = m[1].trim(); if (n.length > 1 && n.length < 60 && !n.includes("<")) identifiedName = n; }
    }

    // Extract links and images
    const links = extractLinks(html, ["google.com", "gstatic.com", "googleapis.com", "youtube.com/embed"]);
    for (const l of links) results.push({ ...l, source_engine: "google" });
    const images = extractImages(html, ["gstatic.com", "google.com", "googleapis.com"]);
    for (const img of images.slice(0, 20)) {
      if (!results.some(r => r.url === img)) results.push({ title: "Google visual match", url: img, thumbnail: img, source_engine: "google-img" });
    }
    // Google /url?q= redirects
    for (const rl of [...html.matchAll(/\/url\?[^"]*q=(https?(?:%3A|:)[^&"]+)/gi)]) {
      const decoded = decodeURIComponent(rl[1]);
      if (!decoded.includes("google.com") && !results.some(r => r.url === decoded)) results.push({ title: "Google result", url: decoded, source_engine: "google" });
    }

    for (const r of results) r.platform = detectPlatform(r.url);
    return { engine: "google", status: "ok", results_url: response.finalUrl, identified_name: identifiedName, matches: results.slice(0, 60), diag };
  } catch (err) { return { engine: "google", status: "error", error: err.message, matches: [], diag: {} }; }
}

async function bingFaceScan(buffer, filename, contentType) {
  try {
    const { boundary, body } = buildMultipart({}, "image", buffer, filename, contentType);
    const response = await chainRequest("https://www.bing.com/images/search?view=detailv2&iss=sbiupload&FORM=SBIHMP&sbifnm=" + encodeURIComponent(filename), {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length.toString() },
      body, timeout: 35000,
    });
    const html = response.body || "";
    const results = [];
    let identifiedName = null;
    const diag = { bodySize: html.length, status: response.statusCode, redirects: response.redirectCount || 0, finalUrl: response.finalUrl };
    const entityMatch = html.match(/class="[^"]*entity[^"]*"[\s\S]*?<a[^>]*>([^<]+)/i) || html.match(/<h2[^>]*>([^<]{2,60})<\/h2>/i);
    if (entityMatch) identifiedName = entityMatch[1].trim();
    const links = extractLinks(html, ["bing.com", "microsoft.com", "msn.com"]);
    for (const l of links) results.push({ ...l, source_engine: "bing" });
    const images = extractImages(html, ["bing.com", "bing.net", "microsoft.com"]);
    for (const img of images.slice(0, 20)) {
      if (!results.some(r => r.url === img)) results.push({ title: "Bing visual match", url: img, thumbnail: img, source_engine: "bing-img" });
    }
    for (const r of results) r.platform = detectPlatform(r.url);
    return { engine: "bing", status: "ok", results_url: response.finalUrl, identified_name: identifiedName, matches: results.slice(0, 50), diag };
  } catch (err) { return { engine: "bing", status: "error", error: err.message, matches: [], diag: {} }; }
}

async function tineyeFaceScan(buffer, filename, contentType) {
  try {
    const { boundary, body } = buildMultipart({}, "image", buffer, filename, contentType);
    const response = await chainRequest("https://tineye.com/search", {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length.toString() },
      body, timeout: 35000,
    });
    const html = response.body || "";
    const results = [];
    const diag = { bodySize: html.length, status: response.statusCode, finalUrl: response.finalUrl };
    const links = extractLinks(html, ["tineye.com"]);
    for (const l of links) results.push({ ...l, source_engine: "tineye" });
    const countMatch = html.match(/(\d+)\s*(?:results?|matches?)/i);
    diag.totalMatches = countMatch ? parseInt(countMatch[1]) : 0;
    for (const r of results) r.platform = detectPlatform(r.url);
    return { engine: "tineye", status: "ok", results_url: response.finalUrl, total_matches: diag.totalMatches, matches: results.slice(0, 30), diag };
  } catch (err) { return { engine: "tineye", status: "error", error: err.message, matches: [], diag: {} }; }
}

async function baiduFaceScan(buffer, filename, contentType) {
  try {
    const { boundary, body } = buildMultipart({}, "image", buffer, filename, contentType);
    const response = await chainRequest("https://graph.baidu.com/upload", {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length.toString() },
      body, timeout: 35000,
    });
    const results = [];
    let identifiedName = null;
    const diag = { bodySize: (response.body || "").length, status: response.statusCode, finalUrl: response.finalUrl };
    try {
      const json = JSON.parse(response.body);
      if (json.data?.url) {
        const pageResp = await chainRequest(json.data.url, { timeout: 25000 });
        diag.pageSize = (pageResp.body || "").length;
        const html = pageResp.body || "";
        const nameMatch = html.match(/"name"\s*:\s*"([^"]+)"/i) || html.match(/class="[^"]*card-title[^"]*"[^>]*>([^<]+)/i);
        if (nameMatch) identifiedName = nameMatch[1].trim();
        const links = extractLinks(html, ["baidu.com", "bdstatic.com", "bdimg.com"]);
        for (const l of links) results.push({ ...l, source_engine: "baidu" });
        const images = extractImages(html, ["baidu.com", "bdstatic.com", "bdimg.com"]);
        for (const img of images.slice(0, 15)) {
          if (!results.some(r => r.url === img)) results.push({ title: "Baidu match", url: img, thumbnail: img, source_engine: "baidu" });
        }
      }
    } catch {}
    for (const r of results) r.platform = detectPlatform(r.url);
    return { engine: "baidu", status: "ok", results_url: response.finalUrl, identified_name: identifiedName, matches: results.slice(0, 30), diag };
  } catch (err) { return { engine: "baidu", status: "error", error: err.message, matches: [], diag: {} }; }
}

async function saucenaoFaceScan(buffer, filename, contentType) {
  try {
    const { boundary, body } = buildMultipart({ db: "999", output_type: "0" }, "file", buffer, filename, contentType);
    const response = await chainRequest("https://saucenao.com/search.php", {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length.toString() },
      body, timeout: 35000,
    });
    const html = response.body || "";
    const results = [];
    const diag = { bodySize: html.length, status: response.statusCode };
    const links = extractLinks(html, ["saucenao.com"]);
    for (const l of links) results.push({ ...l, source_engine: "saucenao" });
    for (const r of results) r.platform = detectPlatform(r.url);
    return { engine: "saucenao", status: "ok", results_url: response.finalUrl, matches: results.slice(0, 20), diag };
  } catch (err) { return { engine: "saucenao", status: "error", error: err.message, matches: [], diag: {} }; }
}

async function karmaDecayScan(buffer, filename, contentType) {
  try {
    const { boundary, body } = buildMultipart({}, "image", buffer, filename, contentType);
    const response = await chainRequest("http://karmadecay.com/search", {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length.toString() },
      body, timeout: 25000,
    });
    const results = [];
    const diag = { bodySize: (response.body || "").length, status: response.statusCode };
    const links = extractLinks(response.body || "", ["karmadecay.com"]);
    for (const l of links) results.push({ ...l, platform: detectPlatform(l.url), source_engine: "karmadecay" });
    return { engine: "karmadecay", status: "ok", matches: results.slice(0, 10), diag };
  } catch (err) { return { engine: "karmadecay", status: "error", error: err.message, matches: [], diag: {} }; }
}

// ── 8. FACECHECK.ID (dedicated face search engine) ─────────────────────

async function faceCheckScan(buffer, filename, contentType) {
  try {
    const { boundary, body } = buildMultipart({}, "images", buffer, filename, contentType);
    const response = await chainRequest("https://facecheck.id/api/upload", {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length.toString(), "Referer": "https://facecheck.id", "Origin": "https://facecheck.id" },
      body, timeout: 40000,
    });
    const results = [];
    const diag = { bodySize: (response.body || "").length, status: response.statusCode, finalUrl: response.finalUrl };

    // Try parsing response
    const html = response.body || "";
    try {
      const json = JSON.parse(html);
      if (json.id_search) diag.searchId = json.id_search;
      if (json.faces) {
        for (const face of (Array.isArray(json.faces) ? json.faces : [json.faces])) {
          if (face.url) results.push({ title: "FaceCheck match", url: face.url, thumbnail: face.base64 || "", source_engine: "facecheck" });
        }
      }
    } catch {
      // Not JSON, try HTML parsing
      const links = extractLinks(html, ["facecheck.id"]);
      for (const l of links) results.push({ ...l, source_engine: "facecheck" });
      const images = extractImages(html, ["facecheck.id"]);
      for (const img of images.slice(0, 20)) {
        if (!results.some(r => r.url === img)) results.push({ title: "FaceCheck match", url: img, thumbnail: img, source_engine: "facecheck" });
      }
    }

    for (const r of results) r.platform = detectPlatform(r.url);
    return { engine: "facecheck", status: "ok", results_url: response.finalUrl, matches: results.slice(0, 30), diag };
  } catch (err) { return { engine: "facecheck", status: "error", error: err.message, matches: [], diag: {} }; }
}

// ── 9. SEARCH4FACES (VK/OK face search) ────────────────────────────────

async function search4facesScan(buffer, filename, contentType) {
  try {
    const { boundary, body } = buildMultipart({}, "photo", buffer, filename, contentType);
    const response = await chainRequest("https://search4faces.com/search", {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length.toString(), "Referer": "https://search4faces.com", "Origin": "https://search4faces.com" },
      body, timeout: 40000,
    });
    const results = [];
    const html = response.body || "";
    const diag = { bodySize: html.length, status: response.statusCode, finalUrl: response.finalUrl };
    const links = extractLinks(html, ["search4faces.com"]);
    for (const l of links) results.push({ ...l, source_engine: "search4faces" });
    const images = extractImages(html, ["search4faces.com"]);
    for (const img of images.slice(0, 20)) {
      if (!results.some(r => r.url === img)) results.push({ title: "search4faces match", url: img, thumbnail: img, source_engine: "search4faces" });
    }
    // Look for VK/OK profile links specifically
    for (const m of [...html.matchAll(/(?:vk\.com|ok\.ru)\/[^\s"'<]+/gi)]) {
      const url = "https://" + m[0];
      if (!results.some(r => r.url === url)) results.push({ title: "Face match", url, source_engine: "search4faces", platform: url.includes("vk.com") ? "VK" : "Odnoklassniki" });
    }
    for (const r of results) if (!r.platform) r.platform = detectPlatform(r.url);
    return { engine: "search4faces", status: "ok", results_url: response.finalUrl, matches: results.slice(0, 30), diag };
  } catch (err) { return { engine: "search4faces", status: "error", error: err.message, matches: [], diag: {} }; }
}

// ══════════════════════════════════════════════════════════════════════════
//  DEEP SOCIAL + WEB SEARCH — text-based image hunting
// ══════════════════════════════════════════════════════════════════════════

// DuckDuckGo image-specific site-scoped searches
async function deepSiteImageSearch(name, sites) {
  const allResults = [];
  for (let i = 0; i < sites.length; i += 4) {
    const batch = sites.slice(i, i + 4);
    const batchResults = await Promise.allSettled(
      batch.map(async (site) => {
        const wr = await scrapeWebSearch(`"${name}" site:${site}`);
        return wr.slice(0, 5).map(r => ({ title: r.title, url: r.url, snippet: r.snippet, source_engine: "ddg-site", platform: detectPlatform(r.url) }));
      })
    );
    for (const br of batchResults) { if (br.status === "fulfilled") allResults.push(...br.value); }
  }
  return allResults;
}

// Cross-check username across platforms
async function crossCheckUsername(username) {
  if (!username || username.length < 2 || username.length > 40) return [];
  const profiles = [
    { name: "Instagram", url: `https://www.instagram.com/${username}/` },
    { name: "Twitter/X", url: `https://x.com/${username}` },
    { name: "Facebook", url: `https://www.facebook.com/${username}` },
    { name: "TikTok", url: `https://www.tiktok.com/@${username}` },
    { name: "GitHub", url: `https://github.com/${username}` },
    { name: "Pinterest", url: `https://www.pinterest.com/${username}/` },
    { name: "Twitch", url: `https://www.twitch.tv/${username}` },
    { name: "Reddit", url: `https://www.reddit.com/user/${username}` },
    { name: "YouTube", url: `https://www.youtube.com/@${username}` },
    { name: "LinkedIn", url: `https://www.linkedin.com/in/${username}` },
    { name: "Tumblr", url: `https://${username}.tumblr.com/` },
    { name: "Medium", url: `https://medium.com/@${username}` },
    { name: "DeviantArt", url: `https://www.deviantart.com/${username}` },
    { name: "Flickr", url: `https://www.flickr.com/people/${username}/` },
    { name: "SoundCloud", url: `https://soundcloud.com/${username}` },
    { name: "VK", url: `https://vk.com/${username}` },
    { name: "Dribbble", url: `https://dribbble.com/${username}` },
    { name: "500px", url: `https://500px.com/p/${username}` },
    { name: "Patreon", url: `https://www.patreon.com/${username}` },
    { name: "Steam", url: `https://steamcommunity.com/id/${username}` },
    { name: "Threads", url: `https://www.threads.net/@${username}` },
    { name: "Bluesky", url: `https://bsky.app/profile/${username}` },
    { name: "Snapchat", url: `https://www.snapchat.com/add/${username}` },
    { name: "Linktree", url: `https://linktr.ee/${username}` },
    { name: "OnlyFans", url: `https://onlyfans.com/${username}` },
    { name: "Fansly", url: `https://fansly.com/${username}` },
  ];
  const found = [];
  for (let i = 0; i < profiles.length; i += 8) {
    const batch = profiles.slice(i, i + 8);
    const results = await Promise.allSettled(batch.map(async (p) => {
      const check = await smartCheckUsername(p.name, p.url);
      return { ...p, exists: check.exists, confidence: check.confidence };
    }));
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.exists) {
        found.push({ title: `${r.value.name}: @${username}`, url: r.value.url, platform: r.value.name, source_engine: "username-check", confidence: r.value.confidence });
      }
    }
  }
  return found;
}

// ══════════════════════════════════════════════════════════════════════════
//  MAIN FACE SCAN — 8 phases, 9 engines, DEEP search everywhere
// ══════════════════════════════════════════════════════════════════════════

app.post("/api/face-scan", async (req, res) => {
  const { imageData } = req.body;
  if (!imageData) return res.status(400).json({ error: "imageData required" });
  const matches = imageData.match(/^data:image\/(.*?);base64,(.*)$/);
  if (!matches) return res.status(400).json({ error: "Invalid image data" });
  const ext = matches[1] === "jpeg" ? "jpg" : matches[1];
  const buffer = Buffer.from(matches[2], "base64");
  const filename = `face_${Date.now()}.${ext}`;
  const contentType = `image/${matches[1]}`;

  // Save face to disk for potential reuse
  const facePath = path.join(UPLOADS_DIR, filename);
  fs.writeFileSync(facePath, buffer);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  function send(event, data) { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} }

  let identifiedName = null;
  const allMatches = [];
  const foundUsernames = new Set();
  const engineStatuses = [];

  // ── Phase 1: Submit to ALL 9 search engines ──
  send("phase", { phase: 1, label: "Submitting face to 9 search engines (Google, Yandex, Bing, TinEye, Baidu, SauceNAO, KarmaDecay, FaceCheck, search4faces)..." });

  const phase1 = await Promise.allSettled([
    withRetry(() => yandexFaceScan(buffer, filename, contentType)),
    withRetry(() => googleFaceScan(buffer, filename, contentType)),
    withRetry(() => bingFaceScan(buffer, filename, contentType)),
    withRetry(() => tineyeFaceScan(buffer, filename, contentType)),
    withRetry(() => baiduFaceScan(buffer, filename, contentType)),
    saucenaoFaceScan(buffer, filename, contentType),
    karmaDecayScan(buffer, filename, contentType),
    faceCheckScan(buffer, filename, contentType),
    search4facesScan(buffer, filename, contentType),
  ]);

  const engineNames = ["yandex", "google", "bing", "tineye", "baidu", "saucenao", "karmadecay", "facecheck", "search4faces"];
  for (let i = 0; i < phase1.length; i++) {
    const r = phase1[i];
    const val = r.status === "fulfilled" ? r.value : { engine: engineNames[i], status: "error", error: "Failed", matches: [] };
    if (val.status === "ok") {
      if (val.identified_name && !identifiedName) identifiedName = val.identified_name;
      allMatches.push(...(val.matches || []));
      for (const m of (val.matches || [])) {
        const un = extractUsernameFromUrl(m.url);
        if (un && un.length > 1 && un.length < 40 && !/^\d+$/.test(un)) foundUsernames.add(un);
      }
    }
    const es = {
      engine: val.engine || engineNames[i], status: val.status, match_count: val.matches?.length || 0,
      identified_name: val.identified_name, results_url: val.results_url, error: val.error,
      diag: val.diag || {},
    };
    engineStatuses.push(es);
    send("engine_result", es);
  }
  send("phase_complete", { phase: 1, engines: engineStatuses.length, total_matches: allMatches.length });

  // ── Phase 2: Deep social platform search by name (31 platforms) ──
  if (identifiedName) {
    send("phase", { phase: 2, label: `Identified: "${identifiedName}" — deep searching 31+ social platforms...` });
    send("identified", { name: identifiedName });
    const socialSites = [
      "instagram.com", "twitter.com", "x.com", "facebook.com", "linkedin.com",
      "tiktok.com", "youtube.com", "pinterest.com", "reddit.com", "tumblr.com",
      "vk.com", "flickr.com", "deviantart.com", "twitch.tv", "snapchat.com",
      "threads.net", "medium.com", "quora.com", "github.com", "spotify.com",
      "soundcloud.com", "myspace.com", "behance.net", "dribbble.com", "500px.com",
      "ok.ru", "ask.fm", "about.me", "patreon.com", "imdb.com", "wikipedia.org",
    ];
    const socialResults = await deepSiteImageSearch(identifiedName, socialSites);
    if (socialResults.length) { allMatches.push(...socialResults); send("social_results", { results: socialResults, count: socialResults.length }); }
  } else {
    send("phase", { phase: 2, label: "No name identified — skipping name-based social search" });
  }

  // ── Phase 3: Username cross-check (26 platforms per username) ──
  const uniqueUsernames = [...foundUsernames].slice(0, 5);
  if (uniqueUsernames.length) {
    send("phase", { phase: 3, label: `Checking ${uniqueUsernames.length} username(s) across 26 platforms each: ${uniqueUsernames.join(", ")}` });
    const unResults = await Promise.allSettled(uniqueUsernames.map(u => crossCheckUsername(u)));
    for (const ur of unResults) { if (ur.status === "fulfilled" && ur.value.length) { allMatches.push(...ur.value); send("username_results", { results: ur.value }); } }
  }

  // ── Phase 4: Name variations + people-search databases ──
  if (identifiedName) {
    send("phase", { phase: 4, label: "Trying name variations and people-search databases..." });
    const parts = identifiedName.toLowerCase().split(/\s+/);
    const guesses = new Set();
    if (parts.length >= 2) {
      guesses.add(parts.join("")); guesses.add(parts.join(".")); guesses.add(parts.join("_"));
      guesses.add(parts[0] + parts[parts.length-1][0]); guesses.add(parts[0][0] + parts[parts.length-1]);
    }
    const guessResults = await Promise.allSettled([...guesses].slice(0, 3).map(g => crossCheckUsername(g)));
    for (const gr of guessResults) { if (gr.status === "fulfilled") allMatches.push(...gr.value); }
    // People-search + general
    for (const q of [`"${identifiedName}" site:spokeo.com`, `"${identifiedName}" site:whitepages.com`, `"${identifiedName}" site:peekyou.com`, `"${identifiedName}" site:socialblade.com`, `"${identifiedName}" social media profile`]) {
      try { const wr = await scrapeWebSearch(q); for (const r of wr.slice(0, 3)) { allMatches.push({ title: r.title, url: r.url, snippet: r.snippet, source_engine: "people-search", platform: detectPlatform(r.url) || "People Search" }); } } catch {}
    }
    send("name_variation_results", { count: allMatches.length });
  }

  // ── Phase 5: DEEP site-specific searches (including NSFW) ──
  send("phase", { phase: 5, label: "Deep searching specific sites (social media, forums, adult sites)..." });
  const deepQueries = [];
  if (identifiedName) {
    deepQueries.push(`"${identifiedName}" photo`, `"${identifiedName}" profile picture`, `"${identifiedName}" selfie`);
  }
  for (const un of uniqueUsernames.slice(0, 2)) {
    deepQueries.push(`"${un}" profile`, `"${un}" photo`);
  }
  // NSFW site searches if name known
  if (identifiedName) {
    const nsfwSites = ["onlyfans.com", "fansly.com", "pornhub.com", "xvideos.com", "xhamster.com", "redgifs.com", "reddit.com/r/gonewild", "manyvids.com", "chaturbate.com"];
    for (const site of nsfwSites) {
      deepQueries.push(`"${identifiedName}" site:${site}`);
    }
  }
  for (const un of uniqueUsernames.slice(0, 2)) {
    deepQueries.push(`"${un}" site:onlyfans.com`, `"${un}" site:reddit.com`);
  }
  for (const q of deepQueries.slice(0, 20)) {
    try {
      const wr = await scrapeWebSearch(q);
      for (const r of wr.slice(0, 3)) {
        allMatches.push({ title: r.title, url: r.url, snippet: r.snippet, source_engine: "deep-web", platform: detectPlatform(r.url) });
      }
    } catch {}
  }

  // ── Phase 6: Follow up on found results — scrape the top result pages ──
  send("phase", { phase: 6, label: "Deep crawling top result pages for more data..." });
  const topUrls = allMatches.filter(m => m.url && m.platform).slice(0, 10).map(m => m.url);
  const seenDomains = new Set();
  for (const url of topUrls) {
    try {
      const domain = new URL(url).hostname;
      if (seenDomains.has(domain)) continue;
      seenDomains.add(domain);
      const pageResp = await chainRequest(url, { timeout: 12000 });
      if (pageResp.body && pageResp.bodySize > 500) {
        // Extract more links from this page
        const pageLinks = extractLinks(pageResp.body, [domain]);
        for (const pl of pageLinks.slice(0, 5)) {
          const plat = detectPlatform(pl.url);
          if (plat && !allMatches.some(m => m.url === pl.url)) {
            allMatches.push({ ...pl, source_engine: "deep-crawl", platform: plat });
          }
        }
        // Extract images
        const pageImgs = extractImages(pageResp.body, [domain]);
        for (const pi of pageImgs.slice(0, 5)) {
          if (!allMatches.some(m => m.url === pi)) {
            allMatches.push({ title: "Found on " + domain, url: pi, thumbnail: pi, source_engine: "deep-crawl", platform: detectPlatform(pi) });
          }
        }
      }
    } catch {}
  }

  // ── Phase 7: General web searches ──
  send("phase", { phase: 7, label: "Running final web searches..." });
  const webQs = [];
  if (identifiedName) webQs.push(`"${identifiedName}"`, `"${identifiedName}" photo`, `"${identifiedName}" instagram`, `"${identifiedName}" twitter`);
  for (const un of uniqueUsernames.slice(0, 2)) webQs.push(`"${un}"`);
  for (const q of webQs.slice(0, 8)) {
    try { const wr = await scrapeWebSearch(q); for (const r of wr.slice(0, 5)) { allMatches.push({ title: r.title, url: r.url, snippet: r.snippet, source_engine: "web", platform: detectPlatform(r.url) }); } } catch {}
  }

  // ── Phase 8: Finalize ──
  send("phase", { phase: 8, label: "Deduplicating and categorizing " + allMatches.length + " raw results..." });
  const seen = new Set();
  const deduped = [];
  for (const m of allMatches) {
    const key = (m.url || "").replace(/^https?:\/\/(?:www\.)?/, "").split("?")[0].split("#")[0].toLowerCase().replace(/\/+$/, "");
    if (key && key.length > 3 && !seen.has(key)) { seen.add(key); if (!m.platform) m.platform = detectPlatform(m.url); m.confidence = scoreFaceScanMatch(m, identifiedName); deduped.push(m); }
  }
  // Sort by confidence: high first, then medium, then low
  const confOrder = { high: 0, medium: 1, low: 2 };
  deduped.sort((a, b) => (confOrder[a.confidence] || 2) - (confOrder[b.confidence] || 2));
  const byPlatform = {};
  const otherMatches = [];
  for (const m of deduped) { if (m.platform) { if (!byPlatform[m.platform]) byPlatform[m.platform] = []; byPlatform[m.platform].push(m); } else otherMatches.push(m); }
  const engineUrls = {};
  for (const es of engineStatuses) { if (es.results_url) engineUrls[es.engine] = es.results_url; }

  send("complete", {
    identified_name: identifiedName,
    usernames_found: uniqueUsernames,
    total_matches: deduped.length,
    social_platforms_found: Object.keys(byPlatform).length,
    social_media: byPlatform,
    other_matches: otherMatches.slice(0, 40),
    engines: engineUrls,
    engine_statuses: engineStatuses,
  });
  res.end();
});


// ══════════════════════════════════════════════════════════════════════════
//  API ROUTE HANDLERS
// ══════════════════════════════════════════════════════════════════════════

// ── Investigation CRUD ───────────────────────────────────────────────────

app.get("/api/investigations", (req, res) => {
  try {
    const list = listInvestigations();
    res.json(list);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/investigations", (req, res) => {
  try {
    const id = saveInvestigation(req.body);
    res.json({ id, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/investigations/:id", (req, res) => {
  try {
    const data = loadInvestigation(req.params.id);
    if (!data) return res.status(404).json({ error: "Not found" });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/investigations/:id", (req, res) => {
  try {
    deleteInvestigation(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Fetch image from URL ─────────────────────────────────────────────────

app.post("/api/fetch-image-url", async (req, res) => {
  const { url } = req.body;
  if (!url || !url.startsWith("http")) return res.status(400).json({ error: "Valid URL required" });
  try {
    const response = await chainRequest(url, { timeout: 20000 });
    if (!response.body || response.statusCode !== 200) {
      // Maybe the URL is a page, not an image - try to extract og:image
      const ogMatch = (response.body || "").match(/<meta[^>]+property="og:image"[^>]*content="([^"]+)"/i);
      if (ogMatch) {
        // Fetch the og:image
        const imgResp = await new Promise((resolve) => {
          const parsed = new URL(ogMatch[1]);
          const driver = parsed.protocol === "https:" ? https : http;
          const req2 = driver.get({ hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: { "User-Agent": "Mozilla/5.0" } }, (r) => {
            const chunks = []; r.on("data", c => chunks.push(c));
            r.on("end", () => resolve({ status: r.statusCode, buffer: Buffer.concat(chunks), type: r.headers["content-type"] }));
          });
          req2.on("error", () => resolve(null));
          req2.setTimeout(15000, () => { req2.destroy(); resolve(null); });
        });
        if (imgResp && imgResp.status === 200) {
          const ext = (imgResp.type || "").includes("png") ? ".png" : (imgResp.type || "").includes("webp") ? ".webp" : ".jpg";
          const filename = crypto.randomBytes(16).toString("hex") + ext;
          const filePath = path.join(UPLOADS_DIR, filename);
          fs.writeFileSync(filePath, imgResp.buffer);
          return res.json({ filename, url: `/uploads/${filename}`, size: imgResp.buffer.length, source_url: ogMatch[1], mimetype: imgResp.type });
        }
      }
      return res.status(400).json({ error: "Could not fetch image from URL" });
    }
    // Check if response is actually an image
    const ct = response.headers?.["content-type"] || "";
    if (ct.includes("image")) {
      const ext = ct.includes("png") ? ".png" : ct.includes("webp") ? ".webp" : ct.includes("gif") ? ".gif" : ".jpg";
      const filename = crypto.randomBytes(16).toString("hex") + ext;
      const filePath = path.join(UPLOADS_DIR, filename);
      fs.writeFileSync(filePath, Buffer.from(response.body, "binary"));
      return res.json({ filename, url: `/uploads/${filename}`, size: response.body.length, source_url: url, mimetype: ct });
    }
    // Not an image - try og:image extraction
    const ogMatch = response.body.match(/<meta[^>]+property="og:image"[^>]*content="([^"]+)"/i);
    if (ogMatch) {
      const imgUrl = ogMatch[1].startsWith("//") ? "https:" + ogMatch[1] : ogMatch[1];
      const imgResp = await new Promise((resolve) => {
        try {
          const parsed = new URL(imgUrl);
          const driver = parsed.protocol === "https:" ? https : http;
          const req2 = driver.get({ hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: { "User-Agent": "Mozilla/5.0" } }, (r) => {
            const chunks = []; r.on("data", c => chunks.push(c));
            r.on("end", () => resolve({ status: r.statusCode, buffer: Buffer.concat(chunks), type: r.headers["content-type"] }));
          });
          req2.on("error", () => resolve(null));
          req2.setTimeout(15000, () => { req2.destroy(); resolve(null); });
        } catch { resolve(null); }
      });
      if (imgResp && imgResp.status === 200) {
        const ext = (imgResp.type || "").includes("png") ? ".png" : ".jpg";
        const filename = crypto.randomBytes(16).toString("hex") + ext;
        const filePath = path.join(UPLOADS_DIR, filename);
        fs.writeFileSync(filePath, imgResp.buffer);
        return res.json({ filename, url: `/uploads/${filename}`, size: imgResp.buffer.length, source_url: imgUrl, mimetype: imgResp.type });
      }
    }
    return res.status(400).json({ error: "URL does not contain an image" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Image proxy ──────────────────────────────────────────────────────────

app.get("/api/proxy-image", (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith("http")) return res.status(400).send("Invalid URL");
  try {
    const parsed = new URL(url);
    const driver = parsed.protocol === "https:" ? https : http;
    const proxyReq = driver.get({
      hostname: parsed.hostname, path: parsed.pathname + parsed.search,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "image/*,*/*;q=0.8", "Referer": parsed.origin },
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        const loc = proxyRes.headers.location.startsWith("/") ? parsed.protocol + "//" + parsed.hostname + proxyRes.headers.location : proxyRes.headers.location;
        proxyRes.resume();
        try { (new URL(loc).protocol === "https:" ? https : http).get(loc, { headers: { "User-Agent": "Mozilla/5.0" } }, (rRes) => { res.setHeader("Content-Type", rRes.headers["content-type"] || "image/jpeg"); res.setHeader("Cache-Control", "public, max-age=3600"); rRes.pipe(res); }).on("error", () => res.status(502).end()); } catch { res.status(502).end(); }
        return;
      }
      res.setHeader("Content-Type", proxyRes.headers["content-type"] || "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=3600");
      proxyRes.pipe(res);
    });
    proxyReq.on("error", () => res.status(502).end());
    proxyReq.setTimeout(10000, () => { proxyReq.destroy(); res.status(504).end(); });
  } catch { res.status(400).end(); }
});

// ── Image upload ─────────────────────────────────────────────────────────

app.post("/api/upload", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image uploaded" });
  res.json({ filename: req.file.filename, url: `/uploads/${req.file.filename}`, size: req.file.size, mimetype: req.file.mimetype });
});

// ── Text search endpoint (SSE) ───────────────────────────────────────────

app.post("/api/search", async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== "string" || !query.trim()) return res.status(400).json({ error: "Query is required" });

  const sanitized = query.trim().slice(0, 100);
  const isUsername = !/\s/.test(sanitized);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sanitized);
  const isDomain = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(sanitized) && !isEmail;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  function send(event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

  const allResults = [];
  let usernameCheckResults = null;

  // Phase 1: Core
  send("phase", { phase: 1, label: "Core platform search..." });
  const coreTasks = [];
  coreTasks.push(lookupWikipedia(sanitized));
  coreTasks.push(lookupDuckDuckGo(sanitized));
  if (isUsername) {
    coreTasks.push(lookupGitHub(sanitized), lookupReddit(sanitized), lookupStackOverflow(sanitized), lookupHackerNews(sanitized));
  } else {
    coreTasks.push(lookupGitHubByName(sanitized), lookupStackOverflow(sanitized));
  }
  if (isEmail) coreTasks.push(lookupGravatar(sanitized));
  if (isDomain) { coreTasks.push(lookupDNS(sanitized), lookupRDAP(sanitized), lookupIPGeo(sanitized), lookupWayback(sanitized)); }

  let settled = await Promise.allSettled(coreTasks);
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) {
      const items = Array.isArray(r.value) ? r.value : [r.value];
      for (const item of items) item.confidence = calculateConfidence(item);
      allResults.push(...items);
      send("results", { results: items });
    }
  }

  // Phase 2: Deep
  send("phase", { phase: 2, label: `Deep platform search (${allResults.length} found)...` });
  const deepTasks = [];
  if (isUsername) {
    deepTasks.push(lookupGitLab(sanitized), lookupKeybase(sanitized), lookupNpm(sanitized), lookupDockerHub(sanitized),
      lookupDevTo(sanitized), lookupLichess(sanitized), lookupChessCom(sanitized), lookupRoblox(sanitized),
      lookupMastodon(sanitized), lookupGravatar(sanitized), lookupCratesIO(sanitized), lookupPyPI(sanitized), lookupHuggingFace(sanitized));
  }
  deepTasks.push(lookupWikidata(sanitized), lookupOpenLibrary(sanitized), lookupArchiveOrg(sanitized));

  settled = await Promise.allSettled(deepTasks);
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) {
      const items = Array.isArray(r.value) ? r.value : [r.value];
      for (const item of items) item.confidence = calculateConfidence(item);
      allResults.push(...items);
      send("results", { results: items });
    }
  }

  // Phase 3: GitHub deep + web search
  send("phase", { phase: 3, label: `Activity analysis & web search (${allResults.length} found)...` });
  const analysisTasks = [];
  if (isUsername && allResults.some(r => r.source === "GitHub")) {
    analysisTasks.push(lookupGitHubRepos(sanitized), lookupGitHubGists(sanitized), lookupGitHubEvents(sanitized), lookupGitHubEmails(sanitized));
  }
  if (isUsername || isEmail) analysisTasks.push(lookupBreaches(sanitized));
  const webSearchPromise = scrapeWebSearch(sanitized);

  settled = await Promise.allSettled(analysisTasks);
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) {
      const items = Array.isArray(r.value) ? r.value : [r.value];
      for (const item of items) item.confidence = calculateConfidence(item);
      allResults.push(...items);
      send("results", { results: items });
    }
  }

  const webResults = await webSearchPromise;
  if (webResults.length) send("web_results", { results: webResults });

  // Phase 4: Username existence check
  if (isUsername) {
    send("phase", { phase: 4, label: `Checking username across 26+ platforms...` });
    usernameCheckResults = await checkUsername(sanitized);
    send("username_check", { results: usernameCheckResults });
  }

  const exposure = calculateExposureScore(allResults, usernameCheckResults);
  send("complete", { total: allResults.length, exposure });
  res.end();
});
// ══════════════════════════════════════════════════════════════════════════
//  MEGA DEEP SEARCH — takes multiple accounts, builds full person profile
// ══════════════════════════════════════════════════════════════════════════

// Platform-specific deep scrapers that extract maximum data

async function deepScrapeRoblox(username) {
  const results = { platform: "Roblox", username, data: {}, friends: [], groups: [], avatar: null };
  try {
    // Search for user
    const search = await safeFetch(`https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(username)}&limit=10`);
    if (!search?.data?.length) return results;
    const user = search.data.find(u => u.name.toLowerCase() === username.toLowerCase()) || search.data[0];
    const userId = user.id;
    results.data = { id: userId, name: user.name, displayName: user.displayName };
    results.data.profile_url = `https://www.roblox.com/users/${userId}/profile`;

    // Get full profile
    const [profile, friends, groups, presence, badges] = await Promise.allSettled([
      safeFetch(`https://users.roblox.com/v1/users/${userId}`),
      safeFetch(`https://friends.roblox.com/v1/users/${userId}/friends?limit=50`),
      safeFetch(`https://groups.roblox.com/v1/users/${userId}/groups/roles`),
      safeFetch(`https://presence.roblox.com/v1/presence/users`, { "Content-Type": "application/json" }),
      safeFetch(`https://accountinformation.roblox.com/v1/users/${userId}/roblox-badges`),
    ]);

    if (profile.status === "fulfilled" && profile.value) {
      const p = profile.value;
      results.data.description = p.description;
      results.data.created = p.created;
      results.data.isBanned = p.isBanned;
      results.data.hasVerifiedBadge = p.hasVerifiedBadge;
    }

    if (friends.status === "fulfilled" && friends.value?.data) {
      results.friends = friends.value.data.slice(0, 20).map(f => ({
        name: f.name, displayName: f.displayName, id: f.id,
        url: `https://www.roblox.com/users/${f.id}/profile`,
      }));
      results.data.friend_count = friends.value.data.length;
    }

    if (groups.status === "fulfilled" && groups.value?.data) {
      results.groups = groups.value.data.slice(0, 15).map(g => ({
        name: g.group.name, id: g.group.id, role: g.role.name,
        memberCount: g.group.memberCount,
        url: `https://www.roblox.com/groups/${g.group.id}`,
      }));
    }

    // Avatar
    try {
      const av = await safeFetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=420x420&format=Png`);
      if (av?.data?.[0]?.imageUrl) results.avatar = av.data[0].imageUrl;
    } catch {}

    // Inventory/favorites for more data
    try {
      const favGames = await safeFetch(`https://games.roblox.com/v2/users/${userId}/favorite/games?limit=10`);
      if (favGames?.data) results.data.favorite_games = favGames.data.map(g => g.name).join(", ");
    } catch {}

  } catch {}
  return results;
}

async function deepScrapeGitHub(username) {
  const results = { platform: "GitHub", username, data: {}, repos: [], activity: [], avatar: null, emails: [] };
  try {
    const [profile, repos, events, gists, orgs] = await Promise.allSettled([
      safeFetch(`https://api.github.com/users/${encodeURIComponent(username)}`),
      safeFetch(`https://api.github.com/users/${encodeURIComponent(username)}/repos?sort=updated&per_page=30`),
      safeFetch(`https://api.github.com/users/${encodeURIComponent(username)}/events/public?per_page=100`),
      safeFetch(`https://api.github.com/users/${encodeURIComponent(username)}/gists?per_page=10`),
      safeFetch(`https://api.github.com/users/${encodeURIComponent(username)}/orgs`),
    ]);

    if (profile.status === "fulfilled" && profile.value && !profile.value.message) {
      const p = profile.value;
      results.data = {
        name: p.name, bio: p.bio, location: p.location, company: p.company,
        blog: p.blog, twitter_username: p.twitter_username, email: p.email,
        public_repos: p.public_repos, public_gists: p.public_gists,
        followers: p.followers, following: p.following,
        created: p.created_at, updated: p.updated_at,
        profile_url: p.html_url, hireable: p.hireable,
      };
      results.avatar = p.avatar_url;
    }

    if (repos.status === "fulfilled" && repos.value) {
      results.repos = repos.value.filter(r => !r.fork).slice(0, 15).map(r => ({
        name: r.name, description: r.description, language: r.language,
        stars: r.stargazers_count, forks: r.forks_count, url: r.html_url,
        updated: r.updated_at,
      }));
      results.data.languages = [...new Set(repos.value.map(r => r.language).filter(Boolean))].join(", ");
      results.data.total_stars = repos.value.reduce((s, r) => s + r.stargazers_count, 0);
    }

    if (events.status === "fulfilled" && events.value) {
      // Extract emails from push events
      const emails = new Set();
      const activeHours = new Set();
      for (const ev of events.value) {
        if (ev.type === "PushEvent" && ev.payload?.commits) {
          for (const c of ev.payload.commits) {
            if (c.author?.email && !c.author.email.includes("noreply")) emails.add(c.author.email);
          }
        }
        activeHours.add(new Date(ev.created_at).getUTCHours());
      }
      results.emails = [...emails];
      results.data.active_hours = [...activeHours].sort((a, b) => a - b).map(h => h + ":00 UTC").join(", ");
      results.data.recent_activity = events.value.slice(0, 5).map(e => ({
        type: e.type.replace("Event", ""), repo: e.repo?.name, date: e.created_at,
      }));
    }

    if (orgs.status === "fulfilled" && orgs.value) {
      results.data.organizations = orgs.value.map(o => o.login).join(", ");
    }
  } catch {}
  return results;
}

async function deepScrapeReddit(username) {
  const results = { platform: "Reddit", username, data: {}, posts: [], avatar: null };
  try {
    const [about, posts, comments] = await Promise.allSettled([
      safeFetch(`https://www.reddit.com/user/${encodeURIComponent(username)}/about.json`),
      safeFetch(`https://www.reddit.com/user/${encodeURIComponent(username)}/submitted.json?limit=25&sort=top`),
      safeFetch(`https://www.reddit.com/user/${encodeURIComponent(username)}/comments.json?limit=25&sort=top`),
    ]);

    if (about.status === "fulfilled" && about.value?.data) {
      const d = about.value.data;
      results.data = {
        name: d.name, link_karma: d.link_karma, comment_karma: d.comment_karma,
        total_karma: d.total_karma, created: new Date(d.created_utc * 1000).toISOString(),
        has_verified_email: d.has_verified_email, is_gold: d.is_gold,
        profile_url: `https://www.reddit.com/user/${d.name}`,
      };
      results.avatar = d.icon_img?.split("?")[0];
    }

    if (posts.status === "fulfilled" && posts.value?.data?.children) {
      const subreddits = new Set();
      results.posts = posts.value.data.children.slice(0, 10).map(p => {
        subreddits.add(p.data.subreddit);
        return {
          title: p.data.title, subreddit: p.data.subreddit, score: p.data.score,
          url: `https://www.reddit.com${p.data.permalink}`, created: new Date(p.data.created_utc * 1000).toISOString(),
        };
      });
      results.data.active_subreddits = [...subreddits].join(", ");
    }

    if (comments.status === "fulfilled" && comments.value?.data?.children) {
      const commentSubs = new Set();
      for (const c of comments.value.data.children) {
        commentSubs.add(c.data.subreddit);
      }
      results.data.comment_subreddits = [...commentSubs].join(", ");
    }
  } catch {}
  return results;
}

async function deepScrapeSteam(username) {
  const results = { platform: "Steam", username, data: {}, avatar: null };
  try {
    // Scrape the Steam community page
    const resp = await chainRequest(`https://steamcommunity.com/id/${encodeURIComponent(username)}`, { timeout: 15000 });
    const html = resp.body || "";

    // Extract profile data from HTML
    const nameMatch = html.match(/class="actual_persona_name">([^<]+)/i);
    if (nameMatch) results.data.display_name = nameMatch[1].trim();

    const summaryMatch = html.match(/class="profile_summary">([\s\S]*?)<\/div>/i);
    if (summaryMatch) results.data.summary = summaryMatch[1].replace(/<[^>]*>/g, "").trim();

    const avatarMatch = html.match(/class="playerAvatarAutoSizeInner">\s*<img[^>]+src="([^"]+)"/i);
    if (avatarMatch) results.avatar = avatarMatch[1];

    const locationMatch = html.match(/class="header_real_name ellipsis">([\s\S]*?)<\/bdi>/i);
    if (locationMatch) {
      const loc = locationMatch[1].replace(/<[^>]*>/g, "").trim();
      if (loc) results.data.real_name_or_location = loc;
    }

    const levelMatch = html.match(/class="friendPlayerLevelNum">(\d+)/i);
    if (levelMatch) results.data.level = parseInt(levelMatch[1]);

    results.data.profile_url = `https://steamcommunity.com/id/${username}`;

    // Extract games if visible
    const gamesResp = await chainRequest(`https://steamcommunity.com/id/${encodeURIComponent(username)}/games/?tab=all`, { timeout: 12000 });
    const gamesHtml = gamesResp.body || "";
    const gameCountMatch = gamesHtml.match(/(\d+)\s*Games?\s*Owned/i);
    if (gameCountMatch) results.data.games_owned = parseInt(gameCountMatch[1]);
  } catch {}
  return results;
}

async function deepScrapeDiscord(username) {
  // Discord doesn't have a public API for user lookup, but we can search the web
  const results = { platform: "Discord", username, data: {}, avatar: null };
  try {
    // Search for Discord presence across the web
    const cleanName = username.replace(/#\d+$/, "");
    results.data.searched_name = cleanName;
    results.data.profile_url = null; // Discord has no public profiles

    // Search for the username on Discord-related sites
    const queries = [
      `"${cleanName}" site:discord.me`, `"${cleanName}" discord profile`,
      `"${cleanName}" site:discordservers.com`, `"${cleanName}" site:disboard.org`,
    ];
    const webResults = [];
    for (const q of queries) {
      try {
        const wr = await scrapeWebSearch(q);
        webResults.push(...wr.slice(0, 3));
      } catch {}
    }
    results.data.web_mentions = webResults.slice(0, 8);
  } catch {}
  return results;
}

async function deepScrapeTikTok(username) {
  const results = { platform: "TikTok", username, data: {}, avatar: null };
  try {
    const resp = await chainRequest(`https://www.tiktok.com/@${encodeURIComponent(username)}`, { timeout: 15000 });
    const html = resp.body || "";

    // Extract from meta tags and JSON-LD
    const descMatch = html.match(/<meta[^>]+name="description"[^>]*content="([^"]+)"/i);
    if (descMatch) results.data.description = descMatch[1];

    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) results.data.page_title = titleMatch[1].trim();

    // Try to extract from JSON in page
    const jsonMatch = html.match(/"userInfo"\s*:\s*(\{[\s\S]*?\})\s*,\s*"/i);
    if (jsonMatch) {
      try {
        const userInfo = JSON.parse(jsonMatch[1]);
        if (userInfo.user) {
          results.data.nickname = userInfo.user.nickname;
          results.data.signature = userInfo.user.signature;
          results.data.verified = userInfo.user.verified;
          results.avatar = userInfo.user.avatarLarger || userInfo.user.avatarMedium;
        }
        if (userInfo.stats) {
          results.data.followers = userInfo.stats.followerCount;
          results.data.following = userInfo.stats.followingCount;
          results.data.likes = userInfo.stats.heartCount;
          results.data.videos = userInfo.stats.videoCount;
        }
      } catch {}
    }

    // Try og:image for avatar
    const ogImg = html.match(/<meta[^>]+property="og:image"[^>]*content="([^"]+)"/i);
    if (ogImg && !results.avatar) results.avatar = ogImg[1];

    results.data.profile_url = `https://www.tiktok.com/@${username}`;
  } catch {}
  return results;
}

async function deepScrapeInstagram(username) {
  const results = { platform: "Instagram", username, data: {}, avatar: null };
  try {
    // Instagram is heavily protected, but we can try the web profile page
    const resp = await chainRequest(`https://www.instagram.com/${encodeURIComponent(username)}/`, {
      timeout: 15000,
      headers: { "Accept": "text/html", "Accept-Language": "en-US,en;q=0.9" },
    });
    const html = resp.body || "";

    // Extract from meta tags
    const descMatch = html.match(/<meta[^>]+(?:name|property)="(?:og:)?description"[^>]*content="([^"]+)"/i);
    if (descMatch) results.data.description = descMatch[1];

    const titleMatch = html.match(/<meta[^>]+property="og:title"[^>]*content="([^"]+)"/i);
    if (titleMatch) results.data.title = titleMatch[1];

    const ogImg = html.match(/<meta[^>]+property="og:image"[^>]*content="([^"]+)"/i);
    if (ogImg) results.avatar = ogImg[1];

    // Try to parse Instagram description format: "X Followers, Y Following, Z Posts - ..."
    if (results.data.description) {
      const statsMatch = results.data.description.match(/(\d[\d,.]*)\s*Followers?,\s*(\d[\d,.]*)\s*Following,\s*(\d[\d,.]*)\s*Posts?/i);
      if (statsMatch) {
        results.data.followers = statsMatch[1].replace(/,/g, "");
        results.data.following = statsMatch[2].replace(/,/g, "");
        results.data.posts = statsMatch[3].replace(/,/g, "");
      }
      // Extract bio (after the stats part)
      const bioMatch = results.data.description.match(/Posts?\s*-\s*(.*)/i);
      if (bioMatch) results.data.bio = bioMatch[1].trim();
    }

    results.data.profile_url = `https://www.instagram.com/${username}/`;
  } catch {}
  return results;
}

async function deepScrapeTwitter(username) {
  const results = { platform: "Twitter/X", username, data: {}, avatar: null };
  try {
    // Twitter/X is very protected, try Nitter instances and web scraping
    const resp = await chainRequest(`https://nitter.privacydev.net/${encodeURIComponent(username)}`, { timeout: 15000 });
    const html = resp.body || "";

    const nameMatch = html.match(/class="profile-card-fullname"[^>]*>([^<]+)/i);
    if (nameMatch) results.data.name = nameMatch[1].trim();

    const bioMatch = html.match(/class="profile-bio"[^>]*>([\s\S]*?)<\/p>/i);
    if (bioMatch) results.data.bio = bioMatch[1].replace(/<[^>]*>/g, "").trim();

    const locationMatch = html.match(/class="profile-location"[^>]*>([\s\S]*?)<\/div>/i);
    if (locationMatch) results.data.location = locationMatch[1].replace(/<[^>]*>/g, "").trim();

    const joinedMatch = html.match(/class="profile-joindate"[^>]*>([\s\S]*?)<\/div>/i);
    if (joinedMatch) results.data.joined = joinedMatch[1].replace(/<[^>]*>/g, "").trim();

    const statsRegex = /class="profile-stat-num"[^>]*>([^<]+)/gi;
    const stats = [...html.matchAll(statsRegex)].map(m => m[1].trim());
    if (stats.length >= 3) {
      results.data.tweets = stats[0];
      results.data.following = stats[1];
      results.data.followers = stats[2];
      if (stats[3]) results.data.likes = stats[3];
    }

    const avatarMatch = html.match(/class="profile-card-avatar"[^>]*src="([^"]+)"/i);
    if (avatarMatch) results.avatar = avatarMatch[1].startsWith("/") ? "https://nitter.privacydev.net" + avatarMatch[1] : avatarMatch[1];

    results.data.profile_url = `https://x.com/${username}`;
  } catch {}
  return results;
}

async function deepScrapeYouTube(username) {
  const results = { platform: "YouTube", username, data: {}, avatar: null };
  try {
    const handle = username.startsWith("@") ? username : `@${username}`;
    const resp = await chainRequest(`https://www.youtube.com/${handle}`, { timeout: 15000 });
    const html = resp.body || "";

    const titleMatch = html.match(/<meta[^>]+property="og:title"[^>]*content="([^"]+)"/i);
    if (titleMatch) results.data.channel_name = titleMatch[1];

    const descMatch = html.match(/<meta[^>]+property="og:description"[^>]*content="([^"]+)"/i);
    if (descMatch) results.data.description = descMatch[1];

    const ogImg = html.match(/<meta[^>]+property="og:image"[^>]*content="([^"]+)"/i);
    if (ogImg) results.avatar = ogImg[1];

    // Try to extract subscriber count
    const subMatch = html.match(/"subscriberCountText"\s*:\s*\{"simpleText"\s*:\s*"([^"]+)"\}/i);
    if (subMatch) results.data.subscribers = subMatch[1];

    const vidCountMatch = html.match(/"videosCountText"[\s\S]*?"text"\s*:\s*"([^"]+)"/i);
    if (vidCountMatch) results.data.video_count = vidCountMatch[1];

    results.data.profile_url = `https://www.youtube.com/${handle}`;
  } catch {}
  return results;
}

// Scrape web for any mention of any of the person's known identifiers
async function megaWebSearch(identifiers) {
  const allResults = [];
  const queries = new Set();

  for (const id of identifiers) {
    if (!id) continue;
    queries.add(`"${id}"`);
    queries.add(`"${id}" profile`);
    queries.add(`"${id}" social media`);
  }

  // Also try cross-referencing identifiers
  const ids = identifiers.filter(Boolean);
  if (ids.length >= 2) {
    queries.add(`"${ids[0]}" "${ids[1]}"`);
  }

  for (const q of [...queries].slice(0, 10)) {
    try {
      const wr = await scrapeWebSearch(q);
      for (const r of wr.slice(0, 5)) {
        if (!allResults.some(x => x.url === r.url)) {
          allResults.push({ ...r, platform: detectPlatform(r.url), source_engine: "web" });
        }
      }
    } catch {}
  }
  return allResults;
}

// ── Main Mega Deep Search endpoint ──────────────────────────────────────

app.post("/api/mega-search", async (req, res) => {
  const inputs = req.body;
  if (!inputs || typeof inputs !== "object") return res.status(400).json({ error: "Invalid input" });

  // SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  function send(event, data) { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} }

  // Normalize inputs — strip URLs to usernames, clean up
  function extractUser(val, platformHint) {
    if (!val) return null;
    val = val.trim().replace(/^@/, "");
    // If it's a URL, extract the username part
    try {
      const url = new URL(val.startsWith("http") ? val : "https://x.com/" + val);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length && val.includes("/")) {
        // Strip common prefixes
        if (parts[0] === "in" || parts[0] === "user" || parts[0] === "c" || parts[0] === "channel" || parts[0] === "people" || parts[0] === "id") return parts[1] || parts[0];
        return parts[0].replace(/^@/, "");
      }
    } catch {}
    return val.replace(/#\d+$/, "").trim(); // Remove Discord discriminator for searches
  }

  const name = inputs.name?.trim() || null;
  const username = extractUser(inputs.username);
  const email = inputs.email?.trim() || null;
  const instagram = extractUser(inputs.instagram, "instagram");
  const discord = inputs.discord?.trim() || null;
  const roblox = extractUser(inputs.roblox, "roblox");
  const twitter = extractUser(inputs.twitter, "twitter");
  const tiktok = extractUser(inputs.tiktok, "tiktok");
  const youtube = extractUser(inputs.youtube, "youtube");
  const github = extractUser(inputs.github, "github");
  const steam = extractUser(inputs.steam, "steam");
  const other = inputs.other?.trim() || null;

  // Collect all known identifiers for cross-referencing
  const allIdentifiers = [name, username, email, instagram, discord, roblox, twitter, tiktok, youtube, github, steam, other].filter(Boolean);
  const allUsernames = new Set([username, instagram, roblox, twitter, tiktok, youtube, github, steam].filter(Boolean));

  if (!allIdentifiers.length) {
    send("error", { message: "Please enter at least one piece of information" });
    return res.end();
  }

  const profile = {
    name: name, avatar: null, bio: null, location: null, created: null,
    usernames: {}, stats: {}, accounts: [], photos: [], details: [],
    emails: [], web_mentions: [], raw: [],
  };

  // ── Phase 1: Platform-specific deep scraping ──
  send("phase", { phase: 1, label: "Deep scraping known accounts..." });

  const scrapeJobs = [];
  if (roblox) scrapeJobs.push(["Roblox", deepScrapeRoblox(roblox)]);
  if (github) scrapeJobs.push(["GitHub", deepScrapeGitHub(github)]);
  if (twitter) scrapeJobs.push(["Twitter", deepScrapeTwitter(twitter)]);
  if (instagram) scrapeJobs.push(["Instagram", deepScrapeInstagram(instagram)]);
  if (tiktok) scrapeJobs.push(["TikTok", deepScrapeTikTok(tiktok)]);
  if (youtube) scrapeJobs.push(["YouTube", deepScrapeYouTube(youtube)]);
  if (steam) scrapeJobs.push(["Steam", deepScrapeSteam(steam)]);
  if (discord) scrapeJobs.push(["Discord", deepScrapeDiscord(discord)]);

  // Also scrape Reddit if username provided
  if (username) scrapeJobs.push(["Reddit", deepScrapeReddit(username)]);

  const scrapeResults = await Promise.allSettled(scrapeJobs.map(j => j[1]));

  for (let i = 0; i < scrapeResults.length; i++) {
    const label = scrapeJobs[i][0];
    const r = scrapeResults[i];
    if (r.status === "fulfilled" && r.value) {
      const scrape = r.value;
      send("scrape_result", { platform: label, data: scrape.data, has_avatar: !!scrape.avatar });

      // Merge into profile
      if (scrape.avatar && !profile.avatar) profile.avatar = scrape.avatar;
      if (scrape.avatar) profile.photos.push(scrape.avatar);
      if (scrape.data.name && !profile.name) profile.name = scrape.data.name;
      if (scrape.data.display_name && !profile.name) profile.name = scrape.data.display_name;
      if (scrape.data.nickname && !profile.name) profile.name = scrape.data.nickname;
      if (scrape.data.channel_name && !profile.name) profile.name = scrape.data.channel_name;
      if (scrape.data.bio) profile.bio = profile.bio || scrape.data.bio;
      if (scrape.data.description && !profile.bio) profile.bio = scrape.data.description;
      if (scrape.data.summary && !profile.bio) profile.bio = scrape.data.summary;
      if (scrape.data.signature && !profile.bio) profile.bio = scrape.data.signature;
      if (scrape.data.location) profile.location = profile.location || scrape.data.location;
      if (scrape.data.real_name_or_location && !profile.location) profile.location = scrape.data.real_name_or_location;
      if (scrape.data.created) profile.created = profile.created || scrape.data.created;
      if (scrape.emails?.length) profile.emails.push(...scrape.emails);

      // Add as linked account
      profile.accounts.push({
        platform: scrape.platform,
        username: scrape.username,
        url: scrape.data.profile_url,
        avatar: scrape.avatar,
        data: scrape.data,
      });

      // Stats
      for (const key of ["followers", "following", "friends", "friend_count", "likes", "videos", "posts", "subscribers",
                          "link_karma", "comment_karma", "total_karma", "public_repos", "total_stars", "games_owned",
                          "level", "tweets", "video_count"]) {
        if (scrape.data[key] != null) {
          profile.stats[`${scrape.platform} ${key}`] = scrape.data[key];
        }
      }

      // Details
      for (const [k, v] of Object.entries(scrape.data)) {
        if (v && typeof v === "string" && v.length < 500 && !["profile_url", "name", "display_name", "nickname", "channel_name"].includes(k)) {
          profile.details.push({ platform: scrape.platform, key: k, value: v });
        }
      }

      // Friends/connections
      if (scrape.friends?.length) {
        profile.details.push({ platform: scrape.platform, key: "Friends", value: scrape.friends.map(f => f.name || f.displayName).join(", ") });
      }
      if (scrape.groups?.length) {
        profile.details.push({ platform: scrape.platform, key: "Groups", value: scrape.groups.map(g => g.name + (g.role ? ` (${g.role})` : "")).join(", ") });
      }
      if (scrape.posts?.length) {
        for (const p of scrape.posts.slice(0, 5)) {
          profile.details.push({ platform: scrape.platform, key: "Post", value: (p.title || "").slice(0, 200) + (p.subreddit ? ` (r/${p.subreddit})` : "") });
        }
      }
      if (scrape.repos?.length) {
        for (const r of scrape.repos.slice(0, 5)) {
          profile.details.push({ platform: scrape.platform, key: "Repo", value: `${r.name} — ${r.description || ""}`.slice(0, 200) + ` (${r.language || "?"}, ${r.stars} stars)` });
        }
      }

      profile.raw.push(scrape);
    }
  }

  // ── Phase 2: API lookups for all known usernames ──
  send("phase", { phase: 2, label: "Running API lookups across platforms..." });

  const apiJobs = [];
  const primaryUser = username || instagram || twitter || github || roblox || tiktok;

  if (primaryUser) {
    apiJobs.push(lookupGitHub(primaryUser), lookupReddit(primaryUser), lookupStackOverflow(primaryUser),
      lookupHackerNews(primaryUser), lookupGitLab(primaryUser), lookupKeybase(primaryUser),
      lookupNpm(primaryUser), lookupDockerHub(primaryUser), lookupDevTo(primaryUser),
      lookupLichess(primaryUser), lookupChessCom(primaryUser), lookupMastodon(primaryUser),
      lookupGravatar(primaryUser), lookupCratesIO(primaryUser), lookupHuggingFace(primaryUser));
  }
  if (name) {
    apiJobs.push(lookupWikipedia(name), lookupDuckDuckGo(name), lookupWikidata(name),
      lookupOpenLibrary(name));
  }
  if (email) {
    apiJobs.push(lookupGravatar(email));
  }

  const apiResults = await Promise.allSettled(apiJobs);
  for (const r of apiResults) {
    if (r.status === "fulfilled" && r.value) {
      const items = Array.isArray(r.value) ? r.value : [r.value];
      for (const item of items) {
        send("api_result", { source: item.source, name: item.name });
        // Merge useful data
        if (item.avatar && !profile.avatar) profile.avatar = item.avatar;
        if (item.avatar) profile.photos.push(item.avatar);
        if (item.name && !profile.name && item.name !== primaryUser) profile.name = item.name;
        if (item.bio && !profile.bio) profile.bio = item.bio;
        if (item.location && !profile.location) profile.location = item.location;
        if (item.profile_url) {
          profile.accounts.push({
            platform: item.source, username: item.username || item.name,
            url: item.profile_url, avatar: item.avatar, data: item,
          });
        }
        if (item.email) profile.emails.push(item.email);
        if (item.twitter_username) allUsernames.add(item.twitter_username);
        if (item.github_username) allUsernames.add(item.github_username);

        // Extract linked accounts from Keybase
        if (item.linked_accounts) {
          profile.details.push({ platform: item.source, key: "Linked accounts", value: item.linked_accounts });
        }

        profile.raw.push(item);
      }
    }
  }

  // ── Phase 3: Username existence check across all discovered usernames ──
  send("phase", { phase: 3, label: `Checking ${allUsernames.size} username(s) across 26+ platforms...` });

  for (const un of allUsernames) {
    if (!un || un.length < 2) continue;
    const checkResults = await checkUsername(un);
    const found = checkResults.filter(r => r.exists);
    send("username_check", { username: un, found: found.length, total: checkResults.length });

    for (const f of found) {
      if (!profile.accounts.some(a => a.url === f.url)) {
        profile.accounts.push({ platform: f.name, username: un, url: f.url, data: { exists: true } });
      }
    }
  }

  // ── Phase 4: Deep social name search ──
  if (name || primaryUser) {
    const searchName = name || primaryUser;
    send("phase", { phase: 4, label: `Searching "${searchName}" across 31 social platforms...` });
    const socialResults = await deepSocialSearch(searchName);
    for (const r of socialResults) {
      if (!profile.accounts.some(a => a.url === r.url)) {
        profile.accounts.push({ platform: r.platform || "Web", username: searchName, url: r.url, data: { title: r.title, snippet: r.snippet } });
      }
    }
    send("social_done", { count: socialResults.length });
  }

  // ── Phase 5: Web search for cross-references ──
  send("phase", { phase: 5, label: "Searching the web for cross-references and mentions..." });
  const webResults = await megaWebSearch(allIdentifiers.slice(0, 5));
  profile.web_mentions = webResults;
  for (const wr of webResults) {
    if (wr.platform && !profile.accounts.some(a => a.url === wr.url)) {
      profile.accounts.push({ platform: wr.platform, username: null, url: wr.url, data: { title: wr.title, snippet: wr.snippet } });
    }
  }
  send("web_done", { count: webResults.length });

  // ── Phase 6: People search engines ──
  if (name) {
    send("phase", { phase: 6, label: "Checking people-search databases..." });
    const peopleSites = [
      `"${name}" site:spokeo.com`, `"${name}" site:whitepages.com`,
      `"${name}" site:pipl.com`, `"${name}" site:peekyou.com`,
      `"${name}" site:socialblade.com`, `"${name}" site:namechk.com`,
      `"${name}" site:knowem.com`, `"${name}" site:usersearch.org`,
    ];
    for (const q of peopleSites) {
      try {
        const wr = await scrapeWebSearch(q);
        for (const r of wr.slice(0, 2)) {
          profile.web_mentions.push({ ...r, platform: "People Search", source_engine: "people-search" });
        }
      } catch {}
    }
  }

  // ── Finalize: dedupe accounts, clean up ──
  send("phase", { phase: 7, label: "Assembling profile..." });

  // Dedupe accounts by URL
  const seenUrls = new Set();
  profile.accounts = profile.accounts.filter(a => {
    if (!a.url) return false;
    const key = a.url.replace(/^https?:\/\/(?:www\.)?/, "").replace(/\/+$/, "").toLowerCase();
    if (seenUrls.has(key)) return false;
    seenUrls.add(key);
    return true;
  });

  // Dedupe photos
  profile.photos = [...new Set(profile.photos.filter(Boolean))];

  // Dedupe emails
  profile.emails = [...new Set(profile.emails.filter(Boolean))];

  // Dedupe web mentions
  const seenWeb = new Set();
  profile.web_mentions = profile.web_mentions.filter(w => {
    const key = (w.url || "").replace(/^https?:\/\/(?:www\.)?/, "").split("?")[0].toLowerCase();
    if (seenWeb.has(key)) return false;
    seenWeb.add(key);
    return true;
  });

  // Score confidence for each account
  for (const acc of profile.accounts) {
    if (acc.data?.exists === true && !acc.data?.title) acc.confidence = "medium";
    else if (acc.data?.profile_url || acc.avatar) acc.confidence = "high";
    else if (acc.data?.title || acc.data?.snippet) acc.confidence = "medium";
    else acc.confidence = "low";
  }
  profile.accounts.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return (order[a.confidence] || 2) - (order[b.confidence] || 2);
  });

  send("complete", {
    profile: {
      name: profile.name,
      avatar: profile.avatar,
      bio: profile.bio,
      location: profile.location,
      created: profile.created,
      emails: profile.emails,
      stats: profile.stats,
    },
    accounts: profile.accounts,
    photos: profile.photos,
    details: profile.details,
    web_mentions: profile.web_mentions.slice(0, 30),
    total_accounts: profile.accounts.length,
    total_details: profile.details.length,
  });

  res.end();
});

// ── Simple reverse search (for full image) ──────────────────────────────

app.post("/api/reverse-search", async (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: "filename required" });
  const filePath = path.join(UPLOADS_DIR, path.basename(filename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });
  const fileBuffer = fs.readFileSync(filePath);
  const ext = path.extname(filename).toLowerCase();
  const mimeMap = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };
  const ct = mimeMap[ext] || "image/jpeg";
  const [yr, gr, br, tr] = await Promise.allSettled([
    yandexFaceScan(fileBuffer, filename, ct), googleFaceScan(fileBuffer, filename, ct),
    bingFaceScan(fileBuffer, filename, ct), tineyeFaceScan(fileBuffer, filename, ct),
  ]);
  res.json({ results: [yr, gr, br, tr].filter(r => r.status === "fulfilled").map(r => r.value) });
});

// ── Cleanup old uploads ─────────────────────────────────────────────────

setInterval(() => {
  if (!fs.existsSync(UPLOADS_DIR)) return;
  const now = Date.now();
  for (const file of fs.readdirSync(UPLOADS_DIR)) {
    try {
      const filePath = path.join(UPLOADS_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > 60 * 60 * 1000) fs.unlinkSync(filePath); // 1 hour
    } catch {}
  }
}, 10 * 60 * 1000);

// ── Start ───────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Person Lookup v4 running at http://localhost:${PORT}`);
  console.log(`Face scan: 9 engines | 8-phase deep pipeline | confidence scoring`);
  console.log(`Investigation tracking | URL image fetch | smart username checking`);
});
