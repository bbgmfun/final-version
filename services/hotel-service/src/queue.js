const amqp = require('amqplib');

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://rabbitmq:5672';
const RESERVATION_QUEUE = process.env.RESERVATION_QUEUE || 'reservations';

let channel = null;
const pendingBuffer = [];

async function connect() {
  let attempts = 0;
  while (attempts < 20) {
    try {
      const conn = await amqp.connect(RABBITMQ_URL);
      conn.on('close', () => {
        console.warn('[hotel] rabbitmq closed, will reconnect');
        channel = null;
        setTimeout(connect, 3000);
      });
      conn.on('error', (err) => console.warn('[hotel] rabbitmq error:', err.message));
      const ch = await conn.createChannel();
      await ch.assertQueue(RESERVATION_QUEUE, { durable: true });
      channel = ch;
      console.log('[hotel] rabbitmq connected, queue:', RESERVATION_QUEUE);
      // Flush any buffered messages
      while (pendingBuffer.length) {
        const msg = pendingBuffer.shift();
        channel.sendToQueue(RESERVATION_QUEUE, Buffer.from(JSON.stringify(msg)), {
          persistent: true
        });
      }
      return;
    } catch (err) {
      attempts += 1;
      console.warn(`[hotel] rabbitmq connect failed (attempt ${attempts}):`, err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.error('[hotel] giving up on rabbitmq for now; will buffer in memory');
}

function publishReservation(payload) {
  if (!channel) {
    pendingBuffer.push(payload);
    return false;
  }
  channel.sendToQueue(RESERVATION_QUEUE, Buffer.from(JSON.stringify(payload)), {
    persistent: true
  });
  return true;
}

module.exports = { connect, publishReservation };
