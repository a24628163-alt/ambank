// Cloudflare Pages / Netlify build: copies only public site files into dist/ 
// and writes js/config.js from env vars.
const fs = require('fs');
const path = require('path');

// 1. Create the dist folder
fs.rmSync('dist', { recursive: true, force: true }); 
fs.mkdirSync('dist');

// 2. Copy HTML files (and rename login.html to index.html for the homepage)
for (const f of fs.readdirSync('.')) {
  if (f.endsWith('.html')) {
    const destName = (f === 'login.html') ? 'index.html' : f;
    fs.copyFileSync(f, path.join('dist', destName));
  }
}

// 3. Copy assets folders
for (const d of ['css', 'js', 'assets']) {
  if (fs.existsSync(d)) {
    fs.cpSync(d, path.join('dist', d), { recursive: true });
  }
}

// 4. Copy the _redirects file for Cloudflare routing
if (fs.existsSync('_redirects')) {
  fs.copyFileSync('_redirects', path.join('dist', '_redirects'));
}

// 5. Generate the config.js with your Supabase keys from Cloudflare Environment Variables
const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ ERROR: SUPABASE_URL and SUPABASE_ANON_KEY must be set in your Cloudflare Environment Variables.');
  process.exit(1);
}

const configContent = `export const SUPABASE_URL = '${SUPABASE_URL}';\nexport const SUPABASE_ANON_KEY = '${SUPABASE_ANON_KEY}';\n`;

fs.writeFileSync(path.join('dist', 'js', 'config.js'), configContent);

console.log('✅ Build complete! dist/ folder is ready. login.html was renamed to index.html.');