// index.js — Lumina Home (CommonJS)
const express = require("express");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");

dotenv.config();
const app = express();
app.use(bodyParser.json());

// ====== صفحات اختبار بسيطة ======
app.get("/", (_req, res) => res.send("Lumina Home: OK"));
app.get("/callback", (req, res) => {
  const { code, state } = req.query;
  res.send(`<h3>OAuth Callback</h3><p>code=${code || ""}</p><p>state=${state || ""}</p>`);
});

// ====== OAuth /authorize: صفحة واضحة بزر ======
app.get("/authorize", (req, res) => {
  const { client_id, redirect_uri, state } = req.query;
  if (!redirect_uri) return res.status(400).send("missing redirect_uri");
  if (client_id && client_id !== "client123") return res.status(400).send("invalid client_id");

  const code = "demo-code";
  const target =
    redirect_uri +
    (redirect_uri.includes("?") ? "&" : "?") +
    `code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ""}`;

  res.type("html").send(`<!doctype html><meta charset="utf-8"/>
  <h2>Lumina Home – Sign in</h2>
  <p>ستُعاد إلى: <code>${target}</code></p>
  <a href="${target}" style="padding:10px 16px;border:1px solid #0a7;border-radius:8px;text-decoration:none;font-weight:700">متابعة</a>`);
});

// ====== OAuth /token ======
app.post("/token", (req, res) => {
  const { grant_type } = req.body || {};
  if (grant_type === "authorization_code") {
    return res.json({ token_type: "bearer", access_token: "demo-access-token", refresh_token: "demo-refresh-token", expires_in: 3600 });
  }
  if (grant_type === "refresh_token") {
    return res.json({ token_type: "bearer", access_token: "demo-access-token-" + Date.now(), expires_in: 3600 });
  }
  return res.json({ token_type: "bearer", access_token: "demo-access-token", expires_in: 3600 });
});

// ====== قاعدة أجهزة تجريبية ======
const devices = [
  {
    id: "dev-kitchen-1",
    type: "action.devices.types.SWITCH",
    traits: ["action.devices.traits.OnOff"],
    name: { name: "Kitchen Switch" },
    willReportState: false,
    roomHint: "Kitchen",
    state: { on: false, online: true },
  },
];
const byId = (id) => devices.find((d) => d.id === id);

// ====== /smarthome (intent موحّد) ======
app.post("/smarthome", (req, res) => {
  console.log("[/smarthome] got:", JSON.stringify(req.body, null, 2));
  const requestId = req.body?.requestId || "req";
  const intent = req.body?.inputs?.[0]?.intent;

  if (intent === "action.devices.SYNC") {
    const payload = {
      agentUserId: "user-123",
      devices: devices.map(({ id, type, traits, name, willReportState, roomHint }) => ({
        id, type, traits, name, willReportState, roomHint
      })),
    };
    return res.json({ requestId, payload });
  }

  if (intent === "action.devices.QUERY") {
    const ids = req.body.inputs[0].payload.devices.map((d) => d.id);
    const result = {};
    ids.forEach((id) => { const d = byId(id); if (d) result[id] = d.state; });
    return res.json({ requestId, payload: { devices: result } });
  }

  if (intent === "action.devices.EXECUTE") {
    const cmds = req.body.inputs[0].payload.commands || [];
    const results = [];
    for (const c of cmds) {
      const ids = c.devices.map((d) => d.id);
      for (const ex of c.execution) {
        if (ex.command === "action.devices.commands.OnOff") {
          const desired = !!ex.params.on;
          ids.forEach((id) => {
            const d = byId(id);
            if (!d) return;
            d.state.on = desired;
            d.state.online = true;
            results.push({ ids: [id], status: "SUCCESS", states: d.state });
          });
        } else {
          results.push({ ids, status: "ERROR", errorCode: "notSupported" });
        }
      }
    }
    return res.json({ requestId, payload: { commands: results } });
  }

  return res.status(400).json({ requestId, error: "unknown_intent" });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Fulfillment server running on http://localhost:${port}\n[/smarthome] handler ready`));
