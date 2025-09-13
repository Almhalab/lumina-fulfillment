// index.js — Lumina Fulfillment (Render + Supabase) — STEP 1 (TEST_USER_ID)

const express = require("express");
const bodyParser = require("body-parser");
const mqtt = require("mqtt");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

/* ========= ENV ========= */
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || "";
const TEST_USER_ID = process.env.TEST_USER_ID || null; // مؤقت للاختبار

const MQTT_URL  = process.env.MQTT_URL  || "";
const MQTT_USER = process.env.MQTT_USER || "";
const MQTT_PASS = process.env.MQTT_PASS || "";

/* ========= Supabase (admin) ========= */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false },
});

/* ========= MQTT (اختياري) ========= */
let mqttClient = null;
if (MQTT_URL) {
  mqttClient = mqtt.connect(MQTT_URL, {
    username: MQTT_USER,
    password: MQTT_PASS,
    reconnectPeriod: 2000,
  });
  mqttClient.on("connect", () => console.log("[MQTT] Connected"));
  mqttClient.on("error", (e) => console.log("[MQTT] Error:", e?.message || e));
}

/* ========= Helpers ========= */
function getAgentUserId(req) {
  // أولوية للاختبار: إذا تم ضبط TEST_USER_ID نستخدمه مباشرة بدون Authorization
  if (TEST_USER_ID && TEST_USER_ID.trim().length > 0) return TEST_USER_ID.trim();

  // لاحقًا (Step 2) سنقرأ من Authorization: Bearer <token> ونحوّل إلى userId
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  // TODO: تحقق التوكن واسترجع userId
  return null;
}

/* ========= Health & Debug ========= */
app.get("/", (_req, res) => res.send("Lumina Fulfillment is running ✅"));
app.get("/health", (_req, res) => res.send("ok"));
app.get("/debug-env", (req, res) => {
  res.json({
    TEST_USER_ID: TEST_USER_ID || null,
    hasAuthHeader: !!req.headers.authorization,
  });
});

/* ========= Google Smart Home (موحّد) ========= */
app.post("/smarthome", async (req, res) => {
  console.log("=== /smarthome body ===");
  console.log(JSON.stringify(req.body, null, 2));

  const { requestId, inputs = [] } = req.body || {};
  const intent = inputs[0]?.intent || "";

  try {
    /* ----- SYNC ----- */
    if (intent.endsWith(".SYNC")) {
      const userId = getAgentUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "unauthorized" });
      }

      // من جدول devices حسب سكيمتك في الموبايل:
      // id, user_id, name, room_key, conn_type, topic_cmd, topic_state ...
      const { data: rows, error } = await supabase
        .from("devices")
        .select("id, name, room_key, conn_type, topic_cmd, topic_state")
        .eq("user_id", userId);

      if (error) {
        console.log("[DB] SYNC error:", error.message);
        return res
          .status(500)
          .json({ requestId, payload: { errorCode: "internalError" } });
      }

      const devices = (rows || []).map((d) => ({
        id: String(d.id),
        type: "action.devices.types.SWITCH",
        traits: ["action.devices.traits.OnOff"],
        name: { name: d.name || "Device" },
        roomHint: d.room_key || undefined,
        willReportState: false,
        attributes: {},
        // نرسل بيانات إضافية قد نحتاجها لاحقًا
        customData: {
          connType: d.conn_type || null,
          topicCmd: d.topic_cmd || null,
          topicState: d.topic_state || null,
        },
      }));

      return res.json({
        requestId,
        payload: { agentUserId: userId, devices },
      });
    }

    /* ----- QUERY ----- */
    if (intent.endsWith(".QUERY")) {
      const asked = inputs[0]?.payload?.devices || [];
      const result = {};
      // إن لم يكن لديك جدول حالة، نرجّع حالة افتراضية
      for (const dev of asked) {
        result[String(dev.id)] = { online: true, on: false };
      }
      return res.json({ requestId, payload: { devices: result } });
    }

    /* ----- EXECUTE ----- */
    if (intent.endsWith(".EXECUTE")) {
      const userId = getAgentUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "unauthorized" });
      }

      const commands = inputs[0]?.payload?.commands || [];
      const results = [];

      for (const group of commands) {
        const ids = (group.devices || []).map((d) => String(d.id));

        // تأكيد ملكية الأجهزة للمستخدم
        const { data: owned, error: ownErr } = await supabase
          .from("devices")
          .select("id, topic_cmd")
          .eq("user_id", userId)
          .in("id", ids);

        if (ownErr) {
          console.log("[DB] OWN error:", ownErr.message);
        }
        const ownedMap = new Map((owned || []).map((r) => [String(r.id), r]));

        for (const exec of group.execution || []) {
          if (exec.command === "action.devices.commands.OnOff") {
            const isOn = !!exec.params?.on;

            for (const id of ids) {
              if (!ownedMap.has(id)) {
                results.push({
                  ids: [id],
                  status: "ERROR",
                  errorCode: "deviceNotFound",
                });
                continue;
              }

              // نشر MQTT إذا كان topic_cmd موجود
              const topic = ownedMap.get(id)?.topic_cmd;
              if (mqttClient && topic) {
                try {
                  mqttClient.publish(
                    topic,
                    JSON.stringify({ on: isOn }),
                    { qos: 1 }
                  );
                } catch (e) {
                  console.log("[MQTT publish error]", e?.message || e);
                }
              }

              // نرجّع الحالة مباشرة (حتى بدون تخزين state)
              results.push({
                ids: [id],
                status: "SUCCESS",
                states: { online: true, on: isOn },
              });
            }
          } else {
            results.push({ ids, status: "ERROR", errorCode: "notSupported" });
          }
        }
      }

      return res.json({ requestId, payload: { commands: results } });
    }

    /* ----- Intent غير مدعوم ----- */
    return res.json({ requestId, payload: {} });
  } catch (e) {
    console.log("smarthome error:", e?.message || e);
    return res
      .status(500)
      .json({ requestId, payload: { errorCode: "internalError" } });
  }
});

/* ========= Start ========= */
app.listen(PORT, () => console.log(`Fulfillment server running on :${PORT}`));
