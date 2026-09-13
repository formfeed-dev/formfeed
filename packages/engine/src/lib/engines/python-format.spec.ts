import { formatValue, pythonFormat } from './python-format';

describe('pythonFormat', () => {
  it('formats numbers the way Python does', () => {
    const cases: Array<[string, unknown[], string]> = [
      ['{:,.2f}', [1234.5], '1,234.50'],
      ['{:.0f}', [72], '72'],
      ['{:,.{}f}', [28.8, 2], '28.80'],
      ['{:,.{}f}', [1234567, 0], '1,234,567'],
      ['{:_d}', [1234567], '1_234_567'],
      ['{:08.3f}', [-3.14159], '-003.142'],
      ['{:+.1%}', [0.256], '+25.6%'],
      ['{:.2e}', [1234.5], '1.23e+03'],
      ['{:g}', [0.00001234], '1.234e-05'],
      ['{:g}', [28.8], '28.8'],
      ['{:#x}', [255], '0xff'],
      ['{:>6}', ['ab'], '    ab'],
      ['{:*^7}', ['ab'], '**ab***'],
      ['{:<5}|', [42], '42   |'],
      ['{:.3}', ['abcdef'], 'abc'],
    ];
    for (const [template, args, expected] of cases) expect(pythonFormat(template, args)).toBe(expected);
  });

  it('resolves numbered, named and attribute fields and keeps escaped braces', () => {
    expect(pythonFormat('{1}-{0}', ['a', 'b'])).toBe('b-a');
    expect(pythonFormat('{name}: {total:.2f}', [], { name: 'Sum', total: 3 })).toBe('Sum: 3.00');
    expect(pythonFormat('{0.city} {0[zip]}', [{ city: 'Berlin', zip: '10115' }])).toBe('Berlin 10115');
    expect(pythonFormat('{{literal}} {}', ['x'])).toBe('{literal} x');
    expect(pythonFormat('{} and {missing}', ['a'])).toBe('a and ');
  });

  it('treats numeric strings as numbers for numeric types only', () => {
    expect(formatValue('12.5', '.1f')).toBe('12.5');
    expect(formatValue('12.5', '>6')).toBe('  12.5');
    expect(formatValue('n/a', '.1f')).toBe('n/a');
  });
});
