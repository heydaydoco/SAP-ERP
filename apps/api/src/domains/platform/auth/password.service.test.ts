import { describe, it, expect } from 'vitest';
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const svc = new PasswordService();

  it('hashes and verifies a password', async () => {
    const hash = await svc.hash('s3cret!');
    expect(hash).not.toBe('s3cret!'); // never store plaintext
    expect(await svc.compare('s3cret!', hash)).toBe(true);
    expect(await svc.compare('wrong', hash)).toBe(false);
  });

  it('produces distinct salted hashes for the same password', async () => {
    const [a, b] = await Promise.all([svc.hash('same'), svc.hash('same')]);
    expect(a).not.toBe(b);
  });
});
