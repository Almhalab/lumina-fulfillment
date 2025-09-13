// index.js — Lumina Fulfillment (Render + Supabase)
const express = require("express");
const bodyParser = require("body-parser");
const mqtt = require("mqtt");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true })); // يدعم x-www-form-urlencoded

// ===== Env =====
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

const MQTT_URL  = process.env.MQTT_URL  || "";
const MQTT_USER = process.env.MQTT_USER || "";
const MQTT_PASS = process.env.MQTT_PASS || "";

// ===== Supabase =====
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ===== MQTT =====
let mqttClient = null;
if (MQTT_URL) {
  mqttClient = mqtt.connect(MQTT_URL, {
    username: MQTT_USER,
    password: MQTT_PASS,
    reconnectPeriod: 2000,
  });
  mqttClient.on("connect", () => {
    console.log("[MQTT] Connected");
    // استقبل حالات جميع الأجهزة (topic نمطي)
    mqttClient.subscribe("lumina/+/state");
  });
  mqttClient.on("error", (e) => console.log("[MQTT] Error:", e?.message || e));
  mqttClient.on("message", async (topic, msg) => {
    try {
      const m = topic.match(/^lumina\/(.+)\/state$/);
      if (!m) return;
      const id = m[1]; // device id
      const payload = JSON.parse(msg.toString());
      // حدّث state في Supabase
      await supabase
        .from("devices")
        .update({ state: { on: !!payload.on, online: true } })
        .eq("id", id);
      console.log("[STATE] updated", id, payload);
    } catch (e) {
      console.log("[MQTT parse error]", e?.message || e);
    }
  });
}

// ===== صفحات فحص بسيطة =====
app.get("/", (_req, res) => res.send("Lumina Fulfillment is running ✅"));
app.get("/health", (_req, res) => res.send("ok"));

// ===== OAuth (مبسّط للاختبار) =====
// نخزّن مؤقتًا: code -> userId
const authCodes = new Map();

/**
 * /authorize: ارجع code مربوط بمستخدمك.
 * مبدئيًا نعيد userId ثابت للاختبار. لاحقًا وصّلها بتسجيل الدخول الفعلي.
 */
app.get("/authorize", (req, res) => {
  const { redirect_uri, state = "" } = req.query;
  if (!redirect_uri) return res.status(400).send("missing redirect_uri");

  // TODO: بدّل هذا بمعرّف المستخدم الحقيقي من نظامك
  const userId = "user-123";

  const code = uuidv4();
  authCodes.set(code, userId);

  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  return res.redirect(url.toString());
});

/**
 * /token: تبادل code -> access_token (JWT يحتوي sub=userId)
 * يقبل JSON أو x-www-form-urlencoded
 */
app.post("/token", (req, res) => {
  const code = req.body.code || req.query.code;
  const userId = authCodes.get(code);
  if (!userId) return res.status(400).json({ error: "invalid_grant" });

  const access_token = jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: "24h" });
  // اختياري: إصدار refresh_token وتخزينه
  return res.json({
    token_type: "bearer",
    access_token,
    expires_in: 86400,
    refresh_token: "demo-refresh-token",
  });
});

// ===== Middleware لاستخراج userId من Authorization: Bearer <JWT> =====
function authMiddleware(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!token) throw new Error("no token");
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.sub;
    next();
  } catch (e) {
    return res.status(401).json({ error: "unauthorized" });
  }
}

// ===== Smart Home: endpoint موحّد =====
app.post("/smarthome", authMiddleware, async (req, res) => {
  console.log("=== /smarthome body ===");
  console.log(JSON.stringify(req.body, null, 2));

  const { requestId, inputs = [] } = req.body || {};
  const intent = inputs[0]?.intent || "";
  const userId = req.userId;

  try {
    // ---- SYNC ----
    if (intent.endsWith(".SYNC")) {
      const { data, error } = await supabase
        .from("devices")
        .select("*")
        .eq("owner", userId);

      if (error) throw error;

      const devices = (data || []).map((d) => ({
        id: d.id,
        type: d.type,
        traits: d.traits,
        name: { name: d.name },
        roomHint: d.room_hint || undefined,
        willReportState: false, // فعّل لاحقًا مع Google HomeGraph
      }));

      return res.json({
        requestId,
        payload: { agentUserId: userId, devices },
      });
    }

    // ---- QUERY ----
    if (intent.endsWith(".QUERY")) {
      const ids = inputs[0]?.payload?.devices?.map((d) => d.id) || [];
      if (ids.length === 0) return res.json({ requestId, payload: { devices: {} } });

      const { data, error } = await supabase
        .from("devices")
        .select("id,state")
        .eq("owner", userId)
        .in("id", ids);

      if (error) throw error;

      const result = {};
      (data || []).forEach((d) => {
        result[d.id] = {
          online: !!d.state?.online,
          on: !!d.state?.on,
        };
      });

      return res.json({ requestId, payload: { devices: result } });
    }

    // ---- EXECUTE ----
    if (intent.endsWith(".EXECUTE")) {
      const commands = inputs[0]?.payload?.commands || [];
      const results = [];

      for (const c of commands) {
        const ids = (c.devices || []).map((d) => d.id);
        // تأكيد الملكية
        const { data: owned, error: ownErr } = await supabase
          .from("devices")
          .select("id,topics")
          .eq("owner", userId)
          .in("id", ids);
        if (ownErr) throw ownErr;

        const ownedSet = new Set((owned || []).map((x) => x.id));
        const topicsById = {};
        (owned || []).forEach((x) => (topicsById[x.id] = x.topics || {}));

        for (const ex of c.execution || []) {
          if (ex.command === "action.devices.commands.OnOff") {
            const isOn = !!ex.params?.on;
            for (const id of ids) {
              if (!ownedSet.has(id)) {
                results.push({ ids: [id], status: "ERROR", errorCode: "deviceNotFound" });
                continue;
              }
              // نشر MQTT
              const topic = topicsById[id]?.set || `lumina/${id}/set`;
              if (mqttClient) {
                try {
                  mqttClient.publish(topic, JSON.stringify({ on: isOn }), { qos: 1 });
                } catch {}
              }
              // تحديث الحالة في DB
              await supabase
                .from("devices")
                .update({ state: { on: isOn, online: true } })
                .eq("id", id)
                .eq("owner", userId);

              results.push({
                ids: [id],
                status: "SUCCESS",
                states: { on: isOn, online: true },
              });
            }
          } else {
            results.push({ ids, status: "ERROR", errorCode: "notSupported" });
          }
        }
      }

      return res.json({ requestId, payload: { commands: results } });
    }

    // غير مدعوم
    return res.json({ requestId, payload: {} });
  } catch (e) {
    console.error("smarthome error:", e?.message || e);
    return res.status(500).json({ requestId, payload: { errorCode: "internalError" } });
  }
});

// ===== OAuth callback للاختبار اليدوي =====
app.get("/callback", (req, res) => {
  const { code, state } = req.query;
  res.type("html").send(
    `<h2>OAuth Callback</h2><p><b>code:</b> ${code || ""}</p><p><b>state:</b> ${state || ""}</p>`
  );
});

// ===== Start =====
app.listen(PORT, () => console.log(`Fulfillment server running on :${PORT}`));
