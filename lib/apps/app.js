const express = require('express');

const historyGraph = require('../history-graph.js');
const redis = require('../redis.js');
const render = require('../render.js');
const Alert = require('../bot/alert.js');
const email = require('../bot/send-email.js');
const sms = require('../bot/send-sms.js');

const app = express();

// PERSIST BASE URL
app.use((req, res, next) => {
  const protocol = req.protocol;
  const host = req.get('host');
  const basePath = `${protocol}://${host}`;
  redis.setAsync('__BASE_PATH', basePath);
  next();
});

// LIST
app.get('/', async (req, res) => {
  const keys = await redis.keysAsync('alert.*');
  const values = keys.length ? await redis.mgetAsync(keys) : [];
  const alerts = values
    .map(v => new Alert(v))
    .filter(alert => req.auth.isAdmin || alert.phone === req.auth.user)
    .sort((a, b) => a.date - b.date);
  res.send(render('list', req, { alerts }));
});

// CREATE
app.post('/', async (req, res) => {
  const alert = new Alert(req.body);
  await redis.setAsync(alert.key(), alert.toJSON());
  res.status(303).location(`/show/${alert.id}`).end();

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
});

// EDIT
app.get('/edit/:id', async (req, res) => {
  const data = await redis.getAsync(`alert.${req.params.id}`);
  const alert = new Alert(data);
  res.send(render('edit', req, { alert }));
});

// UPDATE
app.post('/update/:id', async (req, res) => {
  const oldAlert = new Alert(await redis.getAsync(`alert.${req.params.id}`));
  const resetPriceHistory = (new Alert(oldAlert.data)).signature === (new Alert(req.body)).signature ? {} : { priceHistory: [] };
  const alert = new Alert(Object.assign({}, oldAlert.data, req.body, resetPriceHistory));
  await redis.setAsync(alert.key(), alert.toJSON());
  await redis.delAsync(alert.key('cooldown'));
  res.status(303).location(`/show/${alert.id}`).end();

  await alert.getLatestPrice();
  await redis.setAsync(alert.key(), alert.toJSON());
});

// DELETE
app.get('/delete/:id', async (req, res) => {
  await redis.delAsync(`alert.${req.params.id}`);
  await redis.delAsync(`cooldown.${req.params.id}`);
  res.status(303).location('/').end();
});

// NEW
app.get('/new', async (req, res) => {
  res.send(render('new', req));
});

// SHOW
app.get('/show/:id', async (req, res) => {
  const data = await redis.getAsync(`alert.${req.params.id}`);
  const alert = new Alert(data);
  const graph = alert.data.priceHistory.length ? historyGraph(alert) : '';
  res.send(render('show', req, { alert, graph }));
});

// CHANGE PRICE
app.get('/change-price/:id', async (req, res) => {
  const data = await redis.getAsync(`alert.${req.params.id}`);
  const alert = new Alert(data);
  const newPrice = parseInt(req.query.price, 10);
  if (newPrice < alert.data.price) {
    alert.data.price = newPrice;
    await redis.setAsync(alert.key(), alert.toJSON());
    await redis.delAsync(alert.key('cooldown'));
  }
  res.status(303).location(`/show/${alert.id}`).end();
});

module.exports = app;
