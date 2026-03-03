# Person Lookup - Educational OSINT Tool

An educational web application that demonstrates how publicly available information can be gathered from open APIs. Enter a name, username, or email and see what public data exists across various platforms.

## Disclaimer

**This tool is for educational purposes only.** It only queries publicly available, free APIs. No private data is accessed, no scraping is performed, and no authentication is bypassed. Use responsibly and ethically. Do not use for harassment, stalking, or any malicious purpose.

## Features

Searches across these public sources:

| Source | What it finds |
|---|---|
| **GitHub** | Profile, repos, bio, location, followers |
| **Reddit** | Profile, karma, account age |
| **Wikipedia** | Summary, description, article extract |
| **Stack Overflow** | Profile, reputation, badges, location |
| **Hacker News** | Profile, karma, about |
| **Gravatar** | Profile, avatar, linked URLs |
| **GitLab** | Profile existence check |
| **Keybase** | Profile existence check |
| **DNS** | Domain records (if input is a domain) |

## Getting Started

```bash
# Install dependencies
npm install

# Start the server
npm start
```

Then open http://localhost:3000 in your browser.

## How It Works

1. You enter a name, username, or email
2. The server queries multiple public REST APIs concurrently
3. Results are aggregated and displayed as cards in the UI
4. All requests go through the server (no direct client-side API calls)

## Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** Vanilla HTML/CSS/JS (no framework, no build step)
- **APIs:** All free, public, no API keys required
