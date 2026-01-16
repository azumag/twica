import { NextRequest, NextResponse } from "next/server";
import { GachaService } from "@/lib/services/gacha";
import { handleApiError } from "@/lib/error-handler";
import { getSession } from "@/lib/session";

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { streamerId } = body;

    if (!streamerId) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const gachaService = new GachaService();
    const result = await gachaService.executeGacha(streamerId, session.twitchUserId, session.twitchUsername);

    if (!result.success) {
      return NextResponse.json(
        { error: result.error },
        { status: 500 }
      );
    }

    return NextResponse.json(result.data);
  } catch (error) {
    return handleApiError(error, "Gacha API");
  }
}
