import { sb, makeClient, setMsg } from './app.js';

export function setupPasswordToggle() {
  document.querySelectorAll('.pw').forEach(box => {
    const input = box.querySelector('input'), btn = box.querySelector('button');
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.innerHTML = `<i class="fa-solid fa-eye${show ? '-slash' : ''}"></i>`;
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
  });
}
setupPasswordToggle();

const msg = document.getElementById('msg'), form = document.querySelector('form');
const page = form.dataset.page;

// Persist the "remember me" choice to both storages so every page in this tab
// (and the dashboard client built in app.js) picks the same storage backend.
function setRemember(remember) {
  const v = remember ? '1' : '0';
  try { localStorage.setItem('ambank_remember', v); } catch {}
  try { sessionStorage.setItem('ambank_remember', v); } catch {}
}

// If already signed in (with whatever storage was chosen last time), go straight to the dashboard.
if (page === 'login') {
  sb.auth.getSession().then(({ data }) => data.session && location.replace('dashboard.html'));
}

// --- CAMERA & FACE CAPTURE LOGIC (Only runs on register.html) ---
let videoStream = null;
let capturedPhotoBlob = null;

if (page === 'register') {
  const video = document.getElementById('video');
  const photo = document.getElementById('photo');
  const startBtn = document.getElementById('startCamBtn');
  const captureBtn = document.getElementById('captureBtn');
  const retakeBtn = document.getElementById('retakeBtn');

  startBtn.onclick = async () => {
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      video.srcObject = videoStream;
      video.style.display = 'block';
      startBtn.style.display = 'none';
      captureBtn.style.display = 'block';
    } catch (err) {
      setMsg(msg, 'Camera access denied. Please allow camera permissions to verify identity.');
    }
  };

  captureBtn.onclick = () => {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    
    // Convert canvas to blob
    canvas.toBlob((blob) => {
      capturedPhotoBlob = blob;
      photo.src = URL.createObjectURL(blob);
      
      // Stop camera
      if (videoStream) videoStream.getTracks().forEach(track => track.stop());
      
      // Update UI
      video.style.display = 'none';
      photo.style.display = 'block';
      captureBtn.style.display = 'none';
      retakeBtn.style.display = 'block';
    }, 'image/jpeg', 0.8);
  };

  retakeBtn.onclick = () => {
    capturedPhotoBlob = null;
    photo.style.display = 'none';
    retakeBtn.style.display = 'none';
    startBtn.style.display = 'block';
    startBtn.click(); // Auto-restart camera
  };
}
// --- END CAMERA LOGIC ---

form.addEventListener('submit', async e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form)), btn = form.querySelector('.btn');
  setMsg(msg, '');
  btn.disabled = true;
  
  try {
    if (page === 'login') {
      const remember = !!f.remember, id = f.email.trim();
      setRemember(remember);
      const client = makeClient(remember);
      if (/^\d{10}$/.test(id)) {   // account number: resolved server-side by the 'login' Edge Function
        const { data, error } = await client.functions.invoke('login', { body: { identifier: id, password: f.password } });
        if (error || !data?.access_token) throw new Error('Invalid login credentials');
        const { error: e2 } = await client.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token });
        if (e2) throw e2;
      } else {
        const { error } = await client.auth.signInWithPassword({ email: id, password: f.password });
        if (error) throw error;
      }
      location.href = 'dashboard.html';
      
    } else {
      // REGISTRATION LOGIC
      if (f.password.length < 8) throw new Error('Password must be at least 8 characters');
      if (f.password !== f.confirm) throw new Error('Passwords do not match');
      
      // 18+ Age Validation
      if (!f.dob) throw new Error('Please enter your date of birth.');
      const dob = new Date(f.dob);
      const ageDifMs = Date.now() - dob.getTime();
      const ageDate = new Date(ageDifMs); 
      const age = Math.abs(ageDate.getUTCFullYear() - 1970);
      if (age < 18) throw new Error('You must be at least 18 years old to register.');

      // Facial Verification Check
      if (!capturedPhotoBlob) throw new Error('Please capture a facial photo for identity verification.');

      const client = makeClient(true);
      const { data, error } = await client.auth.signUp({
        email: f.email.trim(),
        password: f.password,
        options: {
          data: { 
            full_name: f.full_name.trim(), 
            phone: f.phone.trim(),
            dob: f.dob,
            id_number: f.id_number,
            occupation: f.occupation
          },
          emailRedirectTo: location.origin + '/login.html'
        }
      });
      
      if (error) throw error;
      
      // Upload the photo to Supabase Storage
      if (data.user && capturedPhotoBlob) {
        const { error: uploadError } = await client.storage
          .from('kyc-documents')
          .upload(`${data.user.id}/face.jpg`, capturedPhotoBlob, { upsert: true });
          
        if (uploadError) {
          console.error('Photo upload failed:', uploadError);
          // We don't block registration if the photo fails, but you might want to in production
        }
      }

      if (data.session) location.href = 'dashboard.html';
      else setMsg(msg, 'Check your email to confirm your account, then sign in.', 'ok');
    }
  } catch (err) { 
    setMsg(msg, err.message); 
  }
  btn.disabled = false;
});

document.getElementById('forgot')?.addEventListener('click', async e => {
  e.preventDefault();
  const email = form.email.value.trim();
  if (!email) return setMsg(msg, 'Enter your email first.');
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/reset.html' });
  error ? setMsg(msg, error.message) : setMsg(msg, 'Password reset link sent. Check your email.', 'ok');
});