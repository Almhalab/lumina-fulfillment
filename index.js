// index.js — Lumina Fulfillment مع MQTT + Supabase + Google Smart Home

import express from 'express';
import morgan from 'morgan';
import bodyParser from 'body-parser';
import { createClient } from '@supabase/supabase-js';
import mqtt from 'mqtt';

/* ========= ENV ========= */
const {
  PORT = 3000,
  AUTH_BEARER = 'test-secret-123',
  TEST_USER_ID,

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

/* ========= Google traits ========= */
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
    reconnectPeriod: 3000,
    connectTimeout: 15_000,
  });

  mqttClient.on('connect', () => {
    console.log('[MQTT] connected');
    mqttClient.subscribe('lumina/+/state', { qos: 0 });
  });

  mqttClient.on('message', async (topic, payloadBuf) => {
    try {
      const msg = payloadBuf.toString().trim();
      const m = /^lumina\/([^/]+)\/state$/.exec(topic);
      if (!m) return;
      const deviceId = m[1];

      let on = null;
      try {
        const j = JSON.parse(msg);
        if (typeof j?.power === 'boolean') on = j.power;
      } catch {
        if (msg.toLowerCase() === 'on') on = true;
        else if (msg.toLowerCase() === 'off') on = false;
      }

      if (on !== null) {
        await supabase.from('device_state').upsert(
          {
            device_id: deviceId,
            on,
            online: true,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'device_id' }
        );
      }
    } catch (e) {
      console.error('[MQTT] message error:', e?.message || e);
    }
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
  await supabase.from('device_state').upsert(
    { device_id: id, on: !!on, online: true, updated_at: new Date().toISOString() },
    { onConflict: 'device_id' }
  );
}

function publishMqtt(topic, message) {
  return new Promise((resolve, reject) => {
    if (!mqttClient || !mqttClient.connected) return reject(new Error('MQTT not connected'));
    mqttClient.publish(topic, message, { qos: 0, retain: false }, (err) => {
      if (err) reject(err);
      else resolve(true);
    });
  });
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

/* ========= Smart Home Fulfillment ========= */
app.post('/smarthome', requireBearer, async (req, res) => {
  try {
    const requestId = req.body?.requestId || `${Date.now()}`;
    const input = (req.body?.inputs || [])[0] || {};
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
          name: {
            defaultNames: [r.model || 'switch'],
            name: r.name || r.id,
            nicknames: [r.name || r.id],
          },
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
        const ex = (group.execution || []).find((e) => e.command === 'action.devices.commands.OnOff');
        if (!ex) {
          results.push({ ids, status: 'ERROR', errorCode: 'notSupported' });
          continue;
        }
        const desiredOn = !!ex.params?.on;
        for (const id of ids) {
          try {
            if (mqttClient && mqttClient.connected) {
              await publishMqtt(`lumina/${id}/cmd`, desiredOn ? 'on' : 'off');
            }
            await upsertDeviceState(id, desiredOn);
            results.push({ ids: [id], status: 'SUCCESS', states: { online: true, on: desiredOn } });
          } catch {
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
app.listen(PORT, () => console.log(`✅ Fulfillment server running on :${PORT}`));
