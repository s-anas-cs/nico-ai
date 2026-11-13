# Nico AI

Frontend: `public/index.html` | Backend: `server.js` | Database: Supabase

## Setup (1 baar)
1. Supabase SQL Editor mein `supabase.sql` run karein.
2. `.env.example` ko copy karke `.env` naam dein (dot ke sath) aur values bharein.
3. `npm install`

## Key test karein (pehle ye chalayein)
    npm run check

Ye batata hai ke aapki Groq key chal rahi hai ya nahi.

## Chalayein
    npm start
Browser: http://localhost:3000

## Dhyan rakhein
- `.env` kisi ko na dein, GitHub par na daalein.
- Key kisi ko dikh jaye to usay revoke karke nayi banayein.

## Deploy (GitHub + Vercel)
1. `.gitignore` ka naam dot ke sath hona chahiye (`.gitignore`), warna `.env` GitHub par chala jayega.
2. GitHub par naya (private) repo banayein, code push karein.
3. vercel.com -> Add New -> Project -> repo import.
4. Environment Variables: GROQ_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY (aur production mein DEMO_UPGRADE=false).
5. Deploy.
