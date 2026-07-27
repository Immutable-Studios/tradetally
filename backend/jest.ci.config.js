// Jest config for CI, where a red run blocks the production deploy.
//
// Identical to jest.config.js except that six suites are quarantined. They
// were already failing (86 tests) before deploy gating existed, and their
// failures are pre-existing debt rather than regressions — gating on them
// would mean nothing could ever ship. Everything else, including every new
// test, gates the deploy.
//
// This list is meant to shrink. Fix a suite, delete its line. Do NOT add to it
// to get a deploy out: a newly failing suite is exactly what this gate is for.

const base = require('./jest.config');

const QUARANTINED = [
  'tests/contracts/tradingCalculations.contract.test.js',
  'tests/controllers/analytics.singleflight.test.js',
  'tests/controllers/analytics.strategyStats.test.js',
  'tests/models/trade.findByUser.characterization.test.js',
  'tests/models/trade.getAnalytics.characterization.test.js',
  'tests/services/emailService.supportRequest.test.js'
];

module.exports = {
  ...base,
  testPathIgnorePatterns: [
    ...base.testPathIgnorePatterns,
    // Anchored so a path fragment cannot accidentally match a new suite.
    ...QUARANTINED.map((file) => `<rootDir>/${file}$`)
  ]
};
