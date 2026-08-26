// Discovery service - handles saving and retrieving discoveries

import db from '@recall/shared/db';
import type { DiscoveryTable, AgencyType } from '@recall/shared/db';
import type { Selectable } from 'kysely';

export type Discovery = Selectable<DiscoveryTable>;

export interface SaveDiscoveryInput {
  companyId: string;
  agency: AgencyType;
  requirements: unknown[];
  metadata?: Record<string, unknown>;
}

/**
 * Save a discovery to the database
 */
export async function saveDiscovery(input: SaveDiscoveryInput): Promise<Discovery> {
  const discovery = await db
    .insertInto('discoveries')
    .values({
      companyId: input.companyId,
      agency: input.agency,
      requirements: JSON.stringify(input.requirements),
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return discovery;
}

/**
 * Find discoveries for a company
 */
export async function findDiscoveriesByCompanyId(companyId: string): Promise<Discovery[]> {
  const discoveries = await db
    .selectFrom('discoveries')
    .selectAll()
    .where('companyId', '=', companyId)
    .orderBy('discoveredAt', 'desc')
    .execute();

  return discoveries;
}

/**
 * Find discoveries by contact email (through company)
 */
export async function findDiscoveriesByEmail(email: string) {
  // First find the company
  const company = await db
    .selectFrom('companies')
    .selectAll()
    .where('contactEmail', '=', email.toLowerCase())
    .executeTakeFirst();

  if (!company) return null;

  // Then find discoveries for that company
  const discoveries = await db
    .selectFrom('discoveries')
    .selectAll()
    .where('companyId', '=', company.id)
    .orderBy('discoveredAt', 'desc')
    .execute();

  return {
    company,
    discoveries,
  };
}

/**
 * Find discoveries by company access token (for anonymous access via /matrix?token=UUID)
 */
export async function findDiscoveriesByToken(token: string) {
  // First find the company by access token
  const company = await db
    .selectFrom('companies')
    .selectAll()
    .where('accessToken', '=', token)
    .executeTakeFirst();

  if (!company) return null;

  // Then find discoveries for that company
  const discoveries = await db
    .selectFrom('discoveries')
    .selectAll()
    .where('companyId', '=', company.id)
    .orderBy('discoveredAt', 'desc')
    .execute();

  return {
    company,
    discoveries,
  };
}

/**
 * Find discoveries with company data by company ID (for authenticated users)
 */
export async function findDiscoveriesWithCompanyById(companyId: string) {
  // First get the company
  const company = await db
    .selectFrom('companies')
    .selectAll()
    .where('id', '=', companyId)
    .executeTakeFirst();

  if (!company) return null;

  // Then find discoveries for that company
  const discoveries = await db
    .selectFrom('discoveries')
    .selectAll()
    .where('companyId', '=', companyId)
    .orderBy('discoveredAt', 'desc')
    .execute();

  return {
    company,
    discoveries,
  };
}

/**
 * Create an empty discovery (for progressive loading)
 */
export async function createEmptyDiscovery(input: Omit<SaveDiscoveryInput, 'requirements'>): Promise<Discovery> {
  const discovery = await db
    .insertInto('discoveries')
    .values({
      companyId: input.companyId,
      agency: input.agency,
      requirements: JSON.stringify([]),
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return discovery;
}

/**
 * Append a requirement to an existing discovery (for progressive loading)
 */
export async function appendRequirement(
  discoveryId: string,
  requirement: unknown
): Promise<Discovery> {
  // Get current requirements
  const current = await db
    .selectFrom('discoveries')
    .select('requirements')
    .where('id', '=', discoveryId)
    .executeTakeFirstOrThrow();

  // Parse current requirements - handle both string and object (Kysely may auto-parse)
  let requirements: unknown[];
  if (typeof current.requirements === 'string') {
    requirements = JSON.parse(current.requirements);
  } else if (Array.isArray(current.requirements)) {
    requirements = current.requirements;
  } else {
    requirements = [];
  }

  // Append new requirement
  requirements.push(requirement);

  // Update with new requirements array
  const updated = await db
    .updateTable('discoveries')
    .set({
      requirements: JSON.stringify(requirements),
    })
    .where('id', '=', discoveryId)
    .returningAll()
    .executeTakeFirstOrThrow();

  return updated;
}

/**
 * Update discovery status in metadata (for marking complete/cancelled)
 */
export async function updateDiscoveryStatus(
  discoveryId: string,
  status: 'in_progress' | 'complete' | 'cancelled'
): Promise<Discovery> {
  // Get current metadata
  const current = await db
    .selectFrom('discoveries')
    .select('metadata')
    .where('id', '=', discoveryId)
    .executeTakeFirstOrThrow();

  // Parse current metadata
  let metadata: Record<string, unknown> = {};
  if (typeof current.metadata === 'string') {
    metadata = JSON.parse(current.metadata);
  } else if (current.metadata && typeof current.metadata === 'object') {
    metadata = current.metadata as Record<string, unknown>;
  }

  // Update status
  metadata.status = status;
  metadata.completedAt = status !== 'in_progress' ? new Date().toISOString() : undefined;

  // Save updated metadata
  const updated = await db
    .updateTable('discoveries')
    .set({
      metadata: JSON.stringify(metadata),
    })
    .where('id', '=', discoveryId)
    .returningAll()
    .executeTakeFirstOrThrow();

  return updated;
}
