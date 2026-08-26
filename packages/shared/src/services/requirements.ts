// Requirements service - handles CRUD operations for normalized requirements

import db from '@recall/shared/db';
import type { RequirementTable, AgencyType } from '@recall/shared/db';
import { sql, type Selectable } from 'kysely';
import { embed, embedBatch, toVectorString } from './embeddings.ts';

export type Requirement = Selectable<RequirementTable>;

// Status values (stored as text in database)
export type RequirementStatus = 'pending' | 'in_progress' | 'compliant' | 'non_compliant' | 'n_a';

// Priority values (stored as integer in database: high=3, medium=2, low=1)
export type RequirementPriorityType = 'high' | 'medium' | 'low';

// Helper to convert priority string to number for database
function priorityToNumber(priority: RequirementPriorityType | undefined): number | null {
  switch (priority) {
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    default: return null;
  }
}

// Helper to convert priority number from database to string
function priorityFromNumber(priority: number | null): RequirementPriorityType | null {
  switch (priority) {
    case 3: return 'high';
    case 2: return 'medium';
    case 1: return 'low';
    default: return null;
  }
}

// Input types for creating requirements
export interface CreateRequirementInput {
  discoveryId: string | null;
  companyId: string;
  citation: string;
  title: string;
  name?: string;
  agency: AgencyType;
  part?: string;
  section?: string;
  confidence: number;
  appliesTo?: string;
  triggers?: unknown[];
  excerpt?: string;
  fullText?: string;
  reasoning?: string;
  regulationSummary?: unknown;
  source?: string;
  status?: RequirementStatus;
  priority?: RequirementPriorityType;
  notes?: string;
  possibleObligations?: unknown;
}

// Input for updating a requirement
export interface UpdateRequirementInput {
  status?: RequirementStatus;
  priority?: RequirementPriorityType;
  notes?: string;
  title?: string;
  name?: string;
  citation?: string;
  appliesTo?: string;
  triggers?: unknown[];
  excerpt?: string;
  sortOrder?: number;
  modifiedByUserId?: string;
  dueDate?: string | null;       // ISO date string
  calendarTracking?: boolean;
  frequency?: string | null;
}

// Filter options for listing requirements
export interface RequirementFilters {
  agency?: AgencyType;
  status?: RequirementStatus;
  priority?: RequirementPriorityType;
}

// Stats for dashboard display
export interface ComplianceStats {
  total: number;
  pending: number;
  inProgress: number;
  compliant: number;
  nonCompliant: number;
  notApplicable: number;
  complianceRate: number;  // percentage of compliant out of applicable
}

/**
 * Create a single requirement
 */
export async function createRequirement(input: CreateRequirementInput): Promise<Requirement> {
  const requirement = await db
    .insertInto('requirements')
    .values({
      discoveryId: input.discoveryId,
      companyId: input.companyId,
      citation: input.citation,
      title: input.title,
      name: input.name || null,
      agency: input.agency,
      part: input.part || null,
      section: input.section || null,
      confidence: input.confidence,
      appliesTo: input.appliesTo || null,
      triggers: JSON.stringify(input.triggers || []),
      excerpt: input.excerpt || null,
      fullText: input.fullText || null,
      reasoning: input.reasoning || null,
      regulationSummary: input.regulationSummary ? JSON.stringify(input.regulationSummary) : null,
      source: input.source || 'recall_search',
      status: input.status || 'pending',
      priority: priorityToNumber(input.priority || 'medium'),
      notes: input.notes || null,
      possibleObligations: input.possibleObligations ? JSON.stringify(input.possibleObligations) : null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  // Fire-and-forget: embed requirement summary + obligations
  embedRequirement(requirement).catch(err =>
    console.error(`[Embed] Failed to embed requirement ${requirement.id}:`, err)
  );

  return requirement;
}

/**
 * Batch insert multiple requirements (for migration/discovery)
 */
export async function createRequirementsBatch(inputs: CreateRequirementInput[]): Promise<Requirement[]> {
  if (inputs.length === 0) return [];

  const values = inputs.map(input => ({
    discoveryId: input.discoveryId,
    companyId: input.companyId,
    citation: input.citation,
    title: input.title,
    name: input.name || null,
    agency: input.agency,
    part: input.part || null,
    section: input.section || null,
    confidence: input.confidence,
    appliesTo: input.appliesTo || null,
    triggers: JSON.stringify(input.triggers || []),
    excerpt: input.excerpt || null,
    fullText: input.fullText || null,
    reasoning: input.reasoning || null,
    regulationSummary: input.regulationSummary ? JSON.stringify(input.regulationSummary) : null,
    source: input.source || 'recall_search',
    status: input.status || 'pending',
    priority: priorityToNumber(input.priority || 'medium'),
    notes: input.notes || null,
    possibleObligations: input.possibleObligations ? JSON.stringify(input.possibleObligations) : null,
  }));

  const requirements = await db
    .insertInto('requirements')
    .values(values)
    .returningAll()
    .execute();

  return requirements;
}

/**
 * Get a single requirement by ID
 */
export async function getRequirementById(id: string): Promise<Requirement | null> {
  const requirement = await db
    .selectFrom('requirements')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();

  return requirement || null;
}

/**
 * Get all requirements for a company with optional filters
 */
export async function getRequirementsByCompany(
  companyId: string,
  filters?: RequirementFilters
): Promise<Requirement[]> {
  let query = db
    .selectFrom('requirements')
    .selectAll()
    .where('companyId', '=', companyId);

  if (filters?.agency) {
    query = query.where('agency', '=', filters.agency);
  }

  if (filters?.status) {
    query = query.where('status', '=', filters.status);
  }

  if (filters?.priority) {
    const priorityNum = priorityToNumber(filters.priority);
    if (priorityNum !== null) {
      query = query.where('priority', '=', priorityNum);
    }
  }

  const requirements = await query
    .orderBy((eb) => eb.fn.coalesce('sortOrder', eb.lit(999999)), 'asc')
    .orderBy('confidence', 'desc')
    .orderBy('citation', 'asc')
    .execute();

  return requirements;
}

/**
 * Get all requirements for a specific discovery
 */
export async function getRequirementsByDiscovery(discoveryId: string): Promise<Requirement[]> {
  const requirements = await db
    .selectFrom('requirements')
    .selectAll()
    .where('discoveryId', '=', discoveryId)
    .orderBy('confidence', 'desc')
    .orderBy('citation', 'asc')
    .execute();

  return requirements;
}

/**
 * Update a requirement (status, priority, notes)
 */
export async function updateRequirement(
  id: string,
  update: UpdateRequirementInput
): Promise<Requirement | null> {
  const updateValues: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (update.status !== undefined) {
    updateValues.status = update.status;
  }

  if (update.priority !== undefined) {
    updateValues.priority = priorityToNumber(update.priority);
  }

  if (update.notes !== undefined) {
    updateValues.notes = update.notes;
  }

  if (update.title !== undefined) {
    updateValues.title = update.title;
  }

  if (update.name !== undefined) {
    updateValues.name = update.name;
  }

  if (update.citation !== undefined) {
    updateValues.citation = update.citation;
  }

  if (update.appliesTo !== undefined) {
    updateValues.appliesTo = update.appliesTo;
  }

  if (update.triggers !== undefined) {
    updateValues.triggers = JSON.stringify(update.triggers);
  }

  if (update.excerpt !== undefined) {
    updateValues.excerpt = update.excerpt;
  }

  if (update.sortOrder !== undefined) {
    updateValues.sortOrder = update.sortOrder;
  }

  if (update.modifiedByUserId !== undefined) {
    updateValues.modifiedByUserId = update.modifiedByUserId;
  }

  if (update.dueDate !== undefined) {
    updateValues.dueDate = update.dueDate ? new Date(update.dueDate) : null;
  }

  if (update.calendarTracking !== undefined) {
    updateValues.calendarTracking = update.calendarTracking;
  }

  if (update.frequency !== undefined) {
    updateValues.frequency = update.frequency;
  }

  const requirement = await db
    .updateTable('requirements')
    .set(updateValues)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();

  return requirement || null;
}

/**
 * Delete a requirement by ID
 */
export async function deleteRequirement(id: string): Promise<boolean> {
  const result = await db
    .deleteFrom('requirements')
    .where('id', '=', id)
    .executeTakeFirst();

  return result.numDeletedRows > 0;
}

/**
 * Get compliance stats for a company using SQL aggregation (single query)
 */
export async function getComplianceStats(companyId: string): Promise<ComplianceStats> {
  const result = await db
    .selectFrom('requirements')
    .select([
      sql<number>`COUNT(*)::int`.as('total'),
      sql<number>`COUNT(*) FILTER (WHERE status = 'pending' OR status IS NULL)::int`.as('pending'),
      sql<number>`COUNT(*) FILTER (WHERE status = 'in_progress')::int`.as('inProgress'),
      sql<number>`COUNT(*) FILTER (WHERE status = 'compliant')::int`.as('compliant'),
      sql<number>`COUNT(*) FILTER (WHERE status = 'non_compliant')::int`.as('nonCompliant'),
      sql<number>`COUNT(*) FILTER (WHERE status = 'n_a')::int`.as('notApplicable'),
    ])
    .where('companyId', '=', companyId)
    .executeTakeFirst();

  if (!result) {
    return {
      total: 0,
      pending: 0,
      inProgress: 0,
      compliant: 0,
      nonCompliant: 0,
      notApplicable: 0,
      complianceRate: 0,
    };
  }

  // Calculate compliance rate (compliant / (total - n/a))
  const applicable = result.total - result.notApplicable;
  const complianceRate = applicable > 0 ? Math.round((result.compliant / applicable) * 100) : 0;

  return {
    total: result.total,
    pending: result.pending,
    inProgress: result.inProgress,
    compliant: result.compliant,
    nonCompliant: result.nonCompliant,
    notApplicable: result.notApplicable,
    complianceRate,
  };
}

/**
 * Migrate requirements from a discovery's JSON blob to the requirements table
 * Used to backfill existing discoveries
 */
export async function migrateDiscoveryRequirements(discoveryId: string): Promise<number> {
  // Get the discovery
  const discovery = await db
    .selectFrom('discoveries')
    .select(['id', 'companyId', 'agency', 'requirements'])
    .where('id', '=', discoveryId)
    .executeTakeFirst();

  if (!discovery) {
    throw new Error(`Discovery not found: ${discoveryId}`);
  }

  // Parse the requirements JSON blob
  let requirements: unknown[];
  if (typeof discovery.requirements === 'string') {
    requirements = JSON.parse(discovery.requirements);
  } else if (Array.isArray(discovery.requirements)) {
    requirements = discovery.requirements;
  } else {
    requirements = [];
  }

  if (requirements.length === 0) {
    return 0;
  }

  // Check which citations are already migrated to avoid duplicates
  const existingCitations = await db
    .selectFrom('requirements')
    .select('citation')
    .where('discoveryId', '=', discoveryId)
    .where('source', '!=', 'user_added')
    .execute();

  const existingSet = new Set(existingCitations.map(r => r.citation));

  if (existingSet.size >= requirements.length) {
    console.log(`Discovery ${discoveryId} fully migrated (${existingSet.size}/${requirements.length}), skipping`);
    return 0;
  }

  // Filter to only unmigrated requirements
  const unmigrated = requirements.filter((req: unknown) => {
    const r = req as Record<string, unknown>;
    return !existingSet.has((r.citation as string) || '');
  });

  if (unmigrated.length === 0) {
    return 0;
  }

  if (existingSet.size > 0) {
    console.log(`Discovery ${discoveryId}: ${existingSet.size} already migrated, migrating ${unmigrated.length} new`);
  }

  // Map JSON requirements to CreateRequirementInput
  const inputs: CreateRequirementInput[] = unmigrated.map((req: unknown) => {
    const r = req as Record<string, unknown>;
    return {
      discoveryId: discovery.id,
      companyId: discovery.companyId,
      citation: (r.citation as string) || '',
      title: (r.title as string) || (r.name as string) || '',
      name: (r.name as string) || undefined,
      agency: (r.agency as AgencyType) || discovery.agency,
      part: (r.part as string) || undefined,
      section: (r.section as string) || undefined,
      confidence: (r.confidence as number) || 0,
      appliesTo: (r.appliesTo as string) || undefined,
      triggers: (r.triggers as unknown[]) || [],
      excerpt: (r.excerpt as string) || undefined,
      fullText: (r.fullText as string) || undefined,
      reasoning: (r.reasoning as string) || undefined,
      regulationSummary: r.regulationSummary || undefined,
      source: (r.source as string) || 'recall_search',
      possibleObligations: r.possibleObligations || undefined,
    };
  });

  // Batch insert
  const created = await createRequirementsBatch(inputs);
  console.log(`Migrated ${created.length} requirements for discovery ${discoveryId}`);

  return created.length;
}

/**
 * Migrate all discoveries for a company
 */
export async function migrateCompanyDiscoveries(companyId: string): Promise<number> {
  const discoveries = await db
    .selectFrom('discoveries')
    .select('id')
    .where('companyId', '=', companyId)
    .execute();

  let totalMigrated = 0;
  for (const discovery of discoveries) {
    totalMigrated += await migrateDiscoveryRequirements(discovery.id);
  }

  return totalMigrated;
}

/**
 * Check if a company has migrated requirements
 */
export async function hasNormalizedRequirements(companyId: string): Promise<boolean> {
  const result = await db
    .selectFrom('requirements')
    .select(db.fn.count('id').as('count'))
    .where('companyId', '=', companyId)
    .executeTakeFirst();

  return result ? Number(result.count) > 0 : false;
}

/**
 * Embed a requirement's summary + extract and embed its obligations
 * Called fire-and-forget after createRequirement
 */
export async function embedRequirement(requirement: Requirement): Promise<void> {
  // Layer 1: Embed regulation summary
  if (requirement.regulationSummary) {
    const summaryText = typeof requirement.regulationSummary === 'string'
      ? requirement.regulationSummary
      : JSON.stringify(requirement.regulationSummary);
    const text = `${requirement.citation}: ${requirement.title}\n${summaryText}`;
    const embedding = await embed(text);
    const vectorStr = toVectorString(embedding);
    await sql`
      UPDATE requirements SET embedding = ${vectorStr}::vector WHERE id = ${requirement.id}
    `.execute(db);
  }

  // Layer 2: Extract and embed individual obligations
  if (requirement.possibleObligations) {
    let obligations: Array<{ obligation?: string; description?: string; text?: string }>;
    if (typeof requirement.possibleObligations === 'string') {
      try { obligations = JSON.parse(requirement.possibleObligations); } catch { return; }
    } else if (Array.isArray(requirement.possibleObligations)) {
      obligations = requirement.possibleObligations as typeof obligations;
    } else {
      return;
    }

    if (!Array.isArray(obligations) || obligations.length === 0) return;

    const obligationTexts: Array<{ index: number; text: string }> = [];
    for (let i = 0; i < obligations.length; i++) {
      const obl = obligations[i];
      const text = obl.obligation || obl.description || obl.text;
      if (text && typeof text === 'string') {
        obligationTexts.push({ index: i, text: `${requirement.citation}: ${text}` });
      }
    }

    if (obligationTexts.length === 0) return;

    const embeddings = await embedBatch(obligationTexts.map(o => o.text));

    for (let i = 0; i < obligationTexts.length; i++) {
      const vectorStr = toVectorString(embeddings[i]);
      await sql`
        INSERT INTO obligation_embeddings ("requirementId", "companyId", "obligationIndex", "obligationText", embedding)
        VALUES (${requirement.id}::uuid, ${requirement.companyId}::uuid, ${obligationTexts[i].index}, ${obligationTexts[i].text}, ${vectorStr}::vector)
        ON CONFLICT ("requirementId", "obligationIndex") DO NOTHING
      `.execute(db);
    }
  }
}

/**
 * Bulk update sortOrder for multiple requirements (used by drag-to-reorder)
 * Uses a single UPDATE with CASE WHEN for better performance
 */
export async function bulkUpdateSortOrder(
  updates: { id: string; sortOrder: number }[]
): Promise<void> {
  if (updates.length === 0) return;

  // Build CASE WHEN clause for sortOrder
  const ids = updates.map(u => u.id);
  const caseClauses = updates
    .map(u => `WHEN id = '${u.id}' THEN ${u.sortOrder}`)
    .join(' ');

  // Single UPDATE query with CASE WHEN (much faster than N individual updates)
  await sql`
    UPDATE requirements
    SET "sortOrder" = CASE ${sql.raw(caseClauses)} END,
        "updatedAt" = NOW()
    WHERE id = ANY(${sql.raw(`ARRAY[${ids.map(id => `'${id}'`).join(',')}]::uuid[]`)})
  `.execute(db);
}
