// Shared user lookup — the narrow slice of the user service that more than one
// component needs.
//
// Only read/link operations live here. Password hashing and verification stay in
// Core API (apps/*/lib/services/user.ts) deliberately: the discovery worker needs
// to find a user by email and attach them to a company, but it has no business
// being able to verify credentials. Keeping bcrypt out of this package means the
// auth surface is not importable from the worker or the AI service.

import { db } from '@recall/shared/db';

export interface User {
  id: string;
  email: string;
  isAnonymous: boolean;
  companyId: string | null;
  createdAt: Date;
  lastActiveAt: Date;
}

/** Shape a users row into the public User type. */
export function toUser(row: {
  id: string;
  email: string | null;
  isAnonymous: boolean;
  companyId: string | null;
  createdAt: Date;
  lastActiveAt: Date;
}): User {
  return {
    id: row.id,
    email: row.email || '',
    isAnonymous: row.isAnonymous,
    companyId: row.companyId || null,
    createdAt: row.createdAt,
    lastActiveAt: row.lastActiveAt,
  };
}

/**
 * Find user by email (case-insensitive).
 */
export async function findUserByEmail(email: string): Promise<User | null> {
  const result = await db
    .selectFrom('users')
    .selectAll()
    .where('email', '=', email.toLowerCase())
    .executeTakeFirst();

  if (!result) return null;
  return toUser(result);
}

/**
 * Link user to company (after discovery or registration).
 */
export async function linkUserToCompany(userId: string, companyId: string): Promise<void> {
  await db
    .updateTable('users')
    .set({ companyId })
    .where('id', '=', userId)
    .execute();
}
