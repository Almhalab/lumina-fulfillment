// index.js — Lumina Fulfillment (Express + Supabase + MQTT + Minimal OAuth)
// ملاحظات سريعة:
// 1) تأكد من وضع المتغيّرات في Render → Environment (موضحة تحت).
// 2) package.json لازم يحتوي:  "type":"module",  و  "start":"node index.js"

import express from "express";
import morgan from "morgan";
import bodyParser from "body-parser";
import mqtt from "mqtt";
import jwt from "jsonwebtoken";
import { createClient } from "@supabase/supabase-js";

/* =====================[ ENV ]===================== */
const {
  PORT = 10000,

  // حماية بسيطة وقت الاختبار (للضرب اليدوي من PowerShell/Curl)
  AUTH_BEARER = "test-secret-123",

  // OAuth (Google Home Console)
  GOOGLE_CLIENT_ID = "secret123",
  // العنوان الرسمي من جوجل (أو أي redirect_uri مسجل في Google Home Console)
  GOOGLE_REDIRECT_URI = "https://oauth-redirect.googleusercontent.com/r/YOUR_PROJECT_ID",

  // عندما تربط من تطبيقك تمرّر جلسة Supabase كـ app_token (JWT)
  // وإذا ما وصل app_token نستخدم TEST_USER_ID كمالك افتراضي للاختبار
  TEST_USER_ID,

  // Supabase (service role)
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,

  // MQTT (اختياري لكن مفضّل)
  MQTT_URL,
  MQTT_USER,
  MQTT_PASS,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error("❌ Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE");
  process.exit(1);
}

/* =====================[ Clients ]===================== */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

let mqttClient = null;
if (MQTT_URL) {
  mqttClient = mqtt.connect(MQTT_URL, {
    username: MQTT_USER,
    password: MQTT_PASS,
    reconnectPeriod: 3000,
    connectTimeout: 15000,
  });

  mqttClient.on("connect", () => {
    console.log("[MQTT] connected");
    try {
      mqttClient.subscribe("lumina/+/state", { qos: 0 }, (err) => {
        if (err) console.error("[MQTT] subscribe error:", err.message);
      });
    } catch (e) {
      console.error("[MQTT] subscribe exception:", e?.message);
    }
  });

  mqttClient.on("error", (e) => console.error("[MQTT] error:", e?.message));
  mqttClient.on("reconnect", () => console.log("[MQTT] reconnecting…"));
  mqttClient.on("close", () => console.log("[MQTT] closed"));

  // أي رسالة حالة من الأجهزة → حدّث جدول device_state
  mqttClient.on("message", async (topic, payloadBuf) => {
    try {
      const m = /^lumina\/([^/]+)\/state$/.exec(topic);
      if (!m) return;
      const deviceId = m[1];
      const msg = payloadBuf.toString().trim();

      let on = null;
      try {
        const j = JSON.parse(msg);
        if (typeof j?.power === "boolean") on = j.power;
      } catch {
        const v = msg.toLowerCase();
        if (v === "on") on = true;
        else if (v === "off") on = false;
      }
      if (on === null) return;

      await supabase.from("device_state").upsert(
        {
          device_id: deviceId,
          on,
          online: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "device_id" }
      );
    } catch (e) {
      console.error("[MQTT] message handler failed:", e?.message || e);
    }
  });
} else {
  console.warn("⚠️ MQTT_URL not set — EXECUTE سيحدّث القاعدة فقط.");
}

function publishMqtt(topic, message) {
  return new Promise((resolve, reject) => {
    if (!mqttClient || !mqttClient.connected) {
      return reject(new Error("MQTT not connected"));
    }
    mqttClient.publish(topic, message, { qos: 0, retain: false }, (err) =>
      err ? reject(err) : resolve(true)
    );
  });
}

/* =====================[ App Setup ]===================== */
const app = express();
app.use(morgan("tiny"));
app.use(bodyParser.json());

/* =====================[ Google device models ]===================== */
const MODEL_MAP = {
  "switch-1": {
    type: "action.devices.types.SWITCH",
    traits: ["action.devices.traits.OnOff"],
  },
};
function modelToTraits(model) {
  return MODEL_MAP[model] || {
    type: "action.devices.types.SWITCH",
    traits: ["action.devices.traits.OnOff"],
  };
}

/* =====================[ Auth helpers ]===================== */
// خرائط بالذاكرة (تكفي للاختبار والتطوير)
const CodeStore = new Map();   // code → owner
const TokenStore = new Map();  // access_token → owner

function randId(n = 24) {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2, 2 + n);
}

// حاول استخراج owner من:
// 1) Authorization: Bearer <access_token> (بعد /token)
// 2) Authorization: Bearer test-secret-123  (وضع الاختبار) ← يعيد TEST_USER_ID
async function resolveOwner(req) {
  const auth = (req.headers.authorization || "").trim();

  if (auth.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length);

    // وضع الاختبار: نستخدم TEST_USER_ID مباشرة
    if (token === AUTH_BEARER && TEST_USER_ID) return TEST_USER_ID;

    // وصول من Google Home بعد تبادل /token
    const owner = TokenStore.get(token);
    if (owner) return owner;

    // إن لم نجد، نسمح بالاختبار بالـ TEST_USER_ID (لتسهيل التجربة)
    if (TEST_USER_ID) return TEST_USER_ID;
  }

  // بدون هيدر → رفض
  return null;
}

/* =====================[ DB helpers ]===================== */
async function fetchUserDevices(owner) {
  const { data, error } = await supabase
    .from("devices")
    .select("id, name, model")
    .eq("owner", owner)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function fetchDevicesState(ids) {
  if (!ids.length) return {};
  const { data, error } = await supabase
    .from("device_state")
    .select("device_id, on, online")
    .in("device_id", ids);
  if (error) throw error;
  const map = {};
  for (const row of data || []) {
    map[row.device_id] = { online: !!row.online, on: !!row.on, status: "SUCCESS" };
  }
  return map;
}

async function upsertDeviceState(id, on) {
  const { error } = await supabase.from("device_state").upsert(
    {
      device_id: id,
      on: !!on,
      online: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "device_id" }
  );
  if (error) throw error;
}

/* =====================[ Diagnostics ]===================== */
app.get("/", (_req, res) => res.type("text").send("Lumina Fulfillment – OK"));
app.get("/health", (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);
app.get("/debug-env", (_req, res) => {
  res.json({
    AUTH_BEARER_SET: !!AUTH_BEARER,
    TEST_USER_ID,
    has_SUPABASE_URL: !!SUPABASE_URL,
    has_SUPABASE_SERVICE_ROLE: !!SUPABASE_SERVICE_ROLE,
    has_MQTT_URL: !!MQTT_URL,
    mqtt_connected: !!(mqttClient && mqttClient.connected),
    token_count: TokenStore.size,
    code_count: CodeStore.size,
  });
});
app.get("/debug-db", async (_req, res) => {
  try {
    const owner = TEST_USER_ID;
    const { data, error } = await supabase
      .from("devices")
      .select("id, name, model")
      .eq("owner", owner)
      .limit(5);
    if (error) throw error;
    res.json({ ok: true, owner, count: data?.length || 0, sample: data || [] });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, error: "ping select failed", details: String(e?.message || e) });
  }
});

/* =====================[ Minimal OAuth ]===================== */
// /authorize: يستقبل state و client_id و redirect_uri من Google.
// إذا جاء app_token (JWT جلسة Supabase من تطبيقك) نفكّه ونستخرج user_id ليكون owner.
// ثم نعيد توجيه Google للـ redirect_uri ومعه code وstate.
app.get("/authorize", (req, res) => {
  try {
    const client_id = String(req.query.client_id || "");
    const redirect_uri = String(req.query.redirect_uri || GOOGLE_REDIRECT_URI);
    const state = String(req.query.state || "");
    const app_token = req.query.app_token ? String(req.query.app_token) : null;

    if (client_id !== GOOGLE_CLIENT_ID) {
      return res.status(400).send("Invalid client_id");
    }

    let owner = TEST_USER_ID || "demo-user";
    if (app_token) {
      try {
        // نفكّ الـ JWT بدون تحقق توقيع لغرض تحديد الـ sub فقط
        const decoded = jwt.decode(app_token) || {};
        owner =
          decoded.sub ||
          decoded.user_id ||
          decoded?.user?.id ||
          decoded?.session?.user?.id ||
          owner;
      } catch {
        // نتجاهل الخطأ ونكمل بـ TEST_USER_ID
      }
    }

    const code = randId(16);
    CodeStore.set(code, { owner, exp: Date.now() + 5 * 60 * 1000 }); // صالح لـ 5 دقائق

    const url =
      `${redirect_uri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;

    return res.redirect(302, url);
  } catch (e) {
    console.error("/authorize error:", e?.message || e);
    return res.status(500).send("authorize failed");
  }
});

// /token: يستبدل code بـ access_token
app.post("/token", (req, res) => {
  try {
    const { code, grant_type } = req.body || {};
    if (!code) return res.status(400).json({ error: "invalid_request" });

    const rec = CodeStore.get(code);
    if (!rec || rec.exp < Date.now()) {
      return res.status(400).json({ error: "invalid_grant" });
    }
    CodeStore.delete(code);

    const access = "acc_" + randId(24);
    TokenStore.set(access, rec.owner);

    return res.json({
      token_type: "bearer",
      access_token: access,
      refresh_token: "ref_" + randId(24),
      expires_in: 3600,
    });
  } catch (e) {
    console.error("/token error:", e?.message || e);
    return res.status(500).json({ error: "server_error" });
  }
});

/* =====================[ Google Smart Home ]===================== */
// يقبل هيدر Authorization من:
// - Google (Bearer <access_token> الذي أعطيناه في /token)
// - وضع الاختبار: Bearer test-secret-123  (يعيد TEST_USER_ID)
app.post("/smarthome", async (req, res) => {
  try {
    const requestId = req.body?.requestId || `${Date.now()}`;
    const inputs = req.body?.inputs || [];
    const input = inputs[0] || {};
    const intent = input.intent;

    const owner = await resolveOwner(req);
    if (!owner) {
      return res.status(401).json({ requestId, error: "unauthorized" });
    }

    // SYNC
    if (intent === "action.devices.SYNC") {
      const rows = await fetchUserDevices(owner);

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
            defaultNames: [r.model || "switch"],
            name: r.name || r.id,
            nicknames: [r.name || r.id],
          },
          willReportState: false,
          deviceInfo: { manufacturer: "Lumina", model: r.model || "switch-1" },
        };
      });

      return res.json({ requestId, payload: { agentUserId: owner, devices } });
    }

    // QUERY
    if (intent === "action.devices.QUERY") {
      const toQuery = (input.payload?.devices || []).map((d) => d.id);
      const states = await fetchDevicesState(toQuery);
      for (const id of toQuery) {
        if (!states[id]) states[id] = { online: true, on: false, status: "SUCCESS" };
      }
      return res.json({ requestId, payload: { devices: states } });
    }

    // EXECUTE (OnOff)
    if (intent === "action.devices.EXECUTE") {
      const results = [];
      for (const group of input.payload?.commands || []) {
        const ids = (group.devices || []).map((d) => d.id);
        const exOnOff = (group.execution || []).find(
          (e) => e.command === "action.devices.commands.OnOff"
        );

        if (!exOnOff) {
          results.push({ ids, status: "ERROR", errorCode: "notSupported" });
          continue;
        }

        const desiredOn = !!exOnOff.params?.on;

        for (const id of ids) {
          try {
            if (mqttClient && mqttClient.connected) {
              const topic = `lumina/${id}/cmd`;
              const payload = desiredOn ? "on" : "off"; // يطابق كود ESP
              await publishMqtt(topic, payload);
            }
            await upsertDeviceState(id, desiredOn);

            results.push({
              ids: [id],
              status: "SUCCESS",
              states: { online: true, on: desiredOn },
            });
          } catch (e) {
            console.error("[EXECUTE] MQTT/DB error:", e?.message || e);
            results.push({ ids: [id], status: "ERROR", errorCode: "hardError" });
          }
        }
      }
      return res.json({ requestId, payload: { commands: results } });
    }

    return res.status(400).json({ requestId, error: "Unsupported intent" });
  } catch (e) {
    console.error("Fulfillment error:", e?.message || e);
    return res.status(500).json({ error: "internal", message: String(e?.message || e) });
  }
});

/* =====================[ Start ]===================== */
app.listen(PORT, () => console.log(`✅ Fulfillment server running on :${PORT}`));
