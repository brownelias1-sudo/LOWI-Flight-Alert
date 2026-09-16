import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "LOWI Flight Alert",
    message: "Server läuft."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`LOWI Flight Alert läuft auf Port ${PORT}`);
});
