// Documents service - CRUD operations for file uploads

import db from '@recall/shared/db';
import type { FileType } from '@recall/shared/db';
import { sql, type Selectable } from 'kysely';
import type { DocumentTable } from '@recall/shared/db';
import { embed, embedBatch, toVectorString } from './embeddings.ts';

export type Document = Selectable<DocumentTable>;

export interface CreateDocumentInput {
  userId: string;
  companyId: string;
  requirementId: string;
  filename: string;
  fileType: FileType;
  s3Key: string;
  fileSizeBytes: number;
}

/**
 * Create a document record
 */
export async function createDocument(input: CreateDocumentInput): Promise<Document> {
  const doc = await db
    .insertInto('documents')
    .values({
      userId: input.userId,
      companyId: input.companyId,
      requirementId: input.requirementId,
      filename: input.filename,
      fileType: input.fileType,
      s3Key: input.s3Key,
      fileSizeBytes: input.fileSizeBytes,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return doc;
}

/**
 * Get all documents for a requirement
 */
export async function getDocumentsByRequirement(requirementId: string): Promise<Document[]> {
  return db
    .selectFrom('documents')
    .selectAll()
    .where('requirementId', '=', requirementId)
    .orderBy('uploadedAt', 'desc')
    .execute();
}

/**
 * Get a single document by ID
 */
export async function getDocumentById(id: string): Promise<Document | null> {
  const doc = await db
    .selectFrom('documents')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();

  return doc || null;
}

/**
 * Delete a document by ID
 */
export async function deleteDocument(id: string): Promise<boolean> {
  const result = await db
    .deleteFrom('documents')
    .where('id', '=', id)
    .executeTakeFirst();

  return result.numDeletedRows > 0;
}

/**
 * Map file extension to FileType enum
 */
export function getFileType(filename: string): FileType {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'pdf': return 'PDF';
    case 'xlsx': case 'xls': return 'XLSX';
    case 'docx': case 'doc': return 'DOCX';
    case 'txt': return 'TXT';
    default: return 'PDF'; // Default to PDF for unknown types
  }
}

/**
 * Embed a document after text extraction.
 * Small docs (< 2000 chars) get a single vector on the documents table.
 * Large docs get chunked with overlap and stored in document_chunks.
 */
export async function embedDocument(documentId: string): Promise<void> {
  const doc = await getDocumentById(documentId);
  if (!doc || !doc.extractedText || doc.extractedText.trim().length === 0) return;

  const text = doc.extractedText;

  if (text.length < 2000) {
    // Small doc: single vector
    const embedding = await embed(`${doc.filename}\n${text}`);
    const vectorStr = toVectorString(embedding);
    await sql`
      UPDATE documents SET embedding = ${vectorStr}::vector WHERE id = ${doc.id}
    `.execute(db);
  } else {
    // Large doc: chunk with overlap
    const chunks = chunkText(text, 1500, 200);
    const chunkTexts = chunks.map((c, i) => `${doc.filename} [chunk ${i + 1}/${chunks.length}]\n${c}`);
    const embeddings = await embedBatch(chunkTexts);

    for (let i = 0; i < chunks.length; i++) {
      const vectorStr = toVectorString(embeddings[i]);
      await sql`
        INSERT INTO document_chunks ("documentId", "companyId", "chunkIndex", "chunkText", embedding)
        VALUES (${doc.id}::uuid, ${doc.companyId}::uuid, ${i}, ${chunks[i]}, ${vectorStr}::vector)
        ON CONFLICT ("documentId", "chunkIndex") DO NOTHING
      `.execute(db);
    }
  }
}

/**
 * Chunk text with overlap, breaking at sentence boundaries when possible
 */
function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + chunkSize;

    if (end < text.length) {
      const segment = text.slice(start, end);
      const lastSentenceEnd = Math.max(
        segment.lastIndexOf('. '),
        segment.lastIndexOf('.\n'),
        segment.lastIndexOf('? '),
        segment.lastIndexOf('! ')
      );

      if (lastSentenceEnd > chunkSize * 0.5) {
        end = start + lastSentenceEnd + 1;
      }
    } else {
      end = text.length;
    }

    chunks.push(text.slice(start, end).trim());
    start = end - overlap;

    if (start >= text.length) break;
  }

  return chunks.filter(c => c.length > 0);
}
