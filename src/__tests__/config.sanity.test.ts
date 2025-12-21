import { loadConfig } from '../../core/env';

describe('config sanity', () => {
  it('loads defaults without throwing', () => {
    expect(() => loadConfig()).not.toThrow();
  });
});
