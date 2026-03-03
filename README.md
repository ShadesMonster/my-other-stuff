# Person Lookup - Educational OSINT Tool

An educational web application that demonstrates how publicly available information can be gathered from open APIs and client-side face detection. Works entirely in the browser — deploy on GitHub Pages with zero setup.

## Disclaimer

**This tool is for educational purposes only.** It only queries publicly available, free APIs. No private data is accessed, no scraping is performed, and no authentication is bypassed. Use responsibly and ethically. Do not use for harassment, stalking, or any malicious purpose.

## Features

### Text Search
Search by name, username, or email across public sources:

| Source | What it finds |
|---|---|
| **GitHub** | Profile, repos, bio, location, followers |
| **Reddit** | Profile, karma, account age |
| **Wikipedia** | Summary, description, article extract |
| **Stack Overflow** | Profile, reputation, badges, location |
| **Hacker News** | Profile, karma, about |
| **DNS** | Domain records (if input is a domain) |

### Image Search
Upload a photo to:
- **Detect faces** with age, gender, and expression analysis (face-api.js)
- **Extract EXIF metadata** (camera, date, dimensions, GPS)
- **Reverse image search** across 6 engines: Google, Yandex, Bing, TinEye, Baidu, KarmaDecay
- Upload via drag & drop, file picker, or Ctrl+V paste

### Face Comparison
Upload two photos to check if they contain the **same person**:
- Uses 128-dimensional face descriptors with Euclidean distance matching
- Shows similarity percentage and confidence verdict
- Threshold: < 0.60 = match, 0.60–0.75 = uncertain, > 0.75 = different

## Deploy on GitHub Pages (Easiest)

1. Push this repo to GitHub
2. Go to **Settings > Pages**
3. Set source to **Deploy from a branch**
4. Select **main** branch and **/ (root)** folder
5. Click Save — your site will be live at `https://<username>.github.io/<repo>/`

That's it. No build step, no server needed. The `index.html` at the root runs 100% in the browser.

## Run Locally (Optional)

The optional Node.js server adds server-side reverse image search proxying:

```bash
npm install
npm start
# Open http://localhost:3000
```

## How It Works

- **Text search:** Browser fetches public APIs directly (GitHub, Wikipedia, Stack Exchange, HN all support CORS)
- **Face detection:** Runs entirely client-side using [face-api.js](https://github.com/justadudewhohacks/face-api.js) (TensorFlow.js)
- **Reverse image search:** Creates hidden HTML forms and submits your image directly to search engines
- **Face comparison:** Extracts 128-dim face embeddings and computes Euclidean distance

## Tech Stack

- **Frontend:** Single-file vanilla HTML/CSS/JS — no framework, no build step
- **Face AI:** face-api.js (SSD MobileNet + face landmarks + face recognition + age/gender/expression)
- **APIs:** All free, public, no API keys required
- **Server (optional):** Node.js + Express + Multer
