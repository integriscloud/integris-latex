import { hash, verify } from '@node-rs/argon2';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { ApiConfig } from '../config/api-config.js';
import { COMMON_PASSWORDS } from './common-passwords.js';

const common = new Set(COMMON_PASSWORDS);

/** Password hashing (argon2id, library defaults) and strength rules. */
@Injectable()
export class PasswordService {
  // Verified when the account does not exist, so both cases take the same time.
  private readonly dummyHash = hash('integris-dummy-password');

  constructor(private readonly config: ApiConfig) {}

  /** Throws `weak_password` or `common_password` when the password is refused. */
  assertStrong(password: string): void {
    if ([...password].length < this.config.env.PASSWORD_MIN_LENGTH) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'weak_password');
    }
    if (common.has(password.toLowerCase())) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'common_password');
    }
  }

  hash(password: string): Promise<string> {
    return hash(password);
  }

  /** Verifies against `passwordHash`, or against a dummy hash when there is none. */
  async verify(passwordHash: string | null, password: string): Promise<boolean> {
    if (!passwordHash) {
      await verify(await this.dummyHash, password).catch(() => false);
      return false;
    }
    return verify(passwordHash, password).catch(() => false);
  }
}
