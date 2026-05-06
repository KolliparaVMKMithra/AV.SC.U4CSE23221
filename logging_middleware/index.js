const axios = require("axios");

let AUTH_TOKEN = "";

function setToken(token) {
  AUTH_TOKEN = token;
}

async function Log(stack, level, package_, message) {
  try {
    const response = await axios.post(
      "http://20.207.122.201/evaluation-service/logs",
      { stack, level, package: package_, message },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
      }
    );
    return response.data;
  } catch (err) {
    console.error("[LogMiddleware] Failed to send log:", err.response?.data || err.message);
  }
}

module.exports = { Log, setToken };