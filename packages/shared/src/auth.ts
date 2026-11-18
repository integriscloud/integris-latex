import { parsePhoneNumberFromString } from 'libphonenumber-js/min';
import { z } from 'zod';
import { LOCALES } from './i18n.js';

/** Name of the session cookie. The `__Host-` prefix forces Secure, Path=/ and no Domain. */
export const SESSION_COOKIE = '__Host-session';

/** Id of the personal space; organization spaces use the organization id. */
export const PERSONAL_SPACE_ID = 'personal';

/** Error codes returned by /api/auth endpoints in `{ code }`. The web app translates each one. */
export const AUTH_ERROR_CODES = [
  'invalid_request',
  'forbidden_origin',
  'unauthenticated',
  'captcha_required',
  'captcha_invalid',
  'rate_limited',
  'locked',
  'invalid_phone',
  'country_not_allowed',
  'invalid_code',
  'code_expired',
  'too_many_attempts',
  'no_account',
  'account_disabled',
  'invalid_credentials',
  'weak_password',
  'common_password',
  'email_required',
  'email_taken',
  'invalid_token',
  'space_not_allowed',
] as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export const authErrorSchema = z.object({
  code: z.enum(AUTH_ERROR_CODES),
  // Seconds before the action can be retried (rate_limited, locked).
  retryAfter: z.number().int().nonnegative().optional(),
});
export type AuthError = z.infer<typeof authErrorSchema>;

/**
 * Normalize a phone number typed by a user to E.164 (`+22670123456`). `dialCode` is the country
 * calling code chosen in the UI; a number typed with its own `+` prefix keeps that prefix.
 * Returns null when the number is not valid.
 */
export function normalizePhone(input: string, dialCode?: string): string | null {
  const cleaned = input.replace(/[\s.\-()]/g, '');
  const withPrefix = cleaned.startsWith('+')
    ? cleaned
    : cleaned.startsWith('00')
      ? `+${cleaned.slice(2)}`
      : dialCode
        ? `+${dialCode}${cleaned}`
        : cleaned;
  const parsed = parsePhoneNumberFromString(withPrefix);
  if (!parsed?.isValid()) return null;
  return parsed.number;
}

/**
 * Readable international form of an E.164 number, e.g. "+226 70 12 34 56", for display only
 * (numbers are stored in E.164). Digits are grouped by pairs when the metadata leaves a longer
 * block (Côte d'Ivoire: "07 08 09 1011" → "07 08 09 10 11").
 */
export function formatPhone(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed) return e164;
  const prefix = `+${parsed.countryCallingCode}`;
  const national = parsed.formatInternational().slice(prefix.length).trim();
  if (!/\d{4,}/.test(national)) return `${prefix} ${national}`;
  const digits = String(parsed.nationalNumber);
  const head = digits.length % 2 === 1 ? 3 : 2;
  const pairs = digits.slice(head).match(/\d{2}/g) ?? [];
  return [prefix, digits.slice(0, head), ...pairs].join(' ');
}

/** Country calling code of an E.164 number, e.g. "226". */
export function dialCodeOf(e164: string): string | null {
  return parsePhoneNumberFromString(e164)?.countryCallingCode ?? null;
}

const phone = z.string().trim().min(4).max(32);
const dialCode = z.string().regex(/^\d{1,4}$/);
const code = z.string().regex(/^\d{4,8}$/);
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
// The strength rules (length, common passwords) are checked by the API to return precise errors.
const password = z.string().min(1).max(256);
const token = z.string().regex(/^[A-Za-z0-9_-]{20,128}$/);
// Base64 JSON payload produced by the ALTCHA solver.
const captcha = z.string().max(4096).optional();
const name = z.string().trim().min(1).max(60);

export const OTP_PURPOSES = ['signup', 'login'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

export const otpRequestSchema = z.object({
  phone,
  dialCode,
  purpose: z.enum(OTP_PURPOSES),
  locale: z.enum(LOCALES),
  captcha,
});
export type OtpRequest = z.infer<typeof otpRequestSchema>;

export const otpRequestResponseSchema = z.object({
  // Seconds before a new code can be requested.
  resendAfter: z.number().int().nonnegative(),
});

export const signupSchema = z.object({
  phone,
  dialCode,
  code,
  firstName: name,
  lastName: name,
  email: z.union([email, z.literal('')]).optional(),
  acceptTerms: z.literal(true),
  locale: z.enum(LOCALES),
  captcha,
});
export type SignupRequest = z.infer<typeof signupSchema>;

export const otpLoginSchema = z.object({ phone, dialCode, code, captcha });
export type OtpLoginRequest = z.infer<typeof otpLoginSchema>;

export const passwordLoginSchema = z.object({ email, password, captcha });
export type PasswordLoginRequest = z.infer<typeof passwordLoginSchema>;

export const selectSpaceSchema = z.object({ spaceId: z.string().min(1).max(64) });

export const emailChangeSchema = z.object({ email, locale: z.enum(LOCALES) });

export const tokenSchema = z.object({ token });

export const passwordChangeSchema = z.object({
  currentPassword: password.optional(),
  newPassword: password,
});

export const passwordForgotSchema = z.object({ email, locale: z.enum(LOCALES), captcha });

export const passwordResetSchema = z.object({ token, newPassword: password });

export const spaceSchema = z.object({
  id: z.string(),
  kind: z.enum(['personal', 'organization']),
  organizationName: z.string().nullable(),
  organizationType: z.enum(['TEAM', 'BUSINESS']).nullable(),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']).nullable(),
  memberKind: z.enum(['TEACHER', 'STUDENT', 'SECRETARY', 'OTHER']).nullable(),
});
export type Space = z.infer<typeof spaceSchema>;

export const sessionUserSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  pendingEmail: z.string().nullable(),
  hasPassword: z.boolean(),
  locale: z.enum(LOCALES),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const meResponseSchema = z.object({
  user: sessionUserSchema,
  spaces: z.array(spaceSchema),
  // null until the user picks a space (several spaces) or when the chosen one was revoked.
  currentSpaceId: z.string().nullable(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const authConfigSchema = z.object({
  allowedDialCodes: z.array(z.string()),
  otpLength: z.number().int(),
  otpResendSeconds: z.number().int(),
  passwordMinLength: z.number().int(),
});
export type AuthConfig = z.infer<typeof authConfigSchema>;
