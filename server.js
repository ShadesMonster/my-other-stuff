const express = require("express");
const https = require("https");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Helper: make an HTTPS GET request and return JSON
function fetchJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const reqOpts = {
      hostname: opts.hostname,
      path: opts.pathname + opts.search,
      method: "GET",
      headers: {
        "User-Agent": "PersonLookup-Educational/1.0",
        Accept: "application/json",
        ...headers,
      },
    };
    const req = https.request(reqOpts, (res) => {
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

// Helper: make an HTTPS GET and return raw text
function fetchText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const reqOpts = {
      hostname: opts.hostname,
      path: opts.pathname + opts.search,
      method: "GET",
      headers: {
        "User-Agent": "PersonLookup-Educational/1.0",
        ...headers,
      },
    };
    const req = https.request(reqOpts, (res) => {
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

// ── Lookup modules ──────────────────────────────────────────────────────

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
    // Gravatar profiles by hash or username
    const crypto = require("crypto");
    const hash = query.includes("@")
      ? crypto.createHash("md5").update(query.trim().toLowerCase()).digest("hex")
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
  // If it looks like a domain, look up DNS records
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
      return { source: platform, icon: platform.toLowerCase(), profile_url: url, exists: true };
    }
    return null;
  } catch {
    return null;
  }
}

async function lookupUsernameAvailability(username) {
  const checks = [
    { platform: "GitLab", url: `https://gitlab.com/${encodeURIComponent(username)}` },
    { platform: "Keybase", url: `https://keybase.io/${encodeURIComponent(username)}` },
  ];

  const results = await Promise.allSettled(
    checks.map((c) => checkPlatformExists(username, c.platform, c.url))
  );

  return results
    .filter((r) => r.status === "fulfilled" && r.value !== null)
    .map((r) => r.value);
}

// ── Main lookup endpoint ────────────────────────────────────────────────

app.post("/api/lookup", async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return res.status(400).json({ error: "Query is required" });
  }

  const sanitized = query.trim().slice(0, 100);
  const isLikelyUsername = !/\s/.test(sanitized);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sanitized);

  const tasks = [];

  // Always search Wikipedia by name
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
    // Search by name
    tasks.push(lookupGitHubByName(sanitized));
    tasks.push(lookupStackOverflow(sanitized));
  }

  const settled = await Promise.allSettled(tasks);
  const results = [];
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value !== null) {
      if (Array.isArray(r.value)) {
        results.push(...r.value);
      } else {
        results.push(r.value);
      }
    }
  }

  res.json({ query: sanitized, results, count: results.length });
});

app.listen(PORT, () => {
  console.log(`Person Lookup running at http://localhost:${PORT}`);
});
