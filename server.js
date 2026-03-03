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
        ...headers,
      },
    };
    const req = driver.request(reqOpts, (res) => {
      // Follow redirects
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

// GET request that follows redirects, returns status code
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
        res.resume(); // drain
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let loc = res.headers.location;
          if (loc.startsWith("/")) loc = opts.protocol + "//" + opts.hostname + loc;
          // Check if redirect goes to a "not found" or login page
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

// ── Username existence checking (server-side, no CORS issues) ───────────

async function checkUsername(username) {
  const platforms = [
    { name: "Instagram", url: `https://www.instagram.com/${username}/`, check: "get" },
    { name: "Twitter/X", url: `https://x.com/${username}`, check: "get" },
    { name: "TikTok", url: `https://www.tiktok.com/@${username}`, check: "get" },
    { name: "Facebook", url: `https://www.facebook.com/${username}`, check: "get" },
    { name: "YouTube", url: `https://www.youtube.com/@${username}`, check: "get" },
    { name: "Pinterest", url: `https://www.pinterest.com/${username}/`, check: "get" },
    { name: "Twitch", url: `https://www.twitch.tv/${username}`, check: "get" },
    { name: "Spotify", url: `https://open.spotify.com/user/${username}`, check: "get" },
    { name: "SoundCloud", url: `https://soundcloud.com/${username}`, check: "get" },
    { name: "Medium", url: `https://medium.com/@${username}`, check: "get" },
    { name: "Dribbble", url: `https://dribbble.com/${username}`, check: "get" },
    { name: "Behance", url: `https://www.behance.net/${username}`, check: "get" },
    { name: "DeviantArt", url: `https://www.deviantart.com/${username}`, check: "get" },
    { name: "Flickr", url: `https://www.flickr.com/people/${username}`, check: "get" },
    { name: "Patreon", url: `https://www.patreon.com/${username}`, check: "get" },
    { name: "Steam", url: `https://steamcommunity.com/id/${username}`, check: "get" },
    { name: "Letterboxd", url: `https://letterboxd.com/${username}`, check: "get" },
    { name: "Last.fm", url: `https://www.last.fm/user/${username}`, check: "get" },
    { name: "MyAnimeList", url: `https://myanimelist.net/profile/${username}`, check: "get" },
    { name: "Linktree", url: `https://linktr.ee/${username}`, check: "get" },
    { name: "About.me", url: `https://about.me/${username}`, check: "get" },
    { name: "Product Hunt", url: `https://www.producthunt.com/@${username}`, check: "get" },
    { name: "CodePen", url: `https://codepen.io/${username}`, check: "get" },
    { name: "Replit", url: `https://replit.com/@${username}`, check: "get" },
    { name: "Kaggle", url: `https://www.kaggle.com/${username}`, check: "get" },
    { name: "Threads", url: `https://www.threads.net/@${username}`, check: "get" },
  ];

  // Run all checks in parallel with concurrency limit
  const CONCURRENCY = 10;
  const results = [];
  for (let i = 0; i < platforms.length; i += CONCURRENCY) {
    const batch = platforms.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (p) => {
        try {
          const status = await getCheck(p.url, 6000);
          return { name: p.name, url: p.url, exists: status >= 200 && status < 400, status };
        } catch {
          return { name: p.name, url: p.url, exists: false, status: 0 };
        }
      })
    );
    for (const r of batchResults) {
      if (r.status === "fulfilled") results.push(r.value);
    }
  }
  return results;
}

// ── DuckDuckGo HTML search scrape (no API key needed) ───────────────────

async function scrapeWebSearch(query) {
  try {
    const { status, data } = await fetchText(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { Accept: "text/html" },
      12000
    );
    if (status !== 200 || !data) return [];

    const results = [];
    // Parse DuckDuckGo HTML results (simple regex-based extraction)
    const linkRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    const links = [...data.matchAll(linkRegex)];
    const snippets = [...data.matchAll(snippetRegex)];

    for (let i = 0; i < Math.min(links.length, 10); i++) {
      let url = links[i][1];
      // DuckDuckGo wraps URLs in redirect
      const uddg = url.match(/uddg=([^&]+)/);
      if (uddg) url = decodeURIComponent(uddg[1]);

      const title = links[i][2].replace(/<[^>]*>/g, "").trim();
      const snippet = snippets[i] ? snippets[i][1].replace(/<[^>]*>/g, "").trim() : "";

      if (title && url.startsWith("http")) {
        results.push({ title, url, snippet });
      }
    }
    return results;
  } catch { return []; }
}

// ── Reverse image search (server-side proxy) ────────────────────────────

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

// ── Privacy exposure score (server-side) ────────────────────────────────

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
  // Username existence results
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

// ══════════════════════════════════════════════════════════════════════════
//  API ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════

// ── Full text search endpoint ───────────────────────────────────────────

app.post("/api/search", async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== "string" || !query.trim()) {
    return res.status(400).json({ error: "Query is required" });
  }

  const sanitized = query.trim().slice(0, 100);
  const isUsername = !/\s/.test(sanitized);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sanitized);
  const isDomain = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(sanitized) && !isEmail;

  // SSE-style streaming: send results as they come in
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  function send(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  const allResults = [];
  let usernameCheckResults = null;

  // Phase 1: Core
  send("phase", { phase: 1, label: "Core platform search..." });

  const coreTasks = [];
  coreTasks.push(lookupWikipedia(sanitized));
  coreTasks.push(lookupDuckDuckGo(sanitized));
  if (isUsername) {
    coreTasks.push(lookupGitHub(sanitized));
    coreTasks.push(lookupReddit(sanitized));
    coreTasks.push(lookupStackOverflow(sanitized));
    coreTasks.push(lookupHackerNews(sanitized));
  } else {
    coreTasks.push(lookupGitHubByName(sanitized));
    coreTasks.push(lookupStackOverflow(sanitized));
  }
  if (isEmail) coreTasks.push(lookupGravatar(sanitized));
  if (isDomain) {
    coreTasks.push(lookupDNS(sanitized));
    coreTasks.push(lookupRDAP(sanitized));
    coreTasks.push(lookupIPGeo(sanitized));
    coreTasks.push(lookupWayback(sanitized));
  }

  let settled = await Promise.allSettled(coreTasks);
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) {
      const items = Array.isArray(r.value) ? r.value : [r.value];
      allResults.push(...items);
      send("results", { results: items });
    }
  }

  // Phase 2: Deep
  send("phase", { phase: 2, label: `Deep platform search (${allResults.length} found)...` });

  const deepTasks = [];
  if (isUsername) {
    deepTasks.push(lookupGitLab(sanitized));
    deepTasks.push(lookupKeybase(sanitized));
    deepTasks.push(lookupNpm(sanitized));
    deepTasks.push(lookupDockerHub(sanitized));
    deepTasks.push(lookupDevTo(sanitized));
    deepTasks.push(lookupLichess(sanitized));
    deepTasks.push(lookupChessCom(sanitized));
    deepTasks.push(lookupRoblox(sanitized));
    deepTasks.push(lookupMastodon(sanitized));
    deepTasks.push(lookupGravatar(sanitized));
    deepTasks.push(lookupCratesIO(sanitized));
    deepTasks.push(lookupPyPI(sanitized));
    deepTasks.push(lookupHuggingFace(sanitized));
  }
  deepTasks.push(lookupWikidata(sanitized));
  deepTasks.push(lookupOpenLibrary(sanitized));
  deepTasks.push(lookupArchiveOrg(sanitized));

  settled = await Promise.allSettled(deepTasks);
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) {
      const items = Array.isArray(r.value) ? r.value : [r.value];
      allResults.push(...items);
      send("results", { results: items });
    }
  }

  // Phase 3: GitHub deep + web search
  send("phase", { phase: 3, label: `Activity analysis & web search (${allResults.length} found)...` });

  const analysisTasks = [];
  if (isUsername && allResults.some(r => r.source === "GitHub")) {
    analysisTasks.push(lookupGitHubRepos(sanitized));
    analysisTasks.push(lookupGitHubGists(sanitized));
    analysisTasks.push(lookupGitHubEvents(sanitized));
    analysisTasks.push(lookupGitHubEmails(sanitized));
  }
  if (isUsername || isEmail) analysisTasks.push(lookupBreaches(sanitized));

  // Web search scrape
  const webSearchPromise = scrapeWebSearch(sanitized);

  settled = await Promise.allSettled(analysisTasks);
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) {
      const items = Array.isArray(r.value) ? r.value : [r.value];
      allResults.push(...items);
      send("results", { results: items });
    }
  }

  const webResults = await webSearchPromise;
  if (webResults.length) {
    send("web_results", { results: webResults });
  }

  // Phase 4: Username existence check (server-side)
  if (isUsername) {
    send("phase", { phase: 4, label: `Checking username across 25+ platforms...` });
    usernameCheckResults = await checkUsername(sanitized);
    send("username_check", { results: usernameCheckResults });
  }

  // Final: exposure score
  const exposure = calculateExposureScore(allResults, usernameCheckResults);
  send("complete", { total: allResults.length, exposure });

  res.end();
});

// ── Image upload + analysis ─────────────────────────────────────────────

app.post("/api/upload", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image uploaded" });
  res.json({
    filename: req.file.filename,
    url: `/uploads/${req.file.filename}`,
    size: req.file.size,
    mimetype: req.file.mimetype,
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  FACE SCANNING PIPELINE v2 — Search EVERYWHERE
// ══════════════════════════════════════════════════════════════════════════


function chainRequest(url, options = {}, depth = 0) {
  return new Promise((resolve) => {
    if (depth > 8) return resolve({ statusCode: 0, body: "", finalUrl: url, error: "too many redirects" });
    try {
      const parsed = new URL(url);
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
          ...(options.headers || {}),
        },
      };
      const req = driver.request(reqOpts, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          let loc = res.headers.location;
          if (loc.startsWith("/")) loc = parsed.protocol + "//" + parsed.hostname + loc;
          else if (!loc.startsWith("http")) loc = parsed.protocol + "//" + parsed.hostname + "/" + loc;
          const prevCookies = options.headers?.Cookie || "";
          const newCookies = res.headers["set-cookie"]?.map(c => c.split(";")[0]).join("; ") || "";
          const allCookies = [prevCookies, newCookies].filter(Boolean).join("; ");
          chainRequest(loc, { method: "GET", headers: { Cookie: allCookies }, timeout: options.timeout }, depth + 1).then(resolve);
          return;
        }
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => {
          let bodyStr;
          try { bodyStr = Buffer.concat(chunks).toString("utf-8"); } catch { bodyStr = ""; }
          resolve({ statusCode: res.statusCode, headers: res.headers, body: bodyStr, finalUrl: url });
        });
      });
      req.on("error", err => resolve({ statusCode: 0, body: "", finalUrl: url, error: err.message }));
      req.setTimeout(options.timeout || 25000, () => { req.destroy(); resolve({ statusCode: 0, body: "", finalUrl: url, error: "timeout" }); });
      if (options.body) req.write(options.body);
      req.end();
    } catch (err) { resolve({ statusCode: 0, body: "", finalUrl: url, error: err.message }); }
  });
}

// ── Platform detection (40+ platforms) ──────────────────────────────────

const PLATFORM_MAP = [
  ["instagram.com", "Instagram"], ["twitter.com", "Twitter/X"], ["x.com", "Twitter/X"],
  ["facebook.com", "Facebook"], ["fb.com", "Facebook"], ["linkedin.com", "LinkedIn"],
  ["tiktok.com", "TikTok"], ["pinterest.com", "Pinterest"], ["youtube.com", "YouTube"],
  ["youtu.be", "YouTube"], ["reddit.com", "Reddit"], ["tumblr.com", "Tumblr"],
  ["vk.com", "VK"], ["flickr.com", "Flickr"], ["deviantart.com", "DeviantArt"],
  ["twitch.tv", "Twitch"], ["snapchat.com", "Snapchat"], ["threads.net", "Threads"],
  ["bsky.app", "Bluesky"], ["mastodon.social", "Mastodon"], ["github.com", "GitHub"],
  ["imdb.com", "IMDb"], ["wikipedia.org", "Wikipedia"], ["wikidata.org", "Wikidata"],
  ["medium.com", "Medium"], ["quora.com", "Quora"], ["spotify.com", "Spotify"],
  ["soundcloud.com", "SoundCloud"], ["myspace.com", "MySpace"], ["weibo.com", "Weibo"],
  ["ok.ru", "Odnoklassniki"], ["telegram.org", "Telegram"], ["t.me", "Telegram"],
  ["discord.gg", "Discord"], ["patreon.com", "Patreon"], ["onlyfans.com", "OnlyFans"],
  ["behance.net", "Behance"], ["dribbble.com", "Dribbble"], ["500px.com", "500px"],
  ["ask.fm", "ASKfm"], ["about.me", "About.me"], ["linktree", "Linktree"],
  ["steamcommunity.com", "Steam"], ["letterboxd.com", "Letterboxd"],
  ["namu.wiki", "NamuWiki"], ["pixiv.net", "Pixiv"], ["artstation.com", "ArtStation"],
];

function detectPlatform(url) {
  if (!url) return null;
  const u = url.toLowerCase();
  for (const [domain, name] of PLATFORM_MAP) {
    if (u.includes(domain)) return name;
  }
  return null;
}

// ── Extract username from social media URL ──────────────────────────────

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
    if (host.includes("youtube.com")) {
      if (parts[0].startsWith("@")) return parts[0].slice(1);
      if ((parts[0] === "c" || parts[0] === "user" || parts[0] === "channel") && parts[1]) return parts[1];
    }
    if (host.includes("reddit.com") && parts[0] === "user" && parts[1]) return parts[1];
    if (host.includes("github.com") && !["features", "enterprise", "pricing", "login", "join", "orgs", "settings"].includes(parts[0])) return parts[0];
    if (host.includes("pinterest.com") && !["pin", "search", "ideas", "today"].includes(parts[0])) return parts[0];
    if (host.includes("twitch.tv") && !["directory", "videos", "settings", "downloads"].includes(parts[0])) return parts[0];
    if (host.includes("vk.com") && !["feed", "im", "groups", "video", "music"].includes(parts[0])) return parts[0];
    if (host.includes("flickr.com") && parts[0] === "people" && parts[1]) return parts[1];
    if (host.includes("medium.com") && parts[0].startsWith("@")) return parts[0].slice(1);
    if (host.includes("soundcloud.com") && !["discover", "stream", "search", "upload"].includes(parts[0])) return parts[0];
    if (host.includes("deviantart.com") && !["search", "about", "team"].includes(parts[0])) return parts[0];
  } catch {}
  return null;
}

// ══════════════════════════════════════════════════════════════════════════
//  SEARCH ENGINES — 7 engines, each submits the face and scrapes results
// ══════════════════════════════════════════════════════════════════════════

// ── 1. YANDEX (best facial recognition) ─────────────────────────────────

async function yandexFaceScan(buffer, filename, contentType) {
  try {
    const { boundary, body } = buildMultipart({}, "upfile", buffer, filename, contentType);
    const response = await chainRequest("https://yandex.com/images/search?rpt=imageview", {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length.toString() },
      body, timeout: 30000,
    });
    const html = response.body || "";
    const results = [];
    let identifiedName = null;
    const tags = [];

    // Extract CBIR tags (Yandex face recognition — person's name)
    const tagMatches = [...html.matchAll(/CbirTags[\s\S]{0,2000}?<\/div>/gi)];
    for (const tm of tagMatches) {
      const links = [...tm[0].matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)];
      for (const l of links) {
        const t = l[1].replace(/<[^>]*>/g, "").trim();
        if (t && t.length > 1 && t.length < 80) { tags.push(t); if (!identifiedName) identifiedName = t; }
      }
    }

    // Extract from CbirSimilar section (face matches)
    const similarSection = html.match(/CbirSimilar[\s\S]{0,80000}?(?=CbirSites|CbirOther|$)/i);
    if (similarSection) {
      const imgUrls = [...similarSection[0].matchAll(/(?:src|data-src|href)="(https?:\/\/[^"]+\.(jpg|jpeg|png|webp)[^"]*)"/gi)];
      for (const iu of imgUrls.slice(0, 15)) {
        if (!iu[1].includes("yandex.") && !iu[1].includes("avatars.mds")) {
          results.push({ title: "Similar face", url: iu[1], thumbnail: iu[1], image_url: iu[1], source_engine: "yandex" });
        }
      }
    }

    // Extract serp-items (structured results)
    const serpRegex = /data-bem='(\{"serp-item":\{[^']*\})'/g;
    let match;
    while ((match = serpRegex.exec(html)) !== null) {
      try {
        const decoded = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
        const data = JSON.parse(decoded)["serp-item"];
        if (data) {
          results.push({
            title: data.snippet?.title || data.snippet?.text || "",
            url: data.snippet?.url || data.img_href || "",
            thumbnail: data.preview?.[0]?.url || data.thumb?.url || "",
            image_url: data.img_href || "", source_engine: "yandex",
          });
        }
      } catch {}
    }

    // Extract CbirSites section (sites containing this image)
    const sitesSection = html.match(/CbirSites[\s\S]{0,80000}?(?=CbirOther|CbirRelated|$)/i);
    if (sitesSection) {
      const siteLinks = [...sitesSection[0].matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
      for (const sl of siteLinks) {
        if (!sl[1].includes("yandex.") && !results.some(r => r.url === sl[1])) {
          results.push({ title: sl[2].replace(/<[^>]*>/g, "").trim().slice(0, 200), url: sl[1], source_engine: "yandex" });
        }
      }
    }

    // Extract ALL external links
    const allLinks = [...html.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
    for (const al of allLinks) {
      const href = al[1];
      if (!href.includes("yandex.") && !href.includes("yastatic.") && !results.some(r => r.url === href)) {
        const text = al[2].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 2 && text.length < 300) {
          results.push({ title: text, url: href, source_engine: "yandex" });
        }
      }
    }

    // Try Yandex JSON API if we got a cbir_id from redirect
    const cbirMatch = response.finalUrl?.match(/cbir_id=([^&]+)/);
    if (cbirMatch) {
      try {
        const jsonUrl = `https://yandex.com/images/search?format=json&rpt=imageview&cbir_id=${cbirMatch[1]}`;
        const jsonResp = await chainRequest(jsonUrl, { timeout: 15000 });
        if (jsonResp.body) {
          try {
            const jd = JSON.parse(jsonResp.body);
            const blocks = jd.blocks || [];
            for (const block of blocks) {
              if (block.html) {
                const blockLinks = [...block.html.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
                for (const bl of blockLinks) {
                  if (!bl[1].includes("yandex.") && !results.some(r => r.url === bl[1])) {
                    results.push({ title: bl[2].replace(/<[^>]*>/g, "").trim(), url: bl[1], source_engine: "yandex-json" });
                  }
                }
              }
            }
          } catch {}
        }
      } catch {}
    }

    for (const r of results) r.platform = detectPlatform(r.url);
    return { engine: "yandex", status: "ok", results_url: response.finalUrl, identified_name: identifiedName, tags, matches: results.slice(0, 50) };
  } catch (err) { return { engine: "yandex", status: "error", error: err.message, matches: [], tags: [] }; }
}

// ── 2. GOOGLE (reverse image search) ────────────────────────────────────

async function googleFaceScan(buffer, filename, contentType) {
  try {
    const { boundary, body } = buildMultipart({ image_url: "", sbisrc: "cr_1" }, "encoded_image", buffer, filename, contentType);
    const response = await chainRequest("https://www.google.com/searchbyimage/upload", {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length.toString() },
      body, timeout: 30000,
    });
    const html = response.body || "";
    const results = [];
    let identifiedName = null;

    // Entity identification patterns
    const entityPatterns = [
      /Results for[:\s]*<[^>]*>([^<]+)/i, /Possible related search[:\s]*<[^>]*>([^<]+)/i,
      /data-attrid="title"[^>]*>([^<]+)/i, /"kc_nm"[^>]*>([^<]+)/i,
      /aria-level="3"[^>]*>([^<]{2,60})<\/[^>]*>/i, /<div[^>]*class="[^"]*SDkEP[^"]*"[^>]*>([^<]+)/i,
    ];
    for (const pat of entityPatterns) {
      const m = html.match(pat);
      if (m && !identifiedName) {
        const name = m[1].trim();
        if (name.length > 1 && name.length < 60 && !name.includes("<")) identifiedName = name;
      }
    }

    // Extract search result blocks
    const resultBlocks = html.split(/<div[^>]*class="[^"]*\bg\b[^"]*"/i);
    for (const block of resultBlocks.slice(1, 30)) {
      const linkMatch = block.match(/<a[^>]+href="(https?:\/\/(?!www\.google\.)[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (linkMatch) {
        const snippetMatch = block.match(/<span[^>]*class="[^"]*st[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
        results.push({
          title: linkMatch[2].replace(/<[^>]*>/g, "").trim().slice(0, 200),
          url: linkMatch[1],
          snippet: snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, "").trim().slice(0, 200) : "",
          source_engine: "google",
        });
      }
    }

    // Extract ALL non-google links
    const allLinks = [...html.matchAll(/<a[^>]+href="(https?:\/\/(?!(?:www\.)?google\.)[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
    for (const al of allLinks) {
      if (!al[1].includes("google.com") && !al[1].includes("gstatic.com") && !al[1].includes("googleapis.com") && !results.some(r => r.url === al[1])) {
        const text = al[2].replace(/<[^>]*>/g, "").trim();
        if (text.length > 1 && text.length < 300) results.push({ title: text, url: al[1], source_engine: "google" });
      }
    }

    // Extract image URLs from JS arrays
    const imgRegex = /\["(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp|gif)[^"]*)",\s*(\d+),\s*(\d+)\]/gi;
    while ((match = imgRegex.exec(html)) !== null) {
      const imgUrl = match[1].replace(/\\u003d/g, "=").replace(/\\u0026/g, "&");
      if (!imgUrl.includes("gstatic.com") && !imgUrl.includes("google.com") && !results.some(r => r.url === imgUrl)) {
        results.push({ title: "Visual match", url: imgUrl, thumbnail: imgUrl, image_url: imgUrl, source_engine: "google-img" });
      }
    }

    // Extract /url?q= redirects
    const redirectLinks = [...html.matchAll(/\/url\?[^"]*q=(https?(?:%3A|:)[^&"]+)/gi)];
    for (const rl of redirectLinks) {
      const decoded = decodeURIComponent(rl[1]);
      if (!decoded.includes("google.com") && !results.some(r => r.url === decoded)) {
        results.push({ title: "Google result", url: decoded, source_engine: "google" });
      }
    }

    for (const r of results) r.platform = detectPlatform(r.url);
    return { engine: "google", status: "ok", results_url: response.finalUrl, identified_name: identifiedName, matches: results.slice(0, 50) };
  } catch (err) { return { engine: "google", status: "error", error: err.message, matches: [] }; }
}

// ── 3. BING VISUAL SEARCH ──────────────────────────────────────────────

async function bingFaceScan(buffer, filename, contentType) {
  try {
    const { boundary, body } = buildMultipart({}, "image", buffer, filename, contentType);
    const response = await chainRequest("https://www.bing.com/images/search?view=detailv2&iss=sbiupload&FORM=SBIHMP&sbifnm=" + encodeURIComponent(filename), {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length.toString() },
      body, timeout: 30000,
    });
    const html = response.body || "";
    const results = [];
    let identifiedName = null;

    const entityMatch = html.match(/class="[^"]*entity[^"]*"[\s\S]*?<a[^>]*>([^<]+)/i) || html.match(/<h2[^>]*>([^<]{2,60})<\/h2>/i);
    if (entityMatch) identifiedName = entityMatch[1].trim();

    // All non-bing links
    const allLinks = [...html.matchAll(/<a[^>]+href="(https?:\/\/(?!(?:www\.)?bing\.)[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
    for (const al of allLinks) {
      if (!al[1].includes("bing.com") && !al[1].includes("microsoft.com") && !al[1].includes("msn.com") && !results.some(r => r.url === al[1])) {
        const text = al[2].replace(/<[^>]*>/g, "").trim();
        if (text.length > 1 && text.length < 300) results.push({ title: text, url: al[1], source_engine: "bing" });
      }
    }

    // Image results from Bing's JSON-encoded data
    const imgRegex = /murl&quot;:&quot;(https?:\/\/[^&]+)&quot;/gi;
    let match;
    while ((match = imgRegex.exec(html)) !== null) {
      const imgUrl = match[1].replace(/\\u002f/gi, "/");
      if (!results.some(r => r.url === imgUrl)) {
        results.push({ title: "Bing visual match", url: imgUrl, thumbnail: imgUrl, image_url: imgUrl, source_engine: "bing-img" });
      }
    }

    // JSON-LD
    const jsonLdMatches = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
    for (const jm of jsonLdMatches) {
      try {
        const ld = JSON.parse(jm[1]);
        if (ld.name && !identifiedName) identifiedName = ld.name;
        if (ld.url && !results.some(r => r.url === ld.url)) results.push({ title: ld.name || "Bing result", url: ld.url, source_engine: "bing" });
      } catch {}
    }

    for (const r of results) r.platform = detectPlatform(r.url);
    return { engine: "bing", status: "ok", results_url: response.finalUrl, identified_name: identifiedName, matches: results.slice(0, 40) };
  } catch (err) { return { engine: "bing", status: "error", error: err.message, matches: [] }; }
}

// ── 4. TINEYE ───────────────────────────────────────────────────────────

async function tineyeFaceScan(buffer, filename, contentType) {
  try {
    const { boundary, body } = buildMultipart({}, "image", buffer, filename, contentType);
    const response = await chainRequest("https://tineye.com/search", {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length.toString() },
      body, timeout: 30000,
    });
    const html = response.body || "";
    const results = [];
    const matchPatterns = [
      /<a[^>]+class="[^"]*match-link[^"]*"[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
      /<p[^>]*class="[^"]*match[^"]*"[\s\S]*?<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
      /<div[^>]*class="[^"]*result[^"]*"[\s\S]*?<a[^>]+href="(https?:\/\/(?!tineye\.)[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    ];
    for (const pat of matchPatterns) {
      let match;
      while ((match = pat.exec(html)) !== null) {
        if (!results.some(r => r.url === match[1])) {
          results.push({ title: match[2].replace(/<[^>]*>/g, "").trim() || "TinEye match", url: match[1], source_engine: "tineye" });
        }
      }
    }
    // All non-tineye links
    const allLinks = [...html.matchAll(/<a[^>]+href="(https?:\/\/(?!(?:www\.)?tineye\.)[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
    for (const al of allLinks) {
      if (!results.some(r => r.url === al[1])) {
        const text = al[2].replace(/<[^>]*>/g, "").trim();
        if (text.length > 0) results.push({ title: text, url: al[1], source_engine: "tineye" });
      }
    }
    const countMatch = html.match(/(\d+)\s*(?:results?|matches?)/i);
    for (const r of results) r.platform = detectPlatform(r.url);
    return { engine: "tineye", status: "ok", results_url: response.finalUrl, total_matches: countMatch ? parseInt(countMatch[1]) : results.length, matches: results.slice(0, 30) };
  } catch (err) { return { engine: "tineye", status: "error", error: err.message, matches: [] }; }
}

// ── 5. BAIDU (Chinese search engine with face recognition) ──────────────

async function baiduFaceScan(buffer, filename, contentType) {
  try {
    const { boundary, body } = buildMultipart({}, "image", buffer, filename, contentType);
    const response = await chainRequest("https://graph.baidu.com/upload", {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length.toString() },
      body, timeout: 30000,
    });
    const results = [];
    let identifiedName = null;
    try {
      const json = JSON.parse(response.body);
      if (json.data?.url) {
        const pageResp = await chainRequest(json.data.url, { timeout: 20000 });
        const html = pageResp.body || "";
        const nameMatch = html.match(/"name"\s*:\s*"([^"]+)"/i) || html.match(/class="[^"]*card-title[^"]*"[^>]*>([^<]+)/i);
        if (nameMatch) identifiedName = nameMatch[1].trim();
        const links = [...html.matchAll(/<a[^>]+href="(https?:\/\/(?!(?:www\.)?baidu\.)[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
        for (const l of links) {
          if (!l[1].includes("baidu.com") && !l[1].includes("bdstatic.com")) {
            results.push({ title: l[2].replace(/<[^>]*>/g, "").trim(), url: l[1], source_engine: "baidu" });
          }
        }
        const jsonData = [...html.matchAll(/"url"\s*:\s*"(https?:\/\/[^"]+)"/gi)];
        for (const jd of jsonData) {
          if (!jd[1].includes("baidu.com") && !results.some(r => r.url === jd[1])) {
            results.push({ title: "Baidu match", url: jd[1], source_engine: "baidu" });
          }
        }
      }
    } catch {}
    for (const r of results) r.platform = detectPlatform(r.url);
    return { engine: "baidu", status: "ok", results_url: response.finalUrl, identified_name: identifiedName, matches: results.slice(0, 30) };
  } catch (err) { return { engine: "baidu", status: "error", error: err.message, matches: [] }; }
}

// ── 6. SAUCENAO (multi-site image search) ───────────────────────────────

async function saucenaoFaceScan(buffer, filename, contentType) {
  try {
    const { boundary, body } = buildMultipart({ db: "999", output_type: "0" }, "file", buffer, filename, contentType);
    const response = await chainRequest("https://saucenao.com/search.php", {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length.toString() },
      body, timeout: 30000,
    });
    const html = response.body || "";
    const results = [];
    const resultBlocks = html.split(/class="result"/i);
    for (const block of resultBlocks.slice(1, 20)) {
      const links = [...block.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
      const simMatch = block.match(/(\d+(?:\.\d+)?)\s*%/);
      const similarity = simMatch ? parseFloat(simMatch[1]) : 0;
      for (const l of links) {
        if (!l[1].includes("saucenao.com") && !results.some(r => r.url === l[1])) {
          results.push({ title: l[2].replace(/<[^>]*>/g, "").trim() || "SauceNAO match", url: l[1], similarity, source_engine: "saucenao" });
        }
      }
    }
    for (const r of results) r.platform = detectPlatform(r.url);
    return { engine: "saucenao", status: "ok", results_url: response.finalUrl, matches: results.slice(0, 20) };
  } catch (err) { return { engine: "saucenao", status: "error", error: err.message, matches: [] }; }
}

// ── 7. KARMA DECAY (Reddit reverse image search) ───────────────────────

async function karmaDecayScan(buffer, filename, contentType) {
  try {
    const { boundary, body } = buildMultipart({}, "image", buffer, filename, contentType);
    const response = await chainRequest("http://karmadecay.com/search", {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length.toString() },
      body, timeout: 25000,
    });
    const html = response.body || "";
    const results = [];
    const redditLinks = [...html.matchAll(/<a[^>]+href="(https?:\/\/(?:www\.)?reddit\.com\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
    for (const rl of redditLinks) {
      if (!results.some(r => r.url === rl[1])) {
        results.push({ title: rl[2].replace(/<[^>]*>/g, "").trim(), url: rl[1], platform: "Reddit", source_engine: "karmadecay" });
      }
    }
    return { engine: "karmadecay", status: "ok", matches: results.slice(0, 10) };
  } catch (err) { return { engine: "karmadecay", status: "error", error: err.message, matches: [] }; }
}

// ══════════════════════════════════════════════════════════════════════════
//  SOCIAL MEDIA DEEP SEARCH — name + username based
// ══════════════════════════════════════════════════════════════════════════

async function deepSocialSearch(name) {
  if (!name) return [];
  const sites = [
    "instagram.com", "twitter.com", "x.com", "facebook.com", "linkedin.com",
    "tiktok.com", "youtube.com", "pinterest.com", "reddit.com", "tumblr.com",
    "vk.com", "flickr.com", "deviantart.com", "twitch.tv", "snapchat.com",
    "threads.net", "medium.com", "quora.com", "github.com", "spotify.com",
    "soundcloud.com", "myspace.com", "behance.net", "dribbble.com", "500px.com",
    "ok.ru", "ask.fm", "about.me", "patreon.com", "imdb.com", "wikipedia.org",
  ];
  const allResults = [];
  // Process in batches of 6
  for (let i = 0; i < sites.length; i += 6) {
    const batch = sites.slice(i, i + 6);
    const batchResults = await Promise.allSettled(
      batch.map(async (site) => {
        const webResults = await scrapeWebSearch(`"${name}" site:${site}`);
        return webResults.slice(0, 3).map(r => ({
          title: r.title, url: r.url, snippet: r.snippet,
          source_engine: "ddg-social", platform: detectPlatform(r.url),
        }));
      })
    );
    for (const br of batchResults) {
      if (br.status === "fulfilled") allResults.push(...br.value);
    }
  }
  return allResults;
}

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
    { name: "Spotify", url: `https://open.spotify.com/user/${username}` },
    { name: "VK", url: `https://vk.com/${username}` },
    { name: "Dribbble", url: `https://dribbble.com/${username}` },
    { name: "Behance", url: `https://www.behance.net/${username}` },
    { name: "500px", url: `https://500px.com/p/${username}` },
    { name: "About.me", url: `https://about.me/${username}` },
    { name: "Patreon", url: `https://www.patreon.com/${username}` },
    { name: "Letterboxd", url: `https://letterboxd.com/${username}/` },
    { name: "Steam", url: `https://steamcommunity.com/id/${username}` },
    { name: "Threads", url: `https://www.threads.net/@${username}` },
    { name: "Bluesky", url: `https://bsky.app/profile/${username}` },
    { name: "Snapchat", url: `https://www.snapchat.com/add/${username}` },
    { name: "ASKfm", url: `https://ask.fm/${username}` },
    { name: "Linktree", url: `https://linktr.ee/${username}` },
  ];
  const found = [];
  for (let i = 0; i < profiles.length; i += 10) {
    const batch = profiles.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map(async (p) => {
        const status = await getCheck(p.url, 6000);
        return { ...p, exists: status >= 200 && status < 400, status };
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.exists) {
        found.push({ title: `${r.value.name}: @${username}`, url: r.value.url, platform: r.value.name, source_engine: "username-check" });
      }
    }
  }
  return found;
}

async function searchNameVariations(name) {
  if (!name) return [];
  const results = [];
  const parts = name.toLowerCase().split(/\s+/);
  const guesses = new Set();
  if (parts.length >= 2) {
    guesses.add(parts.join("")); guesses.add(parts.join(".")); guesses.add(parts.join("_"));
    guesses.add(parts[0] + parts[parts.length - 1][0]);
    guesses.add(parts[0][0] + parts[parts.length - 1]);
    guesses.add(parts[0]); guesses.add(parts[parts.length - 1]);
  }
  const topGuesses = [...guesses].slice(0, 3);
  const guessResults = await Promise.allSettled(topGuesses.map(g => crossCheckUsername(g)));
  for (const gr of guessResults) {
    if (gr.status === "fulfilled") results.push(...gr.value);
  }
  // General web search for name
  try {
    const webResults = await scrapeWebSearch(`"${name}" social media profile`);
    for (const wr of webResults.slice(0, 5)) {
      results.push({ title: wr.title, url: wr.url, snippet: wr.snippet, source_engine: "web-name", platform: detectPlatform(wr.url) });
    }
  } catch {}
  // People-search sites
  const peopleSites = [
    `"${name}" site:spokeo.com`, `"${name}" site:whitepages.com`,
    `"${name}" site:pipl.com`, `"${name}" site:peekyou.com`,
    `"${name}" site:socialblade.com`,
  ];
  for (const q of peopleSites) {
    try {
      const wr = await scrapeWebSearch(q);
      for (const r of wr.slice(0, 2)) {
        results.push({ title: r.title, url: r.url, snippet: r.snippet, source_engine: "people-search", platform: detectPlatform(r.url) || "People Search" });
      }
    } catch {}
  }
  return results;
}

// ══════════════════════════════════════════════════════════════════════════
//  API ENDPOINTS — Face scan + image proxy
// ══════════════════════════════════════════════════════════════════════════

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
        try {
          (new URL(loc).protocol === "https:" ? https : http).get(loc, { headers: { "User-Agent": "Mozilla/5.0" } }, (rRes) => {
            res.setHeader("Content-Type", rRes.headers["content-type"] || "image/jpeg");
            res.setHeader("Cache-Control", "public, max-age=3600");
            rRes.pipe(res);
          }).on("error", () => res.status(502).end());
        } catch { res.status(502).end(); }
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

// ══════════════════════════════════════════════════════════════════════════
//  MAIN FACE SCAN ENDPOINT — 6 phases, searches EVERYWHERE
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

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  function send(event, data) { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} }

  let identifiedName = null;
  const allMatches = [];
  const foundUsernames = new Set();
  const engineStatuses = [];

  // ── Phase 1: Submit to ALL 7 reverse image engines simultaneously ──
  send("phase", { phase: 1, label: "Scanning face across 7 search engines (Google, Yandex, Bing, TinEye, Baidu, SauceNAO, KarmaDecay)..." });

  const phase1 = await Promise.allSettled([
    yandexFaceScan(buffer, filename, contentType),
    googleFaceScan(buffer, filename, contentType),
    bingFaceScan(buffer, filename, contentType),
    tineyeFaceScan(buffer, filename, contentType),
    baiduFaceScan(buffer, filename, contentType),
    saucenaoFaceScan(buffer, filename, contentType),
    karmaDecayScan(buffer, filename, contentType),
  ]);

  const engineNames = ["yandex", "google", "bing", "tineye", "baidu", "saucenao", "karmadecay"];
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
    engineStatuses.push({
      engine: val.engine || engineNames[i], status: val.status, match_count: val.matches?.length || 0,
      identified_name: val.identified_name, results_url: val.results_url, error: val.error,
    });
    send("engine_result", engineStatuses[engineStatuses.length - 1]);
  }
  send("phase_complete", { phase: 1, engines: engineStatuses.length, total_matches: allMatches.length });

  // ── Phase 2: Deep search across 31 social platforms by name ──
  if (identifiedName) {
    send("phase", { phase: 2, label: `Person identified: "${identifiedName}" — searching 31 social platforms...` });
    send("identified", { name: identifiedName });
    const socialResults = await deepSocialSearch(identifiedName);
    if (socialResults.length) {
      allMatches.push(...socialResults);
      send("social_results", { results: socialResults, count: socialResults.length });
    }
  } else {
    send("phase", { phase: 2, label: "No name identified — skipping name-based social search" });
  }

  // ── Phase 3: Cross-check usernames found in results across 29 platforms ──
  const uniqueUsernames = [...foundUsernames].slice(0, 5);
  if (uniqueUsernames.length) {
    send("phase", { phase: 3, label: `Found ${uniqueUsernames.length} username(s): ${uniqueUsernames.join(", ")} — checking 29 platforms each...` });
    const usernameResults = await Promise.allSettled(uniqueUsernames.map(u => crossCheckUsername(u)));
    for (const ur of usernameResults) {
      if (ur.status === "fulfilled" && ur.value.length) {
        allMatches.push(...ur.value);
        send("username_results", { results: ur.value });
      }
    }
  } else {
    send("phase", { phase: 3, label: "No usernames extracted — skipping cross-platform check" });
  }

  // ── Phase 4: Name variations + people-search databases ──
  if (identifiedName) {
    send("phase", { phase: 4, label: "Searching name variations and people-search databases (Spokeo, WhitePages, PeekYou, SocialBlade)..." });
    const nameResults = await searchNameVariations(identifiedName);
    if (nameResults.length) {
      allMatches.push(...nameResults);
      send("name_variation_results", { results: nameResults, count: nameResults.length });
    }
  } else {
    send("phase", { phase: 4, label: "No name — skipping name variation search" });
  }

  // ── Phase 5: General web searches ──
  send("phase", { phase: 5, label: "Running general web searches..." });
  const webQueries = [];
  if (identifiedName) {
    webQueries.push(`"${identifiedName}"`, `"${identifiedName}" photo`, `"${identifiedName}" profile`);
  }
  for (const un of uniqueUsernames.slice(0, 2)) {
    webQueries.push(`"${un}" profile`);
  }
  for (const q of webQueries) {
    try {
      const wr = await scrapeWebSearch(q);
      for (const r of wr.slice(0, 5)) {
        allMatches.push({ title: r.title, url: r.url, snippet: r.snippet, source_engine: "web", platform: detectPlatform(r.url) });
      }
    } catch {}
  }

  // ── Phase 6: Finalize — deduplicate, categorize ──
  send("phase", { phase: 6, label: "Analyzing and categorizing all results..." });

  const seen = new Set();
  const deduped = [];
  for (const m of allMatches) {
    const key = (m.url || "").replace(/^https?:\/\/(?:www\.)?/, "").split("?")[0].split("#")[0].toLowerCase().replace(/\/+$/, "");
    if (key && key.length > 3 && !seen.has(key)) {
      seen.add(key);
      if (!m.platform) m.platform = detectPlatform(m.url);
      deduped.push(m);
    }
  }

  const byPlatform = {};
  const otherMatches = [];
  for (const m of deduped) {
    if (m.platform) {
      if (!byPlatform[m.platform]) byPlatform[m.platform] = [];
      byPlatform[m.platform].push(m);
    } else {
      otherMatches.push(m);
    }
  }

  const engineUrls = {};
  for (const es of engineStatuses) { if (es.results_url) engineUrls[es.engine] = es.results_url; }

  send("complete", {
    identified_name: identifiedName,
    usernames_found: uniqueUsernames,
    total_matches: deduped.length,
    social_platforms_found: Object.keys(byPlatform).length,
    social_media: byPlatform,
    other_matches: otherMatches.slice(0, 30),
    engines: engineUrls,
    engine_statuses: engineStatuses,
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
      if (now - stat.mtimeMs > 30 * 60 * 1000) fs.unlinkSync(filePath);
    } catch {}
  }
}, 10 * 60 * 1000);

// ── Start ───────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Person Lookup running at http://localhost:${PORT}`);
  console.log(`Face scan v2: 7 engines (Google, Yandex, Bing, TinEye, Baidu, SauceNAO, KarmaDecay)`);
  console.log(`+ deep social search (31 platforms) + username cross-check (29 sites) + people-search DBs`);
});
