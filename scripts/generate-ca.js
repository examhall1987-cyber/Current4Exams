// ─────────────────────────────────────────────────────────────────
//  generate-ca.js  —  Current4Exams Daily CA Generator
//
//  PIPELINE:
//    1. Fetch real RSS / XML feeds from official authoritative sources
//    2. Filter headlines using category-specific pick/skip rules
//    3. Send filtered headlines to Groq (LLaMA 3.3 70B)
//    4. AI generates exam-wise formatted articles
//       (UPSC analytical depth + SSC one-liners in same article)
//    5. Push articles to Firestore via REST API
//
//  SOURCES (public RSS/XML only — no login, no scraping):
//    PIB (topic-wise RSS)   → Schemes, Defence, Finance, Sports, Culture, Environment
//    RBI                    → Economy & Banking
//    MEA India              → International, Summits
//    ISRO                   → Science & Technology
//    UN News                → Important Days, International, Summits, Environment
//    UP/Bihar Govt          → No public RSS; covered via PIB + AI knowledge
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
//  RSS FEED REGISTRY
//  Only feeds that are public, stable, and accessible from GitHub Actions
// ─────────────────────────────────────────────────────────────────
const RSS_FEEDS = {
  // PIB — Ministry-wise topic RSS feeds
  pib_main:        { url: 'https://pib.gov.in/Rss.aspx',                                       label: 'PIB' },
  pib_finance:     { url: 'https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=38',            label: 'PIB Finance' },
  pib_defence:     { url: 'https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=16',            label: 'PIB Defence' },
  pib_environment: { url: 'https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=34',            label: 'PIB Environment' },
  pib_sports:      { url: 'https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=57',            label: 'PIB Sports' },
  pib_culture:     { url: 'https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=29',            label: 'PIB Culture' },
  pib_science:     { url: 'https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3',             label: 'PIB Science & Tech' },

  // RBI press releases
  rbi:             { url: 'https://www.rbi.org.in/Scripts/rss.aspx',                            label: 'RBI' },

  // MEA India — official press releases
  mea:             { url: 'https://www.mea.gov.in/rss/press-releases.xml',                      label: 'MEA India' },

  // ISRO latest news
  isro:            { url: 'https://www.isro.gov.in/rss.xml',                                    label: 'ISRO' },

  // UN News — Asia Pacific region
  un_asia:         { url: 'https://news.un.org/feed/subscribe/en/news/region/asia-pacific/rss.xml', label: 'UN News Asia' },
  un_global:       { url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml',             label: 'UN News Global' },
};

// ─────────────────────────────────────────────────────────────────
//  CATEGORY DEFINITIONS
//  17 categories matching your sources document exactly
// ─────────────────────────────────────────────────────────────────
const CATEGORIES = [

  // ─── 1. GOVERNMENT SCHEMES ───────────────────────────────────────
  {
    id: 'government-schemes',
    label: 'Government Schemes',
    feedKeys: ['pib_main', 'pib_finance'],
    sourceNames: ['PIB', 'MyGov India', 'India.gov.in', 'Ministry of Finance', 'NITI Aayog'],
    pickRules: [
      'New schemes launched by central government',
      'Scheme modifications or expansions',
      'Funding pattern and budget allocation',
      'Constitutional or social relevance',
      'Ministries involved',
      'Implementation milestones',
      'SDG linkage',
      'Target beneficiaries',
      'Technology used in scheme delivery',
    ],
    skipRules: [
      'Long ministerial speeches',
      'Political statements and party commentary',
      'Inauguration ceremony details only',
      'Minister quotes without factual substance',
    ],
    keyFactFields: ['Scheme Name', 'Nodal Ministry', 'Target Beneficiaries', 'Funding Pattern', 'Key Feature'],
    examFormats: {
      upsc_uppcs: 'Scheme Name | Ministry | Objective | Key Features | Funding Pattern | Beneficiaries | Significance (Economic/Social/Environmental) | Challenges | Way Forward | Related CA',
      ssc_bank_upsssc: 'Scheme Name → Ministry → Launch Year → Beneficiary → Important Feature',
    },
    examDepth: {
      UPSC:   'Deep analytical — Why important? Constitutional/social/economic relevance? Challenges? Way Forward? SDG linkage?',
      UPPCS:  'Moderate analytical — State linkage, UP adaptation of central scheme, implementation issues in UP',
      SSC:    'Factual one-liners — Who? What? When? Where? Ministry name, launch year, beneficiary',
      BANK:   'Factual — Ministry, beneficiary, financial inclusion angle',
      UPSSSC: 'Short factual — UP schemes, beneficiary groups, key feature only',
      BPSC:   'Moderate — Bihar adaptation, beneficiary count, budget allocation',
    },
    states: ['all'],
  },

  // ─── 2. ECONOMY & BANKING ────────────────────────────────────────
  {
    id: 'economy-banking',
    label: 'Economy & Banking',
    feedKeys: ['rbi', 'pib_finance', 'pib_main'],
    sourceNames: ['RBI', 'SEBI', 'Economic Survey', 'Mint', 'Business Line', 'PIB Finance'],
    pickRules: [
      'Repo rate, reverse repo, CRR, SLR changes announced by RBI',
      'Inflation data — CPI, WPI with actual figures',
      'GDP growth figures (quarterly or annual)',
      'Fiscal deficit numbers and targets',
      'Budget announcements and allocations',
      'RBI policy impacts and MPC decisions',
      'Banking reforms and regulations',
      'Unemployment data (PLFS)',
      'Economic Survey key data points',
      'SEBI regulations affecting investors',
    ],
    skipRules: [
      'Stock market daily fluctuations and Sensex/Nifty movement',
      'Corporate profit/loss results',
      'IPO details and listings',
      'Business gossip and minor company mergers',
      'Individual company news without macro significance',
    ],
    keyFactFields: ['Rate / Indicator', 'Current Value', 'Previous Value', 'Released By', 'Significance'],
    examFormats: {
      upsc_uppcs: 'Topic | Meaning | Current Data | Causes | Impact (Economy / Society / Poor) | Government Measures | RBI Measures | Challenges | Way Forward',
      ssc_bank_upsssc: 'Repo Rate/Term → Current Value → Change → RBI Governor → Significance',
    },
    examDepth: {
      UPSC:   'Deep — fiscal policy, monetary policy transmission, economic survey linkage, global comparison',
      UPPCS:  'Moderate — UP GSDP, state budget, UP economy linkage, MSME in UP',
      SSC:    'Factual — repo rate, CRR, GDP number, RBI governor name',
      BANK:   'Banking-focused — all RBI rates, banking abbreviations, financial terms, SEBI role',
      UPSSSC: 'Basic banking awareness — repo rate, SLR, CRR definitions and current values',
      BPSC:   'Moderate — Bihar GSDP, fiscal deficit, Bihar budget, banking in Bihar',
    },
    states: ['all'],
  },

  // ─── 3. DEFENCE ──────────────────────────────────────────────────
  {
    id: 'defence',
    label: 'Defence',
    feedKeys: ['pib_defence', 'pib_main'],
    sourceNames: ['Ministry of Defence', 'DRDO', 'Indian Army', 'Indian Navy', 'Indian Air Force', 'PIB Defence'],
    pickRules: [
      'Military exercises — name, participating countries, venue, objective',
      'Missile systems — name, range, developed by, type',
      'Defence indigenisation milestones and Make in India',
      'Defence Corridor updates (UP Aligarh-Lucknow, Tamil Nadu)',
      'Maritime security — naval exercises, Coast Guard',
      'Defence deals and acquisitions',
      'Appointments of Army/Navy/Air Force chiefs',
      'Strategic importance of operations or deployments',
    ],
    skipRules: [
      'Ceremonial military visits and parades',
      'Long speeches by Defence Minister',
      'Technical engineering and weapons design specifications',
      'Routine training camp news',
    ],
    keyFactFields: ['Exercise / System Name', 'Countries Involved', 'Venue', 'Developed By / Ministry', 'Strategic Significance'],
    examFormats: {
      upsc_uppcs: 'Exercise/System Name | Participating Countries | Venue | Strategic Importance | Defence Indigenisation angle | Maritime/border security context',
      ssc_bank_upsssc: 'Exercise Name → Countries Involved → Venue → Purpose',
    },
    examDepth: {
      UPSC:   'Strategic depth — indigenisation policy, strategic doctrines, maritime security, border policy implications',
      UPPCS:  'Moderate — UP Defence Corridor (Aligarh to Lucknow), defence manufacturing in UP, DRDO labs in UP',
      SSC:    'Factual — missile names, exercise names, countries involved, chiefs names',
      BANK:   'Basic — major exercises, defence budget headline',
      UPSSSC: 'Basic factual — UP defence corridor name, major missile names',
      BPSC:   'Factual — exercises with Nepal/Bangladesh, Bihar military heritage',
    },
    states: ['all'],
  },

  // ─── 4. REPORTS & INDICES ────────────────────────────────────────
  {
    id: 'reports-indices',
    label: 'Reports & Indices',
    feedKeys: ['pib_main', 'un_global'],
    sourceNames: ['World Bank', 'UNDP', 'IMF', 'WEF', 'NITI Aayog Reports', 'PIB'],
    pickRules: [
      "Report name and publishing organization",
      "India's rank — current and previous year comparison",
      'Top country/state in the index',
      'Theme of the report (especially annual theme)',
      "India's score or composite value",
      'State-wise rankings within India',
    ],
    skipRules: [
      'Full report PDF content and methodology sections',
      'Statistical methodology explanations',
      'Technical annexures and country-by-country detailed tables',
    ],
    keyFactFields: ['Report Name', 'Released By', "India's Rank", 'Top Country / State', 'Theme'],
    examFormats: {
      upsc_uppcs: "Report Name | Released By | India's Rank | Top Country | Theme | Why India's rank changed | Policy implications | State-wise data",
      ssc_bank_upsssc: "Report Name → Released By → India's Rank → Top Country → Theme",
    },
    examDepth: {
      UPSC:   "Deep — India's rank trend over years, policy implications, government response, global comparison",
      UPPCS:  "Moderate — UP's rank in state-wise sub-indices, implications for UP governance",
      SSC:    "Factual — report name, who released it, India rank, top country",
      BANK:   "Factual — economic and financial inclusion indices",
      UPSSSC: "Basic factual — report name, India rank only",
      BPSC:   "Moderate — Bihar's rank, national comparison, NITI Aayog state ranking",
    },
    states: ['all'],
  },

  // ─── 5. ENVIRONMENT & BIODIVERSITY ───────────────────────────────
  {
    id: 'environment',
    label: 'Environment & Biodiversity',
    feedKeys: ['pib_environment', 'pib_main', 'un_global'],
    sourceNames: ['MoEFCC', 'UNEP', 'WWF India', 'IPCC', 'Forest Survey of India', 'PIB Environment'],
    pickRules: [
      'New Ramsar sites designated in India (name, state, area)',
      'Tiger reserve status updates and Project Tiger',
      'National park notifications and wildlife corridors',
      'COP meeting outcomes and India commitments',
      'Climate change data — temperature rise, emissions targets',
      'Biodiversity conventions — CBD, CITES, Ramsar',
      'Endangered species in news with IUCN status',
      'Forest cover India State of Forest Report data',
      'Pollution control — air, water, plastic ban',
      'Green hydrogen, renewable energy milestones',
    ],
    skipRules: [
      'Full climate science research papers',
      'Technical scientific jargon without exam relevance',
      'Routine environmental monitoring data',
      'Individual factory pollution cases',
    ],
    keyFactFields: ['Site / Species Name', 'Location / State', 'Category (Ramsar / Tiger Reserve / NP)', 'Governing Body', 'Significance'],
    examFormats: {
      upsc_uppcs: 'Topic | International Convention linkage | India commitment | Site/Species details | Climate relevance | Challenges | Way Forward',
      ssc_bank_upsssc: 'National Park/Reserve → State → Nearby River → Species found → Why in news',
    },
    examDepth: {
      UPSC:   'Deep — international conventions (CITES, CBD, Ramsar, UNFCCC), India commitments, climate policy, biodiversity Act',
      UPPCS:  'Moderate — UP wildlife sanctuaries (Dudhwa, Pilibhit), Ganga rejuvenation, UP forest cover',
      SSC:    'Factual — national parks, states, rivers nearby, species found',
      BANK:   'Basic — major environmental events, green finance, ESG',
      UPSSSC: 'Factual — UP national parks, common species names, UP environment schemes',
      BPSC:   'Moderate — Bihar wetlands, Valmiki Tiger Reserve, Gangetic dolphin (state animal), Bihar forest data',
    },
    states: ['all'],
  },

  // ─── 6. AWARDS & HONOURS ─────────────────────────────────────────
  {
    id: 'awards-honours',
    label: 'Awards & Honours',
    feedKeys: ['pib_main', 'pib_culture'],
    sourceNames: ['Padma Awards Portal', 'President of India', 'Nobel Prize', 'MHA', 'Ministry of Youth Affairs and Sports', 'PIB'],
    pickRules: [
      'Padma awards — Padma Vibhushan, Padma Bhushan, Padma Shri',
      'Bharat Ratna announcements',
      'Nobel Prize winners (all six categories)',
      'Sports awards — Arjuna, Dronacharya, Khel Ratna, Dhyan Chand',
      'Important national appointments (Governors, CBI, RAW, CEC)',
      'International awards received by Indians',
      'Sahitya Akademi and Sangeet Natak Akademi awards',
    ],
    skipRules: [
      'Full biography details of recipient',
      'Acceptance speech content',
      'Celebrity award shows and film awards',
      'Local or district-level minor awards',
    ],
    keyFactFields: ['Award Name', 'Recipient', 'Field / Category', 'Awarded By', 'Year'],
    examFormats: {
      upsc_uppcs: 'Award Name | Recipient | Field | Awarded By | Year | Historical significance | First recipient ever | Related context',
      ssc_bank_upsssc: 'Award Name → Recipient → Field → Year',
    },
    examDepth: {
      UPSC:   'Moderate — significance of award, first recipient historically, constitutional basis of Bharat Ratna',
      UPPCS:  'Moderate — UP recipients of Padma awards, UP state awards',
      SSC:    'Factual — award name, who got it, which field',
      BANK:   'Factual — RBI governor awards, banking/finance sector appointments',
      UPSSSC: 'Basic — Padma awards, sports awards, national appointments',
      BPSC:   'Moderate — Bihar recipients of Padma/Nobel/national awards',
    },
    states: ['all'],
  },

  // ─── 7. PLACES IN NEWS ───────────────────────────────────────────
  {
    id: 'places-in-news',
    label: 'Places in News',
    feedKeys: ['pib_main', 'mea', 'un_global'],
    sourceNames: ['Survey of India', 'The Hindu', 'Indian Express', 'Britannica', 'MEA India', 'PIB'],
    pickRules: [
      'Exact location — state, country, district, coordinates if relevant',
      'Bordering states or countries',
      'Nearby river, mountain range, or geographical feature',
      'Specific reason why the place is in news',
      'Geopolitical or strategic importance',
      'Historical significance of the location',
    ],
    skipRules: [
      'Travel content and tourism promotion articles',
      'Real estate or property news',
      'Local municipal and civic issues',
    ],
    keyFactFields: ['Place Name', 'State / Country', 'Bordering States / Countries', 'Nearby River / Mountain', 'Why in News'],
    examFormats: {
      upsc_uppcs: 'Place Name | State/Country | Bordering regions | Nearby river/mountain | Why in news | Geopolitical significance | Historical context',
      ssc_bank_upsssc: 'Place → State/Country → Bordering → Why in news',
    },
    examDepth: {
      UPSC:   'Moderate — geopolitical significance, historical context, strategic importance, India policy angle',
      UPPCS:  'Moderate — UP districts in news, rivers of UP, UP-specific geography',
      SSC:    'Factual — location, bordering states/countries',
      BANK:   'Basic — major geopolitical places',
      UPSSSC: 'Factual — UP geography, district facts, rivers in UP',
      BPSC:   'Moderate — Bihar districts, bordering states/countries, Ganges and tributaries in Bihar',
    },
    states: ['all'],
  },

  // ─── 8. IMPORTANT DAYS & EVENTS ──────────────────────────────────
  {
    id: 'important-days',
    label: 'Important Days & Events',
    feedKeys: ['un_global', 'un_asia', 'pib_main'],
    sourceNames: ['United Nations', 'UNESCO', 'WHO', 'FAO', 'UNICEF', 'PIB'],
    pickRules: [
      'Date of observance (exact date)',
      'Annual theme for the current year',
      'Organising body (UN / UNESCO / WHO / FAO / national)',
      'Year the day was first observed/declared',
      'Significance for India specifically',
    ],
    skipRules: [
      'Full historical background essays',
      'Ceremonial celebration programme details',
      'Local city-level event details',
    ],
    keyFactFields: ['Day / Event Name', 'Date', 'Theme (Current Year)', 'Organised By', 'First Observed'],
    examFormats: {
      upsc_uppcs: 'Day Name | Date | Theme (this year) | Organising Body | First Observed | Historical significance | India commitment/policy angle',
      ssc_bank_upsssc: 'Day Name → Date → Theme → Organised By',
    },
    examDepth: {
      UPSC:   'Moderate — historical background, India policy linkage, international convention basis',
      UPPCS:  'Moderate — UP observances, state-level significance',
      SSC:    'Factual — date, theme, organising body',
      BANK:   'Factual — banking and finance related days (World Savings Day etc.)',
      UPSSSC: 'Basic — national and international days, dates and themes only',
      BPSC:   'Moderate — Bihar Foundation Day, Bihar special observances, national days',
    },
    states: ['all'],
  },

  // ─── 9. SPORTS ───────────────────────────────────────────────────
  {
    id: 'sports',
    label: 'Sports',
    feedKeys: ['pib_sports', 'pib_main'],
    sourceNames: ['Olympics', 'ICC', 'BCCI', 'FIFA', 'Sports Authority of India', 'PIB Sports'],
    pickRules: [
      'Tournament winners and champions (name, country)',
      'Host country/city of major tournaments',
      'Venue details for major events',
      'Mascots and themes of tournaments',
      "India's ranking or medal tally",
      'Khelo India programme events',
      'Sports awards (Arjuna, Dronacharya, Khel Ratna)',
    ],
    skipRules: [
      'Match scorecards and ball-by-ball analysis',
      'Player transfer rumours and contracts',
      'Daily tournament updates and match previews',
      'Opinions and commentary columns',
    ],
    keyFactFields: ['Event Name', 'Winner / Champion', 'Host / Venue', "India's Position / Medals", 'Mascot (if any)'],
    examFormats: {
      upsc_uppcs: 'Event Name | Winner | Host/Venue | India Position | Khelo India / Sports policy linkage | Geopolitical angle if relevant',
      ssc_bank_upsssc: 'Tournament → Winner → Host/Venue → India rank/medal → Mascot if any',
    },
    examDepth: {
      UPSC:   'Basic — only major geopolitical sports events (Olympics, Commonwealth, Asian Games, World Cup)',
      UPPCS:  'Moderate — Khelo India UP Games, UP sportspersons, UP sports infrastructure',
      SSC:    'Factual — winners, hosts, venues, mascots, rankings',
      BANK:   'Basic — major international sports headlines only',
      UPSSSC: 'Factual — UP sports events, national games results, UP sportspersons',
      BPSC:   'Moderate — Bihar sports events, national games Bihar contingent, Bihar sports infrastructure',
    },
    states: ['all'],
  },

  // ─── 10. SCIENCE & TECHNOLOGY ────────────────────────────────────
  {
    id: 'science-technology',
    label: 'Science & Technology',
    feedKeys: ['isro', 'pib_science', 'pib_main'],
    sourceNames: ['ISRO', 'DST', 'CSIR', 'NASA', 'Ministry of Electronics and IT', 'PIB Science & Tech'],
    pickRules: [
      'ISRO mission launches — name, vehicle, payload, orbit/destination',
      'AI governance policies and frameworks',
      'Quantum computing milestones',
      'Biotechnology breakthroughs with policy relevance',
      'Semiconductor Mission updates — PLI, fab units',
      'Nobel Prize in Physics, Chemistry, Medicine',
      'DST and CSIR research milestones with national impact',
      'Space mission objectives and achievements',
    ],
    skipRules: [
      'Programming and coding tutorials',
      'Deep engineering and technical specifications',
      'Startup gossip and venture capital news',
      'Consumer technology product launches',
    ],
    keyFactFields: ['Mission / Technology', 'Developed By', 'Purpose / Objective', 'Launch Vehicle / Platform', 'Significance'],
    examFormats: {
      upsc_uppcs: 'Mission/Tech Name | Developed By | Purpose | Launch Vehicle | India global position | AI governance / Semiconductor policy angle | Significance',
      ssc_bank_upsssc: 'Mission Name → ISRO/Agency → Launch Vehicle → Purpose → Orbit/Target',
    },
    examDepth: {
      UPSC:   'Deep — AI governance, quantum policy, semiconductor mission, biotechnology ethics, India space policy',
      UPPCS:  'Moderate — UP tech corridor, IT city Lucknow/Noida, Purvanchal innovation',
      SSC:    'Factual — mission names, ISRO launches, Nobel science news',
      BANK:   'Basic — fintech, digital banking, UPI milestones, RBI digital currency',
      UPSSSC: 'Basic — ISRO mission names, common science facts, UP IT policy',
      BPSC:   'Moderate — tech achievements relevant to Bihar, Digital Bihar initiative',
    },
    states: ['all'],
  },

  // ─── 11. SUMMITS & CONFERENCES ───────────────────────────────────
  {
    id: 'summits-conferences',
    label: 'Summits & Conferences',
    feedKeys: ['mea', 'pib_main', 'un_global'],
    sourceNames: ['G20', 'United Nations', 'MEA India', 'BRICS', 'SCO', 'PIB'],
    pickRules: [
      'Summit name and host city/country',
      'Theme of the summit (exact wording)',
      'Key outcomes and joint declarations',
      "India's role, commitments, and positions taken",
      'Participating countries or member count',
      'Major agreements or MoUs signed',
    ],
    skipRules: [
      'Full declaration texts and communiqué language',
      'Procedural and protocol details',
      'Individual speech content',
      'Side-event details without substantive outcomes',
    ],
    keyFactFields: ['Summit Name', 'Host / Venue', 'Theme', 'Key Participants', 'Key Outcome'],
    examFormats: {
      upsc_uppcs: 'Summit Name | Host/Venue | Theme | Participating Countries | Key Outcomes | India commitments | Strategic significance',
      ssc_bank_upsssc: 'Summit → Host/Venue → Theme → Members/Countries',
    },
    examDepth: {
      UPSC:   'Deep — theme, outcomes, India commitments, historical context, institutional background',
      UPPCS:  'Moderate — India-hosted summits, UP investment summits (Global Investors Summit)',
      SSC:    'Factual — venue, theme, participating countries',
      BANK:   'Factual — G20, IMF, World Bank, ADB summits',
      UPSSSC: 'Basic factual — summit name, venue, theme',
      BPSC:   'Moderate — India-hosted summits, Bihar investment summits',
    },
    states: ['all'],
  },

  // ─── 12. INTERNATIONAL AFFAIRS ───────────────────────────────────
  {
    id: 'international',
    label: 'International Affairs',
    feedKeys: ['mea', 'un_global', 'pib_main'],
    sourceNames: ['MEA India', 'United Nations', 'World Bank', 'Council on Foreign Relations', 'PIB'],
    pickRules: [
      'Bilateral agreements and MoUs signed with India',
      'Strategic partnerships and defence pacts',
      'Border issues and diplomatic resolutions',
      'International organization membership, HQ, and leadership',
      'Treaties signed or ratified by India',
      "Geopolitical conflicts affecting India's interests",
      "India's UNSC positions and multilateral commitments",
    ],
    skipRules: [
      'Daily political commentary and opinion pieces',
      'Ideological debates without policy relevance',
      "Individual country internal politics unless directly India-relevant",
      'Celebrity diplomacy events',
    ],
    keyFactFields: ['Countries / Orgs Involved', 'Nature of Agreement / Event', 'Significance for India', 'Related Treaty / Body', 'Location'],
    examFormats: {
      upsc_uppcs: 'Countries/Orgs Involved | Nature of Event | Strategic significance for India | Related Treaty/Body | Historical context | Challenges',
      ssc_bank_upsssc: 'Organization → HQ → Members → India role → Key report produced',
    },
    examDepth: {
      UPSC:   'Deep analytical — bilateral relations, strategic groups, border policy, multilateral commitments, international law',
      UPPCS:  'Moderate — India-UP trade and investment, UP in diplomatic map (GIS summit)',
      SSC:    'Factual — HQ of organizations, member countries, key reports',
      BANK:   'Factual — IMF, World Bank, ADB roles, India membership fees and voting share',
      UPSSSC: 'Basic — major international orgs, India membership',
      BPSC:   'Moderate — India-Bangladesh, India-Nepal relations, Bihar border implications',
    },
    states: ['all'],
  },

  // ─── 13. ART & CULTURE ───────────────────────────────────────────
  {
    id: 'art-culture',
    label: 'Art & Culture',
    feedKeys: ['pib_culture', 'pib_main'],
    sourceNames: ['Ministry of Culture', 'CCRT', 'ASI', 'Sahitya Akademi', 'IGNCA', 'PIB Culture'],
    pickRules: [
      'UNESCO World Heritage or Intangible Heritage listings',
      'GI tags (Geographical Indications) newly granted',
      'Classical dance forms and classical music in news',
      'Architecture and monuments added to UNESCO or ASI list',
      'Important personalities — authors, artists, dancers in news',
      'Sahitya Akademi and Sangeet Natak Akademi awards',
      'Festivals receiving national or UNESCO recognition',
      'Buddhism and Jainism heritage sites in news',
    ],
    skipRules: [
      'Celebrity culture and Bollywood news',
      'Entertainment industry box office updates',
      'Local cultural events without national significance',
    ],
    keyFactFields: ['Art Form / Site / Festival', 'State / Region', 'UNESCO / GI Status', 'Associated Ministry / Body', 'Significance'],
    examFormats: {
      upsc_uppcs: 'Art Form/Site/Festival | State/Region | UNESCO Status | Associated Community | Historical period | Ministry linkage | Significance for exam',
      ssc_bank_upsssc: 'Folk dance/Festival/Monument → State → Significance',
    },
    examDepth: {
      UPSC:   'Deep — UNESCO process, historical context, Buddhism/Jainism heritage, architectural styles (Nagara, Dravidian, Vesara)',
      UPPCS:  'Deep — UP art forms (Chikankari, Kathak, Thumri), UP UNESCO sites (Agra Fort, Fatehpur Sikri, Taj), UP melas (Kumbh)',
      SSC:    'Factual — folk dances by state, festivals, monuments, states',
      BANK:   'Basic — major cultural milestones, GI tags for banking-relevant products',
      UPSSSC: 'Factual — UP melas, UP crafts (Chikankari, Zardozi, Muradabadi brassware), UP festivals',
      BPSC:   'Deep — Bihar art (Madhubani painting, Tikuli), Chhath Puja UNESCO recognition, Nalanda, Bodh Gaya, Bihar heritage',
    },
    states: ['all'],
  },

  // ─── 14. UP GOVERNMENT SCHEMES ───────────────────────────────────
  {
    id: 'up-schemes',
    label: 'UP Govt. Schemes',
    feedKeys: ['pib_main'],  // UP Govt has no public RSS; PIB covers major UP scheme PIB releases
    sourceNames: ['UP Government (up.gov.in)', 'InfoUP', 'UP Budget (finance.up.nic.in)', 'UPDESCO', 'Invest UP'],
    pickRules: [
      'New schemes launched by UP state government',
      'Budget allocation for UP welfare schemes',
      'Beneficiary count and targets achieved',
      'Nodal department and objectives',
      'State-funded vs centrally sponsored distinction',
      'UP-specific implementation milestones',
    ],
    skipRules: [
      'Political speeches by CM or state ministers',
      'Routine ceremony inaugurations without substance',
      'Contract and tender information',
    ],
    keyFactFields: ['Scheme Name', 'Launched By / Year', 'Target Beneficiaries', 'Budget Allocation', 'Nodal Department'],
    examFormats: {
      upsc_uppcs: 'Scheme Name | Launched By/Year | Nodal Department | Target Beneficiaries | Budget Allocation | Objectives | Key Features | UP-specific significance',
      ssc_bank_upsssc: 'Scheme Name → Department → Beneficiary → Key Feature',
    },
    examDepth: {
      UPPCS:  'Deep — full scheme details, objectives, funding, UP budget linkage, implementation challenges',
      UPSSSC: 'Moderate — scheme name, target group, year launched, key feature',
      SSC:    'Basic — major UP scheme name and primary beneficiary',
      BPSC:   'Not applicable',
    },
    states: ['uppcs'],
  },

  // ─── 15. UP INFRASTRUCTURE ───────────────────────────────────────
  {
    id: 'up-infrastructure',
    label: 'UP Infrastructure',
    feedKeys: ['pib_main'],
    sourceNames: ['UPEIDA (upeida.up.gov.in)', 'Invest UP', 'UP Metro (LMRCL)', 'NHAI', 'UP Power Corporation'],
    pickRules: [
      'Expressway projects — name, length, districts covered, cost',
      'Airport development projects in UP',
      'Metro rail projects — city, corridor length, stations',
      'UP Defence Corridor (Aligarh to Lucknow) updates',
      'Smart city projects in UP (Lucknow, Agra, Varanasi, Kanpur)',
      'Industrial corridors and investment zones',
      'Power projects and renewable energy in UP',
    ],
    skipRules: [
      'Tender notices and contract award details',
      'Technical construction specifications',
      'Routine maintenance and repair news',
    ],
    keyFactFields: ['Project Name', 'Location / Districts', 'Length / Capacity', 'Completion Status', 'Strategic Significance'],
    examFormats: {
      upsc_uppcs: 'Project Name | Location/Districts | Length or Capacity | Investment | Completion Status | Strategic significance | Employment generation',
      ssc_bank_upsssc: 'Project → Districts → Length/Capacity → Status',
    },
    examDepth: {
      UPPCS:  'Deep — all expressways (Purvanchal, Bundelkhand, Ganga, Gorakhpur Link), airports, metro, defence corridor, smart cities, GIS investment',
      UPSSSC: 'Moderate — UP expressways, connectivity projects, districts covered',
      SSC:    'Basic — major UP infrastructure facts',
      BPSC:   'Not applicable',
    },
    states: ['uppcs'],
  },

  // ─── 16. BIHAR GOVERNMENT SCHEMES ────────────────────────────────
  {
    id: 'bihar-schemes',
    label: 'Bihar Govt. Schemes',
    feedKeys: ['pib_main'],
    sourceNames: ['Government of Bihar (state.bihar.gov.in)', 'Bihar PRD', 'Bihar Finance Department', 'RTPS Bihar'],
    pickRules: [
      'New welfare schemes launched by Bihar state government',
      'Budget announcements and allocations for Bihar',
      'Beneficiary schemes — women, youth, farmers, SC/ST',
      'Social sector scheme milestones',
      'State-funded vs centrally sponsored distinction',
    ],
    skipRules: [
      'Political commentary and party statements',
      'Contract and tender information',
      'Ceremonial inauguration-only news',
    ],
    keyFactFields: ['Scheme Name', 'Launched By / Year', 'Target Beneficiaries', 'Budget Allocation', 'Nodal Department'],
    examFormats: {
      upsc_uppcs: 'Scheme Name | Launched By/Year | Nodal Department | Target Beneficiaries | Budget Allocation | Objectives',
      ssc_bank_upsssc: 'Scheme Name → Department → Beneficiary → Key Feature',
    },
    examDepth: {
      BPSC:   'Deep — full scheme details, objectives, funding, Bihar budget linkage, welfare angle, implementation',
      SSC:    'Basic — major Bihar scheme name and beneficiary',
      UPPCS:  'Not applicable',
    },
    states: ['bpsc'],
  },

  // ─── 17. BIHAR INFRASTRUCTURE ────────────────────────────────────
  {
    id: 'bihar-infrastructure',
    label: 'Bihar Infrastructure',
    feedKeys: ['pib_main'],
    sourceNames: ['Bihar Urban Development Department', 'BSRDCL (bsrdcl.bihar.gov.in)', 'BIADA (biadabihar.in)', 'Bihar Government'],
    pickRules: [
      'Road and bridge projects (NH, state highways, Ganga bridges)',
      'Industrial corridors in Bihar (BIADA zones)',
      'Smart city projects (Patna, Gaya, Bhagalpur, Muzaffarpur)',
      'Airport development (Patna, Darbhanga, Gaya)',
      'Railway projects and new lines in Bihar',
      'BSRDCL road construction milestones',
    ],
    skipRules: [
      'Contract and tender information',
      'Technical construction details and specifications',
      'Routine maintenance and repair updates',
    ],
    keyFactFields: ['Project Name', 'Location / Districts', 'Investment / Capacity', 'Completion Status', 'Significance'],
    examFormats: {
      upsc_uppcs: 'Project Name | Location/Districts | Investment | Completion Status | Significance for Bihar economy',
      ssc_bank_upsssc: 'Project → Location → Status',
    },
    examDepth: {
      BPSC:   'Deep — roads, bridges, Ganga bridges, industrial corridors, smart city projects, airport investment',
      SSC:    'Basic — major Bihar infrastructure facts',
      UPPCS:  'Not applicable',
    },
    states: ['bpsc'],
  },

];

// ─────────────────────────────────────────────────────────────────
//  RSS FETCH & PARSE
// ─────────────────────────────────────────────────────────────────
async function fetchFeed(feedKey) {
  const { url, label } = RSS_FEEDS[feedKey];
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Current4Exams-CA-Bot/2.0 (Educational portal; admin: examhall1987@gmail.com)' },
      signal: AbortSignal.timeout(14000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = parseRSS(xml, label, feedKey);
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
    const desc  = clean(get(block, 'description')).slice(0, 350);
    const date  = get(block, 'pubDate') || get(block, 'dc:date') || '';
    if (title) items.push({ title, desc, date, source: label, feedKey });
  }
  return items;
}

function get(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function clean(str) {
  return str
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function isRecent(dateStr) {
  if (!dateStr) return true;
  try {
    const diff = Date.now() - new Date(dateStr).getTime();
    return diff < 48 * 3600 * 1000; // 48 hours
  } catch { return true; }
}

// ─────────────────────────────────────────────────────────────────
//  GROQ CALL
// ─────────────────────────────────────────────────────────────────
async function callGroq(prompt) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      max_tokens: 3500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
  const d = await res.json();
  return d.choices[0].message.content.trim();
}

// ─────────────────────────────────────────────────────────────────
//  ARTICLE GENERATION
// ─────────────────────────────────────────────────────────────────
async function generateForCategory(cat, allHeadlines) {
  // Pull headlines from this category's feeds
  const headlines = allHeadlines
    .filter(h => cat.feedKeys.includes(h.feedKey) && isRecent(h.date))
    .slice(0, 15);

  const headlinesBlock = headlines.length
    ? headlines.map((h, i) => `${i+1}. [${h.source}] ${h.title}\n   ${h.desc}`).join('\n\n')
    : `No live headlines available. Generate the 2 most important and recent ${cat.label} topics from your knowledge as of ${dateDisplay}.`;

  const pickBlock  = cat.pickRules.map(r => `  ✅ ${r}`).join('\n');
  const skipBlock  = cat.skipRules.map(r => `  ❌ ${r}`).join('\n');
  const depthBlock = Object.entries(cat.examDepth)
    .filter(([,v]) => v !== 'Not applicable')
    .map(([exam, depth]) => `  • ${exam}: ${depth}`)
    .join('\n');

  const prompt = `You are a senior current affairs expert writing for Indian competitive exam students (UPSC, UPPCS, BPSC, SSC CGL, UPSSSC).

TODAY: ${dateDisplay}
CATEGORY: ${cat.label}
AUTHORITATIVE SOURCES FOR THIS CATEGORY: ${cat.sourceNames.join(', ')}

━━━ LIVE HEADLINES FETCHED FROM OFFICIAL SOURCES ━━━
${headlinesBlock}

━━━ WHAT TO PICK (exam-relevant for ${cat.label}) ━━━
${pickBlock}

━━━ WHAT TO SKIP (not exam-relevant) ━━━
${skipBlock}

━━━ EXAM-WISE DEPTH REQUIRED ━━━
${depthBlock}

━━━ ARTICLE FORMATS ━━━
For UPSC/UPPCS articles:   ${cat.examFormats.upsc_uppcs}
For SSC/Bank/UPSSSC:       ${cat.examFormats.ssc_bank_upsssc}

━━━ FILTER TEST (apply before writing) ━━━
• UPSC/UPPCS: Is this topic important? What is the impact? What are the challenges? Constitutional/social/economic relevance?
• SSC/Bank: Can examiner ask Who? What? When? Where? from this? If NO → skip.

━━━ YOUR TASK ━━━
Select the 2 MOST EXAM-RELEVANT topics from the headlines above (or from knowledge if no headlines).
Write a complete article for each. Return a JSON array with exactly 2 objects.

Each object must have ALL these fields:
{
  "title": "Specific headline — include actual name, number, or date. Bad: 'Government launches new scheme'. Good: 'PM Modi launches PM Surya Ghar Yojana — 1 Crore rooftop solar homes targeted'",
  "summary": "2-3 sentences. Must include specific numbers, names, places. No vague language like 'significant development'.",
  "body": "Full HTML. Use <p><h3><ul><li><strong> tags. Minimum 250 words. Sections: What Happened → Background → Key Details with numbers → Exam Significance → Challenges (UPSC) / Quick Recall Facts (SSC).",
  "category": "${cat.id}",
  "states": ${JSON.stringify(cat.states)},
  "source": "Name of primary source (from headlines or '${cat.sourceNames[0]}')",
  "importance": "high if this topic appeared in 2+ major exam papers in last 3 years OR is a very major recent development; medium for moderately important; low otherwise",
  "relevance": "Prelims + Mains OR Prelims only OR Tier 1 + Tier 2",
  "examNote": "Specific actionable tip. Name the exam + paper + section. Example: 'UPPCS Mains GS Paper 2 (Governance). SSC CGL Tier 1 GA — expect: What is the ministry? When was it launched? Who are the beneficiaries?'",
  "examTags": ["upsc","uppcs","bpsc","ssc","upsssc"] — only include exams this topic is genuinely relevant for,
  "keyFacts": [
    {"key": "${cat.keyFactFields[0]}", "value": "SPECIFIC — a real name, number, or date. Not 'Various' or 'As applicable'"},
    {"key": "${cat.keyFactFields[1]}", "value": "SPECIFIC value"},
    {"key": "${cat.keyFactFields[2]}", "value": "SPECIFIC value"},
    {"key": "${cat.keyFactFields[3] || 'Related Body'}", "value": "SPECIFIC value"}
  ],
  "sscOneLiner": "Arrow-format for SSC/UPSSSC students. Example: 'PM Surya Ghar Yojana → Ministry of New & Renewable Energy → launched Feb 2024 → 1 crore homes → subsidy up to ₹78,000'",
  "upscAngle": "2 sentences for UPSC/UPPCS. Analytical: constitutional basis, policy challenge, or global comparison. Example: 'The scheme aligns with India's NDC commitment of 500 GW renewable energy by 2030 under the Paris Agreement. However, land acquisition delays and grid integration challenges remain key implementation bottlenecks.'"
}

STRICT RULES:
1. keyFacts values = SPECIFIC (real number, real name, real date). Never vague.
2. title = SPECIFIC (include the actual scheme/mission/exercise name).
3. examNote = SPECIFIC exam + paper + section + type of question expected.
4. sscOneLiner = arrow format only.
5. Do NOT guess or hallucinate statistics. Omit uncertain numbers rather than fabricate.
6. Do NOT write about political speeches, inaugurations only, stock market, or anything in the SKIP list.
7. body must be proper HTML, readable, at least 250 words.

Return ONLY the JSON array. No preamble. No markdown fences. No explanation.`;

  let raw = await callGroq(prompt);
  raw = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();
  if (raw.startsWith('{')) raw = '[' + raw + ']';

  try {
    return JSON.parse(raw);
  } catch(e) {
    // Try extracting array from partial response
    const arrMatch = raw.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try { return JSON.parse(arrMatch[0]); } catch {}
    }
    console.error(`  ⚠️  JSON parse failed for ${cat.label}: ${e.message}`);
    console.error('  First 500 chars:', raw.slice(0, 500));
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────
//  FIRESTORE PUSH
// ─────────────────────────────────────────────────────────────────
function toFSVal(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string')  return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number' && Number.isInteger(v)) return { integerValue: String(v) };
  if (typeof v === 'number') return { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFSVal) } };
  if (typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k,x]) => [k, toFSVal(x)])) } };
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
  if (!res.ok) throw new Error(`Firestore ${res.status}: ${await res.text()}`);
}

// ─────────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────────
async function main() {
  if (!GROQ_API_KEY)     { console.error('❌ Missing GROQ_API_KEY');     process.exit(1); }
  if (!FIREBASE_API_KEY) { console.error('❌ Missing FIREBASE_API_KEY'); process.exit(1); }

  const categoryFilter = process.env.CATEGORIES_OVERRIDE
    ? process.env.CATEGORIES_OVERRIDE.split(',').map(s => s.trim())
    : null;

  const categories = categoryFilter
    ? CATEGORIES.filter(c => categoryFilter.includes(c.id))
    : CATEGORIES;

  console.log('\n' + '═'.repeat(65));
  console.log('  Current4Exams — Daily CA Generator v2.0');
  console.log(`  Date: ${dateDisplay}`);
  console.log(`  Categories: ${categories.length}`);
  console.log('═'.repeat(65));

  // ── Fetch all RSS feeds in parallel ───────────────────────────
  console.log('\n🌐 Fetching RSS feeds...');
  const allFeedKeys = [...new Set(categories.flatMap(c => c.feedKeys))];
  const feedResultsArr = await Promise.allSettled(allFeedKeys.map(fetchFeed));

  const allHeadlines = feedResultsArr.flatMap(r =>
    r.status === 'fulfilled' ? r.value : []
  );
  console.log(`\n📊 Total headlines: ${allHeadlines.length} from ${allFeedKeys.length} feeds\n`);

  // ── Generate + push per category ──────────────────────────────
  let published = 0;
  let failed    = 0;

  for (const cat of categories) {
    console.log(`\n⏳ ${cat.label}`);
    try {
      const articles = await generateForCategory(cat, allHeadlines);
      for (const article of articles) {
        if (!article.title || !article.summary) { console.log('  ⚠️  Skipped: missing title/summary'); continue; }
        article.publishedAt   = new Date(targetDate);
        article.createdAt     = new Date();
        article.autoGenerated = true;
        article.generatedDate = dateStr;
        try {
          await pushToFirestore(article);
          console.log(`  ✅ ${article.title.slice(0, 70)}`);
          published++;
        } catch(e) {
          console.error(`  ❌ Push: ${e.message}`);
          failed++;
        }
      }
    } catch(e) {
      console.error(`  ❌ Generation: ${e.message}`);
      failed++;
    }
    await new Promise(r => setTimeout(r, 2000)); // Groq rate limit pause
  }

  console.log('\n' + '═'.repeat(65));
  console.log(`  ✨ Published: ${published}  |  Failed: ${failed}`);
  console.log('═'.repeat(65) + '\n');

  if (published === 0) { console.error('No articles published.'); process.exit(1); }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
