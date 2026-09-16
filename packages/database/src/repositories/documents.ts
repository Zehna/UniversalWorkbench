import type {
  CreateNoteRecordInput,
  DocumentRepository,
  UpdateNoteRecordInput,
  UpdateNoteRecordResult,
} from "@uw/documents";
import type {
  DocumentRevision,
  NoteDocument,
  NoteDocumentView,
} from "@uw/contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

interface NoteRow extends QueryResultRow {
  document_id: string;
  project_id: string;
  kind: "note";
  title: string;
  current_revision_id: string;
  document_created_at: Date;
  document_updated_at: Date;
  revision_id: string;
  revision_number: number;
  parent_revision_id: string | null;
  content: { body: string };
  metadata: Record<string, unknown>;
  revision_created_at: Date;
}

interface DocumentSummaryRow extends QueryResultRow {
  id: string;
  project_id: string;
  kind: "note";
  title: string;
  current_revision_id: string;
  created_at: Date;
  updated_at: Date;
}

interface RevisionRow extends QueryResultRow {
  id: string;
  document_id: string;
  revision_number: number;
  parent_revision_id: string | null;
  content: { body: string };
  metadata: Record<string, unknown>;
  created_at: Date;
}

interface LockedDocumentRow extends QueryResultRow {
  id: string;
  project_id: string;
  title: string;
  current_revision_id: string;
  created_at: Date;
  revision_number: number;
}

function mapDocument(row: DocumentSummaryRow): NoteDocument {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    currentRevisionId: row.current_revision_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapRevision(row: RevisionRow): DocumentRevision {
  return {
    id: row.id,
    documentId: row.document_id,
    revisionNumber: row.revision_number,
    parentRevisionId: row.parent_revision_id,
    content: row.content,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
  };
}

function mapView(row: NoteRow): NoteDocumentView {
  return {
    document: {
      id: row.document_id,
      projectId: row.project_id,
      kind: row.kind,
      title: row.title,
      currentRevisionId: row.current_revision_id,
      createdAt: row.document_created_at.toISOString(),
      updatedAt: row.document_updated_at.toISOString(),
    },
    revision: {
      id: row.revision_id,
      documentId: row.document_id,
      revisionNumber: row.revision_number,
      parentRevisionId: row.parent_revision_id,
      content: row.content,
      metadata: row.metadata,
      createdAt: row.revision_created_at.toISOString(),
    },
  };
}

async function rollback(client: PoolClient) {
  try {
    await client.query("rollback");
  } catch {
    // Preserve the original transaction error.
  }
}

export function createPostgresDocumentRepository(pool: Pool): DocumentRepository {
  return {
    async projectExists(ownerId, projectId) {
      const result = await pool.query(
        `select 1
           from projects
          where id = $1
            and owner_id = $2
          limit 1`,
        [projectId, ownerId],
      );
      return result.rowCount === 1;
    },

    async createNote(input: CreateNoteRecordInput) {
      const client = await pool.connect();
      try {
        await client.query("begin");

        const project = await client.query(
          `select 1
             from projects
            where id = $1
              and owner_id = $2
            limit 1`,
          [input.projectId, input.ownerId],
        );
        if (project.rowCount !== 1) {
          await client.query("rollback");
          return null;
        }

        await client.query(
          `insert into documents (
             id,
             project_id,
             kind,
             title,
             current_revision_id,
             created_at,
             updated_at
           ) values ($1, $2, 'note', $3, null, $4, $4)`,
          [input.documentId, input.projectId, input.title, input.createdAt],
        );

        await client.query(
          `insert into document_revisions (
             id,
             document_id,
             revision_number,
             parent_revision_id,
             content,
             metadata,
             created_at
           ) values ($1, $2, 1, null, $3, $4, $5)`,
          [
            input.revisionId,
            input.documentId,
            { body: input.body },
            {},
            input.createdAt,
          ],
        );

        await client.query(
          `update documents
              set current_revision_id = $1
            where id = $2`,
          [input.revisionId, input.documentId],
        );

        await client.query("commit");

        const createdAt = input.createdAt.toISOString();
        return {
          document: {
            id: input.documentId,
            projectId: input.projectId,
            kind: "note",
            title: input.title,
            currentRevisionId: input.revisionId,
            createdAt,
            updatedAt: createdAt,
          },
          revision: {
            id: input.revisionId,
            documentId: input.documentId,
            revisionNumber: 1,
            parentRevisionId: null,
            content: { body: input.body },
            metadata: {},
            createdAt,
          },
        };
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async listNotes(ownerId, projectId) {
      const result = await pool.query<DocumentSummaryRow>(
        `select
           d.id,
           d.project_id,
           d.kind,
           d.title,
           d.current_revision_id,
           d.created_at,
           d.updated_at
         from documents d
         join projects p on p.id = d.project_id
        where p.owner_id = $1
          and d.project_id = $2
          and d.kind = 'note'
          and d.current_revision_id is not null
        order by d.created_at, d.id`,
        [ownerId, projectId],
      );
      return result.rows.map(mapDocument);
    },

    async getNote(ownerId, projectId, documentId) {
      const result = await pool.query<NoteRow>(
        `select
           d.id as document_id,
           d.project_id,
           d.kind,
           d.title,
           d.current_revision_id,
           d.created_at as document_created_at,
           d.updated_at as document_updated_at,
           r.id as revision_id,
           r.revision_number,
           r.parent_revision_id,
           r.content,
           r.metadata,
           r.created_at as revision_created_at
         from documents d
         join projects p on p.id = d.project_id
         join document_revisions r on r.id = d.current_revision_id
        where p.owner_id = $1
          and d.project_id = $2
          and d.id = $3
          and d.kind = 'note'
        limit 1`,
        [ownerId, projectId, documentId],
      );
      const row = result.rows[0];
      return row ? mapView(row) : null;
    },

    async listRevisions(ownerId, projectId, documentId) {
      const result = await pool.query<RevisionRow>(
        `select
           r.id,
           r.document_id,
           r.revision_number,
           r.parent_revision_id,
           r.content,
           r.metadata,
           r.created_at
         from document_revisions r
         join documents d on d.id = r.document_id
         join projects p on p.id = d.project_id
        where p.owner_id = $1
          and d.project_id = $2
          and d.id = $3
          and d.kind = 'note'
        order by r.revision_number`,
        [ownerId, projectId, documentId],
      );
      if (result.rows.length === 0) return null;
      return result.rows.map(mapRevision);
    },

    async updateNote(
      input: UpdateNoteRecordInput,
    ): Promise<UpdateNoteRecordResult> {
      const client = await pool.connect();
      try {
        await client.query("begin");

        const locked = await client.query<LockedDocumentRow>(
          `select
             d.id,
             d.project_id,
             d.title,
             d.current_revision_id,
             d.created_at,
             r.revision_number
           from documents d
           join projects p on p.id = d.project_id
           join document_revisions r on r.id = d.current_revision_id
          where p.owner_id = $1
            and d.project_id = $2
            and d.id = $3
            and d.kind = 'note'
          for update of d`,
          [input.ownerId, input.projectId, input.documentId],
        );
        const current = locked.rows[0];
        if (!current) {
          await client.query("rollback");
          return { status: "not_found" };
        }

        if (current.current_revision_id !== input.baseRevisionId) {
          await client.query("rollback");
          return {
            status: "conflict",
            currentRevisionId: current.current_revision_id,
          };
        }

        const nextRevisionNumber = current.revision_number + 1;
        await client.query(
          `insert into document_revisions (
             id,
             document_id,
             revision_number,
             parent_revision_id,
             content,
             metadata,
             created_at
           ) values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            input.revisionId,
            input.documentId,
            nextRevisionNumber,
            current.current_revision_id,
            { body: input.body },
            {},
            input.updatedAt,
          ],
        );

        await client.query(
          `update documents
              set title = $1,
                  current_revision_id = $2,
                  updated_at = $3
            where id = $4`,
          [
            input.title,
            input.revisionId,
            input.updatedAt,
            input.documentId,
          ],
        );

        await client.query("commit");

        return {
          status: "updated",
          value: {
            document: {
              id: input.documentId,
              projectId: input.projectId,
              kind: "note",
              title: input.title,
              currentRevisionId: input.revisionId,
              createdAt: current.created_at.toISOString(),
              updatedAt: input.updatedAt.toISOString(),
            },
            revision: {
              id: input.revisionId,
              documentId: input.documentId,
              revisionNumber: nextRevisionNumber,
              parentRevisionId: current.current_revision_id,
              content: { body: input.body },
              metadata: {},
              createdAt: input.updatedAt.toISOString(),
            },
          },
        };
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
