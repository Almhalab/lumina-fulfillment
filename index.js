import express from "express";
import morgan from "morgan";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import mqtt from "mqtt";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

/* ========= ENV ========= */
const {
  PORT = 10000,
  // حماية اختيارية لمسار /smarthome أثناء الاختبار (اتركه فاضي لتعطيله)
  AUTH_BEARER = "test-secret-123",

  // للربط من تطبيقك: نقرأ userId من app_token أو نfallback لهذا:
  TEST_USER_ID = "demo-user",

  // Supabase (اختياري، إن ما تبغاه اتركه فاضي)
  SUPABASE_URL,
  SUPABASE_KEY,

  // MQTT (اختياري، ينفع للتشغيل الحقيقي)
  MQTT_URL,
  MQTT_USER,
  MQTT_PASS,

  // سرّ توقيع أكواد OAuth الموقتة
  JWT_SECRET = "change-me"
} = process.env;

/* ========= Clients ========= */
const app = express();
app.use(morgan("dev"));
app.use(bodyParser.json());

const supabase =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

let mqttClient = null;
if (MQTT_URL) {
  mqttClient = mqtt.connect(MQTT_URL, {
    username: MQTT_USER,
    password: MQTT_PASS,
    reconnectPeriod: 3000,
    connectTimeout: 15000
  });
  mqttClient.on("connect", () => console.log("[MQTT] connected"));
  mqttClient.on("reconnect", () => console.log("[MQTT] reconnecting…"));
  mqttClient.on("error", (e) => console.error("[MQTT] error:", e?.message));
}

/* ========= Helpers ========= */
function requireBearer(req, res, next) {
  if (!AUTH_BEARER) return next(); // تعطيل الحماية
  const got = (req.headers.authorization || "").trim();
  if (got !== `Bearer ${AUTH_BEARER}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

async function publishMqtt(topic, message) {
  return new Promise((resolve, reject) => {
    if (!mqttClient || !mqttClient.connected) {
      return reject(new Error("MQTT not connected"));
    }
    mqttClient.publish(topic, message, { qos: 0, retain: false }, (err) =>
      err ? reject(err) : resolve(true)
    );
  });
}

/** جلب أجهزة المستخدم:
 * - إن وُجد Supabase: يقرأ من جدول devices (أعمدة: id,name,model,owner)
 * - غير ذلك: يرجع جهاز ثابت للتجربة
 */
async function getUserDevices(ownerId) {
  if (!supabase) {
    return [
      {
        id: "SW-N1-00001",
        name: "SW-N1-00001",
        model: "switch-1"
      }
    ];
  }
  const { data, error } = await supabase
    .from("devices")
    .select("id,name,model")
    .eq("owner", ownerId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

/* ========= Diagnostics ========= */
app.get("/", (_req, res) => res.send("✅ Lumina Fulfillment is running!"));

app.get("/debug-env", (_req, res) => {
  res.json({
    has_AUTH_BEARER: !!AUTH_BEARER,
    TEST_USER_ID,
    has_SUPABASE_URL: !!SUPABASE_URL,
    has_SUPABASE_KEY: !!SUPABASE_KEY,
    has_MQTT_URL: !!MQTT_URL,
    mqtt_connected: !!(mqttClient && mqttClient.connected)
  });
});

/* ========= OAuth (بسيط للربط من تطبيقك) =========
   GET /authorize?client_id=...&redirect_uri=...&response_type=code&state=...&app_token=<JWT من تطبيقك>
   - app_token اختياري: إن كان JWT فيه sub = userId نستخدمه
*/
app.get("/authorize", (req, res) => {
  const { client_id, redirect_uri, state, app_token } = req.query;
  if (!client_id || !redirect_uri) {
    return res.status(400).send("Missing client_id or redirect_uri");
  }

  let userId = TEST_USER_ID;
  if (app_token) {
    try {
      const decoded = jwt.decode(String(app_token));
      if (decoded?.sub) userId = decoded.sub;
    } catch {
      /* ignore */
    }
  }

  // نصدر كود مؤقت (10 دقائق)
  const code = jwt.sign({ userId }, JWT_SECRET, { expiresIn: "10m" });
  const redirectUrl = `${redirect_uri}?code=${encodeURIComponent(
    code
  )}&state=${encodeURIComponent(state || "")}`;
  return res.redirect(302, redirectUrl);
});

/* تبادل الكود بـ access_token */
app.post("/token", (req, res) => {
  const { code } = req.body || {};
  try {
    const decoded = jwt.verify(String(code), JWT_SECRET);
    const accessToken = jwt.sign(
      { userId: decoded.userId },
      JWT_SECRET,
      { expiresIn: "1h" }
    );
    return res.json({
      token_type: "bearer",
      access_token: accessToken,
      expires_in: 3600
    });
  } catch (e) {
    return res.status(400).json({ error: "invalid_grant" });
  }
});

/* ========= Google Smart Home ========= */
const MODEL_MAP = {
  "switch-1": {
    type: "action.devices.types.SWITCH",
    traits: ["action.devices.traits.OnOff"]
  }
};
const defaultModel = MODEL_MAP["switch-1"];

app.post("/smarthome", requireBearer, async (req, res) => {
  try {
  const requestId = req.body?.requestId || `${Date.now()}`;
    const input = req.body?.inputs?.[0] || {};
    const intent = input.intent;

    // عادةً يُستخرج userId من OAuth/Account Linking (Bearer من Google)
    // هنا نبسطها ونأخذ TEST_USER_ID
    const ownerId = TEST_USER_ID;

    /* SYNC */
    if (intent === "action.devices.SYNC") {
      const rows = await getUserDevices(ownerId);
      const devices = rows.map((r) => {
        const meta = MODEL_MAP[r.model] || defaultModel;
        return {
          id: r.id,
          type: meta.type,
          traits: meta.traits,
          name: {
            defaultNames: [r.model || "switch"],
            name: r.name || r.id,
            nicknames: [r.name || r.id]
          },
          willReportState: false,
          deviceInfo: { manufacturer: "Lumina", model: r.model || "switch-1" }
        };
      });
      return res.json({ requestId, payload: { agentUserId: ownerId, devices } });
    }

    /* QUERY */
    if (intent === "action.devices.QUERY") {
      const ids = (input.payload?.devices || []).map((d) => d.id);
      const states = {};
      for (const id of ids) {
        // بدون تخزين حالة: نرجّع افتراضي
        states[id] = { online: true, on: false, status: "SUCCESS" };
      }
      return res.json({ requestId, payload: { devices: states } });
    }

    /* EXECUTE (OnOff) -> يرسل MQTT إلى lumina/<id>/cmd */
    if (intent === "action.devices.EXECUTE") {
      const results = [];

      for (const group of input.payload?.commands || []) {
        const ids = (group.devices || []).map((d) => d.id);
        const ex = (group.execution || []).find(
          (e) => e.command === "action.devices.commands.OnOff"
        );

        if (!ex) {
          results.push({ ids, status: "ERROR", errorCode: "notSupported" });
          continue;
        }

        const desiredOn = !!ex.params?.on;
        for (const id of ids) {
          try {
            if (mqttClient && mqttClient.connected) {
              await publishMqtt(`lumina/${id}/cmd`, desiredOn ? "on" : "off");
            }
            results.push({
              ids: [id],
              status: "SUCCESS",
              states: { on: desiredOn, online: true }
            });
          } catch (e) {
            results.push({ ids: [id], status: "ERROR", errorCode: "hardError" });
          }
        }
      }

      return res.json({ requestId, payload: { commands: results } });
    }

    return res.status(400).json({ requestId, error: "Unsupported intent" });
  } catch (e) {
    console.error("Fulfillment error:", e);
    return res.status(500).json({ error: "internal" });
  }
});

/* ========= Start ========= */
app.listen(PORT, () => {
  console.log(`✅ Fulfillment server running on :${PORT}`);
});