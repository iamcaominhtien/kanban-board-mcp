import { describe, expect, it } from 'vitest';
import { formatValue, isDateFormat } from './numFmt';

const f = (v: number | string, code: string) => formatValue(v, code).text;

describe('formatValue', () => {
  it('shows General the way Excel does', () => {
    expect(f(3.14159, 'General')).toBe('3.14159');
    expect(f(1234567, 'General')).toBe('1234567');
    expect(f(0.1 + 0.2, 'General')).toBe('0.3');
    expect(f('text', 'General')).toBe('text');
  });

  it('shows decimals, thousands, percent, currency and scaling', () => {
    expect(f(1234.5, '#,##0.00')).toBe('1,234.50');
    expect(f(0.256, '0%')).toBe('26%');
    expect(f(0.256, '0.0%')).toBe('25.6%');
    expect(f(1234.5, '"$"#,##0')).toBe('$1,235');
    expect(f(7, '000')).toBe('007');
    expect(f(1234567, '#,##0,')).toBe('1,235');
    expect(f(12345, '0.00E+00')).toBe('1.23E+04');
    expect(f(-1.5, '0.00')).toBe('-1.50');
    expect(f(2.5, '0.0#')).toBe('2.5');
  });

  it('uses the sections for negative and zero values and takes the colour', () => {
    expect(f(-1234, '#,##0;(#,##0)')).toBe('(1,234)');
    expect(f(0, '0;-0;"zero"')).toBe('zero');
    expect(formatValue(5, '[Red]0.0').color).toBe('#ff0000');
    expect(f('hi', '@" !"')).toBe('hi !');
  });

  it('shows dates and times', () => {
    expect(f(45000, 'yyyy-mm-dd')).toBe('2023-03-15');
    expect(f(45000, 'm/d/yyyy')).toBe('3/15/2023');
    expect(f(45000, 'd mmm yyyy')).toBe('15 Mar 2023');
    expect(f(45000, 'dddd, mmmm d')).toBe('Wednesday, March 15');
    expect(f(0.75, 'h:mm AM/PM')).toBe('6:00 PM');
    expect(f(0.5, 'hh:mm:ss')).toBe('12:00:00');
    expect(f(45000.25, 'yyyy-mm-dd hh:mm')).toBe('2023-03-15 06:00');
    expect(f(1.5, '[h]:mm')).toBe('36:00');
  });

  it('knows a date format from a number format', () => {
    expect(isDateFormat('yyyy-mm-dd')).toBe(true);
    expect(isDateFormat('h:mm AM/PM')).toBe(true);
    expect(isDateFormat('#,##0.00')).toBe(false);
    expect(isDateFormat('0.0"d"')).toBe(false);
  });
});
