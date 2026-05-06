require("dotenv").config();
const express = require("express");
const { Log, setToken } = require("../../logging_middleware");
const { getToken } = require("./auth");

const app = express();
app.use(express.json());

const notificationsRouter = require("./routes/notifications");

async function startServer() {
  const token = await getToken();
  setToken(token);

  app.use(async (req, res, next) => {
    await Log("backend", "info", "middleware", `${req.method} ${req.path}`).catch(() => {});
    next();
  });

  app.use("/api/notifications", notificationsRouter);
  app.get("/health", (req, res) => res.json({ status: "ok" }));

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, async () => {
    await Log("backend", "info", "service", "Notification server started").catch(() => {});
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);