import {
  CODE_LIST_RELEASE,
  EINVOICE_SPEC_VERSIONS,
  defaultEinvoiceOptions,
  einvoiceOptionsSchema,
  resolveEinvoiceOptions,
} from './index';

describe('resolveEinvoiceOptions', () => {
  it('is nothing when nothing declares an e-invoice', () => {
    expect(resolveEinvoiceOptions()).toEqual({ ok: true, options: null });
    expect(resolveEinvoiceOptions(undefined, null)).toEqual({
      ok: true,
      options: null,
    });
  });

  it('fills in the defaults of a bare declaration', () => {
    expect(resolveEinvoiceOptions({})).toEqual({
      ok: true,
      options: defaultEinvoiceOptions,
    });
    expect(defaultEinvoiceOptions).toEqual({
      profile: 'en16931',
      flavour: 'factur-x',
      xml: 'embedded',
      display_check: 'warn',
    });
  });

  it('merges field by field, the later layer winning', () => {
    const template = {
      profile: 'basic',
      flavour: 'zugferd',
      display_check: 'strict',
    } as const;
    const resolved = resolveEinvoiceOptions(
      template,
      { xml: 'both' },
      { profile: 'en16931' },
    );
    expect(resolved).toEqual({
      ok: true,
      options: {
        profile: 'en16931',
        flavour: 'zugferd',
        xml: 'both',
        display_check: 'strict',
      },
    });
  });

  it('does not let an absent field of a later layer erase an earlier one', () => {
    const resolved = resolveEinvoiceOptions(
      { profile: 'basic' },
      { profile: undefined, xml: 'both' },
    );
    expect(resolved.ok && resolved.options?.profile).toBe('basic');
  });

  it("lets a request switch a template's declaration off, and a later layer on again", () => {
    expect(resolveEinvoiceOptions({ profile: 'basic' }, false)).toEqual({
      ok: true,
      options: null,
    });
    const again = resolveEinvoiceOptions({ profile: 'basic' }, false, {
      xml: 'both',
    });
    // what came before the `false` is gone, so the profile is the default again
    expect(again.ok && again.options).toEqual({
      ...defaultEinvoiceOptions,
      xml: 'both',
    });
  });

  it('answers a profile we do not emit with its reason, not as a malformed request', () => {
    for (const profile of [
      'minimum',
      'basic-wl',
      'BASICWL',
      'extended',
      'XRechnung',
    ]) {
      expect(einvoiceOptionsSchema.safeParse({ profile }).success).toBe(true);
      const resolved = resolveEinvoiceOptions({ profile });
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        expect(resolved.field).toBe('profile');
        expect(resolved.reason).toMatch(/use (basic or )?en16931/);
      }
    }
    const unknown = resolveEinvoiceOptions({ profile: 'comfort' });
    expect(!unknown.ok && unknown.reason).toBe(
      'Unknown profile; use basic or en16931',
    );
    const flavour = resolveEinvoiceOptions({ flavour: 'peppol' });
    expect(!flavour.ok && flavour.field).toBe('flavour');
  });

  it('takes the names in any case', () => {
    const resolved = resolveEinvoiceOptions({
      profile: 'EN16931',
      flavour: 'ZUGFeRD',
    });
    expect(resolved.ok && resolved.options).toMatchObject({
      profile: 'en16931',
      flavour: 'zugferd',
    });
  });
});

describe('einvoiceOptionsSchema', () => {
  it('refuses a field it does not know and a value outside its list', () => {
    expect(einvoiceOptionsSchema.safeParse({ profil: 'basic' }).success).toBe(
      false,
    );
    expect(einvoiceOptionsSchema.safeParse({ xml: 'separate' }).success).toBe(
      false,
    );
    expect(
      einvoiceOptionsSchema.safeParse({ display_check: 'off' }).success,
    ).toBe(false);
    expect(
      einvoiceOptionsSchema.safeParse({ xml: 'both', display_check: 'strict' })
        .success,
    ).toBe(true);
  });
});

describe('the pinned release', () => {
  it("is one release under its two names, and the code lists are that release's", () => {
    // ZUGFeRD 2.5 and Factur-X 1.09 are the same document; the lists carry its patch level
    expect(EINVOICE_SPEC_VERSIONS).toEqual({
      'factur-x': '1.09',
      zugferd: '2.5',
    });
    expect(
      CODE_LIST_RELEASE.startsWith(`${EINVOICE_SPEC_VERSIONS['factur-x']}.`),
    ).toBe(true);
  });
});
