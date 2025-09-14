// ----- Basic server -----
const express = require('express');
const morgan = require('morgan');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(morgan('dev'));

// ----- Env -----
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_ANON_KEY;
const AUTH_BEARER = process.env.AUTH_BEARER;         // أي نص قوي (للاختبار)
const TEST_USER_ID = process.env.TEST_USER_ID;       // UUID = قيمة owner من جدول devices

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE/SUPABASE_ANON_KEY env vars');
  process.exit(1);
}

// خذ service-role للمخدم إن توفر (أفضل للسيرفر)
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

// ===== Helpers =====
function getUserIdFromRequest(req) {
  // في الإنتاج تربطه بـ OAuth. الآن للاختبار بـ Bearer + TEST_USER_ID
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token && AUTH_BEARER && token === AUTH_BEARER && TEST_USER_ID) {
    return TEST_USER_ID;
  }
  return null;
}

function mapDeviceToGoogle(d) {
  // غيّر حسب موديلاتك لو تحتاج Traits أخرى
  return {
    id: d.id,
    type: 'action.devices.types.SWITCH',
    traits: ['action.devices.traits.OnOff'],
    name: { name: d.name || d.id },
    deviceInfo: { model: d.model || 'switch-1' },
    willReportState: false,
  };
}

// ===== Test/ops endpoints =====
app.get('/', (req, res) => res.send('Lumina fulfillment alive'));
app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/debug-env', (req, res) => {
  res.json({
    hasUrl: !!SUPABASE_URL,
    hasKey: !!SUPABASE_KEY,
    hasAuthBearer: !!AUTH_BEARER,
    hasTestUser: !!TEST_USER_ID,
    node: process.version
  });
});

// ===== Google Smart Home endpoint =====
app.post('/smarthome', async (req, res) => {
  try {
    const requestId = req.body.requestId || `${Date.now()}`;
    const inputs = req.body.inputs || [];
    const intent = inputs[0]?.intent;

    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized', hint: 'Missing/invalid Bearer or TEST_USER_ID' });
    }

    // SYNC: رجع كل أجهزة المستخدم من جدول devices حيث owner = userId
    if (intent === 'action.devices.SYNC') {
      const { data: rows, error } = await supabase
        .from('devices')
        .select('*')
        .eq('owner', userId);

      if (error) throw error;

      const devices = (rows || []).map(mapDeviceToGoogle);

      return res.json({
        requestId,
        payload: {
          agentUserId: userId,
          devices
        }
      });
    }

    // QUERY: رجّع حالة الأجهزة المطلوبة (مثال مبسّط—كلها offline false و on افتراضيًا false)
    if (intent === 'action.devices.QUERY') {
      const deviceIds = inputs[0]?.payload?.devices?.map(d => d.id) || [];
      const { data: rows, error } = await supabase
        .from('devices')
        .select('id, owner')
        .in('id', deviceIds)
        .eq('owner', userId);

      if (error) throw error;

      const out = {};
      for (const d of rows || []) {
        out[d.id] = { online: true, on: false }; // غيّر حسب حالة جهازك الحقيقية إن كانت محفوظة
      }

      return res.json({ requestId, payload: { devices: out } });
    }

    // EXECUTE: نفّذ أوامر (مثال on/off فقط بدون MQTT فعلي هنا)
    if (intent === 'action.devices.EXECUTE') {
      const commands = inputs[0]?.payload?.commands || [];
      // هنا يمكنك إشعال MQTT أو REST لأجهزتك ثم تحدّث device_state في DB
      const results = [];
      for (const cmd of commands) {
        for (const dev of cmd.devices || []) {
          results.push({
            ids: [dev.id],
            status: 'SUCCESS',
            states: { online: true } // أضف on:true/false إذا نفّذت on/off فعلاً
          });
        }
      }
      return res.json({ requestId, payload: { commands: results } });
    }

    // غير مدعوم
    return res.json({ requestId, payload: {} });
  } catch (err) {
    console.error('smarthome error:', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

// ----- start -----
app.listen(PORT, () => {
  console.log(`Fulfillment server running on http://localhost:${PORT}`);
});
