import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

const LOWI_LAT = 47.2602;
const LOWI_LON = 11.3440;

// Testseite
app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "LOWI Flight Alert",
    message: "Server läuft."
  });
});

// OpenSky-Daten für den Bereich rund um Innsbruck
app.get("/aircraft", async (_req, res) => {
  try {
    const url =
      "https://opensky-network.org/api/states/all" +
      "?lamin=47.05&lomin=11.05&lamax=47.47&lomax=11.65";

    const response = await fetch(url);

    if (!response.ok) {
      const errorText = await response.text();

      return res.status(502).json({
        status: "error",
        source: "OpenSky",
        openSkyStatus: response.status,
        openSkyMessage: errorText || "Keine Fehlermeldung von OpenSky"
      });
    }

    const data = await response.json();

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
      airport: "LOWI",
      airportPosition: {
        latitude: LOWI_LAT,
        longitude: LOWI_LON
      },
      aircraft
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      status: "error",
      message: "OpenSky-Daten konnten nicht abgerufen werden.",
      details: error.message
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`LOWI Flight Alert läuft auf Port ${PORT}`);
});
