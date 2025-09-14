// index.js — Lumina Fulfillment + Supabase + MQTT + Google Smart Home
import express from 'express';
import morgan from 'morgan';
import bodyParser from 'body-parser';
import { createClient } from '@supabase/supabase-js';
import mqtt from 'mqtt';

/* ========= ENV ========= */
const {
  PORT = 3000,

  AUTH_BEARER = 'test-secret-123',
  TEST_USER_ID, // يربط المستخدم الحالي في تطبيقك

  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,

  MQTT_URL,
  MQTT_USER,
  MQTT_PASS,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('❌ Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
const app = express();
app.use(morgan('tiny'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true })); // مطلوب لـ /token

/* ========= Google models/traits ========= */
const MODEL_MAP = {
  'switch-1': {
    type: 'action.devices.types.SWITCH',
    traits: ['action.devices.traits.OnOff'],
  },
};
function modelToTraits(model) {
  return MODEL_MAP[model] || {
    type: 'action.devices.types.SWITCH',
    traits: ['action.devices.traits.OnOff'],
  };
}

/* ========= MQTT Client ========= */
let mqttClient = null;
if (MQTT_URL) {
  mqttClient = mqtt.connect(MQTT_URL, {
    username: MQTT_USER,
    password: MQTT_PASS,
  });

  mqttClient.on('connect', () => {
    console.log('[MQTT] connected');
    mqttClient.subscribe('lumina/+/state');
  });

  mqttClient.on('message', async (topic, payloadBuf) => {
    const msg = payloadBuf.toString();
    const m = /^lumina\/([^/]+)\/state$/.exec(topic);
    if (!m) return;
    const deviceId = m[1];
    let on = null;
    try {
      const j = JSON.parse(msg);
      if (typeof j?.power === 'boolean') on = j.power;
    } catch {
      const v = msg.toLowerCase();
      if (v === 'on') on = true;
      if (v === 'off') on = false;
    }
    if (on === null) return;
    await supabase.from('device_state').upsert(
      { device_id: deviceId, on, online: true, updated_at: new Date().toISOString() },
      { onConflict: 'device_id' }
    );
  });
}

function publishMqtt(topic, message) {
  return new Promise((resolve, reject) => {
    if (!mqttClient || !mqttClient.connected) return reject(new Error('MQTT not connected'));
    mqttClient.publish(topic, message, {}, (err) => (err ? reject(err) : resolve(true)));
  });
}

/* ========= Helpers ========= */
function requireBearer(req, res, next) {
  const got = (req.headers.authorization || '').trim();
  if (!got || got !== `Bearer ${AUTH_BEARER}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

async function fetchUserDevices(owner) {
  const { data, error } = await supabase
    .from('devices')
    .select('id, name, model')
    .eq('owner', owner);
  if (error) throw error;
  return data || [];
}

async function fetchDevicesState(ids) {
  if (!ids.length) return {};
  const { data, error } = await supabase
    .from('device_state')
    .select('device_id, on, online')
    .in('device_id', ids);
  if (error) throw error;
  const map = {};
  for (const row of data || []) {
    map[row.device_id] = { online: !!row.online, on: !!row.on, status: 'SUCCESS' };
  }
  return map;
}

async function upsertDeviceState(id, on) {
  await supabase.from('device_state').upsert(
    { device_id: id, on: !!on, online: true, updated_at: new Date().toISOString() },
    { onConflict: 'device_id' }
  );
}

/* ========= Diagnostics ========= */
app.get('/', (_req, res) => res.send('Lumina Fulfillment – OK'));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/debug-env', (_req, res) =>
  res.json({
    TEST_USER_ID,
    has_SUPABASE_URL: !!SUPABASE_URL,
    mqtt_connected: !!(mqttClient && mqttClient.connected),
  })
);
app.get('/debug-db', requireBearer, async (_req, res) => {
  const owner = TEST_USER_ID;
  const { data, error } = await supabase.from('devices').select('id, name, model').eq('owner', owner);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, count: data.length, sample: data });
});

/* ========= OAuth-lite ========= */
// /authorize → Google/Alexa/تطبيقك يطلب Code
app.get('/authorize', (req, res) => {
  const { redirect_uri, state } = req.query;
  if (!redirect_uri) return res.status(400).send('missing redirect_uri');
  const payload = { uid: TEST_USER_ID, ts: Date.now() };
  const code = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const location = `${redirect_uri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state || '')}`;
  res.redirect(location);
});

// /token → يستبدل Code بـ access_token
app.post('/token', (req, res) => {
  const { code, grant_type } = req.body;
  if (grant_type !== 'authorization_code' || !code) return res.status(400).json({ error: 'invalid_request' });
  try {
    const { uid } = JSON.parse(Buffer.from(code, 'base64url').toString());
    const access_token = Buffer.from(`access:${uid}`).toString('base64url');
    res.json({ token_type: 'bearer', access_token, refresh_token: 'dummy', expires_in: 3600 });
  } catch {
    res.status(400).json({ error: 'invalid_grant' });
  }
});

/* ========= Google Smart Home Fulfillment ========= */
app.post('/smarthome', requireBearer, async (req, res) => {
  const requestId = req.body?.requestId || `${Date.now()}`;
  const input = req.body?.inputs?.[0] || {};
  const intent = input.intent;
  const owner = TEST_USER_ID;

  if (intent === 'action.devices.SYNC') {
    const rows = await fetchUserDevices(owner);
    const devices = rows.map((r) => {
      const meta = modelToTraits(r.model);
      return {
        id: r.id,
        type: meta.type,
        traits: meta.traits,
        name: { defaultNames: [r.model], name: r.name || r.id, nicknames: [r.name || r.id] },
        willReportState: false,
        deviceInfo: { manufacturer: 'Lumina', model: r.model || 'switch-1' },
      };
    });
    return res.json({ requestId, payload: { agentUserId: owner, devices } });
  }

  if (intent === 'action.devices.QUERY') {
    const ids = (input.payload?.devices || []).map((d) => d.id);
    const states = await fetchDevicesState(ids);
    return res.json({ requestId, payload: { devices: states } });
  }

  if (intent === 'action.devices.EXECUTE') {
    const results = [];
    for (const group of input.payload?.commands || []) {
      const ids = (group.devices || []).map((d) => d.id);
      const exOnOff = (group.execution || []).find((e) => e.command === 'action.devices.commands.OnOff');
      if (!exOnOff) continue;
      const desiredOn = !!exOnOff.params?.on;
      for (const id of ids) {
        if (mqttClient && mqttClient.connected) {
          await publishMqtt(`lumina/${id}/cmd`, desiredOn ? 'on' : 'off');
        }
        await upsertDeviceState(id, desiredOn);
        results.push({ ids: [id], status: 'SUCCESS', states: { online: true, on: desiredOn } });
      }
    }
    return res.json({ requestId, payload: { commands: results } });
  }

  res.status(400).json({ requestId, error: 'Unsupported intent' });
});

/* ========= Start ========= */
app.listen(PORT, () => console.log(`Fulfillment server running on :${PORT}`));

// ====== OAuth (بسيط للاختبار) ======
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'secret123';

// تخزين مؤقت في الذاكرة
const authCodes = new Map();   // code -> { userId, exp }
const accessTokens = new Map();// token -> { userId, exp }

// مساعد: توليد نص عشوائي قصير
const rnd = (len = 32) => [...crypto.getRandomValues(new Uint8Array(len))]
  .map(b => ('0' + b.toString(16)).slice(-2)).join('');

// صفحة موافقة بسيطة
app.get('/authorize', (req, res) => {
  const { client_id, redirect_uri, response_type, state } = req.query;

  if (client_id !== OAUTH_CLIENT_ID || response_type !== 'code' || !redirect_uri) {
    return res.status(400).send('invalid authorize request');
  }

  // المستخدم الحقيقي عندك معروف (مسجّل في التطبيق) — حالياً نستعمل TEST_USER_ID
  const userId = TEST_USER_ID;
  const code = rnd(16);
  const exp = Date.now() + 5 * 60 * 1000; // 5 دقائق

  authCodes.set(code, { userId, exp });

  // صفحة HTML خفيفة مع زر "ربط"
  res.type('html').send(`
<!doctype html><meta charset="utf-8">
<title>ربط حساب Lumina</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;margin:40px}</style>
<h3>ربط حساب Lumina مع Google Home</h3>
<p>سيتم ربط الحساب للمستخدم: <code>${userId}</code></p>
<form method="GET" action="${redirect_uri}">
  <input type="hidden" name="code" value="${code}">
  <input type="hidden" name="state" value="${state || ''}">
  <button type="submit" style="padding:10px 16px;border-radius:8px;background:#111;color:#fff;border:none">
    ربط
  </button>
</form>
  `);
});

// تبادل code -> token
app.post('/token', express.urlencoded({ extended: false }), (req, res) => {
  const { grant_type, code, client_id, redirect_uri } = req.body || {};

  if (client_id !== OAUTH_CLIENT_ID) {
    return res.status(400).json({ error: 'invalid_client' });
  }
  if (grant_type !== 'authorization_code' || !code) {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }

  const saved = authCodes.get(code);
  if (!saved || saved.exp < Date.now()) {
    return res.status(400).json({ error: 'invalid_grant' });
  }
  authCodes.delete(code);

  const token = rnd(24);
  const exp = Date.now() + 3600 * 1000; // 1 ساعة
  accessTokens.set(token, { userId: saved.userId, exp });

  return res.json({
    access_token: token,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: rnd(24) // اختياري
  });
});

// تعديل بسيط على فحص الـ Bearer: قبول توكنات Google أيضاً
function requireBearer(req, res, next) {
  const got = (req.headers.authorization || '').trim();
  const goodTest = got === `Bearer ${AUTH_BEARER}`;

  let goodGoogle = false;
  if (got.startsWith('Bearer ')) {
    const t = got.slice(7);
    const rec = accessTokens.get(t);
    if (rec && rec.exp > Date.now()) goodGoogle = true;
  }

  if (!goodTest && !goodGoogle) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

