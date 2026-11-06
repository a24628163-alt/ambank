// Netlify build: copies only public site files into dist/ (schema, functions and scripts stay private) and writes js/config.js from env vars.
const fs = require('fs'), path = require('path');
const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) { console.error('Set SUPABASE_URL and SUPABASE_ANON_KEY in Netlify > Site configuration > Environment variables.'); process.exit(1); }
fs.rmSync('dist', { recursive: true, force: true }); fs.mkdirSync('dist');
for (const f of fs.readdirSync('.')) if (f.endsWith('.html')) fs.copyFileSync(f, path.join('dist', f));
for (const d of ['css', 'js', 'assets']) fs.cpSync(d, path.join('dist', d), { recursive: true });
fs.writeFileSync('dist/js/config.js', `export const SUPABASE_URL = ${JSON.stringify(SUPABASE_URL)};\nexport const SUPABASE_ANON_KEY = ${JSON.stringify(SUPABASE_ANON_KEY)};\n`);
console.log('Built dist/');
