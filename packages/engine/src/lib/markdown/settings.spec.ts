import { describe, expect, it } from 'vitest';
import {
  MARKDOWN_LIMITS,
  MARKDOWN_REFUSALS,
  isMarkdownSettings,
  markdownSettingsProblem,
  markdownTextWithinLimit,
  markdownVersion,
  resolveMarkdown,
} from './settings';

describe('settings.markdown', () => {
  it('fills the defaults', () => {
    const defaults = {
      theme: 'document',
      html: 'safe',
      breaks: false,
      css: '',
    };
    expect(resolveMarkdown(undefined)).toEqual(defaults);
    expect(resolveMarkdown(null)).toEqual(defaults);
    expect(resolveMarkdown({})).toEqual(defaults);
    expect(
      resolveMarkdown({
        theme: 'none',
        html: 'allow',
        breaks: true,
        css: 'p{}',
      }),
    ).toEqual({
      theme: 'none',
      html: 'allow',
      breaks: true,
      css: 'p{}',
    });
  });

  it('reads a value the API would have refused as its default, since a render never fails on its look', () => {
    expect(
      resolveMarkdown({ theme: 'github', html: 'yes', breaks: 'true', css: 1 }),
    ).toEqual({
      theme: 'document',
      html: 'safe',
      breaks: false,
      css: '',
    });
    expect(resolveMarkdown('document')).toEqual(resolveMarkdown(undefined));
  });

  it('is strict: every refusal names its field', () => {
    expect(markdownSettingsProblem(undefined)).toBeNull();
    expect(
      markdownSettingsProblem({
        theme: 'none',
        html: 'allow',
        breaks: true,
        css: '',
      }),
    ).toBeNull();
    expect(markdownSettingsProblem('safe')).toEqual({
      field: 'settings.markdown',
      message: MARKDOWN_REFUSALS.notObject,
    });
    expect(markdownSettingsProblem([])).toEqual({
      field: 'settings.markdown',
      message: MARKDOWN_REFUSALS.notObject,
    });
    expect(markdownSettingsProblem({ themes: 'none' })).toEqual({
      field: 'settings.markdown.themes',
      message:
        'settings.markdown.themes is not a setting: the settings are theme, html, breaks, css',
    });
    expect(markdownSettingsProblem({ theme: 'github' })).toEqual({
      field: 'settings.markdown.theme',
      message: MARKDOWN_REFUSALS.theme,
    });
    expect(markdownSettingsProblem({ html: 'sanitize' })).toEqual({
      field: 'settings.markdown.html',
      message: MARKDOWN_REFUSALS.html,
    });
    expect(markdownSettingsProblem({ breaks: 'yes' })).toEqual({
      field: 'settings.markdown.breaks',
      message: MARKDOWN_REFUSALS.breaks,
    });
    expect(markdownSettingsProblem({ css: ['p{}'] })).toEqual({
      field: 'settings.markdown.css',
      message: MARKDOWN_REFUSALS.css,
    });
    expect(isMarkdownSettings({ html: 'safe' })).toBe(true);
    expect(isMarkdownSettings({ html: 'raw' })).toBe(false);
  });

  it('counts the limits in UTF-8 bytes', () => {
    expect(
      markdownSettingsProblem({ css: 'a'.repeat(MARKDOWN_LIMITS.cssBytes) }),
    ).toBeNull();
    expect(
      markdownSettingsProblem({
        css: 'a'.repeat(MARKDOWN_LIMITS.cssBytes + 1),
      }),
    ).toEqual({
      field: 'settings.markdown.css',
      message: 'settings.markdown.css is larger than 256 kB',
    });
    // a character of three bytes: a third as many fit
    expect(
      markdownSettingsProblem({
        css: '€'.repeat(MARKDOWN_LIMITS.cssBytes / 3 + 1),
      })?.field,
    ).toBe('settings.markdown.css');
    expect(markdownTextWithinLimit('a'.repeat(MARKDOWN_LIMITS.textBytes))).toBe(
      true,
    );
    expect(
      markdownTextWithinLimit('a'.repeat(MARKDOWN_LIMITS.textBytes + 1)),
    ).toBe(false);
    expect(
      markdownTextWithinLimit('ü'.repeat(MARKDOWN_LIMITS.textBytes / 2 + 1)),
    ).toBe(false);
    expect(MARKDOWN_REFUSALS.textTooLarge).toBe('markdown is larger than 1 MB');
  });

  it('names the converter and the theme as a render records them', () => {
    expect(markdownVersion('document')).toBe(
      'markdown-it 15.0.3, rules 1, theme document 1',
    );
    expect(markdownVersion('none')).toBe(
      'markdown-it 15.0.3, rules 1, theme none 1',
    );
  });
});
