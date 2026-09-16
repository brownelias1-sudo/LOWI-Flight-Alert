import express from "express";
import https from "https";

const app = express();
const PORT = process.env.PORT || 3000;

// ======================================================
// LOWI – Innsbruck Airport
// ======================================================

const LOWI_LAT = 47.2602;
const LOWI_LON = 11.3440;

// Runway directions
// 08 ≈ 080°
// 26 ≈ 260°
const RUNWAYS = [
  { name: "08", heading: 80 },
  { name: "26", heading: 260 }
];

// ======================================================
// OpenSky
// ======================================================

const TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";

const OPENSKY_PATH =
  "/api/states/all" +
  "?lamin=47.05&lomin=11.05&lamax=47.47&lomax=11.65&extended=1";

let accessToken = null;
let tokenExpiresAt = 0;

// ======================================================
// HTTPS helper
// ======================================================

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

// ======================================================
// OpenSky token
// ======================================================

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

  tokenExpiresAt =
    Date.now() + Math.max(expiresIn - 60, 60) * 1000;

  return accessToken;
}

// ======================================================
// OpenSky aircraft
// ======================================================

async function getAircraftFromOpenSky() {
  const token = await getOpenSkyToken();

  const response = await httpsRequest({
    hostname: "opensky-network.org",
    path: OPENSKY_PATH,
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
      path: OPENSKY_PATH,
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

// ======================================================
// GEO – Berechnungen
// ======================================================

function toRadians(degrees) {
  return degrees * Math.PI / 180;
}

function toDegrees(radians) {
  return radians * 180 / Math.PI;
}

function normalizeHeading(heading) {
  return ((heading % 360) + 360) % 360;
}

function angleDifference(a, b) {
  const diff = Math.abs(normalizeHeading(a) - normalizeHeading(b));
  return Math.min(diff, 360 - diff);
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(a));
}

function bearingBetween(lat1, lon1, lat2, lon2) {
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const lambda1 = toRadians(lon1);
  const lambda2 = toRadians(lon2);

  const y =
    Math.sin(lambda2 - lambda1) * Math.cos(phi2);

  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) *
      Math.cos(phi2) *
      Math.cos(lambda2 - lambda1);

  return normalizeHeading(
    toDegrees(Math.atan2(y, x))
  );
}

// ======================================================
// LOWI approach detection
// ======================================================

function analyzeApproach(aircraft) {
  if (
    aircraft.latitude == null ||
    aircraft.longitude == null ||
    aircraft.heading == null
  ) {
    return {
      isApproach: false,
      reason: "Keine ausreichenden Positions-/Kursdaten"
    };
  }

  const distance = distanceKm(
    aircraft.latitude,
    aircraft.longitude,
    LOWI_LAT,
    LOWI_LON
  );

  // Nicht mehr als 25 km vom Flughafen entfernt
  if (distance > 25) {
    return {
      isApproach: false,
      reason: "Zu weit von LOWI entfernt",
      distanceKm: distance
    };
  }

  // Direkt am Flughafen nicht mehr als Anflug erkennen
  if (distance < 0.8) {
    return {
      isApproach: false,
      reason: "Bereits zu nahe an LOWI",
      distanceKm: distance
    };
  }

  const bearingToAirport = bearingBetween(
    aircraft.latitude,
    aircraft.longitude,
    LOWI_LAT,
    LOWI_LON
  );

  // Flugrichtung muss ungefähr zum Flughafen zeigen
  const headingToAirportDifference = angleDifference(
    aircraft.heading,
    bearingToAirport
  );

  if (headingToAirportDifference > 35) {
    return {
      isApproach: false,
      reason: "Flugrichtung zeigt nicht ausreichend zu LOWI",
      distanceKm: distance,
      bearingToAirport,
      headingToAirportDifference
    };
  }

  // Prüfen, ob die Maschine nahe an einer
  // verlängerten Runway-Achse liegt.
  let bestRunway = null;

  for (const runway of RUNWAYS) {
    const runwayDifference = angleDifference(
      aircraft.heading,
      runway.heading
    );

    const reverseRunwayDifference = angleDifference(
      aircraft.heading,
      normalizeHeading(runway.heading + 180)
    );

    // Je nach Anflugrichtung kann die Maschine
    // auf die entsprechende Runway-Achse zufliegen.
    const headingDifference = Math.min(
      runwayDifference,
      reverseRunwayDifference
    );

    if (
      !bestRunway ||
      headingDifference < bestRunway.headingDifference
    ) {
      bestRunway = {
        runway: runway.name,
        headingDifference
      };
    }
  }

  // Wir verlangen einen vernünftigen Anflugkurs.
  if (bestRunway.headingDifference > 35) {
    return {
      isApproach: false,
      reason: "Nicht ausreichend auf Runway-Achse ausgerichtet",
      distanceKm: distance,
      bearingToAirport,
      headingToAirportDifference,
      runway: bestRunway.runway
    };
  }

  return {
    isApproach: true,
    distanceKm: Number(distance.toFixed(2)),
    bearingToAirport: Number(bearingToAirport.toFixed(1)),
    headingToAirportDifference: Number(
      headingToAirportDifference.toFixed(1)
    ),
    runway: bestRunway.runway,
    runwayHeadingDifference: Number(
      bestRunway.headingDifference.toFixed(1)
    )
  };
}

// ======================================================
// Aircraft classification
// ======================================================

function classifyAircraft(aircraft) {
  const callsign = (aircraft.callsign || "").toUpperCase();

  // Flying Bulls
  const flyingBulls =
    callsign.includes("BULL") ||
    callsign.includes("FLYING") ||
    callsign.includes("FLSB");

  if (flyingBulls) {
    return {
      relevant: true,
      type: "Flying Bulls"
    };
  }

  // OpenSky category 8 = Rotorcraft / Hubschrauber
  if (aircraft.category === 8) {
    return {
      relevant: true,
      type: "Hubschrauber"
    };
  }

  // Bekannte militärische Callsign-Muster
  const militaryPatterns = [
    "GAF",
    "RCH",
    "REACH",
    "NATO",
    "IAM",
    "MMF",
    "ASCOT",
    "RRR",
    "RAF",
    "BAF",
    "FAF",
    "HAF",
    "NAF",
    "DAG",
    "MASCOT"
  ];

  const military =
    militaryPatterns.some((pattern) =>
      callsign.includes(pattern)
    );

  if (military) {
    return {
      relevant: true,
      type: "Militär"
    };
  }

  // OpenSky High Performance kann ein zusätzlicher Hinweis
  // auf militärische/high-performance Luftfahrzeuge sein.
  if (aircraft.category === 7) {
    return {
      relevant: true,
      type: "High Performance / möglicher Militärflug"
    };
  }

  return {
    relevant: false,
    type: null
  };
}

// ======================================================
// Aircraft mapping
// ======================================================

function mapAircraft(a) {
  return {
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
  };
}

// ======================================================
// START
// ======================================================

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "LOWI Flight Alert",
    message: "Server läuft."
  });
});

// ======================================================
// ALLE Flugzeuge – bestehender Endpoint
// ======================================================

app.get("/aircraft", async (_req, res) => {
  try {
    const data = await getAircraftFromOpenSky();

    const aircraft = (data.states || []).map(mapAircraft);

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

// ======================================================
// LOWI ALERTS
// Nur relevante Flugzeuge im Anflug
// ======================================================

app.get("/lowi", async (_req, res) => {
  try {
    const data = await getAircraftFromOpenSky();

    const candidates = [];

    for (const rawAircraft of data.states || []) {
      const aircraft = mapAircraft(rawAircraft);

      // Am Boden befindliche Flugzeuge ignorieren
      if (aircraft.onGround === true) {
        continue;
      }

      const classification = classifyAircraft(aircraft);

      if (!classification.relevant) {
        continue;
      }

      const approach = analyzeApproach(aircraft);

      if (!approach.isApproach) {
        continue;
      }

      candidates.push({
        ...aircraft,

        alert: true,

        type: classification.type,

        approach
      });
    }

    candidates.sort(
      (a, b) =>
        a.approach.distanceKm -
        b.approach.distanceKm
    );

    res.json({
      status: "ok",

      airport: "LOWI",

      alert: candidates.length > 0,

      count: candidates.length,

      aircraft: candidates
    });

  } catch (error) {
    console.error(error);

    res.status(502).json({
      status: "error",
      source: "OpenSky",
      message: "LOWI-Daten konnten nicht abgerufen werden.",
      details: error.message
    });
  }
});

// ======================================================
// Health Check
// ======================================================

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "LOWI Flight Alert"
  });
});

// ======================================================
// SERVER
// ======================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `LOWI Flight Alert läuft auf Port ${PORT}`
  );
});
