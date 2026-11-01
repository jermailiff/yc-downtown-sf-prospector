#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const TANDEM_URL = "https://tandemspace.com/yc-companies";
const OUTPUT_DIR = path.join(__dirname, "..", "output");
const OUTPUT_JSON = path.join(OUTPUT_DIR, "tandem_sf_downtown_founders.json");
const OUTPUT_CSV = path.join(OUTPUT_DIR, "tandem_sf_downtown_founders.csv");
const CHECKPOINT_EVERY = 25;
const REQUEST_TIMEOUT_MS = 15000;
const SEARCH_TIMEOUT_MS = 12000;
const DEFAULT_CONCURRENCY = 16;
const DEFAULT_LIMIT = 0;

const DOWNTOWN_NEIGHBORHOODS = new Set([
  "Civic Center",
  "Embarcadero",
  "FIDI",
  "Jackson Square",
  "Mid Market",
  "Mission Bay",
  "SOMA",
  "South Beach",
  "South FiDi",
  "Tenderloin",
  "Union Square",
  "Yerba Buena"
]);

const EMAIL_LOCAL_PART_PRIORITY = [
  "founder",
  "founders",
  "ceo",
  "hello",
  "hi",
  "contact",
  "info",
  "team",
  "partnerships",
  "business",
  "support"
];

const FOUNDER_TITLE_PATTERNS = [
  "Founder",
  "Co-Founder",
  "Founder & CEO",
  "Co-Founder & CEO",
  "Founder and CEO",
  "Co-Founder and CEO",
  "CEO"
];

function parseArgs(argv) {
  const options = {
    limit: DEFAULT_LIMIT,
    concurrency: DEFAULT_CONCURRENCY,
    skipFounders: true,
    offset: 0
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--limit" && argv[index + 1]) {
      options.limit = Number(argv[index + 1]) || 0;
      index += 1;
      continue;
    }

    if (token === "--concurrency" && argv[index + 1]) {
      options.concurrency = Math.max(1, Number(argv[index + 1]) || DEFAULT_CONCURRENCY);
      index += 1;
      continue;
    }

    if (token === "--skip-founders") {
      options.skipFounders = true;
      continue;
    }

    if (token === "--experimental-founders") {
      options.skipFounders = false;
      continue;
    }

    if (token === "--offset" && argv[index + 1]) {
      throw new Error("Resume by offset is disabled: directory ordering can change between runs.");
    }
  }

  return options;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function fetchText(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.text();
}

function decodeNextChunk(rawChunk) {
  return JSON.parse(`"${rawChunk.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
}

function extractJsonArray(encodedText, startIndex) {
  const prefix = '\\"data\\":{\\"json\\":';
  const arrayStart = encodedText.lastIndexOf(prefix, startIndex) + prefix.length;

  if (arrayStart < prefix.length) {
    return [];
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let endIndex = -1;

  for (let index = arrayStart; index < encodedText.length; index += 1) {
    const char = encodedText[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        endIndex = index;
        break;
      }
    }
  }

  if (endIndex < arrayStart) {
    return [];
  }

  const encodedArray = encodedText.slice(arrayStart, endIndex + 1);
  return JSON.parse(encodedArray.replace(/\\"/g, '"'));
}

function extractSfCompaniesFromHtml(html) {
  const pushMatches = [...html.matchAll(/self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)<\/script>/g)];

  for (const match of pushMatches) {
    const decoded = decodeNextChunk(match[1]);
    const queryNeedle =
      '\\"queryKey\\":[[\\"ycAlumMap\\",\\"getDirectory\\"],{\\"input\\":{\\"cityCode\\":\\"SF\\"},\\"type\\":\\"query\\"}]';

    const queryIndex = decoded.indexOf(queryNeedle);
    if (queryIndex === -1) {
      continue;
    }

    const companies = extractJsonArray(decoded, queryIndex);
    if (companies.length) {
      return companies;
    }
  }

  throw new Error("Could not extract the SF company directory from Tandem.");
}

function normalizeWebsite(domain) {
  const raw = cleanText(domain);
  if (!raw) {
    return "";
  }

  if (/^https?:\/\//i.test(raw)) {
    return raw.replace(/\/+$/, "");
  }

  return `https://${raw.replace(/^www\./i, "").replace(/\/+$/, "")}`;
}

function domainFromWebsite(website) {
  try {
    return new URL(website).hostname.replace(/^www\./i, "").toLowerCase();
  } catch (_) {
    return "";
  }
}

function extractEmailsFromHtml(html, websiteDomain) {
  const matches = new Set();
  const emailRegex = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

  for (const match of html.matchAll(emailRegex)) {
    const email = cleanText(match[0]).toLowerCase();
    if (
      email.endsWith(".png") ||
      email.endsWith(".jpg") ||
      email.includes("example.com") ||
      email.includes("sentry.io") ||
      email.includes("wixpress.com")
    ) {
      continue;
    }

    if (!websiteDomain || !email.endsWith(`@${websiteDomain}`)) {
      continue;
    }

    matches.add(email);
  }

  return [...matches];
}

function extractInterestingLinks(html, baseUrl) {
  const links = [];
  const seen = new Set();
  const hrefRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(hrefRegex)) {
    const href = cleanText(match[1]);
    const text = cleanText(stripTags(match[2])).toLowerCase();

    if (!href || seen.has(href)) {
      continue;
    }

    if (!/(contact|about|team|company|founder|leadership|people)/i.test(`${href} ${text}`)) {
      continue;
    }

    try {
      const resolved = new URL(href, baseUrl);
      if (resolved.hostname !== new URL(baseUrl).hostname) {
        continue;
      }

      seen.add(href);
      links.push(resolved.toString());
    } catch (_) {
      // Ignore malformed URLs.
    }
  }

  return links.slice(0, 3);
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

function pickBestEmail(emails, websiteDomain) {
  if (!emails.length) {
    return "";
  }

  const scored = emails
    .map((email) => {
      const [localPart = "", domain = ""] = email.split("@");
      let score = 0;

      if (domain && websiteDomain && domain === websiteDomain) {
        score += 5;
      }

      const priorityIndex = EMAIL_LOCAL_PART_PRIORITY.indexOf(localPart);
      if (priorityIndex >= 0) {
        score += 20 - priorityIndex;
      }

      if (/founder|ceo/.test(localPart)) {
        score += 5;
      }

      return { email, score };
    })
    .sort((left, right) => right.score - left.score || left.email.localeCompare(right.email));

  return scored[0].email;
}

function parseDuckDuckGoLiteResults(page) {
  const rows = [...page.matchAll(/<tr>([\s\S]*?)<\/tr>/g)];
  const results = [];
  let pending = null;

  for (const rowMatch of rows) {
    const row = rowMatch[1];
    const linkMatch = row.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);

    if (linkMatch) {
      const href = normalizeSearchHref(decodeHtml(stripTags(linkMatch[1])));
      const title = decodeHtml(stripTags(linkMatch[2]));
      pending = { href, title, snippet: "" };
      results.push(pending);
      continue;
    }

    if (pending) {
      const snippet = cleanText(decodeHtml(stripTags(row)));
      if (snippet && !/next page|search only for/i.test(snippet)) {
        pending.snippet = snippet;
        pending = null;
      }
    }
  }

  return results;
}

function normalizeSearchHref(href) {
  const raw = cleanText(href);

  if (!raw) {
    return "";
  }

  try {
    const url = new URL(raw, "https://duckduckgo.com");
    if (url.hostname.includes("duckduckgo.com")) {
      const target = url.searchParams.get("uddg");
      if (target) {
        return decodeURIComponent(target);
      }
    }
  } catch (_) {
    return raw;
  }

  return raw;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function searchDuckDuckGo(query, maxResults = 5) {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;

  try {
    const page = await fetchText(url, SEARCH_TIMEOUT_MS);
    return parseDuckDuckGoLiteResults(page).slice(0, maxResults);
  } catch (_) {
    return [];
  }
}

function inferFounderFromText(companyName, companyDomain, text, href, query) {
  const cleaned = cleanText(text);
  const normalizedCompany = companyName.toLowerCase();
  const sourceHost = href ? domainFromWebsite(href) : "";
  const founderQuery = /founder|co-founder/i.test(query || "");
  const sourceTrusted =
    sourceHost.endsWith("linkedin.com") ||
    sourceHost.endsWith("wikipedia.org") ||
    sourceHost.endsWith("ycombinator.com");

  if (!cleaned) {
    return null;
  }

  const titlePattern = /(co[- ]founder(?:\s*&\s*ceo)?|founder(?:\s*&\s*ceo)?|founder(?:\s*and\s*ceo)?|ceo)/i;
  let titleMatch = cleaned.match(titlePattern);
  const companyMentioned = cleaned.toLowerCase().includes(normalizedCompany);

  if (!titleMatch && founderQuery && sourceTrusted) {
    titleMatch = ["Founder", "Founder"];
  }

  if (!titleMatch) {
    return null;
  }

  if (!companyMentioned && !(founderQuery && sourceTrusted)) {
    return null;
  }

  const namePatterns = [
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s*[-|,]\s*(?:Co[- ]Founder|Founder|CEO)/,
    /(?:Founder|Co[- ]Founder|CEO)[^A-Z]{0,12}([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s+(?:is|was)\s+(?:the\s+)?(?:founder|co[- ]founder|ceo)/i
  ];

  let name = "";
  for (const pattern of namePatterns) {
    const nameMatch = cleaned.match(pattern);
    if (nameMatch && nameMatch[1]) {
      name = cleanText(nameMatch[1]);
      break;
    }
  }

  if (!name) {
    const firstSegment = cleanText(cleaned.split("|")[0].split("-")[0]);
    if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}$/.test(firstSegment) && firstSegment.toLowerCase() !== normalizedCompany) {
      name = firstSegment;
    }
  }

  if (
    !name ||
    name.toLowerCase().includes(normalizedCompany) ||
    /(founder|case study|mission|capital|ventures|company|press|blog|team|executive|leadership|staff)/i.test(name)
  ) {
    return null;
  }

  let score = 0;

  if (/co[- ]founder|founder/i.test(titleMatch[1])) {
    score += 5;
  } else if (/ceo/i.test(titleMatch[1])) {
    score += 1;
  }

  if (sourceHost.endsWith("linkedin.com")) {
    score += 5;
  } else if (sourceHost.endsWith("wikipedia.org")) {
    score += 4;
  } else if (sourceHost.endsWith("ycombinator.com")) {
    score += 4;
  } else if (companyDomain && sourceHost === companyDomain) {
    score += 3;
  } else if (sourceHost.endsWith("crunchbase.com")) {
    score += 2;
  }

  return {
    founderName: name,
    founderTitle: normalizeFounderTitle(titleMatch[1]),
    founderSource: href || "",
    founderConfidence: href && href.includes("linkedin.com") ? "medium" : "low",
    founderScore: score
  };
}

function normalizeFounderTitle(value) {
  const title = cleanText(value);
  return FOUNDER_TITLE_PATTERNS.find((pattern) => pattern.toLowerCase() === title.toLowerCase()) || title;
}

async function findFounder(company) {
  const candidates = [];
  const queries = [
    `"${company.name}" founder linkedin`,
    `"${company.name}" founder`,
    `site:linkedin.com/in "${company.name}" founder`
  ];

  for (const query of queries) {
    const results = await searchDuckDuckGo(query, 3);

    for (const result of results) {
      const founder = inferFounderFromText(
        company.name,
        domainFromWebsite(normalizeWebsite(company.domain)),
        `${result.title} | ${result.snippet}`,
        result.href,
        query
      );

      if (founder) {
        candidates.push(founder);
      }
    }

    await sleep(125);
  }

  candidates.sort((left, right) => right.founderScore - left.founderScore);
  if (candidates.length) {
    const best = candidates[0];
    delete best.founderScore;
    return best;
  }

  return {
    founderName: "",
    founderTitle: "",
    founderSource: "",
    founderConfidence: ""
  };
}

async function findPublicEmail(company) {
  const website = normalizeWebsite(company.domain);
  const websiteDomain = domainFromWebsite(website);

  if (!website) {
    return {
      website: "",
      publicEmail: "",
      emailSource: "",
      emailConfidence: ""
    };
  }

  let homepage = "";
  try {
    homepage = await fetchText(website, REQUEST_TIMEOUT_MS);
  } catch (_) {
    return {
      website,
      publicEmail: "",
      emailSource: "",
      emailConfidence: ""
    };
  }

  let foundEmails = extractEmailsFromHtml(homepage, websiteDomain).map((email) => ({
    email,
    source: website
  }));

  const uniqueEmails = [];
  const seenEmails = new Set();
  for (const item of foundEmails) {
    if (seenEmails.has(item.email)) {
      continue;
    }
    seenEmails.add(item.email);
    uniqueEmails.push(item);
  }

  const bestEmail = pickBestEmail(uniqueEmails.map((item) => item.email), websiteDomain);
  const bestMatch = uniqueEmails.find((item) => item.email === bestEmail);

  return {
    website,
    publicEmail: bestEmail,
    emailSource: bestMatch ? bestMatch.source : "",
    emailConfidence: bestEmail ? "medium" : ""
  };
}

function toCsv(rows) {
  if (!rows.length) {
    return "";
  }

  const headers = Object.keys(rows[0]);
  const escapeValue = (value) => {
    const text = cleanText(value);
    return `"${text.replace(/"/g, '""')}"`;
  };

  const lines = [headers.map(escapeValue).join(",")];

  for (const row of rows) {
    lines.push(headers.map((header) => escapeValue(row[header])).join(","));
  }

  return `${lines.join("\n")}\n`;
}

function checkpoint(rows) {
  ensureOutputDir();
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(rows, null, 2));
  fs.writeFileSync(OUTPUT_CSV, toCsv(rows));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let currentIndex = 0;

  async function worker() {
    while (true) {
      const index = currentIndex;
      currentIndex += 1;

      if (index >= items.length) {
        return;
      }

      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureOutputDir();

  console.log("Fetching Tandem YC companies page...");
  const html = await fetchText(TANDEM_URL, REQUEST_TIMEOUT_MS);
  const sfCompanies = extractSfCompaniesFromHtml(html);
  const downtownCompanies = sfCompanies.filter((company) =>
    DOWNTOWN_NEIGHBORHOODS.has(cleanText(company.neighborhood))
  );
  const endIndex = options.limit > 0 ? options.offset + options.limit : downtownCompanies.length;
  const selectedCompanies = downtownCompanies.slice(options.offset, endIndex);
  const rows =
    options.offset > 0 && fs.existsSync(OUTPUT_JSON)
      ? JSON.parse(fs.readFileSync(OUTPUT_JSON, "utf8"))
      : [];

  console.log(
    `Found ${sfCompanies.length} SF companies, ${downtownCompanies.length} in downtown neighborhoods, enriching ${selectedCompanies.length} starting at offset ${options.offset}.`
  );

  await mapWithConcurrency(selectedCompanies, options.concurrency, async (company, index) => {
    const absoluteIndex = options.offset + index;
    console.log(`[${absoluteIndex + 1}/${downtownCompanies.length}] ${company.name}`);

    const emailInfo = await findPublicEmail(company);
    const founderInfo = options.skipFounders
      ? {
          founderName: "",
          founderTitle: "",
          founderConfidence: "",
          founderSource: ""
        }
      : await findFounder(company);

    const row = {
      company_name: company.name,
      batch: company.batch || "",
      funding_round: company.fundingRoundStatus || "",
      team_size: company.teamSize || "",
      neighborhood: company.neighborhood || "",
      address: company.addressLine1 || "",
      city: company.city || "",
      state: company.state || "",
      website: emailInfo.website || normalizeWebsite(company.domain),
      public_email: emailInfo.publicEmail || "",
      email_confidence: emailInfo.emailConfidence || "",
      email_source: emailInfo.emailSource || "",
      founder_name: founderInfo.founderName || "",
      founder_title: founderInfo.founderTitle || "",
      founder_confidence: founderInfo.founderConfidence || "",
      founder_source: founderInfo.founderSource || "",
      one_liner: company.oneLiner || "",
      industry_tags: Array.isArray(company.industryTags) ? company.industryTags.join(" | ") : "",
      notes:
        founderInfo.founderName || emailInfo.publicEmail
          ? ""
          : options.skipFounders
            ? "No public email found on the homepage."
            : "No public email or founder name confidently extracted."
    };

    rows[absoluteIndex] = row;

    if ((absoluteIndex + 1) % CHECKPOINT_EVERY === 0 || index + 1 === selectedCompanies.length) {
      checkpoint(rows.filter(Boolean));
    }

    await sleep(150);
    return row;
  });

  checkpoint(rows.filter(Boolean));

  const completedRows = rows.filter(Boolean);
  const withFounder = completedRows.filter((row) => row.founder_name).length;
  const withEmail = completedRows.filter((row) => row.public_email).length;

  console.log(`Wrote ${OUTPUT_CSV}`);
  console.log(`Rows with founder name: ${withFounder}/${completedRows.length}`);
  console.log(`Rows with public email: ${withEmail}/${completedRows.length}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, extractEmailsFromHtml, toCsv };
