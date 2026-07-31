const express = require('express');
const router = express.Router();
const mentorController = require('../controllers/mentor.controller');
const { authenticate } = require('../middleware/auth');
const { forbidMentorGrantManagement } = require('../middleware/mentorAccess');

router.use(authenticate, forbidMentorGrantManagement);

router.get('/', mentorController.list);
router.post('/', mentorController.invite);
router.delete('/:id', mentorController.revoke);

module.exports = router;
