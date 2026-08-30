import { NextResponse } from "next/server";
import { askCopilot } from "@/lib/copilot/orchestrate";
import { createServiceClient } from "@/lib/supabase/serviceClient";

export async function POST(request: Request) {
  let question: string;
  try {
    const body = (await request.json()) as { question?: unknown };
    if (typeof body.question !== "string" || !body.question.trim()) {
      return NextResponse.json({ error: "question (non-empty string) is required" }, { status: 400 });
    }
    question = body.question.trim();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const result = await askCopilot(question);

    // Log every interaction — the Copilot's only footprint in the
    // database, same audited-write discipline as every other automated
    // step in this system (see 00007_copilot_audit.sql).
    const supabase = createServiceClient();
    const { error: logError } = await supabase.rpc("log_copilot_interaction_atomic", {
      p_question: question,
      p_answer: result.answer,
      p_tool_calls: result.toolCalls,
      p_model: result.model,
      p_actor_id: null,
    });
    if (logError) {
      console.error("Failed to log Copilot interaction:", logError.message);
    }

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
