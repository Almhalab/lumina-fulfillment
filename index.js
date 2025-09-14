import express from "express";
import bodyParser from "body-parser";
import morgan from "morgan";
import mqtt from "mqtt";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;

/** ================= إعداد Supabase ================= */
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

/** ================= إعداد MQTT ================= */
const mqttClient = mqtt.connect(process.env.MQTT_URL, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
});

mqttClient.on("connect", () => {
  console.log("[MQTT] connected");
});

mqttClient.on("error", (err) => {
  console.error("[MQTT] error:", err.message);
});

/** ================= إعداد Express ================= */
app.use(morgan("dev"));
app.use(bodyParser.json());

/** ================= OAuth: /authorize ================= */
app.get("/authorize", (req, res) => {
  const { client_id, redirect_uri, state, app_token } = req.query;

  if (!client_id || !redirect_uri) {
    return res.status(400).send("Missing client_id or redirect_uri");
  }

  // هنا نتحقق من المستخدم (من تطبيقك أو Supabase)
  let userId = "demo-user";
  try {
    const decoded = jwt.decode(app_token);
    if (decoded?.sub) userId = decoded.sub;
  } catch (e) {
    console.warn("No valid app_token, fallback demo-user");
  }

  const code = jwt.sign({ userId }, process.env.JWT_SECRET || "secret", {
    expiresIn: "10m",
  });

  const redirectUrl = `${redirect_uri}?code=${code}&state=${state}`;
  res.redirect(302, redirectUrl);
});

/** ================= OAuth: /token ================= */
app.post("/token", (req, res) => {
  const { code } = req.body;
  try {
    const decoded = jwt.verify(code, process.env.JWT_SECRET || "secret");
    const accessToken = jwt.sign(
      { userId: decoded.userId },
      process.env.JWT_SECRET || "secret",
      { expiresIn: "1h" }
    );

    res.json({
      token_type: "bearer",
      access_token: accessToken,
      expires_in: 3600,
    });
  } catch (err) {
    res.status(400).json({ error: "invalid_grant" });
  }
});

/** ================= Fulfillment: /smarthome ================= */
app.post("/smarthome", async (req, res) => {
  const intent = req.body.inputs?.[0]?.intent;
  const requestId = req.body.requestId || "123";

  if (intent === "action.devices.SYNC") {
    return res.json({
      requestId,
      payload: {
        agentUserId: "demo-user",
        devices: [
          {
            id: "SW-N1-00001",
            type: "action.devices.types.SWITCH",
            traits: ["action.devices.traits.OnOff"],
            name: {
              defaultNames: ["switch-1"],
              name: "SW-N1-00001",
              nicknames: ["switch-1"],
            },
            willReportState: false,
            deviceInfo: {
              manufacturer: "Lumina",
              model: "switch-1",
            },
          },
        ],
      },
    });
  }

  if (intent === "action.devices.QUERY") {
    return res.json({
      requestId,
      payload: {
        devices: {
          "SW-N1-00001": { online: true, on: false, status: "SUCCESS" },
        },
      },
    });
  }

  if (intent === "action.devices.EXECUTE") {
    const command =
      req.body.inputs[0].payload.commands[0].execution[0].command;
    const params =
      req.body.inputs[0].payload.commands[0].execution[0].params;

    let on = params.on;
    mqttClient.publish("lumina/switch/1/set", on ? "ON" : "OFF");

    return res.json({
      requestId,
      payload: {
        commands: [
          {
            ids: ["SW-N1-00001"],
            status: "SUCCESS",
            states: { on, online: true },
          },
        ],
      },
    });
  }

  res.json({ requestId, payload: {} });
});

/** ================= اختبار ================= */
app.get("/", (req, res) => {
  res.send("✅ Lumina Fulfillment is running!");
});

/** ================= تشغيل السيرفر ================= */
app.listen(PORT, () => {
  console.log(`✅ Fulfillment server running on :${PORT}`);
});
