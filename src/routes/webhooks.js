const express = require('express');

function createWebhooksRouter(io) {
  const router = express.Router();
  router.use(express.json());

  router.post('/seat-booked', (req, res) => {
    const { trip_id, vehicle_id, seats } = req.body || {};
    if (!trip_id) {
      return res.status(400).json({ error: 'trip_id is required' });
    }
    const room = 'trip:' + String(trip_id);
    io.to(room).emit('seat_booked', {
      trip_id: String(trip_id),
      vehicle_id: vehicle_id != null ? String(vehicle_id) : null,
      seats: Array.isArray(seats) ? seats : [],
    });
    res.status(200).json({ ok: true });
  });

  return router;
}

module.exports = createWebhooksRouter;
