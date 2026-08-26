// Company service - handles company creation and lookup

import { randomUUID } from 'crypto';
import db from '@recall/shared/db';
import type { CompanyTable, DiscoveredByType } from '@recall/shared/db';
import { normalizeWebsite } from '@recall/shared/utils/normalize-website';
import type { Selectable } from 'kysely';

export type Company = Selectable<CompanyTable>;

export interface CreateCompanyInput {
  companyName: string;
  website: string;
  naicsCode: string;
  employeeCount: number;
  state?: string;
  contactEmail: string;
  websiteAnalysis?: Record<string, unknown>;
}

/**
 * Create a company record for a user
 * Each email gets their own company record (no website-based deduplication)
 */
export async function createCompany(input: CreateCompanyInput): Promise<Company> {
  const normalizedWebsite = normalizeWebsite(input.website);
  const email = input.contactEmail.toLowerCase();

  // Check if this email already has a company
  const existing = await db
    .selectFrom('companies')
    .selectAll()
    .where('contactEmail', '=', email)
    .executeTakeFirst();

  if (existing) {
    // Update existing company with new info
    const updated = await db
      .updateTable('companies')
      .set({
        companyName: input.companyName,
        website: input.website,
        normalizedWebsite,
        naicsCode: input.naicsCode,
        employeeCount: input.employeeCount,
        state: input.state || null,
        websiteAnalysis: input.websiteAnalysis || null,
      })
      .where('id', '=', existing.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return updated;
  }

  // Create new company for this email
  const company = await db
    .insertInto('companies')
    .values({
      companyName: input.companyName,
      website: input.website,
      normalizedWebsite,
      naicsCode: input.naicsCode,
      employeeCount: input.employeeCount,
      state: input.state || null,
      contactEmail: email,
      websiteAnalysis: input.websiteAnalysis || null,
      discoveredBy: 'ANONYMOUS' as DiscoveredByType,
      accessToken: randomUUID(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return company;
}

/**
 * Find company by contact email
 * Used during registration to link user to existing company
 */
export async function findCompanyByEmail(email: string): Promise<Company | null> {
  const company = await db
    .selectFrom('companies')
    .selectAll()
    .where('contactEmail', '=', email.toLowerCase())
    .executeTakeFirst();

  return company || null;
}

/**
 * Find company by access token
 * Used for anonymous access via /matrix?token=UUID
 */
export async function findCompanyByToken(token: string): Promise<Company | null> {
  const company = await db
    .selectFrom('companies')
    .selectAll()
    .where('accessToken', '=', token)
    .executeTakeFirst();

  return company || null;
}

/**
 * Find company by ID
 */
export async function findCompanyById(id: string): Promise<Company | null> {
  const company = await db
    .selectFrom('companies')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();

  return company || null;
}
