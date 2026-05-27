'use strict';
const express  = require('express');
const { Pool } = require('pg');
const path     = require('path');
const multer   = require('multer');
const crypto   = require('crypto');
const session  = require('express-session');
const https    = require('https');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app  = express();
const port = process.env.PORT || 3000;

// ── PostgreSQL 연결 풀 ─────────────────────────────────────────
// DB 연결 설정 (특수문자 비밀번호 대응 - URL 파싱 우회)
function buildDbConfig() {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } };
  }
  const sup    = process.env.SUPABASE_URL || '';
  const ref    = sup.replace('https://', '').replace('.supabase.co', '');
  const region = process.env.SUPABASE_REGION || 'ap-southeast-2';
  return {
    host:     `aws-1-${region}.pooler.supabase.com`,
    port:     5432,
    user:     `postgres.${ref}`,
    password: process.env.DB_PASSWORD || '',
    database: 'postgres',
    ssl:      { rejectUnauthorized: false }
  };
}
const pool = new Pool(buildDbConfig());

// ── 세션 (DB 저장 - Render 재시작 대응) ───────────────────────
const pgSession = require('connect-pg-simple')(session);
app.use(session({
  store: new pgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'tboard-2026-fallback',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 3600 * 1000 }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── 소셜 OAuth 설정 ────────────────────────────────────────────
const SERVER_URL = process.env.SERVER_URL || 'https://csm-nzg5.onrender.com';
const OAUTH = {
  google: {
    clientId:     process.env.GOOGLE_ID     || '',
    clientSecret: process.env.GOOGLE_SECRET || '',
    redirect: `${SERVER_URL}/api/auth/google/callback`,
  },
  kakao: {
    clientId: process.env.KAKAO_ID || '',
    redirect: `${SERVER_URL}/api/auth/kakao/callback`,
  },
  naver: {
    clientId:     process.env.NAVER_ID     || '',
    clientSecret: process.env.NAVER_SECRET || '',
    redirect: `${SERVER_URL}/api/auth/naver/callback`,
  },
};

// ── Cloudflare R2 ──────────────────────────────────────────────
const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID     || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  },
});
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || 'https://pub-bb4a97963e754ec4a974aad4402fb137.r2.dev';

// ── Multer ─────────────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage() });

// ── 인증 헬퍼 ─────────────────────────────────────────────────
const ENC_KEY = crypto.createHash('sha256').update('tboard-enc-key-2026').digest();

async function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key  = await new Promise((res, rej) => crypto.scrypt(pw, salt, 32, (e, k) => e ? rej(e) : res(k)));
  return `${salt}:${key.toString('hex')}`;
}
async function verifyPw(pw, stored) {
  const [salt, storedKey] = stored.split(':');
  const key = await new Promise((res, rej) => crypto.scrypt(pw, salt, 32, (e, k) => e ? rej(e) : res(k)));
  return crypto.timingSafeEqual(Buffer.from(storedKey, 'hex'), key);
}
function encryptPw(pw) {
  const iv  = crypto.randomBytes(16);
  const cip = crypto.createCipheriv('aes-256-cbc', ENC_KEY, iv);
  return iv.toString('hex') + ':' + Buffer.concat([cip.update(pw, 'utf8'), cip.final()]).toString('hex');
}
function decryptPw(enc) {
  try {
    const [ivH, encH] = enc.split(':');
    const dec = crypto.createDecipheriv('aes-256-cbc', ENC_KEY, Buffer.from(ivH, 'hex'));
    return Buffer.concat([dec.update(Buffer.from(encH, 'hex')), dec.final()]).toString('utf8');
  } catch { return null; }
}

// PG 결과 컬럼명 → 대문자 (프론트엔드 호환)
function toUpper(rows) {
  return rows.map(row => {
    const r = {};
    for (const [k, v] of Object.entries(row)) r[k.toUpperCase()] = v;
    return r;
  });
}

// 이미지 업로드 (R2)
async function uploadToR2(file) {
  const fname = crypto.randomBytes(8).toString('hex') + path.extname(file.originalname);
  await r2.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: fname,
    Body: file.buffer,
    ContentType: file.mimetype,
  }));
  return `${R2_PUBLIC_URL}/${fname}`;
}

// ── 유효성 검사 ───────────────────────────────────────────────
const VALID_ID   = /^[a-z0-9!@#$%^&*._\-]{6,20}$/;
const VALID_NAME = /^[가-힣a-zA-Z]{2,50}$/;
function validPw(pw) {
  if (!pw || pw.length < 10 || pw.length > 15) return false;
  return /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw) && /[!@#$%^&*()\-_=+[\]{};:,.<>?]/.test(pw);
}

// ── 역할 목록 ─────────────────────────────────────────────────
const ROLES = {
  ADMIN:   '전체관리자(ADMIN)',
  PM:      '사업총괄(PM)',
  CM:      '건설사업관리자(CM)',
  SA:      '현장행정/공무(SA)',
  RE:      '감리원(RE)',
  SE:      '현장시공기술자(SE)',
  QC:      '품질관리자(QC)',
  FM:      '작업반장(FM)',
  PENDING: '미승인',
};
const MGMT_ROLES = ['ADMIN', 'CM', 'SA'];

// ── 인증 미들웨어 ─────────────────────────────────────────────
function requireAuth(roles) {
  return (req, res, next) => {
    const u = req.session.user;
    if (!u) return req.path.startsWith('/api') ? res.status(401).json({ error: '로그인 필요' }) : res.redirect('/login');
    if (u.status !== 'ACTIVE') return req.path.startsWith('/api') ? res.status(403).json({ error: '승인 대기 중' }) : res.redirect('/login?pending=1');
    if (roles && !roles.includes(u.role)) return res.status(403).json({ error: '권한 없음' });
    next();
  };
}

// ── DB 초기화 (Supabase 테이블은 이미 생성됨, 시드만) ─────────
async function initDb() {
  try {
    const r = await pool.query('SELECT COUNT(*) FROM tboard_users WHERE user_id=$1', ['dragom76']);
    if (parseInt(r.rows[0].count) === 0) {
      const pw = 'Dragom76!!';
      await pool.query(
        `INSERT INTO tboard_users(user_id,user_pw,user_pw_enc,user_name,role,status)
         VALUES($1,$2,$3,'관리자','ADMIN','ACTIVE')`,
        ['dragom76', await hashPw(pw), encryptPw(pw)]
      );
      console.log('[DB] ADMIN 계정 생성 (dragom76)');
    }
    const dp = await pool.query('SELECT COUNT(*) FROM projects');
    if (parseInt(dp.rows[0].count) === 0) {
      await pool.query(
        `INSERT INTO projects(project_name,project_code,description,created_by)
         VALUES('기본 프로젝트','DEFAULT','최초 기본 프로젝트','dragom76')`
      );
      console.log('[DB] 기본 프로젝트 생성');
    }
  } catch(e) { console.error('[DB] initDb 오류:', e.message); }
}

// ── OAuth 공통 함수 ───────────────────────────────────────────
function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req  = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': data.length, ...headers },
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
    }).on('error', reject);
  });
}

function socialResultHtml(data) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f7fafc;}
.box{text-align:center;padding:32px;background:#fff;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.1);}
.ok{color:#22c55e;font-size:2rem;}.err{color:#ef4444;font-size:2rem;}</style></head>
<body><div class="box">
${data.success ? '<div class="ok">✓</div><p>인증 완료</p>' : `<div class="err">✕</div><p>${data.error || '인증 실패'}</p>`}
<p style="font-size:.8rem;color:#9ca3af">이 창은 자동으로 닫힙니다</p>
</div>
<script>
try { if(window.opener) window.opener.postMessage(${JSON.stringify(data)}, location.origin); }
catch(e){}
setTimeout(()=>window.close(), 1200);
</script></body></html>`;
}

// ════════════════════════════════════════════════════════════
//  페이지 라우트
// ════════════════════════════════════════════════════════════
app.get('/logo.svg', (req, res) => res.sendFile(path.join(__dirname, 'logo.svg')));
app.get('/logo.png', (req, res) => res.sendFile(path.join(__dirname, 'logo.png')));
app.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'login.html'));
});
app.get('/', requireAuth(), (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ════════════════════════════════════════════════════════════
//  인증 API
// ════════════════════════════════════════════════════════════
app.get('/api/auth/me', (req, res) => {
  if (!req.session.user) return res.status(401).json(null);
  res.json(req.session.user);
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// 회원가입
app.post('/api/auth/register', async (req, res) => {
  const { userId, userPw, userName, socialProvider, socialKey } = req.body;
  if (!VALID_ID.test(userId))      return res.status(400).json({ error: 'ID: 영어소문자·숫자·특수문자 6~20자' });
  if (!validPw(userPw))            return res.status(400).json({ error: 'PW: 대/소문자·숫자·특수문자 포함 10~15자' });
  if (!VALID_NAME.test(userName))  return res.status(400).json({ error: '이름: 한글 또는 영문만 2~50자' });
  try {
    const dup = await pool.query('SELECT COUNT(*) FROM tboard_users WHERE user_id=$1', [userId]);
    if (parseInt(dup.rows[0].count) > 0) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
    await pool.query(
      `INSERT INTO tboard_users(user_id,user_pw,user_pw_enc,user_name,social_provider,social_key)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [userId, await hashPw(userPw), encryptPw(userPw), userName,
       socialProvider || null, socialKey || null]
    );
    res.json({ success: true });
  } catch(e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

// 로그인
app.post('/api/auth/login', async (req, res) => {
  const { userId, userPw } = req.body;
  if (!userId || !userPw) return res.status(400).json({ error: 'ID와 비밀번호를 입력하세요.' });
  try {
    const r = await pool.query(
      'SELECT user_id,user_pw,user_name,role,status FROM tboard_users WHERE user_id=$1',
      [userId]
    );
    if (!r.rows.length) return res.status(401).json({ error: '아이디 또는 비밀번호가 틀렸습니다.' });
    const u = r.rows[0];
    if (!(await verifyPw(userPw, u.user_pw))) return res.status(401).json({ error: '아이디 또는 비밀번호가 틀렸습니다.' });
    if (u.status === 'PENDING')  return res.status(403).json({ error: '관리자 승인 대기 중입니다.', pending: true });
    if (u.status === 'INACTIVE') return res.status(403).json({ error: '비활성화된 계정입니다.' });
    req.session.user = { id: u.user_id, name: u.user_name, role: u.role, status: u.status };
    res.json({ success: true, user: req.session.user });
  } catch(e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

// ── Google OAuth ──────────────────────────────────────────────
app.get('/api/auth/google/start', (req, res) => {
  if (!OAUTH.google.clientId) return res.send(socialResultHtml({ success: false, error: 'Google OAuth 미설정' }));
  const mode = req.query.mode || 'verify';
  req.session.oauthMode = mode;
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', OAUTH.google.clientId);
  url.searchParams.set('redirect_uri', OAUTH.google.redirect);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', mode);
  res.redirect(url.toString());
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  const mode = state || req.session.oauthMode || 'verify';
  try {
    const params = new URLSearchParams({
      code, client_id: OAUTH.google.clientId, client_secret: OAUTH.google.clientSecret,
      redirect_uri: OAUTH.google.redirect, grant_type: 'authorization_code',
    });
    const token    = await httpsPost('https://oauth2.googleapis.com/token', params.toString());
    const userInfo = await httpsGet('https://www.googleapis.com/oauth2/v2/userinfo',
      { Authorization: `Bearer ${token.access_token}` });
    if (mode === 'verify') return res.send(socialResultHtml({ success: true, type: 'socialVerified', provider: 'google', key: userInfo.id, name: userInfo.name, email: userInfo.email }));
    const r = await pool.query(
      `SELECT user_id,user_name,role,status FROM tboard_users WHERE social_provider='google' AND social_key=$1`,
      [userInfo.id]
    );
    if (!r.rows.length) return res.send(socialResultHtml({ success: false, error: '가입되지 않은 계정입니다.' }));
    const u = r.rows[0];
    if (u.status === 'PENDING')  return res.send(socialResultHtml({ success: false, error: '관리자 승인 대기 중입니다.' }));
    if (u.status === 'INACTIVE') return res.send(socialResultHtml({ success: false, error: '비활성화된 계정입니다.' }));
    req.session.user = { id: u.user_id, name: u.user_name, role: u.role, status: u.status };
    res.send(socialResultHtml({ success: true, type: 'socialLogin' }));
  } catch(e) { console.error('Google OAuth error:', e.message); res.send(socialResultHtml({ success: false, error: '인증 처리 중 오류 발생' })); }
});

// ── Kakao OAuth ───────────────────────────────────────────────
app.get('/api/auth/kakao/start', (req, res) => {
  if (!OAUTH.kakao.clientId) return res.send(socialResultHtml({ success: false, error: 'Kakao OAuth 미설정' }));
  req.session.oauthMode = req.query.mode || 'verify';
  const url = new URL('https://kauth.kakao.com/oauth/authorize');
  url.searchParams.set('client_id', OAUTH.kakao.clientId);
  url.searchParams.set('redirect_uri', OAUTH.kakao.redirect);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', req.session.oauthMode);
  res.redirect(url.toString());
});

app.get('/api/auth/kakao/callback', async (req, res) => {
  const { code, state } = req.query;
  const mode = state || req.session.oauthMode || 'verify';
  try {
    const params = new URLSearchParams({ code, grant_type: 'authorization_code', client_id: OAUTH.kakao.clientId, redirect_uri: OAUTH.kakao.redirect });
    const token    = await httpsPost('https://kauth.kakao.com/oauth/token', params.toString());
    const userInfo = await httpsGet('https://kapi.kakao.com/v2/user/me', { Authorization: `Bearer ${token.access_token}` });
    const kakaoId   = String(userInfo.id);
    const kakaoName = userInfo.kakao_account?.profile?.nickname || '카카오사용자';
    if (mode === 'verify') return res.send(socialResultHtml({ success: true, type: 'socialVerified', provider: 'kakao', key: kakaoId, name: kakaoName, email: userInfo.kakao_account?.email || '' }));
    const r = await pool.query(
      `SELECT user_id,user_name,role,status FROM tboard_users WHERE social_provider='kakao' AND social_key=$1`,
      [kakaoId]
    );
    if (!r.rows.length) return res.send(socialResultHtml({ success: false, error: '가입되지 않은 계정입니다.' }));
    const u = r.rows[0];
    if (u.status !== 'ACTIVE') return res.send(socialResultHtml({ success: false, error: '로그인 불가 상태입니다.' }));
    req.session.user = { id: u.user_id, name: u.user_name, role: u.role, status: u.status };
    res.send(socialResultHtml({ success: true, type: 'socialLogin' }));
  } catch(e) { res.send(socialResultHtml({ success: false, error: '카카오 인증 오류' })); }
});

// ── Naver OAuth ───────────────────────────────────────────────
app.get('/api/auth/naver/start', (req, res) => {
  if (!OAUTH.naver.clientId) return res.send(socialResultHtml({ success: false, error: 'Naver OAuth 미설정' }));
  req.session.oauthMode = req.query.mode || 'verify';
  const state = crypto.randomBytes(8).toString('hex');
  req.session.naverState = state;
  const url = new URL('https://nid.naver.com/oauth2.0/authorize');
  url.searchParams.set('client_id', OAUTH.naver.clientId);
  url.searchParams.set('redirect_uri', OAUTH.naver.redirect);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.get('/api/auth/naver/callback', async (req, res) => {
  const { code } = req.query;
  const mode = req.session.oauthMode || 'verify';
  try {
    const params = new URLSearchParams({ grant_type: 'authorization_code', client_id: OAUTH.naver.clientId, client_secret: OAUTH.naver.clientSecret, code, state: req.session.naverState || '' });
    const token    = await httpsPost('https://nid.naver.com/oauth2.0/token', params.toString());
    const userInfo = await httpsGet('https://openapi.naver.com/v1/nid/me', { Authorization: `Bearer ${token.access_token}` });
    const profile  = userInfo.response;
    const naverId  = profile.id;
    const naverName = profile.name || '네이버사용자';
    if (mode === 'verify') return res.send(socialResultHtml({ success: true, type: 'socialVerified', provider: 'naver', key: naverId, name: naverName, email: profile.email || '' }));
    const r = await pool.query(
      `SELECT user_id,user_name,role,status FROM tboard_users WHERE social_provider='naver' AND social_key=$1`,
      [naverId]
    );
    if (!r.rows.length) return res.send(socialResultHtml({ success: false, error: '가입되지 않은 계정입니다.' }));
    const u = r.rows[0];
    if (u.status !== 'ACTIVE') return res.send(socialResultHtml({ success: false, error: '로그인 불가 상태입니다.' }));
    req.session.user = { id: u.user_id, name: u.user_name, role: u.role, status: u.status };
    res.send(socialResultHtml({ success: true, type: 'socialLogin' }));
  } catch(e) { res.send(socialResultHtml({ success: false, error: '네이버 인증 오류' })); }
});

// ════════════════════════════════════════════════════════════
//  인원관리 API
// ════════════════════════════════════════════════════════════
app.get('/api/users/pending-count', requireAuth(), async (req, res) => {
  try {
    const r = await pool.query("SELECT COUNT(*) FROM tboard_users WHERE status='PENDING'");
    res.json({ count: parseInt(r.rows[0].count) });
  } catch(e) { res.json({ count: 0 }); }
});

app.get('/api/users', requireAuth(MGMT_ROLES), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT user_id,user_name,role,status,social_provider,
              TO_CHAR(created_at,'YYYY-MM-DD HH24:MI') AS created_at
       FROM tboard_users
       ORDER BY CASE status WHEN 'PENDING' THEN 0 ELSE 1 END, created_at DESC`
    );
    res.json(toUpper(r.rows));
  } catch(e) { console.error(e); res.status(500).json({ error: '조회 실패' }); }
});

app.get('/api/users/:id', requireAuth(MGMT_ROLES), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT user_id,user_name,role,status,social_provider,social_key,
              TO_CHAR(created_at,'YYYY-MM-DD HH24:MI') AS created_at
       FROM tboard_users WHERE user_id=$1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: '없음' });
    res.json(toUpper(r.rows)[0]);
  } catch(e) { res.status(500).json({ error: '조회 실패' }); }
});

app.get('/api/users/:id/pw', requireAuth(['ADMIN']), async (req, res) => {
  try {
    const r = await pool.query('SELECT user_pw_enc FROM tboard_users WHERE user_id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: '없음' });
    const plain = decryptPw(r.rows[0].user_pw_enc || '');
    res.json({ pw: plain || '(복호화 불가)' });
  } catch(e) { res.status(500).json({ error: '복호화 실패' }); }
});

app.put('/api/users/:id', requireAuth(['ADMIN']), async (req, res) => {
  const { role, status } = req.body;
  const validRoles  = Object.keys(ROLES);
  const validStatus = ['PENDING', 'ACTIVE', 'INACTIVE'];
  if (role   && !validRoles.includes(role))    return res.status(400).json({ error: '올바르지 않은 역할' });
  if (status && !validStatus.includes(status)) return res.status(400).json({ error: '올바르지 않은 상태' });
  try {
    await pool.query(
      `UPDATE tboard_users SET role=COALESCE($1,role), status=COALESCE($2,status) WHERE user_id=$3`,
      [role || null, status || null, req.params.id]
    );
    res.json({ success: true });
  } catch(e) { console.error(e); res.status(500).json({ error: '수정 실패' }); }
});

app.get('/api/roles', requireAuth(), (req, res) => res.json(ROLES));

app.get('/api/users/:id/projects', requireAuth(['ADMIN']), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.project_id, p.project_name,
              CASE WHEN pm.user_id IS NOT NULL THEN 1 ELSE 0 END AS is_member
       FROM projects p
       LEFT JOIN project_members pm ON pm.project_id = p.project_id AND pm.user_id = $1
       WHERE p.status = 'ACTIVE'
       ORDER BY p.project_name`,
      [req.params.id]
    );
    res.json(toUpper(r.rows));
  } catch(e) { console.error(e); res.status(500).json({ error: '조회 실패' }); }
});

// ════════════════════════════════════════════════════════════
//  프로젝트 API
// ════════════════════════════════════════════════════════════
app.get('/api/projects', requireAuth(), async (req, res) => {
  try {
    const isAdmin = req.session.user.role === 'ADMIN';
    let r;
    if (isAdmin) {
      r = await pool.query(
        `SELECT p.project_id, p.project_name, p.project_code, p.description, p.status,
                p.created_by, TO_CHAR(p.created_at,'YYYY-MM-DD') AS created_at,
                (SELECT COUNT(*) FROM board b WHERE b.project_id = p.project_id) AS post_count,
                (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.project_id) AS member_count
         FROM projects p WHERE p.status='ACTIVE' ORDER BY p.created_at DESC`
      );
    } else {
      r = await pool.query(
        `SELECT p.project_id, p.project_name, p.project_code, p.description, p.status,
                p.created_by, TO_CHAR(p.created_at,'YYYY-MM-DD') AS created_at,
                (SELECT COUNT(*) FROM board b WHERE b.project_id = p.project_id) AS post_count,
                (SELECT COUNT(*) FROM project_members pm2 WHERE pm2.project_id = p.project_id) AS member_count
         FROM projects p
         WHERE p.status='ACTIVE'
           AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=p.project_id AND pm.user_id=$1)
         ORDER BY p.created_at DESC`,
        [req.session.user.id]
      );
    }
    res.json(toUpper(r.rows));
  } catch(e) { console.error(e); res.status(500).json({ error: '조회 실패' }); }
});

app.post('/api/projects', requireAuth(['ADMIN']), async (req, res) => {
  const { projectName, projectCode, description } = req.body;
  if (!projectName || !projectName.trim()) return res.status(400).json({ error: '프로젝트명을 입력하세요.' });
  try {
    await pool.query(
      `INSERT INTO projects(project_name,project_code,description,created_by) VALUES($1,$2,$3,$4)`,
      [projectName.trim(), projectCode || null, description || null, req.session.user.id]
    );
    res.json({ success: true });
  } catch(e) { console.error(e); res.status(500).json({ error: '생성 실패' }); }
});

app.put('/api/projects/:id', requireAuth(['ADMIN']), async (req, res) => {
  const { projectName, description, status } = req.body;
  try {
    await pool.query(
      `UPDATE projects SET
         project_name=COALESCE($1,project_name),
         description=COALESCE($2,description),
         status=COALESCE($3,status)
       WHERE project_id=$4`,
      [projectName || null, description || null, status || null, req.params.id]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: '수정 실패' }); }
});

app.get('/api/projects/:id/members', requireAuth(MGMT_ROLES), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.user_id, u.user_name, u.role, u.status,
              TO_CHAR(pm.joined_at,'YYYY-MM-DD') AS joined_at
       FROM project_members pm
       JOIN tboard_users u ON u.user_id = pm.user_id
       WHERE pm.project_id = $1 ORDER BY pm.joined_at`,
      [req.params.id]
    );
    res.json(toUpper(r.rows));
  } catch(e) { res.status(500).json({ error: '조회 실패' }); }
});

app.post('/api/projects/:id/members', requireAuth(['ADMIN']), async (req, res) => {
  const { userId } = req.body;
  try {
    await pool.query(
      'INSERT INTO project_members(project_id,user_id) VALUES($1,$2)',
      [req.params.id, userId]
    );
    res.json({ success: true });
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: '이미 추가된 멤버' });
    res.status(500).json({ error: '추가 실패' });
  }
});

app.delete('/api/projects/:id/members/:uid', requireAuth(['ADMIN']), async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM project_members WHERE project_id=$1 AND user_id=$2',
      [req.params.id, req.params.uid]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: '삭제 실패' }); }
});

// ════════════════════════════════════════════════════════════
//  게시판 API
// ════════════════════════════════════════════════════════════
app.get('/api/board', requireAuth(), async (req, res) => {
  const pid = req.query.projectId;
  try {
    let r;
    if (pid) {
      r = await pool.query(
        `SELECT id,title,content,image_path,author_id,author_name,
                TO_CHAR(created_at,'YYYY-MM-DD HH24:MI') AS created_at
         FROM board WHERE project_id=$1 ORDER BY id DESC`,
        [pid]
      );
    } else {
      r = await pool.query(
        `SELECT id,title,content,image_path,author_id,author_name,
                TO_CHAR(created_at,'YYYY-MM-DD HH24:MI') AS created_at
         FROM board ORDER BY id DESC`
      );
    }
    res.json(toUpper(r.rows));
  } catch(e) { console.error(e); res.status(500).json({ error: 'DB 조회 실패' }); }
});

app.get('/api/board/:id', requireAuth(), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id,title,content,image_path,author_id,author_name,
              TO_CHAR(created_at,'YYYY-MM-DD HH24:MI') AS created_at
       FROM board WHERE id=$1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: '없음' });
    res.json(toUpper(r.rows)[0]);
  } catch(e) { res.status(500).json({ error: 'DB 조회 실패' }); }
});

app.post('/api/board', requireAuth(), upload.single('image'), async (req, res) => {
  const { title, content, projectId } = req.body;
  let finalImagePath = null;
  if (req.file) {
    try { finalImagePath = await uploadToR2(req.file); }
    catch(e) { console.error('R2 업로드 실패:', e); return res.status(500).json({ error: '이미지 업로드 실패' }); }
  }
  try {
    await pool.query(
      `INSERT INTO board(title,content,image_path,project_id,author_id,author_name)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [title, content, finalImagePath, projectId || 1, req.session.user.id, req.session.user.name]
    );
    res.json({ success: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'DB 등록 실패' }); }
});

app.put('/api/board/:id', requireAuth(), upload.single('image'), async (req, res) => {
  const { title, content } = req.body;
  try {
    if (req.file) {
      const imgPath = await uploadToR2(req.file);
      await pool.query(
        'UPDATE board SET title=$1,content=$2,image_path=$3 WHERE id=$4',
        [title, content, imgPath, req.params.id]
      );
    } else {
      await pool.query(
        'UPDATE board SET title=$1,content=$2 WHERE id=$3',
        [title, content, req.params.id]
      );
    }
    res.json({ success: true });
  } catch(e) { console.error(e); res.status(500).json({ error: '수정 실패' }); }
});

app.delete('/api/board/:id', requireAuth(), async (req, res) => {
  try {
    await pool.query('DELETE FROM board WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: '삭제 실패' }); }
});

// ════════════════════════════════════════════════════════════
//  댓글 API
// ════════════════════════════════════════════════════════════
app.get('/api/board/:id/comments', requireAuth(), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT comment_id, post_id, author_id, author_name, content, image_path,
              TO_CHAR(created_at,'YYYY-MM-DD HH24:MI') AS created_at
       FROM comments WHERE post_id=$1 ORDER BY comment_id ASC`,
      [req.params.id]
    );
    res.json(toUpper(r.rows));
  } catch(e) { console.error(e); res.status(500).json({ error: '조회 실패' }); }
});

app.post('/api/board/:id/comments', requireAuth(), upload.single('image'), async (req, res) => {
  const { content } = req.body;
  const u = req.session.user;
  let imagePath = null;
  if (req.file) {
    try { imagePath = await uploadToR2(req.file); }
    catch(e) { return res.status(500).json({ error: '파일 업로드 실패' }); }
  }
  try {
    await pool.query(
      `INSERT INTO comments(post_id,author_id,author_name,content,image_path)
       VALUES($1,$2,$3,$4,$5)`,
      [req.params.id, u.id, u.name, content || null, imagePath]
    );
    res.json({ success: true });
  } catch(e) { console.error(e); res.status(500).json({ error: '등록 실패' }); }
});

app.delete('/api/board/:postId/comments/:cid', requireAuth(), async (req, res) => {
  const u = req.session.user;
  try {
    const chk = await pool.query(
      'SELECT author_id FROM comments WHERE comment_id=$1 AND post_id=$2',
      [req.params.cid, req.params.postId]
    );
    if (!chk.rows.length) return res.status(404).json({ error: '없음' });
    if (u.role !== 'ADMIN' && chk.rows[0].author_id !== u.id) return res.status(403).json({ error: '권한 없음' });
    await pool.query('DELETE FROM comments WHERE comment_id=$1', [req.params.cid]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: '삭제 실패' }); }
});

// ── 서버 시작 ─────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`서버가 포트 ${port} 에서 실행 중입니다.`);
  initDb();
});
