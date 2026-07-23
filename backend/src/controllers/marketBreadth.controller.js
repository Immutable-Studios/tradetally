const marketBreadthService = require('../services/marketBreadthService');

const marketBreadthController = {
  async getBoard(req, res) {
    try {
      const payload = await marketBreadthService.getBoard();
      const status = payload.ok ? 200 : payload.needsReauth ? 503 : 502;
      return res.status(status).json(payload);
    } catch (error) {
      console.error('[MARKET-BREADTH] getBoard failed:', error.message);
      return res.status(500).json({
        ok: false,
        error: 'Failed to load market breadth board',
        sections: []
      });
    }
  }
};

module.exports = marketBreadthController;
