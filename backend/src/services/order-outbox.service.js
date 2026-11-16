const EVENT_TYPE = "order.receipt.requested";

function createOrderOutboxService() {
  async function addOrderReceiptEvent(client, orderId) {
    await client.query(
      `INSERT INTO order_outbox (event_type, order_id, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (event_type, order_id) DO NOTHING`,
      [EVENT_TYPE, orderId, JSON.stringify({ orderId })],
    );
  }

  return { addOrderReceiptEvent };
}

const service = createOrderOutboxService();

module.exports = {
  EVENT_TYPE,
  createOrderOutboxService,
  addOrderReceiptEvent: service.addOrderReceiptEvent,
};
