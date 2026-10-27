/**
 * TIFR Visitor Highlighter - Client-Side Engine (Pro Edition)
 * With Auto OCR (Tesseract.js) for Scanned Paper PDFs & Digital PDF support
 */

// Configure PDF.js worker
if (window.pdfjsLib) {
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  } catch (e) {
    console.warn("Could not set PDF.js workerSrc:", e);
  }
}

// Global state
const state = {
  visitors: [],            // parsed visitor objects
  uploadedFiles: [],       // Array of File objects
  processedResults: null,  // results cache
  previewCanvases: [],     // canvases of current preview document
  currentPreviewIdx: 0,
  isProcessing: false,
  viewerMode: localStorage.getItem("tifr_cfg_default_mode") || "individual", // "individual" (default) or "all"
  disabledHighlights: new Set(), // Set of visitor UIDs or numbers whose highlights are disabled/removed
  styleConfigs: null,      // cached style configurations for dynamic re-renders
};

// UI Elements
const elements = {
  inputVisitors: document.getElementById("input-visitors"),
  fileVisitorsImport: document.getElementById("file-visitors-import"),
  btnClearVisitors: document.getElementById("btn-clear-visitors"),
  badgeVisitorCount: document.getElementById("badge-visitor-count"),
  containerParsedVisitors: document.getElementById("container-parsed-visitors"),
  listParsedVisitors: document.getElementById("list-parsed-visitors"),

  dropzone: document.getElementById("dropzone"),
  filePdfInput: document.getElementById("file-pdf-input"),
  badgePdfCount: document.getElementById("badge-pdf-count"),
  listPdfFiles: document.getElementById("list-pdf-files"),

  cfgOcrMode: document.getElementById("cfg-ocr-mode"),
  cfgHighlightColor: document.getElementById("cfg-highlight-color"),
  cfgColorHex: document.getElementById("cfg-color-hex"),
  cfgPadY: document.getElementById("cfg-pad-y"),
  cfgRadius: document.getElementById("cfg-radius"),
  cfgThreshold: document.getElementById("cfg-threshold"),

  btnStartProcess: document.getElementById("btn-start-process"),
  progressContainer: document.getElementById("progress-container"),
  progressStatus: document.getElementById("progress-status"),
  progressPercent: document.getElementById("progress-percent"),
  progressBarFill: document.getElementById("progress-bar-fill"),

  logDrawer: document.getElementById("log-drawer"),

  statusPill: document.getElementById("status-pill"),
  statTotal: document.getElementById("stat-total"),
  statFound: document.getElementById("stat-found"),
  statMissing: document.getElementById("stat-missing"),
  downloadActions: document.getElementById("download-actions"),
  btnDownloadCombined: document.getElementById("btn-download-combined"),
  btnDownloadZip: document.getElementById("btn-download-zip"),
  btnOpenPreviewWindow: document.getElementById("btn-open-preview-window"),
  btnPreviewAllModal: document.getElementById("btn-preview-all-modal"),
  btnQuickPreviewAll: document.getElementById("btn-quick-preview-all"),
  bannerMissing: document.getElementById("banner-missing"),
  listMissingNames: document.getElementById("list-missing-names"),
  tableResultsBody: document.getElementById("table-results-body"),

  btnSampleData: document.getElementById("btn-sample-data"),
  previewCanvas: document.getElementById("preview-canvas"),
  previewEmpty: document.getElementById("preview-empty"),
  previewPageControls: document.getElementById("preview-page-controls"),
  previewPageLabel: document.getElementById("preview-page-label"),
  btnPrevPage: document.getElementById("btn-prev-page"),
  btnNextPage: document.getElementById("btn-next-page"),
};

// Initialize Icons
lucide.createIcons();

// ── Activity Logging ───────────────────────────────────────────

function appendLog(message, type = "info") {
  const time = new Date().toLocaleTimeString();
  const line = document.createElement("div");

  let colorClass = "text-slate-300";
  if (type === "success") colorClass = "text-emerald-400 font-semibold";
  if (type === "warn") colorClass = "text-amber-400";
  if (type === "error") colorClass = "text-rose-400 font-semibold";
  if (type === "ocr") colorClass = "text-sky-300";

  line.className = `flex items-start space-x-1.5 ${colorClass}`;
  line.innerHTML = `<span class="text-slate-500 shrink-0">[${time}]</span> <span>${message}</span>`;

  elements.logDrawer.appendChild(line);
  elements.logDrawer.scrollTop = elements.logDrawer.scrollHeight;
}

function clearLogs() {
  elements.logDrawer.innerHTML = "";
}

// ── Text & Normalization Utilities ──────────────────────────────

function normalize(text) {
  if (!text) return "";
  return text
    .replace(/[\u00e6\u00c6]/g, "ae")
    .replace(/[\u0153\u0152]/g, "oe")
    .replace(/[üÜ]/g, "u")
    .replace(/[öÖ]/g, "o")
    .replace(/[çÇ]/g, "c")
    .replace(/[ğĞ]/g, "g")
    .replace(/[ıİ]/g, "i")
    .replace(/[şŞ]/g, "s")
    .replace(/[ß]/g, "ss")
    .replace(/[ñÑ]/g, "n")
    .replace(/\uFB01/g, "fi")
    .replace(/\uFB02/g, "fl")
    .replace(/\uFB00/g, "ff")
    .replace(/\uFB03/g, "ffi")
    .replace(/\uFB04/g, "ffl")
    .replace(/\uFB05/g, "ft")
    .replace(/\uFB06/g, "st")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function alphaOnly(str) {
  return normalize(str).replace(/[^a-z]/g, "");
}

function cleanVisitorNameParts(visitorName) {
  if (!visitorName) return [];
  // Strip honorifics anywhere: Prof., Dr., Mr., Mrs., Ms., Shri, Smt, etc., plus status notes like (Retired)
  const norm = normalize(visitorName);
  const cleaned = norm
    .replace(/\b(prof|dr|mr|mrs|ms|shri|smt|fr)\b\.?/gi, "")
    .replace(/\b(retired|ret|retd)\b\.?/gi, "")
    .replace(/[^a-z\s]/g, " ")
    .trim();
  return cleaned.split(/\s+/).filter(Boolean);
}

function nameMatches(visitorName, ctx) {
  const parts = cleanVisitorNameParts(visitorName);
  if (parts.length === 0) return false;

  const ctxClean = normalize(ctx).replace(/[^a-z ]/g, " ");
  const first = alphaOnly(parts[0]);
  const last = alphaOnly(parts[parts.length - 1]);

  // Primary check: first and last name both appear in OCR context
  if (first && last && ctxClean.includes(first) && ctxClean.includes(last)) {
    return true;
  }

  // Single word name check
  if (parts.length === 1 && first && ctxClean.includes(first)) {
    return true;
  }

  // Fallback check: if last name is >= 4 chars and any other part is found
  if (last && last.length >= 4 && ctxClean.includes(last)) {
    for (let p = 0; p < parts.length - 1; p++) {
      const partAlpha = alphaOnly(parts[p]);
      if (partAlpha && partAlpha.length >= 3 && ctxClean.includes(partAlpha)) {
        return true;
      }
    }
  }

  return false;
}

function isDateContext(words, idx) {
  if (!words || idx < 0 || idx >= words.length) return false;
  const w = words[idx].raw.trim();
  if (w.includes("/") || w.includes("\\") || w.includes("-")) return true;
  if (idx > 0) {
    const prev = words[idx - 1].raw.trim().toLowerCase();
    if (prev === "to" || prev === "from" || prev === "dated" || prev.endsWith("/")) return true;
  }
  if (idx + 1 < words.length) {
    const next = words[idx + 1].raw.trim();
    if (next.startsWith("/") || /^\d{2,4}$/.test(next) || next === "to") return true;
  }
  return false;
}

function isNumberToken(word, n, words = null, idx = -1) {
  if (!word) return false;
  if (word.includes("/") || word.includes("\\")) return false;
  if (words && idx >= 0) {
    if (isDateContext(words, idx)) return false;
    // Reject Annexure numbering like "(Annexure I)"
    if (idx > 0 && /annexure/i.test(words[idx - 1].raw)) return false;
    if (idx > 1 && /annexure/i.test(words[idx - 2].raw)) return false;
  }

  const cleaned = word.replace(/[^0-9]/g, "");
  if (cleaned.startsWith("0") && cleaned.length > 1) return false;
  if (cleaned === String(n)) {
    if (word.length <= String(n).length + 3) {
      return true;
    }
  }
  if (String(n) === "1") {
    // Only accept I or l if followed by punctuation (e.g. "I." or "1.") - never the standalone English pronoun "I"
    if (/^[Il|][.):]$/.test(word)) return true;
  }
  return false;
}


function isValidVisitorStart(words, i, visitor) {
  const parts = cleanVisitorNameParts(visitor.name);
  if (!parts.length) return false;

  const first = alphaOnly(parts[0]);
  const last = alphaOnly(parts[parts.length - 1]);

  const immediateWords = words.slice(i + 1, Math.min(i + 6, words.length));
  if (!immediateWords.length) return false;

  // Reject obvious section headers like "1. The visitors' details..."
  const firstWordNorm = normalize(immediateWords[0].raw);
  const DISQUALIFIED_START_WORDS = [
    "the", "details", "following", "approval", "sanction", "purpose", "subject", "ref", "dated", "below", "foreign", "nationals"
  ];
  if (DISQUALIFIED_START_WORDS.includes(firstWordNorm)) {
    return false;
  }

  // Check if visitor's first name, last name, or an honorific appears in the first 4 words
  const immediateAlpha = immediateWords.slice(0, 4).map(w => alphaOnly(w.raw));
  const hasNamePart = immediateAlpha.some(w => w === first || w === last || (w.length >= 4 && (first.includes(w) || last.includes(w))));
  const hasHonorific = immediateWords.slice(0, 3).some(w => /^(dr|prof|mr|mrs|ms|shri|smt)\.?$/i.test(normalize(w.raw)));

  if (!hasNamePart && !hasHonorific) {
    return false;
  }

  const ctxWords = words.slice(i + 1, Math.min(i + 16, words.length));
  const ctxClean = normalize(ctxWords.map(w => w.raw).join(" ")).replace(/[^a-z ]/g, " ");

  if (first && last && ctxClean.includes(first) && ctxClean.includes(last)) {
    return true;
  }

  if (last && last.length >= 4 && ctxClean.includes(last)) {
    return true;
  }

  return false;
}

const CLOSING_PHRASES = [
  "we have obtained",
  "passport particulars",
  "prescribed dae format",
  "enclosed with this letter",
  "annexure",
  "yours faithfully",
  "yours sincerely",
  "with regards",
  "with warm regards",
  "telephone",
  "telefon",
  "website",
  "fax",
  "e-mail",
  "email",
  "icts.res.in",
  "tifr.res.in",
  "www.",
  "http",
  "dean",
  "director",
  "centre director",
  "rajesh",
  "gopakumar",
  "registrar",
  "i am writing to request",
  "निवेदन",
  "निवेदन है कि",
  "उपरोक्त",
  "विदेशी नागरिकों",
  "हस्ताक्षर",
  "भवदीय",
  "यदि आपके कोई प्रश्न",
  "परमाणु ऊर्जा विभाग",
  "request you to approve",
  "to approve the above",
  "please do not hesitate",
  "सादर",
  "best regards",
  "contact us",
  "encl",
  "संलग्नक",
  "as stated above",
  "discrepancy",
  "prevail and will be binding"
];

function isClosingParagraph(words, idx) {
  if (!words || !words[idx]) return false;
  // A date token is NEVER closing text (protects wrapped date lines like "26/09/2026.")
  const raw = words[idx].raw;
  if (/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/.test(raw)) {
    return false;
  }
  const rawLower = normalize(raw);
  // Immediate single-token footer markers
  if (rawLower.includes("telephone") || rawLower.includes("टेलीफ़ोन") ||
      rawLower.includes("website") || rawLower.includes("वेबसाइट") ||
      rawLower.includes("email") || rawLower.includes("ईमेल") ||
      rawLower.includes("fax") || rawLower.includes("फ़ैक्स") ||
      rawLower.includes("director") || rawLower.includes("निदेशक") ||
      rawLower.includes("gopakumar") || rawLower.includes("राजेश") ||
      rawLower.includes("encl") || rawLower.includes("संलग्नक") ||
      rawLower.includes("discrepancy") ||
      rawLower.includes("hesitate") || rawLower.includes("संकोच") ||
      rawLower.includes("questions") || rawLower.includes("प्रश्न") ||
      rawLower.includes("regards") || rawLower.includes("सादर") ||
      rawLower.includes("contact") || rawLower.includes("संपर्क") ||
      rawLower.includes("www.") || rawLower.includes("@")) {
    return true;
  }

  const snippet = words
    .slice(idx, Math.min(idx + 5, words.length))
    .map(w => normalize(w.raw))
    .join(" ");

  return CLOSING_PHRASES.some(p => snippet.startsWith(p));
}


function isParentheticalNote(words, idx) {
  if (!words || !words[idx]) return false;
  const w = words[idx].raw.trim();
  if (w.startsWith("(")) {
    if (/^\((oci|pio)\)?[.)]*$/i.test(w)) {
      return false;
    }
    const snippet = words.slice(idx, Math.min(idx + 6, words.length))
      .map(x => normalize(x.raw))
      .join(" ");
    if (/^\((the|this|these|those|note|remark|approval|subject|as\s+per|please|details|family|accompanying|in\s+addition|we|they|she|he|above)/i.test(snippet)) {
      return true;
    }
    if (words.slice(idx, Math.min(idx + 5, words.length)).length >= 3) {
      return true;
    }
  }
  return false;
}

function isDateToken(word, words = null, idx = -1) {
  if (!word) return false;
  if (/\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}[.,;]?\b/.test(word)) return true;
  if (words && idx >= 0) {
    // Check if word is part of a split date sequence (e.g. "10", "/", "04", "/", "2027.")
    const forwardSnippet = words.slice(idx, Math.min(words.length, idx + 5)).map(w => w.raw).join("");
    if (/^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}[.,;]?/.test(forwardSnippet)) return true;
    const backwardSnippet = words.slice(Math.max(0, idx - 4), idx + 1).map(w => w.raw).join("");
    if (/\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}[.,;]?$/.test(backwardSnippet)) return true;
  }
  return false;
}

function getDateSpan(words, idx) {
  if (!words || idx < 0 || idx >= words.length) return null;
  const raw = words[idx].raw.trim();
  if (/\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}[.,;]?\b/.test(raw)) {
    return { start: idx, end: idx + 1 };
  }
  let combined = "";
  for (let k = idx; k < Math.min(words.length, idx + 6); k++) {
    combined += words[k].raw.trim();
    if (/^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}[.,;]?$/.test(combined)) {
      let endK = k + 1;
      if (endK < words.length && /^[.,;]$/.test(words[endK].raw.trim())) {
        endK++;
      }
      return { start: idx, end: endK };
    }
  }
  return null;
}

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = [];
  for (let j = 0; j <= b.length; j++) row[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j];
      if (a[i - 1] === b[j - 1]) {
        row[j] = prev;
      } else {
        row[j] = Math.min(prev + 1, row[j] + 1, row[j - 1] + 1);
      }
      prev = temp;
    }
  }
  return row[b.length];
}

function tokenSimilarity(a, b) {
  if (a === b) return 1.0;
  if (!a || !b) return 0.0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return (maxLen - editDistance(a, b)) / maxLen;
}

function isFuzzyTokenMatch(token, target) {
  if (!token || !target) return false;
  if (token === target) return true;
  if (target.length <= 3) return false;

  // Common OCR substitutions: l/1 <-> i, 0 <-> o, rn <-> m, vv <-> w
  const simA = token.replace(/[l1]/g, "i").replace(/0/g, "o").replace(/rn/g, "m").replace(/vv/g, "w");
  const simB = target.replace(/[l1]/g, "i").replace(/0/g, "o").replace(/rn/g, "m").replace(/vv/g, "w");
  if (simA === simB && simA.length >= 3) return true;

  const lenDiff = Math.abs(token.length - target.length);
  if (lenDiff <= 1 && target.length >= 4) {
    if (editDistance(token, target) <= 1) return true;
  }
  if (lenDiff <= 2 && target.length >= 7 && token.length >= 6) {
    if (tokenSimilarity(token, target) >= 0.82 && editDistance(token, target) <= 2) return true;
  }
  return false;
}

function isTokenMatchForNamePart(a, part) {
  if (!a || !part) return false;
  if (a === part) return true;
  if (part.length <= 3) return a === part;
  if (a.length >= part.length && a.length <= part.length + 3 && a.includes(part)) return true;
  return isFuzzyTokenMatch(a, part);
}

function windowHasPart(windowWords, part) {
  if (!part || !windowWords || windowWords.length === 0) return false;
  for (let k = 0; k < windowWords.length; k++) {
    const a = alphaOnly(windowWords[k].raw);
    if (isTokenMatchForNamePart(a, part)) return true;
  }
  if (part.length >= 4) {
    for (let k = 0; k < windowWords.length - 1; k++) {
      const joined = alphaOnly(windowWords[k].raw + windowWords[k + 1].raw);
      if (isTokenMatchForNamePart(joined, part)) return true;
    }
  }
  return false;
}

function isPureClosingPage(words) {
  if (!words || words.length < 5) return false;
  const fullText = words.map(w => normalize(w.raw)).join(" ");
  const hasClosingMarker = 
    fullText.includes("rajesh gopakumar") ||
    fullText.includes("centre director") ||
    fullText.includes("i am writing to request you to approve") ||
    fullText.includes("with best regards") ||
    fullText.includes("as stated above") ||
    fullText.includes("discrepancy the english version") ||
    fullText.includes("prevail and will be binding") ||
    fullText.includes("survey no 151") ||
    fullText.includes("hesaraghatta hobli");

  if (!hasClosingMarker) return false;

  const hasDateRange = /\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}\b.*?\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}\b/.test(
    words.map(w => w.raw).join(" ")
  );
  const hasVisitorsPreamble = fullText.includes("visitors details are as follows") || fullText.includes("details are as follows");

  return !hasDateRange && !hasVisitorsPreamble;
}


function getVisitorPreambleBarrierIdx(words) {
  if (!words || words.length === 0) return 0;
  let maxBarrier = 0;
  for (let i = 0; i < words.length; i++) {
    const snippet = words.slice(i, Math.min(i + 6, words.length)).map(w => normalize(w.raw)).join(" ");
    if (snippet.includes("details are as follows") ||
        snippet.includes("visitors details") ||
        snippet.includes("as follows") ||
        snippet.includes("nimnanusar hai") ||
        /निम्नानुसार\s*है/.test(words.slice(i, Math.min(i + 3, words.length)).map(w => w.raw).join(" "))) {
      for (let k = i; k < Math.min(i + 8, words.length); k++) {
        const raw = words[k].raw;
        if (raw.includes(":") || normalize(raw).includes("follows") || /निम्नानुसार|है/.test(raw)) {
          maxBarrier = Math.max(maxBarrier, k + 1);
        }
      }
      if (maxBarrier === 0) {
        maxBarrier = Math.max(maxBarrier, i + 5);
      }
    }
  }
  return maxBarrier;
}

function partitionPageVisitorEntries(words) {
  if (!words || words.length === 0) return [];

  const barrierIdx = getVisitorPreambleBarrierIdx(words);

  const bulletCandidates = [];
  for (let i = barrierIdx; i < words.length; i++) {
    const raw = words[i].raw.trim();
    const m = raw.match(/^[\(\[]?(\d+)[.)\]]?$/);
    if (!m) continue;
    const num = parseInt(m[1], 10);
    if (num < 1 || num > 60) continue;
    if (words[i].left > 520) continue; // must be near left margin (tolerant up to 520px for scans/skew)

    if (isDateContext(words, i)) continue;

    // Reject obvious section headers like "1. The visitors' details..."
    if (i + 1 < words.length) {
      const nextWord = normalize(words[i + 1].raw);
      if (['the', 'details', 'following', 'approval', 'sanction', 'purpose', 'subject', 'ref', 'dated', 'below', 'foreign', 'nationals'].includes(nextWord)) {
        continue;
      }
    }

    // Reject Annexure numbering like "(Annexure I)"
    if (i > 0 && /annexure|ref|dated/i.test(words[i - 1].raw)) continue;
    if (i > 1 && /annexure|ref|dated/i.test(words[i - 2].raw)) continue;

    // Reject address / telephone / survey numbers (e.g. "Survey No. 151")
    if (i > 0 && /survey|plot|flat|room|block|sector|pin|box|tel|fax/i.test(words[i - 1].raw)) continue;
    if (i > 1 && /survey|plot|flat|room|block|sector|pin|box|tel|fax/i.test(words[i - 2].raw)) continue;

    // Reject numbers followed by institutional address localities
    const immediateWords = words.slice(i + 1, Math.min(i + 6, words.length));
    const immediateNorm = immediateWords.map(w => normalize(w.raw)).join(" ");
    if (/(shivakote|hesaraghatta|hobli|bengaluru|bangalore|karnataka|autonomous|deemed)/i.test(immediateNorm)) {
      continue;
    }

    // Reject numbers with leading zeros (e.g. pin code "005")
    if (/^0\d+/.test(raw.replace(/[^0-9]/g, ""))) continue;

    // Reject numbers preceded by pin codes or city addresses (e.g. "Mumbai - 400 005")
    if (i > 0 && /^[-,;:]$/.test(words[i - 1].raw) && i > 1 && /^\d{3,6}$/.test(words[i - 2].raw)) continue;
    if (i > 0 && /mumbai|bengaluru|bangalore|delhi|pincode|pin|code/i.test(normalize(words[i - 1].raw))) continue;
    if (i > 1 && /mumbai|bengaluru|bangalore|delhi|pincode|pin|code/i.test(normalize(words[i - 2].raw))) continue;
    if (i > 0 && /अनुबंध|विवरण|आगंतुक|क्रमांक|पिन|दूरभाष/i.test(words[i - 1].raw)) continue;

    bulletCandidates.push({ wordIdx: i, num: num, top: (words[i].deskewedY ?? words[i].top) });
  }

  if (bulletCandidates.length === 0) return [];

  // Strictly discard any candidates before the barrier
  const validCandidates = bulletCandidates.filter(c => c.wordIdx >= barrierIdx);

  if (validCandidates.length === 0) return [];


  const entries = [];
  for (let b = 0; b < validCandidates.length; b++) {
    const curr = validCandidates[b];
    const next = validCandidates[b + 1];
    let startIdx = curr.wordIdx;

    if (startIdx > 0 && /^[(\[#]$/.test(words[startIdx - 1].raw.trim())) {
      startIdx--;
    }

    let endIdx = words.length;

    if (next) {
      endIdx = next.wordIdx;
    } else {
      // Last entry on the page: find closing paragraph or end after dates
      let closingIdx = words.length;
      for (let k = startIdx + 1; k < words.length; k++) {
        if (isClosingParagraph(words, k)) {
          closingIdx = k;
          break;
        }
      }

      let dateEndIdx = words.length;
      let lastDateIdx = -1;
      for (let k = startIdx + 1; k < closingIdx; k++) {
        if (isDateToken(words[k].raw, words, k)) {
          lastDateIdx = k;
        }
      }
      if (lastDateIdx !== -1) {
        let stopAt = lastDateIdx + 1;
        while (stopAt < closingIdx && /^[.,;]$/.test(words[stopAt].raw.trim())) {
          stopAt++;
        }
        if (stopAt < closingIdx && /^\(?(oci|pio)\)?[.,;]?$/i.test(words[stopAt].raw.trim())) {
          stopAt++;
        }
        while (stopAt < closingIdx && /^[.,;]$/.test(words[stopAt].raw.trim())) {
          stopAt++;
        }
        dateEndIdx = stopAt;
      }

      endIdx = Math.min(closingIdx, dateEndIdx);

      // Safety limit: single entry cannot exceed 38 words or 350 vertical pixels
      const startTop = words[startIdx].deskewedY ?? words[startIdx].top;
      for (let k = startIdx + 1; k < endIdx; k++) {
        if (k > startIdx + 38 || ((words[k].deskewedY ?? words[k].top) - startTop > 350)) {
          endIdx = k;
          break;
        }
      }
    }

    const entryWords = words.slice(startIdx, endIdx);
    const entryText = entryWords.map(w => w.raw).join(' ');
    entries.push({
      num: curr.num,
      start: startIdx,
      end: endIdx,
      words: entryWords,
      text: entryText,
      normText: normalize(entryText)
    });
  }

  return splitMultiVisitorEntries(entries, words);
}

function splitMultiVisitorEntries(entries, words) {
  const refined = [];
  for (const entry of entries) {
    const entryWords = entry.words;
    const dateIndices = [];
    for (let k = 0; k < entryWords.length; k++) {
      if (isDateToken(entryWords[k].raw, entryWords, k)) {
        dateIndices.push(k);
      }
    }

    let splitPoint = -1;
    for (let d = 0; d < dateIndices.length - 1; d++) {
      const idx1 = dateIndices[d];
      const idx2 = dateIndices[d + 1];
      for (let m = idx1 + 1; m < idx2; m++) {
        const raw = entryWords[m].raw.toLowerCase();
        if (raw === "from" || (entryWords[m].left <= entryWords[0].left + 50 && m > idx1 + 1)) {
          splitPoint = idx1 + 1;
          while (splitPoint < entryWords.length && /^[.,;]$/.test(entryWords[splitPoint].raw)) {
            splitPoint++;
          }
          break;
        }
      }
      if (splitPoint !== -1) break;
    }

    if (splitPoint !== -1) {
      const part1Words = entryWords.slice(0, splitPoint);
      const part2Words = entryWords.slice(splitPoint);
      refined.push({
        num: entry.num,
        start: entry.start,
        end: entry.start + splitPoint,
        words: part1Words,
        text: part1Words.map(w => w.raw).join(" "),
        normText: normalize(part1Words.map(w => w.raw).join(" "))
      });
      refined.push({
        num: entry.num + 1,
        start: entry.start + splitPoint,
        end: entry.end,
        words: part2Words,
        text: part2Words.map(w => w.raw).join(" "),
        normText: normalize(part2Words.map(w => w.raw).join(" "))
      });
    } else {
      refined.push(entry);
    }
  }
  return refined;
}


function findVisitorBoundary(words, visitor) {
  if (!words || words.length === 0) return null;
  if (isPureClosingPage(words)) return null;

  const parts = cleanVisitorNameParts(visitor.name);
  if (!parts.length) return null;

  const first = parts[0];
  const last = parts[parts.length - 1];
  const allParts = parts.filter(p => p.length >= 2);
  const targetNo = String(visitor.no);
  const targetNoInt = parseInt(targetNo, 10);

  // ── Strategy 1: Disjoint Numbered List Partitioning (Zero-Merge Guarantee) ──
  const partitions = partitionPageVisitorEntries(words);
  if (partitions.length > 0) {
    let bestEntry = null;
    let bestScore = 0;

    for (const entry of partitions) {
      let score = 0;
      const entryWords = entry.words;

      const hasFirst = first && windowHasPart(entryWords, first);
      const hasLast = last && windowHasPart(entryWords, last);
      const matchingPartsCount = allParts.filter(p => windowHasPart(entryWords, p)).length;

      const isNumMatch = !isNaN(targetNoInt) && targetNoInt === entry.num;

      // STRICT SCORING: An entry CANNOT match a visitor unless the visitor's name is present!
      if (hasFirst && hasLast) {
        score = isNumMatch ? 18 : 14;
      } else if (isNumMatch && (hasFirst || hasLast || matchingPartsCount >= 2 || (parts.length === 1 && hasFirst))) {
        score = 15;
      } else if (hasLast && last.length >= 4) {
        const initial = first ? first[0] : "";
        const hasInitial = entryWords.some(w => {
          const a = alphaOnly(w.raw);
          return a === initial && w.raw.length <= 2;
        });
        if (hasInitial) {
          score = isNumMatch ? 15 : 11;
        } else if (matchingPartsCount >= 1 && isNumMatch) {
          score = 14;
        }
      } else if (matchingPartsCount >= 2) {
        score = isNumMatch ? 15 : 11;
      } else if (parts.length === 1 && hasFirst) {
        score = isNumMatch ? 15 : 10;
      }

      // Cross-document verification: check country/institution details if present
      if (score > 0 && visitor.details) {
        const detailWords = visitor.details
          .split(/[\s,;:.()]+/)
          .map(w => alphaOnly(w))
          .filter(w => w.length >= 4);
        const stopWords = new Set(["from", "university", "institute", "center", "centre", "school", "physics", "department", "complex", "systems"]);
        const keyDetails = detailWords.filter(w => !stopWords.has(w));
        if (keyDetails.length > 0) {
          const hasDetail = keyDetails.some(kw => windowHasPart(entryWords, kw));
          if (hasDetail) {
            score += 4;
          }
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestEntry = entry;
      }
    }

    if (bestEntry && bestScore >= 10) {
      return {
        start: bestEntry.start,
        end: bestEntry.end,
        detectedPdfNo: bestEntry.num
      };
    }

    // Strategy 1 did not find visitor, fall through to Strategy 2
  }

  // ── Strategy 2: Sliding-Window Fallback for Unnumbered Documents ──
  const barrierIdx = getVisitorPreambleBarrierIdx(words);
  let bestStart = -1;
  let bestScore = 0;
  let bestFirstTokIdx = -1;

  for (let i = barrierIdx; i < words.length; i++) {
    if (isClosingParagraph(words, i)) continue; // Skip tokens that fall inside closing headers/footers

    const rawTok = words[i].raw;
    const wAlpha = alphaOnly(rawTok);
    const isNum = isNumberToken(rawTok, targetNo, words, i);

    // Look for matching tokens: target number, first name, last name, or any significant part
    const matchesFirst = first && (first.length >= 3 ? (wAlpha.length >= 3 && isFuzzyTokenMatch(wAlpha, first)) : wAlpha === first);
    const matchesLast = last && (last.length >= 3 ? (wAlpha.length >= 3 && isFuzzyTokenMatch(wAlpha, last)) : wAlpha === last);
    const matchesAnyPart = allParts.some(p => p.length >= 3 ? (wAlpha.length >= 3 && isFuzzyTokenMatch(wAlpha, p)) : wAlpha === p);

    if (!isNum && !matchesFirst && !matchesLast && !matchesAnyPart) continue;

    // Reject obvious section headers like "1. The visitors' details..."
    if (isNum) {
      const immediateWords = words.slice(i + 1, Math.min(i + 5, words.length));
      if (immediateWords.length > 0) {
        const firstWordNorm = normalize(immediateWords[0].raw);
        if (["the", "details", "following", "approval", "sanction", "purpose", "subject", "ref", "dated", "below", "foreign", "nationals"].includes(firstWordNorm)) {
          continue;
        }
      }
    }

    // Check if this token is inside an "(Accompanying ...)" parenthetical clause
    let insideAccompanying = false;
    for (let b = i - 1; b >= Math.max(0, i - 12); b--) {
      const raw = words[b].raw;
      if (raw.includes(")")) break;
      if (/^\d+[.):]?$/.test(raw)) break;
      if (/accompany/i.test(raw)) {
        insideAccompanying = true;
        break;
      }
    }
    if (insideAccompanying) continue;

    const winStart = Math.max(0, i - 4);
    const winEnd = Math.min(words.length, i + 20);
    const windowWords = [];
    let inAcc = false;
    for (let wIdx = winStart; wIdx < winEnd; wIdx++) {
      const w = words[wIdx];
      if (/accompany/i.test(w.raw)) inAcc = true;
      if (!inAcc) windowWords.push(w);
      if (w.raw.includes(")")) inAcc = false;
    }

    const hasTargetNum = windowWords.some((w, wI) => isNumberToken(w.raw, targetNo, words, winStart + wI));
    const hasFirst = windowHasPart(windowWords, first);
    const hasLast = windowHasPart(windowWords, last);
    const matchingPartsCount = allParts.filter(p => windowHasPart(windowWords, p)).length;

    // STRICT NAME GUARD: Require actual name presence to match in Strategy 2
    let score = 0;
    if (hasFirst && hasLast) {
      score = hasTargetNum ? 16 : 12;
    } else if (hasTargetNum && (hasFirst || hasLast)) {
      score = 14;
    } else if (hasTargetNum && matchingPartsCount >= 2) {
      score = 13;
    } else if (hasLast && last.length >= 4) {
      const initial = first ? first[0] : "";
      const hasInitial = windowWords.some(w => {
        const a = alphaOnly(w.raw);
        return a === initial && w.raw.length <= 2;
      });
      if (hasInitial) {
        score = hasTargetNum ? 13 : 10;
      }
    } else if (parts.length === 1 && hasFirst) {
      score = hasTargetNum ? 14 : 10;
    }


    if (score > bestScore) {
      bestScore = score;
      let firstIdxInWords = -1;
      for (let k = winStart; k < winEnd; k++) {
        const a = alphaOnly(words[k].raw);
        if (a && allParts.some(p => p === a || isFuzzyTokenMatch(a, p))) {
          firstIdxInWords = k;
          break;
        }
      }
      bestFirstTokIdx = firstIdxInWords;

      let targetNumIdx = -1;
      if (firstIdxInWords !== -1) {
        for (let k = firstIdxInWords; k >= Math.max(0, firstIdxInWords - 6); k--) {
          if (isNumberToken(words[k].raw, targetNo, words, k)) {
            targetNumIdx = k;
            break;
          }
          const mOther = words[k].raw.match(/^(\d+)[.):]?$/);
          if (mOther && mOther[1] !== targetNo && !isDateContext(words, k)) {
            break;
          }
        }
        bestStart = (targetNumIdx !== -1) ? targetNumIdx : firstIdxInWords;
      } else {
        for (let k = winStart; k < winEnd; k++) {
          if (isNumberToken(words[k].raw, targetNo, words, k)) {
            targetNumIdx = k;
            break;
          }
        }
        bestStart = (targetNumIdx !== -1) ? targetNumIdx : i;
      }
    }
  }

  if (bestStart === -1 || bestScore < 8) return null;

  let startIdx = Math.max(bestStart, barrierIdx);
  let detectedPdfNo = null;

  let foundTargetNo = false;
  for (let b = bestStart; b >= Math.max(barrierIdx, bestStart - 6); b--) {
    if (isNumberToken(words[b].raw, targetNo, words, b)) {
      startIdx = b;
      detectedPdfNo = parseInt(targetNo, 10);
      foundTargetNo = true;
      break;
    }
    const mOther = words[b].raw.match(/^(\d+)[.):]?$/);
    if (mOther && mOther[1] !== targetNo && !isDateContext(words, b)) {
      break;
    }
  }


  if (!foundTargetNo) {
    if (isNumberToken(words[bestStart].raw, targetNo, words, bestStart)) {
      startIdx = bestStart;
      detectedPdfNo = parseInt(targetNo, 10);
      foundTargetNo = true;
    } else if (bestStart + 1 < words.length && isNumberToken(words[bestStart + 1].raw, targetNo, words, bestStart + 1)) {
      startIdx = bestStart + 1;
      detectedPdfNo = parseInt(targetNo, 10);
      foundTargetNo = true;
    }
  }

  if (!foundTargetNo && bestFirstTokIdx !== -1) {
    for (let b = bestFirstTokIdx - 1; b >= Math.max(0, bestFirstTokIdx - 4); b--) {
      const bRaw = words[b].raw.trim();
      if (isDateContext(words, b) || bRaw.endsWith(")")) break;
      if (/^(dr|prof|mr|mrs|ms|shri|smt)\.?$/i.test(normalize(bRaw))) continue;
      const m = bRaw.match(/^[\(\[]?(\d+)[.)\]]?$/);
      if (m) {
        const isSameLine = Math.abs((words[b].deskewedY ?? words[b].top) - (words[bestFirstTokIdx].deskewedY ?? words[bestFirstTokIdx].top)) <= 12;
        const isLeftMargin = words[b].left < 220;
        const bulletNo = parseInt(m[1], 10);
        if (isLeftMargin || isSameLine) {
          startIdx = b;
          detectedPdfNo = bulletNo;
        }
        break;
      }
      if (alphaOnly(bRaw).length >= 2) break;
    }
  }

  if (startIdx > 0 && /^[(\[#]$/.test(words[startIdx - 1].raw.trim())) {
    startIdx--;
  }

  let endIdx = words.length;
  let datesFound = 0;
  const startTop = words[startIdx].deskewedY ?? words[startIdx].top;

  for (let j = startIdx + 1; j < words.length; j++) {
    const raw = words[j].raw.trim();

    // Safety limit: visitor entry cannot exceed 38 words or 350 vertical pixels
    if (j > startIdx + 38 || ((words[j].deskewedY ?? words[j].top) - startTop > 350)) {
      endIdx = j;
      break;
    }

    if (isClosingParagraph(words, j)) {
      endIdx = j;
      break;
    }

    const lookaheadSnippet = words.slice(j, Math.min(j + 4, words.length)).map(x => normalize(x.raw)).join(" ");
    if (/^(note|remark|remarks|please\s+note|the\s+above\s+(three|two|four|guests|visitors|family)|approval\s+for\s+prof)/i.test(lookaheadSnippet)) {
      endIdx = j;
      break;
    }

    if (detectedPdfNo !== null) {
      if (isNumberToken(raw, String(detectedPdfNo + 1), words, j) || (raw === String(detectedPdfNo + 1) + ".")) {
        const isStartOfLine = (words[j].left <= words[startIdx].left + 80 || words[j].left < 520) && (
          (words[j].deskewedY ?? words[j].top) > (words[startIdx].deskewedY ?? words[startIdx].top) + 8
        );
        if (isStartOfLine && !isDateContext(words, j)) {
          endIdx = j;
          break;
        }
      }
    }

    if (j > startIdx + 3 && /^\d+[.):]$/.test(raw)) {
      const isStartOfLine = (words[j].left <= words[startIdx].left + 80 || words[j].left < 520) && (
        (words[j].deskewedY ?? words[j].top) > (words[startIdx].deskewedY ?? words[startIdx].top) + 8
      );
      if (isStartOfLine && !isDateContext(words, j)) {
        endIdx = j;
        break;
      }
    }


    const dateSpan = getDateSpan(words, j);
    if (dateSpan) {
      datesFound++;
      j = dateSpan.end - 1;

      if (datesFound >= 2 || words[j].raw.endsWith(".") || words[j].raw.endsWith(";")) {
        let stopAt = j + 1;
        if (stopAt < words.length) {
          const nw = words[stopAt];
          const nRaw = nw.raw.trim();
          const nTop = nw.deskewedY ?? nw.top;
          const startTop = words[startIdx].deskewedY ?? words[startIdx].top;
          if (/^\d+[.):]$/.test(nRaw) && nw.left < 220 && nTop > startTop + 8) {
            endIdx = stopAt;
            break;
          }
        }
        let lookaheadNote = "";
        for (let k = stopAt; k < Math.min(words.length, stopAt + 6); k++) {
          lookaheadNote += words[k].raw.trim();
          if (/^\(?(oci|pio)\)?[.,;]?$/i.test(lookaheadNote)) {
            let noteEnd = k + 1;
            while (noteEnd < words.length && /^[.,;)\]]+$/.test(words[noteEnd].raw.trim())) {
              noteEnd++;
            }
            stopAt = noteEnd;
            break;
          }
        }
        if (stopAt < words.length && words[stopAt].raw.trim().startsWith("(")) {
          for (let k = stopAt; k < Math.min(words.length, stopAt + 14); k++) {
            if (words[k].raw.includes(")")) {
              let noteEnd = k + 1;
              while (noteEnd < words.length && /^[.,;)\]]+$/.test(words[noteEnd].raw.trim())) {
                noteEnd++;
              }
              stopAt = noteEnd;
              break;
            }
          }
        }
        endIdx = stopAt;
        break;
      }
    }
  }

  return { start: Math.max(startIdx, barrierIdx), end: endIdx, detectedPdfNo };
}


function findVisitorStartIdx(words, visitor) {
  const b = findVisitorBoundary(words, visitor);
  return b ? b.start : null;
}

function findEndIdx(words, startIdx, nextNo, visitor = null) {
  if (visitor) {
    const b = findVisitorBoundary(words, visitor);
    if (b) return b.end;
  }
  return words.length;
}

function groupIntoLines(segment, yTol = 8) {
  if (!segment || !segment.length) return [];
  const lines = [];
  for (const w of segment) {
    let placed = false;
    const hasDeskew = w.deskewedY !== undefined;
    const hasBaseline = w.baseline !== undefined;
    const tol = hasDeskew ? 8 : (hasBaseline ? 6 : yTol);
    for (const line of lines) {
      const lineBase = hasDeskew ? line[0].deskewedY : (hasBaseline ? line[0].baseline : line[0].top);
      const wBase = hasDeskew ? w.deskewedY : (hasBaseline ? w.baseline : w.top);
      if (Math.abs(lineBase - wBase) <= tol) {
        line.push(w);
        placed = true;
        break;
      }
    }
    if (!placed) {
      lines.push([w]);
    }
  }
  lines.sort((a, b) => {
    const aBase = a[0].deskewedY !== undefined ? a[0].deskewedY : (a[0].baseline !== undefined ? a[0].baseline : a[0].top);
    const bBase = b[0].deskewedY !== undefined ? b[0].deskewedY : (b[0].baseline !== undefined ? b[0].baseline : b[0].top);
    return aBase - bBase;
  });
  for (const line of lines) {
    line.sort((a, b) => a.left - b.left);
  }
  return lines;
}

function hexToRgb(hex) {
  const cleanHex = hex.replace("#", "");
  return {
    r: parseInt(cleanHex.substring(0, 2), 16),
    g: parseInt(cleanHex.substring(2, 4), 16),
    b: parseInt(cleanHex.substring(4, 6), 16)
  };
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fill();
}

function drawHighlight(ctx, lines, hexColor, padX = 6, padY = 4, radius = 6, opacity = 0.85) {
  if (!lines || !lines.length) return;
  const w = ctx.canvas?.width || 0;
  const h = ctx.canvas?.height || 0;
  if (!w || !h) return;

  const validLines = lines.filter(lw => lw && lw.length > 0);
  if (!validLines.length) return;

  // Sort lines from top to bottom
  const sortedLines = [...validLines].sort((a, b) => {
    const aTop = a[0].deskewedY !== undefined ? a[0].deskewedY : Math.min(...a.map(x => x.top));
    const bTop = b[0].deskewedY !== undefined ? b[0].deskewedY : Math.min(...b.map(x => x.top));
    return aTop - bTop;
  });

  // Use offscreen mask canvas if available to eliminate double-multiplication artifacts (dark orange overlap seams)
  const useMask = typeof document !== "undefined" && typeof document.createElement === "function";
  let targetCtx = ctx;
  let maskCanvas = null;

  if (useMask) {
    maskCanvas = document.createElement("canvas");
    maskCanvas.width = w;
    maskCanvas.height = h;
    targetCtx = maskCanvas.getContext("2d");
    targetCtx.fillStyle = "#FFFFFF";
    targetCtx.fillRect(0, 0, w, h);
  } else {
    ctx.save();
    ctx.globalAlpha = Math.max(0.1, Math.min(1.0, opacity));
    ctx.globalCompositeOperation = "multiply";
  }

  targetCtx.fillStyle = hexColor;

  for (let i = 0; i < sortedLines.length; i++) {
    const lw = sortedLines[i];
    const lineMinLeft = Math.min(...lw.map(x => x.left));
    const lineMaxRight = Math.max(...lw.map(x => x.right));
    const lineMinTop = Math.min(...lw.map(x => x.top));
    const lineMaxBottom = Math.max(...lw.map(x => x.bottom));

    // Determine skew angle for this line
    let skew = lw[0]?.pageSkew;
    if (skew === undefined || skew === null) {
      if (lw.length >= 2) {
        const firstW = lw[0];
        const lastW = lw[lw.length - 1];
        const dx = lastW.left - firstW.left;
        if (dx > 120) {
          const b1 = firstW.baseline !== undefined ? firstW.baseline : firstW.top;
          const b2 = lastW.baseline !== undefined ? lastW.baseline : lastW.top;
          const dy = b2 - b1;
          if (Math.abs(dy) <= 25) {
            skew = dy / dx;
          }
        }
      }
    }
    const theta = (skew && Math.abs(skew) >= 0.003 && Math.abs(skew) <= 0.2) ? Math.atan(skew) : 0;

    let effectivePadYTop = padY;
    let effectivePadYBottom = padY;

    // Prevent vertical overlap with previous line
    if (i > 0) {
      const prevLw = sortedLines[i - 1];
      const prevBottom = Math.max(...prevLw.map(x => x.bottom));
      const gapAbove = lineMinTop - prevBottom;
      if (gapAbove > 0) {
        effectivePadYTop = Math.min(padY, Math.max(0, Math.floor(gapAbove / 2) - 1));
      } else {
        effectivePadYTop = 0;
      }
    }

    // Prevent vertical overlap with next line
    if (i < sortedLines.length - 1) {
      const nextLw = sortedLines[i + 1];
      const nextTop = Math.min(...nextLw.map(x => x.top));
      const gapBelow = nextTop - lineMaxBottom;
      if (gapBelow > 0) {
        effectivePadYBottom = Math.min(padY, Math.max(0, Math.floor(gapBelow / 2) - 1));
      } else {
        effectivePadYBottom = 0;
      }
    }

    if (Math.abs(theta) >= 0.003) {
      // Line is tilted: rotate drawing context so the highlight hugs the slant precisely!
      const cx = (lineMinLeft + lineMaxRight) / 2;
      const heights = lw.map(x => x.bottom - x.top).filter(h => h > 5 && h < 50);
      const avgH = heights.length > 0 ? (heights.reduce((a, b) => a + b, 0) / heights.length) : 18;
      const cyBase = lw.reduce((acc, x) => {
        const b = x.baseline !== undefined ? x.baseline : (x.top + avgH);
        return acc + (b - skew * (x.left - cx));
      }, 0) / lw.length;
      const cy = cyBase - (avgH * 0.45);

      const textWidth = (lineMaxRight - lineMinLeft) / Math.cos(theta);
      const rx = -textWidth / 2 - padX;
      const ry = -avgH / 2 - effectivePadYTop;
      const rw = textWidth + 2 * padX;
      const rh = avgH + effectivePadYTop + effectivePadYBottom;

      if (rw > 0 && rh > 0) {
        targetCtx.save();
        targetCtx.translate(cx, cy);
        targetCtx.rotate(theta);
        drawRoundedRect(targetCtx, rx, ry, rw, rh, radius);
        targetCtx.restore();
      }
    } else {
      // Standard horizontal line
      const minLeft = Math.max(0, lineMinLeft - padX);
      const minTop = Math.max(0, lineMinTop - effectivePadYTop);
      const maxRight = Math.min(w, lineMaxRight + padX);
      const maxBottom = Math.min(h, lineMaxBottom + effectivePadYBottom);

      const rw = maxRight - minLeft;
      const rh = maxBottom - minTop;
      if (rw > 0 && rh > 0) {
        drawRoundedRect(targetCtx, minLeft, minTop, rw, rh, radius);
      }
    }
  }

  if (useMask) {
    ctx.save();
    ctx.globalAlpha = Math.max(0.1, Math.min(1.0, opacity));
    ctx.globalCompositeOperation = "multiply";
    ctx.drawImage(maskCanvas, 0, 0);
    ctx.restore();
  } else {
    ctx.restore();
  }
}

function formatVisitorDisplayName(name) {
  if (!name) return "";
  // Keeps exact word order from Sheet/input; strips commas and collapses multiple spaces
  const cleaned = name.replace(/,/g, " ").trim();
  return cleaned.replace(/\s+/g, " ");
}

function safeFilename(str) {
  if (!str) return "Visitor";
  const cleaned = formatVisitorDisplayName(str).replace(/[\\/*?:"<>|]/g, "").trim();
  return cleaned || "Visitor";
}

function parseVisitorLine(text, sheetIdx) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  let no = "";
  let name = "";
  let details = "";

  // 1. Primary: Match up to " from " (supports names containing commas)
  let m = trimmed.match(/^(\d+)[\.\)]\s*(.+?)\s+from\s+(.+)$/i);
  if (m) {
    no = m[1];
    name = m[2].trim();
    details = m[3].trim();
  } else {
    // 2. Secondary: If no " from ", match up to parenthesis or end
    let m2 = trimmed.match(/^(\d+)[\.\)]\s*(.+?)(?:\s*\(|$)/);
    if (m2) {
      no = m2[1];
      name = m2[2].trim();
    } else {
      let m3 = trimmed.match(/^(\d+)[\.\)]\s*(.+)/);
      if (m3) {
        no = m3[1];
        name = m3[2].trim();
      } else {
        let m4 = trimmed.match(/^(.+?)\s+from\s+(.+)$/i);
        if (m4) {
          name = m4[1].trim();
          details = m4[2].trim();
        } else {
          name = trimmed;
        }
      }
    }
  }

  name = name.replace(/\s*\((retired|ret|retd)[^)]*$/i, "").trim();

  return {
    uid: `v_${sheetIdx}`,
    no: no,
    name: name,
    details: details,
    text: trimmed,
    sheet_idx: sheetIdx
  };
}

// ── Event Handlers & State Updates ──────────────────────────────

function parseVisitorInput() {
  const lines = elements.inputVisitors.value.split("\n").filter(l => l.trim().length > 0);
  const visitors = [];

  lines.forEach((line, idx) => {
    const v = parseVisitorLine(line, idx);
    if (v) {
      visitors.push(v);
    }
  });

  state.visitors = visitors;
  elements.badgeVisitorCount.textContent = `${visitors.length} visitor${visitors.length === 1 ? "" : "s"}`;

  if (visitors.length > 0) {
    elements.containerParsedVisitors.classList.remove("hidden");
    elements.listParsedVisitors.innerHTML = visitors
      .map((v, idx) => `<span class="px-2 py-0.5 bg-sky-50 text-sky-800 rounded-md border border-sky-200 inline-flex items-center space-x-1 text-xs">
        <span class="font-bold text-sky-900">#${idx + 1}</span>
        <span class="text-[10px] text-sky-600 bg-sky-100 px-1 py-0.2 rounded font-mono">Doc #${v.no}</span>
        <span class="font-medium truncate max-w-[150px] sm:max-w-[200px]" title="${v.name}">${v.name}</span>
      </span>`)
      .join("");
  } else {
    elements.containerParsedVisitors.classList.add("hidden");
  }

  checkStartEligibility();
}

function checkStartEligibility() {
  const ready = state.visitors.length > 0 && state.uploadedFiles.length > 0 && !state.isProcessing;
  elements.btnStartProcess.disabled = !ready;
}

function handlePdfUpload(files) {
  for (const file of files) {
    if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
      if (!state.uploadedFiles.some(f => f.name === file.name && f.size === file.size)) {
        state.uploadedFiles.push(file);
        appendLog(`Added PDF: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
      }
    }
  }
  renderPdfFileList();
  checkStartEligibility();
}

function renderPdfFileList() {
  const count = state.uploadedFiles.length;
  elements.badgePdfCount.textContent = `${count} file${count === 1 ? "" : "s"}`;

  if (count === 0) {
    elements.listPdfFiles.innerHTML = "";
    return;
  }

  elements.listPdfFiles.innerHTML = state.uploadedFiles
    .map((file, idx) => `
      <div class="flex items-center justify-between p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs">
        <div class="flex items-center space-x-2 truncate">
          <i data-lucide="file" class="w-4 h-4 text-sky-600 shrink-0"></i>
          <span class="font-medium text-slate-800 truncate" title="${file.name}">${file.name}</span>
          <span class="text-[10px] text-slate-400">(${(file.size / 1024 / 1024).toFixed(2)} MB)</span>
        </div>
        <button onclick="removePdf(${idx})" class="text-slate-400 hover:text-rose-500 p-1 transition" title="Remove">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
        </button>
      </div>
    `)
    .join("");

  lucide.createIcons();
}

window.removePdf = function(index) {
  state.uploadedFiles.splice(index, 1);
  renderPdfFileList();
  checkStartEligibility();
};

// ── Text Extraction & OCR Engine ────────────────────────────────

function timeoutPromise(promise, ms, errMessage) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(errMessage)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function estimatePageSkew(words) {
  if (!words || words.length < 2) return 0;
  const slopes = [];
  for (let i = 0; i < words.length - 1; i++) {
    const w1 = words[i];
    const w2 = words[i + 1];
    const dx = w2.left - w1.left;
    if (dx > 10 && dx < 160) {
      const b1 = w1.baseline !== undefined ? w1.baseline : w1.top;
      const b2 = w2.baseline !== undefined ? w2.baseline : w2.top;
      const dy = b2 - b1;
      if (Math.abs(dy) <= 20) {
        slopes.push(dy / dx);
      }
    }
  }
  if (slopes.length === 0) return 0;
  slopes.sort((a, b) => a - b);
  return slopes[Math.floor(slopes.length / 2)];
}

async function extractWordsFromPage(page, viewport, canvas, ocrMode = "auto") {
  let words = [];
  const textContent = await page.getTextContent();
  const rawDigitalText = (textContent?.items || []).map(it => it.str || "").join(" ").trim();
  // True digital sanction letter pages have at least 60 alphanumeric characters and dozens of words
  const cleanCharCount = rawDigitalText.replace(/[^a-zA-Z0-9]/g, "").length;
  const hasSubstantialDigitalText = cleanCharCount >= 60;

  // Decide whether to run digital extraction (fast 5ms extraction for born-digital pages)
  const shouldRunDigital = ocrMode !== "force" && (hasSubstantialDigitalText || ocrMode === "digital");

  if (shouldRunDigital) {
    let blockCounter = 1;
    let lastY = null;

    for (const item of textContent.items) {
      if (!item.str || !item.str.trim()) continue;

      const tx = item.transform[4];
      const ty = item.transform[5];
      const pt = viewport.convertToViewportPoint(tx, ty);

      const fontHeight = Math.hypot(item.transform[2], item.transform[3]) || 
                         Math.hypot(item.transform[0], item.transform[1]) || 
                         item.height || 10;
      const scaledFont = fontHeight * viewport.scale;
      const baselineY = pt[1];
      const x = pt[0];
      const y = baselineY - (scaledFont * 0.85);
      const w = item.width * viewport.scale;
      const h = scaledFont * 1.1;

      if (lastY !== null && Math.abs(baselineY - lastY) > 25) {
        blockCounter++;
      }
      lastY = baselineY;

      const rawWords = item.str.split(/\s+/).filter(Boolean);
      if (rawWords.length === 1) {
        const trimmedStr = item.str.trim();
        const ratio = item.str.length > 0 ? trimmedStr.length / item.str.length : 1;
        const actualWidth = Math.min(w * ratio, trimmedStr.length * scaledFont * 1.2);
        words.push({
          raw: trimmedStr,
          norm: normalize(trimmedStr),
          left: x,
          top: y,
          right: x + actualWidth,
          bottom: y + h,
          baseline: baselineY,
          block: blockCounter
        });
      } else {
        const avgCharWidth = w / item.str.length;
        let currX = x;
        for (const rw of rawWords) {
          const rwWidth = Math.min(rw.length * avgCharWidth, rw.length * scaledFont * 1.2);
          words.push({
            raw: rw,
            norm: normalize(rw),
            left: currX,
            top: y,
            right: currX + rwWidth,
            bottom: y + h,
            baseline: baselineY,
            block: blockCounter
          });
          currX += rwWidth + avgCharWidth;
        }
      }
    }

    if (words.length > 0) {
      appendLog(`Extracted ${words.length} digital words from page text layer in 5ms.`);
    }
  }

  // Check if digital text contains actual visitor records or is an incomplete/scanner header
  let hasVisitorContent = false;
  if (words.length > 0 && state.visitors && state.visitors.length > 0) {
    const pageTextNorm = words.map(w => w.norm).join(" ");
    hasVisitorContent = state.visitors.some(v => {
      const parts = cleanVisitorNameParts(v.name);
      return parts.some(p => p.length >= 3 && pageTextNorm.includes(p));
    });
  }

  // If digital extraction yielded fewer than 8 words OR failed to locate any visitor records on the page
  const needsOcr = (words.length < 8 || (!hasVisitorContent && ocrMode !== "digital")) && ocrMode !== "digital";

  if (needsOcr) {
    if (words.length > 0 && !hasVisitorContent) {
      appendLog("Digital text layer appears incomplete (visitors not detected in text layer). Engaging Tesseract OCR...", "ocr");
    }
    if (typeof Tesseract === "undefined") {
      appendLog("Tesseract.js is not loaded. Cannot run OCR on scanned document.", "error");
    } else {
      appendLog("📄 Scanned page detected! Running high-speed Tesseract OCR...", "ocr");

      try {
        const maxDim = 2000;
        const ocrScale = Math.min(1.0, maxDim / Math.max(canvas.width, canvas.height));
        const ocrCanvas = document.createElement("canvas");
        ocrCanvas.width = Math.round(canvas.width * ocrScale);
        ocrCanvas.height = Math.round(canvas.height * ocrScale);
        const ocrCtx = ocrCanvas.getContext("2d");
        ocrCtx.drawImage(canvas, 0, 0, ocrCanvas.width, ocrCanvas.height);

        // Fast adaptive contrast enhancement for pristine OCR character recognition
        try {
          const imgData = ocrCtx.getImageData(0, 0, ocrCanvas.width, ocrCanvas.height);
          const d = imgData.data;
          for (let i = 0; i < d.length; i += 4) {
            const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            const val = gray > 180 ? 255 : (gray < 110 ? 0 : gray);
            d[i] = val;
            d[i + 1] = val;
            d[i + 2] = val;
          }
          ocrCtx.putImageData(imgData, 0, 0);
        } catch (_) {}

        if (!window._tifrOcrWorker) {
          appendLog("Initializing OCR Engine (one-time setup)...", "ocr");
          window._tifrOcrWorker = await Tesseract.createWorker("eng", 1, {
            logger: m => {
              if (m.status === "recognizing text") {
                const pct = Math.round((m.progress || 0) * 100);
                elements.progressStatus.textContent = `OCR in progress: ${pct}%...`;
              }
            }
          });
          await window._tifrOcrWorker.setParameters({
            tessedit_pageseg_mode: '3'
          });
        }

        const ocrPromise = window._tifrOcrWorker.recognize(ocrCanvas);
        const ocrResult = await timeoutPromise(ocrPromise, 90000, "OCR timed out (90s limit)");
        const ocrWords = ocrResult?.data?.words || [];
        const extractedOcrWords = [];
        for (const w of ocrWords) {
          if (!w.text || !w.text.trim() || w.confidence < 15) continue;
          const text = w.text.trim();
          // Check for merged bullet tokens e.g. "2.Ozgur" -> "2." and "Ozgur"
          const mSplit = text.match(/^([(\[]?\d{1,3}[.)\]])([A-Za-z].*)$/);
          if (mSplit) {
            const numPart = mSplit[1];
            const wordPart = mSplit[2];
            const splitRatio = numPart.length / text.length;
            const splitX = w.bbox.x0 + (w.bbox.x1 - w.bbox.x0) * splitRatio;
            extractedOcrWords.push({
              raw: numPart,
              norm: normalize(numPart),
              left: w.bbox.x0 / ocrScale,
              top: w.bbox.y0 / ocrScale,
              right: splitX / ocrScale,
              bottom: w.bbox.y1 / ocrScale,
              baseline: w.baseline ? (w.baseline.y0 / ocrScale) : ((w.bbox.y1 - 3) / ocrScale),
              block: w.block ? w.block.id : 1
            });
            extractedOcrWords.push({
              raw: wordPart,
              norm: normalize(wordPart),
              left: splitX / ocrScale,
              top: w.bbox.y0 / ocrScale,
              right: w.bbox.x1 / ocrScale,
              bottom: w.bbox.y1 / ocrScale,
              baseline: w.baseline ? (w.baseline.y0 / ocrScale) : ((w.bbox.y1 - 3) / ocrScale),
              block: w.block ? w.block.id : 1
            });
          } else {
            extractedOcrWords.push({
              raw: text,
              norm: normalize(text),
              left: w.bbox.x0 / ocrScale,
              top: w.bbox.y0 / ocrScale,
              right: w.bbox.x1 / ocrScale,
              bottom: w.bbox.y1 / ocrScale,
              baseline: w.baseline ? (w.baseline.y0 / ocrScale) : ((w.bbox.y1 - 3) / ocrScale),
              block: w.block ? w.block.id : 1
            });
          }
        }

        if (extractedOcrWords.length > 0) {
          words = extractedOcrWords;
          appendLog(`OCR complete: extracted ${words.length} words from scanned page.`, "ocr");
        }
      } catch (ocrErr) {
        console.warn("OCR Warning:", ocrErr);
        window._tifrOcrWorker = null;
        appendLog(`OCR note: ${ocrErr.message}. Continuing...`, "warn");
      }
    }
  }

  // Deskew coordinate calculation and skew-tolerant reading order preservation
  if (words.length > 0) {
    const pageSkew = estimatePageSkew(words);
    for (const w of words) {
      const base = w.baseline !== undefined ? w.baseline : w.top;
      w.deskewedY = base - (pageSkew * w.left);
      w.pageSkew = pageSkew;
    }

    // Check if the original stream sequence is already in sequential reading order
    let isAlreadyOrdered = true;
    for (let i = 0; i < words.length - 1; i++) {
      const w1 = words[i];
      const w2 = words[i + 1];
      // If w2 is significantly above w1 in deskewed coordinates (by more than 12px), reading order was violated
      if (w2.deskewedY < w1.deskewedY - 12) {
        isAlreadyOrdered = false;
        break;
      }
    }

    if (!isAlreadyOrdered) {
      // Re-sort using deskewed line clustering so tilted lines are never fractured
      const lines = [];
      const tol = 12;
      for (const w of words) {
        let placed = false;
        for (const line of lines) {
          const lineBase = line.reduce((acc, cur) => acc + cur.deskewedY, 0) / line.length;
          if (Math.abs(lineBase - w.deskewedY) <= tol) {
            line.push(w);
            placed = true;
            break;
          }
        }
        if (!placed) {
          lines.push([w]);
        }
      }
      lines.sort((a, b) => a[0].deskewedY - b[0].deskewedY);
      for (const line of lines) {
        line.sort((a, b) => a.left - b.left);
      }
      words = lines.flat();
    }
  }

  return words;
}

async function renderPdfPageToCanvas(page, maxPixelWidth = 1800) {
  const baseViewport = page.getViewport({ scale: 1.0 });
  // High-DPI crisp rendering: renders at up to 2.8x scale (~1660-1800px width)
  // for razor-sharp OCR recognition and high-fidelity output
  const scale = Math.min(2.8, Math.max(0.5, maxPixelWidth / baseViewport.width));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  await page.render({ canvasContext: ctx, viewport }).promise;
  return { canvas, ctx, viewport };
}

function canvasToBlob(canvas, type = "image/jpeg", quality = 0.88) {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

// High-speed JPEG cache: encodes each canvas only once across entire session
async function getCanvasJpgBytes(canvas) {
  if (canvas._jpgBytes) return canvas._jpgBytes;
  const blob = await canvasToBlob(canvas, "image/jpeg", 0.88);
  canvas._jpgBytes = await blob.arrayBuffer();
  return canvas._jpgBytes;
}

// On-demand visitor PDF builder (instant on-demand generation)
async function getOrBuildVisitorPdfBytes(item) {
  if (item.pdfBytes) return item.pdfBytes;
  const vPdfDoc = await PDFLib.PDFDocument.create();
  for (const c of item.canvases) {
    const bytes = await getCanvasJpgBytes(c);
    const img = await vPdfDoc.embedJpg(bytes);
    const page = vPdfDoc.addPage([c.width, c.height]);
    page.drawImage(img, { x: 0, y: 0, width: c.width, height: c.height });
  }
  item.pdfBytes = await vPdfDoc.save();
  return item.pdfBytes;
}

// On-demand combined individual approvals PDF builder
async function getOrBuildCombinedIndividualPdf() {
  if (state.processedResults?.combinedIndividualPdfBytes) {
    return state.processedResults.combinedIndividualPdfBytes;
  }
  const indPdfs = state.processedResults?.individualPdfs || [];
  if (!indPdfs.length) return null;

  const combinedIndDoc = await PDFLib.PDFDocument.create();
  const embeddedImageCache = new Map();

  for (const item of indPdfs) {
    for (const c of item.canvases) {
      let img = embeddedImageCache.get(c);
      if (!img) {
        const bytes = await getCanvasJpgBytes(c);
        img = await combinedIndDoc.embedJpg(bytes);
        embeddedImageCache.set(c, img);
      }
      const page = combinedIndDoc.addPage([c.width, c.height]);
      page.drawImage(img, { x: 0, y: 0, width: c.width, height: c.height });
    }
  }
  const bytes = await combinedIndDoc.save();
  if (state.processedResults) {
    state.processedResults.combinedIndividualPdfBytes = bytes;
    state.processedResults.combinedPdfBytes = bytes;
  }
  return bytes;
}

// On-demand master overview PDF builder
async function getOrBuildCombinedMasterPdf() {
  if (state.processedResults?.combinedMasterPdfBytes) {
    return state.processedResults.combinedMasterPdfBytes;
  }
  const entries = state.processedResults?.combinedEntries || [];
  if (!entries.length) return null;

  const combinedDoc = await PDFLib.PDFDocument.create();
  const embeddedImageCache = new Map();

  for (const entry of entries) {
    for (const c of entry.canvases) {
      let img = embeddedImageCache.get(c);
      if (!img) {
        const bytes = await getCanvasJpgBytes(c);
        img = await combinedDoc.embedJpg(bytes);
        embeddedImageCache.set(c, img);
      }
      const page = combinedDoc.addPage([c.width, c.height]);
      page.drawImage(img, { x: 0, y: 0, width: c.width, height: c.height });
    }
  }
  const bytes = await combinedDoc.save();
  if (state.processedResults) {
    state.processedResults.combinedMasterPdfBytes = bytes;
  }
  return bytes;
}

// ── Private Python Cloud Engine (300 DPI Poppler + Linux Tesseract) ──

async function runPythonHighlighter(pythonApiUrl, highlightColor) {
  const visitorText = elements.inputVisitors.value.trim();
  if (!visitorText) return false;

  const formData = new FormData();
  formData.append("visitor_text", visitorText);
  formData.append("highlight_color", highlightColor || "#FFC101");

  for (const file of state.uploadedFiles) {
    formData.append("files", file, file.name);
  }

  updateProgress(20, "Uploading PDFs to Private Python Cloud Engine...");
  appendLog(`Sending ${state.uploadedFiles.length} PDF(s) to server...`, "ocr");

  const abortCtrl = new AbortController();
  const timeoutId = setTimeout(() => abortCtrl.abort(), 45000);

  let response;
  try {
    updateProgress(35, "Server running native Linux Poppler + Tesseract OCR at 300 DPI...");
    response = await fetch(`${pythonApiUrl}/api/highlight`, {
      method: "POST",
      body: formData,
      signal: abortCtrl.signal
    });
  } catch (netErr) {
    clearTimeout(timeoutId);
    if (netErr.name === "AbortError") {
      throw new Error("Server took >45s (cold start); seamlessly using browser engine");
    }
    throw new Error(`Connection failed (${netErr.message})`);
  }
  clearTimeout(timeoutId);


  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown server error");
    throw new Error(`Server returned HTTP ${response.status}: ${errorText}`);
  }

  updateProgress(75, "Receiving highlighted PDFs & processing results...");
  const zipBlob = await response.blob();
  appendLog(`📦 Received processed archive (${(zipBlob.size / 1024).toFixed(1)} KB) from server.`, "success");

  // Read summary header
  let summary = null;
  const summaryHeader = response.headers.get("X-Processing-Summary");
  if (summaryHeader) {
    try {
      summary = JSON.parse(summaryHeader);
    } catch (e) {
      console.warn("Could not parse X-Processing-Summary:", e);
    }
  }

  // Unpack ZIP
  updateProgress(85, "Extracting and rendering highlighted documents...");
  const zip = await JSZip.loadAsync(zipBlob);

  // 1. Get Master Combined PDF
  let masterBytes = null;
  const masterFile = zip.file("TIFR_All_Visitors_Combined.pdf");
  if (masterFile) {
    masterBytes = await masterFile.async("uint8array");
    appendLog("✓ Master Combined PDF (TIFR_All_Visitors_Combined.pdf) extracted.", "success");
  }

  // 2. Get Individual PDFs
  const individualPdfs = [];
  const foundVisitorUids = new Set();
  const foundVisitorNos = new Set();
  const visitorFileMap = {};

  // Map matched records from summary if present
  if (summary && summary.matched_records) {
    for (const rec of summary.matched_records) {
      const v = state.visitors.find(vis =>
        (vis.sheet_idx !== undefined && vis.sheet_idx === (rec.sheet_idx - 1)) ||
        (String(vis.no) === String(rec.doc_no) && vis.name.toLowerCase().includes(rec.name.toLowerCase().slice(0, 5)))
      ) || state.visitors[rec.sheet_idx - 1];

      if (v) {
        foundVisitorUids.add(v.uid);
        foundVisitorNos.add(v.no);
        visitorFileMap[v.uid] = {
          pdfName: rec.pdf,
          page: rec.page,
          visitor: v
        };
        if (!visitorFileMap[v.no]) {
          visitorFileMap[v.no] = visitorFileMap[v.uid];
        }
      }
    }
  }

  // Extract each file inside zip
  const zipEntries = Object.keys(zip.files);
  for (const zipPath of zipEntries) {
    if (zipPath.endsWith("/") || !zipPath.toLowerCase().endsWith(".pdf")) continue;
    if (zipPath === "TIFR_All_Visitors_Combined.pdf") continue;

    const fileObj = zip.files[zipPath];
    const pdfBytes = await fileObj.async("uint8array");
    const baseName = zipPath.split("/").pop();

    let matchedVisitor = null;
    const vNameInFile = baseName.replace(/^TIFR Approval -\s*/i, "").replace(/\.pdf$/i, "").trim();

    for (const v of state.visitors) {
      const vClean = safeFilename(formatVisitorDisplayName(v.name)).toLowerCase();
      if (vClean === vNameInFile.toLowerCase()) {
        matchedVisitor = v;
        break;
      }
    }

    if (!matchedVisitor) {
      for (const v of state.visitors) {
        const vClean = safeFilename(v.name).toLowerCase();
        if (vNameInFile.toLowerCase().includes(vClean) || vClean.includes(vNameInFile.toLowerCase())) {
          matchedVisitor = v;
          break;
        }
      }
    }

    if (!matchedVisitor) {
      for (const v of state.visitors) {
        const tokens = v.name.toLowerCase().split(/\s+/).filter(t => t.length >= 3);
        if (tokens.some(t => vNameInFile.toLowerCase().includes(t))) {
          matchedVisitor = v;
          break;
        }
      }
    }

    if (matchedVisitor) {
      foundVisitorUids.add(matchedVisitor.uid);
      foundVisitorNos.add(matchedVisitor.no);
      if (!visitorFileMap[matchedVisitor.uid]) {
        visitorFileMap[matchedVisitor.uid] = {
          pdfName: matchedVisitor.pdfName || "TIFR Document",
          visitor: matchedVisitor
        };
      }
    }

    individualPdfs.push({
      name: baseName,
      pdfBytes: pdfBytes,
      visitor: matchedVisitor || { name: vNameInFile, no: "1", uid: `v_ext_${individualPdfs.length}`, sheet_idx: individualPdfs.length },
      canvases: []
    });
  }

  // Sort individual PDFs by original spreadsheet order and ensure strict uniqueness
  individualPdfs.sort((a, b) => {
    const sA = a.visitor?.sheet_idx !== undefined ? a.visitor.sheet_idx : 999;
    const sB = b.visitor?.sheet_idx !== undefined ? b.visitor.sheet_idx : 999;
    return sA - sB;
  });

  const uniqueIndividualPdfs = [];
  const seenPdfs = new Set();
  for (const item of individualPdfs) {
    const key = item.visitor ? (item.visitor.uid || String(item.visitor.no)) : item.name;
    if (!seenPdfs.has(key)) {
      seenPdfs.add(key);
      uniqueIndividualPdfs.push(item);
    }
  }
  individualPdfs.length = 0;
  individualPdfs.push(...uniqueIndividualPdfs);

  // Render preview canvases for the Live Document Viewer
  updateProgress(90, "Rendering preview pages for Live Viewer...");
  const combinedEntries = [];

  if (masterBytes) {
    try {
      const masterDoc = await pdfjsLib.getDocument({ data: masterBytes }).promise;
      const masterCanvases = [];
      for (let p = 1; p <= masterDoc.numPages; p++) {
        const page = await masterDoc.getPage(p);
        const { canvas } = await renderPdfPageToCanvas(page, 1800);
        masterCanvases.push(canvas);
      }
      combinedEntries.push({
        minSheetIdx: 0,
        canvases: masterCanvases,
        rawCanvases: masterCanvases,
        pageWordsList: [],
        visitors: state.visitors.filter(v => foundVisitorUids.has(v.uid)),
        visitorSegments: {},
        pdfName: "Master Combined Document"
      });
    } catch (e) {
      console.warn("Could not render master canvases:", e);
    }
  }

  // Assign master canvases immediately so Live Viewer and UI finish in <1 second
  for (const item of individualPdfs) {
    item.canvases = masterCanvases;
    if (item.visitor && visitorFileMap[item.visitor.uid]) {
      visitorFileMap[item.visitor.uid].canvases = masterCanvases;
    }
  }

  // Progressively render exact single-visitor letter canvases in background without freezing the UI
  setTimeout(async () => {
    for (const item of individualPdfs) {
      if (item.pdfBytes && item.canvases === masterCanvases) {
        try {
          const indDoc = await pdfjsLib.getDocument({ data: item.pdfBytes }).promise;
          const indCanvases = [];
          for (let p = 1; p <= indDoc.numPages; p++) {
            const page = await indDoc.getPage(p);
            const { canvas } = await renderPdfPageToCanvas(page, 1800);
            indCanvases.push(canvas);
          }
          item.canvases = indCanvases;
          if (item.visitor && visitorFileMap[item.visitor.uid]) {
            visitorFileMap[item.visitor.uid].canvases = indCanvases;
          }
        } catch (e) {
          // Keep shared master canvases as fallback
        }
      }
    }
  }, 200);

  updateProgress(100, "Server Scan Complete! Ready in Live Viewer.");
  setTimeout(() => elements.progressContainer.classList.add("hidden"), 500);

  state.processedResults = {
    foundVisitorUids,
    foundVisitorNos,
    visitorFileMap,
    individualPdfs,
    combinedIndividualPdfBytes: null,
    combinedMasterPdfBytes: masterBytes,
    combinedPdfBytes: masterBytes,
    combinedEntries,
    zipBlob: zipBlob,
    visitorSegments: {}
  };

  renderResultsSummary();
  return true;
}

// ── Main Processing Pipeline ───────────────────────────────────

async function runHighlighter() {
  if (state.visitors.length === 0 || state.uploadedFiles.length === 0) return;

  state.isProcessing = true;
  elements.btnStartProcess.disabled = true;
  elements.progressContainer.classList.remove("hidden");
  elements.downloadActions?.classList.add("hidden");
  elements.bannerMissing.classList.add("hidden");
  elements.statusPill.textContent = "Scanning documents...";
  elements.statusPill.className = "text-xs px-2.5 py-0.5 rounded-full font-medium bg-amber-100 text-amber-800 animate-pulse";

  clearLogs();
  appendLog(`🚀 TIFR Highlighter Engine v3.5.0 Pro (Master Combined & Exact Name Order Active)`, "success");
  appendLog(`Starting scan for ${state.visitors.length} visitors across ${state.uploadedFiles.length} file(s)...`);

  try {
    const ocrMode = localStorage.getItem("tifr_cfg_ocr_mode") || elements.cfgOcrMode?.value || "auto";
    const padX = parseInt(localStorage.getItem("tifr_cfg_pad_x") || "6", 10);
    const padY = parseInt(localStorage.getItem("tifr_cfg_pad_y") || elements.cfgPadY?.value || "4", 10);
    const radius = parseInt(localStorage.getItem("tifr_cfg_radius") || elements.cfgRadius?.value || "6", 10);
    const threshold = parseInt(localStorage.getItem("tifr_cfg_threshold") || elements.cfgThreshold?.value || "140", 10);
    const opacity = parseFloat(localStorage.getItem("tifr_cfg_opacity") || "85") / 100;
    const highlightColor = localStorage.getItem("tifr_cfg_color") || elements.cfgHighlightColor?.value || "#FFC101";

    state.styleConfigs = { highlightColor, padX, padY, radius, opacity, threshold };

    // Auto-switch to Document Preview on mobile/tablet so user sees results
    if (window.innerWidth < 1024) {
      const tabViewer = document.getElementById("tab-mobile-viewer");
      if (tabViewer) tabViewer.click();
    }

    // ── Primary Engine: Private Python Cloud Engine ───────────
    const usePythonApi = localStorage.getItem("tifr_cfg_use_python_api") !== "false";
    const pythonApiUrl = (localStorage.getItem("tifr_cfg_python_api_url") || "https://tifr-highlighter-api.onrender.com").replace(/\/+$/, "");

    if (usePythonApi && pythonApiUrl) {
      try {
        appendLog(`⚡ Connecting to Private Python Cloud Engine (${pythonApiUrl})...`, "ocr");
        const apiSuccess = await runPythonHighlighter(pythonApiUrl, highlightColor);
        if (apiSuccess) {
          return;
        }
      } catch (apiErr) {
        appendLog(`⚠️ Python Cloud Engine notice: ${apiErr.message}`, "warn");
        appendLog(`Switching seamlessly to high-speed in-browser OCR engine...`, "info");
      }
    }

    // ── Fallback Engine: Client-Side Browser OCR ─────────────
    const foundVisitorUids = new Set();
    const foundVisitorNos = new Set();
    const visitorFileMap = {};
    const individualPdfs = [];
    const combinedEntries = [];
    const allVisitorSegments = {};

    const totalFiles = state.uploadedFiles.length;

    for (let fIdx = 0; fIdx < totalFiles; fIdx++) {
      const file = state.uploadedFiles[fIdx];
      updateProgress((fIdx / totalFiles) * 80, `Reading ${file.name}...`);
      appendLog(`--- File [${fIdx + 1}/${totalFiles}]: ${file.name} ---`);

      const fileBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: fileBuffer }).promise;
      const numPages = pdf.numPages;
      appendLog(`PDF contains ${numPages} page(s).`);

      const rawCanvases = [];
      const pageWordsList = [];

      for (let p = 1; p <= numPages; p++) {
        updateProgress(
          (fIdx / totalFiles) * 80 + ((p / numPages) * (80 / totalFiles)),
          `Scanning ${file.name} (Page ${p}/${numPages})...`
        );
        appendLog(`Processing Page ${p}/${numPages}...`);
        const page = await pdf.getPage(p);
        const { canvas, ctx, viewport } = await renderPdfPageToCanvas(page, 1800);
        const words = await extractWordsFromPage(page, viewport, canvas, ocrMode);

        rawCanvases.push(canvas);
        pageWordsList.push(words);
      }

      const visitorsInThisPdf = [];
      const visitorSegments = {};

      // Detect visitors
      for (const v of state.visitors) {
        // Strict multi-document isolation: skip visitors already matched in an earlier PDF!
        if (foundVisitorUids.has(v.uid) || foundVisitorNos.has(String(v.no))) {
          continue;
        }

        const segs = {};

        for (let pNum = 0; pNum < pageWordsList.length; pNum++) {
          const words = pageWordsList[pNum];
          const boundary = findVisitorBoundary(words, v);

          if (boundary !== null) {
            appendLog(`✅ MATCH: Visitor [${v.no}] "${v.name}" matched on Page ${pNum + 1}!`, "success");
            segs[pNum] = {
              start: boundary.start,
              end: boundary.end
            };
            break; // A visitor entry only appears once per document; stop searching further pages
          }
        }

        if (Object.keys(segs).length > 0) {
          foundVisitorUids.add(v.uid);
          foundVisitorNos.add(String(v.no));
          visitorsInThisPdf.push(v);
          visitorSegments[v.uid] = segs;
          visitorSegments[v.no] = segs;
        }
      }

      if (visitorsInThisPdf.length === 0) {
        appendLog(`No matching visitors automatically detected in ${file.name}. (Available for manual highlighting)`, "warn");
        combinedEntries.push({
          minSheetIdx: 9999 + fIdx,
          canvases: [...rawCanvases],
          rawCanvases: rawCanvases,
          pageWordsList: pageWordsList,
          visitors: [],
          visitorSegments: {},
          pdfName: file.name
        });
        continue;
      }

      appendLog(`Found ${visitorsInThisPdf.length} visitor(s) in ${file.name}. Generating highlighted PDFs...`, "success");

      // Generate individual PDFs (High-speed shared unhighlighted canvases)
      for (const v of visitorsInThisPdf) {
        const segs = visitorSegments[v.uid] || visitorSegments[v.no];
        const vCanvases = [];

        for (let pNum = 0; pNum < rawCanvases.length; pNum++) {
          const origCanvas = rawCanvases[pNum];
          if (segs[pNum]) {
            // Only clone and highlight the specific page containing this visitor!
            const canvasCopy = document.createElement("canvas");
            canvasCopy.width = origCanvas.width;
            canvasCopy.height = origCanvas.height;
            const copyCtx = canvasCopy.getContext("2d");
            copyCtx.drawImage(origCanvas, 0, 0);

            const { start, end } = segs[pNum];
            const lines = groupIntoLines(pageWordsList[pNum].slice(start, end));
            drawHighlight(copyCtx, lines, highlightColor, padX, padY, radius, opacity);
            vCanvases.push(canvasCopy);
          } else {
            // Share the base page canvas directly: zero CPU and zero memory overhead!
            vCanvases.push(origCanvas);
          }
        }

        individualPdfs.push({
          name: `TIFR Approval - ${safeFilename(v.name)}.pdf`,
          pdfBytes: null, // Generated on-demand for maximum speed
          visitor: v,
          canvases: vCanvases,
          rawCanvases: rawCanvases,
          pageWordsList: pageWordsList,
          segments: segs,
          pdfName: file.name
        });

        visitorFileMap[v.uid] = {
          pdfName: file.name,
          canvases: vCanvases,
          visitor: v
        };
        if (!visitorFileMap[v.no]) {
          visitorFileMap[v.no] = visitorFileMap[v.uid];
        }
      }

      // Build Combined Canvas set (Master overview with all visitors highlighted together)
      const combinedCanvases = [];
      for (let pNum = 0; pNum < rawCanvases.length; pNum++) {
        const origCanvas = rawCanvases[pNum];
        const allPageLines = [];
        for (const v of visitorsInThisPdf) {
          const segs = visitorSegments[v.uid] || visitorSegments[v.no];
          if (segs[pNum]) {
            const { start, end } = segs[pNum];
            const lines = groupIntoLines(pageWordsList[pNum].slice(start, end));
            allPageLines.push(...lines);
          }
        }
        if (allPageLines.length > 0) {
          const canvasCopy = document.createElement("canvas");
          canvasCopy.width = origCanvas.width;
          canvasCopy.height = origCanvas.height;
          const copyCtx = canvasCopy.getContext("2d");
          copyCtx.drawImage(origCanvas, 0, 0);
          drawHighlight(copyCtx, allPageLines, highlightColor, padX, padY, radius, opacity);
          combinedCanvases.push(canvasCopy);
        } else {
          // No visitors on this page - share base canvas directly
          combinedCanvases.push(origCanvas);
        }
      }

      const minSheetIdx = Math.min(...visitorsInThisPdf.map(v => v.sheet_idx));
      combinedEntries.push({
        minSheetIdx,
        canvases: combinedCanvases,
        rawCanvases: rawCanvases,
        pageWordsList: pageWordsList,
        visitors: visitorsInThisPdf,
        visitorSegments,
        pdfName: file.name
      });
      Object.assign(allVisitorSegments, visitorSegments);
    }

    // 1. Sort individual PDFs by original spreadsheet order
    individualPdfs.sort((a, b) => a.visitor.sheet_idx - b.visitor.sheet_idx);
    combinedEntries.sort((a, b) => a.minSheetIdx - b.minSheetIdx);

    updateProgress(100, "Scan Complete! Ready in Live Viewer.");
    setTimeout(() => elements.progressContainer.classList.add("hidden"), 500);

    state.processedResults = {
      foundVisitorUids,
      foundVisitorNos,
      visitorFileMap,
      individualPdfs,
      combinedIndividualPdfBytes: null,
      combinedMasterPdfBytes: null,
      combinedPdfBytes: null,
      combinedEntries,
      visitorSegments: allVisitorSegments
    };

    renderResultsSummary();
  } catch (err) {
    console.error("Highlighter Error:", err);
    appendLog(`Processing Error: ${err.message}`, "error");
    alert(`An error occurred while processing: ${err.message}`);
    elements.statusPill.textContent = "Error occurred";
    elements.statusPill.className = "text-xs px-2.5 py-0.5 rounded-full font-medium bg-rose-100 text-rose-800";
  } finally {
    state.isProcessing = false;
    checkStartEligibility();
  }
}

function updateProgress(percent, status) {
  const p = Math.min(100, Math.max(0, Math.round(percent)));
  elements.progressBarFill.style.width = `${p}%`;
  elements.progressPercent.textContent = `${p}%`;
  elements.progressStatus.textContent = status;
}

// ── Render Results & Tables ─────────────────────────────────────

function renderResultsSummary() {
  const { foundVisitorUids, foundVisitorNos, visitorFileMap, individualPdfs, combinedPdfBytes } = state.processedResults;
  const total = state.visitors.length;
  const found = foundVisitorUids ? foundVisitorUids.size : foundVisitorNos.size;
  const missing = total - found;

  elements.statTotal.textContent = total;
  elements.statFound.textContent = found;
  elements.statMissing.textContent = missing;

  if (missing === 0) {
    elements.statusPill.textContent = "All Visitors Found!";
    elements.statusPill.className = "text-xs px-2.5 py-0.5 rounded-full font-medium bg-emerald-100 text-emerald-800";
    elements.bannerMissing.classList.add("hidden");
    appendLog(`All ${total} visitors successfully found and highlighted!`, "success");
  } else {
    elements.statusPill.textContent = `${missing} Visitor${missing === 1 ? "" : "s"} Missing`;
    elements.statusPill.className = "text-xs px-2.5 py-0.5 rounded-full font-medium bg-rose-100 text-rose-800";
    elements.bannerMissing.classList.remove("hidden");

    const missingVisitors = state.visitors.filter(v =>
      foundVisitorUids ? !foundVisitorUids.has(v.uid) : !foundVisitorNos.has(v.no)
    );
    elements.listMissingNames.innerHTML = missingVisitors
      .map((v, idx) => `<li><strong>#${v.sheet_idx !== undefined ? v.sheet_idx + 1 : idx + 1} (Doc #${v.no}):</strong> ${v.name}</li>`)
      .join("");
    appendLog(`${missing} visitor(s) could not be located in the uploaded files.`, "warn");
  }

  // Render Table
  elements.tableResultsBody.innerHTML = state.visitors
    .map((v, idx) => {
      const isFound = foundVisitorUids ? foundVisitorUids.has(v.uid) : foundVisitorNos.has(v.no);
      const matchInfo = isFound ? (visitorFileMap[v.uid] || visitorFileMap[v.no]) : null;
      const pdfName = matchInfo ? matchInfo.pdfName : "—";
      const seqNo = v.sheet_idx !== undefined ? v.sheet_idx + 1 : idx + 1;

      const isRemoved = state.disabledHighlights.has(v.uid) || state.disabledHighlights.has(String(v.no));

      return `
        <tr class="hover:bg-slate-50 transition ${isFound ? '' : 'bg-rose-50/30'}">
          <td class="px-4 py-3 font-mono font-semibold text-slate-700">
            <div class="flex items-center space-x-1.5">
              <span class="text-xs bg-slate-100 text-slate-800 font-bold px-1.5 py-0.5 rounded shadow-2xs">#${seqNo}</span>
              <span class="text-[11px] text-slate-500 font-medium">Doc #${v.no}</span>
            </div>
          </td>
          <td class="px-4 py-3 font-medium text-slate-900">${v.name}</td>
          <td class="px-4 py-3 text-slate-500 truncate max-w-[160px]" title="${pdfName}">${pdfName}</td>
          <td class="px-4 py-3">
            ${isFound
              ? (isRemoved
                  ? `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 text-amber-800">
                      <i data-lucide="eye-off" class="w-3 h-3 mr-1"></i> Removed
                    </span>`
                  : `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-100 text-emerald-800">
                      <i data-lucide="check" class="w-3 h-3 mr-1"></i> Highlighted
                    </span>`
                )
              : `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-rose-100 text-rose-800">
                  <i data-lucide="x" class="w-3 h-3 mr-1"></i> Missing
                </span>`
            }
          </td>
          <td class="px-4 py-3 text-right">
            ${isFound
              ? `<div class="flex items-center justify-end space-x-1">
                  <button onclick="jumpToVisitorPage('${v.uid}')" class="px-2 py-1 rounded bg-sky-50 hover:bg-sky-100 text-sky-700 text-[11px] font-semibold transition" title="Scroll to this visitor in document viewer">
                    View
                  </button>
                  <button onclick="toggleVisitorHighlight('${v.uid}')" class="px-2 py-1 rounded ${isRemoved ? 'bg-amber-100 hover:bg-amber-200 text-amber-800 font-semibold' : 'bg-slate-100 hover:bg-rose-100 text-slate-700 hover:text-rose-700'} text-[11px] font-medium transition" title="${isRemoved ? 'Restore highlight for this visitor' : 'Remove highlight for this visitor'}">
                    ${isRemoved ? 'Restore' : 'Remove'}
                  </button>
                  <button onclick="downloadSinglePdf('${v.uid}')" class="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-medium transition" title="Download individual PDF">
                    PDF
                  </button>
                </div>`
              : `<div class="flex items-center justify-end">
                  <button onclick="startManualHighlight('${v.uid}')" class="px-2 py-1 rounded bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold text-[11px] transition inline-flex items-center gap-1 shadow-2xs" title="Click to manually highlight on document">
                    <i data-lucide="highlighter" class="w-3 h-3"></i> Add Highlight
                  </button>
                </div>`
            }
          </td>
        </tr>
      `;
    })
    .join("");

  lucide.createIcons();

  if (state.processedResults?.individualPdfs?.length > 0 || state.processedResults?.combinedEntries?.length > 0) {
    elements.downloadActions?.classList.remove("hidden");
  }

  // Render the live document viewer directly on the right panel
  renderLiveDocumentViewer();
}

// ── Right Panel: Live Interactive Document Viewer ───────────────

let viewerZoomLevel = 1.0;
let livePagesList = [];

function setViewerMode(mode) {
  state.viewerMode = mode;
  const tabInd = document.getElementById("viewer-tab-individual");
  const tabAll = document.getElementById("viewer-tab-all");
  if (tabInd && tabAll) {
    if (mode === "individual") {
      tabInd.className = "px-2.5 py-1 text-xs font-semibold rounded-md transition bg-sky-600 text-white shadow";
      tabAll.className = "px-2.5 py-1 text-xs font-semibold rounded-md transition text-slate-400 hover:text-slate-200";
    } else {
      tabAll.className = "px-2.5 py-1 text-xs font-semibold rounded-md transition bg-sky-600 text-white shadow";
      tabInd.className = "px-2.5 py-1 text-xs font-semibold rounded-md transition text-slate-400 hover:text-slate-200";
    }
  }
  renderLiveDocumentViewer();
}

function renderLiveDocumentViewer() {
  if (!state.processedResults) return;

  const emptyEl = document.getElementById("live-viewer-empty");
  const contentEl = document.getElementById("live-viewer-content");
  const pagesCountEl = document.getElementById("live-viewer-page-count");
  const jumpSelect = document.getElementById("viewer-jump-select");

  if (emptyEl) emptyEl.classList.add("hidden");
  if (contentEl) contentEl.classList.remove("hidden");

  livePagesList = [];

  if (jumpSelect) {
    jumpSelect.innerHTML = '<option value="">-- Jump to a Visitor --</option>';
  }

  const mode = state.viewerMode || "individual";

  if (mode === "individual") {
    // Mode 1: Individual visitor files (each file contains ONLY that visitor highlighted)
    const indPdfs = state.processedResults.individualPdfs || [];

    indPdfs.forEach((item, itemIdx) => {
      const v = item.visitor;
      const totalSubPages = item.canvases.length;

      item.canvases.forEach((c, cIdx) => {
        const pageId = `live-card-v-${v.uid || v.no}-${cIdx + 1}`;
        const seqNo = v.sheet_idx !== undefined ? v.sheet_idx + 1 : itemIdx + 1;

        let highlightRatioY = null;
        if (item.segments && item.segments[cIdx] && item.pageWordsList && item.pageWordsList[cIdx]) {
          const { start, end } = item.segments[cIdx];
          const slice = item.pageWordsList[cIdx].slice(start, end);
          if (slice.length > 0) {
            const minY = Math.min(...slice.map(w => w.top));
            const maxY = Math.max(...slice.map(w => w.bottom));
            highlightRatioY = ((minY + maxY) / 2) / c.height;
          }
        }

        livePagesList.push({
          id: pageId,
          cardIndex: itemIdx + 1,
          seqNo: seqNo,
          mode: "individual",
          visitorUid: v.uid || `v_${itemIdx}`,
          visitorNo: String(v.no),
          visitorName: v.name,
          pdfFilename: item.name,
          sourcePdfName: item.pdfName,
          subPageNum: cIdx + 1,
          totalSubPages: totalSubPages,
          canvas: c,
          visitor: v,
          highlightRatioY: highlightRatioY
        });

        // Add primary page of each visitor to Jump Select
        if (jumpSelect && cIdx === 0) {
          const opt = document.createElement("option");
          opt.value = pageId;
          opt.textContent = `#${seqNo} • ${v.name} (Doc #${v.no})`;
          jumpSelect.appendChild(opt);
        }
      });
    });

    if (pagesCountEl) {
      pagesCountEl.textContent = `${indPdfs.length} Individual Files • 100% Highlighted`;
      pagesCountEl.className = "text-xs bg-emerald-950/80 text-emerald-300 font-semibold px-2.5 py-0.5 rounded-full border border-emerald-800";
    }

  } else {
    // Mode 2: All highlights overview (source files with all visitors highlighted together)
    let pageCounter = 1;
    const visitorPageMap = {};

    for (const entry of (state.processedResults.combinedEntries || [])) {
      const pdfName = entry.pdfName || "Approval Letter";
      const entryVisitors = entry.visitors || [];
      const entrySegments = entry.visitorSegments || {};

      entry.canvases.forEach((c, cIdx) => {
        const pageId = `live-page-all-${pageCounter}`;

        const onThisPage = entryVisitors.filter(v => {
          const seg = entrySegments[v.uid] || entrySegments[v.no];
          return seg && seg[cIdx] !== undefined;
        });

        const pageVisitors = onThisPage.length > 0 ? onThisPage : (entry.canvases.length === 1 ? entryVisitors : []);

        pageVisitors.forEach(v => {
          if (v.uid && !visitorPageMap[v.uid]) visitorPageMap[v.uid] = pageId;
          if (!visitorPageMap[v.no]) visitorPageMap[v.no] = pageId;
        });

        const pageTitle = pageVisitors.length > 0
          ? `Visitors: ${pageVisitors.map(v => `#${v.no} ${v.name.split(' ')[0]}`).join(", ")}`
          : `Approval Letter`;

        livePagesList.push({
          id: pageId,
          pageNum: pageCounter,
          mode: "all",
          visitorUids: pageVisitors.map(v => v.uid).filter(Boolean),
          visitorNos: pageVisitors.map(v => String(v.no)),
          pageTitle: pageTitle,
          pdfName: pdfName,
          canvas: c,
          visitorSegments: entrySegments,
          pageWordsList: entry.pageWordsList,
          subPageIdx: cIdx
        });

        pageCounter++;
      });
    }

    if (jumpSelect) {
      for (let idx = 0; idx < state.visitors.length; idx++) {
        const v = state.visitors[idx];
        const isFound = state.processedResults.foundVisitorUids
          ? state.processedResults.foundVisitorUids.has(v.uid)
          : state.processedResults.foundVisitorNos.has(v.no);
        if (isFound) {
          const pageId = visitorPageMap[v.uid] || visitorPageMap[v.no];
          const pageItem = pageId ? livePagesList.find(p => p.id === pageId) : null;
          const pageSuffix = pageItem ? ` (Page ${pageItem.pageNum})` : "";
          const opt = document.createElement("option");
          opt.value = pageId || (livePagesList[0] ? livePagesList[0].id : "");
          opt.textContent = `#${idx + 1} • ${v.name} (Doc #${v.no})${pageSuffix}`;
          jumpSelect.appendChild(opt);
        }
      }
    }

    if (pagesCountEl) {
      const countFound = state.processedResults.foundVisitorUids
        ? state.processedResults.foundVisitorUids.size
        : state.processedResults.foundVisitorNos.size;
      pagesCountEl.textContent = `${livePagesList.length} Source Pages • ${countFound} Highlighted`;
      pagesCountEl.className = "text-xs bg-slate-800 text-slate-300 font-semibold px-2.5 py-0.5 rounded-full border border-slate-700";
    }
  }

  updateLiveViewerPages();
}

function updateLiveViewerPages(forceRebuild = false) {
  const contentEl = document.getElementById("live-viewer-content");
  if (!contentEl || !livePagesList.length) return;

  const scrollContainer = document.getElementById("live-viewer-scroll-container");

  // Available container width minus comfortable side padding
  const containerWidth = contentEl.clientWidth > 40 ? contentEl.clientWidth - 24 : 840;

  // Adaptive width that fills the container nicely while maintaining clean readability
  const baseWidth = Math.min(containerWidth, Math.max(480, Math.min(containerWidth, 980)));
  const cardWidth = Math.min(containerWidth, Math.round(baseWidth * viewerZoomLevel));

  const zoomLabel = document.getElementById("viewer-zoom-label");
  if (zoomLabel) {
    zoomLabel.textContent = `${Math.round(viewerZoomLevel * 100)}%`;
  }

  // Fast In-Place Zoom: If cards already exist, simply update width without destroying DOM or resetting scroll
  const existingCards = contentEl.querySelectorAll(".viewer-page-card");
  if (!forceRebuild && existingCards.length === livePagesList.length) {
    const prevScrollRatio = scrollContainer && scrollContainer.scrollHeight > 0
      ? scrollContainer.scrollTop / scrollContainer.scrollHeight
      : 0;

    existingCards.forEach(card => {
      card.style.width = `${cardWidth}px`;
    });

    if (scrollContainer && prevScrollRatio > 0) {
      scrollContainer.scrollTop = Math.round(prevScrollRatio * scrollContainer.scrollHeight);
    }
    return;
  }

  // Anchor current visible card when rebuilding (e.g. on mode switch)
  let activeCardId = null;
  if (scrollContainer && contentEl.children.length > 0) {
    const cards = Array.from(contentEl.querySelectorAll(".viewer-page-card"));
    const containerTop = scrollContainer.getBoundingClientRect().top;
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      if (rect.bottom >= containerTop + 50) {
        activeCardId = card.id;
        break;
      }
    }
  }

  contentEl.innerHTML = "";

  for (const pageItem of livePagesList) {
    const card = document.createElement("div");
    card.id = pageItem.id;
    card.className = "viewer-page-card bg-white rounded-xl shadow-2xl overflow-hidden border border-slate-300 transition-all duration-200 w-full";
    card.style.width = `${cardWidth}px`;
    card.style.maxWidth = "100%";
    card.style.boxSizing = "border-box";

    if (pageItem.mode === "individual") {
      const isRemoved = state.disabledHighlights.has(pageItem.visitorUid) || state.disabledHighlights.has(String(pageItem.visitorNo));

      // Individual Visitor Header Card with dedicated title & actions
      const header = document.createElement("div");
      header.className = "bg-gradient-to-r from-slate-900 to-slate-800 text-white px-4 sm:px-5 py-3 flex items-center justify-between border-b border-slate-700 select-none gap-3";
      header.innerHTML = `
        <div class="flex items-center space-x-3 min-w-0">
          <div class="flex items-center space-x-1.5 shrink-0">
            <span class="bg-amber-400 text-slate-950 font-extrabold text-xs px-2.5 py-1 rounded-md tracking-wide shadow-xs" title="Spreadsheet Sequence">
              #${pageItem.seqNo || pageItem.cardIndex}
            </span>
            <span class="bg-slate-700 text-slate-200 font-semibold text-xs px-2 py-1 rounded-md border border-slate-600 shrink-0" title="Document Number">
              Doc #${pageItem.visitorNo}
            </span>
          </div>
          <div class="min-w-0">
            <div class="font-bold text-sm text-slate-100 truncate flex items-center gap-2">
              <span>${pageItem.visitorName}</span>
              ${isRemoved ? `<span class="bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[10px] font-bold px-2 py-0.5 rounded-full inline-flex items-center gap-1"><i data-lucide="eye-off" class="w-3 h-3 text-amber-400"></i> Highlight Removed</span>` : ''}
            </div>
            <div class="text-[11px] text-slate-400 flex items-center flex-wrap gap-x-2 gap-y-0.5">
              <span class="truncate max-w-[260px] sm:max-w-md">File: <strong class="text-slate-300 font-semibold">${pageItem.sourcePdfName || pageItem.pdfFilename}</strong></span>
              ${pageItem.totalSubPages > 1 ? `<span class="bg-slate-800 text-slate-300 text-[10px] px-1.5 py-0.5 rounded border border-slate-700 shrink-0">Page ${pageItem.subPageNum} of ${pageItem.totalSubPages}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="flex items-center space-x-2 shrink-0">
          <button onclick="toggleVisitorHighlight('${pageItem.visitorUid}')" class="px-2.5 py-1 ${isRemoved ? 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40' : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700'} rounded-md text-[11px] font-medium transition flex items-center space-x-1.5 shadow-xs" title="${isRemoved ? 'Restore highlight for this visitor' : 'Remove highlight for this visitor if done in error'}">
            <i data-lucide="${isRemoved ? 'eye' : 'eraser'}" class="w-3.5 h-3.5 ${isRemoved ? 'text-amber-400' : 'text-slate-400'}"></i>
            <span class="hidden sm:inline">${isRemoved ? 'Restore' : 'Remove'} Highlight</span>
          </button>
          <button onclick="printVisitorCard('${pageItem.visitorUid || pageItem.visitorNo}')" class="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md text-[11px] font-medium text-slate-200 transition flex items-center space-x-1.5 shadow-xs" title="Print this visitor's approval letter">
            <i data-lucide="printer" class="w-3.5 h-3.5 text-sky-400"></i>
            <span class="hidden sm:inline">Print</span>
          </button>
          <button onclick="downloadSinglePdf('${pageItem.visitorUid || pageItem.visitorNo}')" class="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md text-[11px] font-medium text-slate-200 transition flex items-center space-x-1.5 shadow-xs" title="Download this individual approval PDF">
            <i data-lucide="download" class="w-3.5 h-3.5 text-emerald-400"></i>
            <span class="hidden sm:inline">Download</span> PDF
          </button>
          <button onclick="openVisitorNewWindow('${pageItem.visitorUid || pageItem.visitorNo}')" class="px-2.5 py-1 bg-sky-600 hover:bg-sky-500 rounded-md text-[11px] font-medium text-white transition flex items-center space-x-1.5 shadow-xs" title="Open in browser tab">
            <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
            <span>Open</span>
          </button>
        </div>
      `;
      card.appendChild(header);

    } else {
      // All Highlights Header Chip
      const header = document.createElement("div");
      header.className = "bg-slate-100/90 border-b border-slate-200 px-4 py-2.5 flex items-center justify-between text-xs text-slate-700 font-medium select-none";
      header.innerHTML = `
        <div class="flex items-center space-x-2">
          <span class="bg-sky-100 text-sky-800 font-bold px-2 py-0.5 rounded text-[11px]">Page ${pageItem.pageNum} of ${livePagesList.length}</span>
          <span class="font-semibold text-slate-900 truncate max-w-[320px]">${pageItem.pageTitle}</span>
        </div>
        <span class="text-slate-400 text-[11px] truncate max-w-[200px]" title="${pageItem.pdfName}">${pageItem.pdfName}</span>
      `;
      card.appendChild(header);
    }

    // Canvas (Strictly maintains original page aspect ratio)
    const canvas = document.createElement("canvas");
    canvas.width = pageItem.canvas.width;
    canvas.height = pageItem.canvas.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(pageItem.canvas, 0, 0);

    canvas.style.aspectRatio = `${pageItem.canvas.width} / ${pageItem.canvas.height}`;
    canvas.style.objectFit = "contain";
    canvas.style.width = "100%";
    canvas.style.height = "auto";
    // Pointer events for manual highlighting
    canvas.addEventListener("pointerdown", (e) => {
      if (!state.manualHighlight?.active) return;
      canvas._downPos = { x: e.clientX, y: e.clientY };
    });

    canvas.addEventListener("pointerup", (e) => {
      if (!state.manualHighlight?.active || !canvas._downPos) return;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;

      const x1 = (canvas._downPos.x - rect.left) * scaleX;
      const y1 = (canvas._downPos.y - rect.top) * scaleY;
      const x2 = (e.clientX - rect.left) * scaleX;
      const y2 = (e.clientY - rect.top) * scaleY;
      canvas._downPos = null;

      const dist = Math.hypot(x2 - x1, y2 - y1);
      if (dist > 15) {
        window.applyManualHighlightAtPoint(pageItem, x2, y2, { x1, y1, x2, y2 });
      } else {
        window.applyManualHighlightAtPoint(pageItem, x1, y1);
      }
    });

    if (state.manualHighlight?.active) {
      canvas.style.cursor = "crosshair";
    }

    card.appendChild(canvas);
    contentEl.appendChild(card);
  }

  // Render Visitors Directory in drawer
  renderThumbnails();

  // Restore active card view if present
  if (activeCardId) {
    const target = document.getElementById(activeCardId);
    if (target) {
      target.scrollIntoView({ behavior: "instant", block: "start" });
    }
  }

  if (window.lucide) {
    lucide.createIcons();
  }
}

// ── Visitors Directory Drawer (Replaces heavy canvas thumbnails) ──

function renderThumbnails() {
  const thumbListEl = document.getElementById("viewer-thumbnail-list");
  if (!thumbListEl || !state.visitors || !state.visitors.length) return;

  thumbListEl.innerHTML = "";

  const foundUids = state.processedResults?.foundVisitorUids;
  const foundNos = state.processedResults?.foundVisitorNos;
  const fileMap = state.processedResults?.visitorFileMap || {};

  state.visitors.forEach((v, idx) => {
    const isFound = foundUids ? foundUids.has(v.uid) : foundNos?.has(v.no);
    const matchInfo = fileMap[v.uid] || fileMap[v.no];
    const pdfName = matchInfo ? matchInfo.pdfName : "";
    const seq = v.sheet_idx !== undefined ? v.sheet_idx + 1 : idx + 1;
    const isRemoved = state.disabledHighlights.has(v.uid) || state.disabledHighlights.has(String(v.no));

    const itemEl = document.createElement("div");
    itemEl.id = `visitor-dir-item-${v.uid}`;
    itemEl.className = `visitor-dir-card group cursor-pointer border rounded-lg p-2.5 transition-all duration-200 select-none flex flex-col space-y-1.5 ${
      isFound
        ? (isRemoved
            ? "bg-slate-900/60 hover:bg-slate-800/90 border-amber-900/40 hover:border-amber-500/60 text-slate-300"
            : "bg-slate-900/80 hover:bg-slate-800/90 border-slate-800 hover:border-sky-500/60 text-slate-200")
        : "bg-slate-950/40 border-slate-900/80 text-slate-500 opacity-60"
    }`;
    itemEl.setAttribute("data-search", `${v.name.toLowerCase()} ${v.no} ${seq} ${pdfName.toLowerCase()}`);
    itemEl.setAttribute("data-uid", v.uid);

    itemEl.innerHTML = `
      <div class="flex items-center justify-between w-full">
        <div class="flex items-center space-x-1.5 min-w-0">
          <span class="px-1.5 py-0.5 rounded text-[10px] font-extrabold ${isFound ? 'bg-amber-400 text-slate-950' : 'bg-slate-800 text-slate-400'}">
            #${seq}
          </span>
          <span class="text-[10px] font-mono text-slate-400 px-1 py-0.2 rounded bg-slate-800/60">
            Doc #${v.no}
          </span>
        </div>
        ${isFound
          ? (isRemoved
              ? `<span class="inline-flex items-center text-[10px] text-amber-400 font-semibold">
                  <i data-lucide="eye-off" class="w-3 h-3 mr-0.5"></i> Removed
                 </span>`
              : `<span class="inline-flex items-center text-[10px] text-emerald-400 font-semibold">
                  <i data-lucide="check" class="w-3 h-3 mr-0.5"></i> Ready
                 </span>`
            )
          : `<span class="inline-flex items-center text-[10px] text-rose-400/80">
              <i data-lucide="x" class="w-3 h-3 mr-0.5"></i> Missing
             </span>`
        }
      </div>
      <div class="font-semibold text-xs text-slate-100 group-hover:text-sky-300 transition-colors truncate" title="${v.name}">
        ${v.name}
      </div>
      <div class="flex items-center justify-between pt-0.5">
        ${pdfName ? `
          <div class="text-[10px] text-slate-400 truncate flex items-center space-x-1" title="${pdfName}">
            <i data-lucide="file-text" class="w-3 h-3 shrink-0 text-slate-500"></i>
            <span class="truncate max-w-[140px]">${pdfName}</span>
          </div>
        ` : '<div></div>'}
        ${isFound ? `
          <button onclick="event.stopPropagation(); toggleVisitorHighlight('${v.uid}')" class="text-[10px] px-1.5 py-0.5 rounded ${isRemoved ? 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40' : 'bg-slate-800 hover:bg-rose-950/60 text-slate-400 hover:text-rose-300 border border-slate-700'} transition flex items-center gap-1 shadow-2xs" title="${isRemoved ? 'Restore highlight' : 'Remove highlight'}">
            <i data-lucide="${isRemoved ? 'eye' : 'eraser'}" class="w-2.5 h-2.5"></i>
            <span>${isRemoved ? 'Restore' : 'Remove'}</span>
          </button>
        ` : `
          <button onclick="event.stopPropagation(); startManualHighlight('${v.uid}')" class="text-[10px] px-2 py-0.5 rounded bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold transition flex items-center gap-1 shadow-2xs" title="Click to manually highlight on document">
            <i data-lucide="highlighter" class="w-2.5 h-2.5"></i>
            <span>Add Highlight</span>
          </button>
        `}
      </div>
    `;

    itemEl.onclick = () => {
      if (!isFound) {
        startManualHighlight(v.uid);
        return;
      }
      jumpToVisitorPage(v.uid);
    };

    thumbListEl.appendChild(itemEl);
  });

  if (window.lucide) {
    lucide.createIcons();
  }
}

// Search filter for Visitors Directory
const searchVisitorEl = document.getElementById("viewer-visitor-search");
if (searchVisitorEl) {
  searchVisitorEl.addEventListener("input", e => {
    const q = e.target.value.toLowerCase().trim();
    const cards = document.querySelectorAll(".visitor-dir-card");
    cards.forEach(card => {
      const searchData = card.getAttribute("data-search") || "";
      if (!q || searchData.includes(q)) {
        card.classList.remove("hidden");
      } else {
        card.classList.add("hidden");
      }
    });
  });
}

// ── Awesome Visitor Switch & Jump Animation ─────────────────────

window.jumpToVisitorPage = function(targetKey) {
  const keyStr = String(targetKey);

  // If on mobile/tablet screen, auto-switch to Document Preview tab
  if (window.innerWidth < 1024) {
    const tabViewer = document.getElementById("tab-mobile-viewer");
    if (tabViewer) tabViewer.click();
  }

  // Switch to individual mode so the user sees ONLY this visitor's highlighted document
  if (state.viewerMode !== "individual") {
    setViewerMode("individual");
  }

  // 1. Try matching visitorUid
  let pageItem = livePagesList.find(p => p.visitorUid === keyStr);
  // 2. Try matching visitorNo
  if (!pageItem) {
    pageItem = livePagesList.find(p => String(p.visitorNo) === keyStr);
  }
  // 3. Try matching in all mode
  if (!pageItem) {
    pageItem = livePagesList.find(p => (p.visitorUids && p.visitorUids.includes(keyStr)) || (p.visitorNos && p.visitorNos.includes(keyStr)));
  }
  // 4. Try matching via visitorFileMap
  if (!pageItem) {
    const matchInfo = state.processedResults?.visitorFileMap?.[keyStr];
    if (matchInfo) {
      pageItem = livePagesList.find(p => p.pdfName === matchInfo.pdfName || p.sourcePdfName === matchInfo.pdfName);
    }
  }

  if (pageItem) {
    const target = document.getElementById(pageItem.id);
    const jumpSelect = document.getElementById("viewer-jump-select");
    if (jumpSelect) jumpSelect.value = pageItem.id;
    if (target) {
      const scrollContainer = document.getElementById("live-viewer-scroll-container");
      let ratioY = pageItem.highlightRatioY;

      if (ratioY === null || ratioY === undefined) {
        const segs = state.processedResults?.visitorSegments?.[pageItem.visitorUid] ||
                     state.processedResults?.visitorSegments?.[keyStr] ||
                     state.processedResults?.visitorSegments?.[pageItem.visitorNo];
        const pageWordsList = state.processedResults?.pageWordsList || pageItem.pageWordsList;
        const subPageIdx = (pageItem.subPageNum ? pageItem.subPageNum - 1 : (pageItem.subPageIdx || 0));
        if (segs && segs[subPageIdx] && pageWordsList && pageWordsList[subPageIdx]) {
          const { start, end } = segs[subPageIdx];
          const slice = pageWordsList[subPageIdx].slice(start, end);
          if (slice.length > 0) {
            const minY = Math.min(...slice.map(w => w.top));
            const maxY = Math.max(...slice.map(w => w.bottom));
            ratioY = ((minY + maxY) / 2) / (pageItem.canvas?.height || 1000);
          }
        }
      }

      if (scrollContainer && ratioY !== null && ratioY !== undefined && ratioY > 0) {
        const containerRect = scrollContainer.getBoundingClientRect();
        const cardRect = target.getBoundingClientRect();
        const highlightScreenY = (cardRect.top - containerRect.top) + (cardRect.height * ratioY);
        const desiredTop = scrollContainer.scrollTop + highlightScreenY - (containerRect.height / 2);
        scrollContainer.scrollTo({ top: Math.max(0, Math.round(desiredTop)), behavior: "smooth" });
      } else {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      target.classList.remove("viewer-card-active-glow");
      void target.offsetWidth; // Force CSS reflow to re-trigger keyframe animation smoothly
      target.classList.add("viewer-card-active-glow");
      setTimeout(() => target.classList.remove("viewer-card-active-glow"), 1800);
    }

    // Highlight the active card in the Visitors Directory sidebar
    document.querySelectorAll(".visitor-dir-card").forEach(el => {
      el.classList.remove("border-sky-500", "bg-sky-950/70", "ring-1", "ring-sky-400", "text-sky-200");
    });
    const dirCard = document.getElementById(`visitor-dir-item-${pageItem.visitorUid}`) ||
                    document.getElementById(`visitor-dir-item-${targetKey}`);
    if (dirCard) {
      dirCard.classList.add("border-sky-500", "bg-sky-950/70", "ring-1", "ring-sky-400", "text-sky-200");
      dirCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }
};

// ── Remove & Restore Highlight Toggle ───────────────────────────

function refreshCanvasesAfterToggle() {
  if (!state.processedResults) return;

  const cfg = state.styleConfigs || {
    highlightColor: localStorage.getItem("tifr_cfg_color") || "#FFC101",
    padX: parseInt(localStorage.getItem("tifr_cfg_pad_x") || "6", 10),
    padY: parseInt(localStorage.getItem("tifr_cfg_pad_y") || "4", 10),
    radius: parseInt(localStorage.getItem("tifr_cfg_radius") || "6", 10),
    threshold: parseInt(localStorage.getItem("tifr_cfg_threshold") || "140", 10),
    opacity: parseFloat(localStorage.getItem("tifr_cfg_opacity") || "85") / 100
  };

  // 1. Refresh individual visitor canvases
  for (const item of (state.processedResults.individualPdfs || [])) {
    const v = item.visitor;
    const isRemoved = state.disabledHighlights.has(v.uid) || state.disabledHighlights.has(String(v.no));
    item.pdfBytes = null; // Invalidate cached PDF

    if (item.rawCanvases) {
      for (let pNum = 0; pNum < item.canvases.length; pNum++) {
        // Only pages where this visitor has segments have separate highlighted canvases
        if (item.segments && item.segments[pNum]) {
          const origCanvas = item.rawCanvases[pNum];
          const targetCanvas = item.canvases[pNum];
          delete targetCanvas._jpgBytes; // Invalidate cached JPG
          const ctx = targetCanvas.getContext("2d");
          ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
          ctx.drawImage(origCanvas, 0, 0);

          if (!isRemoved) {
            const seg = item.segments[pNum];
            const lines = seg.customLines || groupIntoLines(item.pageWordsList[pNum].slice(seg.start, seg.end));
            drawHighlight(ctx, lines, cfg.highlightColor, cfg.padX, cfg.padY, cfg.radius, cfg.opacity);
          }
        }
      }
    }
  }

  // 2. Refresh combined master canvases
  for (const entry of (state.processedResults.combinedEntries || [])) {
    if (entry.rawCanvases) {
      for (let pNum = 0; pNum < entry.canvases.length; pNum++) {
        const origCanvas = entry.rawCanvases[pNum];
        const activeLines = [];
        for (const v of entry.visitors) {
          if (state.disabledHighlights.has(v.uid) || state.disabledHighlights.has(String(v.no))) continue;
          const seg = entry.visitorSegments[v.uid] || entry.visitorSegments[v.no];
          if (seg && seg[pNum]) {
            const lines = seg[pNum].customLines || groupIntoLines(entry.pageWordsList[pNum].slice(seg[pNum].start, seg[pNum].end));
            activeLines.push(...lines);
          }
        }

        if (activeLines.length > 0) {
          let targetCanvas = entry.canvases[pNum];
          if (targetCanvas === origCanvas) {
            targetCanvas = document.createElement("canvas");
            targetCanvas.width = origCanvas.width;
            targetCanvas.height = origCanvas.height;
            entry.canvases[pNum] = targetCanvas;
          }
          delete targetCanvas._jpgBytes;
          const ctx = targetCanvas.getContext("2d");
          ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
          ctx.drawImage(origCanvas, 0, 0);
          drawHighlight(ctx, activeLines, cfg.highlightColor, cfg.padX, cfg.padY, cfg.radius, cfg.opacity);
        } else {
          entry.canvases[pNum] = origCanvas;
        }
      }
    }
  }

  // 3. Invalidate combined PDF caches
  state.processedResults.combinedIndividualPdfBytes = null;
  state.processedResults.combinedMasterPdfBytes = null;
  state.processedResults.combinedPdfBytes = null;
}

window.toggleVisitorHighlight = function(targetKey) {
  const uid = String(targetKey);
  const isCurrentlyRemoved = state.disabledHighlights.has(uid);
  const vObj = state.visitors.find(v => v.uid === uid || String(v.no) === uid);
  const vName = vObj ? vObj.name : uid;

  if (isCurrentlyRemoved) {
    state.disabledHighlights.delete(uid);
    if (vObj) {
      state.disabledHighlights.delete(vObj.uid);
      state.disabledHighlights.delete(String(vObj.no));
    }
    showSecurityToast(`Highlight restored for "${vName}".`);
  } else {
    state.disabledHighlights.add(uid);
    if (vObj) {
      state.disabledHighlights.add(vObj.uid);
      state.disabledHighlights.add(String(vObj.no));
    }
    showSecurityToast(`Highlight removed for "${vName}".`);
  }

  // Refresh canvases in-place
  refreshCanvasesAfterToggle();

  // Re-render live viewer in-place with forceRebuild=true, preserving scroll position
  updateLiveViewerPages(true);

  // Update thumbnail list and results table badges
  renderThumbnails();
  renderResultsSummary();
};

window.previewVisitor = function(targetKey) {
  window.jumpToVisitorPage(targetKey);
};

window.previewAllDocuments = function() {
  const contentEl = document.getElementById("live-viewer-content");
  if (contentEl) contentEl.scrollIntoView({ behavior: "smooth" });
};

// ── Manual Highlight Mode ───────────────────────────────────────

state.manualHighlight = {
  active: false,
  visitorUid: null
};

window.startManualHighlight = function(targetKey) {
  if (!state.processedResults || !state.processedResults.combinedEntries || state.processedResults.combinedEntries.length === 0) {
    showSecurityToast("Please run scan first before manually highlighting.");
    return;
  }

  const visitors = state.visitors || [];
  if (visitors.length === 0) return;

  let targetVisitor = null;
  if (targetKey) {
    const k = String(targetKey);
    targetVisitor = visitors.find(v => v.uid === k || String(v.no) === k);
  }
  if (!targetVisitor) {
    // Check if jump select has a currently selected visitor
    const jumpSelect = document.getElementById("viewer-jump-select");
    if (jumpSelect && jumpSelect.value && jumpSelect.value !== "all") {
      const pageItem = livePagesList.find(p => p.id === jumpSelect.value);
      if (pageItem && pageItem.visitorUid) {
        targetVisitor = visitors.find(v => v.uid === pageItem.visitorUid);
      }
    }
    // Check currently visible page item in viewer
    if (!targetVisitor) {
      const visibleItem = getCurrentVisiblePageItem();
      if (visibleItem && visibleItem.visitorUid) {
        targetVisitor = visitors.find(v => v.uid === visibleItem.visitorUid);
      }
    }
    // Fall back to first missing visitor, then first visitor
    if (!targetVisitor) {
      const foundUids = state.processedResults.foundVisitorUids;
      targetVisitor = visitors.find(v => !foundUids.has(v.uid)) || visitors[0];
    }
  }

  state.manualHighlight.active = true;
  state.manualHighlight.visitorUid = targetVisitor.uid;

  let banner = document.getElementById("manual-highlight-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "manual-highlight-banner";
    const viewerBody = document.querySelector("#panel-main-viewer .flex-1.flex.overflow-hidden");
    if (viewerBody) {
      viewerBody.parentElement.insertBefore(banner, viewerBody);
    }
  }

  const seq = targetVisitor.sheet_idx !== undefined ? targetVisitor.sheet_idx + 1 : 1;
  banner.className = "bg-gradient-to-r from-amber-500 to-yellow-500 text-slate-950 px-4 py-2.5 flex items-center justify-between shadow-xl sticky top-0 z-50 rounded-lg mx-3 my-2 border border-amber-300";
  banner.innerHTML = `
    <div class="flex items-center space-x-2.5 min-w-0">
      <div class="w-7 h-7 rounded-full bg-slate-950 text-amber-400 flex items-center justify-center font-bold text-xs shrink-0 shadow-xs">
        <i data-lucide="highlighter" class="w-4 h-4"></i>
      </div>
      <div class="min-w-0">
        <div class="text-[10px] font-extrabold uppercase tracking-wider text-slate-900">Manual Highlight Mode</div>
        <div class="text-xs text-slate-950 font-bold truncate">
          Click on any text line on the document for: <span class="bg-slate-950 text-amber-300 px-1.5 py-0.2 rounded text-[11px] font-mono">#${seq} Doc #${targetVisitor.no}</span> <span class="underline decoration-slate-900">${targetVisitor.name}</span>
        </div>
      </div>
    </div>
    <div class="flex items-center space-x-2 shrink-0">
      <select id="manual-highlight-visitor-picker" onchange="window.selectManualHighlightVisitor(this.value)" class="text-xs bg-slate-950 text-amber-300 border border-slate-800 rounded px-2 py-1 font-semibold outline-none max-w-[160px] sm:max-w-[220px] truncate">
        ${visitors.map((v, i) => {
          const s = v.sheet_idx !== undefined ? v.sheet_idx + 1 : i + 1;
          const isF = state.processedResults.foundVisitorUids.has(v.uid);
          const sel = v.uid === targetVisitor.uid ? "selected" : "";
          return `<option value="${v.uid}" ${sel}>#${s} (Doc #${v.no}) ${v.name} ${isF ? '✓' : '[MISSING]'}</option>`;
        }).join("")}
      </select>
      <button onclick="window.cancelManualHighlight()" class="text-xs bg-slate-950 hover:bg-slate-800 text-white font-bold px-3 py-1.5 rounded-md transition shadow-xs flex items-center gap-1">
        <i data-lucide="x" class="w-3 h-3"></i> Cancel
      </button>
    </div>
  `;

  if (window.lucide) lucide.createIcons();

  const isFound = state.processedResults.foundVisitorUids.has(targetVisitor.uid);
  if (!isFound && state.viewerMode === "individual") {
    state.viewerMode = "all";
    document.getElementById("viewer-tab-individual")?.classList.remove("bg-sky-600", "text-white", "shadow");
    document.getElementById("viewer-tab-individual")?.classList.add("text-slate-400");
    document.getElementById("viewer-tab-all")?.classList.remove("text-slate-400");
    document.getElementById("viewer-tab-all")?.classList.add("bg-sky-600", "text-white", "shadow");
    buildLivePagesList();
    updateLiveViewerPages(true);
  } else if (isFound) {
    jumpToVisitorPage(targetVisitor.uid);
  }

  document.querySelectorAll(".viewer-page-card canvas").forEach(c => {
    c.style.cursor = "crosshair";
  });

  showSecurityToast(`Click on the document page where ${targetVisitor.name} is located.`);
};

window.cancelManualHighlight = function() {
  state.manualHighlight.active = false;
  state.manualHighlight.visitorUid = null;
  const banner = document.getElementById("manual-highlight-banner");
  if (banner) banner.remove();
  document.querySelectorAll(".viewer-page-card canvas").forEach(c => {
    c.style.cursor = "default";
  });
};

window.selectManualHighlightVisitor = function(uid) {
  window.startManualHighlight(uid);
};

window.applyManualHighlightAtPoint = function(pageItem, clickX, clickY, dragBox = null) {
  if (!state.manualHighlight.active || !state.manualHighlight.visitorUid) return;

  const vUid = state.manualHighlight.visitorUid;
  const v = (state.visitors || []).find(x => x.uid === vUid);
  if (!v) return;

  const cfg = state.styleConfigs || {
    highlightColor: localStorage.getItem("tifr_cfg_color") || "#FFC101",
    padX: parseInt(localStorage.getItem("tifr_cfg_pad_x") || "6", 10),
    padY: parseInt(localStorage.getItem("tifr_cfg_pad_y") || "4", 10),
    radius: parseInt(localStorage.getItem("tifr_cfg_radius") || "6", 10),
    threshold: parseInt(localStorage.getItem("tifr_cfg_threshold") || "140", 10),
    opacity: parseFloat(localStorage.getItem("tifr_cfg_opacity") || "85") / 100
  };

  const entries = state.processedResults?.combinedEntries || [];
  let targetEntry = entries.find(e => e.pdfName === (pageItem.sourcePdfName || pageItem.pdfFilename || pageItem.pdfName));
  if (!targetEntry && entries.length > 0) {
    targetEntry = entries[0];
  }
  if (!targetEntry) return;

  const pNum = (pageItem.subPageNum ? pageItem.subPageNum - 1 : (pageItem.pageNum ? pageItem.pageNum - 1 : 0));
  const words = targetEntry.pageWordsList?.[pNum] || [];

  let highlightLines = [];
  let segmentStart = 0;
  let segmentEnd = words.length;

  if (dragBox) {
    const minX = Math.min(dragBox.x1, dragBox.x2);
    const maxX = Math.max(dragBox.x1, dragBox.x2);
    const minY = Math.min(dragBox.y1, dragBox.y2);
    const maxY = Math.max(dragBox.y1, dragBox.y2);

    const matchedWords = words.filter(w => {
      return !(w.right < minX || w.left > maxX || w.bottom < minY || w.top > maxY);
    });

    if (matchedWords.length > 0) {
      highlightLines = groupIntoLines(matchedWords);
      const indices = matchedWords.map(w => words.indexOf(w)).filter(i => i !== -1);
      segmentStart = Math.min(...indices);
      segmentEnd = Math.max(...indices) + 1;
    } else {
      highlightLines = [[{
        left: minX,
        top: minY,
        right: maxX,
        bottom: maxY,
        baseline: maxY - 3,
        raw: v.name
      }]];
      segmentStart = 0;
      segmentEnd = 0;
    }
  } else {
    if (words.length > 0) {
      // Check if partitions exist on this page for instant precise entry snapping
      const partitions = partitionPageVisitorEntries(words);
      let matchedPartition = null;
      for (const p of partitions) {
        const pWords = p.words;
        const minY = Math.min(...pWords.map(w => w.top));
        const maxY = Math.max(...pWords.map(w => w.bottom));
        if (clickY >= minY - 10 && clickY <= maxY + 10) {
          matchedPartition = p;
          break;
        }
      }

      if (matchedPartition) {
        segmentStart = matchedPartition.start;
        segmentEnd = matchedPartition.end;
        highlightLines = groupIntoLines(words.slice(segmentStart, segmentEnd));
      } else {
        let closestWord = words[0];
        let minDist = 999999;
        for (const w of words) {
          const yCenter = (w.top + w.bottom) / 2;
          const d = Math.abs(clickY - yCenter);
          if (d < minDist) {
            minDist = d;
            closestWord = w;
          }
        }

        const targetDeskewY = closestWord.deskewedY !== undefined ? closestWord.deskewedY : closestWord.top;
        const lineWords = words.filter(w => {
          const base = w.deskewedY !== undefined ? w.deskewedY : w.top;
          return Math.abs(base - targetDeskewY) <= 12;
        });

        if (lineWords.length > 0) {
          const indices = lineWords.map(w => words.indexOf(w)).filter(i => i !== -1);
          segmentStart = Math.min(...indices);
          let endIdx = Math.max(...indices) + 1;
          for (let j = endIdx; j < Math.min(words.length, endIdx + 20); j++) {
            const raw = words[j].raw.trim();
            if (/^\d+[.):]?$/.test(raw) && words[j].left < 200) break;
            if (isDateToken(raw, words, j)) {
              if (j + 1 < words.length && /^\((oci|pio)\)?[.,;]?$/i.test(words[j + 1].raw.trim())) {
                endIdx = j + 2;
              } else {
                endIdx = j + 1;
              }
              break;
            }
          }
          segmentEnd = endIdx;
          highlightLines = groupIntoLines(words.slice(segmentStart, segmentEnd));
        }
      }
    }

    if (highlightLines.length === 0) {
      const boxW = Math.min(targetEntry.rawCanvases[pNum]?.width || 800, 750);
      highlightLines = [[{
        left: 50,
        top: clickY - 10,
        right: 50 + boxW,
        bottom: clickY + 12,
        baseline: clickY + 9,
        raw: v.name
      }]];
    }
  }

  targetEntry.visitorSegments[v.uid] = {
    [pNum]: {
      start: segmentStart,
      end: segmentEnd,
      customLines: highlightLines
    }
  };
  targetEntry.visitorSegments[v.no] = targetEntry.visitorSegments[v.uid];
  if (!targetEntry.visitors.some(x => x.uid === v.uid)) {
    targetEntry.visitors.push(v);
  }

  state.processedResults.foundVisitorUids.add(v.uid);
  state.processedResults.foundVisitorNos.add(v.no);
  state.disabledHighlights.delete(v.uid);
  state.disabledHighlights.delete(String(v.no));

  const vCanvases = [];
  for (let p = 0; p < targetEntry.rawCanvases.length; p++) {
    const origCanvas = targetEntry.rawCanvases[p];
    if (p === pNum) {
      const copy = document.createElement("canvas");
      copy.width = origCanvas.width;
      copy.height = origCanvas.height;
      const copyCtx = copy.getContext("2d");
      copyCtx.drawImage(origCanvas, 0, 0);
      drawHighlight(copyCtx, highlightLines, cfg.highlightColor, cfg.padX, cfg.padY, cfg.radius, cfg.opacity);
      vCanvases.push(copy);
    } else {
      vCanvases.push(origCanvas);
    }
  }

  let indEntry = state.processedResults.individualPdfs.find(x => x.visitor.uid === v.uid);
  if (!indEntry) {
    indEntry = {
      name: `TIFR Approval - ${safeFilename(v.name)}.pdf`,
      pdfBytes: null,
      visitor: v,
      canvases: vCanvases,
      rawCanvases: targetEntry.rawCanvases,
      pageWordsList: targetEntry.pageWordsList,
      segments: targetEntry.visitorSegments[v.uid],
      pdfName: targetEntry.pdfName
    };
    state.processedResults.individualPdfs.push(indEntry);
  } else {
    indEntry.canvases = vCanvases;
    indEntry.rawCanvases = targetEntry.rawCanvases;
    indEntry.pageWordsList = targetEntry.pageWordsList;
    indEntry.segments = targetEntry.visitorSegments[v.uid];
    indEntry.pdfName = targetEntry.pdfName;
    indEntry.pdfBytes = null;
  }

  state.processedResults.visitorFileMap[v.uid] = {
    pdfName: targetEntry.pdfName,
    canvases: vCanvases,
    visitor: v
  };
  state.processedResults.visitorFileMap[v.no] = state.processedResults.visitorFileMap[v.uid];

  state.processedResults.individualPdfs.sort((a, b) => a.visitor.sheet_idx - b.visitor.sheet_idx);

  refreshCanvasesAfterToggle();
  renderResultsSummary();
  renderThumbnails();
  updateLiveViewerPages(true);

  window.cancelManualHighlight();
  jumpToVisitorPage(v.uid);

  showSecurityToast(`Highlight added for "${v.name}"!`);
};

// ── Keyboard Fast Visitor Navigation ([ and ]) ──────────────────

function getCurrentVisiblePageItem() {
  const scrollContainer = document.getElementById("live-viewer-scroll-container");
  const cards = Array.from(document.querySelectorAll(".viewer-page-card"));
  if (!cards.length) return null;
  if (!scrollContainer) return livePagesList[0];

  const containerRect = scrollContainer.getBoundingClientRect();
  const targetY = containerRect.top + 80;

  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (rect.bottom >= targetY && rect.top <= containerRect.bottom) {
      return livePagesList.find(p => p.id === card.id) || null;
    }
  }
  return livePagesList[0] || null;
}

function jumpStepVisitor(delta) {
  if (!state.visitors || !state.visitors.length || !state.processedResults) return;
  const foundUids = Array.from(state.processedResults.foundVisitorUids || []);
  if (!foundUids.length) return;

  const cur = getCurrentVisiblePageItem();
  const curUid = cur ? cur.visitorUid : foundUids[0];
  let curIdx = foundUids.indexOf(curUid);
  if (curIdx === -1) curIdx = 0;

  let newIdx = curIdx + delta;
  if (newIdx < 0) newIdx = 0;
  if (newIdx >= foundUids.length) newIdx = foundUids.length - 1;

  jumpToVisitorPage(foundUids[newIdx]);
}

document.addEventListener("keydown", e => {
  if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  if (e.key === "[" || (e.altKey && e.key === "ArrowUp")) {
    e.preventDefault();
    jumpStepVisitor(-1);
  } else if (e.key === "]" || (e.altKey && e.key === "ArrowDown")) {
    e.preventDefault();
    jumpStepVisitor(1);
  }
});

// ── Isolated High-Resolution Document Printing ──────────────────

function printCanvases(canvases, title = "TIFR Approval Letter") {
  if (!canvases || !canvases.length) return;

  let printIframe = document.getElementById("tifr-print-iframe");
  if (!printIframe) {
    printIframe = document.createElement("iframe");
    printIframe.id = "tifr-print-iframe";
    printIframe.style.position = "fixed";
    printIframe.style.right = "0";
    printIframe.style.bottom = "0";
    printIframe.style.width = "0";
    printIframe.style.height = "0";
    printIframe.style.border = "none";
    document.body.appendChild(printIframe);
  }

  const doc = printIframe.contentWindow.document;
  doc.open();
  doc.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>${title}</title>
      <style>
        @page {
          size: auto;
          margin: 0;
        }
        html, body {
          margin: 0;
          padding: 0;
          background: #ffffff;
        }
        .page {
          width: 100vw;
          height: 100vh;
          page-break-after: always;
          break-after: page;
          display: flex;
          align-items: center;
          justify-content: center;
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        .page:last-child {
          page-break-after: auto;
          break-after: auto;
        }
        img {
          max-width: 100%;
          max-height: 100%;
          width: auto;
          height: auto;
          display: block;
          object-fit: contain;
        }
      </style>
    </head>
    <body>
      ${canvases.map(c => `
        <div class="page">
          <img src="${c.toDataURL('image/jpeg', 0.95)}" />
        </div>
      `).join('')}
    </body>
    </html>
  `);
  doc.close();

  setTimeout(() => {
    printIframe.contentWindow.focus();
    printIframe.contentWindow.print();
  }, 400);
}

window.printVisitorCard = function(targetKey) {
  const keyStr = String(targetKey);
  const indPdfs = state.processedResults?.individualPdfs || [];
  const item = indPdfs.find(p => (p.visitor.uid && p.visitor.uid === keyStr) || String(p.visitor.no) === keyStr);
  if (item && item.canvases && item.canvases.length) {
    printCanvases(item.canvases, `TIFR Approval - ${item.visitor.name}`);
    return;
  }

  const pageItem = livePagesList.find(p => p.visitorUid === keyStr || String(p.visitorNo) === keyStr);
  if (pageItem && pageItem.canvas) {
    printCanvases([pageItem.canvas], `TIFR Approval - ${pageItem.visitorName}`);
  }
};

window.printCurrentDocument = function() {
  if (!state.processedResults || !livePagesList.length) {
    showSecurityToast("No document loaded to print. Please run scan first.");
    return;
  }

  if (state.viewerMode === "individual") {
    const cur = getCurrentVisiblePageItem();
    if (cur) {
      window.printVisitorCard(cur.visitorUid || cur.visitorNo);
      return;
    }
  }

  const canvases = livePagesList.map(p => p.canvas).filter(Boolean);
  if (canvases.length) {
    printCanvases(canvases, "TIFR Sanction Letters - All Highlights");
  }
};

// ── Bulletproof PDF Opening in New Tab (Anchor Blob Navigation) ──

window.openCombinedNewTab = async function() {
  const mode = state.viewerMode || "individual";
  showSecurityToast("Opening preview in new tab...");
  const bytes = (mode === "all")
    ? await getOrBuildCombinedMasterPdf()
    : await getOrBuildCombinedIndividualPdf();

  if (!bytes) {
    appendLog("Please run scan first.", "warn");
    return;
  }

  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);

  // Use direct anchor with target="_blank" (never blocked as popup)
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
  }, 500);
};

window.openCombinedNewWindow = function() {
  window.openCombinedNewTab();
};

window.openVisitorNewWindow = async function(targetKey) {
  const keyStr = String(targetKey);
  const item = state.processedResults?.individualPdfs.find(
    p => (p.visitor.uid && p.visitor.uid === keyStr) || String(p.visitor.no) === keyStr
  );
  if (!item) return;

  showSecurityToast(`Opening ${item.visitor.name} in tab...`);
  const bytes = await getOrBuildVisitorPdfBytes(item);
  if (!bytes) return;

  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => document.body.removeChild(a), 500);
};

// ── Viewer Listeners ────────────────────────────────────────────

const jumpSelectEl = document.getElementById("viewer-jump-select");
if (jumpSelectEl) {
  jumpSelectEl.addEventListener("change", e => {
    if (e.target.value) {
      const target = document.getElementById(e.target.value);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        target.classList.remove("viewer-card-active-glow");
        void target.offsetWidth;
        target.classList.add("viewer-card-active-glow");
        setTimeout(() => target.classList.remove("viewer-card-active-glow"), 1800);
      }
    }
  });
}

const btnZoomInEl = document.getElementById("viewer-btn-zoom-in");
if (btnZoomInEl) {
  btnZoomInEl.addEventListener("click", () => {
    if (viewerZoomLevel < 1.8) {
      viewerZoomLevel += 0.15;
      updateLiveViewerPages();
    }
  });
}

const btnZoomOutEl = document.getElementById("viewer-btn-zoom-out");
if (btnZoomOutEl) {
  btnZoomOutEl.addEventListener("click", () => {
    if (viewerZoomLevel > 0.6) {
      viewerZoomLevel -= 0.15;
      updateLiveViewerPages();
    }
  });
}

const btnFitWidthEl = document.getElementById("viewer-btn-fit-width");
if (btnFitWidthEl) {
  btnFitWidthEl.addEventListener("click", () => {
    viewerZoomLevel = 1.0;
    updateLiveViewerPages();
  });
}

const btnPrintDoc = document.getElementById("viewer-btn-print");
if (btnPrintDoc) {
  btnPrintDoc.addEventListener("click", () => {
    window.printCurrentDocument();
  });
}

const tabIndividualEl = document.getElementById("viewer-tab-individual");
if (tabIndividualEl) {
  tabIndividualEl.addEventListener("click", () => setViewerMode("individual"));
}

const tabAllEl = document.getElementById("viewer-tab-all");
if (tabAllEl) {
  tabAllEl.addEventListener("click", () => setViewerMode("all"));
}

const btnToggleThumbs = document.getElementById("viewer-btn-toggle-thumbnails");
const sidebarThumbs = document.getElementById("viewer-thumbnail-sidebar");
const btnCloseThumbs = document.getElementById("viewer-btn-close-thumbnails");

if (btnToggleThumbs && sidebarThumbs) {
  btnToggleThumbs.addEventListener("click", () => {
    sidebarThumbs.classList.toggle("hidden");
    if (!sidebarThumbs.classList.contains("hidden")) {
      btnToggleThumbs.classList.add("bg-sky-600", "text-white");
      btnToggleThumbs.classList.remove("bg-slate-800", "text-slate-200");
    } else {
      btnToggleThumbs.classList.remove("bg-sky-600", "text-white");
      btnToggleThumbs.classList.add("bg-slate-800", "text-slate-200");
    }
  });
}

if (btnCloseThumbs && sidebarThumbs) {
  btnCloseThumbs.addEventListener("click", () => {
    sidebarThumbs.classList.add("hidden");
    if (btnToggleThumbs) {
      btnToggleThumbs.classList.remove("bg-sky-600", "text-white");
      btnToggleThumbs.classList.add("bg-slate-800", "text-slate-200");
    }
  });
}

if (elements.btnOpenPreviewWindow) {
  elements.btnOpenPreviewWindow.addEventListener("click", () => {
    window.openCombinedNewTab();
  });
}

// ── Downloads ──────────────────────────────────────────────────

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

window.downloadSinglePdf = async function(targetKey) {
  const keyStr = String(targetKey);
  const item = state.processedResults?.individualPdfs.find(
    p => (p.visitor.uid && p.visitor.uid === keyStr) || String(p.visitor.no) === keyStr
  );
  if (!item) return;

  showSecurityToast(`Preparing PDF for ${item.visitor.name}...`);
  const bytes = await getOrBuildVisitorPdfBytes(item);
  const blob = new Blob([bytes], { type: "application/pdf" });
  triggerBlobDownload(blob, item.name);
};

elements.btnDownloadCombined.addEventListener("click", async () => {
  showSecurityToast("Building combined PDF with ALL visitors highlighted...");
  const bytes = await getOrBuildCombinedMasterPdf();
  if (!bytes) {
    appendLog("Combined PDF not available. Please ensure documents are scanned first.", "warn");
    return;
  }
  const blob = new Blob([bytes], { type: "application/pdf" });
  triggerBlobDownload(blob, "TIFR_All_Visitors_Combined.pdf");
});

const btnDownloadMasterEl = document.getElementById("btn-download-master");
if (btnDownloadMasterEl) {
  btnDownloadMasterEl.addEventListener("click", async () => {
    showSecurityToast("Building master PDF with all visitors highlighted...");
    const bytes = await getOrBuildCombinedMasterPdf();
    if (!bytes) {
      appendLog("Master overview PDF not available.", "warn");
      return;
    }
    const blob = new Blob([bytes], { type: "application/pdf" });
    triggerBlobDownload(blob, "TIFR_All_Visitors_Combined.pdf");
  });
}

const btnDownloadIndCombinedEl = document.getElementById("btn-download-individual-combined");
if (btnDownloadIndCombinedEl) {
  btnDownloadIndCombinedEl.addEventListener("click", async () => {
    showSecurityToast("Assembling combined individual approvals PDF...");
    const bytes = await getOrBuildCombinedIndividualPdf();
    if (!bytes) return;
    const blob = new Blob([bytes], { type: "application/pdf" });
    triggerBlobDownload(blob, "TIFR_All_Visitors_Individual_Combined.pdf");
  });
}

elements.btnDownloadZip.addEventListener("click", async () => {
  if (state.processedResults?.zipBlob) {
    showSecurityToast("Downloading complete highlighted package (ZIP)...");
    triggerBlobDownload(state.processedResults.zipBlob, "TIFR_Highlighted_Approvals.zip");
    return;
  }

  const indPdfs = state.processedResults?.individualPdfs;
  if (!indPdfs || !indPdfs.length) return;

  showSecurityToast("Packaging all visitor PDFs into ZIP archive...");
  const zip = new JSZip();
  for (const item of indPdfs) {
    const bytes = await getOrBuildVisitorPdfBytes(item);
    zip.file(item.name, bytes);
  }

  const zipBlob = await zip.generateAsync({ type: "blob" });
  triggerBlobDownload(zipBlob, "TIFR_Individual_Visitor_Approvals.zip");
});

// ── Setup Listeners ────────────────────────────────────────────

elements.inputVisitors.addEventListener("input", parseVisitorInput);

elements.btnClearVisitors.addEventListener("click", () => {
  elements.inputVisitors.value = "";
  parseVisitorInput();
});

if (elements.btnSampleData) {
  elements.btnSampleData.addEventListener("click", () => {
    // Sample visitors button removed per user request
  });
}

elements.fileVisitorsImport.addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    elements.inputVisitors.value = ev.target.result;
    parseVisitorInput();
  };
  reader.readAsText(file);
});

elements.filePdfInput.addEventListener("change", e => {
  if (e.target.files.length) {
    handlePdfUpload(Array.from(e.target.files));
  }
});

elements.dropzone.addEventListener("dragover", e => {
  e.preventDefault();
  elements.dropzone.classList.add("border-sky-500", "bg-sky-50");
});

elements.dropzone.addEventListener("dragleave", e => {
  e.preventDefault();
  elements.dropzone.classList.remove("border-sky-500", "bg-sky-50");
});

elements.dropzone.addEventListener("drop", e => {
  e.preventDefault();
  elements.dropzone.classList.remove("border-sky-500", "bg-sky-50");
  if (e.dataTransfer.files.length) {
    handlePdfUpload(Array.from(e.dataTransfer.files));
  }
});

if (elements.cfgHighlightColor && elements.cfgColorHex) {
  elements.cfgHighlightColor.addEventListener("input", e => {
    elements.cfgColorHex.textContent = e.target.value.toUpperCase();
  });
}

elements.btnStartProcess.addEventListener("click", runHighlighter);

const btnOpenSettings = document.getElementById("btn-open-settings");
if (btnOpenSettings) {
  btnOpenSettings.addEventListener("click", () => {
    const panel = document.getElementById("panel-settings");
    if (panel) panel.classList.toggle("hidden");
  });
}

// ── Security & Code Protection (Right-Click & Inspect Disabled) ──

function showSecurityToast(msg) {
  let toast = document.getElementById("security-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "security-toast";
    toast.className = "fixed bottom-5 right-5 bg-slate-900/95 border border-slate-700 text-slate-200 px-4 py-2.5 rounded-xl shadow-2xl text-xs z-50 flex items-center space-x-2 transition-all duration-300 opacity-0 pointer-events-none backdrop-blur-md";
    toast.innerHTML = `<i data-lucide="shield-alert" class="w-4 h-4 text-amber-400"></i><span id="security-toast-text">${msg}</span>`;
    document.body.appendChild(toast);
    if (window.lucide) lucide.createIcons();
  } else {
    const txt = document.getElementById("security-toast-text");
    if (txt) txt.textContent = msg;
  }
  toast.classList.remove("opacity-0");
  setTimeout(() => toast.classList.add("opacity-0"), 2000);
}

function initSecurityShield() {
  // 1. Disable Context Menu (Right Click) across the application
  document.addEventListener("contextmenu", e => {
    e.preventDefault();
    showSecurityToast("Right-click is disabled to protect application contents.");
    return false;
  });

  // 2. Disable Developer Shortcut Keys
  document.addEventListener("keydown", e => {
    // F12 key
    if (e.key === "F12" || e.keyCode === 123) {
      e.preventDefault();
      showSecurityToast("Developer tools inspection is disabled.");
      return false;
    }
    // Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C (DevTools inspection)
    if (e.ctrlKey && e.shiftKey && ["I", "i", "J", "j", "C", "c"].includes(e.key)) {
      e.preventDefault();
      showSecurityToast("Developer tools inspection is disabled.");
      return false;
    }
    // Ctrl+U (View Page Source)
    if (e.ctrlKey && (e.key === "u" || e.key === "U")) {
      e.preventDefault();
      showSecurityToast("Viewing source is disabled.");
      return false;
    }
    // Ctrl+S (Save Webpage)
    if (e.ctrlKey && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      return false;
    }
  });
}

// Initialize security shield immediately
initSecurityShield();

// ── Interactive Split Resizer & Width Controls ─────────────────

function initSplitResizer() {
  const resizer = document.getElementById("split-resizer");
  const sidebar = document.getElementById("panel-left-sidebar");
  const btnCompact = document.getElementById("btn-width-compact");
  const btnDefault = document.getElementById("btn-width-default");
  const btnWide = document.getElementById("btn-width-wide");
  const btnPanelToggle = document.getElementById("btn-panel-toggle");
  const btnToggleViewer = document.getElementById("btn-toggle-left-panel");

  if (!resizer || !sidebar) return;

  // Restore saved width from localStorage if present
  const savedWidth = localStorage.getItem("tifr_panel_width");
  if (savedWidth) {
    sidebar.style.width = savedWidth;
  }

  function setSidebarWidth(widthPx) {
    sidebar.classList.remove("hidden");
    sidebar.style.width = `${widthPx}px`;
    localStorage.setItem("tifr_panel_width", `${widthPx}px`);
    updateLiveViewerPages();
  }

  if (btnCompact) {
    btnCompact.addEventListener("click", () => setSidebarWidth(320));
  }
  if (btnDefault) {
    btnDefault.addEventListener("click", () => setSidebarWidth(420));
  }
  if (btnWide) {
    btnWide.addEventListener("click", () => setSidebarWidth(560));
  }

  function toggleSidebar() {
    const isHidden = sidebar.classList.contains("hidden");
    if (isHidden) {
      sidebar.classList.remove("hidden");
      const w = localStorage.getItem("tifr_panel_width") || "420px";
      sidebar.style.width = w;
    } else {
      sidebar.classList.add("hidden");
    }
    updateLiveViewerPages();
  }

  if (btnPanelToggle) btnPanelToggle.addEventListener("click", toggleSidebar);
  if (btnToggleViewer) btnToggleViewer.addEventListener("click", toggleSidebar);

  // Mouse Dragging on #split-resizer
  let isDragging = false;

  resizer.addEventListener("mousedown", e => {
    isDragging = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    resizer.classList.add("bg-sky-500", "w-2.5");
    sidebar.classList.remove("transition-[width]");
  });

  window.addEventListener("mousemove", e => {
    if (!isDragging) return;
    const newWidth = Math.max(260, Math.min(e.clientX, Math.min(window.innerWidth - 350, 750)));
    sidebar.classList.remove("hidden");
    sidebar.style.width = `${newWidth}px`;
  });

  window.addEventListener("mouseup", () => {
    if (!isDragging) return;
    isDragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    resizer.classList.remove("bg-sky-500", "w-2.5");
    sidebar.classList.add("transition-[width]");
    localStorage.setItem("tifr_panel_width", sidebar.style.width);
    updateLiveViewerPages();
  });

  // Responsive window resize listener
  window.addEventListener("resize", () => {
    updateLiveViewerPages();
  });
}

// Initialize Split Resizer
initSplitResizer();

// ── Responsive Mobile & Tablet View Tabs (< 1024px) ────────────

function initMobileTabs() {
  const tabInputs = document.getElementById("tab-mobile-inputs");
  const tabViewer = document.getElementById("tab-mobile-viewer");
  const sidebar = document.getElementById("panel-left-sidebar");
  const viewer = document.getElementById("panel-main-viewer");

  if (!tabInputs || !tabViewer || !sidebar || !viewer) return;

  function setMobileView(view) {
    if (view === "inputs") {
      sidebar.classList.remove("hidden");
      viewer.classList.add("hidden");
      viewer.classList.remove("flex");

      tabInputs.className = "flex-1 py-2 px-3 text-xs font-semibold rounded-lg transition flex items-center justify-center space-x-2 bg-white text-slate-900 shadow-xs border border-slate-200";
      tabViewer.className = "flex-1 py-2 px-3 text-xs font-semibold rounded-lg transition flex items-center justify-center space-x-2 text-slate-600 hover:text-slate-900";
    } else {
      sidebar.classList.add("hidden");
      viewer.classList.remove("hidden");
      viewer.classList.add("flex");

      tabViewer.className = "flex-1 py-2 px-3 text-xs font-semibold rounded-lg transition flex items-center justify-center space-x-2 bg-white text-slate-900 shadow-xs border border-slate-200";
      tabInputs.className = "flex-1 py-2 px-3 text-xs font-semibold rounded-lg transition flex items-center justify-center space-x-2 text-slate-600 hover:text-slate-900";

      updateLiveViewerPages();
    }
  }

  tabInputs.addEventListener("click", () => setMobileView("inputs"));
  tabViewer.addEventListener("click", () => setMobileView("viewer"));

  window.addEventListener("resize", () => {
    if (window.innerWidth >= 1024) {
      sidebar.classList.remove("hidden");
      viewer.classList.remove("hidden");
      viewer.classList.add("flex");
    }
  });
}

initMobileTabs();

// ── Engine Mode Badge Indicator ────────────────────────────────
function updateEngineModeBadge() {
  const badge = document.getElementById("badge-engine-mode");
  if (!badge) return;
  const usePython = localStorage.getItem("tifr_cfg_use_python_api") !== "false";
  if (usePython) {
    badge.className = "px-2 py-0.5 text-[10px] sm:text-[11px] font-semibold bg-sky-100 hover:bg-sky-200 text-sky-800 rounded-full transition flex items-center space-x-1 shadow-2xs";
    badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span><span>Python Cloud Engine</span>`;
    badge.title = "Python Cloud Engine Active (Colab Precision). Click to configure in Settings.";
  } else {
    badge.className = "px-2 py-0.5 text-[10px] sm:text-[11px] font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-full transition flex items-center space-x-1 shadow-2xs";
    badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span><span>Browser OCR Mode</span>`;
    badge.title = "Browser Client Mode Active. Click to configure in Settings.";
  }
}

updateEngineModeBadge();
window.addEventListener("storage", updateEngineModeBadge);

// Warm up Render backend immediately on page load so it is hot by the time user clicks scan
(function warmUpBackend() {
  const usePython = localStorage.getItem("tifr_cfg_use_python_api") !== "false";
  const pythonApiUrl = (localStorage.getItem("tifr_cfg_python_api_url") || "https://tifr-highlighter-api.onrender.com").replace(/\/+$/, "");
  if (usePython && pythonApiUrl) {
    fetch(pythonApiUrl + "/", { method: "GET" })
      .then(r => r.json())
      .then(d => {
        const badge = document.getElementById("badge-engine-mode");
        if (badge && d.status === "online") {
          badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span><span>Python Engine (Ready)</span>`;
        }
      })
      .catch(() => {});
  }
})();




