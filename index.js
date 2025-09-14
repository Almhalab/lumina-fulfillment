// index.js
const express = require('express');
const morgan = require('morgan');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(morgan('tiny'));

// ==== ENV ====
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE; // مفتاح service_role من Supabase
const AUTH_BEARER = process.env.AUTH_BEARER || 'test-secret-123'; // نفس اللي تختبر به
const TEST_USER_ID = process.env.TEST_USER_ID || null;

// Supabase client بمفتاح الخدمة (يتجاوز RLS)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false },
});

// ==== Helpers ====
function requireBearer(req, res) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (!token || token !== AUTH_BEARER) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return token;
}

async function getUserDevices(ownerId) {
  const { data, error } = await supabase
    .from('devices')
    .select('id, owner, name, model')
    .eq('owner', ownerId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

function mapToGoogleDevice(row) {
  // تبسيط: كل الموديلات تعتبر SWITCH بميزة OnOff
  return {
    id: row.id,
    type: 'action.devices.types.SWITCH',
    traits: ['action.devices.traits.OnOff'],
    name: { name: row.name || row.id },
    willReportState: false,
    deviceInfo: {
      manufacturer: 'Lumina',
      model: row.model || 'switch',
    },
  };
}

async function getStatesFor(ids) {
  // لو عندك جدول device_state استخدمه، هنا افتراضي on=false
  const result = {};
  for (const id of ids) {
    result[id] = {
      online: true,
      on: false,
      status: 'SUCCESS',
    };
  }
  return result;
}

// ==== Smart Home Fulfillment ====
app.post('/smarthome', async (req, res) => {
  if (!requireBearer(req, res)) return;

  try {
    const requestId = req.body?.requestId || `${Date.now()}`;
    const inputs = Array.isArray(req.body?.inputs) ? req.body.inputs : [];

    if (!inputs.length) {
      return res.json({ requestId, payload: { errorCode: 'protocolError' } });
    }

    // نختار المستخدم من الهيدر X-User-Id إن وُجد، وإلا TEST_USER_ID للاختبار
    const owner = req.headers['x-user-id'] || TEST_USER_ID;
    if (!owner) {
      return res.status(400).json({
        requestId,
        payload: { errorCode: 'missingUser', debug: 'Provide X-User-Id header or set TEST_USER_ID env' },
      });
    }

    const intent = inputs[0].intent;

    // SYNC
    if (intent === 'action.devices.SYNC') {
      const rows = await getUserDevices(owner);
      const devices = rows.map(mapToGoogleDevice);

      return res.json({
        requestId,
        payload: {
          agentUserId: owner,
          devices,
        },
      });
    }

    // QUERY
    if (intent === 'action.devices.QUERY') {
      const ids = (inputs[0].payload?.devices || []).map(d => d.id);
      const states = await getStatesFor(ids);
      return res.json({ requestId, payload: { devices: states } });
    }

    // EXECUTE (اختياري – نخليه يرد نجاح فوري)
    if (intent === 'action.devices.EXECUTE') {
      return res.json({
        requestId,
        payload: { commands: [{ ids: [], status: 'SUCCESS' }] },
      });
    }

    return res.json({ requestId, payload: { errorCode: 'notSupported' } });
  } catch (e) {
    console.error('Fulfillment error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// ==== Diagnostics ====
app.get('/', (_req, res) => res.send('OK'));
app.get('/health', (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString(), node: process.version })
);
app.get('/debug-env', (req, res) => {
  res.json({
    has_SUPABASE_URL: !!SUPABASE_URL,
    has_SUPABASE_SERVICE_ROLE: !!SUPABASE_SERVICE_ROLE,
    AUTH_BEARER: AUTH_BEARER ? 'set' : 'missing',
    TEST_USER_ID,
    hasAuthHeader: !!req.headers.authorization,
  });
});
app.get('/debug-db', async (_req, res) => {
  try {
    const uid = TEST_USER_ID;
    const { data, error } = await supabase
      .from('devices')
      .select('id, owner, name, model')
      .eq('owner', uid)
      .limit(20);
    if (error) throw error;
    res.json({ ok: true, owner: uid, count: data.length, sample: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Fulfillment server running on :${PORT}`);
});
