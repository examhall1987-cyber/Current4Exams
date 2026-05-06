# Current4Exams

Daily current affairs portal for UPPCS & BPSC exam preparation. Topic-wise articles, vacancy listings and monthly digests.

## File structure

```
current4exams/
├── index.html              ← Public reader (homepage)
├── article.html            ← Single article full view
├── admin.html              ← Publish & manage articles
├── admin-vacancies.html    ← Manage vacancy listings
├── 404.html                ← 404 page
├── css/
│   └── style.css           ← Shared styles
└── js/
    └── firebase-config.js  ← Firebase config (edit this first)
```

---

## Setup steps

### 1. Create Firebase project
1. Go to https://console.firebase.google.com
2. Create new project → name it `current4exams`
3. Enable **Firestore Database** (start in production mode)
4. Go to Project Settings → Your apps → Add web app
5. Copy the config object

### 2. Add Firebase config
Open `js/firebase-config.js` and replace the placeholder values:
```js
const firebaseConfig = {
  apiKey:            "your-actual-api-key",
  authDomain:        "current4exams.firebaseapp.com",
  projectId:         "current4exams",
  ...
};
```
Also change `ADMIN_PASSWORD` to something strong.

### 3. Firestore rules
In Firebase Console → Firestore → Rules, set:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /articles/{doc} {
      allow read: if true;
      allow write: if false;  // writes only via Admin SDK or Console
    }
    match /vacancies/{doc} {
      allow read: if true;
      allow write: if false;
    }
    match /digests/{doc} {
      allow read: if true;
      allow write: if false;
    }
  }
}
```
(The admin.html writes directly — for production, restrict writes to authenticated users.)

### 4. Firestore indexes
Add a composite index for articles:
- Collection: `articles`
- Fields: `publishedAt` (Ascending), `category` (Ascending)

Firebase will prompt you automatically when you first load the site.

### 5. GitHub Pages
1. Create new GitHub repo: `current4exams`
2. Push all files
3. Go to repo Settings → Pages → Source: `main` branch, `/ (root)`
4. Site will be live at `https://yourusername.github.io/current4exams/`

### 6. Custom domain
1. Buy `current4exams.com` (Hostinger or any registrar)
2. In GitHub Pages settings, add custom domain: `current4exams.com`
3. In Cloudflare (new account), add the site, set DNS:
   - `A` record → GitHub Pages IPs (185.199.108.153, etc.)
   - `CNAME` www → yourusername.github.io
4. Enable HTTPS in GitHub Pages settings

---

## Firestore collections

### `articles`
| Field | Type | Notes |
|-------|------|-------|
| title | string | Article headline |
| summary | string | 2–3 line card summary |
| body | string | Full HTML body |
| category | string | e.g. `current-affairs`, `defence` |
| states | array | `["all"]` or `["uppcs","bpsc"]` |
| source | string | e.g. PIB, The Hindu |
| importance | string | `high` / `medium` / `low` |
| relevance | string | e.g. `Prelims + Mains` |
| examNote | string | Exam angle note |
| keyFacts | array | `[{key, value}]` |
| publishedAt | timestamp | Display date |
| createdAt | timestamp | Auto |

### `vacancies`
| Field | Type | Notes |
|-------|------|-------|
| title | string | Exam name |
| posts | string | Number of posts |
| state | string | `uppcs` / `bpsc` / `up` / `bihar` |
| deadline | timestamp | Application closing date |
| deadlineLabel | string | Fallback text if no date |
| link | string | Official URL |
| notes | string | Extra info |

### `digests`
| Field | Type | Notes |
|-------|------|-------|
| label | string | e.g. `April 2025` |
| month | string | e.g. `2025-04` (for sorting) |
| url | string | PDF download URL |

---

## Admin usage

1. Open `admin.html` in browser
2. Enter admin password (set in `firebase-config.js`)
3. Fill form → Publish article
4. Open `admin-vacancies.html` to add vacancy listings
