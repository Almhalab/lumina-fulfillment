// index.js
import express from 'express';
import morgan from 'morgan';
import bodyParser from 'body-parser';
import { createClient } from '@supabase/supabase-js';

// ====== الإعدادات من المتغيرات ======
const {
  PORT = 3000,
  AUTH_BEARER = 'test-secret-123',            // مفتاح بسيط لحماية /smarthome في الاختبار
  TEST_USER_ID,                                // المعرّف التجريبي (UUID) لاختباراتك اليدوية
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,                       // Service Role Key (ليس anon)
} = process.env;

// ====== Supabase (مفتاح Service Role لأننا على السيرفر) ======
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE in env');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// ====== خريطة النماذج → أنواع/Traits ======
const MODEL_MAP = {
  'switch-1': {
    type: 'action.devices.types.SWITCH',
    traits: ['action.devices.traits.OnOff'],
  },
  // أضف نماذج أخرى هنا عند الحاجة
};

const app = express();
app.use(morgan('tiny'));
app.use(bodyParser.json());

// ====== Middleware للحماية برأس Authorization بسيط أثناء الاختبار ======
function requireBearer(req, res, next) {
  const got = (req.headers.authorization || '').trim();
  if (!got || got !== `Bearer ${AUTH_BEARER}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

// ====== أدوات ======
function modelToGhome(model) {
  return MODEL_MAP[model] || {
    type: 'action.devices.types.SWITCH',
    traits: ['action.devices.traits.OnOff'],
  };
}

async function fetchUserDevices(owner) {
  const { data, error } = await supabase
    .from('devices')
    .select('id, name, model')
    .eq('owner', owner)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

async function fetchDevicesState(ids) {
  if (!ids.length) return {};
  const { data, error } = await supabase
    .from('device_state')
    .select('device_id, on')
    .in('device_id', ids);

  if (error) throw error;

  const map = {};
  for (const row of data || []) {
    map[row.device_id] = { online: true, on: !!row.on, status: 'SUCCESS' };
  }
  return map;
}

async function upsertDeviceOnOff(id, on) {
  const { error } = await supabase
    .from('device_state')
    .upsert(
      { device_id: id, on: !!on, updated_at: new Date().toISOString() },
      { onConflict: 'device_id' }
    );
  if (error) throw error;
}

// ====== صفحات فحص سريعة ======
app.get('/', (_req, res) => res.type('text').send('Lumina Fulfillment – OK'));

app.get('/debug-env', (_req, res) => {
  res.json({
    hasAuthHeader: false,
    TEST_USER_ID,
    AUTH_BEARER_SET: !!AUTH_BEARER,
    has_SUPABASE_URL: !!SUPABASE_URL,
    has_SUPABASE_SERVICE_ROLE: !!SUPABASE_SERVICE_ROLE,
  });
});

app.get('/debug-env-auth', requireBearer, (_req, res) => {
  res.json({
    hasAuthHeader: true,
    TEST_USER_ID,
    AUTH_BEARER_SET: !!AUTH_BEARER,
    has_SUPABASE_URL: !!SUPABASE_URL,
    has_SUPABASE_SERVICE_ROLE: !!SUPABASE_SERVICE_ROLE,
  });
});

app.get('/debug-db', requireBearer, async (_req, res) => {
  try {
    const owner = TEST_USER_ID; // في الإنتاج خذ المعرف الحقيقي من توكن ربط الحساب
    const { data, error } = await supabase
      .from('devices')
      .select('id, name, model')
      .eq('owner', owner)
      .limit(5);

    if (error) throw error;
    res.json({ ok: true, owner, count: data?.length || 0, sample: data || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'ping select failed', details: String(e?.message || e) });
  }
});

// ====== Google Smart Home Fulfillment ======
app.post('/smarthome', requireBearer, async (req, res) => {
  try {
    const requestId = req.body?.requestId || `${Date.now()}`;
    const inputs = req.body?.inputs || [];
    const intent = inputs[0]?.intent;

    // ملاحظة: في الإنتاج، استخرج userId الحقيقي من توكن OAuth
    const owner = TEST_USER_ID;

    // --- SYNC ---
    if (intent === 'action.devices.SYNC') {
      const rows = await fetchUserDevices(owner);

      const devices = rows.map((r) => {
        const meta = modelToGhome(r.model);
        return {
          id: r.id,
          type: meta.type,
          traits: meta.traits,
          name: {
            defaultNames: [r.model],
            name: r.name || r.id,
            nicknames: [r.name || r.id],
          },
          willReportState: false,
          deviceInfo: {
            manufacturer: 'Lumina',
            model: r.model,
          },
        };
      });

      return res.json({
        requestId,
        payload: { agentUserId: owner, devices },
      });
    }

    // --- QUERY ---
    if (intent === 'action.devices.QUERY') {
      const toQuery = (inputs[0]?.payload?.devices || []).map((d) => d.id);
      const stateMap = await fetchDevicesState(toQuery);

      // أي جهاز ما له حالة نخليه online=true/on=false
      for (const id of toQuery) {
        if (!stateMap[id]) stateMap[id] = { online: true, on: false, status: 'SUCCESS' };
      }

      return res.json({ requestId, payload: { devices: stateMap } });
    }

    // --- COMMAND (OnOff) ---
    if (intent === 'action.devices.COMMAND') {
      const commands = inputs[0]?.payload?.commands || [];
      const results = [];

      for (const group of commands) {
        const ids = (group.devices || []).map((d) => d.id);
        for (const exec of group.execution || []) {
          if (exec.command === 'action.devices.commands.OnOff') {
            const on = !!exec.params?.on;
            // نحدّث الحالة لكل جهاز
            for (const id of ids) {
              try {
                // (اختياري) هنا ترسل MQTT لو جهازك MQTT
                await upsertDeviceOnOff(id, on);
                results.push({
                  ids: [id],
                  status: 'SUCCESS',
                  states: { online: true, on },
                });
              } catch {
                results.push({ ids: [id], status: 'ERROR', errorCode: 'hardError' });
              }
            }
          }
        }
      }

      return res.json({ requestId, payload: { commands: results } });
    }

    // Intent غير مدعوم
    return res.status(400).json({ requestId, error: 'Unsupported intent' });
  } catch (e) {
    console.error('Fulfillment error:', e);
    return res.status(500).json({ error: 'internal', message: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log(`Fulfillment server running on :${PORT}`));
