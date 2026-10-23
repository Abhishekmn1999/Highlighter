const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Security Headers (anti-clickjacking, MIME protection)
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Serve static assets from project root
app.use(express.static(path.join(__dirname)));

// Fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`TIFR Visitor Highlighter web server running on port ${PORT}`);
});
