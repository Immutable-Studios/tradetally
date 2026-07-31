const express = require('express');
const router = express.Router();
const apiKeyController = require('../controllers/apiKey.controller');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { requiresTier } = require('../middleware/tierAuth');
const { validate, schemas } = require('../middleware/validation');
const { forbidMentorAccountChanges } = require('../middleware/mentorAccess');

// API keys are a Pro-only integration feature.
router.use(authenticate);
router.use(requiresTier('pro'));

// Create a new API key
router.post('/',
  forbidMentorAccountChanges,
  validate(schemas.createApiKey), 
  apiKeyController.createApiKey
);

// Get all API keys for the current user
router.get('/', apiKeyController.getUserApiKeys);

// Get a specific API key
router.get('/:keyId', apiKeyController.getApiKey);

// Update an API key
router.put('/:keyId',
  forbidMentorAccountChanges,
  validate(schemas.updateApiKey), 
  apiKeyController.updateApiKey
);

// Delete an API key
router.delete('/:keyId', forbidMentorAccountChanges, apiKeyController.deleteApiKey);

// Admin routes
router.get('/admin/all', requireAdmin, apiKeyController.getAllApiKeys);

module.exports = router;
