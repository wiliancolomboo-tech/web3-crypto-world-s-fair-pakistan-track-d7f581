import express from "express";
const app = express();
const PORT = process.env.PORT || 8080;

app.get("/healthz", (_, res) => {
  res.status(200).json({
    status: "healthy",
    uptimeSeconds: process.uptime(),
    protocol: "PakFlow Solana-Raast Bridge",
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`[Health Service] Online on port ${PORT}`);
});