// index.js — Lumina Fulfillment (diagnostic build)

const express = require('express');
const morgan = require('morgan');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(morgan('dev'));

/* ====== ENV ====== */
const PORT = process.env.PORT || 3000;

// مفاتيح Supabase
const SUPABASE_URL = process.env.SUPABASE_URL || '';
// استخدم SERVICE_ROLE (مفضّل للسيرفر). إن لم يوجد، سيجرب ANON لكن قد تصدمك RLS.
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

// المصادقة البسيطة للاختبار
const AUTH_BEARER = process.env.AUTH_BEARER || 'test-secret-123';

// المستخدم الافتراضي للاختبار (لازم يطابق devices.owner)
const TEST_USER_ID = process.env.TEST_USER_ID || '';

/* ====== Supabase Client ====== */
const ACTIVE_SUPABASE_KEY = SUPABASE_SERVICE_ROLE || SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !ACTIVE_SUPABASE_KEY) {
  console.warn('⚠️ Missing SUPABASE_URL or SERVICE_ROLE/ANON key — /debug-db سيشرح التفاصيل.');
}
const supabase = (SUPABASE_URL && ACTIVE_SUPABASE_KEY)
  ? createClient(SUPABASE_URL, ACTIVE_SUPABASE_KEY, { auth: { persistSession: false } })
  : null;

/* ====== Helpers ====== */
function checkAuth(req, res) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized', hint: 'Missing Bearer token' });
    return null;
  }
  const token = auth.slice(7).trim();
  if (token !== AUTH_BEARER) {
    res.status(401).json({ error: 'Unauthorized', hint: 'Invalid Bearer token' });
    return null;
  }
  return token;
}

function getOwnerId(req) {
  // أولوية: هيدر X-User-Id إن وُجد، وإلا TEST_USER_ID من البيئة
  return (req.headers['x-user-id'] && String(req.headers['x-user-id'])) || TEST_USER_ID || null;
}

function mapToGoogleDevice(row) {
  return {
    id: row.id,
    type: 'action.devices.types.SWITCH',
    traits: ['action.devices.traits.OnOff'],
    name: { defaultNames: [row.model || 'Switch'], name: row.name || row.id, nicknames: [row.id] },
    willReportState: false,
    deviceInfo: { manufacturer: 'Lumina', model: row.model || 'switch-1' },
  };
}

/* ====== Diagnostics ====== */
app.get('/', (_req, res) => res.send('Lumina fulfillment is running!'));
app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString(), node: process.version }));
app.get('/debug-env', (req, res) => {
  res.json({
    has_SUPABASE_URL: !!SUPABASE_URL,
    has_SERVICE_ROLE: !!SUPABASE_SERVICE_ROLE,
    has_ANON_KEY: !!SUPABASE_ANON_KEY,
    ACTIVE_KEY_TYPE: SUPABASE_SERVICE_ROLE ? 'service_role' : (SUPABASE_ANON_KEY ? 'anon' : 'none'),
    AUTH_BEARER_set: !!AUTH_BEARER,
    TEST_USER_ID: TEST_USER_ID || null,
    hasAuthHeader: !!req.headers.authorization,
  });
});

// تشخيص قاعدة البيانات مع طباعة سبب الخطأ
app.get('/debug-db', async (req, res) => {
  try {
    const ownerId = req.query.owner || TEST_USER_ID || null;

    if (!SUPABASE_URL || !ACTIVE_SUPABASE_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'Missing Supabase configuration',
        details: {
          has_SUPABASE_URL: !!SUPABASE_URL,
          has_SERVICE_ROLE: !!SUPABASE_SERVICE_ROLE,
          has_ANON_KEY: !!SUPABASE_ANON_KEY,
        },
      });
    }
    if (!ownerId) {
      return res.status(400).json({
        ok: false,
        error: 'Missing owner',
        details: 'Set TEST_USER_ID env or pass ?owner=<uuid>',
      });
    }

    // Ping بسيط
    const { error: pingErr } = await supabase.from('devices').select('id').limit(1);
    if (pingErr) {
      return res.status(500).json({
        ok: false,
        error: 'Ping select failed',
        details: pingErr.message || pingErr,
      });
    }

    // الاستعلام الفعلي
    const { data, error, status } = await supabase
      .from('devices')
      .select('id, owner, name, model, created_at')
      .eq('owner', ownerId)
      .limit(50);

    if (error) {
      return res.status(500).json({
        ok: false,
        error: 'Query failed',
        status,
        details: error.message || error,
      });
    }

    return res.json({ ok: true, owner: ownerId, count: (data || []).length, sample: data || [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ====== Google Smart Home ====== */
app.post('/smarthome', async (req, res) => {
  const started = Date.now();
  try {
    if (!checkAuth(req, res)) return;

    const { requestId, inputs } = req.body || {};
    if (!requestId || !Array.isArray(inputs) || !inputs.length) {
      return res.status(400).json({ error: 'Bad request: missing requestId/inputs' });
    }

    const intent = inputs[0]?.intent;
    const ownerId = getOwnerId(req);
    if (!ownerId) {
      return res.status(400).json({
        requestId,
        payload: { errorCode: 'missingUser', debug: 'Provide X-User-Id header or set TEST_USER_ID env' },
      });
    }

    // ===== SYNC =====
    if (intent === 'action.devices.SYNC') {
      if (!supabase) {
        return res.status(500).json({
          requestId,
          payload: { errorCode: 'internalError', debug: 'Supabase client not configured' },
        });
      }

      const { data, error } = await supabase
        .from('devices')
        .select('id, owner, name, model')
        .eq('owner', ownerId);

      if (error) {
        console.error('[SYNC] DB error:', error.message || error);
        return res.status(500).json({
          requestId,
          payload: { errorCode: 'internalError', debug: error.message || String(error) },
        });
      }

      const devices = (data || []).map(mapToGoogleDevice);
      return res.json({ requestId, payload: { agentUserId: ownerId, devices } });
    }

    // ===== QUERY =====
    if (intent === 'action.devices.QUERY') {
      const asked = inputs[0]?.payload?.devices || [];
      const out = {};
      for (const d of asked) {
        // هنا ممكن تجيب الحالة من جدول device_state لو تبغى
        out[d.id] = { online: true, on: false, status: 'SUCCESS' };
      }
      return res.json({ requestId, payload: { devices: out } });
    }

    // ===== EXECUTE (اختياري: stub) =====
    if (intent === 'action.devices.EXECUTE') {
      // نفّذ أوامر on/off … (أضف MQTT لاحقًا)
      return res.json({
        requestId,
        payload: { commands: [{ ids: [], status: 'SUCCESS' }] },
      });
    }

    // Intent غير مدعوم
    return res.json({ requestId, payload: { errorCode: 'notSupported', debug: intent } });
  } catch (e) {
    console.error('SMARTHOME ERROR:', e?.message || e);
    return res.status(500).json({ error: 'internal', message: String(e?.message || e) });
  } finally {
    console.log('Handled /smarthome in', Date.now() - started, 'ms');
  }
});

/* ====== Start ====== */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Fulfillment server running on :${PORT}`);
});
