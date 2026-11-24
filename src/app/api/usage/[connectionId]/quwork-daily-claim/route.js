import { getProviderConnectionById } from "@/lib/localDb";
import { claimQuworkDaily } from "@/sse/services/quworkCheckin.js";

export const dynamic = "force-dynamic";

// POST /api/usage/[connectionId]/quwork-daily-claim — 连接卡「每日领积分」按钮
// （同 meoo-daily-claim）。与后台调度器同一份实现（状态门控，不盲打 claim）。
export async function POST(request, { params }) {
  try {
    const { connectionId } = await params;
    const connection = await getProviderConnectionById(connectionId);
    if (!connection) return Response.json({ error: "Connection not found" }, { status: 404 });
    if (connection.provider !== "quwork") {
      return Response.json({ error: "Daily reward claim is only available for QuWork connections." }, { status: 400 });
    }
    return Response.json(await claimQuworkDaily(connection));
  } catch (error) {
    return Response.json({ claimed: false, balance: null, message: error?.message || "领取失败" }, { status: 500 });
  }
}
