const {
  DATA_START_DATE,
  toDateOnly,
  isBeforeDataStart,
  clampToDataStart,
  assertOnOrAfterDataStart,
  DataStartDateError
} = require('../../src/utils/dataStartDate');

describe('dataStartDate', () => {
  describe('toDateOnly', () => {
    it('passes through a plain date string', () => {
      expect(toDateOnly('2026-07-25')).toBe('2026-07-25');
    });

    it('takes the date portion of an ISO timestamp without re-parsing', () => {
      // Re-parsing through the server's local timezone would shift this to the
      // 24th for anyone west of UTC — the whole reason for the regex path.
      expect(toDateOnly('2026-07-25T02:00:00.000Z')).toBe('2026-07-25');
      expect(toDateOnly('2026-07-25T23:30:00-07:00')).toBe('2026-07-25');
    });

    it('reads Date objects in UTC', () => {
      expect(toDateOnly(new Date('2026-07-25T12:00:00.000Z'))).toBe('2026-07-25');
    });

    it('returns null for empty and unparseable values', () => {
      expect(toDateOnly(null)).toBeNull();
      expect(toDateOnly(undefined)).toBeNull();
      expect(toDateOnly('')).toBeNull();
      expect(toDateOnly('not a date')).toBeNull();
      expect(toDateOnly(new Date('nope'))).toBeNull();
    });
  });

  describe('isBeforeDataStart', () => {
    it('is false on the cutoff day itself', () => {
      expect(isBeforeDataStart(DATA_START_DATE)).toBe(false);
    });

    it('is true the day before and false the day after', () => {
      expect(isBeforeDataStart('2026-07-30')).toBe(true);
      expect(isBeforeDataStart('2026-08-01')).toBe(false);
    });

    it('is false for missing or unreadable dates so nothing is silently dropped', () => {
      expect(isBeforeDataStart(null)).toBe(false);
      expect(isBeforeDataStart('')).toBe(false);
      expect(isBeforeDataStart('garbage')).toBe(false);
    });
  });

  describe('clampToDataStart', () => {
    it('raises earlier dates and null ("all time") to the floor', () => {
      expect(clampToDataStart('2019-01-01')).toBe(DATA_START_DATE);
      expect(clampToDataStart(null)).toBe(DATA_START_DATE);
      expect(clampToDataStart(undefined)).toBe(DATA_START_DATE);
    });

    it('leaves later dates alone and normalizes them to date-only', () => {
      expect(clampToDataStart('2026-09-09')).toBe('2026-09-09');
      expect(clampToDataStart('2026-09-09T14:00:00Z')).toBe('2026-09-09');
    });
  });

  describe('assertOnOrAfterDataStart', () => {
    it('throws a tagged error for pre-cutoff dates', () => {
      expect(() => assertOnOrAfterDataStart('2020-03-05')).toThrow(DataStartDateError);
      try {
        assertOnOrAfterDataStart('2020-03-05');
      } catch (err) {
        expect(err.code).toBe('BEFORE_DATA_START_DATE');
        expect(err.statusCode).toBe(400);
        expect(err.message).toContain(DATA_START_DATE);
        // errorHandler only honours statusCode/body when isAppError is set —
        // without it this would surface as a generic 500.
        expect(err.isAppError).toBe(true);
        expect(err.body).toMatchObject({
          code: 'BEFORE_DATA_START_DATE',
          dataStartDate: DATA_START_DATE
        });
      }
    });

    it('permits the cutoff day, later days, and absent dates', () => {
      expect(() => assertOnOrAfterDataStart(DATA_START_DATE)).not.toThrow();
      expect(() => assertOnOrAfterDataStart('2027-01-01')).not.toThrow();
      expect(() => assertOnOrAfterDataStart(null)).not.toThrow();
    });
  });

  it('stays in sync with the frontend mirror in frontend/src/config/dataStart.js', () => {
    const fs = require('fs');
    const path = require('path');
    const mirror = fs.readFileSync(
      path.join(__dirname, '../../../frontend/src/config/dataStart.js'),
      'utf8'
    );
    expect(mirror).toContain(`export const DATA_START_DATE = '${DATA_START_DATE}'`);
  });

  it('stays in sync with the literal purge date in migration 242', () => {
    const fs = require('fs');
    const path = require('path');
    const migration = fs.readFileSync(
      path.join(__dirname, '../../migrations/242_raise_data_start_to_2026_07_31.sql'),
      'utf8'
    );
    // Every date literal in the migration must be the cutoff — a stray date
    // would purge or admit the wrong range.
    const literals = [...migration.matchAll(/(?:DATE|TIMESTAMPTZ) '(\d{4}-\d{2}-\d{2})/g)]
      .map(match => match[1]);
    expect(literals.length).toBeGreaterThan(0);
    expect([...new Set(literals)]).toEqual([DATA_START_DATE]);
  });
});

