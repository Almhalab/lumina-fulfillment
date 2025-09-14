// index.js — Lumina + Google Smart Home + Supabase + MQTT  (نسخة مضبوطة لمواضيع lumina/*)

import express from 'express';
import morgan from 'morgan';
import bodyParser from 'body-parser';
import { createClient } from '@supabase/supabase-js';
import mqtt from 'mqtt';

/* ========= ENV ========= */
const {
  PORT = 3000,

  // حماية بسيطة للويب هوك أثناء الاختبار
  AUTH_BEARER = 'test-secret-123',
  TEST_USER_ID, // في الإنتاج استخرج user_id من OAuth

  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,

  // مفضّل لـ EMQX عبر الويب:
  // MQTT_URL = 'wss://t8ecaa49.ala.asia-southeast1.emqxsl.com:8084/mqtt'
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

/* ========= MQTT Client (singleton) ========= */
let mqttClient = null;

if (MQTT_URL) {
  mqttClient = mqtt.connect(MQTT_URL, {
    username: MQTT_USER,
    password: MQTT_PASS,
    reconnectPeriod: 3000,
    connectTimeout: 15_000,
  });

  mqttClient.on('connect', () => {
    console.log('[MQTT] connected');
    // اشتراك عام في حالات جميع الأجهزة: lumina/<id>/state
    try {
      mqttClient.subscribe('lumina/+/state', { qos: 0 }, (err) => {
        if (err) console.error('[MQTT] subscribe error:', err.message);
      });
    } catch (e) {
      console.error('[MQTT] subscribe exception:', e?.message);
    }
  });

  mqttClient.on('error', (e) => console.error('[MQTT] error:', e?.message));
  mqttClient.on('reconnect', () => console.log('[MQTT] reconnecting…'));
  mqttClient.on('close', () => console.log('[MQTT] closed'));

  // استلام الحالة من الأجهزة وتحديث Supabase
  mqttClient.on('message', async (topic, payloadBuf) => {
    try {
      const msg = payloadBuf.toString().trim();
      // نتوقع: lumina/<deviceId>/state
      const m = /^lumina\/([^/]+)\/state$/.exec(topic);
      if (!m) return;
      const deviceId = m[1];

      let on = null;

      // جهازك ينشر JSON مثل: {"id":"SW-N1-00001","power":true}
      try {
        const j = JSON.parse(msg);
        if (typeof j?.power === 'boolean') on = j.power;
      } catch {
        // احتياط لو أرسلت نصًا: "on"/"off"
        const v = msg.toLowerCase();
        if (v === 'on') on = true;
        else if (v === 'off') on = false;
      }

      if (on === null) return;

      await supabase.from('device_state').upsert(
        {
          device_id: deviceId,
          on,
          online: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'device_id' }
      );
    } catch (e) {
      console.error('[MQTT] message handler failed:', e?.message || e);
    }
  });
} else {
  console.warn('⚠️ MQTT_URL not set — EXECUTE will update DB only.');
}

// helper: نشر MQTT مع Promise
function publishMqtt(topic, message) {
  return new Promise((resolve, reject) => {
    if (!mqttClient || !mqttClient.connected) {
      return reject(new Error('MQTT not connected'));
    }
    mqttClient.publish(topic, message, { qos: 0, retain: false }, (err) => {
      if (err) reject(err);
      else resolve(true);
    });
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
  // أعمدة جدول devices: id, owner, name, model, created_at
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
  const { error } = await supabase
    .from('device_state')
    .upsert(
      { device_id: id, on: !!on, online: true, updated_at: new Date().toISOString() },
      { onConflict: 'device_id' }
    );
  if (error) throw error;
}

/* ========= Diagnostics ========= */
app.get('/', (_req, res) => res.type('text').send('Lumina Fulfillment – OK'));
app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
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
app.get('/debug-db', requireBearer, async (_req, res) => {
  try {
    const owner = TEST_USER_ID;
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

/* ========= Google Smart Home ========= */
app.post('/smarthome', requireBearer, async (req, res) => {
  try {
    const requestId = req.body?.requestId || `${Date.now()}`;
    const inputs = req.body?.inputs || [];
    const input = inputs[0] || {};
    const intent = input.intent;

    // في الإنتاج: استخرج owner من OAuth/Account Linking
    const owner = TEST_USER_ID;

    // SYNC
    if (intent === 'action.devices.SYNC') {
      const rows = await fetchUserDevices(owner);

      // اشترك في حالة كل جهاز: lumina/<id>/state
      if (mqttClient && mqttClient.connected) {
        for (const r of rows) {
          try {
            mqttClient.subscribe(`lumina/${r.id}/state`);
          } catch {}
        }
      }

      const devices = rows.map((r) => {
        const meta = modelToTraits(r.model);
        return {
          id: r.id,
          type: meta.type,
          traits: meta.traits,
          name: {
            defaultNames: [r.model || 'switch'],
            name: r.name || r.id,
            nicknames: [r.name || r.id],
          },
          willReportState: false, // بدون HomeGraph حالياً
          deviceInfo: { manufacturer: 'Lumina', model: r.model || 'switch-1' },
        };
      });

      return res.json({ requestId, payload: { agentUserId: owner, devices } });
    }

    // QUERY
    if (intent === 'action.devices.QUERY') {
      const toQuery = (input.payload?.devices || []).map((d) => d.id);
      const states = await fetchDevicesState(toQuery);
      for (const id of toQuery) {
        if (!states[id]) states[id] = { online: true, on: false, status: 'SUCCESS' };
      }
      return res.json({ requestId, payload: { devices: states } });
    }

    // EXECUTE (OnOff) → ينشر "on"/"off" إلى lumina/<id>/cmd + يحدّث القاعدة
    if (intent === 'action.devices.EXECUTE') {
      const results = [];

      for (const group of input.payload?.commands || []) {
        const ids = (group.devices || []).map((d) => d.id);
        const exOnOff = (group.execution || []).find((e) => e.command === 'action.devices.commands.OnOff');

        if (!exOnOff) {
          results.push({ ids, status: 'ERROR', errorCode: 'notSupported' });
          continue;
        }

        const desiredOn = !!exOnOff.params?.on;

        for (const id of ids) {
          try {
            if (mqttClient && mqttClient.connected) {
              const topic = `lumina/${id}/cmd`;
              const payload = desiredOn ? 'on' : 'off'; // مطابق لكود الـ ESP
              await publishMqtt(topic, payload);
            }
            await upsertDeviceState(id, desiredOn);

            results.push({
              ids: [id],
              status: 'SUCCESS',
              states: { online: true, on: desiredOn },
            });
          } catch (e) {
            console.error('[EXECUTE] MQTT/DB error:', e?.message || e);
            results.push({ ids: [id], status: 'ERROR', errorCode: 'hardError' });
          }
        }
      }

      return res.json({ requestId, payload: { commands: results } });
    }

    return res.status(400).json({ requestId, error: 'Unsupported intent' });
  } catch (e) {
    console.error('Fulfillment error:', e);
    return res.status(500).json({ error: 'internal', message: String(e?.message || e) });
  }
});

/* ========= Start ========= */
app.listen(PORT, () => console.log(`Fulfillment server running on :${PORT}`));
