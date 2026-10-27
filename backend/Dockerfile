FROM python:3.11-slim

# Install system dependencies: poppler (for pdf2image) and native tesseract-ocr
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    tesseract-ocr \
    tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend application code
COPY . .

# Expose port (Render automatically sets $PORT)
ENV PORT=8000
EXPOSE 8000

# Start FastAPI server
CMD uvicorn main:app --host 0.0.0.0 --port $PORT
