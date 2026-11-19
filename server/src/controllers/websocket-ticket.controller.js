const { issueTicket } = require("../services/websocket-ticket.service");

function createWebSocketTicketController({ issueTicketFn = issueTicket } = {}) {
  return async function createWebSocketTicket(req, res) {
    try {
      const result = await issueTicketFn({
        userId: req.user.id,
        role: req.user.role,
      });

      return res.status(200).json(result);
    } catch (error) {
      if (error.statusCode === 403 || error.statusCode === 503) {
        return res.status(error.statusCode).json({
          message: error.message,
        });
      }

      console.error("WebSocket ticket creation failed:", error.message);

      return res.status(500).json({
        message: "Internal server error",
      });
    }
  };
}

const createWebSocketTicket = createWebSocketTicketController();

module.exports = {
  createWebSocketTicket,
  createWebSocketTicketController,
};
