// Usage: npm run check
// .env ki AI key ko Groq aur xAI (aur AI_BASE_URL agar set ho) par test karta hai.
require('dotenv').config();

const key = (process.env.AI_API_KEY || process.env.GROQ_API_KEY || '').trim();
if (!key) { console.error('AI_API_KEY (ya GROQ_API_KEY) .env mein nahi mila.'); process.exit(1); }

const candidates = process.env.AI_BASE_URL
  ? [['Custom (AI_BASE_URL)', process.env.AI_BASE_URL.trim().replace(/\/+$/, '')]]
  : [['Groq', 'https://api.groq.com/openai/v1'], ['xAI Grok', 'https://api.x.ai/v1']];

(async () => {
  console.log(`Key format: ${key.slice(0, 4)}... (length ${key.length})\n`);
  let worked = null;
  for (const [name, base] of candidates) {
    try {
      const r = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20000)
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        const ids = (data.data || []).map(m => m.id);
        console.log(`✅ ${name} (${base}): key chal rahi hai. ${ids.length} models mile.`);
        console.log('   Examples:', ids.slice(0, 12).join(', '));
        worked ||= { name, base, ids };
      } else {
        const msg = data?.error?.message || (typeof data?.error === 'string' ? data.error : '') || '';
        console.log(`❌ ${name} (${base}): HTTP ${r.status} ${msg}`);
      }
    } catch (e) {
      console.log(`❌ ${name} (${base}): ${e.message}`);
    }
  }
  console.log('');
  if (worked) {
    console.log('.env mein ye lines rakhein:');
    console.log(`AI_BASE_URL=${worked.base}`);
    console.log(`AI_MODEL=<upar ki list mein se koi chat model chunein>`);
  } else {
    console.log('Kisi bhi provider par key nahi chali.');
    console.log('- Groq key: console.groq.com/keys (gsk_... se shuru)');
    console.log('- xAI key : console.x.ai (xai-... se shuru)');
    console.log('- Agar key kisi aur service ki hai to uska URL AI_BASE_URL mein daal kar dobara "npm run check" chalayein.');
    process.exitCode = 1;
  }
})();
