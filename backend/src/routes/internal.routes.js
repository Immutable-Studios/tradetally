const express = require('express');
const router = express.Router();
const internalCrmSyncController = require('../controllers/internalCrmSync.controller');
const dailyReviewCronController = require('../controllers/dailyReviewCron.controller');
const { requireInternalServiceAuth } = require('../middleware/internalServiceAuth');
const { validate, schemas } = require('../middleware/validation');

router.use(requireInternalServiceAuth);

// External cron. The in-process scheduler cannot be relied on while the app
// sleeps when idle, so an outside scheduler POSTs here to wake the app and run
// the batch. See controllers/dailyReviewCron.controller.js.
router.post('/cron/daily-review', dailyReviewCronController.runDailyBatch);
router.get('/cron/daily-review/status', dailyReviewCronController.getStatus);

router.get('/kestra/crm-sync/status', internalCrmSyncController.getStatus);
router.post('/kestra/crm-sync', validate(schemas.internalCrmSyncRun), internalCrmSyncController.runFullSync);
router.post('/kestra/crm-sync/twenty', validate(schemas.internalCrmSyncRun), (req, res, next) => {
  req.body = { ...(req.body || {}), targets: ['twenty'] };
  return internalCrmSyncController.runFullSync(req, res, next);
});
router.post('/kestra/crm-sync/invoice-ninja', validate(schemas.internalCrmSyncRun), (req, res, next) => {
  req.body = { ...(req.body || {}), targets: ['invoiceNinja'] };
  return internalCrmSyncController.runFullSync(req, res, next);
});
router.post('/kestra/crm-sync/users/:userId', validate(schemas.internalCrmSyncUserRun), internalCrmSyncController.syncUser);
router.post('/kestra/crm-sync/users/:userId/twenty', validate(schemas.internalCrmSyncUserRun), (req, res, next) => {
  req.body = { ...(req.body || {}), targets: ['twenty'] };
  return internalCrmSyncController.syncUser(req, res, next);
});
router.post('/kestra/crm-sync/users/:userId/invoice-ninja', validate(schemas.internalCrmSyncUserRun), (req, res, next) => {
  req.body = { ...(req.body || {}), targets: ['invoiceNinja'] };
  return internalCrmSyncController.syncUser(req, res, next);
});
router.post('/kestra/crm-sync/users/:userId/invoice-ninja/revenue', validate(schemas.internalCrmSyncUserRun), internalCrmSyncController.syncUserRevenue);

module.exports = router;
