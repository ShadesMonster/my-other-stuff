const express = require("express");
const https = require("https");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// Multer config
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

app.use(express.json({ limit: "15mb" }));
app.use(express.static(__dirname));           // serves index.html from root
app.use(express.static(path.join(__dirname, "public"))); // legacy compat
app.use("/uploads", express.static(UPLOADS_DIR));

// ── Helpers ─────────────────────────────────────────────────────────────

function fetchJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const driver = opts.protocol === "https:" ? https : http;
    const reqOpts = {
      hostname: opts.hostname,
      path: opts.pathname + opts.search,
      method: "GET",
      headers: {
        "User-Agent": "PersonLookup-Educational/2.0",
        Accept: "application/json",
        ...headers,
      },
    };
    const req = driver.request(reqOpts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: null });
        }
      });
    });
    req.on("error", (err) => reject(err));
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    req.end();
  });
}

function fetchText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const driver = opts.protocol === "https:" ? https : http;
    const reqOpts = {
      hostname: opts.hostname,
      path: opts.pathname + opts.search,
      method: "GET",
      headers: {
        "User-Agent": "PersonLookup-Educational/2.0",
        ...headers,
      },
    };
    const req = driver.request(reqOpts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", (err) => reject(err));
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    req.end();
  });
}

// Build a multipart/form-data body from fields and file buffer
function buildMultipart(fields, fileField, fileBuffer, filename, contentType) {
  const boundary =
    "----PersonLookup" + crypto.randomBytes(16).toString("hex");
  const parts = [];

  for (const [key, val] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`
      )
    );
  }

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`
    )
  );
  parts.push(fileBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return { boundary, body: Buffer.concat(parts) };
}

// ── Text Lookup modules ─────────────────────────────────────────────────

async function lookupGitHub(username) {
  try {
    const { status, data } = await fetchJSON(
      `https://api.github.com/users/${encodeURIComponent(username)}`
    );
    if (status !== 200 || !data || data.message) return null;
    return {
      source: "GitHub",
      icon: "github",
      profile_url: data.html_url,
      avatar: data.avatar_url,
      name: data.name,
      bio: data.bio,
      location: data.location,
      company: data.company,
      blog: data.blog,
      public_repos: data.public_repos,
      followers: data.followers,
      following: data.following,
      created: data.created_at,
    };
  } catch {
    return null;
  }
}

async function lookupGitHubByName(name) {
  try {
    const { status, data } = await fetchJSON(
      `https://api.github.com/search/users?q=${encodeURIComponent(name)}&per_page=5`
    );
    if (status !== 200 || !data || !data.items || data.items.length === 0)
      return null;
    const results = [];
    for (const user of data.items.slice(0, 3)) {
      const detail = await lookupGitHub(user.login);
      if (detail) results.push(detail);
    }
    return results.length > 0 ? results : null;
  } catch {
    return null;
  }
}

async function lookupReddit(username) {
  try {
    const { status, data } = await fetchJSON(
      `https://www.reddit.com/user/${encodeURIComponent(username)}/about.json`
    );
    if (status !== 200 || !data || !data.data) return null;
    const d = data.data;
    return {
      source: "Reddit",
      icon: "reddit",
      profile_url: `https://www.reddit.com/user/${d.name}`,
      avatar: d.icon_img ? d.icon_img.split("?")[0] : null,
      name: d.name,
      link_karma: d.link_karma,
      comment_karma: d.comment_karma,
      created: new Date(d.created_utc * 1000).toISOString(),
      is_gold: d.is_gold,
      verified: d.verified,
    };
  } catch {
    return null;
  }
}

async function lookupWikipedia(name) {
  try {
    const { status, data } = await fetchJSON(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name.replace(/ /g, "_"))}`
    );
    if (status !== 200 || !data || data.type === "not_found") return null;
    return {
      source: "Wikipedia",
      icon: "wikipedia",
      profile_url: data.content_urls?.desktop?.page,
      thumbnail: data.thumbnail?.source,
      name: data.title,
      description: data.description,
      extract: data.extract,
    };
  } catch {
    return null;
  }
}

async function lookupGravatar(query) {
  try {
    const hash = query.includes("@")
      ? crypto
          .createHash("md5")
          .update(query.trim().toLowerCase())
          .digest("hex")
      : query.toLowerCase();
    const { status, data } = await fetchJSON(
      `https://en.gravatar.com/${encodeURIComponent(hash)}.json`
    );
    if (status !== 200 || !data || !data.entry || data.entry.length === 0)
      return null;
    const entry = data.entry[0];
    return {
      source: "Gravatar",
      icon: "gravatar",
      profile_url: entry.profileUrl,
      avatar: entry.thumbnailUrl,
      name: entry.displayName,
      about: entry.aboutMe,
      location: entry.currentLocation,
      urls: entry.urls || [],
    };
  } catch {
    return null;
  }
}

async function lookupStackOverflow(username) {
  try {
    const { status, data } = await fetchJSON(
      `https://api.stackexchange.com/2.3/users?order=desc&sort=reputation&inname=${encodeURIComponent(username)}&site=stackoverflow&pagesize=3`
    );
    if (status !== 200 || !data || !data.items || data.items.length === 0)
      return null;
    return data.items.slice(0, 3).map((u) => ({
      source: "Stack Overflow",
      icon: "stackoverflow",
      profile_url: u.link,
      avatar: u.profile_image,
      name: u.display_name,
      reputation: u.reputation,
      badge_gold: u.badge_counts?.gold,
      badge_silver: u.badge_counts?.silver,
      badge_bronze: u.badge_counts?.bronze,
      location: u.location,
      created: new Date(u.creation_date * 1000).toISOString(),
    }));
  } catch {
    return null;
  }
}

async function lookupHackerNews(username) {
  try {
    const { status, data } = await fetchJSON(
      `https://hacker-news.firebaseio.com/v0/user/${encodeURIComponent(username)}.json`
    );
    if (status !== 200 || !data || !data.id) return null;
    return {
      source: "Hacker News",
      icon: "hackernews",
      profile_url: `https://news.ycombinator.com/user?id=${data.id}`,
      name: data.id,
      karma: data.karma,
      about: data.about,
      created: new Date(data.created * 1000).toISOString(),
    };
  } catch {
    return null;
  }
}

async function lookupDNS(query) {
  if (!/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(query)) return null;
  try {
    const { status, data } = await fetchJSON(
      `https://dns.google/resolve?name=${encodeURIComponent(query)}&type=A`
    );
    if (status !== 200 || !data) return null;
    return {
      source: "DNS Lookup",
      icon: "dns",
      domain: query,
      status_code: data.Status,
      answers: (data.Answer || []).map((a) => ({
        type: a.type,
        data: a.data,
        ttl: a.TTL,
      })),
    };
  } catch {
    return null;
  }
}

async function checkPlatformExists(username, platform, url) {
  try {
    const { status } = await fetchText(url);
    if (status === 200) {
      return {
        source: platform,
        icon: platform.toLowerCase(),
        profile_url: url,
        exists: true,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function lookupUsernameAvailability(username) {
  const checks = [
    {
      platform: "GitLab",
      url: `https://gitlab.com/${encodeURIComponent(username)}`,
    },
    {
      platform: "Keybase",
      url: `https://keybase.io/${encodeURIComponent(username)}`,
    },
  ];
  const results = await Promise.allSettled(
    checks.map((c) => checkPlatformExists(username, c.platform, c.url))
  );
  return results
    .filter((r) => r.status === "fulfilled" && r.value !== null)
    .map((r) => r.value);
}

// ── Text lookup endpoint ────────────────────────────────────────────────

app.post("/api/lookup", async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return res.status(400).json({ error: "Query is required" });
  }

  const sanitized = query.trim().slice(0, 100);
  const isLikelyUsername = !/\s/.test(sanitized);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sanitized);

  const tasks = [];
  tasks.push(lookupWikipedia(sanitized));

  if (isEmail) {
    tasks.push(lookupGravatar(sanitized));
  }

  if (isLikelyUsername) {
    tasks.push(lookupGitHub(sanitized));
    tasks.push(lookupReddit(sanitized));
    tasks.push(lookupStackOverflow(sanitized));
    tasks.push(lookupHackerNews(sanitized));
    tasks.push(lookupGravatar(sanitized));
    tasks.push(lookupUsernameAvailability(sanitized));
    tasks.push(lookupDNS(sanitized));
  } else {
    tasks.push(lookupGitHubByName(sanitized));
    tasks.push(lookupStackOverflow(sanitized));
  }

  const settled = await Promise.allSettled(tasks);
  const results = [];
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value !== null) {
      if (Array.isArray(r.value)) results.push(...r.value);
      else results.push(r.value);
    }
  }

  res.json({ query: sanitized, results, count: results.length });
});

// ── Image upload endpoint ───────────────────────────────────────────────

app.post("/api/upload", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image uploaded" });
  res.json({
    filename: req.file.filename,
    url: `/uploads/${req.file.filename}`,
    size: req.file.size,
    mimetype: req.file.mimetype,
  });
});

// ── Server-side reverse image search proxy ──────────────────────────────
// Submits the uploaded image to search engines and returns redirect URLs

function proxyReverseSearch(engine, fileBuffer, filename, contentType) {
  return new Promise((resolve, reject) => {
    let host, postPath, fileField, extraFields;

    switch (engine) {
      case "google":
        host = "www.google.com";
        postPath = "/searchbyimage/upload";
        fileField = "encoded_image";
        extraFields = { image_url: "", sbisrc: "cr_1", image_content: "" };
        break;
      case "yandex":
        host = "yandex.com";
        postPath = "/images/search?rpt=imageview&format=json";
        fileField = "upfile";
        extraFields = {};
        break;
      case "tineye":
        host = "tineye.com";
        postPath = "/search";
        fileField = "image";
        extraFields = {};
        break;
      default:
        return reject(new Error("Unknown engine"));
    }

    const { boundary, body } = buildMultipart(
      extraFields,
      fileField,
      fileBuffer,
      filename,
      contentType
    );

    const options = {
      hostname: host,
      path: postPath,
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        // Most engines return a 302 redirect to results
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
    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ engine, status: "error", error: "timeout" });
    });
    req.write(body);
    req.end();
  });
}

app.post("/api/reverse-search", async (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: "filename required" });

  const filePath = path.join(UPLOADS_DIR, path.basename(filename));
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  const fileBuffer = fs.readFileSync(filePath);
  const ext = path.extname(filename).toLowerCase();
  const mimeMap = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };
  const contentType = mimeMap[ext] || "image/jpeg";

  const engines = ["google", "yandex", "tineye"];
  const results = await Promise.allSettled(
    engines.map((e) => proxyReverseSearch(e, fileBuffer, filename, contentType))
  );

  const output = results.map((r) =>
    r.status === "fulfilled" ? r.value : { engine: "unknown", status: "error" }
  );

  res.json({ results: output });
});

// ── Cleanup old uploads every 10 minutes ────────────────────────────────

setInterval(() => {
  if (!fs.existsSync(UPLOADS_DIR)) return;
  const now = Date.now();
  for (const file of fs.readdirSync(UPLOADS_DIR)) {
    try {
      const filePath = path.join(UPLOADS_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > 30 * 60 * 1000) fs.unlinkSync(filePath);
    } catch {
      // ignore cleanup errors
    }
  }
}, 10 * 60 * 1000);

// ── Start ───────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Person Lookup running at http://localhost:${PORT}`);
});
