const express = require('express');
const cheerio = require('cheerio');
const loadJsonFile = require('load-json-file');
const airportCodes = require('../bot/validate-airport.js');
const chrono = require('chrono-node');
const redis = require('../redis.js');
const Alert = require('../bot/alert.js');
const email = require('../bot/send-email.js');
const sms = require('../bot/send-sms.js');

const app = express();

// HANDLE EMAIL
app.get('/email', async (req, res) => {
  console.log("Nothing here...");
  res.status(303).location('/').end();
});

app.post('/email', async (req, res) => {
  console.log("req on email hit")
  console.log(req.body.subject);
  parseEmailJSON(req.body);
  res.status(200).send(req.body);
  //res.sendStatus(200);
});


app.use((req, res, next) => {
  next();
});

function getAirportCodes(str) {
  const regex = /\(([A-Z]{3})\)/g;
  let m;
  let codes = [];
  while ((m = regex.exec(str)) !== null) {
    if (m.index === regex.lastIndex) {
      regex.lastIndex++;
    }

    // Since we are matching the same pattern multiple times we want the capture group of each match
    m.forEach((match, groupIndex) => {
      if (groupIndex === 1)
        codes.push(match);
    });
  }
  return codes;
}

function getFare(str) {
  const regex = /Fare Rule.*WN [A-Z]{3}(\d+\.?\d*)WN [A-Z]{3}(\d+\.?\d*)USD(\d+\.?\d*)END/g;
  let m;
  let fares = [];
  while ((m = regex.exec(str)) !== null) {
    if (m.index === regex.lastIndex) {
      regex.lastIndex++;
    }

    // Since we are matching the whole string the 0 match is the string.
    m.forEach((match, groupIndex) => {
      if (groupIndex > 0)
        fares.push(match);
    });
  }
  return fares;
}

async function parseEmailJSON(json) {
  const $ = cheerio.load(json["body-html"]);

  let data = [];
  let flightDataRowStart = -1;
  const startRegex = /AIR Confirmation:/;

  let flightDataRowEnd = -1;
  const stopRegex = /Useful Tools/;


  $('table[width=490] td div').each(function(i, elem) {
    let text = $(this).text().replace(/\s+/g, ' ').trim();
    if (text && text.length > 0) {
      if (flightDataRowStart < 0) {
        // check for startRegex
        if (startRegex.test(text)) {
          flightDataRowStart = i;
        }
      } else {
        // start looking for stopRegex
        if (stopRegex.test(text)) {
          flightDataRowEnd = i;
          return;
        } else {
          data.push(text);
        }
      }
    }
  });

  let flights = [];
  let fares = [];
  // Iterate the data looking for flights
  for (var i = 0; i < data.length; i++) {
    const FLIGHT_KEY = "Departure/Arrival";
    const FARE_KEY = "Fare Rule";
    if(data[i].indexOf(FLIGHT_KEY) != -1) {
      // Next row is the date of this leg
      let flightDate = chrono.parseDate(data[i+1]);
      // The following row i+2 is the flight number
      let flightNumber = parseInt(data[i+2]);
      // Third is a description of the flight
      let airports = getAirportCodes(data[i+3]);

      // Validate everything
      if (flightDate && flightNumber && airportCodes.codeIsValid(airports[0]) && airportCodes.codeIsValid(airports[1]) ) {
        flights.push({date: flightDate, number: flightNumber+",", from: airports[0], to: airports[1]});
      } else {
        console.log("Couldn't parse flight! Date: "+flightDate+", "+data[i+1]+"; number: "+flightNumber+", "+data[i+2]+"; airports: "+airports.join(", ")+", "+data[i+3]);
      }
    }
    if(data[i].indexOf(FARE_KEY) != -1) {
      fares = getFare(data[i]);
    }
  }
  for (var i = 0; i < fares.length; i++) {
    if (fares[i] && flights[i]) {
      flights[i].price = fares[i];
    }
  }

  console.log(flights);
  console.log(fares);
  console.log();

  for (var i = 0; i < flights.length; i++) {
    const alert = new Alert(flights[i]);
    console.log("hello");
    await redis.setAsync(alert.key(), alert.toJSON());

    const message = [
      `Alert created for Southwest flight #${alert.number} from `,
      `${alert.from} to ${alert.to} on ${alert.formattedDate}. `,
      `We'll text you if the price drops below $${alert.price}.`
    ].join('');

    if (email.enabled) {
      email.sendEmail(message);
    }

    if (sms.enabled) {
      sms.sendSms(alert.phone, message);
    }

    await alert.getLatestPrice();
    await redis.setAsync(alert.key(), alert.toJSON());
  }
}


module.exports = app;