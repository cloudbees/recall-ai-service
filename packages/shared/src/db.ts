// Database client using Kysely with PostgreSQL
import { Kysely, PostgresDialect } from 'kysely';
import type { Generated, ColumnType } from 'kysely';
import { Pool } from 'pg';

// =============================================================================
// Type Definitions (matching our existing PostgreSQL tables)
// =============================================================================

// Enums
export type DiscoveredByType = 'ANONYMOUS' | 'PAID_USER';
export type AgencyType = 'FDA' | 'CPSC';
export type FileType = 'PDF' | 'XLSX' | 'DOCX' | 'TXT';
export type MessageRole = 'USER' | 'ASSISTANT';
export type CustomAgencyType = 'CITY' | 'COUNTY' | 'STATE' | 'INTERNAL' | 'OTHER';
export type RequirementStatus = 'ACTIVE' | 'ARCHIVED';
export type OverrideStatus = 'APPLICABLE' | 'NOT_APPLICABLE' | 'FLAGGED' | 'DELETED';
export type AdminAction = 'MERGE_COMPANIES' | 'EDIT_COMPANY' | 'DELETE_COMPANY' | 'EDIT_USER' | 'DELETE_USER';
export type TargetType = 'COMPANY' | 'USER' | 'DISCOVERY';
export type MemoryCategory = 'facility' | 'compliance' | 'preference' | 'process' | 'personnel';

// Requirement CRUD enums
export type RequirementComplianceStatus = 'pending' | 'in_progress' | 'compliant' | 'non_compliant' | 'n_a';
export type RequirementPriority = 'high' | 'medium' | 'low';

// Table interfaces
export interface CompanyTable {
  id: Generated<string>;
  website: string;
  normalizedWebsite: string;
  companyName: string;
  naicsCode: string;
  discoveredBy: DiscoveredByType;
  firstDiscoveredAt: Generated<Date>;
  lastUpdatedAt: ColumnType<Date, never, Date>;
  websiteAnalysis: unknown | null;
  employeeCount: number | null;
  state: string | null;
  contactEmail: string | null;
  accessToken: Generated<string>;
  mergedIntoId: string | null;
  mergedAt: Date | null;
}

export interface UserTable {
  id: Generated<string>;
  isAnonymous: Generated<boolean>;
  sessionToken: string | null;
  email: string | null;
  passwordHash: string | null;
  stripeCustomerId: string | null;
  companyId: string | null;
  createdAt: Generated<Date>;
  lastActiveAt: Generated<Date>;
}

export interface DiscoveryTable {
  id: Generated<string>;
  companyId: string;
  agency: AgencyType;
  requirements: unknown;
  metadata: unknown | null;
  discoveredAt: Generated<Date>;
  expiresAt: Date | null;
}

export interface UserDiscoveryTable {
  userId: string;
  discoveryId: string;
  triggeredAt: Generated<Date>;
}

export interface DocumentTable {
  id: Generated<string>;
  userId: string;
  companyId: string;
  requirementId: string | null;
  filename: string;
  fileType: FileType;
  s3Key: string;
  fileSizeBytes: number;
  extractedText: string | null;
  embedding: string | null;
  uploadedAt: Generated<Date>;
}

export interface ChatMessageTable {
  id: Generated<string>;
  userId: string;
  companyId: string;
  role: MessageRole;
  content: string;
  citedRegulations: unknown | null;
  citedDocuments: unknown | null;
  conversationId: string | null;
  toolCalls: unknown | null;
  model: string | null;
  tokenUsage: unknown | null;
  latencyMs: number | null;
  createdAt: Generated<Date>;
}

export interface CustomRequirementTable {
  id: Generated<string>;
  companyId: string;
  createdByUserId: string;
  title: string;
  agency: string;
  agencyType: CustomAgencyType;
  description: string | null;
  renewalDate: Date | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  attachments: unknown | null;
  status: Generated<RequirementStatus>;
  createdAt: Generated<Date>;
  updatedAt: ColumnType<Date, never, Date>;
}

export interface RequirementUserOverrideTable {
  id: Generated<string>;
  discoveryId: string;
  regulationCitation: string;
  userId: string;
  status: OverrideStatus;
  reason: string | null;
  notes: string | null;
  createdAt: Generated<Date>;
  updatedAt: ColumnType<Date, never, Date>;
}

export interface AdminAuditLogTable {
  id: Generated<string>;
  adminUserId: string;
  action: AdminAction;
  targetType: TargetType;
  targetId: string;
  beforeState: unknown | null;
  afterState: unknown | null;
  reason: string | null;
  performedAt: Generated<Date>;
}

export interface RequirementTable {
  id: Generated<string>;
  discoveryId: string | null;  // Nullable in database
  companyId: string;
  citation: string;
  title: string;
  name: string | null;
  agency: string;  // TEXT in database (FDA, CPSC)
  part: string | null;
  section: string | null;
  confidence: number | null;
  appliesTo: string | null;
  triggers: unknown;  // JSONB array
  excerpt: string | null;
  fullText: string | null;
  reasoning: string | null;
  regulationSummary: unknown | null;  // JSONB object
  source: string;  // NOT NULL with default
  status: string;  // TEXT in database (pending, in_progress, etc)
  priority: number | null;  // INTEGER in database (from previous schema)
  notes: string | null;
  discoveredAt: Generated<Date>;
  createdAt: Generated<Date>;
  updatedAt: ColumnType<Date, never, Date>;
  modifiedByUserId: string | null;
  // Legacy columns from previous schema
  description: string | null;
  dueDate: Date | null;
  assignedTo: string | null;
  deletedAt: Date | null;
  sortOrder: number | null;
  createdBy: string | null;
  calendarTracking: Generated<boolean>;
  frequency: string | null;
  possibleObligations: unknown | null;  // JSONB array of AI-extracted obligations
  embedding: string | null;
}

export interface ObligationEmbeddingTable {
  id: Generated<string>;
  requirementId: string;
  companyId: string;
  obligationIndex: number;
  obligationText: string;
  embedding: string | null;
  createdAt: Generated<Date>;
}

export interface DocumentChunkTable {
  id: Generated<string>;
  documentId: string;
  companyId: string;
  chunkIndex: number;
  chunkText: string;
  embedding: string | null;
  createdAt: Generated<Date>;
}

export interface UserMemoryTable {
  id: Generated<string>;
  userId: string;
  category: MemoryCategory;
  fact: string;
  source: string;
  conversationId: string | null;
  embedding: string | null;
  createdAt: Generated<Date>;
  updatedAt: ColumnType<Date, never, Date>;
  expiresAt: Date | null;
}

// Database interface (all tables)
export interface Database {
  companies: CompanyTable;
  users: UserTable;
  discoveries: DiscoveryTable;
  user_discoveries: UserDiscoveryTable;
  documents: DocumentTable;
  chat_messages: ChatMessageTable;
  custom_requirements: CustomRequirementTable;
  requirement_user_overrides: RequirementUserOverrideTable;
  admin_audit_log: AdminAuditLogTable;
  requirements: RequirementTable;
  obligation_embeddings: ObligationEmbeddingTable;
  document_chunks: DocumentChunkTable;
  user_memory: UserMemoryTable;
}

// =============================================================================
// Database Connection
// =============================================================================

// Strip sslmode from DATABASE_URL — the pg driver doesn't understand libpq's
// sslmode parameter and it conflicts with the ssl config object below.
const connectionString = (process.env.DATABASE_URL || '').replace(/[?&]sslmode=[^&]*/g, '');

// SSL is required for RDS but unavailable on a local Postgres container, which
// rejects the connection outright rather than downgrading. Opt out with
// DATABASE_SSL=disable for local development; the default stays RDS-compatible.
const useSsl = process.env.DATABASE_SSL !== 'disable';

const dialect = new PostgresDialect({
  pool: new Pool({
    connectionString,
    max: 20,                        // Increased from 10 for better concurrency
    min: 3,                         // Keep 3 connections warm
    idleTimeoutMillis: 30000,       // Close idle connections after 30s
    connectionTimeoutMillis: 5000,  // 5s timeout for new connections
    ssl: useSsl
      ? { rejectUnauthorized: false } // Allow RDS certificates
      : false,
  }),
});

export const db = new Kysely<Database>({
  dialect,
});

export default db;
