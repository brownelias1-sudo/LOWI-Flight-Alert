import express from "express";
import https from "https";

const app = express();
const PORT = process.env.PORT || 3000;

const LOWI_LAT = 47.2602;
const LOWI_LON = 11.3440;

const TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";

const OPENSKY_URL =
  "https://opensky-network.org/api/states/all" +
  "?lamin=47.05&lomin=11.05&lamax=47.47&lomax=11.65&extended=1";

let accessToken = null;
let tokenExpiresAt = 0;

function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const request = https.request(options, (response) => {
      let data = "";

      response.on("data", (chunk) => {
        data += chunk;
      });

      response.on("end", () => {
        resolve({
          statusCode: response.statusCode,
          body: data
        });
      });
    });

    request.on("error", reject);

    if (body) {
      request.write(body);
    }

    request.end();
  });
}

async function getOpenSkyToken() {
  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "OPENSKY_CLIENT_ID oder OPENSKY_CLIENT_SECRET fehlt in Render."
    );
  }

  if (accessToken && Date.now() < tokenExpiresAt) {
    return accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret
  }).toString();

  const response = await httpsRequest(
    {
      hostname: "auth.opensky-network.org",
      path: "/auth/realms/opensky-network/protocol/openid-connect/token",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body)
      }
    },
    body
  );

  if (response.statusCode !== 200) {
    throw new Error(
      `OpenSky Anmeldung fehlgeschlagen (${response.statusCode}): ${response.body}`
    );
  }

  const data = JSON.parse(response.body);

  if (!data.access_token) {
    throw new Error("OpenSky hat kein Zugangstoken geliefert.");
  }

  accessToken = data.access_token;

  const expiresIn = Number(data.expires_in || 1800);

  tokenExpiresAt = Date.now() + Math.max(expiresIn - 60, 60) * 1000;

  return accessToken;
}

async function getAircraftFromOpenSky() {
  const token = await getOpenSkyToken();

  const response = await httpsRequest({
    hostname: "opensky-network.org",
    path:
      "/api/states/all" +
      "?lamin=47.05&lomin=11.05&lamax=47.47&lomax=11.65&extended=1",
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (response.statusCode === 401) {
    accessToken = null;
    tokenExpiresAt = 0;

    const newToken = await getOpenSkyToken();

    const retry = await httpsRequest({
      hostname: "opensky-network.org",
      path:
        "/api/states/all" +
        "?lamin=47.05&lomin=11.05&lamax=47.47&lomax=11.65&extended=1",
      method: "GET",
      headers: {
        Authorization: `Bearer ${newToken}`
      }
    });

    if (retry.statusCode !== 200) {
      throw new Error(
        `OpenSky API Fehler nach erneuter Anmeldung (${retry.statusCode}): ${retry.body}`
      );
    }

    return JSON.parse(retry.body);
  }

  if (response.statusCode !== 200) {
    throw new Error(
      `OpenSky API Fehler (${response.statusCode}): ${response.body}`
    );
  }

  return JSON.parse(response.body);
}

// Startseite
app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "LOWI Flight Alert",
    message: "Server läuft."
  });
});

// Flugzeuge rund um Innsbruck
app.get("/aircraft", async (_req, res) => {
  try {
    const data = await getAircraftFromOpenSky();

    const aircraft = (data.states || []).map((a) => ({
      icao24: a[0],
      callsign: (a[1] || "").trim(),
      country: a[2],
      longitude: a[5],
      latitude: a[6],
      altitude: a[7],
      velocity: a[9],
      heading: a[10],
      verticalRate: a[11],
      onGround: a[8],
      category: a[17]
    }));

    res.json({
      status: "ok",
      airport: "LOWI",
      airportPosition: {
        latitude: LOWI_LAT,
        longitude: LOWI_LON
      },
      aircraft
    });
  } catch (error) {
    console.error(error);

    res.status(502).json({
      status: "error",
      source: "OpenSky",
      message: "OpenSky-Daten konnten nicht abgerufen werden.",
      details: error.message
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`LOWI Flight Alert läuft auf Port ${PORT}`);
});
