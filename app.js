/* =========================================================
   DJ MIXER v3.1 — Persistent Library Edition
   node app.js
   Requires: yt-dlp, ffmpeg
   ========================================================= */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'music');
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

/* =========================================================
   TOOL CHECK
   ========================================================= */
function toolExists(cmd) {
  try { execSync('which ' + cmd, { stdio: 'ignore' }); return true; } catch (e) { return false; }
}
const HAS_YTDLP = toolExists('yt-dlp');
const HAS_FFMPEG = toolExists('ffmpeg');

/* =========================================================
   DATABASE (library.json)
   ========================================================= */
let DB = { tracks: [], playlists: [], history: [] };

function loadDB() {
  try {
    if (fs.existsSync(LIBRARY_FILE)) {
      const raw = fs.readFileSync(LIBRARY_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed.tracks) DB.tracks = parsed.tracks;
      if (parsed.playlists) DB.playlists = parsed.playlists;
      if (parsed.history) DB.history = parsed.history;
    }
  } catch (e) { console.error('loadDB error:', e.message); }
}

function saveDB() {
  try {
    fs.writeFileSync(LIBRARY_FILE, JSON.stringify(DB, null, 2));
  } catch (e) { console.error('saveDB error:', e.message); }
}

function scanOrphans() {
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.mp3'));
    const known = new Set(DB.tracks.map(t => t.file));
    let added = 0;
    for (const f of files) {
      if (!known.has(f)) {
        const fp = path.join(DATA_DIR, f);
        const stat = fs.statSync(fp);
        DB.tracks.push({
          id: path.basename(f, '.mp3'),
          title: path.basename(f, '.mp3'),
          artist: 'YouTube',
          duration: 0,
          bpm: 0,
          youtubeUrl: '',
          youtubeId: '',
          file: f,
          size: stat.size,
          addedAt: stat.mtimeMs,
          playCount: 0,
          lastPlayed: 0
        });
        added++;
      }
    }
    if (added) saveDB();
  } catch (e) { console.error('scanOrphans:', e.message); }
}

loadDB();
scanOrphans();

/* =========================================================
   HELPERS
   ========================================================= */
function isValidYoutubeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (!['youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com'].includes(host)) return false;
    return true;
  } catch (e) { return false; }
}

function extractYouTubeId(url) {
  if (!url) return null;
  url = String(url).trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
  let m = url.match(/(?:youtube\.com\/watch\?(?:.*&)?v=)([a-zA-Z0-9_-]{11})/); if (m) return m[1];
  m = url.match(/(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/); if (m) return m[1];
  m = url.match(/(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/); if (m) return m[1];
  m = url.match(/(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/); if (m) return m[1];
  return null;
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 50000) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch (e) { resolve({}); }
    });
  });
}

/* =========================================================
   DOWNLOAD JOBS (with progress)
   ========================================================= */
const jobs = new Map();

function findTrackByYoutubeUrl(url) {
  return DB.tracks.find(t => t.youtubeUrl === url);
}

function startDownload(youtubeUrl, jobId) {
  const trackId = crypto.randomBytes(6).toString('hex');
  const outTemplate = path.join(DATA_DIR, trackId + '.%(ext)s');

  const args = [
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--no-simulate',
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '128K',
    '--postprocessor-args', '-ar 44100',
    '-o', outTemplate,
    '--print', 'before_dl:TITLE:%(title)s',
    '--print', 'before_dl:DURATION:%(duration)s',
    '--print', 'before_dl:VIDID:%(id)s',
    '--print', 'after_move:FILE:%(filepath)s',
    youtubeUrl
  ];

  const proc = spawn('yt-dlp', args);
  let stdoutBuf = '';
  let stderr = '';

  proc.stdout.on('data', (d) => {
    stdoutBuf += d.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      const job = jobs.get(jobId);
      if (!job) continue;

      // progress line: "[download]  45.2% of 3.50MiB at ..."
      const pm = t.match(/\[download\]\s+([\d.]+)%/);
      if (pm) {
        const pct = parseFloat(pm[1]);
        job.progress = Math.min(85, pct * 0.85);
        job.phase = 'downloading';
        continue;
      }
      // postprocess phase
      if (t.includes('[ExtractAudio]') || t.includes('[ffmpeg]') || t.includes('Deleting original')) {
        if (job.progress < 85) job.progress = 85;
        job.phase = 'converting';
        continue;
      }
      if (t.startsWith('TITLE:')) { job.title = t.slice(6).trim(); continue; }
      if (t.startsWith('DURATION:')) { job.duration = parseFloat(t.slice(9).trim()) || 0; continue; }
      if (t.startsWith('VIDID:')) { job.youtubeId = t.slice(6).trim(); continue; }
      if (t.startsWith('FILE:')) { job.filePath = t.slice(5).trim(); continue; }
    }
  });

  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  proc.on('close', (code) => {
    const job = jobs.get(jobId);
    if (!job) return;

    if (code === 0 && job.filePath && fs.existsSync(job.filePath)) {
      const stat = fs.statSync(job.filePath);
      const finalId = path.basename(job.filePath, '.mp3');
      const track = {
        id: finalId,
        title: job.title || 'YouTube Track',
        artist: 'YouTube',
        duration: Math.round(job.duration || 0),
        bpm: 0,
        youtubeUrl,
        youtubeId: job.youtubeId || '',
        file: path.basename(job.filePath),
        size: stat.size,
        addedAt: Date.now(),
        playCount: 0,
        lastPlayed: 0
      };
      // remove any orphan with same youtube url (shouldn't happen since we check first)
      DB.tracks = DB.tracks.filter(t => t.youtubeUrl !== youtubeUrl);
      DB.tracks.unshift(track);
      saveDB();
      job.status = 'done';
      job.progress = 100;
      job.track = track;
    } else {
      job.status = 'error';
      job.progress = 0;
      job.error = (stderr || 'yt-dlp gagal').slice(0, 500);
      // cleanup partial
      try {
        if (job.filePath && fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath);
      } catch (e) {}
    }
  });

  proc.on('error', (err) => {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status = 'error';
    job.error = 'Gagal jalankan yt-dlp: ' + err.message;
  });
}

/* =========================================================
   HTTP HANDLERS
   ========================================================= */

// POST /api/load { url }
async function handleLoad(req, res) {
  const data = await readBody(req);
  const url = (data.url || '').trim();
  if (!isValidYoutubeUrl(url)) return sendJSON(res, 400, { error: 'Invalid YouTube URL' });

  // Already downloaded? Return existing track
  const existing = findTrackByYoutubeUrl(url);
  if (existing && fs.existsSync(path.join(DATA_DIR, existing.file))) {
    return sendJSON(res, 200, { existing: true, track: existing });
  }

  if (!HAS_YTDLP) return sendJSON(res, 500, { error: 'yt-dlp tidak terinstall di server' });

  const jobId = crypto.randomBytes(8).toString('hex');
  jobs.set(jobId, {
    status: 'pending',
    progress: 0,
    phase: 'starting',
    createdAt: Date.now(),
    url,
    title: null,
    duration: 0,
    youtubeId: null,
    filePath: null
  });
  startDownload(url, jobId);
  sendJSON(res, 200, { jobId });
}

// GET /api/status/:jobId
function handleStatus(res, jobId) {
  const job = jobs.get(jobId);
  if (!job) return sendJSON(res, 404, { error: 'Job not found' });
  sendJSON(res, 200, {
    status: job.status,
    progress: job.progress || 0,
    phase: job.phase,
    title: job.title,
    duration: job.duration || 0,
    error: job.error || null,
    track: job.track || null
  });
}

// GET /api/library
function handleLibrary(res) {
  sendJSON(res, 200, {
    tracks: DB.tracks,
    playlists: DB.playlists,
    history: DB.history.slice(0, 50)
  });
}

// GET /api/stream/:trackId
function handleStream(req, res, trackId) {
  const track = DB.tracks.find(t => t.id === trackId);
  if (!track) { res.writeHead(404); return res.end('Track not found'); }
  const fp = path.join(DATA_DIR, track.file);
  if (!fs.existsSync(fp)) { res.writeHead(404); return res.end('File missing'); }

  const stat = fs.statSync(fp);
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': 'audio/mpeg'
      });
      return fs.createReadStream(fp, { start, end }).pipe(res);
    }
  }
  res.writeHead(200, {
    'Content-Length': stat.size,
    'Content-Type': 'audio/mpeg',
    'Accept-Ranges': 'bytes'
  });
  fs.createReadStream(fp).pipe(res);
}

// DELETE /api/library/:trackId
function handleDeleteTrack(res, trackId) {
  const idx = DB.tracks.findIndex(t => t.id === trackId);
  if (idx < 0) return sendJSON(res, 404, { error: 'Track not found' });
  const track = DB.tracks[idx];
  try {
    const fp = path.join(DATA_DIR, track.file);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch (e) {}
  DB.tracks.splice(idx, 1);
  // remove from playlists
  DB.playlists.forEach(p => {
    p.trackIds = p.trackIds.filter(id => id !== trackId);
  });
  // remove from history
  DB.history = DB.history.filter(h => h.trackId !== trackId);
  saveDB();
  sendJSON(res, 200, { ok: true });
}

// POST /api/history { trackId, deckId }
async function handleAddHistory(req, res) {
  const data = await readBody(req);
  const { trackId, deckId } = data;
  if (!trackId) return sendJSON(res, 400, { error: 'trackId required' });
  const track = DB.tracks.find(t => t.id === trackId);
  if (track) {
    track.playCount = (track.playCount || 0) + 1;
    track.lastPlayed = Date.now();
  }
  DB.history.unshift({
    trackId,
    deckId: deckId || 'A',
    playedAt: Date.now()
  });
  if (DB.history.length > 100) DB.history.length = 100;
  saveDB();
  sendJSON(res, 200, { ok: true });
}

// DELETE /api/history
function handleClearHistory(res) {
  DB.history = [];
  saveDB();
  sendJSON(res, 200, { ok: true });
}

// POST /api/tracks/:id/meta { bpm }
async function handleTrackMeta(req, res, trackId) {
  const data = await readBody(req);
  const track = DB.tracks.find(t => t.id === trackId);
  if (!track) return sendJSON(res, 404, { error: 'Track not found' });
  if (typeof data.bpm === 'number' && data.bpm > 0) track.bpm = Math.round(data.bpm * 10) / 10;
  saveDB();
  sendJSON(res, 200, { ok: true });
}

// POST /api/playlists { name }
async function handleCreatePlaylist(req, res) {
  const data = await readBody(req);
  const name = (data.name || '').trim().slice(0, 60);
  if (!name) return sendJSON(res, 400, { error: 'Name required' });
  const pl = {
    id: crypto.randomBytes(6).toString('hex'),
    name,
    trackIds: [],
    createdAt: Date.now()
  };
  DB.playlists.unshift(pl);
  saveDB();
  sendJSON(res, 200, { playlist: pl });
}

// DELETE /api/playlists/:id
function handleDeletePlaylist(res, id) {
  const idx = DB.playlists.findIndex(p => p.id === id);
  if (idx < 0) return sendJSON(res, 404, { error: 'Not found' });
  DB.playlists.splice(idx, 1);
  saveDB();
  sendJSON(res, 200, { ok: true });
}

// POST /api/playlists/:id/tracks { trackId }
async function handleAddToPlaylist(req, res, id) {
  const data = await readBody(req);
  const pl = DB.playlists.find(p => p.id === id);
  if (!pl) return sendJSON(res, 404, { error: 'Playlist not found' });
  if (!data.trackId) return sendJSON(res, 400, { error: 'trackId required' });
  if (!pl.trackIds.includes(data.trackId)) pl.trackIds.push(data.trackId);
  saveDB();
  sendJSON(res, 200, { ok: true, playlist: pl });
}

// DELETE /api/playlists/:id/tracks/:trackId
function handleRemoveFromPlaylist(res, id, trackId) {
  const pl = DB.playlists.find(p => p.id === id);
  if (!pl) return sendJSON(res, 404, { error: 'Playlist not found' });
  pl.trackIds = pl.trackIds.filter(t => t !== trackId);
  saveDB();
  sendJSON(res, 200, { ok: true });
}

/* =========================================================
   ROUTER
   ========================================================= */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  const method = req.method;

  try {
    if (p === '/' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(HTML);
    }
    if (p === '/api/health') {
      return sendJSON(res, 200, { ok: true, ytdlp: HAS_YTDLP, ffmpeg: HAS_FFMPEG });
    }
    if (p === '/api/load' && method === 'POST') return handleLoad(req, res);
    if (p.startsWith('/api/status/') && method === 'GET') return handleStatus(res, p.slice(12));
    if (p === '/api/library' && method === 'GET') return handleLibrary(res);
    if (p.startsWith('/api/stream/') && method === 'GET') return handleStream(req, res, p.slice(12));
    if (p.startsWith('/api/library/') && method === 'DELETE') return handleDeleteTrack(res, p.slice(13));
    if (p === '/api/history' && method === 'POST') return handleAddHistory(req, res);
    if (p === '/api/history' && method === 'DELETE') return handleClearHistory(res);
    if (p.startsWith('/api/tracks/') && p.endsWith('/meta') && method === 'POST') {
      return handleTrackMeta(req, res, p.slice(12, -5));
    }
    if (p === '/api/playlists' && method === 'POST') return handleCreatePlaylist(req, res);
    if (p.startsWith('/api/playlists/') && method === 'DELETE' && !p.includes('/tracks/')) {
      return handleDeletePlaylist(res, p.slice(15));
    }
    if (p.startsWith('/api/playlists/') && p.endsWith('/tracks') && method === 'POST') {
      return handleAddToPlaylist(req, res, p.slice(15, -7));
    }
    if (p.startsWith('/api/playlists/') && p.includes('/tracks/') && method === 'DELETE') {
      const parts = p.split('/');
      // /api/playlists/:id/tracks/:trackId
      return handleRemoveFromPlaylist(res, parts[3], parts[5]);
    }
    res.writeHead(404); res.end('Not found');
  } catch (err) {
    console.error('Server error:', err);
    sendJSON(res, 500, { error: err.message });
  }
});

/* =========================================================
   HTML
   ========================================================= */
const HTML = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<meta name="theme-color" content="#000">
<title>DJ MIXER</title>
<style>
:root{
  --bg:#000;--panel:#131315;--panel-2:#1a1b1e;--panel-3:#222327;
  --border:#2c2e32;--text:#fff;--text-2:#cfcfcf;--text-3:#8f9093;
  --red:#ff3b3b;--green:#3bd77a;
  --pad-top:env(safe-area-inset-top,0px);
  --pad-bottom:env(safe-area-inset-bottom,0px);
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
html,body{margin:0;padding:0;min-height:100%;background:var(--bg);}
body{color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Inter",system-ui,sans-serif;font-size:14px;user-select:none;-webkit-user-select:none;overflow-x:hidden;}
button{font-family:inherit;color:inherit;background:none;border:none;cursor:pointer;padding:0;outline:none;font-size:inherit;}
.icon{display:inline-block;width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;vertical-align:middle;}
.icon-fill{fill:currentColor;stroke:none;}

.app{display:flex;flex-direction:column;min-height:100vh;min-height:100dvh;padding-top:var(--pad-top);padding-bottom:var(--pad-bottom);}

/* HEADER */
.header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;border-bottom:1px solid #16171a;background:linear-gradient(180deg,#0d0e10,#050506);flex-shrink:0;}
.header-side{display:flex;align-items:center;gap:10px;flex:1;min-width:0;}
.header-side.right{justify-content:flex-end;}
.music-btn{flex:0 0 auto;width:52px;height:52px;border-radius:14px;background:linear-gradient(180deg,#222327,#131417);border:1px solid #3a3c41;color:#e8e8ea;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 4px rgba(0,0,0,.6);transition:transform .12s;}
.music-btn:active{transform:scale(.94);}
.music-btn .icon{width:22px;height:22px;}
.load-hint{color:var(--text-3);font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.header-center{display:flex;flex-direction:column;align-items:center;gap:8px;flex:0 0 auto;}
.menu-pill{padding:10px 26px;border-radius:999px;background:linear-gradient(180deg,#232428,#111214);border:1px solid #3a3c41;color:#fff;font-weight:600;letter-spacing:.14em;font-size:12px;transition:transform .12s;}
.menu-pill:active{transform:scale(.96);}
.mode-switch{display:inline-flex;background:#0e0f11;border:1px solid #2a2c30;border-radius:999px;padding:3px;gap:2px;}
.mode-switch button{width:38px;height:30px;border-radius:999px;color:#9a9b9e;display:flex;align-items:center;justify-content:center;}
.mode-switch button .icon{width:15px;height:15px;}
.mode-switch button.active{background:#e9e9ec;color:#111;}

/* TABS */
.tabs{display:none;gap:6px;padding:8px 10px 0;flex-shrink:0;}
.tabs button{flex:1;padding:12px 8px;border-radius:8px 8px 0 0;background:#141518;border:1px solid #222327;border-bottom:none;color:#8b8c8f;font-weight:700;letter-spacing:.14em;font-size:11px;}
.tabs button.active{background:#222327;color:#fff;}

/* MAIN */
.main{flex:1;display:grid;grid-template-columns:66px minmax(0,1fr) minmax(240px,320px) minmax(0,1fr) 66px;gap:10px;padding:10px;min-height:0;}
.side{display:flex;flex-direction:column;gap:8px;min-height:0;}
.side-btn{flex:1;min-height:56px;border-radius:10px;background:linear-gradient(180deg,#1c1d21,#111214);border:1px solid #2c2e32;color:#d0d1d3;font-size:11px;font-weight:600;letter-spacing:.1em;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:6px;transition:transform .12s,background .15s;}
.side-btn:active{transform:scale(.96);}
.side-btn.active{background:linear-gradient(180deg,#2e2f34,#1a1b1e);border-color:#4a4c50;color:#fff;}
.side-btn .dot{width:6px;height:6px;border-radius:50%;background:#3a3c40;}
.side-btn.active .dot{background:#e9e9ec;box-shadow:0 0 6px #ffffff88;}

.deck{display:flex;flex-direction:column;gap:8px;min-height:0;overflow:hidden;position:relative;}
.deck-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding:0 4px;flex-shrink:0;}
.deck-label{font-size:10px;font-weight:700;letter-spacing:.16em;color:#7d7e81;}
.deck-label .letter{color:#fff;font-size:11px;}
.deck-info{text-align:right;flex:1;min-width:0;}
.deck-title{font-size:13px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.deck-artist{font-size:10.5px;color:#7d7e81;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;}
.stats{display:flex;gap:6px;padding:0 4px;flex-shrink:0;}
.stat{flex:1;background:#0e0f11;border:1px solid #232428;border-radius:8px;padding:5px 6px;text-align:center;min-width:0;}
.stat .k{font-size:8.5px;color:#707175;letter-spacing:.12em;font-weight:600;}
.stat .v{font-size:14px;font-weight:600;color:#fff;font-variant-numeric:tabular-nums;}
.stat .v.small{font-size:11.5px;}
.waveform{position:relative;height:52px;border-radius:8px;background:#08090a;border:1px solid #1e1f22;overflow:hidden;flex-shrink:0;cursor:crosshair;}
.waveform canvas{display:block;width:100%;height:100%;}
.stage{position:relative;display:flex;align-items:center;justify-content:center;flex:1;min-height:0;padding:6px 52px 6px 8px;}
.platter-wrap{position:relative;width:100%;max-width:520px;aspect-ratio:1/1;max-height:100%;}
.platter-shadow{position:absolute;inset:-4%;border-radius:50%;background:radial-gradient(circle at 50% 60%,rgba(0,0,0,.9),transparent 65%);filter:blur(14px);z-index:0;pointer-events:none;}
.platter{position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle at 50% 50%,#0a0a0c 0%,#0a0a0c 63%,#131316 63%,#0c0c0e 100%);box-shadow:0 0 0 3px #050506,0 0 0 5px #232428,0 0 0 6px #0a0b0c,0 22px 40px rgba(0,0,0,.8),inset 0 0 60px rgba(0,0,0,.9);overflow:hidden;z-index:1;}
.platter-rotor{position:absolute;inset:6%;border-radius:50%;will-change:transform;}
.vinyl{position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle at 34% 30%,rgba(255,255,255,.045),transparent 38%),repeating-radial-gradient(circle at 50% 50%,rgba(255,255,255,.014) 0px,rgba(255,255,255,.014) 1px,transparent 1px,transparent 3px),radial-gradient(circle at 50% 50%,#161618 0%,#0d0d0f 42%,#0a0a0c 60%,#131315 78%,#070708 100%);box-shadow:inset 0 0 100px rgba(0,0,0,.85);}
.center-label{position:absolute;inset:36%;border-radius:50%;background:radial-gradient(circle at 40% 35%,#2c2d31,#131418 70%);border:1px solid #2a2c30;display:flex;align-items:center;justify-content:center;color:#c9cacd;font-weight:700;letter-spacing:.14em;font-size:clamp(9px,1.8vw,12px);text-align:center;box-shadow:inset 0 0 20px rgba(0,0,0,.7);}
.center-label .ring{position:absolute;inset:6%;border-radius:50%;border:1px dashed #3a3c40;opacity:.4;}
.spindle{position:absolute;width:clamp(6px,1.4vw,10px);height:clamp(6px,1.4vw,10px);border-radius:50%;background:radial-gradient(circle at 30% 30%,#d6d7da,#4a4c50 70%);left:50%;top:50%;transform:translate(-50%,-50%);box-shadow:0 0 0 2px #1a1b1e;z-index:5;}
.tonearm{position:absolute;right:-2%;top:2%;width:70%;height:70%;pointer-events:none;z-index:6;transform-origin:85% 18%;transition:transform .6s cubic-bezier(.4,.2,.2,1);}
.tonearm.playing{transform:rotate(-24deg);}
.tonearm .base{position:absolute;right:6%;top:2%;width:clamp(28px,5.5vw,38px);height:clamp(28px,5.5vw,38px);border-radius:50%;background:radial-gradient(circle at 35% 30%,#4a4c50,#16171a 70%);box-shadow:inset 0 1px 2px rgba(255,255,255,.15),0 3px 6px rgba(0,0,0,.8);border:1px solid #33353a;}
.tonearm .arm{position:absolute;right:12%;top:9%;width:3px;height:78%;border-radius:2px;background:linear-gradient(90deg,#5a5c61,#c2c3c6 40%,#2a2c30);transform-origin:top center;transform:rotate(24deg);}
.tonearm .headshell{position:absolute;width:14px;height:22px;bottom:-4px;left:50%;transform:translateX(-50%);background:linear-gradient(180deg,#3a3c40,#141518);border:1px solid #4a4c50;border-radius:3px;}
.tonearm .stylus{position:absolute;bottom:-6px;left:50%;transform:translateX(-50%);width:2px;height:8px;background:var(--red);border-radius:1px;box-shadow:0 0 4px rgba(255,60,60,.8);}
.pitch-wrap{position:absolute;right:0;top:50%;transform:translateY(-50%);width:38px;height:64%;display:flex;flex-direction:column;align-items:center;gap:6px;}
.pitch-label{font-size:8.5px;letter-spacing:.15em;color:#7d7e81;font-weight:600;}
.pitch-value{font-size:10px;font-weight:600;color:#fff;font-variant-numeric:tabular-nums;}
.pitch-slider{position:relative;flex:1;width:6px;background:#0a0b0c;border-radius:4px;border:1px solid #232428;box-shadow:inset 0 0 6px rgba(0,0,0,.9);}
.pitch-thumb{position:absolute;left:50%;transform:translate(-50%,-50%);width:20px;height:14px;border-radius:4px;background:linear-gradient(180deg,#3a3c40,#1a1b1e);border:1px solid #4a4c50;cursor:grab;touch-action:none;}
.pitch-btn{width:24px;height:22px;border-radius:4px;background:#1a1b1e;border:1px solid #2c2e32;color:#c9cacd;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;}
.pitch-btn:active{transform:scale(.94);}

/* PAD overlay */
.pad-overlay{position:absolute;inset:0;background:rgba(0,0,0,.85);backdrop-filter:blur(4px);display:none;grid-template-columns:repeat(4,1fr);grid-template-rows:repeat(4,1fr);gap:8px;padding:14px;z-index:20;}
.deck.pad-mode .pad-overlay{display:grid;}
.pad{background:linear-gradient(180deg,#1e1f23,#0f1013);border:1px solid #33353a;border-radius:10px;color:#cfcfcf;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;transition:transform .08s,background .15s;position:relative;}
.pad:active{transform:scale(.94);}
.pad.active{background:#e9e9ec;color:#111;border-color:#e9e9ec;}
.pad.has-cue::after{content:'';position:absolute;top:6px;right:6px;width:6px;height:6px;border-radius:50%;background:#ff3b3b;}

/* MIXER */
.mixer{display:flex;flex-direction:column;gap:8px;min-height:0;background:linear-gradient(180deg,#131418,#0b0c0e);border:1px solid #222327;border-radius:14px;padding:10px 8px;}
.mixer-top{display:flex;justify-content:center;padding-bottom:6px;border-bottom:1px solid #1c1d20;}
.cross-label{font-size:9px;color:#7d7e81;font-weight:600;letter-spacing:.14em;}
.mixer-channels{display:grid;grid-template-columns:1fr 1fr;gap:8px;flex:1;min-height:0;}
.channel{display:flex;flex-direction:column;align-items:center;gap:6px;min-height:0;}
.channel-label{font-size:9px;font-weight:700;letter-spacing:.15em;color:#8b8c8f;}
.channel-label.on{color:#fff;}
.eq-strip{display:flex;flex-direction:column;gap:8px;align-items:center;padding:4px 0;}
.knob{width:32px;height:32px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#4a4c51,#202125 65%,#0d0e10 100%);border:1px solid #3a3c40;position:relative;box-shadow:0 1px 2px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.08);touch-action:none;cursor:grab;}
.knob::after{content:"";position:absolute;left:50%;top:3px;width:2px;height:10px;margin-left:-1px;background:#e9e9ec;border-radius:1px;}
.knob.sm{width:26px;height:26px;}
.knob.sm::after{height:8px;}
.knob-row{display:flex;flex-direction:column;align-items:center;gap:4px;}
.knob-row .k{font-size:8px;letter-spacing:.14em;color:#7d7e81;font-weight:600;}
.knob-row .v{font-size:9.5px;color:#c9cacd;font-weight:600;font-variant-numeric:tabular-nums;}
.fader-wrap{position:relative;width:30px;flex:1;min-height:60px;display:flex;justify-content:center;padding:8px 0;}
.fader-track{position:relative;width:5px;height:100%;background:#050607;border-radius:3px;border:1px solid #1e1f22;box-shadow:inset 0 0 5px rgba(0,0,0,.9);}
.fader-thumb{position:absolute;left:50%;transform:translate(-50%,-50%);width:26px;height:16px;border-radius:3px;background:linear-gradient(180deg,#3e4045 0%,#212227 45%,#0f1013 46%,#313338 100%);border:1px solid #4a4c50;cursor:grab;touch-action:none;}
.hp-btn{width:32px;height:26px;border-radius:5px;background:#1a1b1e;border:1px solid #2c2e32;color:#8f9093;display:flex;align-items:center;justify-content:center;}
.hp-btn .icon{width:14px;height:14px;}
.hp-btn.active{background:#e9e9ec;color:#111;border-color:#e9e9ec;}
.cross-wrap{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px;padding:8px 4px 0;border-top:1px solid #1c1d20;}
.cross-track{position:relative;height:8px;background:#050607;border-radius:4px;border:1px solid #1e1f22;}
.cross-thumb{position:absolute;top:50%;transform:translate(-50%,-50%);width:34px;height:22px;border-radius:3px;background:linear-gradient(180deg,#3e4045 0%,#212227 45%,#0f1013 46%,#313338 100%);border:1px solid #4a4c50;cursor:grab;touch-action:none;}

/* TRANSPORT */
.transport{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px;padding:10px 14px 14px;border-top:1px solid #141518;background:linear-gradient(180deg,#0a0b0c,#030304);flex-shrink:0;}
.transport-group{display:flex;gap:8px;align-items:center;}
.transport-group.right{justify-content:flex-end;}
.btn-round{width:52px;height:52px;border-radius:50%;background:linear-gradient(180deg,#232428,#0f1012);border:1px solid #33353a;color:#e9e9ec;display:flex;align-items:center;justify-content:center;transition:transform .1s;}
.btn-round:active{transform:scale(.93);}
.btn-round .icon{width:20px;height:20px;}
.btn-round.playing{background:linear-gradient(180deg,#3a3c41,#1c1d20);box-shadow:0 0 0 1px #55585e,0 0 18px rgba(255,255,255,.08);}
.btn-pill{padding:0 16px;height:44px;min-width:64px;border-radius:10px;background:linear-gradient(180deg,#232428,#0f1012);border:1px solid #33353a;color:#c9cacd;font-size:11px;font-weight:700;letter-spacing:.14em;transition:transform .1s,background .15s;}
.btn-pill:active{transform:scale(.96);}
.btn-pill.active{background:#e9e9ec;color:#111;border-color:#e9e9ec;}

/* MODAL */
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.78);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:none;align-items:center;justify-content:center;z-index:100;padding:20px;}
.modal-bg.open{display:flex;}
.modal{width:100%;max-width:520px;max-height:85vh;background:linear-gradient(180deg,#17181b,#0c0d0f);border:1px solid #2c2e32;border-radius:16px;padding:18px;box-shadow:0 20px 60px rgba(0,0,0,.9);overflow-y:auto;display:flex;flex-direction:column;}
.modal h2{margin:0 0 12px;font-size:13px;font-weight:700;letter-spacing:.2em;color:#fff;display:flex;justify-content:space-between;align-items:center;}
.modal .close{width:32px;height:32px;border-radius:8px;background:#1a1b1e;border:1px solid #2c2e32;color:#c9cacd;display:flex;align-items:center;justify-content:center;}
.modal .close .icon{width:14px;height:14px;}
.field{display:flex;flex-direction:column;gap:6px;margin-bottom:12px;}
.field label{font-size:10px;color:#8b8c8f;letter-spacing:.14em;font-weight:600;}
.field input,.field select{background:#0a0b0c;border:1px solid #2a2c30;border-radius:8px;color:#fff;padding:12px;font-size:14px;font-family:inherit;outline:none;width:100%;}
.field input:focus{border-color:#4a4c50;}
.modal-actions{display:flex;gap:8px;margin-top:6px;}
.btn{flex:1;padding:13px 16px;border-radius:9px;background:#1a1b1e;border:1px solid #2c2e32;color:#e9e9ec;font-weight:600;letter-spacing:.1em;font-size:11px;transition:transform .1s;}
.btn:active{transform:scale(.97);}
.btn.primary{background:#e9e9ec;color:#111;border-color:#e9e9ec;}
.btn.danger{background:#3a1a1a;color:#ff9d9d;border-color:#5a2a2a;}
.btn[disabled]{opacity:.5;pointer-events:none;}

/* Lib tabs */
.lib-tabs{display:flex;gap:4px;background:#0a0b0c;border:1px solid #222327;border-radius:10px;padding:4px;margin-bottom:10px;}
.lib-tabs button{flex:1;padding:9px 6px;border-radius:7px;color:#8b8c8f;font-weight:700;letter-spacing:.1em;font-size:10.5px;transition:background .15s,color .15s;}
.lib-tabs button.active{background:#2a2c31;color:#fff;}

.library-list{overflow-y:auto;min-height:0;margin-top:6px;display:flex;flex-direction:column;gap:6px;max-height:50vh;}
.track{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;padding:10px;background:#141518;border:1px solid #222327;border-radius:8px;}
.track .ti{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.track .tm{font-size:10px;color:#7d7e81;margin-top:3px;display:flex;gap:8px;flex-wrap:wrap;}
.track .tm span{white-space:nowrap;}
.track .actions{display:flex;gap:4px;flex-shrink:0;}
.track .actions button{padding:8px 9px;font-size:10.5px;font-weight:700;border-radius:6px;background:#232428;border:1px solid #33353a;color:#dcdce0;min-width:30px;}
.track .actions button.danger{color:#ff8080;border-color:#3a2020;}
.empty{padding:24px;text-align:center;color:#7d7e81;font-size:12px;}

/* Menu items */
.menu-list{display:flex;flex-direction:column;gap:6px;}
.menu-item{display:flex;align-items:center;gap:10px;padding:14px 12px;border-radius:9px;background:#141518;border:1px solid #222327;color:#dcdce0;font-weight:500;font-size:13px;text-align:left;width:100%;}
.menu-item:active{background:#1e1f23;}
.menu-item.danger{color:#ff8080;}
.menu-item .badge{margin-left:auto;font-size:10px;color:#7d7e81;}

/* PROGRESS */
.progress-modal{text-align:center;padding:12px 0;}
.progress-modal .spinner{width:44px;height:44px;margin:0 auto 14px;border:3px solid #222327;border-top-color:#e9e9ec;border-radius:50%;animation:spin .9s linear infinite;}
@keyframes spin{to{transform:rotate(360deg);}}
.progress-modal .status{font-size:13px;color:#cfcfcf;margin-bottom:14px;}
.progress-modal .status-err{color:#ff9d9d;font-size:11.5px;margin-top:8px;line-height:1.5;word-break:break-word;}
.progress-bar-wrap{width:100%;height:8px;background:#0a0b0c;border:1px solid #222327;border-radius:5px;overflow:hidden;margin-bottom:8px;}
.progress-bar-fill{height:100%;background:linear-gradient(90deg,#4a4c50,#e9e9ec);border-radius:4px;transition:width .3s ease;width:0%;}
.progress-pct{font-size:22px;font-weight:700;color:#fff;font-variant-numeric:tabular-nums;margin-bottom:4px;}
.progress-phase{font-size:10px;color:#7d7e81;letter-spacing:.16em;text-transform:uppercase;margin-bottom:14px;}

/* TOAST */
#toast-wrap{position:fixed;top:calc(env(safe-area-inset-top,0px) + 12px);left:50%;transform:translateX(-50%);z-index:300;display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none;max-width:92vw;}
.toast{background:linear-gradient(180deg,#1e1f23,#0e0f11);border:1px solid #33353a;color:#fff;font-size:12px;padding:10px 18px;border-radius:999px;box-shadow:0 6px 20px rgba(0,0,0,.8);animation:toastIn .3s;white-space:nowrap;max-width:92vw;overflow:hidden;text-overflow:ellipsis;}
.toast.err{border-color:#553030;color:#ff9d9d;}
.toast.ok{border-color:#335a42;}
@keyframes toastIn{from{opacity:0;transform:translateY(-10px);}to{opacity:1;transform:translateY(0);}}

/* FX PANEL */
.fx-panel{position:fixed;z-index:60;background:linear-gradient(180deg,#1a1b1e,#0e0f11);border:1px solid #2c2e32;border-radius:12px;padding:12px;min-width:240px;box-shadow:0 12px 40px rgba(0,0,0,.9);display:none;}
.fx-panel.open{display:block;}
.fx-panel .hd{font-size:10px;letter-spacing:.18em;color:#8b8c8f;font-weight:700;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;}
.fx-panel .hd .close{width:24px;height:24px;border-radius:6px;background:#1a1b1e;border:1px solid #2c2e32;color:#c9cacd;display:flex;align-items:center;justify-content:center;}
.fx-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
.fx-item{display:flex;flex-direction:column;gap:6px;align-items:center;background:#141518;border:1px solid #222327;border-radius:8px;padding:8px;}
.fx-item .n{font-size:9px;letter-spacing:.14em;color:#8b8c8f;font-weight:600;}
.fx-item .on{font-size:9px;padding:4px 10px;border-radius:6px;background:#1a1b1e;border:1px solid #2c2e32;color:#8b8c8f;}
.fx-item.on .on{background:#e9e9ec;color:#111;border-color:#e9e9ec;}
.loop-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px;}
.loop-btn{padding:10px 4px;border-radius:6px;background:#141518;border:1px solid #222327;color:#c9cacd;font-size:10.5px;font-weight:700;}
.loop-btn.active{background:#e9e9ec;color:#111;}
.cue-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:8px;}
.cue-btn{padding:12px 4px;border-radius:6px;background:#141518;border:1px solid #222327;color:#c9cacd;font-size:10.5px;font-weight:700;}
.cue-btn.set{border-color:#e9e9ec;color:#fff;background:#2a2c31;}
.eq-panel-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:12px;}
.eq-panel-row .k{font-size:10px;color:#8b8c8f;letter-spacing:.14em;font-weight:600;}

/* RESPONSIVE — TABLET */
@media (max-width:1100px){
  .main{grid-template-columns:56px minmax(0,1fr) minmax(220px,280px) minmax(0,1fr) 56px;gap:8px;padding:8px;}
  .stage{padding:4px 44px 4px 4px;}
}
@media (max-width:900px) and (min-width:781px){
  .main{grid-template-columns:52px minmax(0,1fr) minmax(200px,260px) minmax(0,1fr) 52px;}
  .music-btn{width:46px;height:46px;}
  .menu-pill{padding:9px 20px;font-size:11px;}
  .load-hint{font-size:11px;}
}

/* MOBILE PORTRAIT */
@media (max-width:900px) and (orientation:portrait){
  .music-btn{width:44px;height:44px;border-radius:12px;}
  .music-btn .icon{width:18px;height:18px;}
  .menu-pill{padding:8px 20px;font-size:11px;}
  .load-hint{font-size:10.5px;}
  .tabs{display:flex;}
  .main{display:block;padding:0 10px 10px;overflow-y:auto;}
  .main > *{margin-top:8px;}
  .main > *:first-child{margin-top:0;}
  .side{display:none!important;}
  .side.show{display:grid!important;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:10px;}
  .side-btn{min-height:60px;padding:10px 4px;font-size:11px;}
  .deck{display:none!important;}
  .deck.show{display:flex!important;flex-direction:column;gap:6px;}
  .stage{padding:8px 46px 8px 6px;flex:0 0 auto;}
  .platter-wrap{max-width:min(80vw,420px);margin:0 auto;width:100%;}
  .pitch-wrap{width:34px;}
  .mixer{margin-top:10px!important;padding:10px;}
  .eq-strip{flex-direction:row;gap:12px;justify-content:center;padding:2px 0;}
  .knob{width:36px;height:36px;}
  .knob.sm{width:30px;height:30px;}
  .fader-wrap{width:34px;height:80px;min-height:0;padding:6px 0;margin:2px 0;}
  .fader-thumb{width:28px;height:18px;}
  .cross-thumb{width:40px;height:26px;}
  .transport{padding:10px 10px 12px;gap:6px;}
  .btn-round{width:52px;height:52px;}
  .btn-pill{height:46px;min-width:56px;padding:0 12px;font-size:10.5px;}
  .fx-panel{left:10px!important;right:10px!important;top:auto!important;bottom:calc(env(safe-area-inset-bottom,0px) + 10px)!important;width:auto!important;min-width:0!important;max-width:none!important;}
}

/* LANDSCAPE PHONE — compact but usable */
@media (orientation:landscape) and (max-height:600px){
  body{font-size:12px;}
  .header{padding:6px 12px;gap:6px;min-height:auto;}
  .music-btn{width:40px;height:40px;border-radius:11px;}
  .music-btn .icon{width:18px;height:18px;}
  .load-hint{font-size:10px;}
  .menu-pill{padding:6px 18px;font-size:10px;}
  .mode-switch{display:none;}
  .header-center{gap:0;}
  .tabs{display:none!important;}

  .main{
    display:grid!important;
    grid-template-columns:48px minmax(0,1fr) minmax(200px,240px) minmax(0,1fr) 48px;
    gap:6px;
    padding:6px;
    overflow:hidden;
  }

  .side{display:flex!important;flex-direction:column;gap:5px;}
  .side-btn{font-size:9px;min-height:38px;padding:3px;border-radius:8px;}
  .side-btn .dot{width:5px;height:5px;}

  .deck{display:flex!important;flex-direction:column;gap:5px;}

  /* Sembunyikan track info supaya hemat ruang */
  .deck-top{display:none;}
  .stats{padding:0 2px;gap:3px;}
  .stat{padding:3px 4px;border-radius:6px;}
  .stat .k{font-size:7px;letter-spacing:.08em;}
  .stat .v{font-size:11px;}
  .stat .v.small{font-size:9.5px;}

  .waveform{height:30px;border-radius:6px;}

  .stage{padding:2px 38px 2px 2px;}
  .pitch-wrap{width:30px;gap:3px;}
  .pitch-label{font-size:7px;}
  .pitch-value{font-size:9px;}
  .pitch-slider{width:5px;}
  .pitch-thumb{width:18px;height:12px;}
  .pitch-btn{width:20px;height:18px;font-size:10px;}

  .mixer{padding:6px 5px;border-radius:10px;gap:5px;}
  .mixer-top{padding-bottom:4px;}
  .cross-label{font-size:8px;}
  .channel-label{font-size:8px;letter-spacing:.1em;}
  .eq-strip{gap:5px;padding:2px 0;}
  .knob{width:26px;height:26px;}
  .knob.sm{width:22px;height:22px;}
  .knob.sm::after{height:7px;}
  .knob-row .k{font-size:7px;}
  .knob-row .v{font-size:8.5px;}
  .fader-wrap{width:26px;min-height:44px;padding:4px 0;margin:1px 0;}
  .fader-track{width:4.5px;}
  .fader-thumb{width:22px;height:13px;}
  .hp-btn{width:26px;height:20px;}
  .hp-btn .icon{width:12px;height:12px;}
  .cross-track{height:7px;}
  .cross-thumb{width:32px;height:20px;}

  .transport{padding:5px 10px 8px;gap:6px;border-radius:0;}
  .transport-group{gap:6px;}
  .btn-round{width:44px;height:44px;}
  .btn-round .icon{width:17px;height:17px;}
  .btn-pill{height:38px;min-width:48px;padding:0 11px;font-size:10px;letter-spacing:.1em;border-radius:8px;}

  .pad-overlay{gap:5px;padding:8px;}
  .pad{font-size:10px;border-radius:8px;}

  .fx-panel{left:10px!important;right:10px!important;top:auto!important;bottom:10px!important;width:auto!important;min-width:0!important;}
}

/* HP sangat kecil */
@media (max-width:380px) and (orientation:portrait){
  .btn-round{width:44px;height:44px;}
  .btn-pill{height:40px;min-width:48px;padding:0 10px;font-size:9.5px;}
  .platter-wrap{max-width:88vw;}
  .stage{padding:6px 42px 6px 4px;}
  .pitch-wrap{width:30px;}
}
</style>
</head>
<body>

<div class="app">
  <header class="header">
    <div class="header-side">
      <button class="music-btn" data-act="open-lib" aria-label="My music">
        <svg class="icon" viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
      </button>
      <div class="load-hint">Ketuk untuk memuat</div>
    </div>
    <div class="header-center">
      <button class="menu-pill" data-act="menu">MENU</button>
      <div class="mode-switch">
        <button data-mode="master" class="active" title="Master"><svg class="icon" viewBox="0 0 24 24"><path d="M3 10v4h4l5 5V5L7 10H3z"/></svg></button>
        <button data-mode="wave" title="Waveform"><svg class="icon" viewBox="0 0 24 24"><path d="M3 12h3v6H3zM8 6h3v12H8zM13 9h3v9h-3zM18 3h3v15h-3z"/></svg></button>
        <button data-mode="pad" title="Pad"><svg class="icon" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></button>
      </div>
    </div>
    <div class="header-side right">
      <div class="load-hint">Ketuk untuk memuat</div>
      <button class="music-btn" data-act="open-lib" aria-label="My music">
        <svg class="icon" viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
      </button>
    </div>
  </header>

  <div class="tabs">
    <button data-tab="A" class="active">DECK A</button>
    <button data-tab="B">DECK B</button>
    <button data-tab="M">MIXER</button>
  </div>

  <main class="main">
    <aside class="side" data-deck="A" id="sideA">
      <button class="side-btn" data-act="panel" data-deck="A" data-panel="fx"><span class="dot"></span><span>FX</span></button>
      <button class="side-btn" data-act="panel" data-deck="A" data-panel="loop"><span class="dot"></span><span>LOOP</span></button>
      <button class="side-btn" data-act="panel" data-deck="A" data-panel="eq"><span class="dot"></span><span>EQ</span></button>
      <button class="side-btn" data-act="panel" data-deck="A" data-panel="cue"><span class="dot"></span><span>HOT CUES</span></button>
    </aside>

    <section class="deck" data-deck="A" id="deckA">
      <div class="deck-top">
        <div class="deck-label">DECK <span class="letter">A</span></div>
        <div class="deck-info">
          <div class="deck-title" id="titleA">No Track Loaded</div>
          <div class="deck-artist" id="artistA">Tap 🎵 untuk pilih musik</div>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><div class="k">BPM</div><div class="v" id="bpmA">--</div></div>
        <div class="stat"><div class="k">KEY</div><div class="v small" id="keyA">8A</div></div>
        <div class="stat"><div class="k">TIME</div><div class="v small" id="timeA">00:00</div></div>
        <div class="stat"><div class="k">DUR</div><div class="v small" id="durA">00:00</div></div>
      </div>
      <div class="waveform" id="waveWrapA"><canvas id="waveA"></canvas></div>
      <div class="stage">
        <div class="platter-wrap">
          <div class="platter-shadow"></div>
          <div class="platter">
            <div class="platter-rotor" id="rotorA">
              <div class="vinyl"></div>
              <div class="center-label"><div class="ring"></div><span>DECK A</span></div>
            </div>
            <div class="spindle"></div>
          </div>
          <div class="tonearm" id="armA"><div class="base"></div><div class="arm"><div class="headshell"><div class="stylus"></div></div></div></div>
          <div class="pitch-wrap">
            <div class="pitch-label">PITCH</div>
            <div class="pitch-value" id="pitchValA">+0.0%</div>
            <button class="pitch-btn" data-act="pitch" data-deck="A" data-dir="up">+</button>
            <div class="pitch-slider" id="pitchSliderA"><div class="pitch-thumb" id="pitchThumbA" style="top:50%"></div></div>
            <button class="pitch-btn" data-act="pitch" data-deck="A" data-dir="down">−</button>
          </div>
        </div>
      </div>
      <div class="pad-overlay" id="padOverlayA"></div>
    </section>

    <section class="mixer" id="mixer">
      <div class="mixer-top"><div class="cross-label">MIXER</div></div>
      <div class="mixer-channels">
        <div class="channel" data-deck="A">
          <div class="channel-label on">CH A</div>
          <div class="knob-row"><div class="k">GAIN</div><div class="knob sm" data-knob="gain-A"></div><div class="v" id="gainValA">0dB</div></div>
          <div class="eq-strip">
            <div class="knob-row"><div class="k">HIGH</div><div class="knob sm" data-knob="high-A"></div></div>
            <div class="knob-row"><div class="k">MID</div><div class="knob sm" data-knob="mid-A"></div></div>
            <div class="knob-row"><div class="k">LOW</div><div class="knob sm" data-knob="low-A"></div></div>
          </div>
          <div class="fader-wrap"><div class="fader-track"><div class="fader-thumb" id="faderA" style="top:20%"></div></div></div>
          <button class="hp-btn" data-act="hp" data-deck="A" aria-label="Headphone A"><svg class="icon" viewBox="0 0 24 24"><path d="M3 18v-6a9 9 0 0118 0v6"/><path d="M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zM3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3z"/></svg></button>
        </div>
        <div class="channel" data-deck="B">
          <div class="channel-label">CH B</div>
          <div class="knob-row"><div class="k">GAIN</div><div class="knob sm" data-knob="gain-B"></div><div class="v" id="gainValB">0dB</div></div>
          <div class="eq-strip">
            <div class="knob-row"><div class="k">HIGH</div><div class="knob sm" data-knob="high-B"></div></div>
            <div class="knob-row"><div class="k">MID</div><div class="knob sm" data-knob="mid-B"></div></div>
            <div class="knob-row"><div class="k">LOW</div><div class="knob sm" data-knob="low-B"></div></div>
          </div>
          <div class="fader-wrap"><div class="fader-track"><div class="fader-thumb" id="faderB" style="top:20%"></div></div></div>
          <button class="hp-btn" data-act="hp" data-deck="B" aria-label="Headphone B"><svg class="icon" viewBox="0 0 24 24"><path d="M3 18v-6a9 9 0 0118 0v6"/><path d="M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zM3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3z"/></svg></button>
        </div>
      </div>
      <div class="cross-wrap">
        <div class="cross-label">A</div>
        <div class="cross-track" id="crossTrack"><div class="cross-thumb" id="crossThumb" style="left:50%"></div></div>
        <div class="cross-label">B</div>
      </div>
    </section>

    <section class="deck" data-deck="B" id="deckB">
      <div class="deck-top">
        <div class="deck-label">DECK <span class="letter">B</span></div>
        <div class="deck-info">
          <div class="deck-title" id="titleB">No Track Loaded</div>
          <div class="deck-artist" id="artistB">Tap 🎵 untuk pilih musik</div>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><div class="k">BPM</div><div class="v" id="bpmB">--</div></div>
        <div class="stat"><div class="k">KEY</div><div class="v small" id="keyB">8A</div></div>
        <div class="stat"><div class="k">TIME</div><div class="v small" id="timeB">00:00</div></div>
        <div class="stat"><div class="k">DUR</div><div class="v small" id="durB">00:00</div></div>
      </div>
      <div class="waveform" id="waveWrapB"><canvas id="waveB"></canvas></div>
      <div class="stage">
        <div class="platter-wrap">
          <div class="platter-shadow"></div>
          <div class="platter">
            <div class="platter-rotor" id="rotorB">
              <div class="vinyl"></div>
              <div class="center-label"><div class="ring"></div><span>DECK B</span></div>
            </div>
            <div class="spindle"></div>
          </div>
          <div class="tonearm" id="armB"><div class="base"></div><div class="arm"><div class="headshell"><div class="stylus"></div></div></div></div>
          <div class="pitch-wrap">
            <div class="pitch-label">PITCH</div>
            <div class="pitch-value" id="pitchValB">+0.0%</div>
            <button class="pitch-btn" data-act="pitch" data-deck="B" data-dir="up">+</button>
            <div class="pitch-slider" id="pitchSliderB"><div class="pitch-thumb" id="pitchThumbB" style="top:50%"></div></div>
            <button class="pitch-btn" data-act="pitch" data-deck="B" data-dir="down">−</button>
          </div>
        </div>
      </div>
      <div class="pad-overlay" id="padOverlayB"></div>
    </section>

    <aside class="side" data-deck="B" id="sideB">
      <button class="side-btn" data-act="panel" data-deck="B" data-panel="fx"><span class="dot"></span><span>FX</span></button>
      <button class="side-btn" data-act="panel" data-deck="B" data-panel="loop"><span class="dot"></span><span>LOOP</span></button>
      <button class="side-btn" data-act="panel" data-deck="B" data-panel="eq"><span class="dot"></span><span>EQ</span></button>
      <button class="side-btn" data-act="panel" data-deck="B" data-panel="cue"><span class="dot"></span><span>HOT CUES</span></button>
    </aside>
  </main>

  <footer class="transport">
    <div class="transport-group">
      <button class="btn-round" data-act="play" data-deck="A" id="playA"><svg class="icon icon-fill" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button>
      <button class="btn-pill" data-act="cue" data-deck="A" id="cueA">CUE</button>
      <button class="btn-pill" data-act="sync" data-deck="A" id="syncA">SYNC</button>
    </div>
    <div></div>
    <div class="transport-group right">
      <button class="btn-pill" data-act="sync" data-deck="B" id="syncB">SYNC</button>
      <button class="btn-pill" data-act="cue" data-deck="B" id="cueB">CUE</button>
      <button class="btn-round" data-act="play" data-deck="B" id="playB"><svg class="icon icon-fill" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button>
    </div>
  </footer>
</div>

<div class="fx-panel" id="fxPanel">
  <div class="hd"><span id="fxPanelTitle">FX</span>
    <button class="close" data-act="close-panel"><svg class="icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
  </div>
  <div id="fxPanelBody"></div>
</div>

<div class="modal-bg" id="modalBg"></div>
<div id="toast-wrap"></div>

<script>
/* =========================================================
   UTIL
   ========================================================= */
var $ = function(s,r){ return (r||document).querySelector(s); };
var $$ = function(s,r){ return Array.prototype.slice.call((r||document).querySelectorAll(s)); };
function clamp(v,a,b){ return v<a?a:(v>b?b:v); }
function fmtTime(s){ if(!isFinite(s)||s<0)s=0; var m=Math.floor(s/60),ss=Math.floor(s%60); return (m<10?'0':'')+m+':'+(ss<10?'0':'')+ss; }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function fmtSize(b){ if(b<1024)return b+'B'; if(b<1048576)return (b/1024).toFixed(1)+'KB'; return (b/1048576).toFixed(1)+'MB'; }
function fmtAgo(ts){ var d=Date.now()-ts; if(d<60000)return 'just now'; if(d<3600000)return Math.floor(d/60000)+'m ago'; if(d<86400000)return Math.floor(d/3600000)+'h ago'; return Math.floor(d/86400000)+'d ago'; }

function toast(msg,type){
  try{
    var w=document.getElementById('toast-wrap'); if(!w) return;
    var el=document.createElement('div');
    el.className='toast'+(type==='err'?' err':(type==='ok'?' ok':''));
    el.textContent=(type==='err'?'⚠ ':type==='ok'?'✓ ':'')+msg;
    w.appendChild(el);
    setTimeout(function(){
      el.style.transition='opacity .25s,transform .25s';
      el.style.opacity='0'; el.style.transform='translateY(-8px)';
      setTimeout(function(){ if(el.parentNode) el.parentNode.removeChild(el); },260);
    },2400);
  }catch(e){}
}

/* =========================================================
   AUDIO ENGINE
   ========================================================= */
var AudioCtx = window.AudioContext || window.webkitAudioContext;
var ctx = new AudioCtx({ latencyHint: 'interactive' });
var masterGain = ctx.createGain();
masterGain.gain.value = 0.9;
masterGain.connect(ctx.destination);
var crossGainA = ctx.createGain();
var crossGainB = ctx.createGain();
crossGainA.connect(masterGain);
crossGainB.connect(masterGain);

function makeImpulse(duration, decay){
  var rate = ctx.sampleRate;
  var length = rate * duration;
  var impulse = ctx.createBuffer(2, length, rate);
  for (var c = 0; c < 2; c++){
    var chan = impulse.getChannelData(c);
    for (var i = 0; i < length; i++) chan[i] = (Math.random()*2-1) * Math.pow(1 - i/length, decay);
  }
  return impulse;
}

function DJDeck(id, output){
  this.id = id;
  this.output = output;
  this.buffer = null;
  this.duration = 0;
  this.playing = false;
  this.source = null;
  this.startedAt = 0;
  this.startOffset = 0;
  this.currentOffset = 0;
  this.playbackRate = 1;
  this.volume = 0.8;
  this.cuePoint = 0;
  this.hotCues = [null,null,null,null,null,null,null,null];
  this.loopStart = null;
  this.loopEnd = null;
  this.loopActive = false;
  this.bpm = 0;
  this.baseBpm = 0;
  this.pitch = 0;
  this.trackId = null;
  this.title = 'No Track Loaded';
  this.artist = 'Tap 🎵 untuk pilih musik';
  this.peaks = null;
  this._seeking = false;

  this.gainNode = ctx.createGain(); this.gainNode.gain.value = this.volume;
  this.eqLow = ctx.createBiquadFilter(); this.eqLow.type='lowshelf'; this.eqLow.frequency.value=200; this.eqLow.gain.value=0;
  this.eqMid = ctx.createBiquadFilter(); this.eqMid.type='peaking'; this.eqMid.frequency.value=1000; this.eqMid.Q.value=1; this.eqMid.gain.value=0;
  this.eqHigh = ctx.createBiquadFilter(); this.eqHigh.type='highshelf'; this.eqHigh.frequency.value=4000; this.eqHigh.gain.value=0;

  this.filterNode = ctx.createBiquadFilter(); this.filterNode.type='lowpass'; this.filterNode.frequency.value=20000;
  this.delayNode = ctx.createDelay(2); this.delayNode.delayTime.value = 0.28;
  this.delayFeedback = ctx.createGain(); this.delayFeedback.gain.value = 0.35;
  this.delayWet = ctx.createGain(); this.delayWet.gain.value = 0;
  this.convolver = ctx.createConvolver(); this.convolver.buffer = makeImpulse(2.2, 2);
  this.reverbWet = ctx.createGain(); this.reverbWet.gain.value = 0;
  this.flangerDelay = ctx.createDelay(0.05); this.flangerDelay.delayTime.value = 0.005;
  this.flangerLFO = ctx.createOscillator(); this.flangerLFO.frequency.value = 0.4;
  this.flangerLFOAmp = ctx.createGain(); this.flangerLFOAmp.gain.value = 0.003;
  this.flangerLFO.connect(this.flangerLFOAmp); this.flangerLFOAmp.connect(this.flangerDelay.delayTime);
  this.flangerLFO.start();
  this.flangerWet = ctx.createGain(); this.flangerWet.gain.value = 0;

  this.gainNode.connect(this.eqLow); this.eqLow.connect(this.eqMid); this.eqMid.connect(this.eqHigh);
  this.eqHigh.connect(this.filterNode);
  this.filterNode.connect(this.output);
  this.filterNode.connect(this.delayNode);
  this.delayNode.connect(this.delayFeedback); this.delayFeedback.connect(this.delayNode);
  this.delayNode.connect(this.delayWet); this.delayWet.connect(this.output);
  this.filterNode.connect(this.convolver);
  this.convolver.connect(this.reverbWet); this.reverbWet.connect(this.output);
  this.filterNode.connect(this.flangerDelay);
  this.flangerDelay.connect(this.flangerWet); this.flangerWet.connect(this.output);
}

DJDeck.prototype.loadBuffer = function(audioBuffer, meta){
  this.stopAll();
  this.buffer = audioBuffer;
  this.duration = audioBuffer.duration;
  this.currentOffset = 0;
  this.cuePoint = 0;
  this.hotCues = [null,null,null,null,null,null,null,null];
  this.loopStart = null; this.loopEnd = null; this.loopActive = false;
  if (meta && meta.title) this.title = meta.title;
  this.artist = 'YouTube';
  this.trackId = (meta && meta.id) || null;
  if (meta && typeof meta.bpm === 'number' && meta.bpm > 0) {
    this.bpm = meta.bpm; this.baseBpm = meta.bpm;
  } else {
    this.bpm = 0; this.baseBpm = 0;
  }
  this.computePeaks();
  if (!this.bpm) this.detectBpm();
  this.updateUI();
  drawWave(this);
};

DJDeck.prototype.computePeaks = function(){
  if (!this.buffer) return;
  var data = this.buffer.getChannelData(0);
  var N = 800;
  var blockSize = Math.floor(data.length / N);
  var peaks = new Float32Array(N);
  for (var i = 0; i < N; i++){
    var s = i*blockSize, e = s+blockSize, max = 0;
    for (var j = s; j < e; j += 8){ var v = Math.abs(data[j]); if (v > max) max = v; }
    peaks[i] = max;
  }
  this.peaks = peaks;
};

DJDeck.prototype.detectBpm = function(){
  if (!this.buffer) return;
  var data = this.buffer.getChannelData(0);
  var sr = this.buffer.sampleRate;
  var maxLen = Math.min(data.length, sr * 30);
  var win = Math.max(1, Math.floor(sr / 400));
  var filtered = new Float32Array(maxLen);
  var acc = 0;
  for (var i = 0; i < maxLen; i++){
    acc += Math.abs(data[i]);
    if (i >= win) acc -= Math.abs(data[i - win]);
    filtered[i] = acc / win;
  }
  var frameSize = Math.floor(sr * 0.02);
  var frames = Math.floor(maxLen / frameSize);
  if (frames < 20) return;
  var energy = new Float32Array(frames);
  for (var f = 0; f < frames; f++){
    var s = f*frameSize, e = s+frameSize, sum = 0;
    for (var k = s; k < e; k++) sum += filtered[k];
    energy[f] = sum / frameSize;
  }
  var framesPerSec = frames / (maxLen / sr);
  var minLag = Math.max(1, Math.floor((60/180) * framesPerSec));
  var maxLag = Math.min(frames-1, Math.floor((60/70) * framesPerSec));
  var mean = 0;
  for (var m = 0; m < frames; m++) mean += energy[m];
  mean /= frames;
  var bestLag = 0, bestVal = -Infinity;
  for (var lag = minLag; lag <= maxLag; lag++){
    var sum2 = 0;
    for (var p = 0; p < frames - lag; p++) sum2 += (energy[p]-mean)*(energy[p+lag]-mean);
    if (sum2 > bestVal){ bestVal = sum2; bestLag = lag; }
  }
  if (bestLag > 0){
    var bpm = 60 / (bestLag / framesPerSec);
    while (bpm < 90) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    this.bpm = Math.round(bpm * 10) / 10;
    this.baseBpm = this.bpm;
  } else {
    this.bpm = 128; this.baseBpm = 128;
  }
  // save to server
  var self = this;
  if (this.trackId){
    fetch('/api/tracks/' + this.trackId + '/meta', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ bpm: this.bpm })
    }).catch(function(){});
  }
  this.updateUI();
};

DJDeck.prototype.play = function(){
  if (!this.buffer || this.playing) return;
  if (ctx.state === 'suspended') ctx.resume();
  var src = ctx.createBufferSource();
  src.buffer = this.buffer;
  src.playbackRate.value = this.playbackRate;
  src.connect(this.gainNode);
  var self = this;
  src.onended = function(){
    if (self.source === src && self.playing && !self._seeking){
      self.playing = false;
      self.currentOffset = 0;
      self.source = null;
      self.updateUI();
    }
  };
  var offset = this.currentOffset;
  if (offset >= this.buffer.duration) offset = 0;
  src.start(0, offset);
  this.source = src;
  this.startedAt = ctx.currentTime;
  this.startOffset = offset;
  this.playing = true;
  this._seeking = false;
  this.updateUI();
};

DJDeck.prototype.pause = function(){
  if (!this.playing) return;
  var pos = this.position;
  this._seeking = true;
  try { this.source.stop(); } catch(e){}
  this.source = null;
  this.playing = false;
  this.currentOffset = pos;
  this.updateUI();
};

DJDeck.prototype.stopAll = function(){
  if (this.source){
    this._seeking = true;
    try { this.source.stop(); } catch(e){}
    this.source = null;
  }
  this.playing = false;
};

DJDeck.prototype.toggle = function(){
  if (!this.buffer){ toast('Load track dulu','err'); return; }
  if (this.playing) this.pause(); else this.play();
};

DJDeck.prototype.seek = function(t){
  if (!this.buffer) return;
  t = clamp(t, 0, this.buffer.duration);
  var wasPlaying = this.playing;
  if (wasPlaying){
    this._seeking = true;
    try { this.source.stop(); } catch(e){}
    this.source = null;
    this.playing = false;
  }
  this.currentOffset = t;
  if (wasPlaying) this.play();
  else this.updateUI();
};

DJDeck.prototype.cue = function(){
  if (!this.buffer){ toast('Load track dulu','err'); return; }
  this.seek(this.cuePoint);
  toast('Cue Deck ' + this.id, 'ok');
};

DJDeck.prototype.setCue = function(){
  if (!this.buffer) return;
  this.cuePoint = this.position;
  toast('Cue set @ ' + fmtTime(this.cuePoint), 'ok');
};

DJDeck.prototype.setHotCue = function(idx){
  if (!this.buffer){ toast('Load track dulu','err'); return; }
  if (this.hotCues[idx] == null){
    this.hotCues[idx] = this.position;
    toast('Hot Cue ' + (idx+1) + ' set', 'ok');
  } else {
    this.seek(this.hotCues[idx]);
    toast('Hot Cue ' + (idx+1), 'ok');
  }
  refreshCueGrid(this);
  updatePadOverlay(this);
};

DJDeck.prototype.setPitch = function(v){
  v = clamp(v, -8, 8);
  this.pitch = Math.round(v * 10) / 10;
  var t = 0.5 - (this.pitch / 16);
  var thumb = document.getElementById('pitchThumb' + this.id);
  var val = document.getElementById('pitchVal' + this.id);
  if (thumb) thumb.style.top = (t * 100) + '%';
  if (val) val.textContent = (this.pitch >= 0 ? '+' : '') + this.pitch.toFixed(1) + '%';
  var rate = 1 + this.pitch / 100;
  this.playbackRate = rate;
  if (this,.source) this.source.playbackRate.value = rate;
   if (this.baseBpm)0 this.bpm = Math.round(this.baseB,pm * rate * 10) /  10;
  this.updateUI();
};

DJDeck0.prototype.setVolume = function(v){
  this.volume = clamp(v, 0, 1);
  var side = (this.id === 'A') ? (100 - STATE.crossfader)/200 : (100 + STATE.crossfader)/200;
  this.gainNode.gain.value = this.volume * side * 1.2;
};

DJDeck.prototype.setEQ = function(band, v){
  var dB = (v - 0.5) * 30;
  if (band === 'low') this.eqLow.gain.value = dB;
  else if (band === 'mid') this.eqMid.gain.value = dB;
  else if (band === 'high') this.eqHigh.gain.value = dB;
};

DJDeck.prototype.setFX = function(name, v){
  if (name === 'FILTER'){
    this.filterNode.frequency.value = v > 0 ? (200 + (1 - v) * 19800) : 20000;
  } else if (name === 'ECHO'){
    this.delayWet.gain.value = v * 0.6;
  } else if (name === 'REVERB'){
    this.reverbWet.gain.value = v * 0.7;
  } else if (name === 'FLANGER'){
    this.flangerWet.gain.value = v * 0.5;
    this.flangerLFO.frequency.value = 0.2 + v * 1.5;
  }
};

DJDeck.prototype.setLoop = function(size){
  if (!this.buffer){ toast('Load track dulu','err'); return; }
  var beat = this.bpm > 0 ? (60 / this.bpm) : 0.5;
  this.loopStart = this.position;
  this.loopEnd = this.loopStart + size * beat;
  this.loopActive = true;
  toast('LOOP ' + size + ' beat', 'ok');
};

DJDeck.prototype.syncTo = function(other){
  if (!this.buffer || !other.buffer || !other.bpm || !this.baseBpm){
    toast('Butuh 2 track dengan BPM terdeteksi','err'); return;
  }
  var target = other.bpm * (1 + (other.pitch||0)/100);
  var rate = target / this.baseBpm;
  this.playbackRate = rate;
  if (this.source) this.source.playbackRate.value = rate;
  this.pitch = Math.round((rate - 1) * 1000) / 10;
  var t = 0.5 - (this.pitch / 16);
  var thumb = document.getElementById('pitchThumb' + this.id);
  if (thumb) thumb.style.top = (t * 100) + '%';
  var val = document.getElementById('pitchVal' + this.id);
  if (val) val.textContent = (this.pitch >= 0 ? '+' : '') + this.pitch.toFixed(1) + '%';
  this.bpm = Math.round(this.baseBpm * rate * 10) / 10;
  this.updateUI();
  toast('SYNC → ' + this.bpm.toFixed(1) + ' BPM', 'ok');
};

Object.defineProperty(DJDeck.prototype, 'position', {
  get: function(){
    if (!this.buffer) return 0;
    if (!this.playing) return this.currentOffset;
    var elapsed = (ctx.currentTime - this.startedAt) * this.playbackRate;
    var pos = this.startOffset + elapsed;
    if (pos >= this.buffer.duration) return this.buffer.duration;
    return pos;
  }
});

DJDeck.prototype.updateUI = function(){
  var self = this;
  var el = function(id){ return document.getElementById(id + self.id); };
  var t = el('title'); if (t) t.textContent = this.title;
  var a = el('artist'); if (a) a.textContent = this.artist;
  var b = el('bpm'); if (b) b.textContent = this.bpm > 0 ? this.bpm.toFixed(1) : '--';
  var d = el('dur'); if (d) d.textContent = fmtTime(this.duration);
  var p = el('play');
  if (p){
    p.classList.toggle('playing', this.playing);
    p.innerHTML = this.playing
      ? '<svg class="icon icon-fill" viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>'
      : '<svg class="icon icon-fill" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  }
  var arm = el('arm');
  if (arm) arm.classList.toggle('playing', this.playing);
};

/* =========================================================
   WAVEFORM
   ========================================================= */
function drawWave(deck){
  var canvas = document.getElementById('wave' + deck.id);
  if (!canvas) return;
  var c = canvas.getContext('2d');
  var w = canvas.clientWidth || 300;
  var h = canvas.clientHeight || 52;
  var dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
  if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
  c.setTransform(dpr, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  c.fillStyle = '#08090a'; c.fillRect(0, 0, w, h);

  var mid = h / 2;
  var progress = 0;
  if (deck.buffer && deck.duration > 0){
    progress = clamp((deck.position || 0) / deck.duration, 0, 1);
  }
  var playedX = w * progress;

  if (!deck.peaks){
    c.fillStyle = '#1a1c20'; c.fillRect(0, mid - 1, w, 2);
  } else {
    var N = deck.peaks.length;
    var bw = w / N;
    for (var i = 0; i < N; i++){
      var amp = Math.max(1, deck.peaks[i] * (mid - 2));
      var x = i * bw;
      var played = x <= playedX;
      if (played){
        var g = c.createLinearGradient(0, mid-amp, 0, mid+amp);
        g.addColorStop(0,'#7a7d84'); g.addColorStop(.5,'#f0f0f2'); g.addColorStop(1,'#7a7d84');
        c.fillStyle = g;
      } else {
        var g2 = c.createLinearGradient(0, mid-amp, 0, mid+amp);
        g2.addColorStop(0,'#2a2c30'); g2.addColorStop(.5,'#4a4c50'); g2.addColorStop(1,'#2a2c30');
        c.fillStyle = g2;
      }
      c.fillRect(x + 0.5, mid - amp, Math.max(1, bw - 1), amp * 2);
    }
  }

  if (progress > 0){
    c.strokeStyle = '#ffffff'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(playedX, 0); c.lineTo(playedX, h); c.stroke();
  }
  for (var hi = 0; hi < 8; hi++){
    if (deck.hotCues[hi] != null && deck.duration > 0){
      var hx = (deck.hotCues[hi] / deck.duration) * w;
      c.fillStyle = '#ff3b3b';
      c.fillRect(hx - 1, 0, 2, 6);
    }
  }
}

/* =========================================================
   STATE
   ========================================================= */
var STATE = {
  crossfader: 0,
  mobileTab: 'A',
  lastActiveDeck: 'A',
  library: { tracks: [], playlists: [], history: [] },
  libTab: 'tracks',
  knobs: {},
  pitches: { A: 0, B: 0 },
  viewingPlaylistId: null
};

function saveState(){
  try {
    localStorage.setItem('djmixer4', JSON.stringify({
      crossfader: STATE.crossfader,
      knobs: STATE.knobs,
      pitches: STATE.pitches
    }));
  } catch(e){}
}
function loadState(){
  try {
    var raw = localStorage.getItem('djmixer4');
    if (!raw) return;
    var p = JSON.parse(raw);
    if (typeof p.crossfader === 'number') STATE.crossfader = p.crossfader;
    if (p.knobs) STATE.knobs = p.knobs;
    if (p.pitches) STATE.pitches = p.pitches;
  } catch(e){}
}

/* =========================================================
   DECKS
   ========================================================= */
var deckA = new DJDeck('A', crossGainA);
var deckB = new DJDeck('B', crossGainB);

function applyCrossfader(){
  var ca = (100 - STATE.crossfader) / 200;
  var cb = (100 + STATE.crossfader) / 200;
  crossGainA.gain.value = ca;
  crossGainB.gain.value = cb;
}
applyCrossfader();

/* =========================================================
   ROTATION TICKER
   ========================================================= */
var lastT = 0, rotA = 0, rotB = 0, speedA = 0, speedB = 0;
var lastDraw = 0;
function tickRotation(now){
  var dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  [[deckA,'A'], [deckB,'B']].forEach(function(pair){
    var d = pair[0], id = pair[1];
    var target = d.playing ? (200 * d.playbackRate) : 0;
    var cur = (id === 'A') ? speedA : speedB;
    cur += (target - cur) * 0.08;
    if (Math.abs(cur) < 0.2) cur = 0;
    if (id === 'A') speedA = cur; else speedB = cur;
    var rot = (id === 'A') ? rotA : rotB;
    rot = (rot + cur * dt) % 360;
    if (id === 'A') rotA = rot; else rotB = rot;
    var el = document.getElementById('rotor' + id);
    if (el) el.style.transform = 'rotate(' + rot + 'deg)';

    var tEl = document.getElementById('time' + id);
    if (tEl) tEl.textContent = fmtTime(d.position);

    if (d.loopActive && d.loopEnd != null && d.loopStart != null && d.playing){
      if (d.position >= d.loopEnd) d.seek(d.loopStart);
    }
  });

  if (now - lastDraw > 50){
    lastDraw = now;
    drawWave(deckA);
    drawWave(deckB);
  }
  requestAnimationFrame(tickRotation);
}
requestAnimationFrame(function(t){ lastT = t; requestAnimationFrame(tickRotation); });

/* =========================================================
   LIBRARY / PLAYLIST / HISTORY
   ========================================================= */
function refreshLibrary(){
  return fetch('/api/library').then(function(r){ return r.json(); }).then(function(d){
    STATE.library = d;
    return d;
  }).catch(function(){ return STATE.library; });
}

function openLibraryModal(){
  var m = openModal(
    '<h2>MUSIK SAYA <button class="close" data-act="close-modal"><svg class="icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg></button></h2>'
    + '<div class="lib-tabs">'
    + '<button data-libtab="tracks" class="active">MUSIK SAYA</button>'
    + '<button data-libtab="playlists">PLAYLIST</button>'
    + '<button data-libtab="history">HISTORY</button>'
    + '</div>'
    + '<div class="library-list" id="libList"><div class="empty">Loading…</div></div>'
    + '<div class="modal-actions">'
    + '<button class="btn primary" data-act="open-add-url">+ TAMBAH URL BARU</button>'
    + '</div>'
  );
  STATE.libTab = 'tracks';
  refreshLibrary().then(function(){ renderLib(); });
}

function renderLib(){
  var list = document.getElementById('libList');
  if (!list) return;
  $$('.lib-tabs button').forEach(function(b){
    b.classList.toggle('active', b.getAttribute('data-libtab') === STATE.libTab);
  });

  if (STATE.libTab === 'tracks') renderTracksList(list);
  else if (STATE.libTab === 'playlists') renderPlaylistsList(list);
  else if (STATE.libTab === 'history') renderHistoryList(list);
}

function renderTracksList(list){
  var tracks = STATE.library.tracks || [];
  if (!tracks.length){
    list.innerHTML = '<div class="empty">Belum ada musik.<br>Tap "+ TAMBAH URL BARU" untuk download.</div>';
    return;
  }
  list.innerHTML = tracks.map(function(t){
    return '<div class="track" data-id="' + esc(t.id) + '">'
      + '<div style="min-width:0">'
      + '<div class="ti">' + esc(t.title) + '</div>'
      + '<div class="tm">'
      + '<span>' + (t.bpm ? t.bpm.toFixed(1) + ' BPM' : 'BPM --') + '</span>'
      + '<span>' + fmtTime(t.duration) + '</span>'
      + '<span>' + fmtSize(t.size || 0) + '</span>'
      + '<span>' + (t.playCount ? '▶ ' + t.playCount : '') + '</span>'
      + '</div></div>'
      + '<div class="actions">'
      + '<button data-act="lib-play" data-id="' + esc(t.id) + '" data-deck="A">A</button>'
      + '<button data-act="lib-play" data-id="' + esc(t.id) + '" data-deck="B">B</button>'
      + '<button data-act="lib-addto" data-id="' + esc(t.id) + '" title="Add to playlist">+PL</button>'
      + '<button class="danger" data-act="lib-del" data-id="' + esc(t.id) + '">×</button>'
      + '</div></div>';
  }).join('');
}

function renderPlaylistsList(list){
  var pls = STATE.library.playlists || [];
  if (STATE.viewingPlaylistId){
    var pl = pls.find(function(p){ return p.id === STATE.viewingPlaylistId; });
    if (!pl){ STATE.viewingPlaylistId = null; return renderPlaylistsList(list); }
    var tracks = (pl.trackIds || []).map(function(id){
      return STATE.library.tracks.find(function(t){ return t.id === id; });
    }).filter(Boolean);
    list.innerHTML =
      '<div style="display:flex;gap:8px;margin-bottom:8px;align-items:center;">'
      + '<button data-act="back-pl" style="padding:8px 12px;background:#1a1b1e;border:1px solid #2c2e32;border-radius:8px;color:#c9cacd;font-size:11px;">← BACK</button>'
      + '<div style="flex:1;font-size:14px;font-weight:700;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(pl.name) + '</div>'
      + '<button data-act="del-pl" data-id="' + esc(pl.id) + '" class="danger" style="padding:8px 12px;background:#3a1a1a;border:1px solid #5a2a2a;border-radius:8px;color:#ff9d9d;font-size:11px;font-weight:700;">HAPUS PL</button>'
      + '</div>'
      + (tracks.length ? tracks.map(function(t){
        return '<div class="track">'
          + '<div style="min-width:0">'
          + '<div class="ti">' + esc(t.title) + '</div>'
          + '<div class="tm"><span>' + (t.bpm ? t.bpm.toFixed(1) + ' BPM' : '-- BPM') + '</span><span>' + fmtTime(t.duration) + '</span></div>'
          + '</div>'
          + '<div class="actions">'
          + '<button data-act="lib-play" data-id="' + esc(t.id) + '" data-deck="A">A</button>'
          + '<button data-act="lib-play" data-id="' + esc(t.id) + '" data-deck="B">B</button>'
          + '<button class="danger" data-act="pl-rm" data-pl="' + esc(pl.id) + '" data-id="' + esc(t.id) + '">×</button>'
          + '</div></div>';
      }).join('') : '<div class="empty">Playlist kosong. Tambah dari MUSIK SAYA (+PL).</div>');
    return;
  }
  list.innerHTML = (pls.length
    ? pls.map(function(p){
      return '<div class="track" style="cursor:pointer;" data-pl-open="' + esc(p.id) + '">'
        + '<div style="min-width:0"><div class="ti">📁 ' + esc(p.name) + '</div>'
        + '<div class="tm"><span>' + (p.trackIds || []).length + ' track</span><span>' + fmtAgo(p.createdAt) + '</span></div></div>'
        + '<div class="actions"><button data-act="open-pl" data-id="' + esc(p.id) + '">OPEN</button></div></div>';
    }).join('')
    : '<div class="empty">Belum ada playlist.</div>')
    + '<button class="btn primary" style="margin-top:8px;" data-act="new-pl">+ BUAT PLAYLIST BARU</button>';
}

function renderHistoryList(list){
  var hist = STATE.library.history || [];
  if (!hist.length){
    list.innerHTML = '<div class="empty">Belum ada history.</div>';
    return;
  }
  list.innerHTML = hist.map(function(h){
    var t = STATE.library.tracks.find(function(x){ return x.id === h.trackId; });
    if (!t) return '';
    return '<div class="track">'
      + '<div style="min-width:0">'
      + '<div class="ti">' + esc(t.title) + '</div>'
      + '<div class="tm"><span>Deck ' + esc(h.deckId) + '</span><span>' + fmtAgo(h.playedAt) + '</span></div>'
      + '</div>'
      + '<div class="actions">'
      + '<button data-act="lib-play" data-id="' + esc(t.id) + '" data-deck="A">A</button>'
      + '<button data-act="lib-play" data-id="' + esc(t.id) + '" data-deck="B">B</button>'
      + '</div></div>';
  }).join('') + '<button class="btn danger" style="margin-top:8px;" data-act="clear-hist">CLEAR HISTORY</button>';
}

/* =========================================================
   LOAD TRACK FROM LIBRARY
   ========================================================= */
function loadTrackFromLibrary(trackId, deckId){
  var track = STATE.library.tracks.find(function(t){ return t.id === trackId; });
  if (!track){ toast('Track tidak ditemukan','err'); return; }
  var deck = deckId === 'A' ? deckA : deckB;
  toast('Memuat ke Deck ' + deckId + '…');
  fetch('/api/stream/' + trackId)
    .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
    .then(function(ab){ return ctx.decodeAudioData(ab); })
    .then(function(buf){
      deck.loadBuffer(buf, {
        id: track.id,
        title: track.title,
        duration: track.duration,
        bpm: track.bpm
      });
      deck.setVolume(deck.volume);
      fetch('/api/history', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ trackId: trackId, deckId: deckId })
      }).then(function(){ refreshLibrary(); });
      toast('Loaded: ' + track.title.slice(0, 40), 'ok');
      closeModal();
    })
    .catch(function(err){
      toast('Gagal load: ' + err.message, 'err');
    });
}

/* =========================================================
   DOWNLOAD WITH PROGRESS
   ========================================================= */
function downloadTrack(url, deckId){
  var m = openModal(
    '<h2>DOWNLOAD <button class="close" data-act="close-modal"><svg class="icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg></button></h2>'
    + '<div class="progress-modal">'
    + '<div class="progress-pct" id="pctEl">0%</div>'
    + '<div class="progress-phase" id="phaseEl">Menghubungi server…</div>'
    + '<div class="progress-bar-wrap"><div class="progress-bar-fill" id="barEl"></div></div>'
    + '<div class="status" id="dlStatus" style="margin-top:12px;font-size:12px;color:#8f9093;">Memulai…</div>'
    + '<div class="status-err" id="errEl" style="display:none;"></div>'
    + '</div>'
  );
  var pctEl = m.querySelector('#pctEl');
  var phaseEl = m.querySelector('#phaseEl');
  var barEl = m.querySelector('#barEl');
  var statusEl = m.querySelector('#dlStatus');
  var errEl = m.querySelector('#errEl');

  fetch('/api/load', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ url: url })
  })
  .then(function(r){ return r.json(); })
  .then(function(data){
    if (data.error){
      errEl.style.display = 'block';
      errEl.textContent = data.error;
      phaseEl.textContent = 'GAGAL';
      return;
    }
    if (data.existing && data.track){
      // sudah ada di library, langsung load
      pctEl.textContent = '100%';
      phaseEl.textContent = 'SUDAH ADA DI LIBRARY';
      barEl.style.width = '100%';
      statusEl.textContent = 'Memuat ke Deck ' + deckId + '…';
      refreshLibrary().then(function(){
        setTimeout(function(){
          closeModal();
          loadTrackFromLibrary(data.track.id, deckId);
        }, 300);
      });
      return;
    }
    if (!data.jobId){
      errEl.style.display = 'block';
      errEl.textContent = 'Server error';
      return;
    }
    var jobId = data.jobId;
    var pollCount = 0;
    var poll = setInterval(function(){
      pollCount++;
      if (pollCount > 600){ // 5 menit max
        clearInterval(poll);
        errEl.style.display = 'block';
        errEl.textContent = 'Timeout. Coba lagi.';
        phaseEl.textContent = 'TIMEOUT';
        return;
      }
      fetch('/api/status/' + jobId)
        .then(function(r){ return r.json(); })
        .then(function(s){
          if (s.status === 'done'){
            clearInterval(poll);
            pctEl.textContent = '100%';
            barEl.style.width = '100%';
            phaseEl.textContent = 'SELESAI';
            statusEl.textContent = 'Memuat ke Deck ' + deckId + '…';
            refreshLibrary().then(function(){
              setTimeout(function(){
                closeModal();
                if (s.track) loadTrackFromLibrary(s.track.id, deckId);
                toast('Downloaded: ' + ((s.track && s.track.title) || 'track').slice(0, 40), 'ok');
              }, 300);
            });
          } else if (s.status === 'error'){
            clearInterval(poll);
            errEl.style.display = 'block';
            errEl.textContent = s.error || 'Download gagal';
            phaseEl.textContent = 'GAGAL';
          } else {
            var p = Math.round(s.progress || 0);
            pctEl.textContent = p + '%';
            barEl.style.width = p + '%';
            phaseEl.textContent = s.phase === 'converting' ? 'CONVERTING TO MP3' : 'DOWNLOADING';
            statusEl.textContent = s.title ? ('🎵 ' + s.title.slice(0, 60)) : 'Mengunduh…';
          }
        })
        .catch(function(err){
          clearInterval(poll);
          errEl.style.display = 'block';
          errEl.textContent = 'Poll error: ' + err.message;
        });
    }, 500);
  })
  .catch(function(err){
    errEl.style.display = 'block';
    errEl.textContent = err.message;
  });
}

/* =========================================================
   MODAL
   ========================================================= */
function openModal(html){
  var bg = document.getElementById('modalBg');
  bg.innerHTML = '<div class="modal">' + html + '</div>';
  bg.classList.add('open');
  return bg.querySelector('.modal');
}
function closeModal(){
  var bg = document.getElementById('modalBg');
  bg.classList.remove('open');
  bg.innerHTML = '';
}

function openAddUrlModal(){
  openModal(
    '<h2>LOAD DARI URL <button class="close" data-act="close-modal"><svg class="icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg></button></h2>'
    + '<div class="field"><label>YOUTUBE URL</label><input type="text" id="ytUrlInput" placeholder="https://www.youtube.com/watch?v=..." autocomplete="off" autocapitalize="off" spellcheck="false"></div>'
    + '<div class="modal-actions">'
    + '<button class="btn" data-act="load-url" data-deck="A">→ DECK A</button>'
    + '<button class="btn primary" data-act="load-url" data-deck="B">→ DECK B</button>'
    + '</div>'
    + '<div style="font-size:11px;color:#7d7e81;margin-top:12px;line-height:1.6;">'
    + 'Server akan download audio via yt-dlp + ffmpeg, convert ke MP3, dan simpan permanen di MUSIK SAYA.'
    + '</div>'
  );
  setTimeout(function(){ var i = document.getElementById('ytUrlInput'); if (i) i.focus(); }, 150);
}

function openMenuModal(){
  openModal(
    '<h2>MENU <button class="close" data-act="close-modal"><svg class="icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg></button></h2>'
    + '<div class="menu-list">'
    + '<button class="menu-item" data-act="menu-act" data-sub="lib">🎵 MUSIK SAYA<span class="badge">' + (STATE.library.tracks.length || 0) + '</span></button>'
    + '<button class="menu-item" data-act="menu-act" data-sub="addurl">➕ TAMBAH URL</button>'
    + '<button class="menu-item" data-act="menu-act" data-sub="about">ℹ ABOUT</button>'
    + '<button class="menu-item danger" data-act="menu-act" data-sub="reset">⟲ RESET LOCAL SETTINGS</button>'
    + '</div>'
  );
}

function openAddToPlaylistModal(trackId){
  var pls = STATE.library.playlists || [];
  var html = '<h2>ADD TO PLAYLIST <button class="close" data-act="close-modal"><svg class="icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg></button></h2>';
  if (!pls.length){
    html += '<div class="empty">Belum ada playlist.</div>';
    html += '<button class="btn primary" style="margin-top:8px;" data-act="new-pl-for" data-id="' + esc(trackId) + '">+ BUAT PLAYLIST</button>';
  } else {
    html += '<div class="library-list">';
    pls.forEach(function(p){
      html += '<button class="menu-item" data-act="add-pl" data-pl="' + esc(p.id) + '" data-id="' + esc(trackId) + '">📁 ' + esc(p.name) + '<span class="badge">' + (p.trackIds || []).length + '</span></button>';
    });
    html += '</div>';
    html += '<button class="btn primary" style="margin-top:8px;" data-act="new-pl-for" data-id="' + esc(trackId) + '">+ BUAT PLAYLIST BARU</button>';
  }
  openModal(html);
}

function openNewPlaylistModal(trackId){
  openModal(
    '<h2>PLAYLIST BARU <button class="close" data-act="close-modal"><svg class="icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg></button></h2>'
    + '<div class="field"><label>NAMA PLAYLIST</label><input type="text" id="plNameInput" placeholder="My Set 01" autocomplete="off"></div>'
    + '<div class="modal-actions">'
    + '<button class="btn primary" data-act="create-pl" data-track="' + (trackId || '') + '">SIMPAN</button>'
    + '</div>'
  );
  setTimeout(function(){ var i = document.getElementById('plNameInput'); if (i) i.focus(); }, 150);
}

function openAboutModal(){
  openModal(
    '<h2>ABOUT <button class="close" data-act="close-modal"><svg class="icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg></button></h2>'
    + '<div style="font-size:12.5px;color:#cfcfcf;line-height:1.8;">'
    + '<b style="color:#fff;">DJ MIXER v3.1</b><br><br>'
    + '<b style="color:#fff;">Fitur real:</b><br>'
    + '• Download YouTube → MP3 (yt-dlp + ffmpeg)<br>'
    + '• Musik tersimpan permanen di folder ./music/<br>'
    + '• Playlist & history persistent<br>'
    + '• EQ 3-band, Filter, Echo, Reverb, Flanger (Web Audio DSP)<br>'
    + '• Pitch, Sync (BPM autocorrelation), Loop, Hot Cues<br>'
    + '• Waveform dari AudioBuffer real<br><br>'
    + '<b style="color:#fff;">Total track:</b> ' + STATE.library.tracks.length + '<br>'
    + '<b style="color:#fff;">Playlist:</b> ' + STATE.library.playlists.length + '<br>'
    + '<b style="color:#fff;">History:</b> ' + STATE.library.history.length
    + '</div>'
  );
}

function openResetConfirm(){
  openModal(
    '<h2>RESET LOCAL <button class="close" data-act="close-modal"><svg class="icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg></button></h2>'
    + '<div style="font-size:13px;color:#cfcfcf;line-height:1.7;margin-bottom:14px;">Reset pengaturan lokal (crossfader, knob, pitch). Library & playlists tetap aman di server.</div>'
    + '<div class="modal-actions">'
    + '<button class="btn" data-act="close-modal">BATAL</button>'
    + '<button class="btn primary" data-act="reset-confirm">RESET</button>'
    + '</div>'
  );
}

/* =========================================================
   SIDE PANEL (FX/LOOP/EQ/HOT CUES)
   ========================================================= */
function openPanel(deckId, panel){
  var deck = deckId === 'A' ? deckA : deckB;
  var body = document.getElementById('fxPanelBody');
  var title = document.getElementById('fxPanelTitle');
  var panelEl = document.getElementById('fxPanel');
  title.textContent = 'DECK ' + deckId + ' · ' + panel.toUpperCase();
  body.innerHTML = '';

  if (panel === 'fx'){
    var h = '<div class="fx-grid">';
    ['FILTER','ECHO','REVERB','FLANGER'].forEach(function(n){
      h += '<div class="fx-item"><div class="n">' + n + '</div>'
        + '<div class="knob sm" data-fxknob="' + n + '"></div>'
        + '<button class="on" data-act="fx-toggle" data-deck="' + deckId + '" data-fx="' + n + '">OFF</button></div>';
    });
    h += '</div>';
    body.innerHTML = h;
    $$('.knob[data-fxknob]', body).forEach(function(k){
      var fxName = k.getAttribute('data-fxknob');
      var key = deckId + '-fx-' + fxName;
      var v = typeof STATE.knobs[key] === 'number' ? STATE.knobs[key] : 0;
      bindKnob(k, key, function(val){ deck.setFX(fxName, val); }, 0);
    });
  } else if (panel === 'loop'){
    body.innerHTML =
      '<div class="loop-grid">'
      + '<button class="loop-btn" data-act="loop-set" data-deck="' + deckId + '" data-size="0.5">1/2</button>'
      + '<button class="loop-btn" data-act="loop-set" data-deck="' + deckId + '" data-size="1">1</button>'
      + '<button class="loop-btn" data-act="loop-set" data-deck="' + deckId + '" data-size="2">2</button>'
      + '<button class="loop-btn" data-act="loop-set" data-deck="' + deckId + '" data-size="4">4</button>'
      + '<button class="loop-btn" data-act="loop-set" data-deck="' + deckId + '" data-size="8">8</button>'
      + '<button class="loop-btn" data-act="loop-set" data-deck="' + deckId + '" data-size="16">16</button>'
      + '</div>'
      + '<div style="display:flex;gap:6px;margin-top:8px;">'
      + '<button class="loop-btn" style="flex:1" data-act="loop-in" data-deck="' + deckId + '">LOOP IN</button>'
      + '<button class="loop-btn" style="flex:1" data-act="loop-out" data-deck="' + deckId + '">LOOP OUT</button>'
      + '<button class="loop-btn" style="flex:1" data-act="loop-clear" data-deck="' + deckId + '">CLEAR</button>'
      + '</div>';
  } else if (panel === 'eq'){
    var h3 = '';
    ['HIGH','MID','LOW'].forEach(function(n){
      h3 += '<div class="eq-panel-row"><div class="k">' + n + '</div>'
        + '<div class="knob" data-eqband="' + n.toLowerCase() + '"></div></div>';
    });
    h3 += '<div style="font-size:10px;color:#7d7e81;margin-top:8px;line-height:1.5;">Real-time biquad filter. Double-tap knob untuk reset ke tengah.</div>';
    body.innerHTML = h3;
    $$('.knob[data-eqband]', body).forEach(function(k){
      var band = k.getAttribute('data-eqband');
      var key = deckId + '-eq-' + band;
      var v = typeof STATE.knobs[key] === 'number' ? STATE.knobs[key] : 0.5;
      bindKnob(k, key, function(val){ deck.setEQ(band, val); }, 0.5);
    });
  } else if (panel === 'cue'){
    var h4 = '<div class="cue-grid">';
    for (var i = 0; i < 8; i++){
      var cls = deck.hotCues[i] != null ? ' set' : '';
      h4 += '<button class="cue-btn' + cls + '" data-act="hotcue" data-idx="' + i + '" data-deck="' + deckId + '">CUE ' + (i+1) + '</button>';
    }
    h4 += '</div>';
    h4 += '<div style="display:flex;gap:6px;margin-top:10px;">'
      + '<button class="loop-btn" style="flex:1" data-act="set-main-cue" data-deck="' + deckId + '">SET MAIN CUE</button>'
      + '</div>';
    body.innerHTML = h4;
  }

  var isMobileLandscape = window.matchMedia('(orientation:landscape) and (max-height:600px)').matches;
  var isMobilePortrait = window.matchMedia('(max-width:900px) and (orientation:portrait)').matches;
  if (!isMobilePortrait && !isMobileLandscape){
    var btn = document.querySelector('.side[data-deck="' + deckId + '"] .side-btn[data-panel="' + panel + '"]');
    if (btn){
      var r = btn.getBoundingClientRect();
      panelEl.style.left = Math.max(8, deckId === 'A' ? (r.right + 6) : (r.left - 270)) + 'px';
      panelEl.style.top = Math.max(80, r.top) + 'px';
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';
    }
  }
  panelEl.classList.add('open');
  $$('.side-btn').forEach(function(b){
    if (b.getAttribute('data-deck') === deckId && b.getAttribute('data-panel') === panel) b.classList.add('active');
    else b.classList.remove('active');
  });
}

function refreshCueGrid(deck){
  var body = document.getElementById('fxPanelBody');
  if (!body) return;
  $$('.cue-btn', body).forEach(function(b){
    var idx = parseInt(b.getAttribute('data-idx'), 10);
    b.classList.toggle('set', deck.hotCues[idx] != null);
  });
}

/* =========================================================
   KNOB
   ========================================================= */
function bindKnob(el, key, onChange, defaultVal){
  var dragging = false, startY = 0, startV;
  var v = STATE.knobs[key];
  if (typeof v !== 'number') v = (typeof defaultVal === 'number') ? defaultVal : 0;
  STATE.knobs[key] = v;
  el.style.transform = 'rotate(' + (-135 + v * 270) + 'deg)';
  el.addEventListener('pointerdown', function(e){
    dragging = true; startY = e.clientY; startV = STATE.knobs[key];
    try { el.setPointerCapture(e.pointerId); } catch(err){}
    e.preventDefault(); e.stopPropagation();
  });
  el.addEventListener('pointermove', function(e){
    if (!dragging) return;
    var nv = clamp(startV + (startY - e.clientY) / 150, 0, 1);
    STATE.knobs[key] = nv;
    el.style.transform = 'rotate(' + (-135 + nv * 270) + 'deg)';
    if (onChange) onChange(nv);
  });
  el.addEventListener('pointerup', function(e){
    dragging = false;
    try { el.releasePointerCapture(e.pointerId); } catch(err){}
    saveState();
  });
  el.addEventListener('dblclick', function(){
    var dv = (typeof defaultVal === 'number') ? defaultVal : 0;
    STATE.knobs[key] = dv;
    el.style.transform = 'rotate(' + (-135 + dv * 270) + 'deg)';
    if (onChange) onChange(dv);
    saveState();
  });
  if (onChange) onChange(v);
}

/* =========================================================
   PAD OVERLAY
   ========================================================= */
function buildPads(deck){
  var overlay = document.getElementById('padOverlay' + deck.id);
  if (!overlay) return;
  overlay.innerHTML = '';
  for (var i = 0; i < 16; i++){
    var btn = document.createElement('button');
    btn.className = 'pad';
    var cueIdx = i % 8;
    btn.textContent = (i+1);
    btn.setAttribute('data-pad-idx', i);
    btn.setAttribute('data-pad-deck', deck.id);
    if (deck.hotCues[cueIdx] != null) btn.classList.add('has-cue');
    btn.addEventListener('click', function(e){
      var idx = parseInt(e.currentTarget.getAttribute('data-pad-idx'), 10);
      var cueIdx2 = idx % 8;
      deck.setHotCue(cueIdx2);
      e.currentTarget.classList.add('active');
      setTimeout(function(){ e.currentTarget.classList.remove('active'); }, 150);
    });
    overlay.appendChild(btn);
  }
}

function updatePadOverlay(deck){
  var overlay = document.getElementById('padOverlay' + deck.id);
  if (!overlay) return;
  $$('.pad', overlay).forEach(function(p){
    var idx = parseInt(p.getAttribute('data-pad-idx'), 10) % 8;
    p.classList.toggle('has-cue', deck.hotCues[idx] != null);
  });
}

buildPads(deckA);
buildPads(deckB);

/* =========================================================
   TABS / MODE SWITCH
   ========================================================= */
function applyMobileTab(){
  var isPortraitMobile = window.matchMedia('(max-width:900px) and (orientation:portrait)').matches;
  var a = document.getElementById('deckA');
  var b = document.getElementById('deckB');
  var sa = document.getElementById('sideA');
  var sb = document.getElementById('sideB');

  if (!isPortraitMobile){
    a.classList.add('show');
    b.classList.add('show');
    sa.classList.remove('show');
    sb.classList.remove('show');
    return;
  }
  var tab = STATE.mobileTab;
  a.classList.toggle('show', tab === 'A');
  b.classList.toggle('show', tab === 'B');
  sa.classList.toggle('show', tab === 'A');
  sb.classList.toggle('show', tab === 'B');
}

/* =========================================================
   CLICK DELEGATION
   ========================================================= */
document.addEventListener('click', function(e){
  var target = e.target;

  // Lib tabs
  var ltab = target.closest && target.closest('.lib-tabs button');
  if (ltab){
    STATE.libTab = ltab.getAttribute('data-libtab');
    STATE.viewingPlaylistId = null;
    renderLib();
    return;
  }

  // Tabs (mobile A/B/M)
  var tb = target.closest && target.closest('.tabs button');
  if (tb){
    STATE.mobileTab = tb.getAttribute('data-tab');
    $$('.tabs button').forEach(function(b){ b.classList.remove('active'); });
    tb.classList.add('active');
    applyMobileTab();
    return;
  }

  // Mode switch
  var mb = target.closest && target.closest('.mode-switch button');
  if (mb){
    $$('.mode-switch button').forEach(function(b){ b.classList.remove('active'); });
    mb.classList.add('active');
    var mode = mb.getAttribute('data-mode');
    document.getElementById('deckA').classList.toggle('pad-mode', mode === 'pad');
    document.getElementById('deckB').classList.toggle('pad-mode', mode === 'pad');
    toast(mode.toUpperCase() + ' mode', 'ok');
    return;
  }

  // Actions
  var t = target.closest && target.closest('[data-act]');
  if (!t) return;
  var act = t.getAttribute('data-act');
  var deckId = t.getAttribute('data-deck') || 'A';
  var deck = deckId === 'A' ? deckA : deckB;

  switch (act){
    case 'open-lib': openLibraryModal(); break;
    case 'open-add-url': closeModal(); setTimeout(openAddUrlModal, 200); break;
    case 'menu': openMenuModal(); break;
    case 'close-modal': closeModal(); break;
    case 'menu-act':
      var sub = t.getAttribute('data-sub');
      if (sub === 'lib'){ closeModal(); setTimeout(openLibraryModal, 200); }
      else if (sub === 'addurl'){ closeModal(); setTimeout(openAddUrlModal, 200); }
      else if (sub === 'about'){ closeModal(); setTimeout(openAboutModal, 200); }
      else if (sub === 'reset'){ closeModal(); setTimeout(openResetConfirm, 200); }
      break;
    case 'reset-confirm':
      try { localStorage.removeItem('djmixer4'); } catch(err){}
      toast('Local settings reset', 'ok');
      setTimeout(function(){ location.reload(); }, 400);
      break;
    case 'load-url':
      var inp = document.getElementById('ytUrlInput');
      if (!inp) break;
      var url = inp.value.trim();
      if (!url){ toast('Masukkan URL','err'); break; }
      if (!/youtube\.com|youtu\.be/.test(url)){ toast('Invalid YouTube URL','err'); break; }
      closeModal();
      setTimeout(function(){ downloadTrack(url, deckId); }, 200);
      break;

    case 'lib-play':
      var id = t.getAttribute('data-id');
      loadTrackFromLibrary(id, deckId);
      break;
    case 'lib-del':
      var idDel = t.getAttribute('data-id');
      if (!confirm('Hapus track ini dari MUSIK SAYA?')) break;
      fetch('/api/library/' + idDel, { method: 'DELETE' })
        .then(function(r){ return r.json(); })
        .then(function(){ refreshLibrary().then(function(){ renderLib(); }); toast('Track dihapus','ok'); })
        .catch(function(){ toast('Gagal hapus','err'); });
      break;
    case 'lib-addto':
      var idAdd = t.getAttribute('data-id');
      refreshLibrary().then(function(){ openAddToPlaylistModal(idAdd); });
      break;
    case 'add-pl':
      var plId = t.getAttribute('data-pl');
      var trId = t.getAttribute('data-id');
      fetch('/api/playlists/' + plId + '/tracks', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ trackId: trId })
      }).then(function(r){ return r.json(); }).then(function(){
        toast('Ditambahkan ke playlist','ok');
        refreshLibrary().then(function(){ closeModal(); });
      });
      break;
    case 'new-pl':
      openNewPlaylistModal('');
      break;
    case 'new-pl-for':
      var trId2 = t.getAttribute('data-id');
      closeModal();
      setTimeout(function(){ openNewPlaylistModal(trId2); }, 200);
      break;
    case 'create-pl':
      var nameInput = document.getElementById('plNameInput');
      var name = nameInput ? nameInput.value.trim() : '';
      if (!name){ toast('Isi nama playlist','err'); break; }
      var trackToAdd = t.getAttribute('data-track') || '';
      fetch('/api/playlists', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ name: name })
      }).then(function(r){ return r.json(); }).then(function(res){
        if (res.error) throw new Error(res.error);
        if (trackToAdd && res.playlist){
          return fetch('/api/playlists/' + res.playlist.id + '/tracks', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ trackId: trackToAdd })
          });
        }
      }).then(function(){
        toast('Playlist dibuat','ok');
        refreshLibrary().then(function(){ closeModal(); });
      }).catch(function(err){ toast(err.message, 'err'); });
      break;
    case 'open-pl':
      STATE.viewingPlaylistId = t.getAttribute('data-id');
      renderLib();
      break;
    case 'back-pl':
      STATE.viewingPlaylistId = null;
      renderLib();
      break;
    case 'del-pl':
      var plIdDel = t.getAttribute('data-id');
      if (!confirm('Hapus playlist ini?')) break;
      fetch('/api/playlists/' + plIdDel, { method: 'DELETE' })
        .then(function(r){ return r.json(); })
        .then(function(){
          STATE.viewingPlaylistId = null;
          toast('Playlist dihapus','ok');
          refreshLibrary().then(function(){ renderLib(); });
        });
      break;
    case 'pl-rm':
      var plIdR = t.getAttribute('data-pl');
      var trIdR = t.getAttribute('data-id');
      fetch('/api/playlists/' + plIdR + '/tracks/' + trIdR, { method: 'DELETE' })
        .then(function(r){ return r.json(); })
        .then(function(){
          toast('Removed','ok');
          refreshLibrary().then(function(){ renderLib(); });
        });
      break;
    case 'clear-hist':
      if (!confirm('Hapus semua history?')) break;
      fetch('/api/history', { method: 'DELETE' })
        .then(function(r){ return r.json(); })
        .then(function(){
          toast('History cleared','ok');
          refreshLibrary().then(function(){ renderLib(); });
        });
      break;

    case 'panel':
      openPanel(deckId, t.getAttribute('data-panel'));
      break;
    case 'close-panel':
      document.getElementById('fxPanel').classList.remove('open');
      $$('.side-btn').forEach(function(b){ b.classList.remove('active'); });
      break;

    case 'play': deck.toggle(); break;
    case 'cue': deck.cue(); break;
    case 'set-main-cue': deck.setCue(); break;
    case 'sync':
      var other = deckId === 'A' ? deckB : deckA;
      if (deck.buffer && other.buffer) deck.syncTo(other);
      else toast('Load 2 track dulu','err');
      break;
    case 'hp':
      t.classList.toggle('active');
      toast('Headphone Deck ' + deckId + ' ' + (t.classList.contains('active') ? 'ON' : 'OFF'), 'ok');
      break;
    case 'pitch':
      var dir = t.getAttribute('data-dir');
      deck.setPitch(deck.pitch + (dir === 'up' ? 0.1 : -0.1));
      STATE.pitches[deckId] = deck.pitch;
      saveState();
      break;
    case 'hotcue':
      deck.setHotCue(parseInt(t.getAttribute('data-idx'), 10));
      break;

    case 'fx-toggle':
      var fxName = t.getAttribute('data-fx');
      var isOn = t.classList.toggle('on');
      t.textContent = isOn ? 'ON' : 'OFF';
      t.parentNode.classList.toggle('on', isOn);
      var key = deckId + '-fx-' + fxName;
      if (!isOn){
        deck.setFX(fxName, 0);
        var knobEl = t.parentNode.querySelector('.knob');
        if (knobEl) knobEl.style.transform = 'rotate(-135deg)';
        STATE.knobs[key] = 0;
      } else {
        var val = STATE.knobs[key] || 0.6;
        STATE.knobs[key] = val;
        var ke = t.parentNode.querySelector('.knob');
        if (ke) ke.style.transform = 'rotate(' + (-135 + val * 270) + 'deg)';
        deck.setFX(fxName, val);
      }
      saveState();
      break;

    case 'loop-set':
      deck.setLoop(parseFloat(t.getAttribute('data-size')));
      $$('.loop-btn', t.parentNode).forEach(function(b){ b.classList.remove('active'); });
      t.classList.add('active');
      break;
    case 'loop-in':
      deck.loopStart = deck.position;
      toast('Loop In set','ok');
      break;
    case 'loop-out':
      if (deck.loopStart != null){
        deck.loopEnd = deck.position;
        deck.loopActive = true;
        toast('Loop Out set','ok');
      } else toast('Set Loop In dulu','err');
      break;
    case 'loop-clear':
      deck.loopStart = null; deck.loopEnd = null; deck.loopActive = false;
      toast('Loop cleared','ok');
      break;
  }
});

/* Close FX panel on outside tap */
document.addEventListener('pointerdown', function(e){
  var p = document.getElementById('fxPanel');
  if (!p || !p.classList.contains('open')) return;
  if (p.contains(e.target)) return;
  if (e.target.closest && e.target.closest('[data-act="panel"]')) return;
  p.classList.remove('open');
  $$('.side-btn').forEach(function(b){ b.classList.remove('active'); });
});

/* =========================================================
   DRAG HELPERS
   ========================================================= */
function bindVertical(el, onChange){
  var track = el.parentNode, dragging = false;
  function setFromY(cy){
    var r = track.getBoundingClientRect();
    var t = clamp((cy - r.top) / r.height, 0, 1);
    el.style.top = (t * 100) + '%';
    onChange(1 - t);
  }
  el.addEventListener('pointerdown', function(e){
    dragging = true;
    try { el.setPointerCapture(e.pointerId); } catch(err){}
    e.preventDefault(); e.stopPropagation();
  });
  el.addEventListener('pointermove', function(e){ if (dragging) setFromY(e.clientY); });
  el.addEventListener('pointerup', function(e){
    dragging = false;
    try { el.releasePointerCapture(e.pointerId); } catch(err){}
    saveState();
  });
  track.addEventListener('pointerdown', function(e){
    if (e.target === el) return;
    setFromY(e.clientY);
    saveState();
  });
}

/* Faders */
['A','B'].forEach(function(id){
  var th = document.getElementById('fader' + id);
  if (!th) return;
  var deck = id === 'A' ? deckA : deckB;
  bindVertical(th, function(v){
    deck.volume = v;
    deck.setVolume(v);
  });
  deck.setVolume(deck.volume);
});

/* Pitch sliders */
['A','B'].forEach(function(id){
  var track = document.getElementById('pitchSlider' + id);
  var thumb = document.getElementById('pitchThumb' + id);
  if (!track || !thumb) return;
  var deck = id === 'A' ? deckA : deckB;
  var dragging = false;
  function setFromY(cy){
    var r = track.getBoundingClientRect();
    var t = clamp((cy - r.top) / r.height, 0, 1);
    thumb.style.top = (t * 100) + '%';
    deck.setPitch((0.5 - t) * 16);
    STATE.pitches[id] = deck.pitch;
  }
  thumb.addEventListener('pointerdown', function(e){
    dragging = true;
    try { thumb.setPointerCapture(e.pointerId); } catch(err){}
    e.preventDefault(); e.stopPropagation();
  });
  thumb.addEventListener('pointermove', function(e){ if (dragging) setFromY(e.clientY); });
  thumb.addEventListener('pointerup', function(e){
    dragging = false;
    try { thumb.releasePointerCapture(e.pointerId); } catch(err){}
    saveState();
  });
  track.addEventListener('pointerdown', function(e){
    if (e.target === thumb) return;
    setFromY(e.clientY);
    saveState();
  });
});

/* Crossfader */
(function(){
  var track = document.getElementById('crossTrack');
  var thumb = document.getElementById('crossThumb');
  if (!track || !thumb) return;
  var dragging = false;
  function setFromX(cx){
    var r = track.getBoundingClientRect();
    var t = clamp((cx - r.left) / r.width, 0, 1);
    thumb.style.left = (t * 100) + '%';
    STATE.crossfader = (t * 2 - 1) * 100;
    applyCrossfader();
  }
  thumb.addEventListener('pointerdown', function(e){
    dragging = true;
    try { thumb.setPointerCapture(e.pointerId); } catch(err){}
    e.preventDefault(); e.stopPropagation();
  });
  thumb.addEventListener('pointermove', function(e){ if (dragging) setFromX(e.clientX); });
  thumb.addEventListener('pointerup', function(e){
    dragging = false;
    try { thumb.releasePointerCapture(e.pointerId); } catch(err){}
    saveState();
  });
  track.addEventListener('pointerdown', function(e){
    if (e.target === thumb) return;
    setFromX(e.clientX);
    saveState();
  });
  var t0 = (STATE.crossfader + 100) / 200;
  thumb.style.left = (t0 * 100) + '%';
  applyCrossfader();
})();

/* Mixer knobs */
$$('.knob[data-knob]').forEach(function(kn){
  var key = kn.getAttribute('data-knob');
  var parts = key.split('-');
  var band = parts[0];
  var deckId = parts[1];
  var deck = deckId === 'A' ? deckA : deckB;
  bindKnob(kn, key, function(val){
    if (band === 'gain'){
      var dB = (val - 0.5) * 24;
      // map to linear gain
      var lin = Math.pow(10, dB / 20);
      // simple: use gain to volume
      var side = (100 - STATE.crossfader) / 200;
      if (deckId === 'B') side = (100 + STATE.crossfader) / 200;
      deck.gainNode.gain.value = lin * deck.volume * side * 1.2;
      var el = document.getElementById('gainVal' + deckId);
      if (el) el.textContent = (dB >= 0 ? '+' : '') + dB.toFixed(1) + 'dB';
    } else if (band === 'high') deck.setEQ('high', val);
    else if (band === 'mid') deck.setEQ('mid', val);
    else if (band === 'low') deck.setEQ('low', val);
  }, 0.5);
});

/* Waveform click seek */
['A','B'].forEach(function(id){
  var w = document.getElementById('waveWrap' + id);
  if (!w) return;
  var deck = id === 'A' ? deckA : deckB;
  w.addEventListener('click', function(e){
    if (!deck.buffer) return;
    var r = w.getBoundingClientRect();
    var t = clamp((e.clientX - r.left) / r.width, 0, 1);
    deck.seek(t * deck.duration);
  });
});

/* =========================================================
   KEYBOARD
   ========================================================= */
document.addEventListener('keydown', function(e){
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
  var k = e.key;
  var deck = STATE.lastActiveDeck === 'A' ? deckA : deckB;
  if (k === ' '){ e.preventDefault(); deck.toggle(); return; }
  if (k === 'a' || k === 'A'){ STATE.lastActiveDeck = 'A'; toast('Deck A aktif','ok'); return; }
  if (k === 'b' || k === 'B'){ STATE.lastActiveDeck = 'B'; toast('Deck B aktif','ok'); return; }
  if (k === 'c' || k === 'C'){ deck.cue(); return; }
  if (k === 's' || k === 'S'){
    var other = deck.id === 'A' ? deckB : deckA;
    if (deck.buffer && other.buffer) deck.syncTo(other);
    return;
  }
  if (k >= '1' && k <= '8'){ deck.setHotCue(parseInt(k, 10) - 1); return; }
  if (k === 'ArrowUp'){ deck.setVolume(clamp(deck.volume + 0.05, 0, 1)); return; }
  if (k === 'ArrowDown'){ deck.setVolume(clamp(deck.volume - 0.05, 0, 1)); return; }
  if (k === 'ArrowLeft'){
    STATE.crossfader = clamp(STATE.crossfader - 5, -100, 100);
    document.getElementById('crossThumb').style.left = ((STATE.crossfader + 100) / 2) + '%';
    applyCrossfader(); return;
  }
  if (k === 'ArrowRight'){
    STATE.crossfader = clamp(STATE.crossfader + 5, -100, 100);
    document.getElementById('crossThumb').style.left = ((STATE.crossfader + 100) / 2) + '%';
    applyCrossfader(); return;
  }
});

/* =========================================================
   INIT
   ========================================================= */
loadState();
applyMobileTab();

window.addEventListener('resize', function(){
  applyMobileTab();
  drawWave(deckA); drawWave(deckB);
});
window.addEventListener('orientationchange', function(){
  setTimeout(function(){
    applyMobileTab();
    drawWave(deckA); drawWave(deckB);
  }, 250);
});

deckA.updateUI(); deckB.updateUI();
drawWave(deckA); drawWave(deckB);

// Restore pitch
['A','B'].forEach(function(id){
  var p = STATE.pitches[id] || 0;
  var thumb = document.getElementById('pitchThumb' + id);
  var val = document.getElementById('pitchVal' + id);
  if (thumb) thumb.style.top = ((0.5 - p / 16) * 100) + '%';
  if (val) val.textContent = (p >= 0 ? '+' : '') + p.toFixed(1) + '%';
  var deck = id === 'A' ? deckA : deckB;
  deck.setPitch(p);
});

// Load initial library
refreshLibrary().then(function(){
  console.log('Library loaded:', STATE.library.tracks.length, 'tracks');
});

console.log('DJ MIXER v3.1 ready');
toast('DJ MIXER siap — tap 🎵 untuk MUSIK SAYA','ok');

// Resume audio
document.addEventListener('touchstart', function once(){
  if (ctx.state === 'suspended') ctx.resume();
  document.removeEventListener('touchstart', once);
}, { once: true });
document.addEventListener('mousedown', function once(){
  if (ctx.state === 'suspended') ctx.resume();
  document.removeEventListener('mousedown', once);
}, { once: true });
</script>
</body>
</html>`;

/* =========================================================
   START SERVER
   ========================================================= */
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  DJ MIXER v3.1 — Persistent Library      ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('  Local:   http://localhost:' + PORT);
  console.log('  LAN:     http://<IP-KAMU>:' + PORT);
  console.log('');
  console.log('  yt-dlp:  ' + (HAS_YTDLP ? '✓ OK' : '✗ TIDAK ADA'));
  console.log('  ffmpeg:  ' + (HAS_FFMPEG ? '✓ OK' : '✗ TIDAK ADA'));
  console.log('  Music:   ' + DATA_DIR);
  console.log('  Tracks:  ' + DB.tracks.length);
  console.log('');
  if (!HAS_YTDLP || !HAS_FFMPEG) {
    console.log('  ⚠  Install dulu:');
    if (!HAS_YTDLP) console.log('     pip install yt-dlp');
    if (!HAS_FFMPEG) console.log('     pkg install ffmpeg');
    console.log('');
  }
  console.log('  Buka browser → tap 🎵 untuk load musik.');
  console.log('  Ctrl+C untuk stop.');
  console.log('');
});

process.on('SIGINT', () => { console.log('\nBye!'); process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });
