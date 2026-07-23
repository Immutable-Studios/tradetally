const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const marketBreadthController = require('../controllers/marketBreadth.controller');

router.get('/', authenticate, marketBreadthController.getBoard);

module.exports = router;
