// index.js — Lumina + Google Smart Home + Supabase + MQTT + App-driven linking

import express from 'express';
import morgan from 'morgan';
import bodyParser from 'body-parser';
import { createClient } from '@supabase/supabase-js';
import mqtt from 'mqtt';
import crypto from 'crypto';

const {
  PORT = 3000,
  // للطلبات اليدوية فقط
  AUTH_BEARER = 'test-secret-123',
  TEST_USER_ID, // للDevelopment فقط

  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,

  MQTT_URL,
  MQTT_USER,
  MQTT_PASS,

  // يجب أن يطابق ما في Google Home Console
  GOOGLE_CLIENT_ID = 'secret123',
  GOOGLE_CLIENT_SECRET = 'secret-not-used',
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('❌ Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

const app = express();
app.use(morgan('tiny'));
app.use(bodyParser.json());

/* ---------------- Google models/traits ---------------- */
const MODEL_MAP = {
  'switch-1': {
    type: 'action.devices.types.SWITCH',
    traits: ['action.devices.traits.OnOff'],
  },
};
const modelToTraits = (model) =>
  MODEL_MAP[model] || { type: 'action.devices.types.SWITCH', traits: ['action.devices.traits.OnOff'] };

/* ---------------- MQTT ---------------- */
let mqttClient = null;
if (MQTT_URL) {
  mqttClient = mqtt.connect(MQTT_URL, {
    username: MQTT_USER,
    password: MQTT_PASS,
    reconnectPeriod: 3000,
    connectTimeout: 15000,
  });
  mqttClient.on('connect', () => {
    console.log('[MQTT] connected');
    mqttClient.subscribe('lumina/+/state', (e) => e && console.error('[MQTT] sub error:', e.message));
  });
  mqttClient.on('message', async (topic, buf) => {
    try {
      const m = /^lumina\/([^/]+)\/state$/.exec(topic);
      if (!m) return;
      const id = m[1];
      const s = buf.toString().trim();
      let on = null;
      try { const j = JSON.parse(s); if (typeof j?.power === 'boolean') on = j.power; }
      catch { const v = s.toLowerCase(); if (v==='on') on=true; else if (v==='off') on=false; }
      if (on === null) return;
      await supabase.from('device_state').upsert(
        { device_id: id, on, online: true, updated_at: new Date().toISOString() },
        { onConflict: 'device_id' }
      );
    } catch (e) { console.error('[MQTT] handle error:', e?.message||e); }
  });
} else {
  console.warn('⚠️ MQTT_URL not set — EXECUTE سيحدّث القاعدة فقط.');
}
const publishMqtt = (topic, msg) => new Promise((res, rej) => {
  if (!mqttClient || !mqttClient.connected) return rej(new Error('MQTT not connected'));
  mqttClient.publish(topic, msg, { qos: 0 }, (e)=> e?rej(e):res(true));
});

/* ---------------- Helpers ---------------- */
const requireBearer = (req, res, next) => {
  const got = (req.headers.authorization || '').trim();
  if (!got) return res.status(401).json({ ok:false, error:'Unauthorized' });
  next();
};
const fetchUserDevices = async (owner) => {
  const { data, error } = await supabase.from('devices')
    .select('id, name, model').eq('owner', owner).order('created_at', { ascending: true });
  if (error) throw error;
  return data||[];
};
const fetchDevicesState = async (ids) => {
  if (!ids.length) return {};
  const { data, error } = await supabase.from('device_state')
    .select('device_id, on, online').in('device_id', ids);
  if (error) throw error;
  const m = {};
  for (const r of data||[]) m[r.device_id] = { online: !!r.online, on: !!r.on, status: 'SUCCESS' };
  return m;
};
const upsertDeviceState = async (id, on) => {
  const { error } = await supabase.from('device_state').upsert(
    { device_id: id, on: !!on, online: true, updated_at: new Date().toISOString() },
    { onConflict: 'device_id' }
  );
  if (error) throw error;
};

/* ---------------- In-Memory stores (demo) ---------------- */
// code -> { owner, exp }
const codeStore = new Map();
// access_token -> owner
const tokenStore = new Map();
const makeRandom = (p='') => p + crypto.randomBytes(16).toString('hex');

/* ---------------- Diagnostics ---------------- */
app.get('/', (_req, res) => res.type('text').send('Lumina Fulfillment – OK'));
app.get('/health', (_req, res) => res.json({ ok:true, time: new Date().toISOString() }));
app.get('/debug-env', (_req, res) => {
  res.json({
    AUTH_BEARER_SET: !!AUTH_BEARER,
    TEST_USER_ID,
    has_SUPABASE_URL: !!SUPABASE_URL,
    has_SUPABASE_SERVICE_ROLE: !!SUPABASE_SERVICE_ROLE,
    has_MQTT_URL: !!MQTT_URL,
    mqtt_connected: !!(mqttClient && mqttClient.connected),
  });
});
app.get('/debug-db', (req, res) => res.status(401).json({ok:false, error:'protect this with bearer in production'}));

/* =========================================================
   1) /authorize  — ربط من داخل التطبيق:
      - التطبيق يفتح هذا المسار ومعه app_token (توكن جلسة Supabase)
      - نتحقق من التوكن ونستخرج owner
      - ننشئ code مؤقت ونرجّع إلى redirect_uri
   ========================================================= */
app.get('/authorize', async (req, res) => {
  try {
    const { client_id, redirect_uri, response_type, state, app_token } = req.query;

    if (client_id !== GOOGLE_CLIENT_ID) return res.status(400).send('invalid client_id');
    if (response_type !== 'code') return res.status(400).send('invalid response_type');
    if (!redirect_uri) return res.status(400).send('missing redirect_uri');
    if (!app_token) return res.status(400).send('missing app_token');

    // تحقق من توكن Supabase لجلب user_id
    const { data, error } = await supabase.auth.getUser(app_token);
    if (error || !data?.user?.id) return res.status(401).send('invalid app_token');

    const owner = data.user.id;
    const code = makeRandom('cd_');
    codeStore.set(code, { owner, exp: Date.now() + 5 * 60 * 1000 }); // 5 دقائق

    const url = new URL(redirect_uri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);

    // رجوع إلى Google Home
    return res.redirect(url.toString());
  } catch (e) {
    console.error('/authorize error:', e);
    return res.status(500).send('internal error');
  }
});

/* =========================================================
   2) /token  — تبادل code بـ access_token
   ========================================================= */
app.post('/token', bodyParser.urlencoded({ extended: false }), (req, res) => {
  try {
    const { grant_type, code, client_id /*, client_secret*/ } = req.body;
    if (grant_type !== 'authorization_code') return res.status(400).json({ error: 'unsupported_grant_type' });
    if (client_id !== GOOGLE_CLIENT_ID) return res.status(400).json({ error: 'invalid_client' });
    const rec = codeStore.get(code);
    if (!rec || rec.exp < Date.now()) return res.status(400).json({ error: 'invalid_code' });

    codeStore.delete(code);
    const access = makeRandom('tk_');
    tokenStore.set(access, rec.owner);

    return res.json({
      token_type: 'bearer',
      access_token: access,
      expires_in: 3600,
    });
  } catch (e) {
    console.error('/token error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

/* =========================================================
   3) /smarthome  — يستخدم AUTH header لتحديد المالك:
      - Bearer test-secret-123  => يستخدم TEST_USER_ID (للاختبار اليدوي)
      - Bearer tk_xxx           => يبحث في tokenStore ويستخرج owner الحقيقي
   ========================================================= */
app.post('/smarthome', requireBearer, async (req, res) => {
  try {
    const requestId = req.body?.requestId || `${Date.now()}`;
    const input = (req.body?.inputs || [])[0] || {};
    const intent = input.intent;

    // استخرج المالك من Authorization
    const auth = (req.headers.authorization || '').trim();
    let owner = null;

    if (auth === `Bearer ${AUTH_BEARER}`) {
      owner = TEST_USER_ID || null;
    } else if (auth.startsWith('Bearer ')) {
      const token = auth.slice(7);
      owner = tokenStore.get(token) || null;
    }
    if (!owner) return res.status(401).json({ requestId, error: 'unauthorized' });

    if (intent === 'action.devices.SYNC') {
      const rows = await fetchUserDevices(owner);
      if (mqttClient && mqttClient.connected) {
        for (const r of rows) { try { mqttClient.subscribe(`lumina/${r.id}/state`); } catch {} }
      }
      const devices = rows.map((r) => {
        const meta = modelToTraits(r.model);
        return {
          id: r.id,
          type: meta.type,
          traits: meta.traits,
          name: { defaultNames: [r.model || 'switch'], name: r.name || r.id, nicknames: [r.name || r.id] },
          willReportState: false,
          deviceInfo: { manufacturer: 'Lumina', model: r.model || 'switch-1' },
        };
      });
      return res.json({ requestId, payload: { agentUserId: owner, devices } });
    }

    if (intent === 'action.devices.QUERY') {
      const ids = (input.payload?.devices || []).map((d) => d.id);
      const states = await fetchDevicesState(ids);
      for (const id of ids) if (!states[id]) states[id] = { online: true, on: false, status: 'SUCCESS' };
      return res.json({ requestId, payload: { devices: states } });
    }

    if (intent === 'action.devices.EXECUTE') {
      const results = [];
      for (const group of input.payload?.commands || []) {
        const ids = (group.devices || []).map((d) => d.id);
        const ex = (group.execution || []).find((e) => e.command === 'action.devices.commands.OnOff');
        if (!ex) { results.push({ ids, status:'ERROR', errorCode:'notSupported' }); continue; }
        const desiredOn = !!ex.params?.on;

        for (const id of ids) {
          try {
            if (mqttClient && mqttClient.connected) {
              await publishMqtt(`lumina/${id}/cmd`, desiredOn ? 'on':'off');
            }
            await upsertDeviceState(id, desiredOn);
            results.push({ ids:[id], status:'SUCCESS', states:{ online:true, on: desiredOn } });
          } catch (e) {
            console.error('[EXECUTE] error:', e?.message||e);
            results.push({ ids:[id], status:'ERROR', errorCode:'hardError' });
          }
        }
      }
      return res.json({ requestId, payload: { commands: results } });
    }

    return res.status(400).json({ requestId, error: 'Unsupported intent' });
  } catch (e) {
    console.error('Fulfillment error:', e);
    return res.status(500).json({ error:'internal', message:String(e?.message||e) });
  }
});

/* ---------------- Start ---------------- */
app.listen(PORT, () => console.log(`Fulfillment running on :${PORT}`));
