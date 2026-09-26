import express from "express";
import { API_BASE_URL, API_PORT, NETWORK, requireState } from "../lib/config.js";
import { requirePayment } from "./payments.js";
import { services } from "./services.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT");
  res.setHeader("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get("/api/services", (_req, res) => {
  const state = requireState();
  res.json({
    network: NETWORK,
    currency: { mint: state.mint, decimals: state.decimals, name: "USDC (devnet test token)" },
    payTo: state.merchant,
    services: services.map((s) => ({
      id: s.id,
      method: s.method,
      url: `${API_BASE_URL}${s.path}`,
      priceUsdc: s.priceUsdc,
      description: s.description,
      params: s.params,
    })),
  });
});

for (const service of services) {
  const route = service.method === "GET" ? app.get.bind(app) : app.post.bind(app);
  route(
    service.path,
    (req, res, next) => {
      const problem = service.validate(req);
      if (problem) res.status(400).json({ error: problem });
      else next();
    },
    requirePayment(service),
    (req, res) => service.handle(req, res),
  );
}

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

requireState(); // Fail fast if setup hasn't run.
app.listen(API_PORT, () => {
  console.log(`Overseer paid API on ${API_BASE_URL}`);
  for (const s of services) console.log(`  ${s.method} ${s.path}  ${s.priceUsdc} USDC  ${s.description}`);
});
