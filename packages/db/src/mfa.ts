import { query } from "./client.ts";

export interface MfaRow {
  encrypted_secret: string | null;
  enabled_at: Date | null;
  enrollment_expires_at: Date | null;
  last_counter: string | number;
}

export async function getMfa(userId: string): Promise<MfaRow | null> {
  const result = await query<MfaRow>(
    `SELECT mfa_secret_ciphertext AS encrypted_secret,
            mfa_enabled_at AS enabled_at,
            mfa_enrollment_expires_at AS enrollment_expires_at,
            mfa_last_counter AS last_counter
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function beginMfaEnrollment(
  userId: string,
  encryptedSecret: string,
  expiresAt: string,
): Promise<boolean> {
  const result = await query(
    `UPDATE users
        SET mfa_secret_ciphertext = $2,
            mfa_enrollment_expires_at = $3,
            mfa_last_counter = -1
      WHERE id = $1 AND deleted_at IS NULL AND mfa_enabled_at IS NULL`,
    [userId, encryptedSecret, expiresAt],
  );
  return result.rowCount === 1;
}

export async function confirmMfaEnrollment(userId: string, counter: number): Promise<boolean> {
  const result = await query(
    `UPDATE users
        SET mfa_enabled_at = now(), mfa_enrollment_expires_at = NULL,
            mfa_last_counter = $2
      WHERE id = $1 AND deleted_at IS NULL AND mfa_enabled_at IS NULL
        AND mfa_secret_ciphertext IS NOT NULL
        AND mfa_enrollment_expires_at > now() AND mfa_last_counter < $2`,
    [userId, counter],
  );
  return result.rowCount === 1;
}

export async function consumeMfaCounter(userId: string, counter: number): Promise<boolean> {
  const result = await query(
    `UPDATE users SET mfa_last_counter = $2
      WHERE id = $1 AND deleted_at IS NULL AND mfa_enabled_at IS NOT NULL
        AND mfa_last_counter < $2`,
    [userId, counter],
  );
  return result.rowCount === 1;
}

export async function disableMfa(userId: string, counter: number): Promise<boolean> {
  const result = await query(
    `UPDATE users
        SET mfa_secret_ciphertext = NULL, mfa_enabled_at = NULL,
            mfa_enrollment_expires_at = NULL, mfa_last_counter = -1
      WHERE id = $1 AND deleted_at IS NULL AND mfa_enabled_at IS NOT NULL
        AND mfa_last_counter < $2`,
    [userId, counter],
  );
  return result.rowCount === 1;
}
