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
//  FACE SCANNING PIPELINE — Full reverse image search with scraping
// ══════════════════════════════════════════════════════════════════════════

// HTTP client that follows redirects and returns the final page
function chainRequest(url, options = {}, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 6) return resolve({ statusCode: 0, body: "", finalUrl: url, error: "too many redirects" });
    try {
      const parsed = new URL(url);
      const driver = parsed.protocol === "https:" ? https : http;
      const reqOpts = {
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        method: options.method || "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
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
          const cookies = res.headers["set-cookie"]?.map(c => c.split(";")[0]).join("; ") || "";
          chainRequest(loc, {
            method: "GET",
            headers: { Cookie: cookies },
          }, depth + 1).then(resolve).catch(reject);
          return;
        }
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
            finalUrl: url,
          });
        });
      });
      req.on("error", err => resolve({ statusCode: 0, body: "", finalUrl: url, error: err.message }));
      req.setTimeout(options.timeout || 20000, () => { req.destroy(); resolve({ statusCode: 0, body: "", finalUrl: url, error: "timeout" }); });
      if (options.body) req.write(options.body);
      req.end();
    } catch (err) { resolve({ statusCode: 0, body: "", finalUrl: url, error: err.message }); }
  });
}

// Detect social media platform from URL
function detectPlatform(url) {
  if (!url) return null;
  const u = url.toLowerCase();
  if (u.includes("instagram.com")) return "Instagram";
  if (u.includes("twitter.com") || u.includes("x.com")) return "Twitter/X";
  if (u.includes("facebook.com") || u.includes("fb.com")) return "Facebook";
  if (u.includes("linkedin.com")) return "LinkedIn";
  if (u.includes("tiktok.com")) return "TikTok";
  if (u.includes("pinterest.com")) return "Pinterest";
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "YouTube";
  if (u.includes("reddit.com")) return "Reddit";
  if (u.includes("tumblr.com")) return "Tumblr";
  if (u.includes("vk.com")) return "VK";
  if (u.includes("flickr.com")) return "Flickr";
  if (u.includes("deviantart.com")) return "DeviantArt";
  if (u.includes("twitch.tv")) return "Twitch";
  if (u.includes("snapchat.com")) return "Snapchat";
  if (u.includes("threads.net")) return "Threads";
  if (u.includes("bsky.app")) return "Bluesky";
  if (u.includes("mastodon")) return "Mastodon";
  if (u.includes("github.com")) return "GitHub";
  if (u.includes("imdb.com")) return "IMDb";
  if (u.includes("wikipedia.org")) return "Wikipedia";
  if (u.includes("wikidata.org")) return "Wikidata";
  return null;
}

// ── Yandex face scan (best for facial recognition) ──────────────────────

async function yandexFaceScan(buffer, filename, contentType) {
  try {
    const { boundary, body } = buildMultipart({}, "upfile", buffer, filename, contentType);

    // Submit image to Yandex
    const response = await chainRequest("https://yandex.com/images/search?rpt=imageview", {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length.toString(),
      },
      body: body,
      timeout: 25000,
    });

    const html = response.body;
    const results = [];
    let identifiedName = null;

    // Extract CBIR tags (Yandex face recognition — often contains the person's name)
    const tagBlockMatch = html.match(/CbirTags[\s\S]*?<\/div>/i);
    if (tagBlockMatch) {
      const tagLinks = [...tagBlockMatch[0].matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)];
      for (const t of tagLinks) {
        const tag = t[1].replace(/<[^>]*>/g, "").trim();
        if (tag && tag.length > 1) {
          if (!identifiedName) identifiedName = tag;
        }
      }
    }

    // Also try extracting name from title/heading
    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    if (titleMatch && !identifiedName) {
      const title = titleMatch[1].replace(/<[^>]*>/g, "").trim();
      if (title && !title.includes("Yandex") && title.length < 60) {
        identifiedName = title;
      }
    }

    // Extract serp-items (search results with images)
    const serpRegex = /data-bem='(\{"serp-item":\{[^']*\})'/g;
    let match;
    while ((match = serpRegex.exec(html)) !== null) {
      try {
        const decoded = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
        const data = JSON.parse(decoded)["serp-item"];
        if (data) {
          const item = {
            title: data.snippet?.title || "",
            url: data.snippet?.url || "",
            thumbnail: data.preview?.[0]?.url || data.thumb?.url || "",
            image_url: data.img_href || "",
            source_engine: "yandex",
          };
          item.platform = detectPlatform(item.url);
          if (item.url || item.image_url) results.push(item);
        }
      } catch {}
    }

    // Extract from simpler HTML patterns
    const linkRegex = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*class="[^"]*link[^"]*"[^>]*>[\s\S]*?<\/a>/gi;
    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1];
      if (href && !href.includes("yandex.") && !results.some(r => r.url === href)) {
        const textMatch = match[0].match(/>([^<]+)</);
        results.push({
          title: textMatch ? textMatch[1].trim() : "",
          url: href,
          thumbnail: "",
          source_engine: "yandex",
          platform: detectPlatform(href),
        });
      }
    }

    // Extract image src URLs that might be thumbnails of results
    const imgRegex = /<img[^>]+src="(https?:\/\/[^"]*(?:avatars|thumb|preview|photo|image)[^"]*)"[^>]*>/gi;
    while ((match = imgRegex.exec(html)) !== null) {
      // These are potential face match thumbnails
    }

    return {
      engine: "yandex",
      status: "ok",
      results_url: response.finalUrl,
      identified_name: identifiedName,
      matches: results.slice(0, 30),
    };
  } catch (err) {
    return { engine: "yandex", status: "error", error: err.message, matches: [] };
  }
}

// ── Google face scan ────────────────────────────────────────────────────

async function googleFaceScan(buffer, filename, contentType) {
  try {
    const { boundary, body } = buildMultipart(
      { image_url: "", sbisrc: "cr_1" }, "encoded_image", buffer, filename, contentType
    );

    const response = await chainRequest("https://www.google.com/searchbyimage/upload", {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length.toString(),
      },
      body: body,
      timeout: 25000,
    });

    const html = response.body;
    const results = [];
    let identifiedName = null;

    // Google sometimes shows "Results for [person name]" or entity info
    const entityMatch = html.match(/(?:Results for|Possible related search)[:\s]*<[^>]*>([^<]+)/i);
    if (entityMatch) identifiedName = entityMatch[1].trim();

    // Try knowledge panel name
    const kpMatch = html.match(/data-attrid="title"[^>]*>([^<]+)/i);
    if (kpMatch && !identifiedName) identifiedName = kpMatch[1].trim();

    // Extract search result links
    const resultRegex = /<a[^>]+href="(https?:\/\/(?!www\.google\.)[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = resultRegex.exec(html)) !== null) {
      const href = match[1];
      const text = match[2].replace(/<[^>]*>/g, "").trim();
      if (text && href && !href.includes("google.com/") && !results.some(r => r.url === href)) {
        results.push({
          title: text.slice(0, 200),
          url: href,
          thumbnail: "",
          source_engine: "google",
          platform: detectPlatform(href),
        });
      }
    }

    // Extract image results
    const imgResultRegex = /\["(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)",\s*(\d+),\s*(\d+)\]/gi;
    while ((match = imgResultRegex.exec(html)) !== null) {
      const imgUrl = match[1];
      if (!imgUrl.includes("gstatic.com") && !imgUrl.includes("google.com")) {
        results.push({
          title: "Image match",
          url: imgUrl,
          thumbnail: imgUrl,
          image_url: imgUrl,
          source_engine: "google",
          platform: detectPlatform(imgUrl),
        });
      }
    }

    return {
      engine: "google",
      status: "ok",
      results_url: response.finalUrl,
      identified_name: identifiedName,
      matches: results.slice(0, 30),
    };
  } catch (err) {
    return { engine: "google", status: "error", error: err.message, matches: [] };
  }
}

// ── TinEye scan ─────────────────────────────────────────────────────────

async function tineyeFaceScan(buffer, filename, contentType) {
  try {
    const { boundary, body } = buildMultipart({}, "image", buffer, filename, contentType);

    const response = await chainRequest("https://tineye.com/search", {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length.toString(),
      },
      body: body,
      timeout: 25000,
    });

    const html = response.body;
    const results = [];

    // Extract TinEye match results
    const matchRegex = /<a[^>]+class="[^"]*match-link[^"]*"[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = matchRegex.exec(html)) !== null) {
      results.push({
        title: match[2].replace(/<[^>]*>/g, "").trim() || "TinEye match",
        url: match[1],
        thumbnail: "",
        source_engine: "tineye",
        platform: detectPlatform(match[1]),
      });
    }

    // Extract from other patterns
    const linkRegex = /<p[^>]*class="[^"]*match[^"]*"[^>]*>[\s\S]*?<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>/gi;
    while ((match = linkRegex.exec(html)) !== null) {
      if (!results.some(r => r.url === match[1])) {
        results.push({
          title: "TinEye match",
          url: match[1],
          thumbnail: "",
          source_engine: "tineye",
          platform: detectPlatform(match[1]),
        });
      }
    }

    // Count total matches
    const countMatch = html.match(/(\d+)\s*(?:results?|matches?)/i);

    return {
      engine: "tineye",
      status: "ok",
      results_url: response.finalUrl,
      total_matches: countMatch ? parseInt(countMatch[1]) : results.length,
      matches: results.slice(0, 20),
    };
  } catch (err) {
    return { engine: "tineye", status: "error", error: err.message, matches: [] };
  }
}

// ── Site-scoped face search (Google image search restricted to specific site) ──

async function siteSpecificImageSearch(buffer, filename, contentType, siteDomain) {
  try {
    // Submit image to Google with site restriction
    const { boundary, body } = buildMultipart(
      { image_url: "", sbisrc: "cr_1" }, "encoded_image", buffer, filename, contentType
    );

    // First get the search token/redirect
    const submitResp = await chainRequest("https://www.google.com/searchbyimage/upload", {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length.toString(),
      },
      body: body,
      timeout: 20000,
    });

    // Now add site: filter to the search
    const finalUrl = submitResp.finalUrl;
    if (finalUrl && finalUrl.includes("google.com")) {
      const siteUrl = finalUrl + (finalUrl.includes("?") ? "&" : "?") + "as_sitesearch=" + encodeURIComponent(siteDomain);
      const siteResp = await chainRequest(siteUrl, { timeout: 15000 });
      const html = siteResp.body;
      const results = [];

      const linkRegex = /<a[^>]+href="(https?:\/\/(?:www\.)?[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = linkRegex.exec(html)) !== null) {
        const href = match[1];
        if (href.includes(siteDomain) && !results.some(r => r.url === href)) {
          results.push({
            title: match[2].replace(/<[^>]*>/g, "").trim().slice(0, 200),
            url: href,
            source_engine: "google-site",
            platform: detectPlatform(href),
          });
        }
      }
      return results.slice(0, 5);
    }
    return [];
  } catch { return []; }
}

// ── DuckDuckGo name search scoped to social media sites ──

async function searchPersonOnSocial(name) {
  if (!name) return [];
  const sites = [
    "instagram.com", "twitter.com", "facebook.com", "linkedin.com",
    "tiktok.com", "youtube.com", "pinterest.com", "reddit.com",
  ];
  const allResults = [];

  // Search DuckDuckGo for the person's name on social media
  for (const site of sites) {
    try {
      const query = `"${name}" site:${site}`;
      const webResults = await scrapeWebSearch(query);
      for (const r of webResults.slice(0, 3)) {
        allResults.push({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          source_engine: "ddg-social",
          platform: detectPlatform(r.url),
        });
      }
    } catch {}
  }
  return allResults;
}

// ══════════════════════════════════════════════════════════════════════════
//  FACE SCAN API ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════

// Image proxy — allows displaying external images without CORS issues
app.get("/api/proxy-image", (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith("http")) return res.status(400).send("Invalid URL");

  try {
    const parsed = new URL(url);
    const driver = parsed.protocol === "https:" ? https : http;

    const proxyReq = driver.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "image/*,*/*;q=0.8",
        "Referer": parsed.origin,
      },
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        // Follow one redirect for images
        const loc = proxyRes.headers.location.startsWith("/")
          ? parsed.protocol + "//" + parsed.hostname + proxyRes.headers.location
          : proxyRes.headers.location;
        proxyRes.resume();
        try {
          const rParsed = new URL(loc);
          const rDriver = rParsed.protocol === "https:" ? https : http;
          rDriver.get(loc, { headers: { "User-Agent": "Mozilla/5.0" } }, (rRes) => {
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

// Upload endpoint
app.post("/api/upload", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image uploaded" });
  res.json({
    filename: req.file.filename,
    url: `/uploads/${req.file.filename}`,
    size: req.file.size,
    mimetype: req.file.mimetype,
  });
});

// ── Full face scan endpoint (SSE streaming) ─────────────────────────────

app.post("/api/face-scan", async (req, res) => {
  const { imageData } = req.body;
  if (!imageData) return res.status(400).json({ error: "imageData required" });

  const matches = imageData.match(/^data:image\/(.*?);base64,(.*)$/);
  if (!matches) return res.status(400).json({ error: "Invalid image data" });

  const ext = matches[1] === "jpeg" ? "jpg" : matches[1];
  const buffer = Buffer.from(matches[2], "base64");
  const filename = `face_${Date.now()}.${ext}`;
  const contentType = `image/${matches[1]}`;

  // SSE streaming
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  function send(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  let identifiedName = null;
  const allMatches = [];

  // Phase 1: Submit to all reverse image search engines in parallel
  send("phase", { phase: 1, label: "Submitting face to Google, Yandex, TinEye..." });

  const [yandexResult, googleResult, tineyeResult] = await Promise.allSettled([
    yandexFaceScan(buffer, filename, contentType),
    googleFaceScan(buffer, filename, contentType),
    tineyeFaceScan(buffer, filename, contentType),
  ]);

  // Process Yandex results
  if (yandexResult.status === "fulfilled" && yandexResult.value.status === "ok") {
    const yr = yandexResult.value;
    if (yr.identified_name) identifiedName = yr.identified_name;
    send("engine_result", {
      engine: "yandex", status: "ok",
      results_url: yr.results_url,
      identified_name: yr.identified_name,
      match_count: yr.matches.length,
    });
    allMatches.push(...yr.matches);
  } else {
    send("engine_result", {
      engine: "yandex", status: "error",
      error: yandexResult.value?.error || "Failed",
    });
  }

  // Process Google results
  if (googleResult.status === "fulfilled" && googleResult.value.status === "ok") {
    const gr = googleResult.value;
    if (gr.identified_name && !identifiedName) identifiedName = gr.identified_name;
    send("engine_result", {
      engine: "google", status: "ok",
      results_url: gr.results_url,
      identified_name: gr.identified_name,
      match_count: gr.matches.length,
    });
    allMatches.push(...gr.matches);
  } else {
    send("engine_result", {
      engine: "google", status: "error",
      error: googleResult.value?.error || "Failed",
    });
  }

  // Process TinEye results
  if (tineyeResult.status === "fulfilled" && tineyeResult.value.status === "ok") {
    const tr = tineyeResult.value;
    send("engine_result", {
      engine: "tineye", status: "ok",
      results_url: tr.results_url,
      total_matches: tr.total_matches,
      match_count: tr.matches.length,
    });
    allMatches.push(...tr.matches);
  } else {
    send("engine_result", {
      engine: "tineye", status: "error",
      error: tineyeResult.value?.error || "Failed",
    });
  }

  // Phase 2: If name identified, search social media for that person
  if (identifiedName) {
    send("phase", { phase: 2, label: `Identified: "${identifiedName}" — searching social media...` });
    send("identified", { name: identifiedName });

    const socialResults = await searchPersonOnSocial(identifiedName);
    if (socialResults.length) {
      allMatches.push(...socialResults);
      send("social_results", { results: socialResults });
    }
  } else {
    send("phase", { phase: 2, label: "Searching social media platforms with face image..." });
  }

  // Phase 3: Site-specific reverse image searches on key social platforms
  send("phase", { phase: 3, label: "Scanning Instagram, Facebook, Twitter, LinkedIn..." });

  const socialSites = ["instagram.com", "twitter.com", "facebook.com", "linkedin.com", "tiktok.com"];
  const siteResults = await Promise.allSettled(
    socialSites.map(site => siteSpecificImageSearch(buffer, filename, contentType, site))
  );

  for (const sr of siteResults) {
    if (sr.status === "fulfilled" && sr.value.length) {
      allMatches.push(...sr.value);
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  const deduped = [];
  for (const m of allMatches) {
    const key = (m.url || "").split("?")[0].split("#")[0].toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      deduped.push(m);
    }
  }

  // Group by platform
  const socialMediaMatches = deduped.filter(m => m.platform);
  const otherMatches = deduped.filter(m => !m.platform);

  // Group social by platform name
  const byPlatform = {};
  for (const m of socialMediaMatches) {
    if (!byPlatform[m.platform]) byPlatform[m.platform] = [];
    byPlatform[m.platform].push(m);
  }

  send("complete", {
    identified_name: identifiedName,
    total_matches: deduped.length,
    social_media: byPlatform,
    other_matches: otherMatches.slice(0, 20),
    engines: {
      yandex: yandexResult.status === "fulfilled" ? yandexResult.value.results_url : null,
      google: googleResult.status === "fulfilled" ? googleResult.value.results_url : null,
      tineye: tineyeResult.status === "fulfilled" ? tineyeResult.value.results_url : null,
    },
  });

  res.end();
});

// ── Simple reverse search (for full image, non-face) ────────────────────

app.post("/api/reverse-search", async (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: "filename required" });

  const filePath = path.join(UPLOADS_DIR, path.basename(filename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });

  const fileBuffer = fs.readFileSync(filePath);
  const ext = path.extname(filename).toLowerCase();
  const mimeMap = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };
  const contentType = mimeMap[ext] || "image/jpeg";

  const [yr, gr, tr] = await Promise.allSettled([
    yandexFaceScan(fileBuffer, filename, contentType),
    googleFaceScan(fileBuffer, filename, contentType),
    tineyeFaceScan(fileBuffer, filename, contentType),
  ]);

  const results = [];
  for (const r of [yr, gr, tr]) {
    if (r.status === "fulfilled") results.push(r.value);
  }

  res.json({ results });
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
  console.log(`Face scanning pipeline active — scans Google, Yandex, TinEye + social media`);
});
