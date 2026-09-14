import { describe, expect, it } from 'vitest';
import { defaultOutput, imageOutput, isOutputFormat } from './output';

describe('defaultOutput', () => {
  it('renders PDF templates and sources without a kind as PDF', () => {
    expect(defaultOutput('pdf', { image: { format: 'jpeg' } })).toBe('pdf');
    expect(defaultOutput(null)).toBe('pdf');
    expect(defaultOutput(undefined, { image: { format: 'webp' } })).toBe('pdf');
  });

  it('takes the image format of an image template, PNG without one', () => {
    expect(defaultOutput('image')).toBe('png');
    expect(defaultOutput('image', {})).toBe('png');
    expect(defaultOutput('image', { image: { width: 1200 } })).toBe('png');
    expect(defaultOutput('image', { image: { format: 'jpeg' } })).toBe('jpg');
    expect(defaultOutput('image', { image: { format: 'webp' } })).toBe('webp');
  });

  it('lets a later settings layer (the request) choose over the template', () => {
    expect(defaultOutput('image', { image: { format: 'jpeg' } }, { image: { format: 'webp' } })).toBe('webp');
    expect(defaultOutput('image', { image: { format: 'jpeg' } }, { image: { width: 800 } })).toBe('jpg');
    expect(defaultOutput('image', { image: { format: 'jpeg' } }, null, undefined)).toBe('jpg');
  });
});

describe('imageOutput', () => {
  it('maps the settings spelling to the API one and accepts jpg', () => {
    expect(imageOutput({ image: { format: 'jpeg' } })).toBe('jpg');
    expect(imageOutput({ image: { format: 'jpg' } })).toBe('jpg');
    expect(imageOutput({ image: { format: 'gif' } })).toBe('png');
    expect(imageOutput('nonsense')).toBe('png');
  });
});

describe('isOutputFormat', () => {
  it('knows the API values only', () => {
    expect(isOutputFormat('webp')).toBe(true);
    expect(isOutputFormat('jpeg')).toBe(false);
    expect(isOutputFormat('html')).toBe(false);
  });
});
