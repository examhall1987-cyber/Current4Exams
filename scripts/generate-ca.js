// ─────────────────────────────────────────────────────────────────
//  generate-ca.js  —  Current4Exams Daily CA Generator v3.0
//
//  FIXES in v3.0:
//    1. PIB/MEA/ISRO 403 → fetch via allorigins.win CORS proxy
//    2. Groq 429 rate limit → shortened prompts + retry with backoff
//    3. Firestore 403 → documented fix in README (rules must allow write)
//
//  PIPELINE:
//    1. Fetch RSS via proxy (bypasses 403 blocks)
//    2. Filter recent headlines per category
//    3. Send SHORT prompt to Groq (stays under 12k TPM)
//    4. Retry on 429 with exponential backoff
//    5. Push to Firestore REST API
// ─────────────────────────────────────────────────────────────────

import fetch from 'node-fetch';

const GROQ_API_KEY     = process.env.GROQ_API_KEY;
const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT_ID || 'current4exams';
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;

const targetDate  = process.env.DATE_OVERRIDE ? new Date(process.env.DATE_OVERRIDE) : new Date();
const dateStr     = targetDate.toISOString().split('T')[0];
const dateDisplay = targetDate.toLocaleDateString('en-IN', {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
});

// ─────────────────────────────────────────────────────────────────
//  RSS FEEDS — fetched via allorigins.win proxy to bypass 403
//  allorigins is a free CORS proxy that works from GitHub Actions
// ─────────────────────────────────────────────────────────────────
const RSS_FEEDS = [
  // PIB topic-wise RSS (blocked directly → use proxy)
  { key: 'pib_main',    url: 'https://pib.gov.in/Rss.aspx',                               label: 'PIB' },
  { key: 'pib_fin',     url: 'https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=38',   label: 'PIB Finance' },
  { key: 'pib_def',     url: 'https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=16',   label: 'PIB Defence' },
  { key: 'pib_env',     url: 'https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=34',   label: 'PIB Environment' },
  { key: 'pib_spo',     url: 'https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=57',   label: 'PIB Sports' },
  { key: 'pib_cul',     url: 'https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=29',   label: 'PIB Culture' },
  { key: 'pib_sci',     url: 'https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3',    label: 'PIB Science' },
  // RBI press releases
  { key: 'rbi',         url: 'https://www.rbi.org.in/Scripts/rss.aspx',                   label: 'RBI' },
  // MEA India
  { key: 'mea',         url: 'https://www.mea.gov.in/rss/press-releases.xml',             label: 'MEA India' },
  // ISRO
  { key: 'isro',        url: 'https://www.isro.gov.in/rss.xml',                           label: 'ISRO' },
  // UN News — these work directly (no 403)
  { key: 'un_global',   url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml',    label: 'UN News', direct: true },
  { key: 'un_asia',     url: 'https://news.un.org/feed/subscribe/en/news/region/asia-pacific/rss.xml', label: 'UN Asia', direct: true },
];

// Which feeds each category watches
const CAT_FEEDS = {
  'government-schemes':   ['pib_main', 'pib_fin'],
  'economy-banking':      ['rbi', 'pib_fin'],
  'defence':              ['pib_def', 'pib_main'],
  'reports-indices':      ['pib_main', 'un_global'],
  'environment':          ['pib_env', 'un_global'],
  'awards-honours':       ['pib_main', 'pib_cul'],
  'places-in-news':       ['pib_main', 'mea', 'un_global'],
  'important-days':       ['un_global', 'un_asia', 'pib_main'],
  'sports':               ['pib_spo', 'pib_main'],
  'science-technology':   ['isro', 'pib_sci', 'pib_main'],
  'summits-conferences':  ['mea', 'pib_main', 'un_global'],
  'international':        ['mea', 'un_global', 'pib_main'],
  'art-culture':          ['pib_cul', 'pib_main'],
  'up-schemes':           ['pib_main'],
  'up-infrastructure':    ['pib_main'],
  'bihar-schemes':        ['pib_main'],
  'bihar-infrastructure': ['pib_main'],
};

// ─────────────────────────────────────────────────────────────────
//  CATEGORY CONFIG — compact version (pick/skip + format per exam)
// ─────────────────────────────────────────────────────────────────
const CATEGORIES = [
  {
    id: 'government-schemes', label: 'Government Schemes', states: ['all'],
    pick: 'New schemes, scheme modifications, funding pattern, ministries, beneficiaries, SDG linkage',
    skip: 'Minister speeches, inauguration ceremonies, political statements',
    upscFormat: 'Scheme Name | Ministry | Objective | Key Features | Funding Pattern | Beneficiaries | Significance | Challenges | Way Forward',
    sscFormat:  'Scheme Name → Ministry → Launch Year → Beneficiary → Key Feature',
    keyFields:  ['Scheme Name', 'Nodal Ministry', 'Target Beneficiaries', 'Funding Pattern'],
    examTags:   ['upsc','uppcs','bpsc','ssc','upsssc'],
  },
  {
    id: 'economy-banking', label: 'Economy & Banking', states: ['all'],
    pick: 'Repo rate, CRR, SLR, inflation (CPI/WPI), GDP, fiscal deficit, budget, banking reforms, RBI MPC decisions',
    skip: 'Stock market daily movement, IPO news, corporate profits, company mergers',
    upscFormat: 'Topic | Meaning | Current Data | Causes | Impact (Economy/Society/Poor) | RBI Measures | Challenges | Way Forward',
    sscFormat:  'Rate/Term → Current Value → Change → Significance',
    keyFields:  ['Rate / Indicator', 'Current Value', 'Previous Value', 'Released By'],
    examTags:   ['upsc','uppcs','bpsc','ssc','bank','upsssc'],
  },
  {
    id: 'defence', label: 'Defence', states: ['all'],
    pick: 'Military exercises (name, countries, venue), missile systems, defence indigenisation, defence corridor, maritime security, appointments of chiefs',
    skip: 'Ceremonial visits, technical weapon specs, routine training',
    upscFormat: 'Exercise/System | Countries | Venue | Strategic Importance | Indigenisation angle',
    sscFormat:  'Exercise Name → Countries → Venue → Purpose',
    keyFields:  ['Exercise / System Name', 'Countries Involved', 'Venue', 'Significance'],
    examTags:   ['upsc','uppcs','ssc','upsssc','bpsc'],
  },
  {
    id: 'reports-indices', label: 'Reports & Indices', states: ['all'],
    pick: "Report name, publishing org, India's rank (current + previous), top country, theme, state-wise rankings",
    skip: 'Full report methodology, statistical annexures, country-by-country tables',
    upscFormat: "Report | Released By | India's Rank | Top Country | Theme | Why rank changed | Policy implications",
    sscFormat:  "Report → Released By → India's Rank → Top Country → Theme",
    keyFields:  ['Report Name', 'Released By', "India's Rank", 'Top Country / State'],
    examTags:   ['upsc','uppcs','bpsc','ssc','upsssc'],
  },
  {
    id: 'environment', label: 'Environment & Biodiversity', states: ['all'],
    pick: 'New Ramsar sites, tiger reserves, national parks, COP outcomes, endangered species (IUCN status), forest cover data, climate targets',
    skip: 'Full climate science papers, technical jargon, routine monitoring data',
    upscFormat: 'Topic | Convention linkage | India commitment | Site/Species details | Challenges | Way Forward',
    sscFormat:  'NP/Reserve → State → Nearby River → Species → Why in news',
    keyFields:  ['Site / Species Name', 'Location / State', 'Category', 'Governing Body'],
    examTags:   ['upsc','uppcs','bpsc','ssc','upsssc'],
  },
  {
    id: 'awards-honours', label: 'Awards & Honours', states: ['all'],
    pick: 'Padma awards, Bharat Ratna, Nobel Prize, sports awards (Arjuna/Khel Ratna), national appointments, international awards to Indians',
    skip: 'Full biographies, acceptance speeches, celebrity film awards, local awards',
    upscFormat: 'Award | Recipient | Field | Awarded By | Year | Historical significance | First recipient',
    sscFormat:  'Award → Recipient → Field → Year',
    keyFields:  ['Award Name', 'Recipient', 'Field / Category', 'Awarded By'],
    examTags:   ['upsc','uppcs','bpsc','ssc','upsssc'],
  },
  {
    id: 'places-in-news', label: 'Places in News', states: ['all'],
    pick: 'Location (state/country), bordering regions, nearby river/mountain, why in news, geopolitical/strategic importance',
    skip: 'Travel content, real estate news, local municipal issues',
    upscFormat: 'Place | State/Country | Bordering regions | Nearby river/mountain | Why in news | Geopolitical significance',
    sscFormat:  'Place → State/Country → Bordering → Why in news',
    keyFields:  ['Place Name', 'State / Country', 'Bordering Region', 'Nearby River / Mountain'],
    examTags:   ['upsc','uppcs','bpsc','ssc','upsssc'],
  },
  {
    id: 'important-days', label: 'Important Days & Events', states: ['all'],
    pick: 'Date of observance, annual theme (exact wording), organising body, year first observed',
    skip: 'Full historical essays, ceremonial programme details, local events',
    upscFormat: 'Day Name | Date | Theme | Organising Body | First Observed | India policy angle',
    sscFormat:  'Day → Date → Theme → Organised By',
    keyFields:  ['Day / Event Name', 'Date', 'Theme (Current Year)', 'Organised By'],
    examTags:   ['upsc','uppcs','bpsc','ssc','upsssc'],
  },
  {
    id: 'sports', label: 'Sports', states: ['all'],
    pick: "Tournament winners, host country/city, venues, mascots, India's rank/medals, Khelo India events, sports awards",
    skip: 'Match scorecards, player transfers, daily tournament updates, opinions',
    upscFormat: 'Event | Winner | Host/Venue | India Position | Sports policy/Khelo India linkage',
    sscFormat:  'Tournament → Winner → Host/Venue → India medals → Mascot',
    keyFields:  ['Event Name', 'Winner / Champion', 'Host / Venue', "India's Position"],
    examTags:   ['uppcs','bpsc','ssc','upsssc'],
  },
  {
    id: 'science-technology', label: 'Science & Technology', states: ['all'],
    pick: 'ISRO missions (name/vehicle/payload), AI governance, quantum computing, semiconductor mission, Nobel in science, DST/CSIR breakthroughs',
    skip: 'Programming tutorials, deep technical specs, startup gossip, consumer product launches',
    upscFormat: 'Mission/Tech | Developed By | Purpose | Launch Vehicle | AI/semiconductor policy angle | India global position',
    sscFormat:  'Mission → Agency → Launch Vehicle → Purpose → Orbit/Target',
    keyFields:  ['Mission / Technology', 'Developed By', 'Purpose', 'Launch Vehicle / Platform'],
    examTags:   ['upsc','uppcs','bpsc','ssc','upsssc'],
  },
  {
    id: 'summits-conferences', label: 'Summits & Conferences', states: ['all'],
    pick: 'Summit name, host city, theme (exact wording), key outcomes, India commitments, participating countries/members',
    skip: 'Full declaration texts, procedural details, individual speeches',
    upscFormat: 'Summit | Host/Venue | Theme | Countries | Key Outcomes | India commitments | Strategic significance',
    sscFormat:  'Summit → Host/Venue → Theme → Member count',
    keyFields:  ['Summit Name', 'Host / Venue', 'Theme', 'Key Outcome'],
    examTags:   ['upsc','uppcs','bpsc','ssc','upsssc'],
  },
  {
    id: 'international', label: 'International Affairs', states: ['all'],
    pick: "Bilateral MoUs/agreements with India, strategic partnerships, international org (HQ/members), treaties signed, India's UNSC positions",
    skip: 'Daily political commentary, ideological debates, internal politics of countries',
    upscFormat: 'Countries/Orgs | Nature of Event | India significance | Related Treaty/Body | Historical context | Challenges',
    sscFormat:  'Organization → HQ → Members → India role',
    keyFields:  ['Countries / Orgs Involved', 'Nature of Event', 'India Significance', 'Related Treaty / Body'],
    examTags:   ['upsc','uppcs','bpsc','ssc'],
  },
  {
    id: 'art-culture', label: 'Art & Culture', states: ['all'],
    pick: 'UNESCO heritage listings, GI tags granted, classical dances/music, architecture/monuments, Sahitya/Sangeet Akademi awards, Buddhist/Jain heritage',
    skip: 'Bollywood news, entertainment industry, local cultural events',
    upscFormat: 'Art/Site/Festival | State/Region | UNESCO/GI Status | Historical period | Ministry linkage | Significance',
    sscFormat:  'Folk dance/Festival/Monument → State → Significance',
    keyFields:  ['Art Form / Site / Festival', 'State / Region', 'UNESCO / GI Status', 'Associated Body'],
    examTags:   ['upsc','uppcs','bpsc','ssc','upsssc'],
  },
  {
    id: 'up-schemes', label: 'UP Govt. Schemes', states: ['uppcs'],
    pick: 'UP government schemes, budget allocations, beneficiary counts, nodal department, UP-specific welfare',
    skip: 'Political speeches, tenders, routine inaugurations',
    upscFormat: 'Scheme | Launched By/Year | Department | Beneficiaries | Budget | Objectives | UP significance',
    sscFormat:  'Scheme → Department → Beneficiary → Key Feature',
    keyFields:  ['Scheme Name', 'Launched By / Year', 'Target Beneficiaries', 'Nodal Department'],
    examTags:   ['uppcs','upsssc'],
  },
  {
    id: 'up-infrastructure', label: 'UP Infrastructure', states: ['uppcs'],
    pick: 'Expressways (name/length/districts), UP airports, metro rail projects, UP Defence Corridor, smart cities, industrial corridors',
    skip: 'Tenders, technical specs, maintenance news',
    upscFormat: 'Project | Districts | Length/Capacity | Investment | Status | Strategic significance',
    sscFormat:  'Project → Districts → Length → Status',
    keyFields:  ['Project Name', 'Location / Districts', 'Length / Capacity', 'Completion Status'],
    examTags:   ['uppcs','upsssc'],
  },
  {
    id: 'bihar-schemes', label: 'Bihar Govt. Schemes', states: ['bpsc'],
    pick: 'Bihar state welfare schemes, budget allocations, beneficiaries (women/youth/farmers), social sector milestones',
    skip: 'Political commentary, tenders, inauguration-only news',
    upscFormat: 'Scheme | Launched By/Year | Department | Beneficiaries | Budget | Objectives',
    sscFormat:  'Scheme → Department → Beneficiary → Key Feature',
    keyFields:  ['Scheme Name', 'Launched By / Year', 'Target Beneficiaries', 'Nodal Department'],
    examTags:   ['bpsc'],
  },
  {
    id: 'bihar-infrastructure', label: 'Bihar Infrastructure', states: ['bpsc'],
    pick: 'Roads/bridges (NH, Ganga bridges), BIADA industrial zones, smart cities (Patna/Gaya/Bhagalpur), airports, BSRDCL milestones',
    skip: 'Contract/tender details, technical specs, routine maintenance',
    upscFormat: 'Project | Districts | Investment | Status | Bihar economy significance',
    sscFormat:  'Project → Location → Status',
    keyFields:  ['Project Name', 'Location / Districts', 'Investment', 'Completion Status'],
    examTags:   ['bpsc'],
  },
];

// ─────────────────────────────────────────────────────────────────
//  RSS FETCH via allorigins.win proxy (bypasses PIB/MEA 403 block)
// ─────────────────────────────────────────────────────────────────
async function fetchFeed({ key, url, label, direct }) {
  const fetchUrl = direct
    ? url
    : `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;

  try {
    const res = await fetch(fetchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Current4ExamsBot/3.0)' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    let xml;
    if (direct) {
      xml = await res.text();
    } else {
      const json = await res.json();
      xml = json.contents || '';
      if (!xml) throw new Error('Empty proxy response');
    }

    const items = parseRSS(xml, label, key);
    console.log(`  ✅ ${label}: ${items.length} items`);
    return items;
  } catch(e) {
    console.warn(`  ⚠️  ${label}: ${e.message}`);
    return [];
  }
}

function parseRSS(xml, label, feedKey) {
  const items = [];
  const re = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const title = clean(get(block, 'title'));
    const desc  = clean(get(block, 'description')).slice(0, 200);
    const date  = get(block, 'pubDate') || get(block, 'dc:date') || '';
    if (title && title.length > 5) items.push({ title, desc, date, source: label, feedKey });
  }
  return items;
}

function get(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function clean(s) {
  return s.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<')
    .replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
}

function isRecent(d) {
  if (!d) return true;
  try { return Date.now() - new Date(d).getTime() < 48*3600*1000; }
  catch { return true; }
}

// ─────────────────────────────────────────────────────────────────
//  GROQ CALL with exponential backoff retry on 429
// ─────────────────────────────────────────────────────────────────
async function callGroq(prompt, attempt = 0) {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        temperature: 0.3,
        max_tokens: 2000,          // reduced from 3500 → stays under TPM limit
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (res.status === 429) {
      // Parse "try again in Xs" from error message
      const errText = await res.text();
      const waitMatch = errText.match(/try again in ([\d.]+)s/i);
      const waitSecs = waitMatch ? Math.ceil(parseFloat(waitMatch[1])) + 2 : (10 * (attempt + 1));
      console.log(`  ⏳ Groq rate limit — waiting ${waitSecs}s (attempt ${attempt+1})`);
      await sleep(waitSecs * 1000);
      if (attempt < 4) return callGroq(prompt, attempt + 1);
      throw new Error('Groq rate limit after 4 retries');
    }

    if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
    const d = await res.json();
    return d.choices[0].message.content.trim();
  } catch(e) {
    if (e.message.includes('rate limit') && attempt < 4) {
      await sleep(15000 * (attempt + 1));
      return callGroq(prompt, attempt + 1);
    }
    throw e;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────
//  GENERATE — SHORT PROMPT to stay under 12k TPM
// ─────────────────────────────────────────────────────────────────
async function generateForCategory(cat, allHeadlines) {
  const feeds = CAT_FEEDS[cat.id] || ['pib_main'];
  const headlines = allHeadlines
    .filter(h => feeds.includes(h.feedKey) && isRecent(h.date))
    .slice(0, 8);  // max 8 headlines per category to keep prompt short

  const hlText = headlines.length
    ? headlines.map((h,i) => `${i+1}. [${h.source}] ${h.title}`).join('\n')
    : `No live feed. Use knowledge for most important recent ${cat.label} topic as of ${dateStr}.`;

  // SHORT focused prompt — key to staying under TPM
  const prompt = `You write current affairs for Indian competitive exams (UPSC/UPPCS/BPSC/SSC/UPSSSC).
Date: ${dateDisplay} | Category: ${cat.label}

HEADLINES:
${hlText}

PICK: ${cat.pick}
SKIP: ${cat.skip}

Select 2 most exam-relevant topics. For each return JSON:
{
  "title": "specific headline with real name/number",
  "summary": "2-3 sentences with specific facts, numbers, names",
  "body": "<p>HTML article 200+ words. Sections: What Happened → Background → Key Facts → Exam Angle</p>",
  "category": "${cat.id}",
  "states": ${JSON.stringify(cat.states)},
  "source": "source name",
  "importance": "high|medium|low",
  "relevance": "Prelims + Mains|Prelims only|Tier 1 + Tier 2",
  "examNote": "specific exam+paper+section tip",
  "examTags": ${JSON.stringify(cat.examTags)},
  "keyFacts": [
    {"key":"${cat.keyFields[0]}","value":"specific value"},
    {"key":"${cat.keyFields[1]}","value":"specific value"},
    {"key":"${cat.keyFields[2]}","value":"specific value"},
    {"key":"${cat.keyFields[3] || 'Significance'}","value":"specific value"}
  ],
  "sscOneLiner": "${cat.sscFormat.replace(/\|/g,'→')} — fill with real values",
  "upscAngle": "2-sentence analytical angle for UPSC/UPPCS"
}

UPSC/UPPCS format: ${cat.upscFormat}
SSC/UPSSSC format: ${cat.sscFormat}

Rules: keyFacts = specific (real names/numbers, not vague). No hallucinated stats.
Return ONLY a JSON array of 2 objects. No markdown, no explanation.`;

  let raw = await callGroq(prompt);
  raw = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();
  if (raw.startsWith('{')) raw = '[' + raw + ']';

  try {
    return JSON.parse(raw);
  } catch(e) {
    const arr = raw.match(/\[[\s\S]*\]/);
    if (arr) { try { return JSON.parse(arr[0]); } catch {} }
    console.error(`  ⚠️  JSON parse failed: ${e.message} | Raw: ${raw.slice(0,200)}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────
//  FIRESTORE PUSH
// ─────────────────────────────────────────────────────────────────
function toFSVal(v) {
  if (v == null) return { nullValue: null };
  if (typeof v === 'string')  return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number' && Number.isInteger(v)) return { integerValue: String(v) };
  if (typeof v === 'number')  return { doubleValue: v };
  if (v instanceof Date)      return { timestampValue: v.toISOString() };
  if (Array.isArray(v))       return { arrayValue: { values: v.map(toFSVal) } };
  if (typeof v === 'object')  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k,x]) => [k, toFSVal(x)])) } };
  return { stringValue: String(v) };
}

async function pushToFirestore(article) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/articles?key=${FIREBASE_API_KEY}`;
  const fields = Object.fromEntries(Object.entries(article).map(([k,v]) => [k, toFSVal(v)]));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const err = await res.text();
    // Friendly message for 403
    if (res.status === 403) throw new Error(`Firestore 403 — update Firestore Rules (see README)`);
    throw new Error(`Firestore ${res.status}: ${err}`);
  }
}

// ─────────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────────
async function main() {
  if (!GROQ_API_KEY)     { console.error('❌ Missing GROQ_API_KEY');     process.exit(1); }
  if (!FIREBASE_API_KEY) { console.error('❌ Missing FIREBASE_API_KEY'); process.exit(1); }

  const catFilter = process.env.CATEGORIES_OVERRIDE
    ? process.env.CATEGORIES_OVERRIDE.split(',').map(s => s.trim())
    : null;
  const categories = catFilter ? CATEGORIES.filter(c => catFilter.includes(c.id)) : CATEGORIES;

  console.log('\n' + '═'.repeat(60));
  console.log('  Current4Exams — Daily CA Generator v3.0');
  console.log(`  Date: ${dateDisplay}`);
  console.log(`  Categories: ${categories.length}`);
  console.log('═'.repeat(60));

  // ── Fetch all feeds in parallel ────────────────────────────────
  console.log('\n🌐 Fetching RSS feeds via proxy...');
  const feedResults = await Promise.allSettled(RSS_FEEDS.map(fetchFeed));
  const allHeadlines = feedResults.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  console.log(`\n📊 Total headlines: ${allHeadlines.length}\n`);

  // ── Generate + push per category (with 6s gap between each) ───
  let published = 0, failed = 0;

  for (const cat of categories) {
    console.log(`\n⏳ ${cat.label}`);
    try {
      const articles = await generateForCategory(cat, allHeadlines);
      for (const a of articles) {
        if (!a.title || !a.summary) { console.log('  ⚠️  Skipped: missing fields'); continue; }
        a.publishedAt   = new Date(targetDate);
        a.createdAt     = new Date();
        a.autoGenerated = true;
        a.generatedDate = dateStr;
        try {
          await pushToFirestore(a);
          console.log(`  ✅ ${a.title.slice(0, 72)}`);
          published++;
        } catch(e) {
          console.error(`  ❌ Push: ${e.message}`);
          failed++;
          // If Firestore is the problem, no point continuing pushes for this category
          if (e.message.includes('403')) break;
        }
      }
    } catch(e) {
      console.error(`  ❌ ${e.message}`);
      failed++;
    }

    // 6s gap between categories → avoids Groq TPM overflow
    await sleep(6000);
  }

  console.log('\n' + '═'.repeat(60));
  console.log(`  ✨ Published: ${published}  |  Failed: ${failed}`);
  console.log('═'.repeat(60) + '\n');

  if (published === 0) {
    console.error('No articles published — check Firestore Rules (see fix below)');
    process.exit(1);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
