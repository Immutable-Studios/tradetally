const AccountMentor = require('../models/AccountMentor');
const User = require('../models/User');
const EmailService = require('../services/emailService');
const { normalizeEmail } = require('../utils/normalizeEmail');

function publicMentorRow(row) {
  return {
    id: row.id,
    email: row.mentor_email,
    status: row.status,
    username: row.mentor_username || null,
    fullName: row.mentor_full_name || null,
    invitedAt: row.invited_at,
    acceptedAt: row.accepted_at
  };
}

const mentorController = {
  async list(req, res, next) {
    try {
      const mentors = await AccountMentor.listForOwner(req.user.id);
      res.json({ mentors: mentors.map(publicMentorRow) });
    } catch (error) {
      next(error);
    }
  },

  async invite(req, res, next) {
    try {
      const email = normalizeEmail(req.body?.email);
      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'A valid email address is required' });
      }

      if (normalizeEmail(req.user.email) === email) {
        return res.status(400).json({ error: 'You cannot add yourself as a mentor' });
      }

      const existingUser = await User.findByEmail(email);
      const mentor = await AccountMentor.invite({
        ownerUserId: req.user.id,
        mentorEmail: email,
        mentorUserId: existingUser?.id || null
      });

      const ownerName = req.user.full_name || req.user.username || req.user.email;
      try {
        await EmailService.sendMentorInviteEmail(email, {
          ownerName,
          ownerEmail: req.user.email,
          inviteToken: mentor.invite_token,
          alreadyRegistered: Boolean(existingUser)
        });
      } catch (emailErr) {
        console.warn('[MENTOR] Failed to send invite email:', emailErr.message);
      }

      const mentors = await AccountMentor.listForOwner(req.user.id);
      const created = mentors.find((m) => m.id === mentor.id) || mentor;

      res.status(201).json({
        message: existingUser
          ? 'Mentor added. They can access your journal the next time they log in.'
          : 'Mentor invited. They will get an email to create an account and join.',
        mentor: publicMentorRow({
          ...created,
          mentor_email: mentor.mentor_email,
          mentor_username: created.mentor_username,
          mentor_full_name: created.mentor_full_name
        })
      });
    } catch (error) {
      if (error.code === 'MENTOR_EXISTS') {
        return res.status(409).json({ error: error.message });
      }
      next(error);
    }
  },

  async revoke(req, res, next) {
    try {
      const revoked = await AccountMentor.revoke(req.user.id, req.params.id);
      if (!revoked) {
        return res.status(404).json({ error: 'Mentor not found' });
      }
      res.json({ message: 'Mentor access removed' });
    } catch (error) {
      next(error);
    }
  }
};

module.exports = mentorController;
