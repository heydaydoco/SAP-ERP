import { Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';

/** Password hashing (bcrypt). Plaintext passwords are never stored or logged (root CLAUDE.md §5.3). */
@Injectable()
export class PasswordService {
  private readonly rounds = 10;

  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.rounds);
  }

  compare(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }
}
