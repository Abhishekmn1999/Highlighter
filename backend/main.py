import os
import re
import io
import json
import difflib
import zipfile
import tempfile
import unicodedata
from typing import List

import numpy as np
from PIL import Image, ImageDraw
import pytesseract
from pdf2image import convert_from_path
from pypdf import PdfWriter

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

app = FastAPI(
    title="TIFR Document Highlighter Engine",
    description="Private High-Precision Document Processing API",
    version="1.0.0"
)

# Enable CORS for webapp integration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)


# ── Core Proprietary Engine (Server-Side Only - 100% Hidden) ────

def normalize(text):
    if not text:
        return ""
    text = text.replace('\u00e6', 'ae').replace('\u00c6', 'ae').replace('\u0153', 'oe').replace('\u0152', 'oe')
    text = unicodedata.normalize("NFKD", text)
    return "".join(c for c in text if not unicodedata.combining(c)).lower().strip()

def alpha_only(s):
    return re.sub(r"[^a-z]", "", normalize(s))

def token_similarity(a, b):
    return difflib.SequenceMatcher(None, a, b).ratio()

def is_number_token(word, n_str, next_word=None):
    cleaned = re.sub(r"[^0-9]", "", word)
    if cleaned == str(n_str):
        if re.fullmatch(rf"{n_str}[.),:;]?", word):
            return True
        if word == str(n_str) and next_word in (".", ")", ",", ":", "-"):
            return True
    return False

def strip_honorifics(name):
    return re.sub(r"^(prof|professor|dr|mr|mrs|ms|shri|smt)\.?\s+", "", name, flags=re.IGNORECASE).strip()

def clean_visitor_name_parts(name):
    clean = strip_honorifics(name)
    parts = [p for p in re.split(r"[\s,]+", clean) if len(alpha_only(p)) >= 2]
    return parts

def name_matches(visitor_name, ctx):
    parts = clean_visitor_name_parts(visitor_name)
    if not parts:
        return False
    first = alpha_only(parts[0])
    last = alpha_only(parts[-1])
    ctx_clean = " " + re.sub(r"[^a-z0-9 ]", " ", normalize(ctx)) + " "
    ctx_words = [w for w in ctx_clean.split() if len(w) >= 2]

    def part_in_ctx(p):
        if f" {p} " in ctx_clean:
            return True
        return any(token_similarity(p, w) >= 0.78 for w in ctx_words if len(w) >= 2)

    if len(parts) == 1:
        return part_in_ctx(first)
    return part_in_ctx(first) and part_in_ctx(last)

def is_valid_visitor_start(words, i, visitor):
    clean_name = strip_honorifics(visitor["name"])
    parts = clean_visitor_name_parts(clean_name)
    if not parts:
        return False
    first = alpha_only(parts[0])
    last = alpha_only(parts[-1])

    immediate_words = words[i + 1: min(i + 5, len(words))]
    if not immediate_words:
        return False

    first_word_norm = normalize(immediate_words[0]["raw"])
    disqualified = ["the", "details", "following", "approval", "sanction", "purpose", "subject", "ref", "dated", "below"]
    if first_word_norm in disqualified:
        return False

    for k in range(len(immediate_words)):
        if is_number_token(immediate_words[k]["raw"], visitor["no"]):
            return False

    immediate_alpha = [alpha_only(w["raw"]) for w in immediate_words]
    has_name_part = any(w == first or w == last or (len(w) >= 4 and (first in w or last in w)) for w in immediate_alpha)
    has_honorific = any(re.match(r"^(dr|prof|mr|mrs|ms|shri|smt)\.?$", normalize(w["raw"])) for w in immediate_words)

    if not has_name_part and not has_honorific:
        return False

    ctx = " ".join(normalize(words[j]["raw"]) for j in range(i + 1, min(i + 18, len(words))))
    return name_matches(visitor["name"], ctx)

def find_visitor_start_idx(words, visitor):
    parts = clean_visitor_name_parts(visitor["name"])
    if not parts:
        return None
    first = alpha_only(parts[0])
    last = alpha_only(parts[-1])
    target_no = str(visitor["no"])

    # Strategy 1: Anchor by Name Match, then search backward for number token
    for i, w in enumerate(words):
        if is_closing_text(words, i):
            continue

        w_alpha = alpha_only(w["raw"])
        is_first_match = bool(first and (w_alpha == first or (len(first) >= 4 and first in w_alpha)))
        is_last_match = bool(last and (w_alpha == last or (len(last) >= 4 and last in w_alpha)))

        if is_first_match or is_last_match:
            window_words = words[max(0, i - 2) : min(len(words), i + 15)]
            window_str = " ".join(alpha_only(item["raw"]) for item in window_words)

            both_match = bool(first and last and first in window_str and last in window_str)
            has_num = any(is_number_token(words[b]["raw"], target_no) for b in range(max(0, i - 9), min(len(words), i + 2)))
            single_long_match = bool(((last and len(last) >= 6 and last in window_str) or (first and len(first) >= 6 and first in window_str)) and has_num)

            if both_match or single_long_match:
                for b in range(i, max(-1, i - 9), -1):
                    if is_number_token(words[b]["raw"], target_no):
                        return b
                    if words[b]["raw"].startswith(target_no) and len(words[b]["raw"]) <= len(target_no) + 2:
                        return b
                return max(0, i - 1)

    # Strategy 2: Forward scan fallback
    for i, w in enumerate(words):
        if is_closing_text(words, i):
            continue
        if is_number_token(w["raw"], target_no):
            if is_valid_visitor_start(words, i, visitor):
                return i

    return None

CLOSING_PHRASES = [
    "we have obtained",
    "passport particulars",
    "prescribed dae format",
    "enclosed with this letter",
    "annexure",
    "yours faithfully",
    "yours sincerely",
    "with regards",
    "with warm regards",
    "thanking you",
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
    "registrar",
    "encl",
    "discrepancy",
    "rajesh",
    "gopakumar",
    "centre director",
    "prevail and will be binding"
]

def is_closing_text(words, idx):
    raw_lower = normalize(words[idx]["raw"])
    if any(k in raw_lower for k in ["telephone", "website", "email", "fax", "www.", "@", "director", "encl", "discrepancy", "rajesh", "gopakumar", "निदेशक"]):
        return True
    if re.search(r"\d{1,2}[./-]\d{1,2}[./-]\d{2,4}", words[idx]["raw"]):
        return False
    snippet = " ".join(normalize(words[j]["raw"]) for j in range(idx, min(idx + 5, len(words))))
    return any(p in snippet for p in CLOSING_PHRASES)

def find_end_idx(words, start_idx, next_no):
    start_top = words[start_idx]["top"]
    for i in range(start_idx + 1, len(words)):
        nxt = words[i + 1]["raw"] if i + 1 < len(words) else None
        if next_no and is_number_token(words[i]["raw"], next_no, nxt):
            return i
        if is_closing_text(words, i):
            return i
        if re.fullmatch(r"\d+[.):]?", words[i]["raw"]) and i > start_idx + 8:
            return i
        # Safety limit: visitor entry shouldn't exceed 40 words or 350 vertical pixels
        if i > start_idx + 38 or (words[i]["top"] - start_top > 350):
            return i
    return len(words)

def find_visitor_segment(words, visitor):
    start_idx = find_visitor_start_idx(words, visitor)
    if start_idx is None:
        return None
    visitor_no = visitor["no"]
    next_no = str(int(visitor_no) + 1) if visitor_no.isdigit() else None
    end_idx = find_end_idx(words, start_idx, next_no)
    return (start_idx, end_idx)

def group_into_lines(segment, y_tol=12):
    lines = []
    for w in segment:
        placed = False
        for line in lines:
            line_avg_y = sum(item["top"] for item in line) / len(line)
            if abs(line_avg_y - w["top"]) <= y_tol:
                line.append(w)
                placed = True
                break
        if not placed:
            lines.append([w])
    return lines

def hex_to_rgb(hex_str):
    hex_str = hex_str.lstrip('#')
    if len(hex_str) == 6:
        return tuple(int(hex_str[i:i+2], 16) for i in (0, 2, 4))
    return (255, 193, 1)

def draw_highlight(img, lines, color=(255, 193, 1), pad_x=6, pad_y=3, radius=6):
    mask_img = Image.new("L", img.size, 0)
    draw     = ImageDraw.Draw(mask_img)
    for lw in lines:
        draw.rounded_rectangle(
            [min(w["left"] for w in lw)  - pad_x,
             min(w["top"]  for w in lw)  - pad_y,
             max(w["right"] for w in lw) + pad_x,
             max(w["bottom"] for w in lw)+ pad_y],
            radius=radius, fill=255
        )
    mask    = np.array(mask_img, dtype=bool)
    arr     = np.array(img, dtype=np.uint8)
    lum     = 0.299*arr[:,:,0] + 0.587*arr[:,:,1] + 0.114*arr[:,:,2]
    bg      = mask & (lum >= 140)
    tx      = mask & (lum <  140)
    arr[bg] = [*color]
    arr[tx] = 0
    img.paste(Image.fromarray(arr))
    return img

def parse_visitor(text):
    text = text.strip()
    m = re.match(r"^(\d+)[.)]\s*(.+?)\s+from\s+(.+)$", text, re.IGNORECASE)
    if m:
        return {
            "no": m.group(1),
            "name": m.group(2).strip(),
            "details": m.group(3).strip(),
            "text": text
        }
    m2 = re.match(r"^(\d+)[.)]\s*([^,\n]+)", text)
    if m2:
        return {"no": m2.group(1), "name": m2.group(2).strip(), "details": "", "text": text}
    m3 = re.match(r"^(.+?)\s+from\s+(.+)$", text, re.IGNORECASE)
    if m3:
        return {"no": "", "name": m3.group(1).strip(), "details": m3.group(2).strip(), "text": text}
    return {"no": "", "name": text, "details": "", "text": text}

def format_visitor_display_name(name):
    cleaned = re.sub(r'[,]', ' ', name.strip())
    return " ".join(cleaned.split())

def safe_filename(s):
    return re.sub(r'[\\/*?:"<>|]', "", s).strip()


# ── REST API Endpoints ──────────────────────────────────────────

@app.get("/")
def health_check():
    return {
        "status": "online",
        "service": "TIFR Document Highlighter Engine",
        "version": "1.0.0"
    }

@app.post("/api/highlight")
async def highlight_documents(
    visitor_text: str = Form(...),
    highlight_color: str = Form("#FFC101"),
    files: List[UploadFile] = File(...)
):
    if not files:
        raise HTTPException(status_code=400, detail="No PDF files uploaded.")

    visitor_lines = [r.strip() for r in visitor_text.strip().split("\n") if r.strip()]
    if not visitor_lines:
        raise HTTPException(status_code=400, detail="No visitor names provided.")

    all_visitors = []
    for sheet_idx, vt in enumerate(visitor_lines):
        v = parse_visitor(vt)
        if v:
            v["sheet_idx"] = sheet_idx
            all_visitors.append(v)

    color_rgb = hex_to_rgb(highlight_color)

    with tempfile.TemporaryDirectory() as temp_dir:
        master_source_pdfs = []
        completed_sheet_indices = set()
        matched_records = []
        individual_pdf_buffers = []

        for upload in sorted(files, key=lambda f: f.filename):
            pdf_name = upload.filename
            local_pdf = os.path.join(temp_dir, pdf_name)
            content = await upload.read()
            with open(local_pdf, "wb") as f:
                f.write(content)

            try:
                pages = convert_from_path(local_pdf, dpi=200, thread_count=2)
            except Exception as e:
                continue

            raw_pages = [p.convert("RGB") for p in pages]
            page_words = [extract_words(img) for img in raw_pages]
            os.remove(local_pdf)

            pdf_matches = []
            all_segments_by_page = {p: [] for p in range(len(raw_pages))}

            for v in all_visitors:
                sheet_idx = v["sheet_idx"]
                v_no      = v["no"]
                v_name    = v["name"]

                if sheet_idx in completed_sheet_indices:
                    continue

                for p_idx, words in enumerate(page_words):
                    seg = find_visitor_segment(words, v)
                    if seg:
                        start_i, end_i = seg
                        pdf_matches.append((v, p_idx, start_i, end_i))
                        all_segments_by_page[p_idx].append((start_i, end_i))
                        completed_sheet_indices.add(sheet_idx)
                        matched_records.append({
                            "sheet_idx": sheet_idx + 1,
                            "doc_no": v_no,
                            "name": v_name,
                            "pdf": pdf_name,
                            "page": p_idx + 1
                        })
                        break

            # A. Build Individual Visitor PDFs (High-Speed JPEG-in-PDF encoding)
            for v, page_num, start_idx, end_idx in pdf_matches:
                display_name = format_visitor_display_name(v["name"])
                clean_name   = safe_filename(display_name)
                out_filename = f"TIFR Approval - {clean_name}.pdf"

                individual_pages = []
                for p_idx, img in enumerate(raw_pages):
                    if p_idx == page_num:
                        p_img = img.copy()
                        seg_words = page_words[page_num][start_idx:end_idx]
                        lines = group_into_lines(seg_words)
                        p_img = draw_highlight(p_img, lines, color=color_rgb)
                        individual_pages.append(p_img)
                    else:
                        individual_pages.append(img)

                buf = io.BytesIO()
                if len(individual_pages) == 1:
                    individual_pages[0].save(buf, "PDF", resolution=200.0, quality=82)
                else:
                    individual_pages[0].save(buf, "PDF", resolution=200.0, quality=82, save_all=True, append_images=individual_pages[1:])
                individual_pdf_buffers.append((out_filename, buf.getvalue()))

            # B. Save Copy with ALL Visitors Highlighted in this PDF
            if pdf_matches:
                earliest_sheet_idx = min(m[0]["sheet_idx"] for m in pdf_matches)
                all_highlighted_pages = []

                for p_idx, img in enumerate(raw_pages):
                    segs = all_segments_by_page[p_idx]
                    if not segs:
                        all_highlighted_pages.append(img)
                        continue

                    p_img = img.copy()
                    words = page_words[p_idx]
                    for start_idx, end_idx in segs:
                        lines = group_into_lines(words[start_idx:end_idx])
                        p_img = draw_highlight(p_img, lines, color=color_rgb)
                    all_highlighted_pages.append(p_img)

                temp_master_path = os.path.join(temp_dir, f"master_{safe_filename(pdf_name)}.pdf")
                if len(all_highlighted_pages) == 1:
                    all_highlighted_pages[0].save(temp_master_path, "PDF", resolution=200.0, quality=82)
                else:
                    all_highlighted_pages[0].save(temp_master_path, "PDF", resolution=200.0, quality=82, save_all=True, append_images=all_highlighted_pages[1:])

                master_source_pdfs.append((earliest_sheet_idx, temp_master_path))

        # C. Build Combined Master PDF in exact sheet order
        master_combined_bytes = None
        if master_source_pdfs:
            master_source_pdfs.sort(key=lambda x: x[0])
            writer = PdfWriter()
            for s_idx, pdf_path in master_source_pdfs:
                writer.append(pdf_path)
            comb_buf = io.BytesIO()
            writer.write(comb_buf)
            writer.close()
            master_combined_bytes = comb_buf.getvalue()

        # D. Assemble Final ZIP Archive
        zip_buf = io.BytesIO()
        with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
            if master_combined_bytes:
                zf.writestr("TIFR_All_Visitors_Combined.pdf", master_combined_bytes)
            for fname, pdf_bytes in individual_pdf_buffers:
                zf.writestr(f"Individual Approvals/{fname}", pdf_bytes)

        # Missing visitors detection
        missing_visitors = [
            {"sheet_idx": v["sheet_idx"] + 1, "doc_no": v["no"], "name": v["name"]}
            for v in all_visitors if v["sheet_idx"] not in completed_sheet_indices
        ]

        summary_data = {
            "total_visitors": len(all_visitors),
            "matched_visitors": len(completed_sheet_indices),
            "missing_count": len(missing_visitors),
            "matched_records": matched_records,
            "missing_visitors": missing_visitors
        }

        zip_bytes = zip_buf.getvalue()

        return Response(
            content=zip_bytes,
            media_type="application/zip",
            headers={
                "Content-Disposition": 'attachment; filename="TIFR_Highlighted_Approvals.zip"',
                "X-Processing-Summary": json.dumps(summary_data)
            }
        )
