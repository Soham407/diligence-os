import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type JobRow = {
  id: string;
  org_id: string;
  report_id: string | null;
  anthropic_session_id: string | null;
  status: JobStatus;
  created_at: string;
  updated_at: string;
};

export type JobEventRow = {
  id: string;
  job_id: string;
  kind: string;
  payload: Record<string, unknown> | null;
  created_at: string;
};

export type EnqueueJobSpec = {
  orgId: string;
  reportId: string | null;
  anthropicSessionId?: string | null;
  spec: Record<string, unknown>;
};

function assertSuccess<T>(result: { data: T; error: { message: string } | null }, message: string): T {
  if (result.error) {
    throw new Error(`${message}: ${result.error.message}`);
  }

  return result.data;
}

export function createJobRunner(client: Pick<SupabaseClient, "from">) {
  return {
    async enqueue(spec: EnqueueJobSpec): Promise<JobRow> {
      const inserted = await client
        .from("jobs")
        .insert({
          org_id: spec.orgId,
          report_id: spec.reportId,
          anthropic_session_id: spec.anthropicSessionId ?? null,
          status: "queued"
        })
        .select("id, org_id, report_id, anthropic_session_id, status, created_at, updated_at")
        .single();

      const createdJob = assertSuccess(inserted, "Failed to enqueue job") as JobRow;

      const eventInsert = await client.from("job_events").insert({
        job_id: createdJob.id,
        kind: "job_enqueued",
        payload: spec.spec
      });

      if (eventInsert.error) {
        throw new Error(`Failed to insert job_enqueued event: ${eventInsert.error.message}`);
      }

      return createdJob;
    },

    async getJob(id: string): Promise<JobRow | null> {
      const selected = await client
        .from("jobs")
        .select("id, org_id, report_id, anthropic_session_id, status, created_at, updated_at")
        .eq("id", id)
        .maybeSingle();

      if (selected.error) {
        throw new Error(`Failed to load job ${id}: ${selected.error.message}`);
      }

      return (selected.data as JobRow | null) ?? null;
    },

    async listActiveJobs(limit = 20): Promise<JobRow[]> {
      const selected = await client
        .from("jobs")
        .select("id, org_id, report_id, anthropic_session_id, status, created_at, updated_at")
        .in("status", ["queued", "running"])
        .order("created_at", { ascending: true })
        .limit(limit);

      if (selected.error) {
        throw new Error(`Failed to list active jobs: ${selected.error.message}`);
      }

      return (selected.data as JobRow[]) ?? [];
    },

    async listJobEvents(jobId: string): Promise<JobEventRow[]> {
      const selected = await client
        .from("job_events")
        .select("id, job_id, kind, payload, created_at")
        .eq("job_id", jobId)
        .order("created_at", { ascending: true });

      if (selected.error) {
        throw new Error(`Failed to load events for job ${jobId}: ${selected.error.message}`);
      }

      return (selected.data as JobEventRow[]) ?? [];
    },

    async appendEvent(jobId: string, kind: string, payload: Record<string, unknown> = {}): Promise<void> {
      const inserted = await client.from("job_events").insert({
        job_id: jobId,
        kind,
        payload
      });

      if (inserted.error) {
        throw new Error(`Failed to append job event ${kind}: ${inserted.error.message}`);
      }
    },

    async updateJob(jobId: string, patch: Partial<Pick<JobRow, "status" | "anthropic_session_id">>): Promise<JobRow> {
      const updated = await client
        .from("jobs")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", jobId)
        .select("id, org_id, report_id, anthropic_session_id, status, created_at, updated_at")
        .single();

      return assertSuccess(updated, `Failed to update job ${jobId}`) as JobRow;
    }
  };
}
