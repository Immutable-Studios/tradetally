jest.mock('../../src/models/Trade', () => ({ create: jest.fn() }));
jest.mock('../../src/models/Diary', () => ({ create: jest.fn() }));
jest.mock('../../src/models/Account', () => ({ create: jest.fn() }));

const SampleDataService = require('../../src/services/sampleDataService');
const { DATA_START_DATE } = require('../../src/utils/dataStartDate');

const FLOOR = new Date(`${DATA_START_DATE}T00:00:00Z`);

describe('getTradingDays', () => {
  it('returns the requested number of days, oldest first', () => {
    const days = SampleDataService.getTradingDays(5);

    expect(days).toHaveLength(5);
    for (let i = 1; i < days.length; i++) {
      expect(days[i].getTime()).toBeGreaterThanOrEqual(days[i - 1].getTime());
    }
  });

  it('never returns a day before the data start date', () => {
    // Unclamped this walks back from yesterday, and Trade.create rejects
    // anything older — which would fail every sample trade and with it new-user
    // onboarding until the cutoff is far enough in the past.
    const days = SampleDataService.getTradingDays(60);

    for (const day of days) {
      expect(day.getTime()).toBeGreaterThanOrEqual(FLOOR.getTime());
    }
  });

  it('skips weekends', () => {
    const days = SampleDataService.getTradingDays(10);

    for (const day of days) {
      // Clamped days collapse onto the cutoff, which may itself be a weekend;
      // only the unclamped ones carry the weekday guarantee.
      if (day.getTime() !== FLOOR.getTime()) {
        expect([0, 6]).not.toContain(day.getDay());
      }
    }
  });

  it('handles a zero-day request', () => {
    expect(SampleDataService.getTradingDays(0)).toEqual([]);
  });

  it('returns real Date objects, not strings', () => {
    for (const day of SampleDataService.getTradingDays(3)) {
      expect(day).toBeInstanceOf(Date);
      expect(Number.isNaN(day.getTime())).toBe(false);
    }
  });

  it('clamps to the floor rather than dropping days', () => {
    // A caller asking for 200 days still gets 200 entries; the excess bunches
    // on the cutoff and spreads out on its own as the cutoff recedes.
    expect(SampleDataService.getTradingDays(200)).toHaveLength(200);
  });
});
