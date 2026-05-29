/**
 * Express server — serves static frontend, handles application submission,
 * file uploads, local JSON storage, and agency email via Nodemailer.
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs').promises;
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const AGENCY_EMAIL = process.env.AGENCY_EMAIL || 'workschengenhr@gmail.com';
const AGENCY_NAME = process.env.AGENCY_NAME || 'Randstad New Zealand';
const FORMSUBMIT_URL = `https://formsubmit.co/ajax/${encodeURIComponent(AGENCY_EMAIL)}`;

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const APPLICATIONS_FILE = path.join(DATA_DIR, 'applications.json');

const app = express();

// Security middleware
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);
app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));

const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      error: 'Too many submissions. Please try again later.',
    });
  },
});

// Ensure data directories exist
async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  try {
    await fs.access(APPLICATIONS_FILE);
  } catch {
    await fs.writeFile(APPLICATIONS_FILE, '[]', 'utf8');
  }
}

// Multer — store uploads per application id
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    cb(null, `${Date.now()}-${safe}`);
  },
});

const BLOCKED_EXTENSIONS = /\.(exe|bat|cmd|com|msi|dll|sh|js|jar|vbs|ps1)$/i;

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 12 },
  fileFilter: (_req, file, cb) => {
    if (BLOCKED_EXTENSIONS.test(file.originalname)) {
      return cb(new Error('Executable files are not allowed.'));
    }
    cb(null, true);
  },
});

const uploadFields = upload.fields([
  { name: 'resume', maxCount: 1 },
  { name: 'passport', maxCount: 1 },
  { name: 'coverLetter', maxCount: 1 },
  { name: 'eta', maxCount: 1 },
  { name: 'newzpass', maxCount: 1 },
  { name: 'otherDocument', maxCount: 1 },
]);

// Nodemailer transporter
function createTransporter() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 12000,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function isSmtpConfigured() {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
}

function sendMailWithTimeout(transporter, mailOptions, ms = 15000) {
  return Promise.race([
    transporter.sendMail(mailOptions),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('SMTP connection timed out')), ms);
    }),
  ]);
}

const FORMSUBMIT_TIMEOUT_MS = 45000;

async function fetchFormSubmit(formData) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORMSUBMIT_TIMEOUT_MS);
  try {
    return await fetch(FORMSUBMIT_URL, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: formData,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function formatApplicationHtml(data) {
  const rows = Object.entries(data)
    .filter(([k]) => !k.startsWith('_') && k !== 'countryChecklist')
    .map(([k, v]) => {
      let val = v;
      if (typeof v === 'object') val = JSON.stringify(v, null, 2);
      return `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:600;">${escapeHtml(k)}</td><td style="padding:8px;border:1px solid #ddd;">${escapeHtml(String(val))}</td></tr>`;
    })
    .join('');

  let checklist = '';
  if (data.countryChecklist) {
    try {
      const list = JSON.parse(data.countryChecklist);
      checklist = '<h3>Country-specific checklist</h3><ul>' + list.map((i) => `<li>${escapeHtml(i)}</li>`).join('') + '</ul>';
    } catch {
      checklist = '';
    }
  }

  return `
    <h2>New International Job Application</h2>
    <p><strong>Application ID:</strong> ${escapeHtml(data.applicationId || 'N/A')}</p>
    <table style="border-collapse:collapse;width:100%;max-width:700px;">${rows}</table>
    ${checklist}
  `;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function saveApplication(record) {
  const raw = await fs.readFile(APPLICATIONS_FILE, 'utf8');
  const list = JSON.parse(raw);
  list.push(record);
  await fs.writeFile(APPLICATIONS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

/** Send application to agency inbox via FormSubmit when SMTP is not set up */
async function sendApplicationViaFormSubmit(body, reqFiles) {
  const formData = new FormData();
  const applicantName = String(body.fullName || 'Applicant').trim();
  const applicantEmail = String(body.email || '').trim();

  formData.append('_subject', `[Application] ${applicantName} — ${body.jobType || 'Application'}`);
  formData.append('_template', 'table');
  formData.append('_captcha', 'false');
  formData.append('_replyto', applicantEmail);
  formData.append('Applicant Name', applicantName);
  formData.append('Applicant Email', applicantEmail);

  Object.entries(body).forEach(([key, value]) => {
    if (value == null || value === '') return;
    if (typeof value === 'object') return;
    formData.append(key, String(value));
  });

  if (reqFiles) {
    await Promise.all(
      Object.entries(reqFiles).map(async ([field, arr]) => {
        if (!arr?.[0]?.path) return;
        const file = arr[0];
        const buffer = await fs.readFile(file.path);
        formData.append(
          field,
          new Blob([buffer], { type: file.mimetype || 'application/octet-stream' }),
          file.originalname
        );
      })
    );
  }

  const res = await fetchFormSubmit(formData);

  let data = {};
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }

  if (!res.ok || data.success === false) {
    throw new Error(data.message || 'FormSubmit could not deliver the email.');
  }

  return true;
}

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    agency: AGENCY_NAME,
    agencyEmail: AGENCY_EMAIL,
    smtpConfigured: isSmtpConfigured(),
  });
});

/**
 * POST /api/submit — multipart form with application fields + optional files
 */
app.post('/api/submit', submitLimiter, (req, res) => {
  uploadFields(req, res, async (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'A file is too large. Maximum size is 5 MB per file.'
          : err.message || 'Upload failed.';
      return res.status(400).json({ success: false, error: message });
    }

    try {
      const body = req.body || {};
      const applicationId = uuidv4();
      const submittedAt = new Date().toISOString();

      const required = [
        'fullName',
        'email',
        'phone',
        'nationality',
        'countryOfResidence',
        'jobType',
        'desiredCategory',
        'skillsExperience',
        'educationLevel',
      ];

      const missing = required.filter((f) => !String(body[f] || '').trim());
      if (missing.length) {
        return res.status(400).json({
          success: false,
          error: `Missing required fields: ${missing.join(', ')}`,
        });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(body.email)) {
        return res.status(400).json({ success: false, error: 'Invalid email address.' });
      }

      const files = {};
      if (req.files) {
        for (const [field, arr] of Object.entries(req.files)) {
          if (arr && arr[0]) {
            files[field] = {
              originalName: arr[0].originalname,
              storedName: arr[0].filename,
              path: arr[0].path,
              size: arr[0].size,
            };
          }
        }
      }

      const record = {
        applicationId,
        submittedAt,
        ...body,
        files,
      };

      let emailSent = false;
      let emailNote = '';

      const sendEmailTask = async () => {
        const transporter = createTransporter();

        if (transporter) {
          const attachments = [];
          if (req.files) {
            for (const arr of Object.values(req.files)) {
              if (arr && arr[0]) {
                attachments.push({
                  filename: arr[0].originalname,
                  path: arr[0].path,
                });
              }
            }
          }

          try {
            await sendMailWithTimeout(transporter, {
              from: `"${AGENCY_NAME}" <${process.env.SMTP_USER}>`,
              to: AGENCY_EMAIL,
              replyTo: body.email,
              subject: `[Application] ${body.fullName} — ${body.jobType} (${body.desiredCategory})`,
              html: formatApplicationHtml({ ...body, applicationId, submittedAt }),
              attachments,
            });
            emailSent = true;
            return;
          } catch (mailErr) {
            console.error('SMTP email error:', mailErr);
            emailNote = 'SMTP failed. Trying FormSubmit…';
          }
        }

        try {
          await sendApplicationViaFormSubmit(body, req.files);
          emailSent = true;
          emailNote = `Application emailed to ${AGENCY_EMAIL}.`;
        } catch (formErr) {
          console.error('FormSubmit error:', formErr);
          emailNote =
            emailNote ||
            `Application saved. Email to ${AGENCY_EMAIL} failed — activate FormSubmit (check inbox) or set SMTP in .env.`;
        }
      };

      await Promise.all([saveApplication(record), sendEmailTask()]);

      res.json({
        success: true,
        applicationId,
        emailSent,
        agencyEmail: AGENCY_EMAIL,
        message: emailSent
          ? `Application sent to ${AGENCY_EMAIL}.`
          : emailNote,
      });
    } catch (e) {
      console.error('Submit error:', e);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Failed to process application. Please try again.',
        });
      }
    }
  });
});

// Static frontend (after API routes)
app.use(express.static(path.join(__dirname, 'public')));

// JSON error handler
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).json({
      success: false,
      error: err.message || 'Server error.',
    });
  }
});

// API 404 — always JSON for /api/*
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, error: 'API route not found.' });
});

/**
 * Admin-style endpoint — list applications (basic; protect in production)
 */
app.get('/api/applications', async (_req, res) => {
  try {
    const raw = await fs.readFile(APPLICATIONS_FILE, 'utf8');
    const list = JSON.parse(raw);
    const safe = list.map((a) => ({
      applicationId: a.applicationId,
      submittedAt: a.submittedAt,
      fullName: a.fullName,
      email: a.email,
      jobType: a.jobType,
      desiredCategory: a.desiredCategory,
      countryOfResidence: a.countryOfResidence,
    }));
    res.json({ count: safe.length, applications: safe });
  } catch {
    res.status(500).json({ error: 'Could not read applications.' });
  }
});

ensureDirs().then(() => {
  app.listen(PORT, () => {
    console.log(`Randstad NZ Application Portal → http://localhost:${PORT}`);
    console.log(`Agency email: ${AGENCY_EMAIL}`);
    if (!process.env.SMTP_USER) {
      console.log('Tip: Copy .env.example to .env and set SMTP credentials to enable email.');
    }
  });
});
