// index.js — Lumina Fulfillment (Render-ready)

const express = require("express");
const bodyParser = require("body-parser");
const mqtt = require("mqtt");

const app = express();
app.use(bodyParser.json());

// ====== بيئة التشغيل ======
const PORT = process.env.PORT || 3000;
const MQTT_URL  = process.env.MQTT_URL  || "";
const MQTT_USER = process.env.MQTT_USER || "";
const MQTT_PASS = process.env.MQTT_PASS || "";

// ====== MQTT ======
let mqttClient = null;
if (MQTT_URL) {
  try {
    mqttClient = mqtt.connect(MQTT_URL, {
      username: MQTT_USER,
      password: MQTT_PASS,
      reconnectPeriod: 3000,
    });

    mqttClient.on("connect", () => console.log("[MQTT] Connected"));
    mqttClient.on("error", (err) => console.log("[MQTT] Error:", err?.message || err));
  } catch (e) {
    console.log("[MQTT] connect exception:", e?.message || e);
  }
}

// ====== DB بسيطة للأجهزة ======
const devicesDB = {
  "dev-kitchen-1": {
    id: "dev-kitchen-1",
    type: "action.devices.types.SWITCH",
    traits: ["action.devices.traits.OnOff"],
    name: "Kitchen Switch",
    roomHint: "Kitchen",
    willReportState: false,
    states: { on: false },
    // topic اختياري لو أردت نشر أوامر MQTT
    mqttTopic: "home/kitchen/switch",
  },
};

// ====== صفحات مساعدة ======
app.get("/", (_req, res) => {
  res.type("text/plain").send("Lumina Fulfillment is running ✅");
});
app.get("/health", (_req, res) => res.status(200).send("ok"));

// ====== OAuth 2.0 (تبسيطي للاختبار) ======
// Google سيرسل إليك: response_type, client_id, redirect_uri, state, scope
app.get("/authorize", (req, res) => {
  const { redirect_uri, state = "" } = req.query;

  // في الإنتاج، اعرض شاشة تسجيل الدخول؛ هنا نعيد توجيه فوريًا مع code تجريبي
  if (redirect_uri) {
    const code = "demo-code";
    const uri = new URL(redirect_uri);
    uri.searchParams.set("code", code);
    uri.searchParams.set("state", state);
    return res.redirect(uri.toString());
  }

  // للزيارة اليدوية
  res.type("html").send(`
    <h2>OAuth Authorize (demo)</h2>
    <p>هذه صفحة تجريبية. يجب أن تُستدعى من Google مع redirect_uri.</p>
  `);
});

// Google يستبدل code بـ access_token
app.post("/token", (req, res) => {
  // في الواقع تتحقق من client_id/secret و code. هنا نرجّع توكن تجريبي.
  res.json({
    token_type: "bearer",
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    expires_in: 3600,
  });
});

// ====== Smart Home Fulfillment ======
app.post("/smarthome", async (req, res) => {
  console.log("=== /smarthome body ===");
  console.log(JSON.stringify(req.body, null, 2));

  const { requestId, inputs = [] } = req.body || {};
  const intent = inputs[0]?.intent || "";

  try {
    if (intent.endsWith(".SYNC")) {
      // رجّع الأجهزة
      const device = devicesDB["dev-kitchen-1"];
      return res.json({
        requestId,
        payload: {
          agentUserId: "user-123",
          devices: [
            {
              id: device.id,
              type: device.type,
              traits: device.traits,
              name: { name: device.name },
              roomHint: device.roomHint,
              willReportState: device.willReportState,
            },
          ],
        },
      });
    }

    if (intent.endsWith(".QUERY")) {
      const devs = inputs[0]?.payload?.devices || [];
      const out = {};
      for (const d of devs) {
        const dev = devicesDB[d.id];
        if (dev) out[d.id] = { online: true, on: !!dev.states.on };
      }
      return res.json({ requestId, payload: { devices: out } });
    }

    if (intent.endsWith(".EXECUTE")) {
      const cmds = inputs[0]?.payload?.commands || [];
      const results = [];
      for (const group of cmds) {
        for (const exec of group.execution || []) {
          if (exec.command === "action.devices.commands.OnOff") {
            const newOn = !!exec.params.on;
            for (const t of group.devices || []) {
              const dev = devicesDB[t.id];
              if (!dev) continue;
              dev.states.on = newOn;
              // نشر MQTT (اختياري)
              if (mqttClient && dev.mqttTopic) {
                try { mqttClient.publish(dev.mqttTopic, newOn ? "ON" : "OFF"); } catch {}
              }
              results.push({
                ids: [dev.id],
                status: "SUCCESS",
                states: { online: true, on: dev.states.on },
              });
            }
          }
        }
      }
      return res.json({ requestId, payload: { commands: results } });
    }

    // أي Intent غير مدعوم
    return res.json({ requestId, payload: {} });
  } catch (e) {
    console.log("smarthome error:", e?.message || e);
    return res.status(500).json({ requestId, payload: { errorCode: "internalError" } });
  }
});

// ====== callback للاختبار اليدوي فقط ======
app.get("/callback", (req, res) => {
  const { code, state } = req.query;
  res.type("html").send(`
    <h2>OAuth Callback</h2>
    <p><b>code</b>: ${code || ""}</p>
    <p><b>state</b>: ${state || ""}</p>
  `);
});

// ====== تشغيل ======
app.listen(PORT, () => {
  console.log(`Fulfillment server running on :${PORT}`);
});
