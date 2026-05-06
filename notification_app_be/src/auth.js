require("dotenv").config();
const axios = require("axios");
const { setToken } = require("../../logging_middleware");

const AUTH_URL = "http://20.207.122.201/evaluation-service/auth";

let currentToken = "";
let tokenExpiry = 0;

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  if (currentToken && now < tokenExpiry - 60) {
    return currentToken;
  }

  const res = await axios.post(AUTH_URL, {
    email: process.env.EMAIL,
    name: process.env.NAME,
    rollNo: process.env.ROLL_NO,
    accessCode: process.env.ACCESS_CODE,
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
  });

  currentToken = res.data.access_token;
  tokenExpiry = res.data.expires_in;
  setToken(currentToken);
  console.log("Token refreshed successfully");
  return currentToken;
}

module.exports = { getToken };