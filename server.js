require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

// ───────────────────────── Config ─────────────────────────
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  PORT = 3000,
  CORS_ORIGIN = '*',
  DEMO_UPGRADE = 'false'
} = process.env;

// ── AI provider (OpenAI-compatible). Groq ya xAI Grok, dono chalte hain ──
//   Groq : AI_BASE_URL=https://api.groq.com/openai/v1   AI_MODEL=qwen/qwen3.6-27b
//   xAI  : AI_BASE_URL=https://api.x.ai/v1              AI_MODEL=grok-4.7
const AI_API_KEY = (process.env.AI_API_KEY || process.env.GROQ_API_KEY || '').trim();
const detectBase = k => (k.startsWith('xai-') ? 'https://api.x.ai/v1' : 'https://api.groq.com/openai/v1');
const AI_BASE_URL = (process.env.AI_BASE_URL || detectBase(AI_API_KEY)).trim().replace(/\/+$/, '');
const IS_GROQ = AI_BASE_URL.includes('groq.com');
const KEY_LOOKS_STANDARD = /^(gsk_|xai-|sk-)/.test(AI_API_KEY);

for (const [k, v] of Object.entries({ 'AI_API_KEY (ya GROQ_API_KEY)': AI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY })) {
  if (!v) {
    console.error(`Missing ${k} in .env`);
    process.exit(1);
  }
}

const FREE_MAX_RESPONSES = 5;
const COOLDOWN_MS = 30 * 60 * 1000;
const HISTORY_LIMIT = 6;
const MAX_MESSAGE_CHARS = 12000;
// Har plan ke liye same model (text + image dono samajhne wala).
const AI_MODEL = (process.env.AI_MODEL || process.env.GROQ_MODEL || (IS_GROQ ? 'qwen/qwen3.6-27b' : 'grok-4.7')).trim();
// Fallback optional hai (text-only). Groq par default gpt-oss-120b, baaki par jab tak set na karo koi fallback nahi.
const AI_FALLBACK_MODEL = (process.env.AI_FALLBACK_MODEL || process.env.GROQ_FALLBACK_MODEL || (IS_GROQ ? 'openai/gpt-oss-120b' : '')).trim();

// Plans sirf limits (PDF/images) aur Pro-lock ke liye alag hain, model sab ka same.
const MODELS = {
  'nico-2.0':     { label: 'Nico 2.0',         locked: false, maxPdfs: 1, maxImages: 3 },
  'nico-pro-3.5': { label: 'Nico Pro 3.5',     locked: true,  maxPdfs: 2, maxImages: 5 },
  'nico-code':    { label: 'Nico Code Expert', locked: true,  maxPdfs: 4, maxImages: 6 }
};

const SYSTEM_PROMPT =
  'You are Nico AI, an expert, helpful assistant. Format code cleanly inside fenced markdown blocks ' +
  'with the language specified (e.g. ```html, ```python, ```javascript).';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

// ───────────────────────── App ─────────────────────────
const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map(s => s.trim()) }));
app.use(express.json({ limit: '4mb' })); // Vercel ki limit 4.5MB hai; frontend images chhoti karke bhejta hai
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: res => res.setHeader('Cache-Control', 'no-store')
}));

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, thora ruk kar try karein.' }
});

// ───────────────────────── Helpers ─────────────────────────
const wrap = fn => (req, res) =>
  Promise.resolve(fn(req, res)).catch(err => {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Server error', ...(err.code ? { code: err.code } : {}), ...(err.extra || {}) });
  });

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.extra = extra;
  return e;
}

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const CHAT_ID_RE = /^[A-Za-z0-9_-]{6,80}$/;

// Har request par client id verify + profile load/create
async function auth(req, res, next) {
  try {
    const clientId = req.get('x-client-id');
    if (!clientId || !CLIENT_ID_RE.test(clientId)) throw httpError(401, 'Invalid client id');
    req.clientId = clientId;
    req.profile = await getProfile(clientId);
    next();
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
}

async function getProfile(clientId) {
  let { data, error } = await supabase.from('profiles').select('*').eq('client_id', clientId).maybeSingle();
  if (error) throw error;
  if (!data) {
    const ins = await supabase.from('profiles').insert({ client_id: clientId }).select().single();
    if (ins.error) throw ins.error;
    data = ins.data;
  }
  // cooldown khatam ho gaya to counter reset
  if (Number(data.cooldown_until) > 0 && Number(data.cooldown_until) <= Date.now()) {
    const up = await supabase
      .from('profiles')
      .update({ free_count: 0, cooldown_until: 0 })
      .eq('client_id', clientId)
      .select()
      .single();
    if (up.error) throw up.error;
    data = up.data;
  }
  return data;
}

const publicProfile = p => ({
  isPro: !!p.is_pro,
  freeCount: p.free_count,
  cooldownUntil: Number(p.cooldown_until) || 0
});

async function assertChatOwner(chatId, clientId) {
  const { data, error } = await supabase.from('chats').select('id, client_id').eq('id', chatId).maybeSingle();
  if (error) throw error;
  if (data && data.client_id !== clientId) throw httpError(403, 'Forbidden');
  return !!data; // exists?
}

function cleanAttachments(list, tier) {
  const out = [];
  let pdfs = 0;
  let images = 0;
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || typeof a !== 'object') continue;
    const name = String(a.name || 'file').slice(0, 200);
    if (a.type === 'pdf') {
      if (++pdfs > tier.maxPdfs) throw httpError(400, `${tier.label} allows max ${tier.maxPdfs} PDF(s) per prompt.`);
      out.push({ type: 'pdf', name, textContent: String(a.textContent || '').slice(0, 4000) });
    } else if (a.type === 'image') {
      if (++images > tier.maxImages) throw httpError(400, `${tier.label} allows max ${tier.maxImages} image(s) per prompt.`);
      if (typeof a.dataUrl !== 'string' || !a.dataUrl.startsWith('data:image/')) continue;
      out.push({ type: 'image', name, dataUrl: a.dataUrl });
    }
  }
  return out;
}

// <think>...</think> reasoning blocks user ko nahi dikhane
const stripThinking = t => t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

const toPlainText = c =>
  Array.isArray(c) ? c.filter(p => p.type === 'text').map(p => p.text).join('\n') : c;

async function callAI(history, userContent) {
  let lastError = 'AI service se connect nahi ho paya.';
  const attempts = [{ model: AI_MODEL, content: userContent }];
  if (AI_FALLBACK_MODEL && AI_FALLBACK_MODEL !== AI_MODEL) {
    attempts.push({ model: AI_FALLBACK_MODEL, content: toPlainText(userContent) }); // fallback text-only
  }

  for (const { model, content } of attempts) {
    try {
      const r = await fetch(`${AI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history, { role: 'user', content }]
        }),
        signal: AbortSignal.timeout(90000)
      });
      const data = await r.json().catch(() => ({}));
      const raw = data?.choices?.[0]?.message?.content;
      const text = raw ? stripThinking(raw) : '';
      if (r.ok && text) return text;

      const detail = data?.error?.message || (typeof data?.error === 'string' ? data.error : '') || data?.message || '';
      lastError = `AI provider error (${r.status}) [${model}]: ${detail || 'empty response'}`;
      console.warn(`[ai] ${lastError}`);
      if (r.status === 401 || r.status === 403) {
        lastError = `API key galat ya allowed nahi hai (${r.status}). ${detail}`.trim();
        if (!KEY_LOOKS_STANDARD) {
          lastError += ' | Ye key Groq (gsk_) ya xAI (xai-) format ki nahi lagti. Apne provider ka AI_BASE_URL aur AI_MODEL .env mein set karein, ya "npm run check" chalayein.';
        }
        break; // key ghalat hai, fallback ka faida nahi
      }
    } catch (e) {
      lastError = e.name === 'TimeoutError' ? 'AI ne time par jawab nahi diya.' : `Network error: ${e.message}`;
      console.warn(`[ai] ${model} error: ${lastError}`);
    }
  }
  throw httpError(502, lastError);
}

// ───────────────────────── Routes ─────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Page load par: profile + saari chats + messages
app.get('/api/bootstrap', auth, wrap(async (req, res) => {
  const { data: chats, error } = await supabase
    .from('chats')
    .select('id, title, updated_at')
    .eq('client_id', req.clientId)
    .order('updated_at', { ascending: false })
    .limit(50);
  if (error) throw error;

  let byChat = {};
  if (chats.length) {
    const { data: msgs, error: mErr } = await supabase
      .from('messages')
      .select('id, chat_id, role, model, text, attachments, created_at')
      .in('chat_id', chats.map(c => c.id))
      .order('created_at', { ascending: true });
    if (mErr) throw mErr;
    for (const m of msgs) {
      (byChat[m.chat_id] ||= []).push({
        id: m.id,
        role: m.role,
        model: m.model || undefined,
        text: m.text,
        attachments: m.attachments || []
      });
    }
  }

  res.json({
    profile: publicProfile(req.profile),
    chats: chats.map(c => ({
      id: c.id,
      title: c.title,
      updatedAt: new Date(c.updated_at).getTime(),
      messages: byChat[c.id] || []
    }))
  });
}));

// Message bhejo -> AI jawab -> dono DB mein save
app.post('/api/chat', chatLimiter, auth, wrap(async (req, res) => {
  const { chatId, title, message, model: modelKey, attachments } = req.body || {};
  const profile = req.profile;

  if (!chatId || !CHAT_ID_RE.test(chatId)) throw httpError(400, 'Invalid chatId');
  if (typeof message !== 'string' || !message.trim()) throw httpError(400, 'Message required');
  if (message.length > MAX_MESSAGE_CHARS) throw httpError(400, 'Message bohot lamba hai.');

  const tier = MODELS[modelKey];
  if (!tier) throw httpError(400, 'Unknown model');
  if (tier.locked && !profile.is_pro) throw httpError(403, `${tier.label} sirf Pro users ke liye hai.`);

  // Free limit server par enforce
  if (!profile.is_pro && Number(profile.cooldown_until) > Date.now()) {
    throw httpError(429, 'Free limit reached. Wait for the timer or upgrade to Pro.', {
      cooldownUntil: Number(profile.cooldown_until)
    });
  }

  const atts = cleanAttachments(attachments, tier);

  // Chat row ensure + ownership check
  const exists = await assertChatOwner(chatId, req.clientId);
  const safeTitle = String(title || 'New Conversation').slice(0, 80);
  if (!exists) {
    const { error } = await supabase.from('chats').insert({ id: chatId, client_id: req.clientId, title: safeTitle });
    if (error) throw error;
  }

  // Pichli history DB se (client par trust nahi)
  const { data: past, error: hErr } = await supabase
    .from('messages')
    .select('role, text')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);
  if (hErr) throw hErr;
  const history = (past || []).reverse().map(m => ({
    role: m.role === 'ai' ? 'assistant' : 'user',
    content: m.text
  }));

  // User content (PDF text + images)
  const pdfNotes = atts.filter(a => a.type === 'pdf').map(p => `[PDF: ${p.name}]\n${p.textContent}`).join('\n\n');
  const combinedText = pdfNotes ? `${pdfNotes}\n\nUser Question: ${message}` : message;
  const images = atts.filter(a => a.type === 'image');
  const userContent = images.length
    ? [{ type: 'text', text: combinedText }, ...images.map(i => ({ type: 'image_url', image_url: { url: i.dataUrl } }))]
    : combinedText;

  const reply = await callAI(history, userContent);

  // Save: attachments ka sirf metadata (base64 images DB mein nahi)
  const meta = atts.map(a => ({ type: a.type, name: a.name }));
  // Bulk insert mein har row ke saare columns explicitly dene hain (missing key = null ban jata hai)
  const now = Date.now();
  const { data: saved, error: sErr } = await supabase
    .from('messages')
    .insert([
      { chat_id: chatId, role: 'user', model: null, text: message, attachments: meta, created_at: new Date(now - 1).toISOString() },
      { chat_id: chatId, role: 'ai', model: tier.label, text: reply, attachments: [], created_at: new Date(now).toISOString() }
    ])
    .select('id, role');
  if (sErr) throw sErr;

  await supabase.from('chats').update({ updated_at: new Date().toISOString() }).eq('id', chatId);

  // Usage update
  let freeCount = profile.free_count;
  let cooldownUntil = Number(profile.cooldown_until) || 0;
  if (!profile.is_pro) {
    freeCount += 1;
    if (freeCount >= FREE_MAX_RESPONSES) cooldownUntil = Date.now() + COOLDOWN_MS;
    await supabase.from('profiles').update({ free_count: freeCount, cooldown_until: cooldownUntil }).eq('client_id', req.clientId);
  }

  res.json({
    reply,
    model: tier.label,
    messageId: saved.find(m => m.role === 'ai')?.id,
    profile: { isPro: !!profile.is_pro, freeCount, cooldownUntil }
  });
}));

app.delete('/api/chats/:id', auth, wrap(async (req, res) => {
  const { error } = await supabase.from('chats').delete().eq('id', req.params.id).eq('client_id', req.clientId);
  if (error) throw error;
  res.json({ ok: true });
}));

app.post('/api/chats/:id/clear', auth, wrap(async (req, res) => {
  const exists = await assertChatOwner(req.params.id, req.clientId);
  if (exists) {
    const { error } = await supabase.from('messages').delete().eq('chat_id', req.params.id);
    if (error) throw error;
    await supabase.from('chats').update({ title: 'New Conversation' }).eq('id', req.params.id);
  }
  res.json({ ok: true });
}));

// Demo upgrade: sirf testing. Real payment (Stripe etc.) lagane par isko replace karein.
app.post('/api/upgrade', auth, wrap(async (req, res) => {
  if (DEMO_UPGRADE !== 'true') throw httpError(501, 'Payments abhi configure nahi hain.');
  const { data, error } = await supabase
    .from('profiles')
    .update({ is_pro: true, free_count: 0, cooldown_until: 0 })
    .eq('client_id', req.clientId)
    .select()
    .single();
  if (error) throw error;
  res.json({ profile: publicProfile(data) });
}));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Startup self-check: UI file + Supabase ──
function checkUiFile() {
  const fs = require('fs');
  const file = path.join(__dirname, 'public', 'index.html');
  if (!fs.existsSync(file)) {
    console.error(`❌ UI file nahi mili: ${file}\n   index.html ko "public" folder ke andar rakhein.`);
    return;
  }
  const html = fs.readFileSync(file, 'utf8');
  if (html.includes('NICO_UI_V3')) console.log(`✅ UI file theek hai: ${file}`);
  else console.error(`❌ Ye PURANI index.html hai (bug wali): ${file}\n   Nayi zip wali public/index.html se isko replace karein.`);
}

async function checkSupabase() {
  const { error } = await supabase.from('profiles').select('client_id').limit(1);
  if (!error) { console.log('✅ Supabase connected, tables theek hain'); return; }
  console.error(`❌ Supabase problem: ${error.message}`);
  const m = String(error.message || '').toLowerCase();
  if (m.includes('schema cache') || m.includes('does not exist') || m.includes('relation')) {
    console.error('   -> Tables nahi bane. Supabase SQL Editor mein supabase.sql poora run karein.');
  } else if (m.includes('invalid api key') || m.includes('jwt')) {
    console.error('   -> SUPABASE_SERVICE_KEY galat hai. Project Settings -> API se service_role/secret key lein.');
  } else if (m.includes('fetch failed') || m.includes('enotfound')) {
    console.error('   -> SUPABASE_URL galat hai ya internet nahi hai.');
  }
}

// Local par: node server.js  |  Vercel par: app export hota hai (listen nahi chahiye)
if (require.main === module) {
  app.listen(PORT, () => {
    checkUiFile();
    checkSupabase().catch(e => console.error('Supabase check failed:', e.message));
    console.log(`Nico AI running on http://localhost:${PORT}`);
    console.log(`AI provider: ${AI_BASE_URL} | model: ${AI_MODEL}${AI_FALLBACK_MODEL ? ' | fallback: ' + AI_FALLBACK_MODEL : ''}`);
    if (!KEY_LOOKS_STANDARD) {
      console.warn('WARNING: API key ka format gsk_/xai- jaisa nahi hai. Agar AI jawab na de to "npm run check" chalayein.');
    }
  });
}

module.exports = app;
