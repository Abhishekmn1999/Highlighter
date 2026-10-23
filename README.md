# 📄 TIFR Visitor Highlighter (Web App Edition)

Easily scan academic / administrative approval letters, detect visitor sanction paragraphs using intelligent OCR & text extraction, highlight visitor blocks in golden amber, and merge all approved pages into a combined PDF ordered by spreadsheet position.

---

## 🌟 What Changed from the Colab Script?

| Feature | Original Colab Script | New Web App |
| :--- | :--- | :--- |
| **User Interface** | Manual code cells, hardcoded folder/sheet IDs | **Modern interactive Web UI** (Drag & drop, buttons, preview) |
| **Visitor Input** | Requires Google Cloud service account & Sheet auth | **Direct copy-paste from Sheet Column A** or upload .txt/.csv |
| **PDF Input** | Google Drive API with folder ID & manual chunk downloads | **Drag & drop multiple PDFs directly** from your computer |
| **Execution** | Manual cell-by-cell execution | **1-Click "Scan & Highlight"** with live progress bar |
| **Visual Preview** | None (check files in Google Drive) | **Live document viewer** with page navigation |
| **Downloads** | Files saved to Google Drive paths | **1-Click Combined PDF** & **All Individual PDFs (.ZIP)** |
| **Matching Engine** | Basic first/last name regex | **Enhanced engine**: handles diacritics (`Giardina'`, `Schütz`), honorifics (`Prof.`, `Dr.`), and paragraph boundaries |

---

## 🚀 How to Use

### Method 1: Instant Browser Web App (Zero Setup)
No installation or Python required. Runs 100% locally in your browser.

1. Navigate to:
   ```
   tifr-visitor-highlighter/index.html
   ```
2. Double-click **`run_web_app.bat`** (or open `index.html` in Chrome / Edge / Brave).
3. **Step 1:** Paste your visitor list from Google Sheet (Column A) or click *"Load Sample Visitors"*.
4. **Step 2:** Drag and drop your approval PDFs into the dropzone.
5. Click **"Scan PDFs & Highlight Visitors"**.
6. View real-time results:
   - 📥 **Download Combined PDF** (ordered by spreadsheet sequence).
   - 📦 **Download All Individual PDFs (.ZIP)** (`TIFR Approval - [Visitor Name].pdf`).
   - 👁️ **Visual Preview:** Click "View" next to any visitor to inspect the highlighted approval letter.

---

### Method 2: Google Colab 1-Click Web App (Gradio)
If you prefer running in Google Colab (with Colab's cloud GPU/CPU and zero local software):

1. Open a new notebook in [Google Colab](https://colab.research.google.com).
2. Create **Cell 1**:
   ```bash
   !apt install poppler-utils tesseract-ocr -y
   !pip install gradio pdf2image pytesseract pillow pypdf gspread
   ```
3. Create **Cell 2**: Copy and paste the code from [`colab_notebook_code.py`](file:///C:/Users/HarishitSM/.gemini/antigravity/scratch/tifr-visitor-highlighter/colab_notebook_code.py).
4. Run both cells.
5. Colab will generate a public Gradio URL (e.g. `https://xxxx.gradio.live`). Open it on your laptop or phone to use the web application!

---

### Method 3: Local Server
If you'd like to host the web app locally on your network:
```powershell
python serve.py
```
Open [http://localhost:8080/index.html](http://localhost:8080/index.html) in your browser.

---

## 📂 Project Structure

```text
tifr-visitor-highlighter/
├── index.html               # Main Web App UI (Tailwind CSS, responsive layout)
├── app.js                   # Client-side processing engine (PDF.js, PDF-Lib, JSZip)
├── run_web_app.bat          # 1-Click Windows launcher
├── serve.py                 # Lightweight local web server
├── colab_notebook_code.py   # 1-Click Google Colab Gradio Web App script
├── test_engine.js           # Unit tests for matching and parsing logic
├── samples/                 # Sample generated TIFR sanction letters for testing
│   ├── TIFR_Sanction_Batch_1.pdf
│   └── TIFR_Sanction_Batch_2.pdf
└── README.md                # Documentation & User Guide
```
